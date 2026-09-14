# Lifecycle architecture

Architecture of the supported tool domains and their authority boundaries.
See [the capability reference](cursor-capabilities.md) for evidence labels.

## Context

cursor-mcp exposes Cloud Agent operations through a thin custom client. The
planned scope adds named environments, environment definitions, Builds,
snapshots, activation, rollback, freshness, and selected workspace controls.
Cursor may expose those capabilities through different integration surfaces over
time. Callers must operate in Cursor domain terms, not REST, SDK, Cloud MCP, or
dashboard terms.

The capability reference classifies authority. This architecture uses those
labels as `documented`, `observed`, `uncertain`,
`manual-only`, or `unavailable`. It does not speculate an adapter or write path
before the supported contract establishes the available authority.

## Decision

Organize the public surface around four Cursor domains:

1. **Agent Lifecycle** — agents, runs, named-environment launch, archive, delete.
2. **Environment Definition** — local and proposed install/start documents.
3. **Environment Operations** — inspect, build, qualify, save, activate, restore,
   rollback, cancel.
4. **Workspace Controls** — identity, models, connected repositories, and the
   Cloud Agent settings that actually affect a launch.

Use internal adapters only where **two proven, non-browser integration paths**
exist for the same public operation. Today that bar is not met. The API-key
client remains the only host transport. Delegated Cloud MCP is a distinct
authority class, not a second adapter behind the same tools.

Initially model four persistent resources:

- Environment;
- Environment definition / version;
- Build;
- active Build reference.

Represent snapshots as fields on those resources unless Cursor exposes an
independently addressable snapshot that requires its own type. Qualification
evidence and mutation outcomes are operation results, not stored resources.

Extend the existing policy model with an environment-name allowlist and a second
gate for activation or rollback. Keep the existing tool allowlist. Do not add a
second authorization framework.

## Alternatives considered

- **Organize tools by REST, SDK, Cloud MCP, or dashboard surface.** Rejected:
  transport boundaries are not the product. A caller that learned
  `list-environment-builds` would break if the same capability later arrived on
  the API key.
