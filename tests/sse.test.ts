import { describe, expect, it } from "vitest";
import { SseParser } from "../src/sse.js";

const enc = new TextEncoder();
const bytes = (text: string) => enc.encode(text);

/** Feed a whole payload as one chunk and finish. */
function parseAll(text: string) {
  const parser = new SseParser();
  const events = parser.push(bytes(text));
  const { events: tail, leftover } = parser.end();
  return { events: [...events, ...tail], leftover };
}

describe("field parsing", () => {
  it("dispatches on a blank line and defaults the type to message", () => {
    const { events } = parseAll("data: hello\n\n");
    expect(events).toEqual([{ type: "message", data: "hello", lastEventId: "" }]);
  });

  it("uses the event field as the type", () => {
    const { events } = parseAll("event: done\ndata: {}\n\n");
    expect(events[0]).toEqual({ type: "done", data: "{}", lastEventId: "" });
  });

  it("removes exactly one space after the colon, not all of it", () => {
    const { events } = parseAll("data:  indented\n\n");
    expect(events[0]?.data).toBe(" indented");
  });

  it("treats a line with no colon as a field name with an empty value", () => {
    // A bare `data` line still appends, so the event dispatches with "".
    const { events } = parseAll("data\n\n");
    expect(events).toEqual([{ type: "message", data: "", lastEventId: "" }]);
  });

  it("dispatches a data field whose value is empty", () => {
    const { events } = parseAll("data:\n\n");
    expect(events[0]?.data).toBe("");
  });

  it("ignores comment lines", () => {
    const { events } = parseAll(": keepalive\ndata: x\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]?.data).toBe("x");
  });

  it("ignores unknown field names so Cursor can add fields", () => {
    const { events } = parseAll("weird: value\ndata: x\n\n");
    expect(events[0]?.data).toBe("x");
  });

  it("joins multiple data fields with newlines and strips only the last one", () => {
    const { events } = parseAll("data: one\ndata: two\ndata:\n\n");
    expect(events[0]?.data).toBe("one\ntwo\n");
  });
});

describe("dispatch rules", () => {
  it("dispatches nothing for an event with no data, but keeps the id", () => {
    // The trap this guards: waiting for an *event* named done hangs forever if
    // done ever arrives without a data field, while the id has already moved.
    const { events } = parseAll("id: 7\nevent: done\n\ndata: after\n\n");
    expect(events).toHaveLength(1);
    expect(events[0]).toEqual({ type: "message", data: "after", lastEventId: "7" });
  });

  it("carries the last id forward to events that have none of their own", () => {
    const { events } = parseAll("id: a1\ndata: first\n\ndata: second\n\n");
    expect(events.map((e) => e.lastEventId)).toEqual(["a1", "a1"]);
  });

  it("resets the event type between events but not the id", () => {
    const { events } = parseAll("id: 1\nevent: status\ndata: x\n\ndata: y\n\n");
    expect(events[1]).toEqual({ type: "message", data: "y", lastEventId: "1" });
  });

  it("ignores an id containing NUL, since it would go back out as a header", () => {
    const { events } = parseAll("id: good\n\nid: ba\0d\ndata: x\n\n");
    expect(events[0]?.lastEventId).toBe("good");
  });

  it("exposes the last id seen for use as a resume point", () => {
    const parser = new SseParser();
    parser.push(bytes("id: 99\ndata: x\n\n"));
    expect(parser.lastEventId).toBe("99");
  });
});

describe("line terminators", () => {
  it("handles CRLF framing", () => {
    const { events } = parseAll("event: a\r\ndata: 1\r\n\r\n");
    expect(events).toEqual([{ type: "a", data: "1", lastEventId: "" }]);
  });

  it("handles bare CR framing", () => {
    const { events } = parseAll("event: a\rdata: 1\r\r");
    expect(events).toEqual([{ type: "a", data: "1", lastEventId: "" }]);
  });

  it("does not split a CRLF whose LF is in the next chunk", () => {
    // Read as two terminators this yields a phantom blank line, which
    // dispatches the event a field early.
    const parser = new SseParser();
    const first = parser.push(bytes("data: whole\r"));
    expect(first).toEqual([]);
    const second = parser.push(bytes("\ndata: more\r\n\r\n"));
    const { events: tail, leftover } = parser.end();
    expect([...second, ...tail]).toEqual([
      { type: "message", data: "whole\nmore", lastEventId: "" },
    ]);
    expect(leftover.truncated).toBe(false);
  });

  it("flushes a held CR at end of stream so a bare-CR server keeps its last event", () => {
    const parser = new SseParser();
    // The final \r is the blank line. Held while the stream might continue.
    const during = parser.push(bytes("data: last\r\r"));
    expect(during).toEqual([]);
    const { events, leftover } = parser.end();
    expect(events).toEqual([{ type: "message", data: "last", lastEventId: "" }]);
    expect(leftover.truncated).toBe(false);
  });
});

describe("decoding across chunks", () => {
  it("reassembles a character split between two chunks", () => {
    const parser = new SseParser();
    const payload = bytes("data: café\n\n");
    // Split inside the two-byte é.
    const cut = payload.indexOf(0xc3) + 1;
    parser.push(payload.slice(0, cut));
    const events = parser.push(payload.slice(cut));
    const { leftover } = parser.end();
    expect(events[0]?.data).toBe("café");
    expect(leftover.truncated).toBe(false);
  });

  it("strips one leading BOM even when it arrives as its own chunk", () => {
    // TextDecoder does this; the test pins the behaviour we rely on.
    const parser = new SseParser();
    parser.push(new Uint8Array([0xef, 0xbb, 0xbf]));
    const events = parser.push(bytes("data: x\n\n"));
    expect(events[0]?.data).toBe("x");
  });

  it("keeps a later BOM, which is data rather than a marker", () => {
    const { events } = parseAll("data: a\n\ndata: ﻿b\n\n");
    expect(events[1]?.data).toBe("﻿b");
  });
});

describe("truncation detection", () => {
  it("reports a clean stream as not truncated", () => {
    const { leftover } = parseAll("event: done\ndata: {}\n\n");
    expect(leftover).toEqual({
      line: "",
      data: "",
      decoded: "",
      truncated: false,
    });
  });

  it("catches a stream cut in the middle of a line", () => {
    // Exactly what a proxy closing at an idle timeout produces: well-framed
    // chunked encoding, clean EOF, half an event.
    const { events, leftover } = parseAll("data: ok\n\nevent: interaction_upda");
    expect(events).toHaveLength(1);
    expect(leftover.truncated).toBe(true);
    expect(leftover.line).toBe("event: interaction_upda");
  });

  it("catches complete lines whose dispatching blank line never arrived", () => {
    const { events, leftover } = parseAll("event: result\ndata: {\"a\":1}\n");
    expect(events).toEqual([]);
    expect(leftover.truncated).toBe(true);
    expect(leftover.data).toBe('{"a":1}\n');
  });

  it("catches a character cut in half at end of stream", () => {
    const parser = new SseParser();
    const payload = bytes("data: café\n\n");
    parser.push(payload.slice(0, payload.indexOf(0xc3) + 1));
    const { leftover } = parser.end();
    expect(leftover.decoded).not.toBe("");
    expect(leftover.truncated).toBe(true);
  });

  it("refuses to be used after end", () => {
    const parser = new SseParser();
    parser.end();
    expect(() => parser.push(bytes("data: x\n\n"))).toThrow("push after end");
    expect(() => parser.end()).toThrow("end called twice");
  });
});

describe("a multi-event stream fixture", () => {
  // Synthetic identifiers with LF-only framing, repeated event IDs, and
  // differing status values across events.
  const fixture =
    'event: status\ndata: {"runId":"run-sse-1","status":"CANCELLED"}\n\n' +
    'event: status\ndata: {"runId":"run-sse-1","status":"FINISHED"}\n\n' +
    "id: evt-dup-0\nevent: result\n" +
    'data: {"runId":"run-sse-1","status":"CANCELLED","durationMs":3439}\n\n' +
    "id: evt-dup-0\nevent: done\ndata: {}\n\n";

  it("parses the whole fixture in order with no leftovers", () => {
    const { events, leftover } = parseAll(fixture);
    expect(events.map((e) => e.type)).toEqual([
      "status",
      "status",
      "result",
      "done",
    ]);
    expect(leftover.truncated).toBe(false);
    expect(events.at(-1)?.data).toBe("{}");
  });

  it("shows two adjacent events sharing one id, so ids cannot deduplicate", () => {
    // This is the reason a resume point may only be taken where the id changes:
    // resuming from a duplicated id skips its second event permanently.
    const { events } = parseAll(fixture);
    const withIds = events.filter((e) => e.lastEventId !== "");
    expect(withIds).toHaveLength(2);
    expect(withIds[0]?.lastEventId).toBe(withIds[1]?.lastEventId);
  });

  it("produces identical events at every possible chunk split", () => {
    // Exercise every byte boundary in the fixed payload deterministically.
    const payload = bytes(fixture);
    const { events: whole } = parseAll(fixture);

    for (let cut = 0; cut <= payload.length; cut++) {
      const parser = new SseParser();
      const a = parser.push(payload.slice(0, cut));
      const b = parser.push(payload.slice(cut));
      const { events: tail, leftover } = parser.end();
      expect([...a, ...b, ...tail], `split at ${cut}`).toEqual(whole);
      expect(leftover.truncated, `split at ${cut}`).toBe(false);
    }
  });
});
