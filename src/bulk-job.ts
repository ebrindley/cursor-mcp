/**
 * Bulk archive/unarchive as a paced background job.
 *
 * Cursor has no bulk endpoint: every agent is one scope GET plus one POST. A
 * tool call must return within the host's request timeout, so a job outlives
 * the call that started it and is inspected with separate status calls.
 *
 * Pacing is per endpoint class and applies to every HTTP attempt, retries
 * included: the job owns retries, and its requests opt out of the client's own
 * (`retry: false`), so the count the pacer keeps is the count Cursor sees.
 * Cursor's limits are unpublished and were measured (see config `BulkSchema`);
 * the pacer keeps under the configured budgets and honours a 429's Retry-After
 * in full, but other processes on the same key are outside its control.
 *
 * Scope is judged from a fresh record before every POST attempt, retries
 * included, never from the session cache: a grant earned minutes ago does not
 * authorize a write now. The record's id is compared with the requested id
 * before its verdict is used.
 *
 * A POST whose response was lost is `uncertain`, never `pending` or `failed`:
 * Cursor may have applied it. Archive and unarchive are idempotent, so
 * re-sending is harmless, but the job does not do it on its own.
 *
 * A job lives in this process. Shutdown aborts in-flight requests and the
 * record is gone; recovery is re-submitting the original ids.
 */

import { randomUUID } from "node:crypto";
import type { AgentScope } from "./agent-scope.js";
import { USAGE_LIMITED_CLASS } from "./api-errors.js";
import type { CursorClient } from "./client.js";
import { seg } from "./client.js";
import type { BulkSettings } from "./config.js";
import {
  CursorApiError,
  CursorContractError,
  CursorTransportError,
} from "./errors.js";
import { AgentSchema, IdResponseSchema } from "./schemas.js";

export type BulkAction = "archive" | "unarchive";

export type ItemState =
  | "pending"
  | "inFlight"
  | "retrying"
  | "done"
  | "denied"
  | "unresolved"
  | "failed"
  | "uncertain"
  | "notSubmitted";

export type JobState = "running" | "cancelling" | "completed" | "cancelled" | "stopped";
export type StopReason = "usage-exhausted" | "timeout" | "shutdown";

export interface BulkItem {
  agentId: string;
  state: ItemState;
  code?: string;
  httpStatus?: number;
  /** HTTP attempts made for this agent, reads and writes. */
  attempts: number;
  /** When a retrying agent may next be attempted (epoch ms). */
  nextAttemptAt?: number;
}

/** Time source and abortable sleep. Real timers by default; tests fake them. */
export interface Clock {
  now(): number;
  /** Resolves true after `ms`, false if `signal` aborts first. */
  sleep(ms: number, signal?: AbortSignal): Promise<boolean>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve(false);
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort);
        resolve(true);
      }, Math.max(0, ms));
      const onAbort = () => {
        clearTimeout(timer);
        resolve(false);
      };
      signal?.addEventListener("abort", onAbort, { once: true });
    }),
};

const WINDOW_MS = 60_000;
/** A scope verdict older than this is re-read before the POST it authorizes. */
const FRESHNESS_MS = 15_000;
/** Finished jobs kept for status reads. The running job is never evicted. */
const MAX_RETAINED = 5;

/**
 * At most `limit` attempts in any 60-second window, plus a shared cooldown a
 * 429 sets. A slot is taken synchronously when granted, so concurrent callers
 * cannot both see the last one.
 */
export class RateWindow {
  readonly #stamps: number[] = [];
  #blockedUntil = 0;
  attempts = 0;

  constructor(
    readonly limit: number,
    readonly clock: Clock,
  ) {}

  get blockedUntil(): number {
    return this.#blockedUntil;
  }

  cooldown(ms: number): void {
    this.#blockedUntil = Math.max(this.#blockedUntil, this.clock.now() + ms);
  }

  /** Resolves true once a slot is taken, false if `signal` aborts first. */
  async acquire(signal: AbortSignal): Promise<boolean> {
    for (;;) {
      if (signal.aborted) return false;
      const now = this.clock.now();
      while (this.#stamps.length > 0 && this.#stamps[0]! <= now - WINDOW_MS) {
        this.#stamps.shift();
      }
      let waitMs: number;
      if (now < this.#blockedUntil) {
        waitMs = this.#blockedUntil - now;
      } else if (this.#stamps.length >= this.limit) {
        waitMs = this.#stamps[0]! + WINDOW_MS - now;
      } else {
        this.#stamps.push(now);
        this.attempts += 1;
        return true;
      }
      if (!(await this.clock.sleep(waitMs, signal))) return false;
    }
  }
}

