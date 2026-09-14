# Exporting a run's whole replay to disk

`cursor_export_run` writes one terminal run's complete SSE replay to a local file,
verbatim, and derives two sidecars from it: a structured tool-call index and a
readable terminal log. It exists because `cursor_tail_run` deliberately cannot do
this — that tool is a bounded excerpt for live monitoring (1 MiB, 200 events, text
into the caller's context), and recovering one multi-megabyte run through it takes
dozens of calls and puts the whole run in the model's context. Nothing about the
tail tool changes here.

This document is the contract, decided before implementation, for the three
questions the export raises: who authorizes the disk writes, where the exported
bytes stop, and what a second call does.

## 1. Authorization: two explicit operator acts, never `read:*`

The tool reads Cursor state, so its Cursor-side risk is a read — but it creates
persistent local files, and no read grant in this server has ever implied that.
So it is not annotated `READ`, and it is not covered by `read:*`.

It carries `LOCAL_WRITE` (`readOnlyHint: false`, `destructiveHint: false`,
`idempotentHint: false`, `openWorldHint: true`). The hints are load-bearing in two
directions: `readOnlyHint: false` is what keeps `read:*` and no-policy read-only
mode from granting it, and `destructiveHint: false` is honest — an export creates
files and never removes or replaces one, so it must not be pushed behind
`deleteEnabled`, which is the gate for permanent deletion of cloud state.
`idempotentHint: false` is the truth from section 3: a second identical call does
not repeat quietly, it refuses.

Registration requires **both** of:

1. The active profile names `cursor_export_run` in `tools`, or uses the `"*"`
   wildcard. `read:*` is not enough.
2. A storage root is configured, as an absolute path, by either
   `profiles`-independent `exportRoot` in the policy file or the
   `CURSOR_MCP_EXPORT_ROOT` environment variable. The policy value wins.

Missing either one means the tool is never registered: it does not appear in
`tools/list` and cannot be called. A relative or empty root is refused — from the
policy file at startup, so a typo cannot silently widen or narrow anything, and
from the environment by declining to register plus one warning on stderr.

A separate `exportEnabled` switch was considered and rejected. It would be a third
gate over the same decision the two above already express, and the operator act
that actually matters — naming a directory this server may write into — has no
default and cannot be arrived at by accident.

Agent-scope checks are identical to every other Cursor read: `scope.assert` on the
agent id before anything else, so a profile's repository allowlist governs which
runs can be exported at all.

## 2. Where the bytes stop: `done`, chunk-atomic, buffers empty

**Completion stops at the `done` event. A bounded clean EOF is not required and is
not waited for.** Cursor replays a finished run and then holds the connection; the
existing reader stops at `done` for the same reason, and waiting for EOF would
trade a definite artifact for an indefinite wait.

The precise contract:

- Every byte received is written to the partial file in arrival order, unchanged
  and unre-encoded, before it is parsed. The export is the bytes, not our reading
  of them.
- The published file therefore contains every byte received through the network
  chunk that completed the `done` event. The boundary is chunk-atomic on purpose:
  trailing bytes that arrived *with* `done` were received, and this server does
  not decide unilaterally that received evidence is uninteresting.
- Completion additionally requires that the chunk carrying `done` ends the stream
  cleanly at the application layer: **no event dispatches after `done`**, and the
  parser's buffers are empty when the stream is finished — no pending line, no
  pending `data:` for an undispatched event, no held `\r`, and nothing left in the
  `TextDecoder` flush.
- If either check fails, the result is `complete: false` with
  `stopReason: "trailing-content"`, the reported `trailingEvents` and
  `trailingBytes` say which, the `.partial` file keeps those bytes, and nothing is
  published. A malformed tail is never discarded and then called complete.
- EOF before `done` is `stopReason: "eof-before-done"`, `complete: false`, partial
  retained. So is exceeding the 32 MiB ceiling (`"byte-limit"`), caller
  cancellation, or a write failure.
- **Any clipping outranks `done`.** When a chunk crossed the 32 MiB ceiling, the
  bytes past it are not in the file, and that is `"byte-limit"` even if the prefix
  that fit happened to contain `done` — a capture missing received bytes is never
  reported as complete, however clean the part that landed looks.
- Written means persisted. A single `write` may store fewer bytes than it was
  given, so each chunk is written until the whole of it is on disk, and a write
  that stores nothing fails the capture rather than looping. `persistedBytes` is
  counted per successful write rather than per whole chunk, so a chunk that landed
  partly and then failed still reports the bytes that reached the file: it equals
  `bytes` on every successful export, and after a failed write it reports what is
  in the `.partial` while `bytes` — the received count — does not include the
  chunk that failed. When a write rejects it never says how much of its buffer
  landed, so the closed file's own size is read and `persistedBytes` is raised to
  it if it is larger. When that size cannot be read either, the count is a floor
  rather than a total and says so: `persistedBytesUnknown: true`, the text reads
  "at least N, exact size unreadable", and the `.partial` is reported as kept —
  because it is. Known-empty and unknown are different answers, and only the
  first one means nothing was written.

`complete: true` means "these bytes arrived, through `done`". It is never a claim
about server-side delivery: Cursor documents stream delivery as best-effort and a
dropped event is never redelivered. Terminal run state comes from
`GET /v1/agents/{id}/runs/{runId}` with the run id and agent id checked against the
request, before the stream is opened — never from the stream's own `status` event,
which is observed to report `FINISHED` for a run REST reports as `CANCELLED`.

The fixture contract follows this section: a fixture ends at its `done` event, and
a fixture with anything after that boundary is a trailing-content fixture, not a
complete one.

## 3. Repeated calls and collisions: refuse, never overwrite or append

Layout under the configured root, with `agentId` and `runId` validated against
`^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$` before they are joined — so no separator, no
dot segment, and no absolute path can be derived from a tool argument, and the
resolved paths are asserted to be the exact expected children of the root:

```
<root>/<agentId>/<runId>.sse.partial   in-progress capture
<root>/<agentId>/<runId>.sse           published raw replay
<root>/<agentId>/<runId>.tools.json    derived tool-call index
<root>/<agentId>/<runId>.terminal.md   derived terminal log
```

- The partial is opened with `wx` (create-exclusive). That is the concurrency
  boundary as well as the collision check: two exports of the same run cannot both
  proceed, and neither can silently continue someone else's file.
- An existing `<runId>.sse`, or an existing `<runId>.sse.partial`, refuses the
  call and names the path. A retry never appends to an earlier attempt's partial
  and never treats it as its own work. Removing or moving an earlier export is the
  operator's decision, not this server's.
- The raw file is closed *before* it is published. Bytes still held in the handle
  are not in the file, and `link` does not flush them, so publishing first would
  put a name that promises a whole capture over one.
- Publication is `link` then `unlink`, not `rename`: `link` fails when the final
  path exists, so publication cannot clobber a file that appeared meanwhile.
  `rename` would. The two steps fail differently and are reported differently: a
  failed `link` published nothing and refuses; a failed `unlink` published
  everything, so it comes back as `rawPublished: true` with
  `partialCleanupFailed: true` and `partialKept: true` — a duplicate to clean up,
  not a lost capture, and never a successful export reported as a failure.
- Sidecars are built in their own `.partial`, closed, and then published by the
  same non-replacing `link`. Exclusive creation alone would still leave a
  truncated file under a final name if the disk filled or the process died
  mid-write; a failed sidecar is absent instead.
- The agent directory is resolved and compared with the resolved root before
  anything is written. `mkdir -p` over a pre-existing `<root>/<agentId>` symlink
  succeeds and would land every artifact wherever that link points, so a
  symlinked agent directory is refused — including one pointing elsewhere inside
  the root. A symlinked *root* is fine: both sides resolve through it.
- One narrow exception to "never remove": when an export fails having written
  **zero** bytes, the empty partial this call created is removed, so a transient
  failure does not leave a file that blocks every later retry. Emptiness is read
  from the file itself, not inferred from a counter, and a partial whose size
  cannot be read is kept: any partial holding received bytes is evidence, and
  uncertainty is resolved in favour of keeping it.
- A published raw export stays valid if a sidecar then fails. That is reported as
  separate fields (`rawPublished`, `toolsPublished`, `terminalPublished`,
  `sidecarError`), and overall `complete` is false, because a partial artifact set
  is not success. A failed sidecar is absent, never half-written.

Cancellation and the 45-second ceiling reach publication too, as far as they
honestly can. No `link`, `unlink`, or `write` takes a signal, so nothing here
claims to interrupt a filesystem operation in flight: the state is checked
*between* steps, and a call abandoned or timed out after the raw file was
published reports exactly that — `rawPublished: true`, the sidecars it did not
write as unpublished, and `stoppedBefore: "cancelled"` or `"time-limit"`. What
already exists on disk is named; what was not attempted is not claimed.

The check before a sidecar is not the only one: a large sidecar's write and close
can outlast the call, so the state is checked again after its bytes are on disk and
**before** the `link` that would publish them. A stop seen there leaves the final
name absent and the sidecar's own `.partial` removed — nothing under a name that
says this export finished — and a stop seen during the last publication attempt is
still reported, because an export missing an artifact says why rather than leaving a
reader to infer it from an absent file. A raw export published before the stop stays
published and valid.

The derived terminal log has its own 2 MiB ceiling, charged in UTF-8 bytes of what
the file will hold — command text, output, and the markup and fences around them.
A command is observed more than once, `running` and then `completed` with its
output, so replacements are charged as a delta and screened against the ceiling
like new entries: an update that would exceed it is dropped whole, keeping the
previous text with only its status refreshed, and `terminalTruncated` says so.

## Pacing and retries

The export owns its own scheduler because the tail transport deliberately has
none: it never retries, never reads `Retry-After`, and discards the error body's
classification. Here the stream request is retried at most twice (three attempts),
only before the first byte is written, and only for a 429 that means congestion, a
5xx, or a transport failure. The wait is `Retry-After` when the response carried
one, otherwise 1 s then 3 s, and it is always cancellable and always clipped to
what remains of the 45-second ceiling for the whole call — including scope
resolution, the REST status read, streaming, and sidecars. A wait that does not fit
is not taken; the call reports why instead.

**One export streams at a time, process-wide.** An exclusive partial already stops
two exports of the same run; different runs also share one stream slot. A second
call queues, and the slot is held across every attempt and every `Retry-After` wait — releasing between
attempts is exactly what would put two readers on the API at once. The queue is
bounded at four waiters and refuses beyond that rather than growing, and a caller
who cancels while queued leaves immediately, having written nothing, without
holding up the callers behind it. This is not a scheduler: no priorities, no
persistence, nothing survives the process.

A 429 classified as **usage exhaustion is never retried**, by the shared
classification in `src/api-errors.ts`: no amount of waiting clears an exhausted
quota, and retrying only spends the remaining attempts.

## What comes back

Totals only, and they stay inside a 1,024-byte response budget: completeness and
`stopReason`, REST-verified `status`/`terminal`, byte counts (`bytes`,
`persistedBytes`, plus `persistedBytesUnknown` when that one is only a floor)
and event counts, trailing counts, tool-call totals (events,
distinct calls, completed, still running), attempt count, publication state, the
file names, and `dirUnderRoot`. Per-tool-name counts and the list of
still-running calls live in `tools.json`; command output lives in `terminal.md`;
everything lives in the raw export.

Artifacts are located relative to the configured root — `dirUnderRoot` is the
agent directory's name, and the file names are plain names — because the absolute
prefix is the one part of the path the operator already chose, and it is the part
that does not fit. Nothing in this report is truncated to make it fit: the
structured payload is capped by *dropping* fields, and a dropped required field
would turn a finished export into a schema error describing nothing. So the widest
report this call could produce is priced against `maxResponseBytes` **before the
stream is opened**, and a budget too small for it refuses immediately with nothing
written, naming the two numbers. At the 1,024-byte minimum that leaves room for
identifiers well past the observed `bc-`/`run-` shapes; ids at the 128-character
limit need a larger budget, and are told so rather than discovered halfway.

Event payloads never reach the response — not its text, not its structured fields,
not its errors. A credential an agent echoed into a command's output is in the raw
file on disk, because that file is a verbatim record and that is its purpose; it is
not in anything this tool hands back to a model. Control-character stripping is not
redaction and is not treated as any.

## Fixtures

`tests/fixtures/export/` contains two synthetic replays and a manifest of their
expected byte, event and tool-call counts. The generator invents every payload
value and uses explicit synthetic tool mixes. Coverage includes interleaved calls,
duplicate event IDs, incomplete calls, malformed tool payloads, and a seeded fake
credential that must stay out of tool responses. No private replay or campaign
measurements are included.
