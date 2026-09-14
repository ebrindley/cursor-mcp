# Environment control-plane contract

This document classifies authority. It does not describe undocumented dashboard
requests as a supported integration.

## Authority summary

| Surface | Environment/Build authority |
|---|---|
| Published Cloud Agents API key | Agent and run lifecycle only. No published environment, Build, version, activation, restore, or rollback resources. |
| `@cursor/sdk` | Agent lifecycle and named-environment selection at launch. No environment/Build control plane. |
| Delegated Cloud MCP | Environment/Build reads, run-scoped proposal, test-Build trigger, and snapshot operations. Not a reusable host API. |
| Dashboard browser session | Product UI for Save, manual Build trigger/cancel, Build activation/deactivation, and environment-version Restore. No published reusable contract. |
| `.cursor/environment.json` | Repository-owned declarative definition. A commit is not Save of a personal/team environment version. |

Absence from the published API proves only that the API-key authority does not
expose the capability. It does not prove Cursor lacks an internal control plane.
Cookie or CSRF replay is not an acceptable production integration.

## Proposal is not persistence

Dated Cloud MCP evidence established:

- `propose-environment-json` accepted only `environmentJson` and optional
  `buildId`;
- it could not accept environment id, environment name, or environment-version
  id;
- targeting was implicit through the current run's linked environment;
- the response echoed proposed install/start text but returned no proposal id,
  environment-version id, or config-version id;
- refreshing the standalone owner editor still loaded the old persisted scripts;
- `request-environment-setup-actions` recorded an owner action but did not save.

The correct typed result is therefore:

```json
{
  "persisted": false,
  "requiresOwnerSave": true
}
```

Do not add speculative optional receipt or version fields.

## Per-action classification

| Action | Supported authority | Contract |
|---|---|---|
| Save database-managed environment configuration/version | Dashboard owner action (`environmentJsonPath` null) | Cloud MCP proposal may stage review content, but Save requires durable version readback. Documented to mint a version **and** fire a `CONFIG_CHANGE` Build. See [environment-save-persistence.md](./environment-save-persistence.md). |
| Save repository-file managed environment configuration | `repo-commit` (`environmentJsonPath` present) | The configuration of record is the file at that path on the default branch. A commit is not a dashboard Save, and dashboard Save is shadowed by the committed file. |
| Commit repository environment definition | `repo-commit` | `.cursor/environment.json`; distinct from dashboard Save and subject to documented resolution precedence. |
| Trigger agent-requested draft Build | Delegated Cloud MCP | `trigger-environment-build`, implicitly scoped to the current run's environment. Do not infer a host route from the tool name. Contract proven 2026-08-29; see [environment-build-operations.md](./environment-build-operations.md). |
| Trigger general manual Build | Dashboard owner action | No published API-key or SDK contract. |
| Cancel Build | Dashboard owner action | Absent from a live delegated tool census, not merely undocumented. Run cancellation is a different resource and must never substitute for Build cancellation. |
| Activate/deactivate Build | Dashboard owner action | Requires exact `buildId` and active-state readback. `SUCCEEDED` and current-run Build do not prove active state. |
| Restore environment version | Dashboard owner action | Requires public environment-version identity and current-version readback. |
| Roll back Build | No distinct published primitive | Treat as selecting/activating a prior successful Build only if a supported contract proves that contract. Never conflate with environment-version Restore. |

The observed delegated read model exposed no fields named `active`, `latest`, or
`currentRun`. `environment-info.build.buildId` identifies the Build used by that
run, not the environment's active Build.

## Environment and Build interfaces

Environment and Build operations use the authorities listed above. Where no
supported programmatic operation exists, the MCP returns an owner-required
action for the dashboard. It does not guess routes or replay dashboard
credentials. `GET /v1/me` establishes account identity, not environment or Build
authority.

## Required future contracts

Future adapter changes must establish these independently:

- explicit environment targeting on every write;
- durable version id after Save — **specified but unexecuted** as of 2026-08-29;
  persisted install/start readback is **unavailable** on the delegated surface
  when `environment-info.environmentJson` is owner-restricted, so the version id
  is the only delegated persistence signal;
- ~~returned `buildId`, trigger type, and initial status after Build trigger~~ —
  established 2026-08-29: the trigger returns `buildId`, `isDraft`, and
  `createdDraftEnvironment`, but **not** trigger type or initial status, which
  require a list readback;
