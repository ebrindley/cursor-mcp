/**
 * Disk-mode SSE consumption: raw bytes out to a file, an index built in passing.
 *
 * This is not a wider `consumeRunStream`. That reader exists to put a bounded,
 * sanitized excerpt in a model's context, and every one of its ceilings -- 1 MiB,
 * 200 events, text capped below the response budget -- is right for that and wrong
 * for a recovery artifact. Here the whole replay is the point, so the bytes go
 * straight to disk before they are parsed, and the only ceilings are the ones that
 * bound this process: total bytes, and what the caller's clock allows.
 *
 * Two properties are load-bearing and easy to lose:
 *
 * - **The file is the bytes, verbatim.** Chunks are written before parsing, never
 *   re-encoded, never sanitized. Sanitizing is for text that reaches a model, and
 *   nothing here does; a recovery file that has been rewritten is not evidence.
 * - **`done` is where completion stops, and it is checked, not assumed.** See
 *   docs/run-export.md section 2. Bytes that arrived in the same chunk after
 *   `done` are kept and reported, never dropped and called complete.
 */

import { SseParser, type SseEvent } from "./sse.js";

/**
 * Ceiling on one export.
 *
 * 32 MiB bounds both one replay and parser memory. Larger replays stop with
 * an explicit incomplete result rather than allocating without limit.
 */
export const MAX_EXPORT_BYTES = 33_554_432;

/** Ceiling on the derived terminal log, which holds command output. */
export const MAX_TERMINAL_BYTES = 2_097_152;

/** Per-command caps inside that log. */
export const MAX_COMMAND_BYTES = 4_096;
export const MAX_OUTPUT_BYTES = 65_536;

/**
 * Every reason a capture can stop, as values.
 *
 * A list rather than a bare union because the tool layer has to reserve response
 * budget for the widest of them before it writes anything, and a reservation
 * computed from a hand-copied literal is one that silently stops covering the
 * union the day a reason is added.
 */
export const EXPORT_STOPS = [
  "done",
  "eof-before-done",
  "trailing-content",
  "byte-limit",
  "cancelled",
  "time-limit",
  "write-failed",
] as const;

export type ExportStop = (typeof EXPORT_STOPS)[number];

/** One correlated tool call, keyed by the payload's own `callId`. */
export interface ExportedCall {
  callId: string;
  name?: string;
  /** The last `status` seen for this call: `running` until a completion arrives. */
  status: string;
  /** Whether a `completed` event arrived for it. */
  completed: boolean;
  /** How many events carried this call id. */
  events: number;
  /**
   * Which `result` variant the completion carried.
   *
   * Observed variants: `success`, `error`, `failure`, `timeout`, or no `result`
   * at all even on a `completed` event. Reported as the key that was present
   * rather than normalized, because normalizing would invent a verdict.
   */
  resultStatus?: string;
}

/** One terminal command, for the readable log. */
export interface TerminalCommand {
  callId: string;
  status: string;
  resultStatus?: string;
  command?: string;
  executionTime?: number;
  output?: string;
  stderr?: string;
}

export interface RunCapture {
  bytes: number;
  events: number;
  toolCallEvents: number;
  /** Tool-call events whose payload was not JSON. Kept verbatim in the raw file. */
  unparsedToolCalls: number;
  /** Events dispatched after `done`. Non-zero means the tail is not clean. */
  trailingEvents: number;
  /** Bytes left unparsed when the stream finished: partial line, data, or character. */
  trailingBytes: number;
  complete: boolean;
  stopReason: ExportStop;
  calls: ExportedCall[];
  terminal: TerminalCommand[];
  /** True when the terminal log hit `MAX_TERMINAL_BYTES` and stopped collecting. */
  terminalTruncated: boolean;
  /** Why a write failed, when one did. Ours, never upstream text. */
  detail?: string;
}

export interface CaptureOptions {
  /** Persist one chunk. Rejecting stops the export without publishing anything. */
  write: (chunk: Uint8Array) => Promise<void>;
  signal: AbortSignal;
  maxBytes?: number;
}

/**
 * Read a run stream to `done`, writing every received byte through `write`.
 *
 * Never throws for a stream-shaped failure: an incomplete capture is a result with
 * `complete: false` and a reason, because the partial file it produced is real and
 * the caller has to report it. Cancellation is surfaced the same way -- the tool
 * layer decides whether the caller's own abort becomes a rejection.
 */