type Failure =
  | { kind: "usage" }
  | { kind: "rate"; waitMs?: number }
  | { kind: "transient"; code: string; httpStatus?: number }
  | { kind: "final"; code: string; httpStatus?: number };

function classify(error: unknown): Failure {
  if (error instanceof CursorApiError) {
    if (error.classification === USAGE_LIMITED_CLASS) return { kind: "usage" };
    if (error.status === 429) {
      return error.retryAfterMs === undefined
        ? { kind: "rate" }
        : { kind: "rate", waitMs: error.retryAfterMs };
    }
    if (error.status === 404) return { kind: "final", code: "NOT_FOUND", httpStatus: 404 };
    if (error.status >= 500) {
      return { kind: "transient", code: "SERVER_ERROR", httpStatus: error.status };
    }
    return { kind: "final", code: error.code ?? "API_ERROR", httpStatus: error.status };
  }
  if (error instanceof CursorContractError) return { kind: "final", code: "CONTRACT_ERROR" };
  if (error instanceof CursorTransportError) return { kind: "transient", code: "TRANSPORT_ERROR" };
  return { kind: "final", code: "INTERNAL_ERROR" };
}

export interface JobSnapshot {
  jobId: string;
  action: BulkAction;
  state: JobState;
  stopReason?: StopReason;
  total: number;
  duplicatesIgnored: number;
  counts: Record<ItemState, number>;
  createdAt: string;
  finishedAt?: string;
  elapsedMs: number;
  attempts: { reads: number; writes: number; rateLimited: number };
  limits: { readsPerMinute: number; writesPerMinute: number; maxInFlight: number };
  cooldownUntil?: { reads?: string; writes?: string };
}

export class BulkJob {
  readonly jobId = `bulk-${randomUUID()}`;
  readonly items: BulkItem[];
  readonly createdAt: number;
  finishedAt?: number;
  state: JobState = "running";
  stopReason?: StopReason;
  rateLimited = 0;
  readonly done: Promise<void>;

  /** Aborted on cancel, stop, or shutdown: nothing new starts. */
  readonly #admission = new AbortController();
  /** Aborted only on shutdown: in-flight requests are cut off. */
  readonly #shutdown = new AbortController();
  #cancelRequested = false;
  #resolveDone!: () => void;

  constructor(
    readonly action: BulkAction,
    agentIds: readonly string[],
    readonly duplicatesIgnored: number,
    private readonly deps: {
      client: CursorClient;
      scope: Pick<AgentScope, "classify">;
      settings: BulkSettings;
      reads: RateWindow;
      writes: RateWindow;
      clock: Clock;
    },
  ) {
    this.items = agentIds.map((agentId) => ({ agentId, state: "pending", attempts: 0 }));
    this.createdAt = deps.clock.now();
    this.done = new Promise((resolve) => {
      this.#resolveDone = resolve;
    });
  }

  get finished(): boolean {
    return this.finishedAt !== undefined;
  }

