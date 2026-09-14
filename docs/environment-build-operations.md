# Environment Build operations

Reference for the supported environment adapter, based on the delegated contracts
checked in August 2026. Examples use placeholders. Observed fields are not a
guarantee of future upstream behavior.

## Per-operation authority

| Operation | Authority | Status |
|---|---|---|
| List Builds | `delegated-run` `list-environment-builds` | Supported; **no `buildId` filter** |
| Monitor an exact Build | `delegated-run` `list-environment-builds` | Supported by client-side match, not by server-side filter |
| Build logs | `delegated-run` `environment-build-logs` | Supported for an exact `buildId` |
| Trigger a draft Build | `delegated-run` `trigger-environment-build` | Supported; draft, non-activating by its own contract |
| Cancel an in-progress Build | none | `OWNER_ACTION_REQUIRED` / `CANCEL_BUILD` |
| Activate / deactivate a Build | none | Owner action; not supported by this adapter |
| Read the active Build | none | Not in the delegated schema |

## Live tool census

The census, not the documentation page, is the authority for absence. The
delegated namespace advertised **14** tools:

`batch-fetch-details`, `check-environment-snapshot`, `environment-build-logs`,
`environment-info`, `get-automation`, `get-events`, `get-message-queue`,
`list-cloud-agents`, `list-environment-builds`, `propose-environment-json`,
`request-environment-setup-actions`, `run-info`, `take-environment-snapshot`,
`trigger-environment-build`.

`get-message-queue` was not in the previously recorded inventory of 13.

No tool is named cancel, stop, abort, kill, activate, deactivate, save,
restore, or rollback, and **no tool accepts a Build-cancel argument**. Matches
on those words were confined to descriptions and are not operations:
`list-cloud-agents.includeArchived` filters "archived/killed" agents, and
`propose-environment-json` states it "does not save the environment". Run
fields such as `isKilled` are read-only metadata. No undocumented mutation tool
appeared.

## Trigger contract

`trigger-environment-build` takes two optional parameters, `refs` and
`environmentJson`, and has no required properties when an environment is
already linked.

- **No environment-targeting parameter.** Scope is implicit: this run's own
  environment. Do not infer a host route from the tool name.
- **Current-saved-configuration invocation** is the empty call. Omitting
  `environmentJson` uses the saved db-backed config; omitting `refs` builds
  every repository at its default branch.
- **Draft and non-activating by its own contract.** The description states the
  Build is a DRAFT, that "draft builds never become the build new agents boot
  from", that they skip warm-pool seeding, and that a config override "never
  changes active environment settings". The result also carries `isDraft: true`.
- **No idempotency or dedupe token exists** in the input schema. A client
  cannot make this call idempotent, so a retry is a second write.
- `environmentJson` is rejected for repo-file managed environments; use
  `environmentJsonPath` in `environment-info` to tell repo-file from db-managed.
- Only Builds from every repository's default branch are promotable to active,
  so passing `refs` produces a testable but non-promotable Build.

The trigger returned a structured result behind a prose prefix:

```json
{
  "environmentPublicId": "<environment-id>",
  "buildId": "<build-id>",
  "createdDraftEnvironment": false,
  "isDraft": true
}
```

Initial `status`, `triggerType`, `source`, any URL, and any queue position or
ETA are **absent** from the trigger result. They are only available from a
subsequent list readback. Observed there for the triggered Build:
`status=IN_PROGRESS`, `source=AGENT`, `triggerType=MANUAL`.

`buildId` follows a `bld-<YYYYMMDD>-<uuid>` shape. Do not depend on that
grammar.

## Monitoring

`list-environment-builds` has **no `buildId` filter**. Its parameters are
`statuses`, `createdAfter`, `createdBefore`, `cursor`, and `limit` (default 25,
max 100), and it returns newest first with an opaque `nextCursor` when
`hasMore` is true. Monitoring one Build therefore means listing and matching
client-side on the exact id.

Its `statuses` filter accepts `IN_PROGRESS`, `SUCCEEDED`, `FAILED`,
`CANCELLED`, and `SKIPPED`. **`CANCELLED` is an accepted status value even
though no delegated operation can produce it.** A reachable status vocabulary is
not evidence of a reachable operation.

