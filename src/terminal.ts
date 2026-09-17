import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { object, TerminalFailure, type TerminalConnector, type TerminalPeer, failureFields } from './terminal-gateway.js';

export type TerminalRequest = { operation: string; sessionId?: string; commandId?: string; command?: string;
  timeoutMs?: number; outputOffset?: number; outputLimit?: number; waitMs?: number };
type Command = {
  commandId: string; digest: string; state: string; commandOutcome: 'not_submitted' | 'unknown' | 'ended';
  exitCode: number | null; signal: number | null; executionEnded: boolean; outputComplete: boolean; outputReadFailed: boolean;
  outputTruncated: boolean; cancelRequested: boolean; cleanup: string; reason: string | null;
  reattachments: number; continuityUncertain: boolean; resumable: boolean; gapCheck: boolean;
  lastEventId?: string; lastSeq?: number; seen: Set<string>;
  bytes: Buffer; machineId?: string; ptyId?: string; peer?: TerminalPeer; wake?: (reason: string) => void;
  httpStatus?: number; failedOperation?: string;
};

const MAX_COMMAND_BYTES = 16384;
const MAX_REATTACHMENTS = 3;
/** Transport-class loss only. Cancellation, auth, protocol and reaped-PTY failures are never reattached. */
const RESUMABLE = new Set(['stream_ended_without_exit', 'gateway_unavailable', 'gateway_disconnected',
  'gateway_send_failed', 'terminal_connection_failed']);
/** The backoff uses the same global timer as the command deadline, so one clock bounds both. */
const pause = (ms: number, signal: AbortSignal) => new Promise<boolean>(resolve => {
  const stop = () => { clearTimeout(timer); resolve(false); };
  const timer = setTimeout(() => { signal.removeEventListener('abort', stop); resolve(true); }, ms);
  if (signal.aborted) stop(); else signal.addEventListener('abort', stop, { once: true });
});

/** One owned process at a time; retained IDs are never evicted and silently executed again. */
export class TerminalService {
  sessionId = randomUUID();
  private readonly results = new Map<string, Command>();
  private active: Command | undefined;
  private closed = false;
  private readonly shutdown = new AbortController();
  constructor(private readonly agentId: string, private readonly connector: TerminalConnector,
    private readonly maxOutputBytes = 65536, private readonly maxResults = 32) {}

  get canRetire() { return !this.active && this.results.size === 0; }
  get retention() { return { retainedResults: this.results.size, activeCommandId: this.active?.commandId ?? null }; }

  private async probe(signal: AbortSignal): Promise<{ status: string; machineId: string | undefined }> {
    let peer: TerminalPeer | undefined, machineId: string | undefined;
    try {
      ({ peer, machineId } = await this.connector.connect(undefined, signal));
      const response = await peer.unary('ListPtys', {});
      if (signal.aborted) return { status: 'request_cancelled', machineId };
      if (response.ptys !== undefined && !Array.isArray(response.ptys)) throw new TerminalFailure('invalid_gateway_response');
      return { status: 'ready', machineId };
    } catch (error) {
      return { status: error instanceof TerminalFailure ? error.code : 'terminal_unavailable', machineId, ...failureFields(error) };
    } finally { peer?.close(); }
  }

