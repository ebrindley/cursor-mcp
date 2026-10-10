import { randomUUID } from 'node:crypto';
import { createWaitScope, within, schedule, WaitStoppedError, type DisposableTimer } from './wait.js';
import { independently, requestScope, withWaitScope } from './request-context.js';

/** Where a Cursor call failed: the RPC name and observed HTTP status. Never a URL or a body. */
export interface FailureDetail { httpStatus?: number; operation?: string }
export class TerminalFailure extends Error {
  constructor(readonly code: string, readonly submitted = false, readonly detail: FailureDetail = {}) { super(code); }
}
/** Result fields a failure adds beside its code. The code and `submitted` keep their existing meanings. */
export const failureFields = (error: unknown): { httpStatus?: number; failedOperation?: string } => {
  if (!(error instanceof TerminalFailure)) return {};
  return { ...(error.detail.httpStatus !== undefined ? { httpStatus: error.detail.httpStatus } : {}),
    ...(error.detail.operation ? { failedOperation: error.detail.operation } : {}) };
};
export const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

export interface TerminalPeer {
  unary(method: string, input: Record<string, unknown>, submitted?: () => void,
    acknowledged?: (value: Record<string, unknown>) => void): Promise<Record<string, unknown>>;
  stream(method: string, input: Record<string, unknown>, event: (value: Record<string, unknown>) => void, signal: AbortSignal): Promise<void>;
  settleAccepted?(): Promise<void>;
  close(): void;
}
export type Pod = { podId: string; tenantId: string; cluster: string; networkToken: string; ptyAuthToken: string };
export type SocketFactory = (url: string) => WebSocket;

/** Cursor's gateway envelope carrying ordinary Connect JSON messages. No IDE IPC. */
export class TerminalGateway implements TerminalPeer {
  private socket: WebSocket | undefined;
  private opening: Promise<WebSocket> | undefined;
  private disposed = false;
  private failOpening: (() => void) | undefined;
  private readonly abort = () => this.close();
  private readonly pending = new Map<string, { socket: WebSocket; streaming: boolean; frame: (value: Record<string, unknown>) => void; fail: (code: string) => void }>();
  private readonly idle = new Set<() => void>();
  private keepalive: DisposableTimer | undefined;
  constructor(private readonly pod: Pod, private readonly socketFactory: SocketFactory = url => new WebSocket(url),
    private readonly requestTimeoutMs = 10000, private readonly signal?: AbortSignal, private readonly keepaliveMs = 20000) {
    signal?.addEventListener('abort', this.abort, { once: true });
    if (signal?.aborted) this.close();
  }