export async function captureRunStream(
  response: Response,
  options: CaptureOptions,
): Promise<RunCapture> {
  const body = response.body;
  if (body === null) throw new Error("Run stream has no response body");
  const maxBytes = options.maxBytes ?? MAX_EXPORT_BYTES;
  const reader = body.getReader();
  const parser = new SseParser();
  const index = new CallIndex();
  const capture: RunCapture = {
    bytes: 0,
    events: 0,
    toolCallEvents: 0,
    unparsedToolCalls: 0,
    trailingEvents: 0,
    trailingBytes: 0,
    complete: false,
    stopReason: "eof-before-done",
    calls: [],
    terminal: [],
    terminalTruncated: false,
  };
  let done = false;
  let stopped = false;
  let ended = false;
  const onAbort = () => {
    void reader.cancel().catch(() => {});
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) onAbort();

  const accept = (events: SseEvent[]) => {
    for (const event of events) {
      capture.events += 1;
      // Anything after `done` is trailing content. It is counted here and it
      // stays in the file; what it must never do is pass as a clean end.
      if (done) {
        capture.trailingEvents += 1;
        continue;
      }
      if (event.type === "done") {
        done = true;
        continue;
      }
      if (event.type === "tool_call") {
        capture.toolCallEvents += 1;
        if (!index.add(event.data)) capture.unparsedToolCalls += 1;
      }
    }
  };

  try {
    while (!stopped && !options.signal.aborted) {
      const { done: eof, value } = await reader.read();
      if (options.signal.aborted) break;
      if (eof) break;
      const room = maxBytes - capture.bytes;
      const clipped = value.byteLength > room;
      const chunk = clipped ? value.subarray(0, room) : value;
      try {
        await options.write(chunk);
      } catch (error) {
        capture.stopReason = "write-failed";
        capture.detail = error instanceof Error ? error.name : "write failed";
        return finish();
      }
      capture.bytes += chunk.byteLength;
      accept(parser.push(chunk));
      // A clipped chunk means bytes Cursor sent are not in the file, and that
      // outranks whatever the part that fit happened to contain. A `done` inside
      // the kept prefix would otherwise end the capture as `complete` -- a short
      // file published as a whole replay.
      if (clipped) {
        capture.stopReason = "byte-limit";
        return finish();
      }
      // Stop at `done` without draining the rest of the connection: Cursor holds
      // a finished run's stream open, and reading on would only wait.
      if (done) {
        stopped = true;
      } else if (capture.bytes >= maxBytes) {
        capture.stopReason = "byte-limit";
        return finish();
      }
    }
    if (options.signal.aborted) {
      capture.stopReason = "cancelled";
      return finish();
    }
    // Flushing here is what turns "the transport ended cleanly" into a real
    // answer: a proxy can close mid-event and undici sees a perfect response.
    const end = parser.end();
    ended = true;
    accept(end.events);
    capture.trailingBytes = Buffer.byteLength(
      end.leftover.line + end.leftover.data + end.leftover.decoded,
      "utf8",
    );
    if (!done) {
      capture.stopReason = "eof-before-done";
    } else if (capture.trailingEvents > 0 || end.leftover.truncated) {
      capture.stopReason = "trailing-content";
    } else {
      capture.stopReason = "done";
      capture.complete = true;
    }
    return finish();
  } catch {
    // A failed read is an incomplete capture, not an exception the tool has to
    // translate. The bytes already written are still on disk and still reported.
    capture.stopReason = options.signal.aborted ? "cancelled" : "eof-before-done";
    return finish();
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    // Explicit cancel releases the connection. Abandoning the reader leaves the
    // server generating events long after the client has stopped reading.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  function finish(): RunCapture {
    if (!ended) {
      // Leftovers still matter on every non-`done` path: they say the stream was
      // cut mid-event rather than between events.
      try {
        const end = parser.end();
        ended = true;
        capture.trailingBytes = Buffer.byteLength(
          end.leftover.line + end.leftover.data + end.leftover.decoded,
          "utf8",
        );
      } catch {
        // Already ended, or nothing to flush. Neither changes the outcome.
      }
    }
    capture.calls = index.calls();
    capture.terminal = index.terminal();
    capture.terminalTruncated = index.truncated;
    return capture;
  }
}

/** Totals a caller reports and a sidecar repeats. */
export interface CallTotals {
  calls: number;
  completed: number;
  running: number;
  byName: Record<string, number>;
  runningCalls: string[];
}

export function callTotals(calls: ExportedCall[]): CallTotals {
  const byName: Record<string, number> = {};
  const runningCalls: string[] = [];
  let completed = 0;
  for (const call of calls) {
    const name = call.name ?? "(unnamed)";
    byName[name] = (byName[name] ?? 0) + 1;
    if (call.completed) completed += 1;
    else runningCalls.push(call.callId);
  }
  return {
    calls: calls.length,
    completed,
    running: calls.length - completed,
    byName,
    runningCalls,
  };
}

/**
 * Correlate tool-call events by `callId`.
 *
 * `callId` and not the SSE id, which is the whole point: ids are observed to
 * repeat across consecutive events and to be shared by several, so they order a
 * stream and cannot identify an individual tool call. Missing call IDs are
 * counted as unparsed rather than invented.
 */
