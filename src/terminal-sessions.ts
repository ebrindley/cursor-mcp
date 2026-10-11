import { createHash, randomUUID } from 'node:crypto';
import { MAX_OUTPUT_CODE_POINTS } from './terminal-output.js';
import { StringDecoder } from 'node:string_decoder';
import { createWaitScope, within, WaitStoppedError } from './wait.js';
import { independently, requestScope, withWaitScope } from './request-context.js';
import { object, TerminalFailure, type TerminalConnector, type TerminalPeer, failureFields } from './terminal-gateway.js';

type Delivery = 'not_submitted' | 'submitted' | 'unknown';
export type SessionRequest = { operation: string; sessionId?: string; terminalId?: string; sequence?: number;
  data?: string; cols?: number; rows?: number; outputOffset?: number; outputLimit?: number; waitMs?: number; forget?: boolean };
type Session = {
  terminalId: string; state: 'starting' | 'attaching' | 'attached' | 'detached' | 'exited' | 'closing' | 'lost' | 'unknown';
  machineId?: string; ptyId?: string; peer?: TerminalPeer; connecting?: Promise<TerminalPeer>; abort?: AbortController;
  reason: string | null; cleanup: string; creationOutcome: Delivery; exitCode: number | null; signal: number | null;
  output: string; start: number; end: number; decoder: StringDecoder; lastEventId?: string; seen: Set<string>;
  reconnectGapPossible: boolean; nextInputSequence: number; lastInput?: { sequence: number; digest: string; outcome: Delivery };
  busy: boolean; wake: Set<() => void>;
  httpStatus?: number; failedOperation?: string;
};
const sequenceValid = (n: unknown): n is number => Number.isSafeInteger(n) && (n as number) >= 1 && (n as number) < Number.MAX_SAFE_INTEGER;
const dimensionsValid = (cols: unknown, rows: unknown) => Number.isInteger(cols) && Number.isInteger(rows) &&
  (cols as number) >= 2 && (cols as number) <= 500 && (rows as number) >= 2 && (rows as number) <= 300;
const code = (error: unknown) => error instanceof WaitStoppedError ? (error.reason === 'deadline' ? 'deadline' : 'request_cancelled') : error instanceof TerminalFailure ? error.code : 'terminal_unavailable';
const MAX_INPUT_BYTES = 16384;

/** Owned shells only. Sequence high-water marks reject retired requests without an unbounded journal. */
export class TerminalSessions {
  readonly sessionId = randomUUID();
  private readonly sessions = new Map<string, Session>();
  private nextCreateSequence = 1;
  private lastCreate?: { sequence: number; digest: string; terminalId: string };
  private creating = false;
  private closed = false;
  constructor(private readonly connector: TerminalConnector, private readonly maxOutputBytes = 65536,
    private readonly maxSessions = 4) {}

  get canRetire() { return !this.creating && this.sessions.size === 0; }
  get retention() { return { retainedSessions: this.sessions.size, creating: this.creating }; }