  private async wake(waitMs: number, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const result = { status: 'wake', sessionId: this.sessionId, wakeOutcome: 'not_submitted',
      readiness: 'skipped', machineChanged: null as boolean | null, reason: null as string | null };
    if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 60000) return { ...result, status: 'invalid_request' };
    const lifetime = AbortSignal.any([this.shutdown.signal, ...(signal ? [signal] : [])]);
    if (lifetime.aborted) return { ...result, readiness: 'cancelled' };
    // Precheck and submission have their own bounds; waitMs bounds subsequent readiness work.
    const precheck = AbortSignal.any([lifetime, AbortSignal.timeout(30000)]);
    const before = await this.probe(precheck);
    if (precheck.aborted) return { ...result, readiness: lifetime.aborted ? 'cancelled' : 'deadline' };
    if (before.status === 'ready') return { ...result, status: 'already_ready', readiness: 'ready' };
    if (before.status !== 'gateway_unavailable' || !before.machineId || !this.connector.wake)
      return { ...result, readiness: 'unavailable', reason: before.status };
    try {
      result.wakeOutcome = await this.connector.wake(lifetime) ? 'signaled' : 'not_signaled';
    } catch (error) {
      result.wakeOutcome = error instanceof TerminalFailure && !error.submitted ?
        (['terminal_permission_denied', 'terminal_authentication_expired'].includes(error.code) ? 'rejected' : 'not_submitted') : 'unknown';
      result.reason = error instanceof TerminalFailure ? error.code : 'terminal_connection_failed';
      Object.assign(result, failureFields(error));
      if (result.wakeOutcome !== 'unknown') return { ...result, readiness: lifetime.aborted ? 'cancelled' : 'skipped' };
    }
    if (lifetime.aborted) return { ...result, readiness: 'cancelled' };
    if (!waitMs) return result;
    const deadline = AbortSignal.timeout(waitMs);
    const polling = AbortSignal.any([lifetime, deadline]);
    while (!polling.aborted) {
      const after = await this.probe(polling);
      if (after.machineId) result.machineChanged = after.machineId !== before.machineId;
      if (polling.aborted) break;
      if (after.status === 'ready') return { ...result, readiness: 'ready' };
      if (after.status !== 'gateway_unavailable') return { ...result, readiness: 'unavailable', reason: after.status };
      try { await delay(1000, undefined, { signal: polling }); } catch { break; }
    }
    return { ...result, readiness: lifetime.aborted ? 'cancelled' : 'deadline' };
  }

  private snapshot(op: Command, offset = 0, limit = 2000) {
    const decoder = new StringDecoder('utf8');
    const text = decoder.write(op.bytes) + (op.outputComplete && !op.outputTruncated ? decoder.end() : '');
    const points = [...text];
    return { status: 'command', sessionId: this.sessionId, agentId: this.agentId, commandId: op.commandId,
      state: op.state, commandOutcome: op.commandOutcome, executionEnded: op.executionEnded, exitCode: op.exitCode, signal: op.signal,
      outputComplete: op.outputComplete, outputReadFailed: op.outputReadFailed, outputTruncated: op.outputTruncated,
      cancelRequested: op.cancelRequested, cleanup: op.cleanup, reason: op.reason,
      ...(op.httpStatus !== undefined ? { httpStatus: op.httpStatus } : {}), ...(op.failedOperation ? { failedOperation: op.failedOperation } : {}),
      reattachments: op.reattachments, continuityUncertain: op.continuityUncertain,
      output: points.slice(offset, offset + limit).join(''), outputOffset: offset,
      outputNextOffset: offset + points.slice(offset, offset + limit).length, outputLength: points.length };
  }

  async handle(request: TerminalRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) return { status: 'request_cancelled', ...(request.operation === 'execute' ? { commandOutcome: 'not_submitted' } : {}) };
    if (request.operation === 'wake') return this.wake(request.waitMs ?? 30000, signal);
    if (request.operation === 'status') {
      const base = { sessionId: this.sessionId, agentId: this.agentId, activeCommandId: this.active?.commandId ?? null,
        retainedResults: this.results.size, maxOutputBytes: this.maxOutputBytes, maxResults: this.maxResults };
      if (this.closed) return { ...base, status: 'closed' };
      let peer: TerminalPeer | undefined;
      try {
        ({ peer } = await this.connector.connect());
        const response = await peer.unary('ListPtys', {});
        if (response.ptys !== undefined && !Array.isArray(response.ptys)) throw new TerminalFailure('invalid_gateway_response');
        return { ...base, status: 'ready', transport: 'direct_pty', inferenceRequired: false };
      } catch (error) { return { ...base, status: error instanceof TerminalFailure ? error.code : 'terminal_unavailable', ...failureFields(error) }; }
      finally { peer?.close(); }
    }
    if (request.sessionId !== this.sessionId) return { status: 'session_mismatch', sessionId: this.sessionId };
    if (request.operation === 'reset') {
      if (this.active || [...this.results.values()].some(op => op.state !== 'finished' || !['process_exited', 'process_not_listed', 'not_created'].includes(op.cleanup)))
        return { status: 'reset_blocked' };
      if (this.closed) return { status: 'closed' };
      this.results.clear(); this.sessionId = randomUUID();
      return { status: 'reset', sessionId: this.sessionId };
    }
    if (request.operation === 'read' || request.operation === 'cancel') {
      const op = this.results.get(request.commandId ?? '');
      if (!op) return { status: 'not_retained', sessionId: this.sessionId };
      const offset = request.outputOffset ?? 0, limit = request.outputLimit ?? 2000;
      if (!Number.isInteger(offset) || offset < 0 || offset > 65536 || !Number.isInteger(limit) || limit < 1 || limit > 2000) return { status: 'invalid_request' };
      if (request.operation === 'cancel' && op.state === 'finished' && op.cleanup === 'termination_unconfirmed' && op.ptyId && !this.closed) {
        op.state = 'cleaning';
        op.cleanup = await this.terminate(op);
        op.state = 'finished';
      } else if (request.operation === 'cancel' && op.state !== 'finished' && op.state !== 'cleaning') {
        op.cancelRequested = true; op.wake?.('cancel_requested');
      }
      return this.snapshot(op, offset, limit);
    }
    const { command, commandId, timeoutMs } = request;
    // Reject oversized source before recording or submitting a command.
    const commandBytes = typeof command === 'string' ? Buffer.byteLength(command) : 0;
    if (commandBytes > MAX_COMMAND_BYTES) return { status: 'invalid_request', commandOutcome: 'not_submitted',
      reason: 'command_too_large', bytes: commandBytes, maxBytes: MAX_COMMAND_BYTES };
    if (request.operation !== 'execute' || typeof commandId !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(commandId) ||
      typeof command !== 'string' || !command.length || command.includes('\0') ||
      !Number.isInteger(timeoutMs) || timeoutMs! < 1 || timeoutMs! > 300000) return { status: 'invalid_request', commandOutcome: 'not_submitted' };
    const digest = createHash('sha256').update(JSON.stringify([command, timeoutMs])).digest('hex');
    const previous = this.results.get(commandId);
    if (previous) return previous.digest === digest ? this.snapshot(previous) : { status: 'command_id_conflict' };
    if (this.closed) return { status: 'closed', commandOutcome: 'not_submitted' };
    if (this.active) return { status: 'busy', commandOutcome: 'not_submitted' };
    if (this.results.size >= this.maxResults) return { status: 'session_capacity', commandOutcome: 'not_submitted' };
    const op: Command = { commandId, digest, state: 'starting', commandOutcome: 'not_submitted', exitCode: null, signal: null,
      executionEnded: false, outputComplete: false, outputReadFailed: false, outputTruncated: false,
      cancelRequested: false, cleanup: 'pending', reason: null, reattachments: 0, continuityUncertain: false,
      resumable: true, gapCheck: false, seen: new Set(), bytes: Buffer.alloc(0) };
    this.results.set(commandId, op); this.active = op;
    // An MCP request's signal is intentionally not the lifetime of the accepted command.
    void this.run(op, command, timeoutMs!);
    return this.snapshot(op);
  }

  private async run(op: Command, command: string, timeoutMs: number) {
    const attachment = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishing = false;
    let ended: string | undefined;
    // Settling the outcome also detaches, so a superseded backoff, reconnect or stream cannot outlive it.
    const completion = new Promise<string>(resolve => { op.wake = reason => { ended ??= reason; attachment.abort(); resolve(reason); }; });
    const live = () => ended === undefined && !finishing && !op.cancelRequested && !this.closed;
    const observe = (peer: TerminalPeer) => this.observe(op, peer, attachment.signal, () => !finishing && op.peer === peer);
    try {
      const connection = await this.connector.connect();
      op.peer = connection.peer; op.machineId = connection.machineId;
      if (this.closed || op.cancelRequested) { op.reason = 'cancelled_before_submission'; return; }
      const spawned = await op.peer.unary('SpawnPty', { process: { shell: '/bin/bash', args: ['--noprofile', '--norc', '-c', command] },
        cwd: '/tmp', env: { BASH_ENV: '/dev/null', TERM: 'dumb' }, cols: 80, rows: 24 }, () => { op.commandOutcome = 'unknown'; });
      if (typeof spawned.ptyId !== 'string' || !spawned.ptyId) throw new TerminalFailure('spawn_identity_missing', true);
      op.ptyId = spawned.ptyId; op.state = 'running';
      if (this.closed || op.cancelRequested) { op.reason = this.closed ? 'server_closed' : 'cancel_requested'; return; }
      timer = setTimeout(() => op.wake?.('deadline_exceeded'), timeoutMs);
      let lost = observe(connection.peer);
      for (;;) {
        const outcome = await Promise.race([completion.then(reason => ({ reason })), lost.then(code => ({ code }))]);
        if ('reason' in outcome) { op.reason = outcome.reason; break; }
        // Losing the stream before PtyExited is a transport event, not an outcome: reattach from the cursor. Without an
        // observed cursor there is nothing to resume from, so the loss keeps today's unknown-outcome path.
        const next = op.resumable && op.lastEventId !== undefined && RESUMABLE.has(outcome.code)
          ? await this.recover(op, live, observe, attachment.signal) : undefined;
        if (next) { lost = next.lost; continue; }
        if (live()) { op.outputReadFailed = true; op.reason = outcome.code === 'stream_ended_without_exit' ? outcome.code : 'output_read_failed'; }
        else op.reason = ended ?? (this.closed ? 'server_closed' : 'cancel_requested');
        break;
      }
    } catch (error) {
      if (error instanceof TerminalFailure && error.submitted) op.commandOutcome = 'unknown';
      op.reason = error instanceof TerminalFailure ? error.code : 'terminal_execution_failed';
      Object.assign(op, failureFields(error));
    } finally {
      finishing = true; clearTimeout(timer);
      // The deployed AttachPty stream stays open after PtyExited. Detach explicitly.
      attachment.abort(); op.peer?.close(); delete op.peer; delete op.wake;
      op.state = 'cleaning';
      op.cleanup = this.closed ? 'detached' : op.executionEnded ? 'process_exited' :
        op.ptyId ? await this.terminate(op) : op.commandOutcome === 'not_submitted' ? 'not_created' : 'identity_unknown';
      op.state = 'finished'; if (this.active === op) this.active = undefined;
    }
  }

  /** Dedupe and move the cursor before the byte cap, so a resume neither replays nor stalls behind retained output. */
  private consume(op: Command, event: Record<string, unknown>) {
    if (op.executionEnded) return;
    const id = typeof event.eventId === 'string' && event.eventId ? event.eventId : undefined;
    if (!id) op.resumable = false;
    // Observed ids are `<ptyId>-<n>` with n monotonic per PTY; any other shape is treated as opaque.
    const counted = id?.match(/^(.+)-(\d+)$/);
    const seq = counted && counted[1] === op.ptyId ? Number(counted[2]) : undefined;
    if (id && (seq !== undefined ? op.lastSeq !== undefined && seq <= op.lastSeq : op.seen.has(id))) return;
    if (op.gapCheck) {
      op.gapCheck = false;
      if (seq === undefined || seq !== (op.lastSeq ?? 0) + 1) op.continuityUncertain = true;
    }
    if (event.ptyData !== undefined) {
      if (!object(event.ptyData)) throw new Error('invalid_pty_event');
      const data = event.ptyData.data === undefined ? '' : event.ptyData.data;
      if (typeof data !== 'string') throw new Error('invalid_output');
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('invalid_output');
      const bytes = Buffer.from(data, 'base64');
      const left = this.maxOutputBytes - op.bytes.length;
      op.bytes = Buffer.concat([op.bytes, bytes.subarray(0, left)]);
      if (bytes.length > left) op.outputTruncated = true;
    } else if (event.ptyExited !== undefined) {
      if (!object(event.ptyExited)) throw new Error('invalid_pty_event');
      const code = event.ptyExited.exitCode ?? 0; // Protobuf JSON omits default-valued scalars.
      const signal = event.ptyExited.signal;
      if (!Number.isInteger(code) || (signal !== undefined && (!Number.isInteger(signal) || (signal as number) < 0))) throw new Error('invalid_exit');
      op.signal = signal as number | undefined ?? null;
      op.exitCode = op.signal ? null : code as number; op.executionEnded = true; op.commandOutcome = 'ended';
      op.outputComplete = true; op.wake?.(op.signal ? 'signaled' : 'completed');
    } // Ignore unknown event variants for forward compatibility.
    if (id) {
      op.lastEventId = id;
      if (seq !== undefined) op.lastSeq = seq;
      op.seen.add(id);
      if (op.seen.size > 256) op.seen.delete(op.seen.values().next().value!);
    }
  }

  /** One attachment: resolves with the transport code when its stream ends before PtyExited, and stays pending otherwise. */
  private observe(op: Command, peer: TerminalPeer, signal: AbortSignal, current: () => boolean): Promise<string> {
    return new Promise<string>(resolve => {
      const lost = (code: string) => { if (current() && !op.executionEnded) resolve(code); };
      void peer.stream('AttachPty', { ptyId: op.ptyId, ...(op.lastEventId ? { lastEventId: op.lastEventId } : {}) },
        event => { if (current()) this.consume(op, event); }, signal)
        .then(() => lost('stream_ended_without_exit'))
        .catch(error => lost(error instanceof TerminalFailure ? error.code : 'output_read_failed'));
    });
  }

  /** Reattach a lost stream from its cursor; each connect and each attach consumes one of MAX_REATTACHMENTS. The new
   *  attachment is returned wrapped because awaiting a bare promise here would wait for that attachment's own loss. */
  private async recover(op: Command, live: () => boolean, observe: (peer: TerminalPeer) => Promise<string>,
    signal: AbortSignal): Promise<{ lost: Promise<string> } | undefined> {
    const stale = op.peer; delete op.peer; stale?.close();
    while (live() && op.reattachments < MAX_REATTACHMENTS) {
      if (!await pause(1000 * 2 ** op.reattachments++, signal) || !live()) return undefined;
      let peer: TerminalPeer;
      try { ({ peer } = await this.connector.connect(op.machineId, signal)); }
      catch (error) { if (!RESUMABLE.has(error instanceof TerminalFailure ? error.code : '')) return undefined; continue; }
      if (!live()) { peer.close(); return undefined; }
      op.peer = peer; op.gapCheck = true;
      return { lost: observe(peer) };
    }
    return undefined;
  }

  private async terminate(op: Command): Promise<string> {
    let peer: TerminalPeer | undefined;
    try {
      ({ peer } = await this.connector.connect(op.machineId));
      try { await peer.unary('TerminatePty', { ptyId: op.ptyId }); } catch { /* Verify despite an ambiguous termination reply. */ }
      const listed = await peer.unary('ListPtys', {});
      if (listed.ptys !== undefined && !Array.isArray(listed.ptys)) return 'termination_unconfirmed';
      return (listed.ptys as unknown[] | undefined ?? []).some(value => object(value) && value.ptyId === op.ptyId)
        ? 'termination_unconfirmed' : 'process_not_listed';
    } catch (error) { return error instanceof TerminalFailure && error.code === 'machine_changed' ? 'machine_changed' : 'termination_unconfirmed'; }
    finally { peer?.close(); }
  }

  close() {
    this.closed = true;
    this.shutdown.abort();
    this.active?.wake?.('server_closed');
    this.active?.peer?.close();
    // Server shutdown detaches; it does not silently terminate remote work.
  }
}
