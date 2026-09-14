/**
 * Server-sent event framing, per WHATWG HTML 9.2.5-9.2.6.
 *
 * Pure: bytes in, events out, no I/O. That is deliberate. The bugs that matter
 * here all live at chunk boundaries -- a character split in half, a `\r` whose
 * `\n` is in the next chunk -- and the only way to test those is to hand the
 * parser byte arrays split wherever we like. A parser that owned its own fetch
 * could not be tested that way.
 *
 * What this deliberately does NOT do:
 *
 * - Strip the BOM. `TextDecoder` already removes exactly one leading BOM,
 *   statefully across chunks, and leaves later ones intact as data -- verified.
 *   Hand-rolling it again would either duplicate that or eat a real character.
 * - Cap anything. An abusive server that never sends a newline would grow the
 *   line buffer without bound, and the byte ceiling in the caller is what stops
 *   that. One cap in one place beats two that can disagree.
 * - Reconnect. `retry` is read and discarded; resumption is the caller's
 *   business, because it needs a request header we do not own here.
 */

/** One dispatched event. */
export interface SseEvent {
  /** The `event:` field, or `message` when the stream omitted it. */
  type: string;
  /** The joined `data:` fields, with the single trailing newline removed. */
  data: string;
  /**
   * The last `id:` seen at the moment this event dispatched.
   *
   * Not necessarily this event's own id. The spec resets the data and event-type
   * buffers on dispatch but never the id, so an event with no `id:` of its own
   * inherits the previous one. Empty string until the stream sends an id.
   */
  lastEventId: string;
}

/** What was still in flight when the stream ended. */
export interface SseLeftover {
  /** An unterminated final line. */
  line: string;
  /** `data:` fields for an event whose blank line never arrived. */
  data: string;
  /** Output from the final decoder flush: bytes that were not a whole character. */
  decoded: string;
  /**
   * True when any of the above is non-empty.
   *
   * This is the whole reason the leftovers are reported rather than discarded.
   * A server can send half an event and then cleanly terminate the chunked
   * encoding, which at the transport layer is a perfectly successful response --
   * undici validates `Content-Length` and chunk framing, and both are intact.
   * Only this check knows the difference.
   */
  truncated: boolean;
}

export class SseParser {
  /**
   * One decoder for the whole stream. A fresh decoder per chunk, or
   * `Buffer.toString()`, turns a character split across two chunks into U+FFFD
   * with no error raised -- mojibake that fails validation later, pointing at
   * the wrong problem.
   */
  readonly #decoder = new TextDecoder();
  /** Undispatched text. May end in a `\r` we are holding; see `#drain`. */
  #line = "";
  #data = "";
  #type = "";
  #lastEventId = "";
  #ended = false;

  constructor(lastEventId = "") {
    // A resumed connection may begin with id-less status events. Preserve the
    // request's last ID until the stream actually replaces or resets it.
    this.#lastEventId = lastEventId;
  }

  /** The last id seen, for a caller that needs a resume point. */
  get lastEventId(): string {
    return this.#lastEventId;
  }

  push(chunk: Uint8Array): SseEvent[] {
    if (this.#ended) throw new Error("SseParser: push after end");
    this.#line += this.#decoder.decode(chunk, { stream: true });
    return this.#drain(false);
  }

  /**
   * Finish the stream: flush the decoder, flush a held `\r`, and report what is
   * left over.
   */
  end(): { events: SseEvent[]; leftover: SseLeftover } {
    if (this.#ended) throw new Error("SseParser: end called twice");
    this.#ended = true;

    // `decode()` with no argument flushes. Anything it returns is bytes that did
    // not form a whole character, so the stream was cut mid-character.
    const decoded = this.#decoder.decode();
    this.#line += decoded;

    // Now the held `\r` can be resolved: there is no next chunk, so it is a
    // terminator rather than half of a `\r\n`. Skipping this loses the final
    // event of a bare-CR server, silently.
    const events = this.#drain(true);

    return {
      events,
      leftover: {
        line: this.#line,
        data: this.#data,
        decoded,
        truncated: this.#line !== "" || this.#data !== "" || decoded !== "",
      },
    };
  }

  /**
   * Consume whole lines from the buffer.
   *
   * Terminators are `\r\n`, `\n`, and a bare `\r`, and they are found by
   * scanning rather than by splitting on `\n\n`: splitting misses `\r\n\r\n` and
   * bare `\r\r` entirely, so a dispatch would never fire against those servers.
   */
  #drain(final: boolean): SseEvent[] {
    const events: SseEvent[] = [];
    for (;;) {
      const cr = this.#line.indexOf("\r");
      const lf = this.#line.indexOf("\n");
      let at: number;
      let width: number;

      if (cr !== -1 && (lf === -1 || cr < lf)) {
        // A trailing `\r` is ambiguous: the `\n` completing it may be in the
        // next chunk. Treating it as a terminator now would turn one `\r\n`
        // into two line endings, and the phantom blank line dispatches an
        // event early. Hold it until more arrives, or until the stream ends.
        if (cr === this.#line.length - 1 && !final) break;
        at = cr;
        width = this.#line[cr + 1] === "\n" ? 2 : 1;
      } else if (lf !== -1) {
        at = lf;
        width = 1;
      } else {
        break;
      }

      const line = this.#line.slice(0, at);
      this.#line = this.#line.slice(at + width);
      const event = this.#handle(line);
      if (event !== undefined) events.push(event);
    }
    return events;
  }

  /** Process one complete line. */
  #handle(line: string): SseEvent | undefined {
    if (line === "") return this.#dispatch();
    // A line starting with a colon is a comment. Servers use these as
    // keepalives, so they carry no fields but do prove the connection is alive.
    if (line.startsWith(":")) return undefined;

    const colon = line.indexOf(":");
    // No colon at all means a field name with an empty value, not a line to
    // skip. A bare `data` line therefore appends an empty string and its event
    // still dispatches.
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    // Exactly one space, never a trim: `data:  x` legitimately carries a
    // leading space, and trimming would corrupt indented JSON or diff text.
    if (value.startsWith(" ")) value = value.slice(1);

    switch (field) {
      case "event":
        this.#type = value;
        break;
      case "data":
        this.#data += `${value}\n`;
        break;
      case "id":
        // The spec ignores an id containing NUL. That also matters concretely
        // here: this value goes back out as a `Last-Event-ID` request header,
        // and a NUL in a header value throws.
        if (!value.includes("\0")) this.#lastEventId = value;
        break;
      case "retry":
        // Valid, and useless to us: we never reconnect from inside the parser.
        break;
      default:
        // Unknown field names are ignored, which is what lets Cursor add
        // fields without breaking us.
        break;
    }
    return undefined;
  }

  /** A blank line arrived. */
  #dispatch(): SseEvent | undefined {
    if (this.#data === "") {
      // An `event:` or `id:` with no `data:` dispatches nothing at all. The id
      // side effect already happened, which is why anything that waits for an
      // *event* named `done` can wait forever while the ids keep moving.
      this.#type = "";
      return undefined;
    }

    // Exactly one trailing newline comes off, because every `data:` field
    // appended one. Trimming would eat a deliberate blank final line.
    const data = this.#data.endsWith("\n") ? this.#data.slice(0, -1) : this.#data;
    const event: SseEvent = {
      type: this.#type === "" ? "message" : this.#type,
      data,
      lastEventId: this.#lastEventId,
    };
    this.#data = "";
    this.#type = "";
    // #lastEventId deliberately survives. See SseEvent.lastEventId.
    return event;
  }
}
