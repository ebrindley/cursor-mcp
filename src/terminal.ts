import { createHash, randomUUID } from 'node:crypto';
import { StringDecoder } from 'node:string_decoder';
import { setTimeout as delay } from 'node:timers/promises';
import { object, TerminalFailure, type TerminalConnector, type TerminalPeer } from './terminal-gateway.js';

export type TerminalRequest = { operation: string; sessionId?: string; commandId?: string; command?: string;
  timeoutMs?: number; outputOffset?: number; outputLimit?: number; waitMs?: number };
type Command = {
  commandId: string; digest: string; state: string; commandOutcome: 'not_submitted' | 'unknown' | 'ended';
  exitCode: number | null; signal: number | null; executionEnded: boolean; outputComplete: boolean; outputReadFailed: boolean;
  outputTruncated: boolean; cancelRequested: boolean; cleanup: string; reason: string | null;
  bytes: Buffer; machineId?: string; ptyId?: string; peer?: TerminalPeer; wake?: (reason: string) => void;
};

const MAX_COMMAND_BYTES = 16384;

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
      return { status: error instanceof TerminalFailure ? error.code : 'terminal_unavailable', machineId };
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
      } catch (error) { return { ...base, status: error instanceof TerminalFailure ? error.code : 'terminal_unavailable' }; }
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
      cancelRequested: false, cleanup: 'pending', reason: null, bytes: Buffer.alloc(0) };
    this.results.set(commandId, op); this.active = op;
    // An MCP request's signal is intentionally not the lifetime of the accepted command.
    void this.run(op, command, timeoutMs!);
    return this.snapshot(op);
  }

  private async run(op: Command, command: string, timeoutMs: number) {
    const attachment = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let finishing = false;
    const completion = new Promise<string>(resolve => { op.wake = resolve; });
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
      void op.peer.stream('AttachPty', { ptyId: op.ptyId }, event => {
        if (finishing || op.executionEnded) return;
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
      }, attachment.signal).then(() => {
        if (!finishing && !op.executionEnded) { op.outputReadFailed = true; op.wake?.('stream_ended_without_exit'); }
      }).catch(() => {
        if (!finishing && !op.executionEnded) { op.outputReadFailed = true; op.wake?.('output_read_failed'); }
      });
      op.reason = await completion;
    } catch (error) {
      if (error instanceof TerminalFailure && error.submitted) op.commandOutcome = 'unknown';
      op.reason = error instanceof TerminalFailure ? error.code : 'terminal_execution_failed';
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
