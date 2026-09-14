# Bounded run activity

`cursor_tail_run` reads a bounded activity excerpt. It is an optional read tool;
add its exact name to a policy with an explicit tool list, then restart the client.
Profiles using `read:*` already permit it. It does not launch or cancel cloud work.

Pass `agentId`, `runId`, optional `lastEventId`, and optional `durationMs`
(default 10 seconds, maximum 30 seconds). The entire call, including scope and
final REST readback, is bounded to 45 seconds. Each read consumes at most 1 MiB of
stream input and 200 events, with text capped below the policy response budget.
There are no automatic reconnects and no background subscriptions. A client that
supplies a progress token gets counter notifications while the read runs; see
[progress notifications](#progress-notifications) for their contents and
client-dependent display behavior. Cancellation or client
disconnect stops monitoring, not the run.

The response includes `eventsRead`, `bytesRead`, `done`, `truncated`, `stopReason`,
`lastEventId` when usable, `replayRequired`, and `statusVerified`. `status` and
`terminal` are present only when REST readback verifies the requested run identity.
Use `cursor_get_run` for the final reply and branch/PR details. Stream `done` means
only that the stream ended; it never proves success.

Pass the returned cursor into the next call. Partial results conservatively resume
before the final event-ID group because Cursor can give several events the same
ID. Expect replayed events; IDs cannot deduplicate them. If no safe cursor exists,
`replayRequired` is true. A single event or ID group larger than the read budget
can prevent cursor advancement; use `cursor_get_run` or Cursor's UI instead of
repeating an unchanged call indefinitely. Clipped activity is not a lossless log.
An expired stream (`410`) or rejected cursor (`400` with a supplied cursor) returns
REST status when available and does not retry. Drop a rejected cursor only when
you deliberately want to replay. An expired stream should be inspected via REST.

For a whole replay rather than an excerpt, see [the export contract](run-export.md).
`cursor_export_run` writes one terminal run's every byte to a configured directory
and returns totals; none of it enters the model's context. Everything below about
parsing, decoding, and what `done` does not prove applies to it unchanged.

## Progress notifications

`cursor_tail_run` and `cursor_wait_run` send `notifications/progress` while they
read, and only when the calling client attached a `progressToken` to the tool
call. No token means no notification: the token is how a client says it will
consume them, and a token of `0` is a token like any other.

What is sent is this server's own counters, in its own words: for a wait, the poll
count and elapsed seconds against the requested bound; for a tail, events read,
bytes read, and elapsed seconds. Cursor's assistant text, thinking, and tool
transcript never appear in a notification — a client may render notification text
outside the tool result, where the caller cannot see that it came from an agent,
and unlike the excerpt it would be unbounded. Messages are sanitized and capped at
200 bytes.

`progress` starts at 1 and increases by one per notification. **No `total` is ever
sent**, because a monitoring read does not know how many polls or events remain,
and a client given a total draws a percentage from it — a fabricated one. A wait
sends at most one notification per completed non-terminal poll (its poll interval
is at least a second); a tail sends at most one per second, dropping the
in-between ticks rather than queueing them, so the next one carries the newest
counters. Both stop at 60 notifications per call, and stop entirely once the tool
has its result. A notification the client rejects is dropped and disables further
sends for that call; it never fails the read, and it never changes the result,
the resume cursor, or the time limits described above. Cancelling the call still
stops local reading only — `cursor_cancel_run` remains the way to stop cloud work.

The MCP client determines whether and how notifications are displayed. The server
does not guarantee a visible progress indicator or that notification text enters
the model's context. Notifications do not extend this server's monitoring bounds;
the server does not rely on them resetting a client's request timeout. Clients
that ignore notifications still receive the same tool results.

## Replay semantics and limits

The endpoint is `GET /v1/agents/{id}/runs/{runId}/stream` with `Accept:
text/event-stream`. The parser accepts status, assistant, thinking, tool-call,
interaction-update, result and completion frames, plus unknown event types.

A fresh connection may replay earlier events. Event IDs can repeat; they are
resume cursors, not unique deduplication keys. The parser handles LF, CRLF and bare
CR framing, including events split across chunks. A quiet connection need not send
heartbeats, so idle timeouts are explicit bounds, not evidence of completion.

A long replay can exceed the tail tool's byte or event budget. Use
`cursor_export_run` for disk capture rather than trying to reconstruct a replay
from bounded excerpts. Capture early: a retention duration with no established
epoch does not provide a reliable expiration deadline.

REST run detail is the terminal-status authority. A stream's FINISHED frame or
`done` event does not establish successful execution. Tool calls can remain running
without a completion event when the stream ends. Correlate tool events by `callId`
when present; treat subtype and tool names as open strings.

Read requests can be throttled. Exports are serialized with bounded retries;
usage-exhaustion errors are not retried as congestion.

## The one that matters: a truncated stream looks successful

A server can send a complete event, then half of another, then **cleanly
terminate the chunked encoding**. At the transport layer that is a fully
successful, well-framed HTTP response: `done: true`, no error, no way to tell.
Only the application layer knows an event was cut in half. Any proxy or ingress
that closes a stream at an idle timeout produces exactly this.

This is the protection we *lose* by moving off `response.text()`. undici enforces
`Content-Length` and chunked framing and rejects truncation — verified — but SSE
framing is application-level and undici cannot validate it.

Three guards, because they catch different things:

1. **Require the terminal `done` event.** A clean EOF without it is a failure,
   never a finished run.
2. **Assert the buffers are empty at EOF** — leftover line buffer, pending data
   buffer, held `\r`, and the `TextDecoder` flush. Non-empty means truncation.
3. **Never derive run status from stream status.** Confirm terminal state with
   `GET /v1/agents/{id}/runs/{runId}`. Cursor's docs are explicit that delivery
   is best-effort, that a dropped event is never redelivered, and that the list
   is the source of truth. The stream is a latency optimisation, not a ledger.

## Parsing (WHATWG HTML §9.2.5–9.2.6)

- Dispatch on a blank line; strip exactly **one** trailing `\n` from the data
  buffer. Do **not** split on `\n\n` — that misses `\r\n\r\n` and bare `\r\r`.
- Remove exactly **one** leading space after the colon. A line with no colon is
  a field name with an empty value. A line starting with `:` is a comment.
- **`event:`/`id:` with no `data:` dispatches nothing**, but the `id` side effect
  still applies. If Cursor's `done` carries no data payload, waiting for an
  *event* hangs forever — track `id` separately.
- **`data:` with an empty value does dispatch**, with `data === ""`. Guard before
  `JSON.parse`.
- **The last-event-ID buffer is not reset between events**, unlike the data and
  event-type buffers. Every later event inherits the last seen `id`.
- Hold a trailing `\r` — the `\n` may be in the next chunk — but **flush it at
  end of stream**, or a bare-CR server silently loses its final event.
- Strip **one** leading BOM, statefully: the BOM can arrive as its own chunk.
  Miss it and the first field name becomes `"﻿data"`, matching nothing.

## Decoding

One long-lived `TextDecoder` with `{ stream: true }` for the whole stream, and
`decode()` with no arguments at EOF to flush. A fresh decoder per chunk, or
`Buffer.toString()`, silently corrupts a multi-byte character split across chunks
into `U+FFFD` — no error, just mojibake that fails validation later pointing at
the wrong problem.

## Lifecycle

- **Cancel the body on every exit path.** Abandoning a reader keeps the socket
  *and* leaves the server generating events long after the client stopped
  reading. GC does not help — an in-flight body is referenced by the dispatcher.
- **Bound each call and its bytes.** The shipped bounded reader intentionally stops
  even a healthy stream at its absolute ceiling. It does not reset the deadline on
  activity and does not need a separate idle timer for this short-lived read.
- **Chain the MCP client's cancellation in**: `AbortSignal.any([extra.signal, absolute])`. Without it a cancelled tool call leaves the stream running.
- A **separate dispatcher** was going to be required here, on the grounds that one
  long stream holds a connection from a bounded per-origin pool and can starve REST
  calls. Measured on Node 24: eight simultaneously held open streams delayed a REST
  call to the same origin not at all, returning in 2 ms. The default global agent
  does not bound connections per origin the way that assumed. Skipped, since it
  would also mean adding `undici` as this client's first HTTP dependency. Revisit if
  starvation ever actually shows up.
- **Send `Accept-Encoding: identity`.** undici sends `gzip, deflate` by default;
  a server that does not flush the compressor buffers every event until close, so
  progress arrives all at once with no error raised, and an idle timeout then
  kills a perfectly healthy stream.
- **Assert the content type is `text/event-stream`.** `fetch` does not care, so an
  HTML 502 from a proxy would otherwise be fed to the parser and reported as
  "stream ended with no events".
- `res.body` is `null` on 204/304 — `getReader()` on it throws.

## Resumption

This section previously concluded **not** to resume, on the general grounds that
`Last-Event-ID` can miss and duplicate events and that the spec offers no gap
detection. Measurement reverses that, because it also showed the alternative is
worse: since every fresh connection replays the entire run, not resuming means
every follow-up call re-reads everything seen so far.

Resumption works, and it is exclusive of the id given: passing the last id from a
previous connection returned events strictly after it, with no repeat. A malformed
or foreign id returns `400 invalid_last_event_id` in the application error
envelope, so a bad id fails loudly instead of silently restarting from the top.
That failure mode is recoverable by dropping the id and replaying.

The general warning still applies where it is actually true. Ids are not unique, so
they order events but cannot deduplicate them. The `status` event carries no id and
repeats on every connection, so any consumer has to be idempotent on it.

The retention header reported 86,400 seconds (observed 2026-08-22 and again on
2026-09-08, epoch unverified — see above), after which the endpoint returns
`410 stream_expired`. Treat that as "read terminal state over REST", not as
retryable.

## Timeout ceiling

The MCP SDK's default client-side request timeout is 60s and does **not** reset on
progress notifications by default. So a single `tail_run` call must return well
inside 60s regardless of run length — bounded tail, then let the caller decide
whether to call again. It cannot block until the run finishes.

For repeated calls, the returned cursor is conservative on partial output: it may
replay the final ID group rather than skip unread events with a duplicate ID.
The byte and event ceilings can prevent progress through a very large group; that
limitation is explicit rather than silently skipping data.