  private open(): Promise<WebSocket> {
    if (this.disposed) return Promise.reject(new TerminalFailure('terminal_closed'));
    if (this.socket?.readyState === 1) return Promise.resolve(this.socket);
    if (this.opening) return this.opening;
    // Routing values are supplied only by authenticated GetMachine, never by a tool caller.
    const label = /^[a-zA-Z0-9-]+$/;
    if (![this.pod.tenantId, this.pod.podId, this.pod.cluster].every(value => label.test(value)))
      return Promise.reject(new TerminalFailure('invalid_machine_response'));
    const url = new URL(`wss://${this.pod.tenantId}-pod-${this.pod.podId.replace(/^pod-/, '')}-26054.${this.pod.cluster}.cursorvm.com/`);
    url.searchParams.set('network_token', this.pod.networkToken);
    url.searchParams.set('token', this.pod.ptyAuthToken);
    this.opening = new Promise<WebSocket>((resolve, reject) => {
      let socket: WebSocket;
      try { socket = this.socketFactory(url.toString()); }
      catch { reject(new TerminalFailure('gateway_unavailable')); return; }
      this.socket = socket;
      let opened = false;
      const openingScope = createWaitScope({ timeoutMs: this.requestTimeoutMs });
      const onDeadline = () => { failed(); socket.close(); };
      openingScope.signal.addEventListener('abort', onDeadline, { once: true });
      const failed = () => {
        openingScope.dispose();
        openingScope.signal.removeEventListener('abort', onDeadline);
        if (!opened) reject(new TerminalFailure('gateway_unavailable'));
        for (const request of [...this.pending.values()]) if (request.socket === socket) request.fail('gateway_disconnected');
        this.rearm(socket);
      };
      this.failOpening = failed;
      socket.addEventListener('open', () => {
        opened = true; openingScope.dispose(); openingScope.signal.removeEventListener('abort', onDeadline); resolve(socket);
      }, { once: true });
      socket.addEventListener('error', failed);
      socket.addEventListener('close', failed);
      socket.addEventListener('message', event => {
        this.rearm(socket);
        try {
          if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 2 * 1024 * 1024) throw new Error();
          const frame: unknown = JSON.parse(event.data);
          if (!object(frame) || typeof frame.requestId !== 'string') throw new Error();
          const request = this.pending.get(frame.requestId);
          if (request?.socket === socket) request.frame(frame);
        } catch {
          for (const request of [...this.pending.values()]) if (request.socket === socket) request.fail('invalid_gateway_response');
          socket.close();
        }
      });
    }).finally(() => { this.opening = undefined; this.failOpening = undefined; });
    return this.opening;
  }

  private streams(socket: WebSocket) { return [...this.pending.values()].some(request => request.socket === socket && request.streaming); }
  /** The pod gateway closed a socket idle in both directions for ~60s even with an AttachPty pending (observed 2026-09-16), so an
   *  idle unary keeps the current socket warm. Keepalive failures are ignored: this prevents that drop, it is not a liveness check. */
  private rearm(socket: WebSocket | undefined = this.socket) {
    if (this.socket !== socket) return;
    this.keepalive?.dispose(); this.keepalive = undefined;
    if (!socket || this.disposed || !this.keepaliveMs || socket.readyState !== 1 || !this.streams(socket)) return;
    const timer = schedule(this.keepaliveMs, () => {
      this.keepalive = undefined;
      if (this.disposed || this.socket !== socket || socket.readyState !== 1 || !this.streams(socket)) return;
      void independently(() => this.unary('ListPtys', {})).catch(() => { /* Its send re-arms the timer; a keepalive failure says nothing about the stream. */ });
    });
    timer.unref();
    this.keepalive = timer;
  }

  private async request(method: string, input: Record<string, unknown>, event?: (value: Record<string, unknown>) => void,
    signal?: AbortSignal, submitted?: () => void, acknowledged?: (value: Record<string, unknown>) => void): Promise<Record<string, unknown>> {
    const streaming = event !== undefined;
    // The RPC owner is finite and independent of any one observer.
    const owner = createWaitScope({ timeoutMs: this.requestTimeoutMs, signal, signalReason: 'caller_cancelled' });
    let socket: WebSocket;
    try { socket = await within(owner, () => this.open()); }
    catch (error) { owner.dispose(); throw error instanceof WaitStoppedError
      ? new TerminalFailure(error.reason === 'deadline' ? 'gateway_unavailable' : 'request_cancelled') : error; }
    if (signal?.aborted) { owner.dispose(); throw new TerminalFailure('request_cancelled'); }
    const requestId = randomUUID();
    let body = Buffer.from(JSON.stringify(input));
    if (streaming) { const prefix = Buffer.alloc(5); prefix.writeUInt32BE(body.length, 1); body = Buffer.concat([prefix, body]); }
    return new Promise((resolve, reject) => {
      let sent = false;
      let settled = false;
      let status: number | undefined;
      let buffer = Buffer.alloc(0);
      let streamEnded = false;
      const cleanup = () => {
        this.pending.delete(requestId); owner.dispose(); owner.signal.removeEventListener('abort', stopped);
        signal?.removeEventListener('abort', abort); this.rearm(socket);
        if (![...this.pending.values()].some(request => !request.streaming)) {
          for (const done of this.idle) done();
          this.idle.clear();
        }
      };
      const cancelRequest = () => {
        if (socket.readyState === 1 && sent) try { socket.send(JSON.stringify({ type: 2, requestId })); } catch { /* no replay */ }
      };
      const fail = (code: string) => {
        if (settled) return;
        settled = true; cleanup(); cancelRequest();
        reject(new TerminalFailure(code, sent, { operation: method, ...(status === undefined ? {} : { httpStatus: status }) }));
      };
      const abort = () => fail('request_cancelled');
      const stopped = () => fail(owner.stopReason() === 'deadline' ? 'terminal_rpc_timeout' : 'request_cancelled');
      this.pending.set(requestId, { socket, streaming, fail, frame: frame => {
        if (settled) return;
        try {
          if (frame.type === 4) {
            if (status !== undefined || !Number.isInteger(frame.status)) throw new Error();
            status = frame.status as number;
          } else if (frame.type === 3) {
            if (status === undefined || typeof frame.body !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(frame.body)) throw new Error();
            buffer = Buffer.concat([buffer, Buffer.from(frame.body, 'base64')]);
            if (buffer.length > 1024 * 1024) return fail('terminal_response_limit');
            while (streaming && buffer.length >= 5) {
              const length = buffer.readUInt32BE(1);
              if (length > 1024 * 1024) return fail('terminal_response_limit');
              if (buffer.length < length + 5) break;
              const flags = buffer[0];
              const value: unknown = JSON.parse(buffer.subarray(5, length + 5).toString('utf8'));
              buffer = buffer.subarray(length + 5);
              if (!object(value) || streamEnded) throw new Error();
              if (flags === 2) { streamEnded = true; if (value.error) return fail('terminal_stream_error'); }
              else if (flags === 0) { event!(value); if (settled) return; }
              else throw new Error(); // Compression was not requested.
            }
          } else if (frame.type === 5) {
            if (status !== 200) return fail(status === 401 || status === 403 ? 'terminal_permission_denied' : 'terminal_rpc_failed');
            if (streaming && (!streamEnded || buffer.length)) throw new Error();
            const value: unknown = streaming ? {} : JSON.parse(buffer.toString('utf8') || '{}');
            if (!object(value)) throw new Error();
            settled = true; cleanup(); acknowledged?.(value); resolve(value);
          } else if (frame.type === 6) fail('terminal_rpc_failed');
          else throw new Error();
        } catch { fail('invalid_gateway_response'); }
      } });
      signal?.addEventListener('abort', abort, { once: true });
      if (!streaming) owner.signal.addEventListener('abort', stopped, { once: true });
      else owner.dispose(); // Attachment lifetime belongs to its explicit stream signal.
      try {
        if (signal?.aborted) { abort(); return; }
        sent = true; submitted?.();
        socket.send(JSON.stringify({ type: 1, requestId, path: `/agent.v1.PtyHostService/${method}`, method: 'POST',
          headers: { 'content-type': streaming ? 'application/connect+json' : 'application/json',
            'connect-protocol-version': '1', authorization: `Bearer ${this.pod.ptyAuthToken}` }, body: body.toString('base64') }));
        this.rearm(socket);
      } catch { fail('gateway_send_failed'); }
    });
  }

  unary(method: string, input: Record<string, unknown>, submitted?: () => void,
    acknowledged?: (value: Record<string, unknown>) => void) {
    // Observer cancellation does not cancel an accepted RPC or discard its acknowledgement.
    const observer = requestScope(this.requestTimeoutMs);
    let sent = false;
    return within(observer, () => independently(() => this.request(method, input, undefined, undefined, () => { sent = true; submitted?.(); }, acknowledged)))
      .catch(error => { if (error instanceof WaitStoppedError) throw new TerminalFailure(
        error.reason === 'deadline' ? 'terminal_rpc_timeout' : 'request_cancelled', sent, { operation: method }); throw error; })
      .finally(() => observer.dispose());
  }
  async stream(method: string, input: Record<string, unknown>, event: (value: Record<string, unknown>) => void, signal: AbortSignal) {
    await this.request(method, input, event, signal);
  }
  /** Settlement only: pending unary owners retain their existing deadline and never replay. */
  settleAccepted(): Promise<void> {
    if (![...this.pending.values()].some(request => !request.streaming)) return Promise.resolve();
    return new Promise(resolve => { this.idle.add(resolve); });
  }
  close() {
    this.disposed = true;
    this.rearm();
    this.signal?.removeEventListener('abort', this.abort);
    this.failOpening?.();
    for (const request of [...this.pending.values()]) request.fail('terminal_closed');
    try { this.socket?.close(); } catch { /* No raw socket errors or credential-bearing URLs. */ }
  }
}