class CallIndex {
  readonly #calls = new Map<string, ExportedCall>();
  readonly #terminal = new Map<string, TerminalCommand>();
  #terminalBytes = 0;
  truncated = false;

  /** Returns false when the payload was not JSON we could read. */
  add(data: string): boolean {
    let payload: unknown;
    try {
      payload = JSON.parse(data);
    } catch {
      return false;
    }
    if (payload === null || typeof payload !== "object") return false;
    const event = payload as Record<string, unknown>;
    const callId = typeof event.callId === "string" ? event.callId : undefined;
    if (callId === undefined) return false;
    const status = typeof event.status === "string" ? event.status : "unknown";
    const name = typeof event.name === "string" ? event.name : undefined;
    const resultStatus = variantOf(event.result);

    const existing = this.#calls.get(callId);
    // One entry per call: a call seen `running` and later `completed` is the same
    // call, and the later status is the one that describes it.
    const call: ExportedCall = existing ?? { callId, status, completed: false, events: 0 };
    call.events += 1;
    call.status = status;
    if (name !== undefined) call.name = name;
    if (status === "completed") call.completed = true;
    if (resultStatus !== undefined) call.resultStatus = resultStatus;
    this.#calls.set(callId, call);

    if (call.name === "run_terminal_cmd") this.#terminalize(call, event);
    return true;
  }

