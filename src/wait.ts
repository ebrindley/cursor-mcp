/** Bounded observation. Stopping a wait does not establish what the work did. */
export type StopReason = "deadline" | "caller_cancelled" | "shutdown";
export interface Clock { now(): number; wallNow(): number }
export const systemClock: Clock = { now: () => performance.now(), wallNow: () => Date.now() };
export interface DisposableTimer { dispose(): void; unref(): void }
export function schedule(ms: number, callback: () => void): DisposableTimer {
  const timer = setTimeout(callback, Math.max(0, ms));
  return { dispose: () => clearTimeout(timer), unref: () => { timer.unref(); } };
}
export class WaitStoppedError extends Error {
  constructor(readonly reason: StopReason) {
    super(reason === "deadline" ? "Observation deadline reached; completion was not confirmed."
      : reason === "shutdown" ? "Observation stopped during shutdown; completion was not confirmed."
      : "Observation cancelled by the caller; accepted work may still complete.");
    this.name = "WaitStoppedError";
  }
}
export type WaitOutcome<T> = { kind: "completed"; value: T } | { kind: "failed"; error: unknown } | { kind: "stopped"; reason: StopReason };
export interface WaitOptions {
  timeoutMs: number;
  parent?: WaitScope | undefined;
  signal?: AbortSignal | undefined;
  signalReason?: StopReason | undefined;
  clock?: Clock | undefined;
}
export class WaitScope {
  readonly signal: AbortSignal;
  readonly clock: Clock;
  readonly deadline: number;
  private readonly controller = new AbortController();
  private readonly timer: DisposableTimer;
  private readonly removers: Array<() => void> = [];
  private reason: StopReason | undefined;
  constructor(options: WaitOptions) {
    if (!Number.isFinite(options.timeoutMs) || options.timeoutMs < 0) throw new RangeError("timeoutMs must be finite and non-negative");
    this.signal = this.controller.signal;
    this.clock = options.parent?.clock ?? options.clock ?? systemClock;
    this.deadline = Math.min(this.clock.now() + options.timeoutMs, options.parent?.deadline ?? Infinity);
    const bind = (signal: AbortSignal, reason: () => StopReason) => {
      const stop = () => this.stop(reason());
      if (signal.aborted) stop();
      else { signal.addEventListener("abort", stop, { once: true }); this.removers.push(() => signal.removeEventListener("abort", stop)); }
    };
    if (options.parent) bind(options.parent.signal, () => options.parent!.stopReason() ?? "caller_cancelled");
    if (options.signal) bind(options.signal, () => options.signalReason ?? "caller_cancelled");
    this.timer = schedule(this.remainingMs(), () => this.stop("deadline"));
    if (this.deadline <= this.clock.now()) this.stop("deadline");
  }
  remainingMs(): number { return Math.max(0, this.deadline - this.clock.now()); }
  stopReason(): StopReason | undefined {
    if (!this.reason && this.remainingMs() === 0) this.stop("deadline");
    return this.reason;
  }
  stop(reason: StopReason): void { if (!this.reason) { this.reason = reason; this.controller.abort(); } }
  throwIfStopped(): void { const reason = this.stopReason(); if (reason) throw new WaitStoppedError(reason); }
  child(timeoutMs: number): WaitScope { return createWaitScope({ timeoutMs, parent: this }); }
  dispose(): void { this.timer.dispose(); for (const remove of this.removers.splice(0)) remove(); }
}
export function createWaitScope(options: WaitOptions): WaitScope { return new WaitScope(options); }
/** Consume late settlement; never launch work when admission is already closed. */
export function waitFor<T>(scope: WaitScope, start: () => PromiseLike<T> | T): Promise<WaitOutcome<T>> {
  const reason = scope.stopReason();
  if (reason) return Promise.resolve({ kind: "stopped", reason });
  return new Promise(resolve => {
    let settled = false;
    const finish = (result: WaitOutcome<T>) => {
      if (settled) return;
      settled = true;
      scope.signal.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const onAbort = () => finish({ kind: "stopped", reason: scope.stopReason() ?? "caller_cancelled" });
    scope.signal.addEventListener("abort", onAbort, { once: true });
    if (scope.signal.aborted) { onAbort(); return; }
    try { Promise.resolve(start()).then(value => finish({ kind: "completed", value }), error => finish({ kind: "failed", error })); }
    catch (error) { finish({ kind: "failed", error }); }
  });
}
export async function within<T>(scope: WaitScope, start: () => PromiseLike<T> | T): Promise<T> {
  const result = await waitFor(scope, start);
  if (result.kind === "completed") return result.value;
  if (result.kind === "failed") throw result.error;
  throw new WaitStoppedError(result.reason);
}
export async function sleep(scope: WaitScope, ms: number): Promise<void> {
  let timer: DisposableTimer | undefined;
  try { await within(scope, () => new Promise<void>(resolve => { timer = schedule(ms, resolve); })); }
  finally { timer?.dispose(); }
}
/** A standalone delay for cadence/test seams; observation uses sleep(scope, ms). */
export function delay(ms: number): Promise<void> { return new Promise(resolve => { schedule(ms, resolve); }); }