  private snapshot(op: Session, offset = op.start, limit = 2000): Record<string, unknown> {
    const actual = Math.max(offset, op.start);
    const points = [...op.output].slice(actual - op.start, actual - op.start + limit);
    return { status: 'terminal_session', sessionId: this.sessionId, terminalId: op.terminalId, state: op.state,
      creationOutcome: op.creationOutcome, reason: op.reason, cleanup: op.cleanup,
      ...(op.httpStatus !== undefined ? { httpStatus: op.httpStatus } : {}), ...(op.failedOperation ? { failedOperation: op.failedOperation } : {}),
      releaseAvailable: op.state === 'lost' || (op.state === 'unknown' && !op.ptyId && op.creationOutcome === 'unknown'), exitCode: op.exitCode, signal: op.signal,
      nextInputSequence: op.nextInputSequence, lastInputOutcome: op.lastInput?.outcome ?? null,
      reconnectGapPossible: op.reconnectGapPossible, outputStartOffset: op.start, outputEndOffset: op.end,
      outputGap: Math.max(0, op.start - offset), outputOffset: actual, outputNextOffset: actual + points.length,
      output: points.join('') };
  }
  private notify(op: Session) { for (const wake of [...op.wake]) wake(); }
  private append(op: Session, text: string) {
    op.end += [...text].length; op.output += text;
    if (Buffer.byteLength(op.output) > this.maxOutputBytes) {
      const points = [...op.output]; let bytes = 0, keep = points.length;
      while (keep > 0 && bytes + Buffer.byteLength(points[keep - 1]!) <= this.maxOutputBytes) bytes += Buffer.byteLength(points[--keep]!);
      op.output = points.slice(keep).join(''); op.start = op.end - (points.length - keep);
    }
  }
  private detach(op: Session) {
    const peer = op.peer; delete op.peer; op.abort?.abort(); delete op.abort; peer?.close();
  }
  private async attach(op: Session, initialPeer?: TerminalPeer): Promise<TerminalPeer> {
    if (this.closed) throw new TerminalFailure('terminal_closed');
    if (op.peer) return op.peer;
    if (op.connecting) return op.connecting;
    if (!op.ptyId || ['exited', 'lost', 'closing', 'unknown'].includes(op.state)) throw new TerminalFailure('session_not_attachable');
    op.connecting = independently(async () => {
      const scope = createWaitScope({ timeoutMs: 30000 });
      try {
        return await withWaitScope(scope, async () => {
          const peer = initialPeer ?? (await within(scope, () => this.connector.connect(op.machineId, scope.signal).then(connection => {
            if (scope.stopReason() || this.closed) connection.peer.close();
            return connection;
          }))).peer;
          if (this.closed || op.state === 'closing') { peer.close(); throw new TerminalFailure('terminal_closed'); }
          op.peer = peer; op.abort = new AbortController(); op.state = 'attaching';
          const disconnected = (reason: string) => {
            if (op.peer !== peer) return;
            this.detach(op); op.state = 'detached'; op.reason = reason; op.reconnectGapPossible = true; this.notify(op);
          };
          void peer.stream('AttachPty', { ptyId: op.ptyId, ...(op.lastEventId ? { lastEventId: op.lastEventId } : {}) }, event => {
            if (op.peer !== peer) return;
            if (typeof event.eventId !== 'string' || !event.eventId) throw new Error('missing_event_cursor');
            if (op.seen.has(event.eventId)) return;
            if (event.ptyData !== undefined) {
              if (!object(event.ptyData)) throw new Error('invalid_pty_data');
              const data = event.ptyData.data ?? '';
              if (typeof data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data)) throw new Error('invalid_pty_data');
              this.append(op, op.decoder.write(Buffer.from(data, 'base64')));
            } else if (event.ptyExited !== undefined) {
              if (!object(event.ptyExited)) throw new Error('invalid_pty_exit');
              const exitCode = event.ptyExited.exitCode ?? 0, signal = event.ptyExited.signal ?? 0;
              if (!Number.isInteger(exitCode) || !Number.isInteger(signal) || (signal as number) < 0) throw new Error('invalid_pty_exit');
              this.append(op, op.decoder.end()); op.signal = (signal as number) || null; op.exitCode = signal ? null : exitCode as number;
              op.state = 'exited'; op.reason = signal ? 'signaled' : 'completed'; op.cleanup = 'process_exited';
            }
            op.lastEventId = event.eventId; op.seen.add(event.eventId);
            if (op.seen.size > 256) op.seen.delete(op.seen.values().next().value!);
            if (op.state === 'exited') this.detach(op); else { op.state = 'attached'; op.reason = null; }
            this.notify(op);
          }, op.abort.signal).then(() => disconnected('stream_ended_without_exit')).catch(error => disconnected(code(error)));
          return peer;
        });
      } finally { scope.dispose(); }
    }).catch(error => {
      op.reason = code(error); if (op.reason === 'machine_changed') op.state = 'lost';
      throw error;
    }).finally(() => { delete op.connecting; });
    return op.connecting;
  }

  async handle(request: SessionRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    const scope = requestScope(45000);
    const cancel = () => scope.stop('caller_cancelled');
    if (signal?.aborted) cancel(); else signal?.addEventListener('abort', cancel, { once: true });
    try { return await withWaitScope(scope, () => within(scope, () => this.dispatch(request, scope.signal))); }
    catch (error) {
      if (!(error instanceof WaitStoppedError)) throw error;
      const op = this.sessions.get(request.terminalId ?? (request.operation === 'create' ? this.lastCreate?.terminalId : '') ?? '');
      return { ...(op ? this.snapshot(op) : {}), status: error.reason === 'deadline' ? 'deadline' : 'request_cancelled',
        ...(request.operation === 'input' ? { inputOutcome: op?.lastInput?.outcome ?? 'not_submitted' } : {}) };
    } finally { scope.dispose(); signal?.removeEventListener('abort', cancel); }
  }

  private async dispatch(request: SessionRequest, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (signal?.aborted) return { status: 'request_cancelled' };
    if (request.operation === 'list') return { status: this.closed ? 'closed' : 'ready', sessionId: this.sessionId,
      nextCreateSequence: this.nextCreateSequence, maxSessions: this.maxSessions,
      terminals: [...this.sessions.values()].map(op => ({ terminalId: op.terminalId, state: op.state })) };
    if (request.sessionId !== this.sessionId) return { status: 'session_mismatch', sessionId: this.sessionId };
    if (this.closed) return { status: 'closed' };
    if (request.operation === 'create') return independently(() => this.create(request));
    const op = this.sessions.get(request.terminalId ?? '');
    if (!op) return { status: 'not_retained' };
    if (request.operation === 'read' || request.operation === 'attach') {
      const offset = request.outputOffset ?? op.start, limit = request.outputLimit ?? 2000, wait = request.waitMs ?? 0;
      if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > MAX_OUTPUT_CODE_POINTS ||
        !Number.isInteger(wait) || wait < 0 || wait > 10000) return { status: 'invalid_request' };
      if (op.state === 'detached') { try { await this.attach(op); } catch { /* Reason is retained by attach. */ } }
      // Attachment has a separate allowance; zero wait is an immediate output snapshot.
      if (wait && offset >= op.end && ['attached', 'attaching'].includes(op.state)) {
        const observation = requestScope(wait);
        let done: (() => void) | undefined;
        try { await within(observation, () => new Promise<void>(resolve => { done = resolve; op.wake.add(done); if (this.closed) resolve(); })); }
        catch (error) { if (!(error instanceof WaitStoppedError)) throw error; }
        finally { observation.dispose(); if (done) op.wake.delete(done); }
      }
      return this.snapshot(op, offset, limit);
    }
    if (request.operation === 'close') {
      if (request.forget === true) {
        if (op.state !== 'lost' && (op.state !== 'unknown' || op.ptyId || op.creationOutcome !== 'unknown')) return { status: 'release_not_allowed' };
        this.detach(op); this.sessions.delete(op.terminalId); this.notify(op);
        return { status: 'released', cleanup: op.cleanup, remoteOutcome: 'unknown' };
      }
      return independently(() => this.terminate(op));
    }
    if (request.operation !== 'input' && request.operation !== 'resize') return { status: 'invalid_request' };
    if (request.operation === 'input') {
      // Reject oversized input before hashing it or consuming its sequence.
      const inputBytes = typeof request.data === 'string' ? Buffer.byteLength(request.data) : 0;
      if (inputBytes > MAX_INPUT_BYTES) return { status: 'invalid_request', inputOutcome: 'not_submitted',
        reason: 'input_too_large', bytes: inputBytes, maxBytes: MAX_INPUT_BYTES };
      if (!sequenceValid(request.sequence) || typeof request.data !== 'string' || !request.data.length)
        return { status: 'invalid_request', inputOutcome: 'not_submitted' };
      const digest = createHash('sha256').update(request.data).digest('hex');
      if (request.sequence < op.nextInputSequence) return op.lastInput?.sequence === request.sequence
        ? { status: op.lastInput.digest !== digest ? 'sequence_conflict' : op.busy ? 'input_pending' : 'input_result',
          inputOutcome: op.busy ? 'unknown' : op.lastInput.outcome, nextInputSequence: op.nextInputSequence }
        : { status: 'request_retired', nextInputSequence: op.nextInputSequence };
      if (request.sequence !== op.nextInputSequence) return { status: 'sequence_mismatch', nextInputSequence: op.nextInputSequence };
    } else if (!dimensionsValid(request.cols, request.rows)) return { status: 'invalid_request' };
    if (op.busy) return { status: 'busy' };
    if (['exited', 'lost', 'unknown', 'closing', 'starting'].includes(op.state)) return { status: 'session_not_writable', inputOutcome: 'not_submitted' };
    op.busy = true;
    const input = request.operation === 'input' ? { sequence: request.sequence!, digest: createHash('sha256').update(request.data!).digest('hex'), outcome: 'not_submitted' as Delivery } : undefined;
    const acknowledgeInput = (response: Record<string, unknown>) => {
      if (input) input.outcome = response.success === true ? 'submitted' : 'unknown';
    };
    if (input) { op.lastInput = input; op.nextInputSequence++; }
    return independently(async () => {
      const owner = createWaitScope({ timeoutMs: 30000 });
      let peer: TerminalPeer | undefined;
      try {
        peer = await within(owner, () => this.attach(op));
        const response = await withWaitScope(owner, () => within(owner, () => peer!.unary(input ? 'SendInput' : 'ResizePty', input
          ? { ptyId: op.ptyId, data: Buffer.from(request.data!).toString('base64') }
          : { ptyId: op.ptyId, cols: request.cols, rows: request.rows }, () => { if (input) input.outcome = 'unknown'; }, acknowledgeInput).then(response => {
          acknowledgeInput(response);
          return response;
        })));
        if (input) input.outcome = response.success === true ? 'submitted' : 'unknown';
        return { status: input ? 'input_result' : response.success === true ? 'resized' : 'resize_unconfirmed',
          ...(input ? { inputOutcome: input.outcome, nextInputSequence: op.nextInputSequence } : {}) };
      } catch (error) {
        if (input && error instanceof TerminalFailure && error.submitted) input.outcome = 'unknown';
        if (['terminal_rpc_timeout', 'deadline'].includes(code(error)) && peer && op.peer === peer) {
          this.detach(op); op.state = 'detached'; op.reason = 'terminal_rpc_timeout';
          op.reconnectGapPossible = true; this.notify(op);
        }
        return { status: code(error), ...failureFields(error), ...(input ? { inputOutcome: input.outcome, nextInputSequence: op.nextInputSequence } : {}) };
      } finally { owner.dispose(); op.busy = false; }
    });
  }

  private async create(request: SessionRequest): Promise<Record<string, unknown>> {
    const cols = request.cols ?? 80, rows = request.rows ?? 24;
    if (!sequenceValid(request.sequence) || !dimensionsValid(cols, rows)) return { status: 'invalid_request' };
    const digest = `${cols}:${rows}`;
    if (request.sequence < this.nextCreateSequence) {
      if (this.lastCreate?.sequence !== request.sequence) return { status: 'request_retired' };
      if (this.lastCreate.digest !== digest) return { status: 'sequence_conflict' };
      const prior = this.sessions.get(this.lastCreate.terminalId); return prior ? this.snapshot(prior) : { status: 'request_retired' };
    }
    if (request.sequence !== this.nextCreateSequence) return { status: 'sequence_mismatch', nextCreateSequence: this.nextCreateSequence };
    if (this.creating) return { status: 'busy' };
    if (this.sessions.size >= this.maxSessions) return { status: 'session_capacity' };
    this.creating = true;
    const owner = createWaitScope({ timeoutMs: 30000 });
    const op: Session = { terminalId: randomUUID(), state: 'starting', reason: null, cleanup: 'pending', creationOutcome: 'not_submitted',
      exitCode: null, signal: null, output: '', start: 0, end: 0, decoder: new StringDecoder('utf8'), seen: new Set(),
      reconnectGapPossible: false, nextInputSequence: 1, busy: false, wake: new Set() };
    this.sessions.set(op.terminalId, op); this.lastCreate = { sequence: request.sequence, digest, terminalId: op.terminalId }; this.nextCreateSequence++;
    const acknowledgeSpawn = (value: Record<string, unknown>) => {
      if (typeof value.ptyId === 'string' && value.ptyId) {
        op.ptyId = value.ptyId; op.creationOutcome = 'submitted'; op.state = 'detached';
        if (op.cleanup === 'identity_unknown') op.cleanup = 'pending';
      }
    };
    try {
      const connection = await withWaitScope(owner, () => within(owner, () => this.connector.connect(undefined, owner.signal).then(connection => {
        if (owner.stopReason() || this.closed) connection.peer.close();
        return connection;
      }))); op.machineId = connection.machineId;
      try {
        if (this.closed) throw new TerminalFailure('terminal_closed');
        const response = await withWaitScope(owner, () => within(owner, () => connection.peer.unary('SpawnPty', { process: { shell: '/bin/bash', args: ['--noprofile', '--norc', '-i'] },
          cwd: '/tmp', env: { BASH_ENV: '/dev/null', TERM: 'dumb', PS1: 'MCP> ', PROMPT_COMMAND: '' }, cols, rows }, () => { op.creationOutcome = 'unknown'; }, acknowledgeSpawn).then(value => {
          acknowledgeSpawn(value);
          return value;
        })));
        if (typeof response.ptyId !== 'string' || !response.ptyId) throw new TerminalFailure('spawn_identity_missing', true);
        op.ptyId = response.ptyId; op.creationOutcome = 'submitted'; op.state = 'detached';
        await within(owner, () => this.attach(op, connection.peer));
      } finally {
        if (op.peer !== connection.peer) {
          if (connection.peer.settleAccepted && !this.closed) {
            const settlement = createWaitScope({ timeoutMs: 10000 });
            try { await within(settlement, () => connection.peer.settleAccepted!()); } catch { /* No retry or deadline extension. */ }
            finally { settlement.dispose(); }
          }
          connection.peer.close();
        }
      }
    } catch (error) {
      op.reason = code(error);
      Object.assign(op, failureFields(error));
      if (error instanceof TerminalFailure && error.submitted && !op.ptyId) op.creationOutcome = 'unknown';
      if (!op.ptyId) { op.state = 'unknown'; op.cleanup = op.creationOutcome === 'not_submitted' ? 'not_created' : 'identity_unknown'; }
    } finally { owner.dispose(); this.creating = false; }
    return this.snapshot(op);
  }
  private async terminate(op: Session): Promise<Record<string, unknown>> {
    if (op.busy || op.state === 'starting' || op.state === 'closing') return { status: 'busy' };
    if (!op.ptyId && op.creationOutcome !== 'not_submitted') return this.snapshot(op);
    if (op.state === 'exited' || !op.ptyId) { this.sessions.delete(op.terminalId); return { status: 'closed', cleanup: op.cleanup }; }
    if (op.state === 'lost') return this.snapshot(op);
    op.state = 'closing'; this.detach(op); this.notify(op);
    const owner = createWaitScope({ timeoutMs: 30000 });
    let peer: TerminalPeer | undefined;
    try {
      ({ peer } = await withWaitScope(owner, () => within(owner, () => this.connector.connect(op.machineId, owner.signal).then(connection => {
        if (owner.stopReason()) connection.peer.close();
        return connection;
      }))));
      try { await withWaitScope(owner, () => within(owner, () => peer!.unary('TerminatePty', { ptyId: op.ptyId }))); } catch { /* Verify an uncertain reply without resending input. */ }
      const response = await withWaitScope(owner, () => within(owner, () => peer!.unary('ListPtys', {})));
      if (response.ptys !== undefined && !Array.isArray(response.ptys)) throw new TerminalFailure('invalid_gateway_response');
      if ((response.ptys as unknown[] | undefined ?? []).some(value => object(value) && value.ptyId === op.ptyId)) throw new TerminalFailure('termination_unconfirmed');
      this.sessions.delete(op.terminalId); return { status: 'closed', cleanup: 'process_not_listed' };
    } catch (error) {
      op.reason = code(error); op.cleanup = op.reason === 'machine_changed' ? 'machine_changed' : 'termination_unconfirmed';
      op.state = op.reason === 'machine_changed' ? 'lost' : 'detached';
      if (op.state === 'detached') op.reconnectGapPossible = true;
      return this.snapshot(op);
    } finally { owner.dispose(); peer?.close(); }
  }
  close() { this.closed = true; for (const op of this.sessions.values()) { this.detach(op); this.notify(op); } }
}
