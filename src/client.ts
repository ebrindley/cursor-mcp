/**
 * Thin HTTP client for the Cursor Cloud Agents v1 API.
 *
 * Handles authentication, retries, timeouts, origin checks, and response parsing
 * consistently across endpoints. This client has no dependency on @cursor/sdk.
 *
 * Retry policy: only safe reads, and 429 within the backoff ceiling. A write is
 * never retried -- Cursor may have accepted it, and a second attempt would launch
 * a second run.
 */

import type { z } from "zod";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  CursorApiError,
  CursorContractError,
  CursorTransportError,
} from "./errors.js";
import { USAGE_LIMITED_CLASS, classifyApiError, parseApiError } from "./api-errors.js";
import { log } from "./log.js";
import type { ProgressReporter } from "./progress.js";
import { sanitize } from "./untrusted.js";
import { consumeRunStream, RESUME_ID, type StreamCounts, type StreamTail } from "./run-stream.js";

const BASE_URL = "https://api.cursor.com";
const TIMEOUT_MS = 30_000;
const TOTAL_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 2;
const BASE_BACKOFF_MS = 500;
const MAX_BACKOFF_MS = 8_000;
/** Ceiling on a response body we will parse. See the check for why. */
const MAX_BODY_BYTES = 4_000_000;
/** Statuses whose responses carry no body by definition. */
const BODILESS_STATUS = new Set([204, 205, 304]);
const requestSignal = new AsyncLocalStorage<AbortSignal>();
const requestProgress = new AsyncLocalStorage<ProgressReporter>();

export function withRequestSignal<T>(
  signal: AbortSignal,
  operation: () => Promise<T>,
): Promise<T> {
  return requestSignal.run(signal, operation);
}

/** The MCP request's cancellation signal, when a tool call is in progress. */
export function currentRequestSignal(): AbortSignal | undefined {
  return requestSignal.getStore();
}

/**
 * Carry a progress reporter for the current tool call, alongside its signal.
 *
 * The same request-scoped mechanism, for the same reason: a handler deep in a
 * poll loop needs the request's notification channel without every tool
 * signature growing a parameter it does not use.
 */
export function withRequestProgress<T>(
  reporter: ProgressReporter,
  operation: () => Promise<T>,
): Promise<T> {
  return requestProgress.run(reporter, operation);
}

/** The reporter for the tool call in progress, when the client asked for one. */
export function currentRequestProgress(): ProgressReporter | undefined {
  return requestProgress.getStore();
}

/** Thrown when the caller cancelled the MCP request. Never retried. */
export class CursorCancelledError extends CursorTransportError {
  constructor(message: string) {
    super(message);
    this.name = "CursorCancelledError";
  }
}

/**
 * Sleep, but stop early when the signal aborts.
 *
 * Used for retry backoff and for run polling. A cancelled request must not keep
 * a handler parked in a timer for up to eight seconds after the client gave up.
 */
export function pause(
  ms: number,
  signal: AbortSignal | undefined,
  sleepImpl: (ms: number) => Promise<void> = sleep,
): Promise<void> {
  if (signal === undefined) return sleepImpl(ms);
  if (signal.aborted) return Promise.reject(new CursorCancelledError("cancelled by the caller"));
  return new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(new CursorCancelledError("cancelled by the caller"));
    };
    signal.addEventListener("abort", onAbort, { once: true });
    sleepImpl(ms).then(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, reject);
  });
}

export interface ClientOptions {
  apiKey: string;
  /** Test seam only. There is no environment override for this. */
  baseUrl?: string;
  /** Test seam only. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  /** Test seam only, so retry tests do not sleep. */
  sleepImpl?: (ms: number) => Promise<void>;
}

type Method = "GET" | "POST" | "DELETE";

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
  signal?: AbortSignal;
  /**
   * `false` makes this one attempt, even for a GET. For a caller that owns its
   * own retry and pacing, so every attempt it counts is an attempt sent.
   */
  retry?: false;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A query, a fragment, a backslash, or anything outside printable ASCII. */
const UNSAFE_PATH = new RegExp("[?#\\\\]|[^\\u0021-\\u007E]");

/**
 * Encode one path segment.
 *
 * Identifiers reaching a URL come from model-supplied tool arguments. Without
 * encoding, `../../v0/agents/x` reaches a different API version and `?limit=1`
 * injects a query parameter. Use this at every interpolation site:
 * `/v1/agents/${seg(id)}/runs`.
 */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