  /** Start the workers. Not awaited by the caller: the job outlives the request. */
  run(): void {
    const { settings, clock } = this.deps;
    void clock
      .sleep(settings.jobTimeoutMinutes * 60_000, this.#admission.signal)
      .then((expired) => {
        if (expired && !this.finished) this.#stop("timeout");
      });
    let next = 0;
    const worker = async () => {
      while (next < this.items.length) {
        const item = this.items[next++]!;
        await this.#process(item);
      }
    };
    const workers = Array.from(
      { length: Math.min(settings.maxInFlight, this.items.length) },
      worker,
    );
    void Promise.all(workers).then(() => this.#finish());
  }

  cancel(): void {
    if (this.finished || this.#cancelRequested) return;
    this.#cancelRequested = true;
    if (this.stopReason === undefined) this.state = "cancelling";
    this.#admission.abort();
  }

  /** Server shutdown: stop admissions and cut off in-flight requests. */
  shutdown(): void {
    if (this.finished) return;
    this.#stop("shutdown");
    this.#shutdown.abort();
  }

  snapshot(): JobSnapshot {
    const { settings, reads, writes, clock } = this.deps;
    const counts = {
      pending: 0,
      inFlight: 0,
      retrying: 0,
      done: 0,
      denied: 0,
      unresolved: 0,
      failed: 0,
      uncertain: 0,
      notSubmitted: 0,
    } satisfies Record<ItemState, number>;
    for (const item of this.items) counts[item.state] += 1;
    const now = clock.now();
    const cooldown: { reads?: string; writes?: string } = {};
    if (!this.finished && reads.blockedUntil > now) {
      cooldown.reads = new Date(reads.blockedUntil).toISOString();
    }
    if (!this.finished && writes.blockedUntil > now) {
      cooldown.writes = new Date(writes.blockedUntil).toISOString();
    }
    return {
      jobId: this.jobId,
      action: this.action,
      state: this.state,
      ...(this.stopReason === undefined ? {} : { stopReason: this.stopReason }),
      total: this.items.length,
      duplicatesIgnored: this.duplicatesIgnored,
      counts,
      createdAt: new Date(this.createdAt).toISOString(),
      ...(this.finishedAt === undefined
        ? {}
        : { finishedAt: new Date(this.finishedAt).toISOString() }),
      elapsedMs: (this.finishedAt ?? now) - this.createdAt,
      attempts: { reads: this.#readAttempts, writes: this.#writeAttempts, rateLimited: this.rateLimited },
      limits: {
        readsPerMinute: settings.readsPerMinute,
        writesPerMinute: settings.writesPerMinute,
        maxInFlight: settings.maxInFlight,
      },
      ...(Object.keys(cooldown).length === 0 ? {} : { cooldownUntil: cooldown }),
    };
  }

  #readAttempts = 0;
  #writeAttempts = 0;

  #stop(reason: StopReason): void {
    if (this.stopReason === undefined) this.stopReason = reason;
    if (!this.finished) this.state = "stopped";
    this.#admission.abort();
  }

  #finish(): void {
    this.finishedAt = this.deps.clock.now();
    this.state =
      this.stopReason !== undefined
        ? "stopped"
        : this.#cancelRequested
          ? "cancelled"
          : "completed";
    this.#admission.abort();
    this.#resolveDone();
  }

  #notSubmitted(item: BulkItem): void {
    item.state = "notSubmitted";
    delete item.nextAttemptAt;
    item.code =
      this.stopReason === "usage-exhausted"
        ? "USAGE_EXHAUSTED"
        : this.stopReason === "timeout"
          ? "JOB_TIMEOUT"
          : this.stopReason === "shutdown"
            ? "SHUTDOWN"
            : "CANCELLED";
  }

  #settle(item: BulkItem, state: ItemState, code?: string, httpStatus?: number): void {
    item.state = state;
    delete item.nextAttemptAt;
    if (code === undefined) delete item.code;
    else item.code = code;
    if (httpStatus === undefined) delete item.httpStatus;
    else item.httpStatus = httpStatus;
  }

