import type { TerminalService } from './terminal.js';
import type { TerminalSessions } from './terminal-sessions.js';

export type TerminalTarget = { terminal: TerminalService; sessions: TerminalSessions };
type RetainedTarget = TerminalTarget & { inFlight: number };

/** Owns independent manager state per VM. Only empty, idle contexts can be retired. */
export class TerminalTargets {
  private readonly targets = new Map<string, RetainedTarget>();
  private closed = false;

  constructor(private readonly factory: (agentId: string) => TerminalTarget, private readonly maxTargets: number) {
    if (!Number.isSafeInteger(maxTargets) || maxTargets < 1) throw new Error('invalid_terminal_target_limit');
  }

  private canRetire(target: RetainedTarget) {
    return target.inFlight === 0 && target.terminal.canRetire && target.sessions.canRetire;
  }

  overview(offset = 0, limit = 10): Record<string, unknown> {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 128)
      return { status: 'invalid_request' };
    const entries = [...this.targets.entries()].slice(offset, offset + limit);
    return { status: this.closed ? 'closed' : 'targets', maxTargets: this.maxTargets, retainedTargets: this.targets.size,
      targetOffset: offset, targetNextOffset: offset + entries.length,
      targets: entries.map(([agentId, target]) => ({ agentId, inFlight: target.inFlight,
        canRetire: this.canRetire(target), ...target.terminal.retention, ...target.sessions.retention })) };
  }

  async handle(agentId: string, operation: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Record<string, unknown>> {
    if (this.closed) return { status: 'closed', agentId };
    if (signal?.aborted) return { status: 'request_cancelled', agentId };
    let target = this.targets.get(agentId);
    if (!target) {
      // A retired session must never be recreated by a stale execute/create request.
      if (operation !== 'status' && operation !== 'session_list' && operation !== 'wake') return { status: 'not_retained', agentId };
      let retired: [string, RetainedTarget] | undefined;
      if (this.targets.size >= this.maxTargets) {
        retired = [...this.targets.entries()].find(([, value]) => this.canRetire(value));
        if (!retired) return { status: 'target_capacity', agentId, maxTargets: this.maxTargets, retainedTargets: this.targets.size };
      }
      // Admission and reservation are synchronous; factory construction must not perform I/O.
      target = { ...this.factory(agentId), inFlight: 0 };
      if (retired) {
        this.targets.delete(retired[0]);
        retired[1].terminal.close(); retired[1].sessions.close();
      }
      this.targets.set(agentId, target);
    }
    target.inFlight++;
    try {
      const result = operation.startsWith('session_')
        ? await target.sessions.handle({ ...args, operation: operation.slice(8) }, signal)
        : await target.terminal.handle({ ...args, operation }, signal);
      return { ...result, agentId };
    } finally { target.inFlight--; }
  }

  close() {
    this.closed = true;
    for (const target of this.targets.values()) { target.terminal.close(); target.sessions.close(); }
  }
}