- cancellable-state and terminal Build readback for Build cancel — still
  unproven; no delegated cancel operation exists to readback against;
- expected-current and resulting active Build for activate/deactivate —
  **specified but blocked on active-Build readback** as of 2026-08-29;
- source and resulting environment-version ids for Restore — likewise blocked;
- separate Build and environment-version rollback semantics;
- conflict, idempotency, authorization, and audit behavior.

See "Activation, restoration, and rollback" below for the blocking triad and the
per-operation residual shapes.

Keep identifier types separate:

- `environmentPublicId`;
- public opaque `environmentVersionPublicId`;
- numeric/internal `builds[].environmentVersionId`;
- `buildId`;
- snapshot-operation id and base-snapshot id.

## Residual owner action

Until a supported authority is proven, return a structured residual instead of
claiming success:

```json
{
  "status": "OWNER_ACTION_REQUIRED",
  "action": "SAVE_ENVIRONMENT",
  "authority": "browser-session",
  "environmentPublicId": "<environment-id>",
  "environmentVersionPublicId": "<optional-version-id>",
  "buildId": "<optional-build-id>",
  "reason": "No published API-key, SDK, or delegated Cloud MCP authority for this action.",
  "requiredReadback": "<durable version, terminal Build status, or active Build id>"
}
```

Allowed action values are:

- `SAVE_ENVIRONMENT`;
- `TRIGGER_BUILD`;
- `CANCEL_BUILD`;
- `ACTIVATE_BUILD`;
- `DEACTIVATE_BUILD`;
- `RESTORE_ENVIRONMENT_VERSION`;
- `ROLLBACK_BUILD`.

This residual is a capability result, not an invitation to automate the
dashboard.

## Activation, restoration, and rollback

Activation requires both a supported write authority and exact active-Build
readback. The supported adapters provide neither.

| Question | Answer on supported authorities |
|---|---|
| Make a qualified successful Build active by exact `buildId`? | **No.** No activate or promote operation exists on the API key, the SDK, or the delegated census. |
| Restore the previous active Build by exact `buildId`? | **No.** No rollback primitive on those authorities, and the predecessor cannot be recorded. |
| Restore a previous environment version by exact `environmentVersionPublicId`? | **No** as a reusable contract on those authorities. |
| Read the active Build authoritatively? | **No** on the delegated surface: no field named `active`, `latest`, or `currentRun`. |

Each answer above is scoped to the authorities this project may use.

Keep three layers separate: the **product capability** is documented in the
dashboard; the **exact-id supported contract** is absent on every programmatic
authority; the **implementation** is therefore unjustified. Absence on these
authorities is not a claim that Cursor lacks the capability.

### Why no experiment was run

Three preconditions fail independently, each sufficient on its own:

1. **The predecessor cannot be proven active.** An id can be declared out of
   band, but no surface can show it *is* the active Build.
   `environment-info.build.buildId` is the Build the pod booted from. A
   `SUCCEEDED` row is not an active Build. Any mutation would therefore be
   irreversible by construction.
2. **"Qualified" and "non-current" are not computable client-side.** Build rows
   carry no promotability flag, no `isDraft`, no ref, and no commit SHA.
   Promotability is defined by the trigger contract as built from every
   repository's default branch — a property absent from the row.
3. **No activation write exists** on the API key, the SDK, or the 14-tool
   delegated census.

Consequently, **even if Cursor exposed an activate endpoint on a supported
authority tomorrow with no other change, this project still could not safely
target it.** The readback gap is binding, not merely the missing verb.

The readback gap is scoped to this project's supported programmatic authorities;
it does not establish what is available elsewhere in Cursor's product.

A missing active-Build field or mutation verb cannot be supplied by inference.
Return the existing owner action before any unverifiable mutation.

### Four operations, never one code path

A generic `restore(target)` performs the wrong operation on a type confusion.

| | Activate | Deactivate | Environment-version Restore | Build rollback |
|---|---|---|---|---|
| Resource | Build | Build | Saved environment version | Build |
| Identifier | exact `buildId` | exact `buildId` | `environmentVersionPublicId` | predecessor `buildId` |
| Changes saved Install/Start? | No | No | **Yes** | No |
| Names a replacement? | Yes | **No** — resulting selection is unpublished | n/a | Yes |
| Extra effect | None documented | Unspecified | May fire `CONFIG_CHANGE` and mint a **new** `buildId` | None |
| Inverse | Activate the predecessor | **Not** the inverse of Activate | Another forward Restore, i.e. compensation | Activate the successor |

