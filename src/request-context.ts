import { AsyncLocalStorage } from "node:async_hooks";
import type { ProgressReporter } from "./progress.js";
import { createWaitScope, type WaitScope } from "./wait.js";
interface RequestContext { signal?: AbortSignal | undefined; scope?: WaitScope | undefined; progress?: ProgressReporter | undefined }
const context = new AsyncLocalStorage<RequestContext>();
/** Raw MCP cancellation only. Scope deadlines are carried by currentRequestScope. */
export function currentRequestSignal(): AbortSignal | undefined { return context.getStore()?.signal; }
export function currentRequestScope(): WaitScope | undefined { return context.getStore()?.scope; }
export function currentRequestProgress(): ProgressReporter | undefined { return context.getStore()?.progress; }
export function withRequestSignal<T>(signal: AbortSignal, operation: () => T): T { return context.run({ ...context.getStore(), signal }, operation); }
export function withRequestProgress<T>(progress: ProgressReporter, operation: () => T): T { return context.run({ ...context.getStore(), progress }, operation); }
export function withWaitScope<T>(scope: WaitScope, operation: () => T): T { return context.run({ ...context.getStore(), scope }, operation); }
/** Accepted work and containment must explicitly shed the observer's context. */
export function independently<T>(operation: () => T): T { return context.run({}, operation); }
export function requestScope(timeoutMs: number): WaitScope {
  return createWaitScope({ timeoutMs, parent: currentRequestScope(), signal: currentRequestScope() ? undefined : currentRequestSignal() });
}