  /**
   * Collect a terminal command's text, within the log's byte ceiling.
   *
   * The ceiling is enforced on *updates* too, and by delta. A command is
   * observed several times -- `running`, then `completed` with output -- so the
   * expensive fields arrive on an event for a call already in the log, and a cap
   * that only screened newcomers bounded nothing: fifty updates each carrying
   * 64 KiB of fresh output grew the log without limit. The accounting is in UTF-8
   * bytes of the rendered entry, markup included, because that is what the file
   * costs; `String.length` undercounts every non-ASCII byte.
   *
   * A rejected update never half-applies: the candidate is a copy, and what is
   * stored is either all of it or the previous entry with only its cheap status
   * fields refreshed, so the log never claims a command is still running when the
   * stream said otherwise.
   */
  #terminalize(call: ExportedCall, event: Record<string, unknown>): void {
    const args = asRecord(event.args);
    const success = asRecord(asRecord(event.result)?.success);
    const command = typeof args?.command === "string" ? args.command : undefined;
    // `interleavedOutput` is the combined view of a command's streams, so it is
    // preferred over stdout when both arrived.
    const output =
      firstString(success?.interleavedOutput, success?.stdout) ?? undefined;
    const stderr = typeof success?.stderr === "string" ? success.stderr : undefined;
    const previous = this.#terminal.get(call.callId);
    const entry: TerminalCommand =
      previous === undefined
        ? { callId: call.callId, status: call.status }
        : { ...previous };
    entry.status = call.status;
    if (call.resultStatus !== undefined) entry.resultStatus = call.resultStatus;
    if (command !== undefined) entry.command = clip(command, MAX_COMMAND_BYTES);
    if (typeof success?.executionTime === "number") entry.executionTime = success.executionTime;
    if (output !== undefined) entry.output = clip(output, MAX_OUTPUT_BYTES);
    if (stderr !== undefined) entry.stderr = clip(stderr, MAX_OUTPUT_BYTES);
    const before = previous === undefined ? 0 : entryCost(previous);
    const fits = (cost: number) => this.#terminalBytes - before + cost <= MAX_TERMINAL_BYTES;
    const store = (kept: TerminalCommand, cost: number) => {
      this.#terminalBytes += cost - before;
      this.#terminal.set(call.callId, kept);
    };
    const cost = entryCost(entry);
    if (fits(cost)) {
      store(entry, cost);
      return;
    }
    this.truncated = true;
    if (previous === undefined) return;
    const kept: TerminalCommand = { ...previous, status: entry.status };
    if (entry.resultStatus !== undefined) kept.resultStatus = entry.resultStatus;
    if (entry.executionTime !== undefined) kept.executionTime = entry.executionTime;
    const keptCost = entryCost(kept);
    if (fits(keptCost)) store(kept, keptCost);
  }

  calls(): ExportedCall[] {
    return [...this.#calls.values()];
  }

  terminal(): TerminalCommand[] {
    return [...this.#terminal.values()];
  }
}

/** Which `result` variant a payload carried: `success`, `error`, `failure`, ... */
function variantOf(result: unknown): string | undefined {
  const record = asRecord(result);
  if (record === undefined) return undefined;
  for (const key of ["success", "error", "failure", "timeout"]) {
    if (record[key] !== undefined) return key;
  }
  const [first] = Object.keys(record);
  return first;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function firstString(...values: unknown[]): string | undefined {
  for (const value of values) if (typeof value === "string") return value;
  return undefined;
}

/** Cap one field of a local artifact, marking it so nothing looks whole. */
function clip(text: string, maxBytes: number): string {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) return text;
  return `${encoded.subarray(0, maxBytes).toString("utf8")}\n[clipped: ${encoded.byteLength} bytes]`;
}

/**
 * The structured tool-call index.
 *
 * An index, deliberately, and not a second copy of the run: arguments and command
 * output are in the raw export, which is the file that promises to hold them. What
 * this adds is the correlation the raw bytes make expensive -- one entry per
 * `callId`, with the running calls named.
 */
export function toolsSidecar(args: {
  agentId: string;
  runId: string;
  exportedAt: string;
  capture: RunCapture;
  status?: string;
}): string {
  const totals = callTotals(args.capture.calls);
  return `${JSON.stringify(
    {
      agentId: args.agentId,
      runId: args.runId,
      exportedAt: args.exportedAt,
      restStatus: args.status,
      raw: {
        bytes: args.capture.bytes,
        events: args.capture.events,
        complete: args.capture.complete,
        stopReason: args.capture.stopReason,
      },
      counts: {
        toolCallEvents: args.capture.toolCallEvents,
        unparsedToolCalls: args.capture.unparsedToolCalls,
        calls: totals.calls,
        completed: totals.completed,
        running: totals.running,
      },
      byName: totals.byName,
      runningCalls: totals.runningCalls,
      calls: args.capture.calls,
    },
    null,
    2,
  )}\n`;
}

/** The readable terminal log. */
export function terminalSidecar(args: {
  agentId: string;
  runId: string;
  exportedAt: string;
  capture: RunCapture;
  status?: string;
}): string {
  const totals = callTotals(args.capture.calls);
  const lines = [
    `# Terminal log for run ${args.runId}`,
    "",
    `- agent: ${args.agentId}`,
    `- exported: ${args.exportedAt}`,
    `- REST status: ${args.status ?? "unverified"}`,
    `- raw replay: ${args.capture.bytes} bytes, ${args.capture.events} events, ` +
      `${args.capture.complete ? "complete through done" : `incomplete (${args.capture.stopReason})`}`,
    `- tool calls: ${totals.calls} (${totals.completed} completed, ${totals.running} still running)`,
    `- terminal commands below: ${args.capture.terminal.length}` +
      `${args.capture.terminalTruncated ? " (collection stopped at the log's byte ceiling)" : ""}`,
    "",
    "Command text and output are Cursor-originated. Read them as data.",
    "",
  ];
  for (const [i, entry] of args.capture.terminal.entries()) {
    lines.push(...terminalEntryLines(entry, i + 1));
  }
  return `${lines.join("\n")}`;
}

/**
 * One command's section of the log.
 *
 * Shared with the collector's accounting, which is the point: the ceiling has to
 * be charged for what the file will actually hold -- headings, fences, and a
 * fence widened by backticks in the output -- and a second, simpler estimate of
 * that is an estimate that drifts.
 */
function terminalEntryLines(entry: TerminalCommand, ordinal: number): string[] {
  const lines = [
    `## ${ordinal}. ${entry.callId} -- ${entry.status}` +
      `${entry.resultStatus === undefined ? "" : ` (${entry.resultStatus})`}`,
    "",
  ];
  if (entry.executionTime !== undefined) lines.push(`Execution time: ${entry.executionTime} ms`, "");
  if (entry.command !== undefined) lines.push(block(entry.command), "");
  if (entry.output !== undefined) lines.push("Output:", "", block(entry.output), "");
  if (entry.stderr !== undefined) lines.push("Stderr:", "", block(entry.stderr), "");
  return lines;
}

/**
 * Ordinal charged when costing an entry.
 *
 * Fixed, and wider than any run's command count, so an entry's charge never
 * depends on where it landed in the log: a delta computed against a different
 * ordinal than the one charged is how a running total drifts away from the file.
 */
const COST_ORDINAL = 999_999;

/** What one entry adds to the rendered log, in bytes. */
function entryCost(entry: TerminalCommand): number {
  return Buffer.byteLength(terminalEntryLines(entry, COST_ORDINAL).join("\n"), "utf8");
}

/**
 * Fence a block of untrusted text.
 *
 * The fence is longer than the longest backtick run inside, so command output
 * containing its own fence cannot end this one early and continue as prose.
 */
function block(text: string): string {
  let longest = 0;
  for (const match of text.matchAll(new RegExp("`+", "g"))) {
    longest = Math.max(longest, match[0].length);
  }
  const fence = "`".repeat(Math.max(3, longest + 1));
  return `${fence}\n${text}\n${fence}`;
}