  /** Honour Retry-After in full; otherwise capped exponential backoff with jitter. */
  #backoff(attempt: number, retryAfterMs?: number): number {
    const { backoffBaseMs, backoffMaxMs } = this.deps.settings;
    if (retryAfterMs !== undefined) return retryAfterMs + Math.random() * 500;
    const capped = Math.min(backoffMaxMs, backoffBaseMs * 2 ** Math.max(0, attempt - 1));
    return capped / 2 + Math.random() * (capped / 2);
  }

  async #process(item: BulkItem): Promise<void> {
    const { client, scope, settings, reads, writes, clock } = this.deps;
    const admission = this.#admission.signal;
    const shutdown = this.#shutdown.signal;
    let rateLimited = 0;
    let transient = 0;

    const onRateLimit = (window: RateWindow, waitMs: number | undefined): boolean => {
      this.rateLimited += 1;
      rateLimited += 1;
      if (rateLimited > settings.maxRateLimitRetries) {
        this.#settle(item, "failed", "RATE_LIMITED", 429);
        return false;
      }
      const wait = this.#backoff(rateLimited, waitMs);
      window.cooldown(wait);
      item.state = "retrying";
      item.nextAttemptAt = clock.now() + wait;
      return true;
    };

    for (;;) {
      if (admission.aborted) return this.#notSubmitted(item);
      // Reading scope while writes are cooling down would only produce a verdict
      // that is stale by the time a write slot opens.
      const writeCooldown = writes.blockedUntil - clock.now();
      if (writeCooldown > 0 && !(await clock.sleep(writeCooldown, admission))) {
        return this.#notSubmitted(item);
      }

      // Fresh scope read. A GET mutates nothing, so any failure before the POST
      // leaves the agent as it was.
      if (!(await reads.acquire(admission))) return this.#notSubmitted(item);
      item.state = "inFlight";
      delete item.nextAttemptAt;
      item.attempts += 1;
      this.#readAttempts += 1;
      let readAt = 0;
      try {
        const agent = await client.get(`/v1/agents/${seg(item.agentId)}`, AgentSchema, {
          signal: shutdown,
          retry: false,
        });
        readAt = clock.now();
        if (agent.id !== item.agentId) {
          return this.#settle(item, "failed", "IDENTITY_MISMATCH");
        }
        const verdict = scope.classify(agent);
        if (verdict === "denied") return this.#settle(item, "denied", "POLICY_DENIED");
        if (verdict === "unresolved") {
          return this.#settle(item, "unresolved", "SCOPE_UNRESOLVED");
        }
      } catch (error) {
        if (shutdown.aborted) return this.#notSubmitted(item);
        const failure = classify(error);
        if (failure.kind === "usage") {
          this.#stop("usage-exhausted");
          return this.#notSubmitted(item);
        }
        if (failure.kind === "rate") {
          if (onRateLimit(reads, failure.waitMs)) continue;
          return;
        }
        if (failure.kind === "transient") {
          transient += 1;
          if (transient > settings.maxTransientRetries) {
            return this.#settle(item, "failed", failure.code, failure.httpStatus);
          }
          const wait = this.#backoff(transient);
          item.state = "retrying";
          item.nextAttemptAt = clock.now() + wait;
          if (!(await clock.sleep(wait, admission))) return this.#notSubmitted(item);
          continue;
        }
        return this.#settle(item, "failed", failure.code, failure.httpStatus);
      }

      if (!(await writes.acquire(admission))) return this.#notSubmitted(item);
      // A long wait for a write slot means the verdict is stale: read again.
      if (clock.now() - readAt > FRESHNESS_MS) continue;

      item.state = "inFlight";
      item.attempts += 1;
      this.#writeAttempts += 1;
      try {
        const response = await client.post(
          `/v1/agents/${seg(item.agentId)}/${this.action}`,
          IdResponseSchema,
          { signal: shutdown },
        );
        if (response.id !== item.agentId) {
          return this.#settle(item, "uncertain", "IDENTITY_MISMATCH");
        }
        return this.#settle(item, "done");
      } catch (error) {
        const failure = classify(error);
        if (failure.kind === "usage") {
          this.#stop("usage-exhausted");
          return this.#settle(item, "failed", "USAGE_EXHAUSTED", 429);
        }
        if (failure.kind === "rate") {
          // Refused, so re-sent; the loop re-reads scope before the retry.
          if (onRateLimit(writes, failure.waitMs)) continue;
          return;
        }
        if (failure.kind === "final" && failure.httpStatus !== undefined) {
          return this.#settle(item, "failed", failure.code, failure.httpStatus);
        }
        // Lost response, 5xx, malformed body, or shutdown mid-request: Cursor may
        // have applied it.
        const code =
          failure.kind === "final"
            ? failure.code
            : failure.httpStatus !== undefined
              ? "SERVER_ERROR"
              : "OUTCOME_UNKNOWN";
        return this.#settle(item, "uncertain", code, failure.httpStatus);
      }
    }
  }
}

/** One active job per server, a few finished ones kept for status reads. */
export class BulkJobs {
  readonly #jobs = new Map<string, BulkJob>();
  readonly #reads: RateWindow;
  readonly #writes: RateWindow;
  #active: BulkJob | undefined;

  constructor(
    private readonly client: CursorClient,
    private readonly scope: Pick<AgentScope, "classify">,
    readonly settings: BulkSettings,
    private readonly clock: Clock = realClock,
  ) {
    this.#reads = new RateWindow(settings.readsPerMinute, clock);
    this.#writes = new RateWindow(settings.writesPerMinute, clock);
  }

  get active(): BulkJob | undefined {
    return this.#active?.finished === false ? this.#active : undefined;
  }

  start(action: BulkAction, agentIds: readonly string[]): BulkJob {
    const running = this.active;
    if (running !== undefined) {
      throw new Error(
        `bulk job ${running.jobId} is still running; cancel it or wait for it to finish`,
      );
    }
    const unique = [...new Set(agentIds)];
    const job = new BulkJob(action, unique, agentIds.length - unique.length, {
      client: this.client,
      scope: this.scope,
      settings: this.settings,
      reads: this.#reads,
      writes: this.#writes,
      clock: this.clock,
    });
    this.#evict();
    this.#jobs.set(job.jobId, job);
    this.#active = job;
    job.run();
    return job;
  }

  get(jobId: string): BulkJob | undefined {
    return this.#jobs.get(jobId);
  }

  close(): void {
    for (const job of this.#jobs.values()) job.shutdown();
  }

  #evict(): void {
    const finished = [...this.#jobs.values()].filter((job) => job.finished);
    while (finished.length >= MAX_RETAINED) {
      this.#jobs.delete(finished.shift()!.jobId);
    }
  }
}