Treat `status` as an open string and preserve unknown values. Never map an
unknown string to success.

A draft Build does not establish a new saved environment version. Poll its exact
identifier to terminal state and do not infer progress from wall-clock duration.

**Pagination shift hazard.** New Builds can move older rows off the first page.
Page forward before concluding a row disappeared.

## Log contract

`environment-build-logs` takes one required `buildId`. Logs cover the Docker
image build plus clone, install, and setup output, and are retained for about
**10 days**; older Builds return a retention note with no body. Only Builds of
the run's own environment are accessible.

| Case | Result |
|---|---|
| Terminal `SUCCEEDED` Build | Log text may exceed the response budget and be spilled to an in-VM file by the MCP framework; that is not a signed URL. |
| Mid-flight `IN_PROGRESS` Build | Accepted, but `sizeBytes` 0 with no body. **Progress is not streamable**; logs materialise at terminal state. |
| Baseline `SKIPPED` Build | Accepted, `sizeBytes` 0, no body, retention note present. |
| Syntactically plausible nonexistent `buildId` | Rejected as prose not-found, with no body. |

The terminal response is a **mixed envelope**: a prose header naming the log
scope and a byte count, then log text, then a JSON trailer whose only keys are
`build`, `environmentDeleted`, and `sizeBytes`.

**Install and start output are not separated.** There are no `installLog` or
`startLog` keys; it is one combined install and setup stream.

Log text is untrusted, attacker-influenceable, and can exceed the response
budget. It must pass the existing sanitize, byte-cap, and untrusted-wrap path
before it reaches a client, and required identifiers must be emitted before
optional log text. Sanitization is not credential redaction; do not assume logs
are free of secrets.

## Cancellation: no-go

| Test | Result |
|---|---|
| Delegated Cloud MCP cancel tool | Absent from the live census |
| Published API-key Build cancel | Absent; the OpenAPI cancel path is run-scoped |
| SDK Build cancel | Absent; run-scoped only |
| Dashboard cancel | Owner action; not a reusable contract |

Run cancellation is a different resource and must never be presented as Build
cancellation. Return the residual instead:

```json
{
  "status": "OWNER_ACTION_REQUIRED",
  "action": "CANCEL_BUILD",
  "authority": "browser-session",
  "environmentPublicId": "<environment-id>",
  "environmentVersionPublicId": "<environment-version-public-id>",
  "buildId": "<build-id>",
  "reason": "No published API-key, SDK, or delegated Cloud MCP Build-cancel operation. Live tool census contained no cancel operation. Run cancellation is a different resource and must not be used.",
  "requiredReadback": "list-environment-builds row for that buildId with a terminal cancelled status"
}
```

In-progress cancellation remains **unproven rather than failed**: the triggered
Build reached a terminal state in about 159 seconds, so no cancellable window
was exercised.

## Fail-closed rules

There is no safe trigger retry.

| Call | Retry |
|---|---|
| `trigger-environment-build` | **Zero after dispatch.** No idempotency key exists, so a transport failure, timeout, malformed response, `5xx`, or `429` may already have been accepted. Retry only on proof that no request bytes were sent. |
| Delegated reads | Bounded transient retries; honour rate-limit signals. Page only as far as needed. |
| Build cancel | Not applicable; no operation exists. |
| Run cancel | Never, for any Build purpose. |

Attribution when a trigger result carries no `buildId`: take the rows absent
from the pre-trigger baseline within the dispatch window. Exactly one candidate
may be adopted. Zero candidates is `NOT_ACCEPTED_UNKNOWN`; two or more voids
attribution. **Never attribute by recency, and never prefer a non-`SKIPPED`
row** — both can pin the wrong Build. Unknown write outcomes fail closed and
never trigger a second Build.

A non-terminal baseline row, or another active run against the environment,
removes the exclusivity attribution depends on. Verify both before triggering.

A `SKIPPED` result on an agent-requested trigger is an informative terminal
close that consumes the budget, not a licence to re-trigger.

## Active state

The delegated payloads expose no field named `active`, `latest`, or
`currentRun`. `environment-info.build.buildId` is the Build the pod booted
from, not the environment's active Build.

