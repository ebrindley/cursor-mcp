# Waiting for results

Waiting has a finite budget and an explicit owner. A deadline means observation
ended; it does not prove that a command failed, a remote run stopped, or a write
can safely be repeated. Use the existing run, command, job, or resume identifier
to reconcile accepted work.

`src/wait.ts` owns deadline scopes, bounded observation, cancellable sleep,
monotonic clocks, and disposable scheduling. `src/request-context.ts` carries
the request signal, scope, and progress reporter. No production dependency or
persistent job registry is added.

## Rules

1. Select the budget before admission or I/O. Sequential steps consume the same
   remaining budget. A child can shorten its parent, never extend it.
2. Classify a stop from the source the scope owns. Caller-supplied signal reasons
   are not deadline or shutdown evidence.
3. Caller cancellation stops new business steps. Accepted background work has
   an independent context and follows its existing cancellation policy.
4. One observer settles once, even when its operation ignores cancellation.
   Consume late rejections. A late acknowledgment may update the existing owner
   or permit already-authorized containment; it cannot start another business step.
5. Cleanup has a separate finite allowance when it must survive caller
   cancellation. Report unconfirmed cleanup honestly.
6. A resource reservation follows the activity using it. An early response does
   not release a file, stream slot, or command reservation still in use. Preserve
   the feature's existing release policy; do not introduce indefinite quarantine.
7. Use monotonic time for elapsed budgets and pacing. Use wall time for public
   dates, persisted timestamps, and preview expiry. Inject the clocks separately.
   Inject elapsed time at the root; children inherit that clock so their absolute
   deadlines remain comparable.

Registration supplies request context and normally a 45-second foreground
budget. It does not race the whole handler against a timer. Phased adapters
declare `waitBudgetMs: null` and select their own budgets before I/O; this keeps
long CLI operations, delegation, and terminal wake from being clipped to 45
seconds. HTTP attempts still consume the enclosing scope.

## Choosing an owner

| Work | Owner and budget |
| --- | --- |
| Ordinary foreground call | Request, 45 seconds including sequential requests |
| HTTP | Enclosing request; at most 30 seconds per attempt and 45 seconds per request |
| CLI chain | Operation budget covering preparation, dispatch, verification, and cleanup; each process also has its own limit |
| Run, Build, activity, export | Feature observer, including target resolution and admission |
| Delegation | Launch envelope and requested collection are distinct bounded phases |
| Terminal wake | Precheck, submission, and requested readiness are distinct bounded phases |
| Accepted terminal command | Independent command owner, existing execution limit and bounded containment |
| Interactive shell | Persistent shell owner; attach/output/close are bounded observations |
| Bulk job | Independent job owner; observer timeout does not cancel the job |
| Maintenance | Existing cadence using disposable scheduling, independent of observer budgets |

`cursorCli.timeoutMs` remains the per-process ceiling. Optional
`cursorCli.operationTimeoutMs` bounds a complete operation. Its default is
`max(45000, 3 * timeoutMs + 2000)`. Preparation must leave the declared dispatch,
verification, and cleanup allowance before a write can start. An exhausted
preparation budget is not dispatched; an acknowledgment lost after dispatch is
unknown and requires reconciliation.

At the default 15-second process limit, the 47-second operation budget leaves
15 seconds for preparation before the 32-second write reserve. Increase
`operationTimeoutMs` for slower preparation and align the MCP client's request
limit with that budget. This is a time allocation, not measured CLI latency.

## Zero-duration observations

A new delegation returns its creation envelope and resume handle without a
collection GET. Resuming a delegation or waiting for a run performs one bounded
observation without polling, so a handle-only workflow can eventually complete.
Bulk and terminal output observers return a snapshot; terminal attachment is a
separate bounded phase. Wake performs no readiness polling when its requested
wait is zero. A positive wait includes the whole named observation phase.

## Returning an outcome

Keep the feature's result contract. Run and Build observers retain their last
known state; absence of a required first observation remains an error.
Delegation returns pending with the same handle. Local process timeout retains
partial output and distinguishes observation from confirmed termination.
Submitted writes with missing acknowledgments remain unknown; they are not
automatically replayed.

Export reports capture, publication, and cleanup separately. An issued async
file operation can finish after the observer stops. In that case the result uses
an unconfirmed artifact state and candidate paths, omitting definitive
publication and existence fields until those facts are known. The file owner
retains the necessary reservation until the operation settles, and no later
publication step starts after the stop.

## Implementation pattern

Create a scope with `requestScope(timeoutMs)` before a request-owned phase.
Use `within(scope, start)` for bounded I/O and `sleep(scope, interval)` for
polling. Translate `WaitStoppedError` at the operation boundary, or use
`waitFor` to receive an explicit completed, failed, or stopped outcome. Dispose
the scope in `finally`. Admission checks must precede every new business step.

Call `independently` only when starting an existing independent owner or
authorized containment. Give that owner its own finite scope; detaching context
does not authorize new work. Shared authentication and connections have their
own lifetimes, so one caller cannot abort another caller's transport.

`schedule` is for disposable timers and maintenance cadence. `delay` supports
standalone cadence and test seams; production observation uses a scope. Local
completion-versus-stream-loss event multiplexing is not a deadline mechanism.
Third-party SDK timeout internals remain external and are configured at their
boundary. Developer checks may use an independent process watchdog when they
must survive a hung child or inherited pipe, following the same ownership and
outcome rules.

Export allows two seconds for already-owned filesystem work to settle after an
observation stop. Terminal wrappers allow five seconds to serialize known
results. Accepted terminal RPCs keep their original ten-second owner window;
this does not extend the RPC deadline. Delegate archival runs independently
with a five-second allowance and does not delay the collected report.

## Migration and validation

The shared mechanics cover request/HTTP, CLI and local I/O, run/Build/delegated
observation, activity/export, terminal transport and owners, bulk/lifecycle,
progress, and developer probes. Deliberate fixture timers and third-party SDK
internals stay outside the migration. Wall-clock preview and persisted backoff
values remain wall-clock values.

Focused tests exercise depleted budgets, ignored cancellation, late settlement,
independent owners, zero waits, partial output, and publication uncertainty.
The existing CI remains the release gate; no parallel timeout gate is added.

The migration replaces 27 direct timing sites with one shared scheduler and one
installer process-boundary watchdog. The terminal completion-versus-stream-loss
race remains event multiplexing. CLI duration settings increase from one to two;
retry authority, tool permissions, and CI gates remain unchanged.
