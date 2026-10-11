import { describe, expect, it, vi, afterEach } from "vitest";
import { createWaitScope, waitFor, within, sleep, WaitStoppedError } from "../src/wait.js";
import { independently, currentRequestScope, currentRequestSignal, withRequestSignal, withWaitScope } from "../src/request-context.js";

afterEach(() => vi.useRealTimers());
describe("bounded observation", () => {
  it("settles a stalled operation once and consumes its late rejection", async () => {
    vi.useFakeTimers();
    const scope = createWaitScope({ timeoutMs: 20 });
    let reject!: (error: Error) => void;
    const result = waitFor(scope, () => new Promise<never>((_, fail) => { reject = fail; }));
    await vi.advanceTimersByTimeAsync(20);
    expect(await result).toEqual({ kind: "stopped", reason: "deadline" });
    reject(new Error("late"));
    await Promise.resolve();
    expect(await result).toEqual({ kind: "stopped", reason: "deadline" });
    scope.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("prevents admission after stop without trusting signal reason", async () => {
    const caller = new AbortController();
    caller.abort("deadline");
    const scope = createWaitScope({ timeoutMs: 100, signal: caller.signal });
    const start = vi.fn(() => 1);
    expect(await waitFor(scope, start)).toEqual({ kind: "stopped", reason: "caller_cancelled" });
    expect(start).not.toHaveBeenCalled();
    scope.dispose();
  });
  it("children share elapsed budget despite a wall clock jump", async () => {
    let elapsed = 0, wall = 1000;
    const parent = createWaitScope({ timeoutMs: 100, clock: { now: () => elapsed, wallNow: () => wall } });
    elapsed = 80; wall = -100000;
    const child = parent.child(100);
    expect(child.remainingMs()).toBe(20);
    elapsed = 100;
    await expect(within(child, () => 1)).rejects.toBeInstanceOf(WaitStoppedError);
    child.dispose(); parent.dispose();
  });
  it("cancels sleep and removes its timer", async () => {
    vi.useFakeTimers();
    const scope = createWaitScope({ timeoutMs: 10000 });
    const sleeping = sleep(scope, 5000);
    scope.stop("shutdown");
    await expect(sleeping).rejects.toMatchObject({ reason: "shutdown" });
    scope.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("detaches accepted owners from request scope", () => {
    const scope = createWaitScope({ timeoutMs: 100 });
    withWaitScope(scope, () => {
      expect(currentRequestScope()).toBe(scope);
      independently(() => expect(currentRequestScope()).toBeUndefined());
      expect(currentRequestScope()).toBe(scope);
    });
    scope.dispose();
  });
  it("keeps an enclosing deadline distinct from raw caller cancellation", () => {
    const caller = new AbortController();
    const scope = createWaitScope({ timeoutMs: 100, signal: caller.signal });
    withRequestSignal(caller.signal, () => withWaitScope(scope, () => {
      scope.stop("deadline");
      expect(currentRequestSignal()).toBe(caller.signal);
      expect(currentRequestSignal()?.aborted).toBe(false);
      expect(currentRequestScope()?.stopReason()).toBe("deadline");
    }));
    scope.dispose();
  });
});
