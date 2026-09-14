/** Bounded SSE consumption. Transport and policy remain with their existing owners. */
import { SseParser, type SseEvent } from "./sse.js";
import { capBytes, sanitize } from "./untrusted.js";

export const MAX_STREAM_BYTES = 1_048_576;
export const RESUME_ID = /^[\x21-\x7e]{1,256}$/;
export type TailStop = "done" | "eof" | "time-limit" | "byte-limit" | "event-limit" | "interrupted" | "expired" | "resume-rejected";
export interface StreamTail {
  text: string;
  eventsRead: number;
  bytesRead: number;
  lastEventId?: string;
  done: boolean;
  truncated: boolean;
  stopReason: TailStop;
}

/**
 * Counters after a chunk was consumed, for a caller reporting progress.
 *
 * Counts only. The excerpt text is Cursor's, and handing it out here would put
 * untrusted transcript fragments into whatever the caller does next.
 */
export type StreamCounts = (counts: { eventsRead: number; bytesRead: number }) => void;

export async function consumeRunStream(
  response: Response,
  signal: AbortSignal,
  maxBytes: number,
  lastEventId?: string,
  onCounts?: StreamCounts,
): Promise<StreamTail> {
  if (!response.body) throw new Error("Run stream has no response body");
  const reader = response.body.getReader();
  const parser = new SseParser(lastEventId);
  const result: StreamTail = {
    text: "", eventsRead: 0, bytesRead: 0, done: false, truncated: false, stopReason: "eof",
    ...(lastEventId === undefined ? {} : { lastEventId }),
  };
  let stopped = false;
  let outputBytes = 0;
  let groupId = lastEventId;
  let previousGroupId = lastEventId;
  const onAbort = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", onAbort, { once: true });
  if (signal.aborted) onAbort();
  const accept = (events: SseEvent[]) => {
    for (const event of events) {
      // Limit even empty events: their framing and metadata also cost memory.
      if (result.eventsRead >= 200) { result.stopReason = "event-limit"; result.truncated = true; stopped = true; break; }
      const line = `${sanitize(event.type)}: ${sanitize(event.data)}\n`;
      const room = Math.max(0, maxBytes - outputBytes);
      const clipped = capBytes(line, room);
      // An oversized event is explicitly clipped. A partial result resumes
      // before its last ID group, since multiple events can share one ID.
      result.text += clipped.text;
      outputBytes += Buffer.byteLength(clipped.text);
      result.eventsRead += 1;
      if (RESUME_ID.test(event.lastEventId)) {
        if (event.lastEventId !== groupId) { previousGroupId = groupId; groupId = event.lastEventId; }
        result.lastEventId = event.lastEventId;
      } else {
        delete result.lastEventId;
        groupId = undefined; previousGroupId = undefined;
      }
      if (event.type === "done") { result.done = true; result.stopReason = "done"; stopped = true; }
      if (clipped.truncated) { result.truncated = true; result.stopReason = "byte-limit"; stopped = true; }
      if (stopped) break;
    }
  };
  try {
    while (!stopped && !signal.aborted) {
      const { done, value } = await reader.read();
      if (signal.aborted) break;
      if (done) break;
      const room = MAX_STREAM_BYTES - result.bytesRead;
      const chunk = value.subarray(0, room);
      result.bytesRead += chunk.byteLength;
      accept(parser.push(chunk));
      if (onCounts !== undefined) {
        // Observation only: a reporting callback must never end a read.
        try {
          onCounts({ eventsRead: result.eventsRead, bytesRead: result.bytesRead });
        } catch {
          onCounts = undefined;
        }
      }
      if (!stopped && result.bytesRead >= MAX_STREAM_BYTES) {
        result.stopReason = "byte-limit"; result.truncated = true; stopped = true;
      }
    }
    // End only at a real EOF. Flushing an intentional partial read could
    // incorrectly acknowledge an event that has not actually completed.
    if (!stopped && !signal.aborted) {
      const end = parser.end();
      accept(end.events);
      result.truncated ||= end.leftover.truncated;
    }
    if (signal.aborted) { result.stopReason = "time-limit"; result.truncated = true; }
    // Missing done is incomplete, even when EOF itself was clean.
    result.truncated ||= !result.done;
    conservativeCursor();
    return result;
  } catch {
    result.stopReason = signal.aborted ? "time-limit" : "interrupted";
    result.truncated = true;
    conservativeCursor();
    return result;
  } finally {
    signal.removeEventListener("abort", onAbort);
    // Explicit cancel releases the undici connection; never drain an unbounded stream.
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }

  function conservativeCursor() {
    if (!result.truncated) return;
    if (previousGroupId === undefined) delete result.lastEventId;
    else result.lastEventId = previousGroupId;
  }
}