export class CursorClient {
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #origin: string;
  readonly #fetch: typeof fetch;
  readonly #timeoutMs: number;
  readonly #totalTimeoutMs: number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: ClientOptions) {
    this.#apiKey = options.apiKey;
    this.#baseUrl = options.baseUrl ?? BASE_URL;
    this.#origin = new URL(this.#baseUrl).origin;
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
    this.#totalTimeoutMs = options.totalTimeoutMs ?? TOTAL_TIMEOUT_MS;
    this.#sleep = options.sleepImpl ?? sleep;
  }

  /** GET is safe to retry. */
  get<S extends z.ZodType>(
    path: string,
    schema: S,
    options: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.#send("GET", path, schema, options, true);
  }

  /** One bounded stream read. Never reconnect or retry internally. */
  async tailRun(path: string, options: {
    durationMs: number; maxBytes: number; lastEventId?: string; signal?: AbortSignal; deadlineSignal?: AbortSignal;
    onCounts?: StreamCounts;
  }): Promise<StreamTail> {
    const url = this.#buildUrl(path, undefined);
    if (options.lastEventId !== undefined && !RESUME_ID.test(options.lastEventId)) {
      throw new CursorTransportError("Invalid run-stream resume id");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), options.durationMs);
    const caller = options.signal ?? currentRequestSignal();
    const signal = AbortSignal.any([
      controller.signal, ...(caller ? [caller] : []), ...(options.deadlineSignal ? [options.deadlineSignal] : []),
    ]);
    let response: Response | undefined;
    try {
      response = await this.#fetch(url, {
        method: "GET", redirect: "error", signal,
        headers: { Authorization: `Bearer ${this.#apiKey}`, Accept: "text/event-stream", "Accept-Encoding": "identity",
          ...(options.lastEventId === undefined ? {} : { "Last-Event-ID": options.lastEventId }) },
      });
      if (response.status === 410 || (response.status === 400 && options.lastEventId !== undefined)) {
        return { text: "", eventsRead: 0, bytesRead: 0, done: false, truncated: true,
          stopReason: response.status === 410 ? "expired" : "resume-rejected" };
      }
      if (!response.ok) throw new CursorApiError(response.status, "Cursor refused the run stream request");
      if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
        throw new CursorContractError("Run stream did not return text/event-stream");
      }
      const result = await consumeRunStream(response, signal, options.maxBytes, options.lastEventId, options.onCounts);
      if (caller?.aborted) throw new CursorCancelledError("Run activity read cancelled; the cloud run was not cancelled");
      return result;
    } catch (error) {
      if (caller?.aborted) throw new CursorCancelledError("Run activity read cancelled; the cloud run was not cancelled");
      if (controller.signal.aborted || options.deadlineSignal?.aborted) return {
        text: "", eventsRead: 0, bytesRead: 0, done: false, truncated: true, stopReason: "time-limit",
        ...(options.lastEventId === undefined ? {} : { lastEventId: options.lastEventId }),
      };
      if (error instanceof CursorApiError || error instanceof CursorContractError) throw error;
      throw new CursorTransportError("Run stream could not be read; check the run with cursor_get_run");
    } finally {
      clearTimeout(timer);
      await response?.body?.cancel().catch(() => {});
    }
  }

  /**
   * Open a run stream and hand back the live response, unread.
   *
   * `tailRun` cannot serve an export. It bounds the read to one duration, it
   * normalizes every failure into either a stop reason or a bare
   * `CursorTransportError`, and it discards the error body -- so a caller cannot
   * tell congestion from an exhausted quota, and never sees `Retry-After`. An
   * export has to make exactly that distinction, and it owns its own pacing, so
   * this method retries nothing and decides nothing: it authenticates, checks the
   * origin and the content type, classifies a refusal fully, and returns the
   * body for the caller to consume and cancel.
   */
  async openRunStream(path: string, options: { signal: AbortSignal }): Promise<Response> {
    const url = this.#buildUrl(path, undefined);
    let response: Response;
    try {
      response = await this.#fetch(url, {
        method: "GET",
        redirect: "error",
        signal: options.signal,
        headers: {
          Authorization: `Bearer ${this.#apiKey}`,
          Accept: "text/event-stream",
          // See docs/streaming.md: a compressing server that does not flush
          // buffers every event until close.
          "Accept-Encoding": "identity",
        },
      });
    } catch (error) {
      if (options.signal.aborted) {
        throw new CursorCancelledError(`GET ${path} was cancelled before the stream opened`);
      }
      throw new CursorTransportError(`GET ${path} ${this.#reason(error, this.#timeoutMs)}`);
    }
    if (!response.ok) {
      // The body decides whether waiting can help, so it is read and classified
      // here rather than reduced to a status the caller has to guess about.
      let body = "";
      try {
        body = await this.#readBody(response, "GET", path);
      } catch {
        // A refusal we could not read is still a refusal. Fall through with the
        // status alone rather than replacing it with a body-read failure.
      }
      const parsed = parseApiError(body);
      const code = machineCode(parsed.code);
      throw new CursorApiError(
        response.status,
        `GET ${path} failed with ${response.status}` +
          `${code === undefined ? "" : ` (${code})`}: ${summarize(parsed.message ?? body)}`,
        code,
        retryAfterMs(response.headers.get("retry-after")),
        classifyApiError({
          ...(code === undefined ? {} : { code }),
          ...(parsed.message === undefined ? {} : { message: parsed.message }),
        }),
      );
    }
    if (response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "text/event-stream") {
      await response.body?.cancel().catch(() => {});
      throw new CursorContractError("Run stream did not return text/event-stream");
    }
    if (response.body === null) {
      throw new CursorContractError("Run stream returned no response body");
    }
    return response;
  }

  /** POST is never retried: the server may already have acted on it. */
  post<S extends z.ZodType>(
    path: string,
    schema: S,
    options: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.#send("POST", path, schema, options, false);
  }

  /** DELETE is never retried. */
  delete<S extends z.ZodType>(
    path: string,
    schema: S,
    options: RequestOptions = {},
  ): Promise<z.infer<S>> {
    return this.#send("DELETE", path, schema, options, false);
  }

  /**
   * Resolve a request path against the API base, refusing anything that leaves
   * the configured origin.
   *
   * `new URL()` alone is not a boundary: a protocol-relative path such as
   * `//attacker.example/x`, or a fully qualified URL, resolves to that host and
   * would carry the Authorization header there. This matters because milestone 3
   * consumes artifact URLs that come *from* API responses.
   */
  #buildUrl(path: string, query: RequestOptions["query"]): URL {
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new CursorTransportError(
        `refusing request path ${JSON.stringify(path)}: it must be origin-relative`,
      );
    }
    // Query and fragment belong in `query`, not in the path. A `#` in a path
    // silently discards everything after it.
    if (UNSAFE_PATH.test(path)) {
      throw new CursorTransportError(
        `refusing request path ${JSON.stringify(path)}: it must contain no query, ` +
          `fragment, backslash, or control character`,
      );
    }
    const url = new URL(path, this.#baseUrl);
    if (url.origin !== this.#origin) {
      throw new CursorTransportError(
        `refusing request to ${url.origin}: only ${this.#origin} is allowed`,
      );
    }
    // The resolved path must be the path we asked for. URL parsing normalises
    // dot-segments, decodes `%2e`, and strips tabs -- so `/v1/%2e%2e/v0/x`
    // resolves to `/v0/x` and reaches a different API version. Comparing after
    // resolution catches every such rewrite at once, rather than relying on each
    // call site to remember `seg()`.
    if (url.pathname !== path) {
      throw new CursorTransportError(
        `refusing request path ${JSON.stringify(path)}: it resolves to ` +
          `${JSON.stringify(url.pathname)}; encode identifiers with seg()`,
      );
    }
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
    return url;
  }

  async #send<S extends z.ZodType>(
    method: Method,
    path: string,
    schema: S,
    options: RequestOptions,
    retryable: boolean,
  ): Promise<z.infer<S>> {
    let attempt = 0;
    const deadline = Date.now() + this.#totalTimeoutMs;
    const url = this.#buildUrl(path, options.query);
    const callerSignal = options.signal ?? requestSignal.getStore();
    for (;;) {
      try {
        const remaining = deadline - Date.now();
        if (remaining <= 0) {
          throw new CursorTransportError(
            `${method} ${path} exceeded the ${this.#totalTimeoutMs}ms total deadline`,
          );
        }
        return await this.#attempt(method, path, url, schema, options, remaining, callerSignal);
      } catch (error) {
        // A cancelled caller is not a transport failure to retry through: the
        // client has already stopped listening.
        if (error instanceof CursorCancelledError) throw error;
        const wait = this.#retryDelay(error, attempt, retryable && options.retry !== false);
        if (wait === undefined) throw error;
        if (Date.now() + wait >= deadline) {
          throw new CursorTransportError(
            `${method} ${path} exceeded the ${this.#totalTimeoutMs}ms total deadline`,
          );
        }
        attempt += 1;
        log.debug(`${method} ${path} retry ${attempt} in ${wait}ms`);
        await pause(wait, callerSignal, this.#sleep);
      }
    }
  }

  /**
   * How long to wait before retrying, or undefined to give up.
   *
   * A 429 is retried only when the method is safe. Without a verified
   * idempotency guarantee, a write response cannot prove the operation was not
   * accepted before throttling. A
   * Retry-After longer than the backoff ceiling means giving up rather than
   * retrying early -- retrying before the server said to would only spend the
   * remaining attempts on another 429.
   */
  #retryDelay(
    error: unknown,
    attempt: number,
    retryable: boolean,
  ): number | undefined {
    if (attempt >= MAX_RETRIES) return undefined;
    if (!retryable) return undefined;

    if (error instanceof CursorApiError) {
      if (error.status === 429) {
        // Out of quota is not congestion: no amount of waiting clears it, and
        // retrying only spends the remaining attempts. The normalized
        // classification is what decides this, because Cursor sends usage
        // exhaustion under `rate_limit_exceeded` too.
        if (error.classification === USAGE_LIMITED_CLASS) return undefined;
        if (error.retryAfterMs === undefined) return this.#backoff(attempt);
        return error.retryAfterMs > MAX_BACKOFF_MS ? undefined : error.retryAfterMs;
      }
      if (error.status >= 500) return this.#backoff(attempt);
      return undefined;
    }
    if (error instanceof CursorTransportError) {
      return this.#backoff(attempt);
    }
    return undefined;
  }

  #backoff(attempt: number): number {
    const exponential = BASE_BACKOFF_MS * 2 ** attempt;
    const capped = Math.min(exponential, MAX_BACKOFF_MS);
    return capped / 2 + Math.random() * (capped / 2);
  }

  async #attempt<S extends z.ZodType>(
    method: Method,
    path: string,
    url: URL,
    schema: S,
    options: RequestOptions,
    remainingMs: number,
    callerSignal: AbortSignal | undefined,
  ): Promise<z.infer<S>> {
    const controller = new AbortController();
    const attemptTimeoutMs = Math.min(this.#timeoutMs, remainingMs);
    const timer = setTimeout(() => controller.abort(), attemptTimeoutMs);
    const signal =
      callerSignal === undefined
        ? controller.signal
        : AbortSignal.any([controller.signal, callerSignal]);

    // The timer must survive until the body is fully read. Clearing it once
    // headers arrive leaves a response that sends headers and then stalls
    // hanging forever, with nothing left to abort it.
    try {
      let response: Response;
      try {
        response = await this.#fetch(url, {
          method,
          headers: {
            // Bearer, per the v1 authentication docs.
            Authorization: `Bearer ${this.#apiKey}`,
            Accept: "application/json",
            ...(options.body === undefined
              ? {}
              : { "Content-Type": "application/json" }),
          },
          ...(options.body === undefined
            ? {}
            : { body: JSON.stringify(options.body) }),
          redirect: "error",
          signal,
        });
      } catch (error) {
        const uncertain = method === "GET" ? "" : "; the outcome is unknown";
        if (callerSignal?.aborted) {
          throw new CursorCancelledError(
            `${method} ${path} was cancelled by the caller${uncertain}`,
          );
        }
        throw new CursorTransportError(
          `${method} ${path} ${this.#reason(error, attemptTimeoutMs)}${uncertain}`,
        );
      }

      // A body read can fail independently of the request: a reset connection, a
      // stalled stream, an abort. Swallowing that into an empty string made a
      // failed read look like a successful empty response -- and after a write,
      // like a write that definitely did not land.
      let text: string;
      try {
        text = await this.#readBody(response, method, path);
      } catch (error) {
        if (error instanceof CursorContractError) throw error;
        if (callerSignal?.aborted) {
          throw new CursorCancelledError(
            `${method} ${path} responded ${response.status} but the caller cancelled before ` +
              "the body was read; the outcome is unknown",
          );
        }
        throw new CursorTransportError(
          `${method} ${path} responded ${response.status} but the body ` +
            `${this.#reason(error, attemptTimeoutMs)}; the outcome is unknown`,
        );
      }

      if (!response.ok) {
        // The documented code is far more actionable than the status alone:
        // `agent_busy` and `usage_limit_exceeded` are both things a caller can
        // do something about, and they share their status with codes that are not.
        // No request id is captured: api.cursor.com returns no `x-request-id`
        // (nor any other correlation header) on success or on error -- verified
        // live against 200, 400, and 404. Promising one meant printing a handle
        // that never existed.
        const parsedError = parseApiError(text);
        // Both fields are untrusted body content. The message is flattened and
        // capped like any other body; the code is kept only when it looks like a
        // documented machine token, so a reflected request fragment cannot ride
        // along as a "code".
        const code = machineCode(parsedError.code);
        const detail = summarize(parsedError.message ?? text);
        // Classified from the code we kept plus the raw message. The message is
        // only matched against a recorded phrase here, never echoed from this
        // step, so matching before summarizing costs nothing.
        const classification = classifyApiError({
          ...(code === undefined ? {} : { code }),
          ...(parsedError.message === undefined ? {} : { message: parsedError.message }),
        });
        throw new CursorApiError(
          response.status,
          `${method} ${path} failed with ${response.status}` +
            `${code === undefined ? "" : ` (${code})`}: ${detail}`,
          code,
          retryAfterMs(response.headers.get("retry-after")),
          classification,
        );
      }

      let payload: unknown;
      if (text === "") {
        // 204 and 304 are bodiless by definition. An empty 200 is a broken
        // response, and saying so beats reporting every missing field.
        if (!BODILESS_STATUS.has(response.status)) {
          throw new CursorContractError(
            `${method} ${path} returned ${response.status} with an empty body`,
          );
        }
        payload = {};
      } else {
        try {
          payload = JSON.parse(text);
        } catch {
          throw new CursorContractError(
            `${method} ${path} returned a body that is not JSON`,
          );
        }
      }

      const parsed = schema.safeParse(payload);
      if (!parsed.success) {
        // The fields this operation depends on are missing or wrong. Unknown
        // extra fields are preserved by the schemas, so this only fires on real
        // drift.
        const issues = parsed.error.issues
          .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
          .join("; ");
        throw new CursorContractError(
          `${method} ${path} response did not match the expected contract -- ${issues}`,
        );
      }
      return parsed.data;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Describe a failure without echoing it. A fetch error can carry the full
   * request, headers included, in its message or cause.
   */
  async #readBody(response: Response, method: Method, path: string): Promise<string> {
    const declared = Number(response.headers.get("content-length"));
    if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
      // Release the connection rather than leaving an unread body pinning a
      // keep-alive socket until the agent times it out.
      await response.body?.cancel().catch(() => undefined);
      throw new CursorContractError(
        `${method} ${path} declared ${declared} response bytes, over the ` +
          `${MAX_BODY_BYTES} limit`,
      );
    }
    if (response.body === null) return "";

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let bytes = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_BODY_BYTES) {
        await reader.cancel();
        throw new CursorContractError(
          `${method} ${path} exceeded the ${MAX_BODY_BYTES} response-byte limit`,
        );
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  }

  #reason(error: unknown, timeoutMs: number): string {
    if (error instanceof Error && error.name === "AbortError") {
      return `timed out after ${timeoutMs}ms`;
    }
    return "transport failure";
  }
}

