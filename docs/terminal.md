# Cloud Agent VM terminal

The optional terminal tools connect from Cursor MCP directly to an existing Cursor-hosted VM. Cursor IDE, an extension, browser automation, and agent inference are not runtime dependencies. The terminal feature requires Node 22 or newer with its built-in WebSocket API; other tools keep the package's normal Node requirement.

Configure the existing `CURSOR_API_KEY` and an explicit policy:

```json
{
  "terminal": { "agentId": "bc-YOUR-EXISTING-AGENT-ID", "executeEnabled": true },
  "deleteEnabled": true,
  "defaultProfile": "terminal",
  "profiles": {
    "terminal": {
      "tools": ["cursor_terminal_status", "cursor_terminal_execute", "cursor_terminal_read", "cursor_terminal_cancel"]
    }
  }
}
```

Without `terminal`, these tools are not registered. Execute requires the existing destructive grant because arbitrary shell code can overwrite or delete files. Cancel remains separately available with execution and profile permission, even without `deleteEnabled`.

Call status to check direct PTY access and get a session ID. Execute accepts a unique command ID and Bash source, returning promptly; poll read for that ID until its state is finished. Every terminal result carries its identifiers (`sessionId`, `commandId`, `terminalId`) and any `output` in the fenced text block as well as in `structuredContent`, so a client that renders only text content can complete the same sequence; both pass through the same sanitizer and `maxResponseBytes` cap. Start directory is `/tmp`; use explicit repository paths when needed. The source is a Bash argument, not text typed into an interactive terminal. NUL is rejected; tabs, quotes and multiline source are supported. Startup profiles and BASH_ENV are disabled for the owned process.

When the Cursor control-plane call behind status, wake, execute, or a session operation fails, the result also names the failed Cursor RPC as `failedOperation` (for example `GetMachine` or `WakeBackgroundComposer`) and, when Cursor answered with an HTTP rejection, its `httpStatus`. A network-level failure carries the operation and no status. The `status` and `reason` codes keep their existing meanings, so a 429, a 503, and a dropped connection all remain `terminal_connection_failed` and are told apart by these two fields, which the text block mirrors.

An oversized command or input is refused by the server rather than by request-schema validation, so the refusal is machine-readable: `invalid_request` with `reason` (`command_too_large` for execute, `input_too_large` for session_input), the measured `bytes`, and `maxBytes`, alongside `commandOutcome`/`inputOutcome` `not_submitted`. Those size fields appear once the request's session and terminal resolve: an unrecognized `sessionId` returns `session_mismatch` and a released terminal returns `not_retained`, neither carrying `reason` or byte counts. The rejected attempt creates no command record and consumes no input sequence. A smaller payload can reuse an ID or sequence that was unused before the rejection; existing IDs and sequences keep their normal replay rules.

One disposable command runs at a time per target; different VMs run independently. Results and command-ID deduplication live in this MCP server process. Repeated identical requests return the retained result; changing source or timeout under the same ID fails. The 32-result capacity refuses new commands rather than forgetting IDs and risking duplicate execution; explicit reset releases settled records and rotates the command sessionId without restarting MCP. Restarting the server clears that state and creates a new session ID. A disconnected client, lost result, or new session is never permission to rerun an uncertain command.

Output retains the first 64 KiB of bytes and returns sanitized text in Unicode code-point pages. PTY output combines stdout and stderr and may include terminal transformations. The client continues consuming after its retention cap so output volume does not hide the process-exit event. `outputComplete` means an exit event was observed after the delivered output; it is not a lossless-capture guarantee. Large output should be written to a caller-owned VM file, followed by small excerpts or checksums. Input has a separate cap: command source must be at most 16,384 UTF-8 bytes, measured in bytes rather than characters. An oversized command is rejected before this request submits anything, so it did not run. A large payload belongs in a caller-owned VM file materialized another way (for example from the repository checkout) and referenced by path.

Completion comes from `PtyExited`, including its exit code or termination signal. Signal termination reports `signal`, a null `exitCode`, and reason `signaled`. The deployed attachment can remain open afterward, so the client explicitly detaches. Cancel, deadline, and output-stream failure handling request PTY termination and check absence on the same pod; `process_not_listed` is not a guarantee that every descendant exited. A stream lost before `PtyExited` is a transport event rather than an outcome: the server reattaches on the same machine from the last observed event cursor, at most three times with 1-, 2- and 4-second backoff, and only for transport-class failures. Replay was observed to be exclusive of that cursor, and an unknown cursor replays the whole history, so repeated events are discarded; the result reports `reattachments` and `continuityUncertain`, which becomes true when a resumed stream did not continue the observed event sequence. Exhausted attempts, and any non-transport failure, leave execution outcome unknown with the existing termination cleanup. The pod keeps a PTY and its event history only while the PTY exists: a process that exits with no client attached is removed within seconds (observed still present about 2 s after exit and gone by about 12 s), after which reattaching fails with `terminal_stream_error`. Resume therefore recovers a stream lost while the process is still running, or an exit that occurred moments before the reattachment; an older exit is not recoverable and the outcome is reported unknown as before. Failed cleanup is explicit. MCP shutdown detaches and can leave remote work running; there is no persisted recovery journal or automatic input replay.