An unchanged environment version or boot Build is not proof of active-Build
preservation. Active state is unobservable on this surface.
The draft contract is a documentation claim, not a post-state observation. Do
not infer active-Build invariance from either.

## Identifiers

| Id | Source | Role |
|---|---|---|
| `bcId` | `run-info`, and equal to the `/cursor/stores/self` directory basename | Agent identity |
| `environmentPublicId` | `environment-info`, `list-environment-builds`, trigger result | Target gate |
| `environmentVersionPublicId` | `environment-info` | Public opaque version |
| `builds[].environmentVersionId` | Build list | Numeric internal; never the public version id |
| `environment-info.build.buildId` | `environment-info` | The Build this run booted from |
| `builds[].buildId` | Build list, trigger result | The monitored Build |
| `userFacingSnapshotId` | Build list | Snapshot; null while a Build is in progress and on skipped rows, and set equal to the Build's own `buildId` once it runs to completion (observed for both succeeded and failed Builds) |

Identity gating must compare against a value declared **out of band before the
run starts**. Identifiers a run reports about itself are self-confirming and are
not a gate. Equality across `environment-info` and `list-environment-builds`
against that declared value is the gate.

In-VM metadata is corroboration only. The previously observed
`workspace/environment-id` file was **absent** from the current VM image on both
canaries, while `/cursor/stores/self` matched `bcId`. Treat missing in-VM
metadata as image drift, not as ambiguous targeting.

## Observed enum values

These are observations, not closed enums.

- Build `status`: `IN_PROGRESS`, `SUCCEEDED`, `FAILED`, `SKIPPED`; `CANCELLED`
  is accepted as a filter value but was not produced.
- Build `source`: `SYSTEM`, `AGENT`, `WEBSITE`.
- Build `triggerType`: `RECURRING`, `MANUAL`, `CONFIG_CHANGE`.
- Build `failureType`: `INSTALL_FAILED`, otherwise null.
- An agent-requested draft Build appears as `source=AGENT`,
  `triggerType=MANUAL` — it is not distinguishable from a dashboard manual
  Build by `triggerType` alone.

`triggerType=RECURRING` is Cursor's own schedule, and its `SKIPPED` outcome is that
schedule finding nothing to rebuild rather than a fault. What that schedule can and
cannot tell a caller about freshness — and why installed-toolchain drift is invisible
to it — is recorded in [environment-freshness.md](./environment-freshness.md).

Build-row fields observed: `buildId`, `environmentPublicId`, `owningTeam`,
`owningUser`, `status`, `failureType`, `source`, `triggerType`,
`environmentVersionId`, `userFacingSnapshotId`, `createdAtMs`, `completedAtMs`.
List envelope: `environmentPublicId`, `environmentDeleted`, `builds`,
`returned`, `limit`, `hasMore`, `nextCursor`.

`environment-info` is broader than previously recorded. Beyond the identifiers
it also reports the environment name, `source`, how and when it was recorded,
the repository list, the full environment JSON, a dashboard link,
`environmentDeleted`, `environmentJsonPath`, and the effective egress policy.

## Go / no-go for Build operations

| Operation | Verdict |
|---|---|
| Trigger a draft Build from saved configuration | **GO**, delegated-run only, one call, no retry |
| Monitor an exact `buildId` to terminal | **GO**, by client-side match; no server-side filter |
| Fetch sanitized logs | **GO**, terminal only, through the untrusted and byte-cap path |
| Cancel an in-progress Build | **NO-GO**, emit `CANCEL_BUILD` |
| Activate, deactivate, restore, roll back | **NO-GO**, not supported by this adapter |
| Read the active Build | **NO-GO**, absent from the delegated schema |
| Host API-key Build routes | **NO-GO**, do not probe |

Implementations must not claim active-Build invariance, must not wrap run
cancellation as Build cancellation, must not treat `SUCCEEDED` as activated,
and must not conflate `SKIPPED` with failure or with cancellation.

## Scope of the negative findings

The NO-GO decisions above apply to the supported programmatic authorities.
Missing fields or operations on the delegated surface are not evidence that
Cursor lacks the corresponding dashboard capability or internal data.