/** A documented error code is a short lowercase token such as `agent_busy`. */
const MACHINE_CODE = new RegExp("^[A-Za-z0-9_.-]{1,64}$");

function machineCode(code: string | undefined): string | undefined {
  return code !== undefined && MACHINE_CODE.test(code) ? code : undefined;
}

/** Keep an upstream error body short, flat, and free of hidden characters. */
function summarize(text: string): string {
  const flat = sanitize(text).replace(new RegExp("\\s+", "g"), " ").trim();
  return flat.length > 300 ? `${flat.slice(0, 300)}...` : flat || "(empty body)";
}

/**
 * Parse Retry-After per RFC 9110 section 10.2.3: `delay-seconds / HTTP-date`,
 * where delay-seconds is `1*DIGIT` -- no sign, no decimal point, no exponent,
 * no hex.
 *
 * Strictness is the whole point. `Number()` accepts "-5", "1.5", "0x10", and
 * "1e3", and anything it rejects used to fall through to `Date.parse`, which
 * reads "-5" as a date in the past and yields a 0 ms delay: an immediate retry
 * against a server that has just said it is overloaded. An unparseable value
 * must be treated as absent so our own backoff applies, never as zero.
 */
function retryAfterMs(header: string | null): number | undefined {
  if (!header) return undefined;
  const value = header.trim();

  if (DELAY_SECONDS.test(value)) return Number(value) * 1000;

  // All three HTTP-date forms begin with a day name, which is what separates a
  // date from a malformed number. Without this, "0x10" reaches Date.parse.
  if (!HTTP_DATE_START.test(value)) return undefined;
  const date = Date.parse(value);
  if (Number.isNaN(date)) return undefined;
  // A date already in the past legitimately means "retry now".
  return Math.max(date - Date.now(), 0);
}

const DELAY_SECONDS = new RegExp("^\\d+$");
const HTTP_DATE_START = new RegExp("^[A-Za-z]");