Authentication exchanges the configured API key and discovers the selected VM, keeping returned credentials in memory. Tokens and credential-bearing gateway URLs are excluded from tool results and errors. A failed capability check reports its failure; there is no IDE or inference fallback. Status checks availability and does not intentionally request a wake.

Implementation tests cover the independent transport and result contract. Live verification must start with Cursor IDE exited and use an existing VM; offline tests cannot establish account admission.

## Long-running and detached work

A disposable execute command has a 30-second default `timeoutMs` and a 300-second maximum; heartbeats and keepalives keep a stream attached and do not extend either bound.

For jobs that must outlive the local MCP process, use a caller-owned detached tmux session and save output and the workload's exit status to VM files. After restarting MCP, discover the same target and use a fresh command to inspect those files; this recovers job results, not the old terminal handles or command-ID deduplication state. Initialize any required toolchain paths explicitly because startup profiles are disabled. Files written under `/opt/cursor/artifacts` can be listed with `cursor_list_artifacts` and downloaded using `cursor_get_artifact_url`; use the exact path returned by the listing. Download required results while access works, and clean up only files and sessions owned by your job. Neither tmux nor VM-local files guarantee survival of machine loss.

On 2026-09-16, probes observed an AttachPty WebSocket closing after approximately 60 seconds without frames in either direction (abnormal closure 1006) while the VM, PTY, and process remained healthy. While a streaming request is pending, Cursor MCP sends ListPtys on the same socket after 20 idle seconds to prevent this observed idle drop. Keepalive failures are ignored; this is not a connection-health check or a Cursor timing or availability guarantee. Keepalives do not extend command deadlines or preserve MCP-local handles and output across restart. Cleanup after an unrecoverable stream loss is unchanged.

This server does not create or manage tmux sessions; the reasoning and the conditions for revisiting it are recorded in `.poetic/planning/tmux-durability-decision.md`.

## Interactive sessions

Add these tools to the terminal profile when needed: `cursor_terminal_session_list`, `cursor_terminal_session_create`, `cursor_terminal_session_input`, `cursor_terminal_session_resize`, `cursor_terminal_session_read`, `cursor_terminal_session_attach`, and `cursor_terminal_session_close`. Create/input require the same destructive execution grant as execute. Resize and close require execution permission and their profile entries. Reads do not grant input authority.

1. Call session_list for its **separate** sessionId and nextCreateSequence. This sessionId belongs to the interactive manager, not the disposable-command manager returned by status.
2. Call session_create with that sessionId and sequence. Retain its terminalId and nextInputSequence. Up to four sessions may be retained concurrently. Each is an interactive Bash process in `/tmp`, with no automatic command deadline; shell variables and working directory persist across input calls. The prompt is `MCP> ` and TERM is dumb.
3. Send UTF-8 text with session_input, including a newline to submit a shell command. Use the returned nextInputSequence for the next operation. Ctrl-C is byte 0x03, EOF is 0x04, and other ASCII control keys may be sent in the same data field. Each call's `data` must be at most 16,384 UTF-8 bytes, measured in bytes rather than characters; an oversized payload is rejected before this request submits anything, so it sent no input. `submitted` means the input RPC acknowledged delivery, not that the typed command completed. There is no automatic per-command exit detector in an interactive shell. Use the existing execute tool when structured per-process completion is required.
4. Read output and follow outputNextOffset. Offsets count Unicode code points in the raw decoded stream, before display sanitization. A bounded recent 64-KiB window replaces older output; outputGap reports evicted characters between the requested offset and retained start. waitMs may wait up to ten seconds for output. Request cancellation does not close the shell.
5. Resize with cols/rows. Close explicitly when finished; closing confirms PTY absence on the original machine and frees the retained slot. An unconfirmed close can be explicitly retried. If releaseAvailable is true because the machine changed or creation identity is unknown, close with forget=true explicitly releases only that record and its capacity; it reports released with remoteOutcome unknown, makes no termination claim, and never adopts or terminates another process. Healthy sessions cannot be forgotten. Process exit alone retains its result until close releases it.

The most recent identical create/input sequence is deduplicated. Older sequences are rejected as request_retired, and changed input under the same latest sequence fails sequence_conflict. High-water marks survive record retirement within this MCP process, so forgotten requests cannot execute again. An uncertain input or spawn is never permission to resend under a new sequence. Resize may be repeated with the same desired dimensions; it does not resend shell input.