export interface TerminalConnection { machineId: string; peer: TerminalPeer }
export interface TerminalConnector {
  connect(expectedMachineId?: string, signal?: AbortSignal): Promise<TerminalConnection>;
  wake?(signal?: AbortSignal): Promise<boolean>;
}

/** Uses only the configured API key; no IDE/CLI credential files or persisted tokens. */
export class CursorTerminalConnector implements TerminalConnector {
  private token: string | undefined;
  private authenticating: Promise<void> | undefined;
  constructor(private readonly apiKey: string, private readonly agentId: string,
    private readonly fetcher: typeof fetch = fetch, private readonly socketFactory?: SocketFactory) {}

  private async post(path: string, token: string, input: Record<string, unknown>, signal?: AbortSignal, mutation = false) {
    const scope = requestScope(10000);
    const operation = path.slice(path.lastIndexOf('/') + 1);
    let submitted = false;
    const external = () => scope.stop('caller_cancelled');
    if (signal?.aborted) external(); else signal?.addEventListener('abort', external, { once: true });
    try {
      return await within(scope, async () => {
        submitted = true;
        const response = await this.fetcher(`https://api2.cursor.sh${path}`, { method: 'POST', redirect: 'error',
          headers: { 'content-type': 'application/json', 'connect-protocol-version': '1', 'x-cursor-client-type': 'cli', authorization: `Bearer ${token}` },
          body: JSON.stringify(input), signal: scope.signal });
        if (response.status === 401 || response.status === 403) {
          this.token = undefined;
          throw new TerminalFailure(response.status === 401 ? 'terminal_authentication_expired' : 'terminal_permission_denied', false,
            { httpStatus: response.status, operation });
        }
        if (!response.ok) throw new TerminalFailure(response.status === 404 ? 'machine_unavailable' : 'terminal_connection_failed', mutation,
          { httpStatus: response.status, operation });
        let value: unknown;
        try { value = await response.json(); } catch { throw new TerminalFailure('invalid_machine_response', mutation, { operation }); }
        if (!object(value)) throw new TerminalFailure('invalid_machine_response', mutation, { operation });
        return value;
      });
    } catch (error) {
      if (error instanceof TerminalFailure) throw error;
      throw new TerminalFailure(scope.stopReason() && scope.stopReason() !== 'deadline' ? 'request_cancelled' : 'terminal_connection_failed', mutation && submitted, { operation });
    } finally { scope.dispose(); signal?.removeEventListener('abort', external); }
  }