- **SDK integration.** The server uses its HTTP client for shared authentication,
  retries, timeouts, origin checks, and parsing. `@cursor/sdk` is not a dependency;
  see the [dated SDK coverage](cursor-capabilities.md#cursorsdk-coverage).
- **Create a generic workflow or receipt engine first.** Rejected: atomic
  operations do not exist yet. Composition is a later thin layer over those
  operations, not infrastructure they depend on.
- **Mirror every dashboard section.** Rejected: dashboard grouping does not prove
  a supported programmable capability. This server uses only its explicitly
  supported programmatic authorities.

## Consequences

- Atomic tools remain the primary contract. A later end-to-end workflow may
  compose them; it must not replace them.
- Backend-specific limitations are internal capability details. The caller sees
  a Cursor operation plus a precise residual when the operation cannot run.
- Save, activation, rollback, and Build cancellation remain **required
  capabilities** even though every current programmatic authority classifies
  them `manual-only`. They return structured owner-action residuals, never a
  silent no-op and never a fake success.
- Persistent workflow state, mutation databases, and broad workspace
  administration remain deferred.

## Public surface

Tool names are Cursor capabilities. They stay stable if an internal integration
changes. Descriptions stay one line; this document holds the workflow.

Existing tools keep their names. New tools follow `cursor_<verb>_<resource>`.

### Agent Lifecycle

| Operation | Tool | Current contract |
|---|---|---|
| List / get agents | `cursor_list_agents`, `cursor_get_agent` | API-key `observed`. Status is an open string; `IDLE` is follow-up eligibility, not run success. |
| List / get runs | `cursor_list_runs`, `cursor_get_run` | API-key `observed`. Run status is the execution ledger. |
| Usage | `cursor_get_usage` | API-key `observed`. |
| Artifacts | `cursor_list_artifacts`, `cursor_get_artifact_url` | API-key `observed`. Presigned URL only; no second origin. |
| Launch (repository) | `cursor_create_agent` | API-key `observed`. One or multiple repositories; exact target and source-pin readback are reported. |
| Launch (named environment) | `cursor_create_agent` | API-key `documented`, implemented. Same tool, mutually exclusive target arguments, both allowlists. |
| Follow up | `cursor_create_run` | API-key `observed`. |
| Cancel run | `cursor_cancel_run` | API-key `observed`. A request, not a stop. Never a Build cancel. |
| Archive / unarchive | `cursor_archive_agent`, `cursor_unarchive_agent` | API-key `observed`. List hygiene only. |
| Delete | `cursor_delete_agent` | API-key `documented`. Second gate: `deleteEnabled`. |

No-repository launch is the default when all target/source options are absent
and the profile permits the create tool. `noRepository: true` selects it explicitly;
`allowNoRepository: false` opts the profile out. The same decision covers existing
no-repository agents across sessions. Explicit targets retain their allowlists;
invalid or denied targets never fall back. See the README's migration notes.

### Environment Definition

Local, generic, no live Cursor write. Authority is `repo-commit` plus Cursor's
published environment schema.

| Operation | Tool | Notes |
|---|---|---|
| Validate | `cursor_validate_environment_definition` | Implemented. JSONC; strict schema; comments allowed; unknown top-level properties rejected. Optionally returns a validated synchronization request. |
| Inspect | `cursor_inspect_environment_definition` | Implemented. Normalized view of install, start, snapshot input, MCP policy, ports, terminals, container build. |
| Diff | `cursor_diff_environment_definition` | Implemented. Bounded semantic diff. Never emit secret values. |

Saved-definition inspection that exists only inside a delegated run is labeled
delegated untrusted evidence, not host-authoritative configuration.

Schema errors, safety findings, and capability limitations are three separate
lists in the result, and a safety finding names the field and line rather than
quoting the script. Strict shell mode is one of those advisories, not a schema
requirement. Persistence stays out: the synchronization request carries digests,
never Install/Start text and never a `buildId`.

### Environment Operations

| Operation | Planned tool | Classification |
|---|---|---|
| Inspect environment | `cursor_inspect_environment` | Delegated reads `observed`; API-key environment routes `unavailable`. |
| List / inspect Builds | `cursor_list_builds`, `cursor_get_build` | Delegated list `observed`; no `buildId` filter; no active/latest/currentRun field. |
| Build logs | `cursor_get_build_logs` | Delegated `observed`; text; untrusted; terminal-only body. |
| Trigger Build | `cursor_trigger_build` | Delegated draft trigger `observed` (non-activating, no retry). General manual Build is `manual-only`. |
| Cancel Build | `cursor_list_owner_actions` row | `manual-only` (`CANCEL_BUILD`). Run cancel must not substitute. No verb is registered; the catalog carries the owner action. |
| Qualify | `cursor_qualify_environment` | Three independent layers: prepared Build disk, Start execution, task shell. |
| Save / synchronize | `cursor_save_environment` | Database-managed: `manual-only` (`SAVE_ENVIRONMENT`). Repository-file: `repo-commit` of `.cursor/environment.json`. Proposal is not Save. |
| Activate / deactivate | `cursor_list_owner_actions` rows | `manual-only`. Blocked on missing verb **and** unreadable active Build. Catalog rows, not verbs. |
| Restore version | `cursor_list_owner_actions` row | `manual-only`. Distinct resource from Build rollback. |
| Roll back Build | `cursor_list_owner_actions` row | `manual-only`. Exact prior `buildId` only; never guessed. |
| Bounded lifecycle | `cursor_run_environment_lifecycle` | Thin in-process composition of the rows above, plus monitor, dry-run, confirm, timeout, cancel, and rollback. No durable state. |

`cursor_trigger_build` may exist as a real mutation for the proven draft path
and still return `TRIGGER_BUILD` for a non-draft / host-wide Build. One tool,
two capability outcomes.

### Workspace Controls

| Operation | Tool | Classification |
|---|---|---|
| Catalog | `cursor_list_workspace_controls` | Local. Filters `supported`, `unverified`, `unsupported`, and `unavailable-on-plan`. |
| Identity and entitlement | `cursor_whoami`, `cursor_inspect_workspace` | API-key `observed`. Service-account keys omit owner fields. |
| Models | `cursor_list_models` | API-key `observed`. |
| Connected repositories | `cursor_list_repos` | API-key `observed`. Rate limited. |
| One control, read | `cursor_get_workspace_control` | Supported controls fetch live. Others return `unverified`. A `plan_required` / `feature_unavailable` / `role_forbidden` read is `unavailable-on-plan`. |
| One control, write | `cursor_list_workspace_controls` row | `unsupported` until a proven contract exists. No write verb is registered; the row records the capability. |

Defaults, network, secret *names*, MCP policy, and team follow-up stay addressable
as capability results. Writes wait for a proven contract and never fake success.
Secret *values* are never a read or write surface. Slack, Origin, billing, and
self-hosted fleets stay out of scope.

## Domain model

Persistent resources only. Optional fields stay optional: absence on a given
authority is not a defaulted value.

```
Environment
  environmentPublicId
  name?                         # launch key; policy allowlist matches this
  environmentVersionPublicId?   # public opaque version
  environmentJsonPath?          # null => database-managed; string => repo-file
  activeBuild: ActiveBuildRef   # readable only when an authoritative read exists

Environment definition / version
  managedAs: database | repository-file | unknown
  versionPublicId?              # same identifier as environmentVersionPublicId
  # numeric builds[].environmentVersionId is internal and never this field

Build
  buildId
  environmentPublicId
  status                        # open string; never mapped to success on unknown
  source?
  triggerType?
  failureType?
  userFacingSnapshotId?         # snapshot field, not a Snapshot resource
  environmentVersionId?         # numeric/internal; never the public version id
  isDraft?

ActiveBuildRef
  { readable: false }           # this authority cannot read active state
  | { readable: true,
      buildId: string | null }  # null means readable and none is active
```

**Snapshots** live on these models:

- Environment-definition `snapshot` is a *base snapshot input*.
- Build `userFacingSnapshotId` / `snapshotId` is disk provenance of that Build.
- `take-environment-snapshot` / `check-environment-snapshot` produce an
  **operation result** (snapshot-operation id plus readiness), not a stored
  Snapshot type.

Promote a Snapshot resource only if a supported contract shows an independently
addressable snapshot that is neither a Build field nor a base-snapshot input.

**Not resources:**

- Qualification evidence (`preparedBuild`, `startExecution`, `taskShell`).
- Mutation outcomes, including `OWNER_ACTION_REQUIRED` residuals.
- Workflow progress, receipts, or predecessor memory. The caller holds
  identifiers between atomic calls.

**Identifier rules**, binding on every implementation:

1. Do not equate `environmentVersionPublicId` with `builds[].environmentVersionId`.
2. Do not equate `environment-info.build.buildId` (current-run / boot provenance)
   with the environment's active Build.
3. Do not equate `SUCCEEDED`, `userFacingSnapshotId`, or recency with activated.
4. Do not equate `userFacingSnapshotId` with success; it is set on failed Builds.
5. Do not count `IDLE` agents as concurrent activity or as run completion.
6. Identity gates compare against an **out-of-band declared** environment id, never
   against a value the run reports about itself.

Domain types live in `src/lifecycle-model.ts`. Wire schemas stay in
`src/schemas.ts` and remain loose.

## Capability results

Unsupported, uncertain, or manual-only mutations **fail** with a structured
residual. They do not throw through the generic tool-error path, and they do not
return `ok`.

```json
{
  "status": "OWNER_ACTION_REQUIRED",
  "action": "ACTIVATE_BUILD",
  "authority": "browser-session",
  "environmentPublicId": "<environment-id>",
  "environmentVersionPublicId": "<optional-version-id>",
  "buildId": "<optional-build-id>",
  "reason": "<why this authority cannot perform the action>",
  "requiredReadback": "<what would prove the action happened>",
  "nextSteps": ["<operator action>"]
}
```

Action values are exactly those in
[environment-control-plane-contract.md](./environment-control-plane-contract.md):
`SAVE_ENVIRONMENT`, `TRIGGER_BUILD`, `CANCEL_BUILD`, `ACTIVATE_BUILD`,
`DEACTIVATE_BUILD`, `RESTORE_ENVIRONMENT_VERSION`, `ROLLBACK_BUILD`.

Residual field rules from that contract remain binding:

- Qualification failures are typed client / policy errors, not owner residuals.
- `RESTORE_ENVIRONMENT_VERSION` never carries `buildId`.
- Build-family residuals never carry `environmentVersionPublicId` as a Restore
  target, and never carry numeric `environmentVersionId`.
- Build-family residuals carry `activeBuildReadable: false` and
  `expectedActiveBuildId: null` until an authoritative active-Build read exists.
- `ROLLBACK_BUILD` carries `supersededBuildId` and a null predecessor with a
  reason; it does not invent a proven-active predecessor.
- Unknown outcome after a dispatched write is `ACTIVE_STATE_UNKNOWN` or the
  equivalent readback-unknown status for that resource — never a second write.

`uncertain` and `unavailable` use the same residual shape, with `status` set to
`CAPABILITY_UNCERTAIN` or `CAPABILITY_UNAVAILABLE` and the same `action` /
`nextSteps`. Callers branch on `status`, not on prose.

## Lifecycle

The product lifecycle is a sequence of atomic operations:

```
inspect → validate → synchronize → build → qualify → activate → verify
```

Cancellation may interrupt **build** (Build cancel) or a run (run cancel).
Rollback is a separate exact-id Build activation of a caller-supplied
predecessor, never an implicit inverse and never environment-version Restore.

| Stage | Meaning | Authoritative readback |
|---|---|---|
| inspect | Environment identity, managed type, current version, Build history, current-run Build. Active Build only if readable. | `environmentPublicId`, `environmentVersionPublicId`, Build rows. Active Build is currently unreadable. |
| validate | Local definition is schema-legal and safe enough to propose. | Schema result; safety warnings distinct from errors. |
| synchronize | Persist the definition. Database-managed: owner Save. Repository-file: default-branch commit. | New `environmentVersionPublicId` after Save; commit SHA is not present on delegated Build objects. Proposal echo is not persistence. |
| build | Prepare a bootable disk. Draft trigger is the only proven programmatic write. | Exact `buildId` row to a terminal `status`. `SKIPPED` is terminal and consumes the trigger budget. |
| qualify | Three layers, independently. A pass on disk is not a pass on Start or the task shell. | Structured layer results. `get-events` empty is indeterminate, not failed. |
| activate | Make a qualified successful promotable Build the Build new agents boot from. | Authoritative active Build equal to the exact `buildId`. **Currently impossible** on supported authorities. |
| verify | Confirm the environment still matches the intended version and active Build. | Same readback as inspect after the mutation. |

`cursor_run_environment_lifecycle` is the bounded in-process composition of
these stages (plus monitor) and of the cancel / rollback side paths. It is not
a durable workflow engine: nothing is stored, a failed prerequisite stops later
mutations, and every atomic tool stays independently usable. Unsupported steps
are recorded as residuals, never as completed.

## Fail-closed behavior

1. **No speculative writes.** Without a supported non-browser authority,
   return a capability residual. Do not probe `/v1/environments`, `/v1/builds`,
   Cloud MCP tool names as host routes, or dashboard cookies.
2. **No write retry after dispatch.** Trigger, Save, activate, restore, rollback,
   and create inherit the existing client rule: a write is never retried.
   Delegated `trigger-environment-build` has no idempotency key; retry only when
   no request bytes were sent.
3. **Unknown outcome → readback, not compensation.** Never fire a second Build,
   a compensating rollback, or a second activation to "make sure".
4. **Exact identifiers.** No "latest", recency, or newest-successful selection
   for activate, rollback, cancel, or log fetch.
5. **Managed-type discrimination** uses `environmentJsonPath` only. Never probe
   by submitting `environmentJson` to a trigger.
6. **Empty allowlists permit nothing.** The repository list accepts an explicit
   `"*"` meaning Cursor's own installation boundary; the environment list has no
   wildcard. These lists govern their named target classes; no-repository VMs
   independently default to create-tool permission. A missing policy file is read-only.
7. **Named-environment selection is a secrets-and-egress grant**, not merely VM
   routing. Both the environment allowlist and the attached-repository allowlist
   apply; fail if either is unmet or if attached repositories cannot be read
   back.
8. **Active Build unreadable** blocks any implementation of activate, deactivate,
   or rollback, even if a verb appears later without a read. The blocking triad
   in the control-plane contract still applies.

## Transport invariants

The custom client keeps these rules for every new operation:

- Origin confinement: `Authorization` never follows an API-supplied URL off
  `api.cursor.com`. Artifact download remains a presigned URL handed to the
  caller.
- One response budget (`maxResponseBytes`) for the whole structured payload.
  Required identifiers are emitted before optional free text.
- Writes are not retried. Safe reads may retry on 429 within the backoff ceiling.
- Wire schemas stay loose. Unknown future status strings pass through; they are
  never coerced to success or to a terminal state.
- Every Cursor-originated string, including error bodies, Build logs, and
  delegated Cloud MCP output, goes through `src/untrusted.ts` and
  `src/tools/result.ts`. There is no second result path.
- stdio only. No HTTP MCP transport.

Delegated Cloud MCP output is agent-authored untrusted evidence. It is never the
sole authority for a high-impact mutation when independent readback exists.

## Adapters

```
caller
  → MCP tools (Cursor domain)
    → policy + scope
      → CursorClient          # proven API-key path (agents, runs, artifacts)
      → capability residual   # manual-only / unavailable / uncertain
      → (later) delegated run # only for Cloud MCP operations with supported contracts
```

Do **not** introduce an `EnvironmentBackend` / `BuildAdapter` interface now.
Dashboard integration is outside this server's supported programmatic authorities.
A generic adapter appears only when the same public operation has two proven
non-browser authorities and mapping between them would otherwise leak into
tool handlers.

Bounded environment-scoped delegation (launch a credential-free canary to call
Cloud MCP) is an Environment Operations implementation detail, not a public
adapter and not a generalized delegation framework. Launching that delegate is
itself a secrets-and-egress grant and uses Agent Lifecycle policy.

## Policy

Keep one policy file, one tool allowlist, registration-time gating.

| Addition | Shape | Default |
|---|---|---|
| `profiles.*.environments` | array of environment **names**, or bindings `{name, publicId, scope, repos}` | omitted / empty → no named environment may be targeted |
| `activationEnabled` | boolean, same pattern as `deleteEnabled` | `false`; even `tools: ["*"]` does not register activate, deactivate, or rollback |

Activation and rollback also require a caller-supplied `confirm: true` argument.
That is confirmation, not a second permission model.

Environment names match `env.name` exactly after trim. No case folding, no
wildcard. Public environment ids are runtime identifiers, not policy keys.

`deleteEnabled` continues to gate `destructiveHint` tools. Activation is a
separate high-impact class so granting deletion does not grant promotion.

Existing repository allowlists, `autoCreatePR` pinning, and credential
exclusions (`envVars`, inline MCP servers) are unchanged.

## SDK

The server uses its HTTP client for API operations and has no `@cursor/sdk`
dependency. Dated SDK coverage and environment/Build capability limits are
recorded in [cursor-capabilities.md](./cursor-capabilities.md#cursorsdk-coverage).

## Scenario walkthroughs

Classifications below are current as of 2026-08-29. They are the implementation
contract, not a hope that a later dashboard click will become an API.

### Cold setup

A caller wants a new or empty named environment to become the boot image for
future agents.

1. **inspect** — if a delegated read is available, return identity, managed type,
   version, and Build history. Active Build is `readable: false`. If no
   environment exists yet, that is an inspect result, not a bootstrap from a
   hardcoded repository.
2. **validate** — local `.cursor/environment.json` or a proposed document.
   Schema errors ≠ safety warnings ≠ capability limits.
3. **synchronize** — database-managed: `SAVE_ENVIRONMENT` residual with
   `requiredReadback` = new `environmentVersionPublicId`. Repository-file:
   tell the caller to commit the file; this MCP does not git-push.
4. **build** — after Save, Cursor may fire `CONFIG_CHANGE` itself. An
   agent-requested draft Build is the proven programmatic trigger and **does
   not activate**. A host-wide manual Build is `TRIGGER_BUILD`.
5. **qualify** — wait for exact `buildId` terminal status, then the three
   layers. `FAILED` stops the lifecycle; the prior active Build is not claimed
   preserved because it was not readable.
6. **activate** — `ACTIVATE_BUILD` residual. `SUCCEEDED` is not activation.
7. **verify** — re-inspect. Report unverified active state rather than
   inferring invariance.

No customer name, repository, or bootstrap script is in this path.

### Warm launch

An allowed named environment already exists.

1. `cursor_create_agent` sends `env: { type: "cloud", name }` and omits explicit repositories.
2. Read back the attached environment name **and** repositories. Enforce both
   allowlists. Treat this as a secrets-and-egress grant.
3. Follow-up eligibility uses agent status (`IDLE` / `ACTIVE`, not `ARCHIVED`)
   plus run terminal state. `IDLE` is not `FINISHED`.
4. `environment-info.build.buildId` is this run's boot provenance. It is not
   proof of the environment-wide active Build.

Repository-mode launch remains the same `cursor_create_agent` path and now accepts
multiple repository entries. The create response must read back the exact requested set.

### Failed Build

1. Trigger (draft) or observe a `CONFIG_CHANGE` / recurring row.
2. Monitor the exact `buildId` until `FAILED` (or `SKIPPED`).
3. Surface `failureType` when present. Do not activate. Do not retry the
   trigger. Do not claim the previous active Build is still active; report
   active state unverified.
4. Logs, if fetched, go through the untrusted / byte-cap path. Mid-flight logs
   may be empty; that is not a fetch error.

### Cancellation

- **Run:** `cursor_cancel_run` remains the proven request. Confirm with
  `cursor_get_run`. A 200 is not `CANCELLED`.
- **Build:** `cursor_list_owner_actions` returns the `CANCEL_BUILD` row. Required
  readback is that Build's row in a terminal cancelled status. The row exists so
  the capability stays addressable when a later authority appears; a verb that
  could only ever answer "do it in the dashboard" was removed.

### Activation

Caller supplies exact `environmentPublicId`, exact `buildId`, and `confirm: true`.

Refuse as a client error if the Build is failed, skipped, in progress, draft,
in the wrong environment, or otherwise unqualified. If it *would* be eligible,
return `ACTIVATE_BUILD` with `activeBuildReadable: false` and
`expectedActiveBuildId: null`. Do not call the dashboard. Do not treat
`isDraft: false` on a host row as a proven activate verb.

### Rollback

Caller supplies the predecessor `buildId` they want to become active. This MCP
does not remember a predecessor across calls.

Same eligibility checks as activate. Residual is `ROLLBACK_BUILD` with
`supersededBuildId` and a null proven-active predecessor. Never offer
`RESTORE_ENVIRONMENT_VERSION` as an equivalent option in the same result:
Restore changes saved Install/Start and may mint a new Build.

## Out of scope

- Persistent workflow or mutation-receipt storage.
- Generalized authorization beyond the policy file.
- Browser, cookie, or CSRF integration.
- Guessed API-key environment/Build routes.
- Wholesale `@cursor/sdk`.
- Hardcoded customer, repository, environment, runtime, or CLI lists.
- Secret values, Slack, Cursor Origin, self-hosted fleets, billing admin.
- Treating the dashboard host surface as a supported backend.

## Key decisions

1. **Public surface is four Cursor domains**, not transports. Tool names survive
   an internal integration change.
2. **Four resources only** at the start. Snapshots are fields or operation
   results. Qualification and mutation outcomes are not stored.
3. **Atomic tools first.** Composition is optional and later.
4. **Manual-only is still a capability.** Required mutations always exist as
   tools that fail closed with a residual.
5. **No adapter until two proven paths exist.** One client, plus residuals, plus
   later bounded Cloud MCP delegation as an implementation detail.
6. **Policy grows an environment allowlist and `activationEnabled`.** The tool
   allowlist stays the only permission list.
7. **Shared HTTP client.** API operations use consistent authentication, retries,
   timeouts, origin checks, and parsing.
8. **Fail closed on unreadable active Build.** A future activate verb without
   read-your-write is not implementable.
9. **Preserve transport invariants** (origin, budget, write retry, loose
   schemas, untrusted envelope) for every new operation.
10. **No customer-specific bootstrap.** Inspect/validate/synchronize/build work
    from caller-supplied identifiers and local files.


### Late environment discovery

A repository launch can inherit a prepared environment and its secrets even when
POST readback omits the environment. `targetVerified` confirms the requested
target, not a clean image; `environmentVerified: false` means environment identity
is unknown. Source pinning is separate. Qualify a clean installation baseline
before substantive clean-install work; the launch response cannot prove it.

Incomplete environment observations are not cached. A fresh denied observation
evicts an older grant, so subsequent reads and follow-ups cannot reuse it. The
existing cancel tool alone may cancel an exact agent/run pair created by this
server session even after scope denial. This narrow recovery exception does not
authorize reads or further execution and does not survive server restart.
Cancellation responses mean requested, not terminal; if policy prevents terminal
readback, report that limitation rather than claiming the VM stopped.
