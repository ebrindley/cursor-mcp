/**
 * Server-authored progress notifications for a monitoring read.
 *
 * The MCP client attaches a progress token to a tool call only when it actually
 * intends to consume notifications, so the token's absence -- not a policy
 * setting -- is what silences this. Nothing here changes what a tool returns,
 * how long it waits, or what it reads: a notification is a side channel, and a
 * send that fails is dropped rather than turned into a failed read.
 *
 * Messages are written here, from counters this server owns (polls, elapsed
 * time, events, bytes). Cursor's own prose, thinking, and transcript text never
 * reach a notification: it is untrusted text, a client may render it outside the
 * tool result where the caller cannot see its provenance, and it would be
 * unbounded.
 */

import { log } from "./log.js";
import { capBytes, sanitize } from "./untrusted.js";

/** The token the client supplied. Zero is a valid token, so absence is `undefined`. */
export type ProgressToken = string | number;

/** What the SDK's request-scoped `sendNotification` does, narrowed to progress. */
export type ProgressSend = (params: {
  progressToken: ProgressToken;
  progress: number;
  message?: string;
}) => Promise<void>;

/** Longest notification message sent, in bytes. A counter line needs far less. */
const MAX_MESSAGE_BYTES = 200;
/** Ceiling on notifications per tool call, whatever the counters do. */
const MAX_SENDS = 60;

export interface ProgressOptions {
  /** Test seam, so a cadence test does not sleep. */
  now?: () => number;
}

/**
 * Sends at most one notification per allowed tick, with a monotonic counter and
 * no fabricated total.
 *
 * `total` is deliberately never sent. A monitoring read does not know how many
 * polls or events remain, and a client that receives a total renders a
 * percentage -- a fabricated one, which is worse than no bar at all.
 */
export class ProgressReporter {
  readonly #send: ProgressSend;
  readonly #token: ProgressToken;
  readonly #now: () => number;
  #progress = 0;
  #lastSentAt: number | undefined;
  #stopped = false;

  constructor(send: ProgressSend, token: ProgressToken, options: ProgressOptions = {}) {
    this.#send = send;
    this.#token = token;
    this.#now = options.now ?? Date.now;
  }

  /** Notifications sent so far. The value carried by the next send is this plus one. */
  get sent(): number {
    return this.#progress;
  }

  /**
   * Report the current counters, at most once per `minGapMs`. The gap belongs to
   * the call site, because the useful cadence does: one send per poll for a wait
   * whose interval is already a second or more, one per second for a stream that
   * can deliver hundreds of events in that time.
   *
   * Fire and forget: the caller is inside a read and must not wait on, or fail
   * for, the client's notification channel.
   *
   * Coalescing is dropping, not queueing. Every message is built from live
   * counters at call time, so the next send that is allowed already carries the
   * newest numbers and a queued older one would only be stale.
   */
  report(message: string, minGapMs = 0): void {
    if (this.#stopped) return;
    const at = this.#now();
    if (this.#lastSentAt !== undefined && minGapMs > 0 && at - this.#lastSentAt < minGapMs) {
      return;
    }
    if (this.#progress >= MAX_SENDS) {
      this.#stopped = true;
      return;
    }
    this.#lastSentAt = at;
    this.#progress += 1;
    const text = capBytes(sanitize(message), MAX_MESSAGE_BYTES).text;
    void this.#send({
      progressToken: this.#token,
      progress: this.#progress,
      ...(text === "" ? {} : { message: text }),
    }).catch((error: unknown) => {
      // A client that rejects or has gone away gets no further notifications,
      // and the read it asked for continues unaffected.
      this.#stopped = true;
      log.debug(`progress notification dropped: ${error instanceof Error ? error.message : "unknown"}`);
    });
  }

  /** Stop sending. Called when the request has produced its result. */
  done(): void {
    this.#stopped = true;
  }
}
