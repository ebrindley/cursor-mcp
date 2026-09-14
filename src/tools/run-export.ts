/**
 * `cursor_export_run`: one terminal run's whole replay, on disk.
 *
 * The tool that reads Cursor and writes local files, so it is the one tool whose
 * authorization is two operator acts rather than one -- an explicit tool grant, and
 * a configured storage root. `read:*` does not reach it. docs/run-export.md is the
 * contract; the comments here only say why the code looks like it does.
 */

import type { FileHandle } from "node:fs/promises";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentScope } from "../agent-scope.js";
import { USAGE_LIMITED_CLASS } from "../api-errors.js";
import {
  currentRequestSignal,
  CursorCancelledError,
  pause,
  seg,
  type CursorClient,
} from "../client.js";
import { activeProfile, resolveExportRoot, type Policy } from "../config.js";
import {
  CursorApiError,
  CursorContractError,
  CursorTransportError,
  CursorUsageExhaustedError,
  PolicyError,
} from "../errors.js";
import {
  assertNotExported,
  discardEmptyPartial,
  exportPaths,
  openPartial,
  partialBytes,
  publishRaw,
  writeFully,
  writeSidecar,
  type ExportPaths,
} from "../export-store.js";
import { log } from "../log.js";
import {
  callTotals,
  captureRunStream,
  EXPORT_STOPS,
  terminalSidecar,
  toolsSidecar,
  type RunCapture,
} from "../run-export.js";
import { isTerminal, RunSchema } from "../schemas.js";
import { capBytes, sanitize } from "../untrusted.js";
import { LOCAL_WRITE } from "./annotations.js";
import { defineTool } from "./register.js";
import { ok, structuredCost } from "./result.js";

/** Ceiling on the whole call: scope, status read, streaming, and sidecars. */
const MAX_EXPORT_MS = 45_000;

/** Attempts at opening the stream, including the first. */
const MAX_ATTEMPTS = 3;

/** Waits used when a refusal carried no `Retry-After`, per attempt already made. */
const FALLBACK_WAITS = [1_000, 3_000];

/** Time kept back so publication and sidecars are not cut off by the ceiling. */
const PUBLISH_RESERVE_MS = 5_000;

/** Longest sidecar failure we echo. Ours, but a path can be long. */
const MAX_SIDECAR_DETAIL_BYTES = 160;

/**
 * Exports that may wait for the one that is streaming, before a call is refused.
 *
 * Concurrent exports share one stream slot to bound API pressure. An exclusive
 * partial already prevents two exports of the same run. The queue is bounded so
 * callers beyond its capacity are told to retry instead of waiting indefinitely.
 */
const MAX_QUEUED_EXPORTS = 4;

export interface ExportHooks {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  /** Overridable so a test's exports do not queue behind another test's. */
  gate?: ExportGate;
  /**
   * Overridable so a test can inject the write failures a real disk produces --
   * a short write followed by ENOSPC, a handle that stops making progress, a
   * close that fails -- against real files in a real directory.
   */
  openRaw?: (paths: ExportPaths) => Promise<FileHandle>;
}

/**
 * One export streams at a time, process-wide.
 *
 * Not a scheduler: no priorities, no persistence, no retry policy of its own. A
 * slot is held across the whole stream phase -- every attempt, every
 * `Retry-After` wait, and the capture itself -- because releasing between
 * attempts is what would put two readers on the API at once, which is the shape
 * that was rate-limited. A caller who gives up while queued leaves immediately
 * and does not hold the queue behind it.
 */
export class ExportGate {
  #tail: Promise<void> = Promise.resolve();
  #queued = 0;