**Build rollback is not a published primitive.** Its only honest meaning is
activating a prior successful, promotable `buildId` without changing saved
configuration.

**Automatic lifecycle activation** — a successful non-draft Build becoming
active — is a **third** story, distinct from an exact-id pin of a non-current
Build. Do not implement auto-promote as Activate. Pin semantics are unpublished,
so activation durability against a later successful recurring or
`CONFIG_CHANGE` Build is unspecified.

If a Restore fires a configuration-change Build that then auto-activates on
success, the resulting active Build is a **new** `buildId`, not the predecessor.
Never adopt it as the predecessor.

Also keep **launch-from-a-specific-Build** separate: that is a per-run boot
override, not environment-wide activation, and API-key create cannot pass a
`buildId`. `START_AGENT_FROM_BUILD` is not a residual action.

The SDK's `Agent.unarchive()` restores an archived **agent**. It is a name
collision, not environment-version Restore.

### The blocking triad

Implementation stays unjustified unless **all three** appear together on a
non-browser authority. Cookie or CSRF replay is permanently disqualified.

1. An **activate operation** on a supported authority.
2. An **authoritative active-Build read** on that same authority, with
   read-your-write freshness, able to express "none active" as a value
   distinguishable from "unreadable".
3. **Expected-current preconditions** with typed conflict behaviour.

Any one or two arriving alone still yields NO-GO. **A verb arriving without the
read is the most dangerous case**, because it is the one that would look
implementable and would not be. If that happens, stop and re-scope; do not
opportunistically call it.

A future write contract must also require an explicit `environmentPublicId`, an
exact `buildId` with no recency or "latest" selection, a required
`expectedActiveBuildId` whose "expected none active" sentinel is distinguishable
from omission, an idempotency key, and server-enforced qualification with typed
errors. Do not treat the OpenAPI's existing `409` codes — `agent_busy`,
`agent_archived`, `agent_id_conflict`, `run_not_cancellable` — as Build-activation
conflict behaviour. Snapshot retention is unstated, so activating a
garbage-collected snapshot needs a distinguishable error.

Until such a contract exists there is no idempotency key on any delegated write,
so a write would be zero-retry after dispatch, and an unknown outcome resolves by
authoritative readback only — never by a second activation and never by a
compensating rollback.

### Residual rules for these four actions

Qualification failures are **typed client errors, not owner residuals**. If the
named Build is failed, skipped, in progress, draft, non-promotable, in the wrong
environment, or ambiguous, refuse with a client error. Emit `ACTIVATE_BUILD` or
`ROLLBACK_BUILD` only when the target would be eligible if an operation existed.

- `ACTIVATE_BUILD`, `DEACTIVATE_BUILD`, and `ROLLBACK_BUILD` carry `buildId`.
  `RESTORE_ENVIRONMENT_VERSION` **must never carry a `buildId`**, because a Build
  id is not a Restore receipt.
- `RESTORE_ENVIRONMENT_VERSION` carries `environmentVersionPublicId`. The
  Build-family actions must never carry one, and no residual ever carries the
  numeric `builds[].environmentVersionId`.
- Build-family residuals carry `activeBuildReadable: false` together with an
  explicit `expectedActiveBuildId: null`. Never omit it: a dated dashboard
  observation of a blank Active Build field is ambiguous between "none active"
  and "not shown to you", so omission would let a consumer read absence as "none
  active".
- `ROLLBACK_BUILD` additionally carries `supersededBuildId` to preserve intent,
  since the dashboard gesture is identical to Activate. Its predecessor field
  must be null with a reason today; emitting a predecessor described as proven
  active would be a fabrication.
- Never present `ROLLBACK_BUILD` and `RESTORE_ENVIRONMENT_VERSION` as
  interchangeable alternatives.
- Never emit a `SUCCEEDED` status, a `userFacingSnapshotId`, or
  `environment-info.build.buildId` as evidence of activation.
- If a future write is dispatched and its outcome is unknown, return
  `ACTIVE_STATE_UNKNOWN` rather than recommending another mutation.

Activation and Restore remain dashboard owner actions until the contracts above
are available.