A lost output stream detaches the session instead of killing its shell. Read/attach/input may make one new attachment attempt using the last observed opaque event cursor, on the original machine. Recently repeated event IDs are suppressed. `reconnectGapPossible` becomes true after stream loss: the server's internal replay retention is not a lossless-output guarantee. Local buffer eviction has the separate exact outputGap count. There is no background reconnect loop or automatic input replay. Terminal rendering, binary byte-for-byte capture, and recovery/adoption across MCP restart are not provided. Shutdown detaches and can leave shells alive. A changed machine is reported; another machine's process is never terminated as cleanup.

Enable `cursor_terminal_reset` to explicitly release all settled command records and obtain a new command sessionId. Reset refuses active work or unresolved cleanup, and old requests then fail session_mismatch. It does not affect interactive sessions. Commands still retain their first 64 KiB; sessions retain recent output. Both page their output within maxResponseBytes and preserve the corresponding cursor.


## Multiple VM targets

The legacy terminal block remains pinned to its configured agentId. An explicit different agentId is rejected. To coordinate several existing VMs through one MCP connection, opt in:

```json
"terminal": { "targets": "profile", "executeEnabled": true, "maxTargets": 16 }
```

Keep the normal defaultProfile, tools, repository/environment allowlists, and execution grants. In profile mode discovery and new work (status, wake, session_list, execute, session_create) pass the existing AgentScope access check, including repository and named-environment policy. Operations on retained handles use their already-authorized context, so output, existing terminal input and cleanup remain available during account-API failures; they cannot admit a new target, and remote PTY operations stay pinned to the original machine. This mode does not grant access merely because the API key can see a VM. An optional configured agentId supplies the default; otherwise pass agentId on every targeted call. Each result identifies its target. There are thirteen terminal tools regardless of VM count, and profiles can expose only the tools a worker needs.

Call status, wake or session_list with agentId first to establish a target context. Then retain that target's command or interactive sessionId and include the same agentId in subsequent calls. Crossed target/session handles fail without executing. Requests using owned handles cannot recreate an absent target. A not_retained result never establishes that remote work did not execute.

maxTargets limits retained local target contexts (default 16, configurable 1–128); it is not a provider VM quota or a scheduler. Each context has independent command and interactive managers, input sequences, retained output, cleanup, and reconnect state. One target waiting on I/O does not lock another. The existing limits of one active disposable command, 32 retained command results, and four interactive sessions apply per target.

Call status with overview=true to inspect retained targets and capacity without discovering or waking a VM. targetOffset and targetLimit page this local snapshot; follow targetNextOffset until it reaches retainedTargets. Pages shrink to fit maxResponseBytes. Entries report in-flight calls, retained results/sessions, and canRetire. Pagination is a live snapshot, so refresh from offset zero if concurrent target admission/retirement changes the list.

At capacity, a new discovery may retire an empty idle context. Retained results are never discarded simply because a page was read: use reset after collecting settled command results, and close all interactive sessions. Active work and unresolved records prevent retirement. If no context is eligible, discovery returns target_capacity. Recreated contexts have fresh session IDs, so old requests cannot replay. Merely reading status/session_list does not reserve an empty context indefinitely; if another discovery retires it before use, rediscover and obtain the new session ID.

No VM is created by these terminal tools. Use the existing lifecycle tools separately. Multi-target routing adds no scheduler, automatic replacement, credential provisioning, background recovery, or MCP-restart adoption. Shutdown detaches every retained target and may leave remote processes running.

## Explicit wake

Allow `cursor_terminal_wake` in the profile with `executeEnabled` to request recovery of an existing VM whose discovery succeeds but PTY gateway is unavailable. It does not require `deleteEnabled`. It prechecks availability and returns `already_ready` without submitting a wake when access already works. Status and execution never automatically call wake.

Wake sends at most one wake request. It does not start an agent run, provision a VM, replay commands, or retry the request. A wake request does not guarantee VM recovery or persistence.

`wakeOutcome` distinguishes `not_submitted`, explicit auth `rejected`, acknowledged `signaled`/`not_signaled`, and `unknown` delivery/application. Do not automatically retry unknown outcomes. `readiness` is separate: `ready`, `unavailable`, `deadline`, `cancelled`, or `skipped`. Acknowledgement does not prove terminal readiness; even false or unknown acknowledgement may be followed by read-only checks.

`waitMs` bounds those checks after the wake response, defaults to 30000 and allows 0–60000; zero skips them. Precheck has a separate 30-second bound and HTTP requests have a 10-second timeout. Cancellation stops further checks, but cannot undo a possibly submitted wake. `machineChanged` compares discovered machine identities before and after when available (otherwise null); false is not proof that processes survived. Wake preserves existing session IDs, retained results and owned handles. Existing machine-binding checks still protect later input and cleanup.