  async acquire(signal: AbortSignal): Promise<() => void> {
    if (this.#queued >= MAX_QUEUED_EXPORTS) {
      throw new PolicyError(
        `refusing to export: ${this.#queued} exports are already waiting to read a run ` +
          "stream, and they are read one at a time to stay under Cursor's stream rate " +
          "limit. Retry when one has finished.",
      );
    }
    const previous = this.#tail;
    let release!: () => void;
    const mine = new Promise<void>((resolve) => {
      release = resolve;
    });
    // The next waiter is gated on `previous` *and* `mine`, so giving up my place
    // early can never let two captures run at once.
    this.#tail = previous.then(
      () => mine,
      () => mine,
    );
    this.#queued += 1;
    try {
      await waitForTurn(previous, signal);
    } catch (error) {
      release();
      throw error;
    } finally {
      this.#queued -= 1;
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      release();
    };
  }
}

/**
 * Wait for the slot ahead, or for the caller to give up first.
 *
 * The listener is removed either way: a race left attached would reject long
 * after the winner returned, with nobody to catch it.
 */
async function waitForTurn(previous: Promise<void>, signal: AbortSignal): Promise<void> {
  const cancelled = () =>
    new CursorCancelledError(
      "Run export cancelled while it was queued behind another export; nothing was written",
    );
  if (signal.aborted) throw cancelled();
  let onAbort = () => {};
  try {
    await new Promise<void>((resolve, reject) => {
      onAbort = () => reject(cancelled());
      signal.addEventListener("abort", onAbort, { once: true });
      previous.then(resolve, resolve);
    });
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
}

/** The process-wide gate, shared by every registration in this process. */
const exportGate = new ExportGate();

export function registerRunExportTool(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
  scope: AgentScope,
  hooks: ExportHooks = { now: Date.now, sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
): string[] {
  const root = resolveExportRoot(policy);
  if (root === undefined) {
    // Not a failure: no configured storage root is the normal state, and it means
    // no operator has authorized writing exports anywhere.
    log.debug("no export storage root configured; cursor_export_run not registered");
    return [];
  }
  const registered = defineTool(server, policy, activeProfile(policy), {
    name: "cursor_export_run",
    config: {
      title: "Cursor: export a run's full replay",
      description:
        "Write one terminal run's whole SSE replay to the configured export root, plus a tool-call index and terminal log. Refuses when an export exists.",
      inputSchema: {
        agentId: z.string().min(1).max(128),
        runId: z.string().min(1).max(128),
      },
      outputSchema: {
        complete: z.boolean(),
        rawComplete: z.boolean(),
        stopReason: z.string(),
        status: z.string(),
        terminal: z.boolean(),
        bytes: z.number(),
        persistedBytes: z.number(),
        /** Present, and true, when `persistedBytes` is a floor rather than a total. */
        persistedBytesUnknown: z.boolean().optional(),
        events: z.number(),
        trailingEvents: z.number(),
        trailingBytes: z.number(),
        toolCallEvents: z.number(),
        unparsedToolCalls: z.number(),
        toolCalls: z.number(),
        completedCalls: z.number(),
        runningCalls: z.number(),
        terminalCommands: z.number(),
        attempts: z.number(),
        rawPublished: z.boolean(),
        toolsPublished: z.boolean(),
        terminalPublished: z.boolean(),
        partialKept: z.boolean(),
        partialCleanupFailed: z.boolean(),
        stoppedBefore: z.string().optional(),
        rawFile: z.string(),
        toolsFile: z.string().optional(),
        terminalFile: z.string().optional(),
        dirUnderRoot: z.string(),
        sidecarError: z.string().optional(),
      },
      annotations: LOCAL_WRITE,
    },
    handler: async (args: { agentId: string; runId: string }) => {
      const started = hooks.now();
      const bound = new AbortController();
      const timer = setTimeout(() => bound.abort(), MAX_EXPORT_MS);
      const caller = currentRequestSignal();
      const signal = caller
        ? AbortSignal.any([bound.signal, caller])
        : bound.signal;
      /**
       * The ceiling passed, and the caller did not cancel.
       *
       * The clock is read as well as the timer: a long synchronous step -- a
       * large sidecar being rendered -- can hold the loop past the deadline
       * before the timer's callback gets to run, and a deadline that is only
       * visible once the event loop is free is not a deadline during
       * publication.
       */
      const boundHit = () =>
        (bound.signal.aborted || hooks.now() - started >= MAX_EXPORT_MS) &&
        caller?.aborted !== true;
      try {
        await scope.assert(args.agentId, { signal });
        const path = `/v1/agents/${seg(args.agentId)}/runs/${seg(args.runId)}`;
        // Terminal state and identity come from REST, before a byte is written.
        // The stream's own `status` event is observed to report FINISHED for a run
        // REST calls CANCELLED, so it can never gate an export.
        const run = await client.get(path, RunSchema, { signal });
        if (run.id !== args.runId || run.agentId !== args.agentId) {
          throw new CursorContractError(
            `refusing to export: ${path} answered for a different run or agent`,
          );
        }
        if (!isTerminal(run.status)) {
          throw new CursorContractError(
            `refusing to export: run status is ${sanitize(run.status)}, which is not ` +
              "terminal. Wait for the run to finish, then export it.",
          );
        }
        const paths = exportPaths(root, args.agentId, args.runId);
        assertReportable(paths, policy, run.status);
        await assertNotExported(paths);
        const releaseSlot = await (hooks.gate ?? exportGate).acquire(signal);
        // The slot is released by the `finally` below, which only exists once the
        // partial is open. A refusal here has to hand it back itself, or every
        // later export in this process waits on a capture that never started.
        const handle = await (hooks.openRaw ?? openPartial)(paths).catch((error: unknown) => {
          releaseSlot();
          throw error;
        });
        let capture: RunCapture | undefined;
        // What reached the file, not what the parser accounted for, and counted
        // per successful write rather than per whole chunk: a chunk that
        // persisted some bytes and then failed leaves a partial worth keeping,
        // and a counter that only moved on complete chunks called that file
        // empty.
        let persisted = 0;
        // Set by a write that rejected. Until the file's own size is read, it is
        // the difference between "nothing was written" and "we do not know".
        let writeUnconfirmed = false;
        let closed = false;
        const closeRaw = async () => {
          if (closed) return;
          closed = true;
          await handle.close();
        };
        try {
          let attempts = 0;
          for (;;) {
            attempts += 1;
            try {
              const response = await client.openRunStream(`${path}/stream`, { signal });
              capture = await captureRunStream(response, {
                signal,
                write: async (chunk) => {
                  try {
                    await writeFully(handle, chunk, (bytes) => {
                      persisted += bytes;
                    });
                  } catch (error) {
                    // A rejected write never says how much of its buffer landed,
                    // so from here on the counter is a floor, not a total.
                    writeUnconfirmed = true;
                    throw error;
                  }
                },
              });
              break;
            } catch (error) {
              if (error instanceof CursorApiError && error.classification === USAGE_LIMITED_CLASS) {
                // Waiting cannot clear an exhausted quota, so this one never
                // becomes a retry, whatever code carried it.
                throw new CursorUsageExhaustedError(
                  error,
                  "Included Cloud Agent usage is exhausted; the stream request was not retried.",
                );
              }
              const wait = attempts >= MAX_ATTEMPTS ? undefined : retryDelay(error, attempts - 1);
              if (wait === undefined) throw error;
              const remaining =
                MAX_EXPORT_MS - (hooks.now() - started) - PUBLISH_RESERVE_MS;
              if (wait > remaining) {
                // Better to report the wait than to retry earlier than the server
                // asked, or to be cut off mid-capture by the ceiling.
                throw new CursorTransportError(
                  `Cursor asked for a ${wait}ms wait before the run stream can be read, ` +
                    `which does not fit this call's ${MAX_EXPORT_MS}ms ceiling; nothing was exported`,
                );
              }
              log.debug(`run export retry ${attempts} in ${wait}ms`);
              await pause(wait, signal, hooks.sleep);
            }
          }
          if (caller?.aborted) {
            throw new CursorCancelledError(
              "Run export cancelled; the cloud run was not cancelled and nothing was published",
            );
          }
          if (boundHit()) capture.stopReason = "time-limit";
          // Before publication, not after it. Bytes still sitting in the handle
          // are not in the file, and a `link` does not flush them: closing here
          // is what makes "published" mean the final name holds the capture.
          await closeRaw();
          // A write that rejected never said how much of its buffer landed, so
          // the closed file is asked. Only upwards: the file is the floor on
          // what was persisted, and an unreadable size leaves the count alone
          // rather than lowering it to zero.
          const onDisk = await partialBytes(paths);
          if (onDisk !== undefined && onDisk > persisted) persisted = onDisk;
          // Known-empty and unknown are different answers, and only one of them
          // means nothing was written. A write that rejected without confirming
          // its progress, over a file whose size cannot be read, leaves a
          // partial that the cleanup keeps -- so the report must not call that
          // an exact zero with nothing on disk.
          const persistedUnknown = writeUnconfirmed && onDisk === undefined;
          return await report({
            args,
            capture,
            paths,
            attempts,
            policy,
            persisted,
            persistedUnknown,
            status: run.status,
            exportedAt: new Date(hooks.now()).toISOString(),
            // Checked between filesystem operations, which is the only place a
            // check can be: no `link` or `write` here takes a signal, so this
            // stops the *next* step rather than interrupting one in flight.
            stop: () => (caller?.aborted ? "cancelled" : boundHit() ? "time-limit" : undefined),
          });
        } finally {
          releaseSlot();
          await closeRaw().catch((error: unknown) => {
            log.debug(
              `could not close the export partial: ${error instanceof Error ? error.message : String(error)}`,
            );
          });
          // Only a partial this call created and never wrote to. Anything that
          // reached the file stays -- including bytes from a write that then
          // failed, which the capture's own counter never got to see. The
          // counter only decides whether to look; `discardEmptyPartial` reads
          // the file's own size and keeps anything it cannot confirm empty.
          if (persisted === 0) await discardEmptyPartial(paths);
        }
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return registered ? ["cursor_export_run"] : [];
}

/**
 * Publish what completed, report what did not.
 *
 * A published raw export stays valid when a sidecar then fails: the bytes are
 * whole and the failure is a separate fact, so both are reported and overall
 * `complete` is false.
 */
async function report(args: {
  args: { agentId: string; runId: string };
  capture: RunCapture;
  paths: ExportPaths;
  attempts: number;
  policy: Policy;
  /** Bytes this call actually wrote into the partial. */
  persisted: number;
  /**
   * `persisted` is a floor rather than a total: a write rejected without saying
   * what it stored and the file's size could not be read.
   */
  persistedUnknown: boolean;
  status: string;
  exportedAt: string;
  stop: () => "cancelled" | "time-limit" | undefined;
}) {
  const { capture, paths } = args;
  const totals = callTotals(capture.calls);
  let rawPublished = false;
  let toolsPublished = false;
  let terminalPublished = false;
  let sidecarError: string | undefined;
  let partialCleanupError: string | undefined;
  // A deadline or a cancellation between the capture and the artifacts used to be
  // invisible here: publication ran to the end and reported a complete export
  // minutes after the call was abandoned. Publication is not itself
  // interruptible, so each step is gated on the state before it starts.
  let stopped = args.stop();
  if (capture.complete && stopped === undefined) {
    const published = await publishRaw(paths);
    rawPublished = published.linked;
    partialCleanupError = published.detail;
    const derived = {
      agentId: args.args.agentId,
      runId: args.args.runId,
      exportedAt: args.exportedAt,
      capture,
      status: args.status,
    };
    const sidecars = [
      { path: paths.tools, content: () => toolsSidecar(derived) },
      { path: paths.terminal, content: () => terminalSidecar(derived) },
    ] as const;
    for (const [index, sidecar] of sidecars.entries()) {
      stopped = args.stop();
      if (stopped !== undefined) break;
      try {
        // The probe goes into the helper too: checking only here left the whole
        // write-and-close of a large sidecar unguarded, and a cancellation
        // during it was followed by a `link` that called the export finished.
        const written = await writeSidecar(sidecar.path, sidecar.content(), args.stop);
        if (index === 0) toolsPublished = written.linked;
        else terminalPublished = written.linked;
        if (written.detail !== undefined) sidecarError = written.detail;
      } catch (error) {
        // Absent, never half-written: a sidecar is built in its own partial and
        // published by link, so a failure leaves nothing to mistake for a
        // derived file.
        sidecarError = capBytes(
          sanitize(error instanceof Error ? error.message : String(error)),
          MAX_SIDECAR_DETAIL_BYTES,
        ).text;
      }
    }
  }
  const complete = rawPublished && toolsPublished && terminalPublished;
  // One more probe when an artifact is missing, so the response names why rather
  // than leaving a caller to infer it from an absent file: a stop observed
  // inside the last publication attempt never reached the loop's own check. A
  // complete export is not re-probed -- every file is on disk, and a deadline
  // that passed afterwards did not take anything away.
  if (!complete) stopped ??= args.stop();
  // Whether the partial file is still on disk, which publication does not always
  // settle: a `link` that succeeded and an `unlink` that failed leaves both.
  // Unpublished, the partial is kept unless it was confirmed empty and removed --
  // so an unreadable size, which `discardEmptyPartial` resolves in favour of
  // keeping the file, reports the file as kept rather than as nothing written.
  const partialKept = rawPublished
    ? partialCleanupError !== undefined
    : args.persisted > 0 || args.persistedUnknown;
  return ok({
    source: `run export ${args.args.agentId}/${args.args.runId}`,
    policy: args.policy,
    text:
      `REST run status: ${args.status}.\n` +
      `Raw replay: ${capture.bytes} bytes, ${capture.events} events, ` +
      `${capture.complete ? "complete through done" : `incomplete (${capture.stopReason})`}.\n` +
      `${
        args.persisted === capture.bytes && !args.persistedUnknown
          ? ""
          : `Bytes on disk: ${args.persistedUnknown ? `at least ${args.persisted}, exact size unreadable` : args.persisted}.\n`
      }` +
      `${rawPublished ? `Published ${paths.names.raw}` : `Not published; ${partialKept ? `${paths.names.partial} kept` : "nothing written"}`}` +
      `${stopped === undefined ? "" : `; export ${stopped} before the remaining artifacts were written`}` +
      `${partialCleanupError === undefined ? "" : `; ${paths.names.partial} could not be removed`}` +
      `${sidecarError === undefined ? "" : `; sidecar failed: ${sidecarError}`}.\n` +
      `Tool calls: ${totals.calls} (${totals.completed} completed, ${totals.running} still running) ` +
      `over ${capture.toolCallEvents} events.\n` +
      "Completeness means these bytes arrived through done, not that Cursor delivered everything.\n",
    structured: {
      complete,
      rawComplete: capture.complete,
      stopReason: capture.stopReason,
      status: args.status,
      terminal: isTerminal(args.status),
      bytes: capture.bytes,
      persistedBytes: args.persisted,
      // Only present when it changes how `persistedBytes` reads: a floor rather
      // than a count. Absent is the ordinary case, so the common response does
      // not pay for it.
      ...(args.persistedUnknown ? { persistedBytesUnknown: true } : {}),
      events: capture.events,
      trailingEvents: capture.trailingEvents,
      trailingBytes: capture.trailingBytes,
      toolCallEvents: capture.toolCallEvents,
      unparsedToolCalls: capture.unparsedToolCalls,
      toolCalls: totals.calls,
      completedCalls: totals.completed,
      runningCalls: totals.running,
      terminalCommands: capture.terminal.length,
      attempts: args.attempts,
      rawPublished,
      toolsPublished,
      terminalPublished,
      partialKept,
      partialCleanupFailed: partialCleanupError !== undefined,
      ...(stopped === undefined ? {} : { stoppedBefore: stopped }),
      rawFile: rawPublished ? paths.names.raw : paths.names.partial,
      ...(toolsPublished ? { toolsFile: paths.names.tools } : {}),
      ...(terminalPublished ? { terminalFile: paths.names.terminal } : {}),
      // Named relative to the configured root, which is where the operator put
      // it: the absolute prefix is the one part of a path the caller already
      // knows, and clipping it to fit produced a directory that did not exist.
      dirUnderRoot: paths.dirUnderRoot,
      ...(sidecarError === undefined ? {} : { sidecarError }),
    },
  });
}

/**
 * The widest a count in this report can be rendered as.
 *
 * Every number here is a byte or event count, and one larger than this is not an
 * exact integer in JSON anyway, so this bounds the digits a reservation must buy.
 */
const WIDEST_COUNT = Number.MAX_SAFE_INTEGER;

/**
 * The largest structured report this export could produce.
 *
 * Exported so a test can check it still covers every key a real response
 * carries: a reservation that has stopped mentioning a field is a reservation
 * that has stopped protecting it.
 */
export function worstCaseReport(paths: ExportPaths, status: string): Record<string, unknown> {
  const widestStop = EXPORT_STOPS.reduce((a, b) => (a.length >= b.length ? a : b));
  return {
    complete: false,
    rawComplete: false,
    stopReason: widestStop,
    status,
    terminal: false,
    bytes: WIDEST_COUNT,
    persistedBytes: WIDEST_COUNT,
    persistedBytesUnknown: true,
    events: WIDEST_COUNT,
    trailingEvents: WIDEST_COUNT,
    trailingBytes: WIDEST_COUNT,
    toolCallEvents: WIDEST_COUNT,
    unparsedToolCalls: WIDEST_COUNT,
    toolCalls: WIDEST_COUNT,
    completedCalls: WIDEST_COUNT,
    runningCalls: WIDEST_COUNT,
    terminalCommands: WIDEST_COUNT,
    attempts: WIDEST_COUNT,
    rawPublished: false,
    toolsPublished: false,
    terminalPublished: false,
    partialKept: false,
    partialCleanupFailed: false,
    stoppedBefore: "time-limit",
    // The partial name is the longest of the four.
    rawFile: paths.names.partial,
    toolsFile: paths.names.tools,
    terminalFile: paths.names.terminal,
    dirUnderRoot: paths.dirUnderRoot,
    sidecarError: "s".repeat(MAX_SIDECAR_DETAIL_BYTES),
  };
}

/**
 * Refuse before writing anything when the report itself would not fit.
 *
 * `sanitizeDeep` truncates a structured payload by *dropping entries*, and a
 * dropped required field fails the output schema -- so a response that does not
 * fit is not a shortened report, it is an error. With ids at their limit and a
 * small `maxResponseBytes` that error would arrive after a whole replay had been
 * captured and published, describing nothing about where the files are. Better
 * to say so first: this checks the widest report this call could produce, and
 * every value in it is known before the stream is opened.
 */
function assertReportable(paths: ExportPaths, policy: Policy, status: string): void {
  const cost = structuredCost(worstCaseReport(paths, status));
  if (cost > policy.maxResponseBytes) {
    throw new PolicyError(
      `refusing to export: reporting this export needs up to ${cost} bytes of ` +
        `structured output and maxResponseBytes is ${policy.maxResponseBytes}, so the ` +
        "result would be dropped fields rather than a report. Nothing was written. " +
        "Raise maxResponseBytes, or export a run with shorter identifiers.",
    );
  }
}

/**
 * How long to wait before another attempt at opening the stream, or undefined to
 * give up.
 *
 * Only before the first byte is written -- the caller never re-enters this once a
 * capture has started, because a second attempt would replay from event one and
 * this server never appends to a partial. Usage exhaustion is handled before this
 * is consulted.
 */
function retryDelay(error: unknown, attemptsMade: number): number | undefined {
  const fallback = FALLBACK_WAITS[attemptsMade];
  if (fallback === undefined) return undefined;
  if (error instanceof CursorCancelledError) return undefined;
  if (error instanceof CursorApiError) {
    if (error.status === 429) return error.retryAfterMs ?? fallback;
    return error.status >= 500 ? fallback : undefined;
  }
  // A contract failure -- wrong content type, no body -- is not congestion.
  if (error instanceof CursorContractError) return undefined;
  return error instanceof CursorTransportError ? fallback : undefined;
}