  private async authenticate(signal?: AbortSignal) {
    if (this.token) return;
    const observer = requestScope(10000);
    const cancel = () => observer.stop('caller_cancelled');
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    try {
      await within(observer, () => {
        this.authenticating ??= independently(async () => {
          if (!this.apiKey) throw new TerminalFailure('api_key_missing');
          const value = await this.post('/auth/exchange_user_api_key', this.apiKey, {});
          if (typeof value.accessToken !== 'string' || !value.accessToken) throw new TerminalFailure('invalid_auth_response');
          this.token = value.accessToken;
        }).finally(() => { this.authenticating = undefined; });
        return this.authenticating;
      });
    } catch (error) { if (error instanceof WaitStoppedError) throw new TerminalFailure(error.reason === 'deadline' ? 'terminal_connection_failed' : 'request_cancelled'); throw error; }
    finally { observer.dispose(); signal?.removeEventListener('abort', cancel); }
  }

  async wake(signal?: AbortSignal): Promise<boolean> {
    const scope = requestScope(30000);
    let submitted = false;
    const cancel = () => scope.stop('caller_cancelled');
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await withWaitScope(scope, () => within(scope, async () => {
        await this.authenticate(scope.signal);
        // Exactly one mutation attempt. Never refresh/retry this POST or change reason.
        scope.throwIfStopped();
        const value = await independently(() => {
          submitted = true;
          return this.post('/aiserver.v1.BackgroundComposerService/WakeBackgroundComposer', this.token!,
            { bcId: this.agentId, reason: 1 }, undefined, true);
        });
        const signaled = value.signaled ?? false; // ProtoJSON omits default-false scalars; null also leaves them unset.
        if (typeof signaled !== 'boolean') throw new TerminalFailure('invalid_wake_response', true);
        return signaled;
      }));
    } catch (error) { if (error instanceof WaitStoppedError) throw new TerminalFailure(error.reason === 'deadline' ? 'terminal_connection_failed' : 'request_cancelled', submitted); throw error; }
    finally { scope.dispose(); signal?.removeEventListener('abort', cancel); }
  }

  async connect(expectedMachineId?: string, signal?: AbortSignal): Promise<TerminalConnection> {
    const scope = requestScope(30000);
    const cancel = () => scope.stop('caller_cancelled');
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    try {
      return await withWaitScope(scope, () => within(scope, async () => {
        if (!this.socketFactory && typeof globalThis.WebSocket !== 'function') throw new TerminalFailure('websocket_runtime_required');
        const wasCached = !!this.token;
        await this.authenticate(signal);
        let value: Record<string, unknown>;
        try { value = await this.post('/aiserver.v1.BackgroundComposerService/GetMachine', this.token!, { bcId: this.agentId }, signal); }
        catch (error) {
          // One refresh for cached-token expiry on this read-only lookup. Never retry a command or a 403.
          if (!wasCached || !(error instanceof TerminalFailure) || error.code !== 'terminal_authentication_expired') throw error;
          await this.authenticate(signal);
          value = await this.post('/aiserver.v1.BackgroundComposerService/GetMachine', this.token!, { bcId: this.agentId }, signal);
        }
        const pod = object(value.machine) && object(value.machine.pod) ? value.machine.pod : undefined;
        if (!pod) throw new TerminalFailure('machine_unavailable');
        if (!['podId', 'tenantId', 'cluster', 'networkToken', 'ptyAuthToken'].every(key => typeof pod[key] === 'string' && pod[key]))
          throw new TerminalFailure('terminal_unavailable');
        const routing = pod as Pod;
        const machineId = `${routing.tenantId}/${routing.cluster}/${routing.podId}`;
        if (expectedMachineId !== undefined && expectedMachineId !== machineId) throw new TerminalFailure('machine_changed');
        if (signal?.aborted) throw new TerminalFailure('request_cancelled');
        // Discovery's observer must not become the shared socket's owner.
        return { machineId, peer: independently(() => new TerminalGateway(routing, this.socketFactory)) };
      }));
    } catch (error) { if (error instanceof WaitStoppedError) throw new TerminalFailure(error.reason === 'deadline' ? 'terminal_connection_failed' : 'request_cancelled'); throw error; }
    finally { scope.dispose(); signal?.removeEventListener('abort', cancel); }
  }
}
