# Cursor capability reference

Baseline checked on 2026-08-28. This document is organized by Cursor capability,
not by transport. It records what implementers can rely on now and which lifecycle
questions still require bounded discovery. The caller-facing architecture that
consumes these labels is [lifecycle-architecture.md](./lifecycle-architecture.md).

## Evidence labels

| Label | Meaning |
|---|---|
| `documented` | Current official Cursor documentation, OpenAPI, or schema states it. |
| `observed` | This repository measured it against the live service. |
| `uncertain` | The behavior is plausible or advertised, but the required authority or readback is not established. |
| `unavailable` | The capability is absent for the named authority class or explicitly outside this project. |
| `contradicted` | Current authoritative sources disagree; do not silently choose one. |

Authority is separate from evidence:

- `api-key`: the published Cloud Agents v1 API.
- `delegated-run`: Cursor Cloud MCP tools available inside a cloud agent.
- `browser-session`: the signed-in dashboard control plane.
- `admin`: Cursor team/account administration.
- `repo-commit`: `.cursor/environment.json` committed with a repository.
- `cursor-cli`: a locally installed Cursor CLI, authenticated by its own login
  rather than by an API key. Optional, operator-configured by absolute path and
  by checked version. It supports environment reads and separately gated
  publication-to-PR, database Save, and deletion through commands the CLI itself
  advertises. Its command contract is unpublished, so a version nobody
  checked is not assumed to match, and a build whose root help describes an agent
  prompt is treated as having no registered command at all.

Absence from the published API is not proof that Cursor lacks a capability.
Likewise, observing a browser-session request does not make it an acceptable
production integration. Model or agent prose is never a substitute for structured
readback.

## Authoritative sources

| Surface | Source |
|---|---|
| Cloud Agents overview | <https://cursor.com/docs/cloud-agent> |
| API endpoints | <https://cursor.com/docs/cloud-agent/api/endpoints> |
| OpenAPI | <https://cursor.com/docs-static/cloud-agents-openapi.yaml> |
| Environment setup | <https://cursor.com/docs/cloud-agent/setup> |
| Environment schema | <https://cursor.com/schemas/environment.schema.json> |
| Builds | <https://cursor.com/docs/cloud-agent/builds> |
| Capabilities and Cloud MCP | <https://cursor.com/docs/cloud-agent/capabilities> |
| Settings | <https://cursor.com/docs/cloud-agent/settings> |
| Secrets and network | <https://cursor.com/docs/cloud-agent/security-network> |
| In-VM metadata | <https://cursor.com/docs/cloud-agent/metadata> |
| In-VM OIDC socket | <https://cursor.com/docs/cloud-agent/identity> |
| Self-hosted machines | <https://cursor.com/docs/cloud-agent/self-hosted> |
| CLI commands | <https://cursor.com/docs/cli/reference/parameters> |
| TypeScript SDK | <https://cursor.com/docs/sdk/typescript> |
| SDK package | <https://www.npmjs.com/package/@cursor/sdk> |

Implementation notes are in [streaming.md](streaming.md). Labels describe
documented or previously observed behavior, not a fresh live-service guarantee.

## Domain glossary

- **Agent:** durable conversation and workspace, identified by `bc-<uuid>`.
- **Run:** one prompt execution, identified by `run-<uuid>`. Execution state
  belongs to the run.
- **Named environment:** a saved Cursor environment selected with
  `env: { type: "cloud", name }`.
- **Environment definition:** install, start, repository, container, snapshot,
  port, terminal, MCP, secret, and network configuration. A repository-owned
  definition lives at `.cursor/environment.json`.
- **Environment version:** a saved revision shown by the dashboard. Cloud MCP
  exposed a public opaque identifier in `environmentVersionPublicId`; Build rows
  also exposed a separate numeric `environmentVersionId`. Mutation contracts
  remain unpublished.
- **Build:** a bootable snapshot prepared by cloning repositories, running
  `install`, and saving disk state.
- **Base snapshot:** the `snapshot` field in the environment schema. It is an
  input to environment preparation, not the same resource as a Build.
- **Active Build:** the prepared Build used by new agents. Exact activation and
  rollback operations are dashboard-documented but not in the published v1 API.
- **Cloud MCP:** Cursor's environment-scoped, delegated diagnostics/setup tools.
  It is not a documented host control plane.

## Agent and run lifecycle

Authority for this section is `api-key` unless stated otherwise.

| Capability | Evidence | Current contract |
|---|---|---|
| Create agent and first run | `documented`, `observed` | `POST /v1/agents` returns both `{ agent, run }`. |
| Follow up | `documented`, `observed` | `POST /v1/agents/{id}/runs`; one active run per agent. |
| Cancel run | `documented`, `observed` | A request, not a guaranteed stop. A second cancel may return `409`; re-read the run. |
| Archive and unarchive | `documented`, `observed` | Idempotent list hygiene. Immediate readback reflects the state. Do not use archive as a capacity-control operation. |
| Delete agent | `documented` | Irreversible. Deletes the agent, transcript, and artifacts, not environment snapshots. |
| List and get agents | `contradicted` | Documentation describes thin list items; the 2026-08-22 live response returned the full agent shape. Schemas remain permissive. |
| List and get runs | `documented`, `observed` | Run status is the execution ledger. Terminal values currently handled are `FINISHED`, `ERROR`, `CANCELLED`, and `EXPIRED`. |
| Named-environment launch | `documented` | Select with `env.type = "cloud"` and `env.name`; explicit `repos` are omitted. This MCP enforces both environment and attached-repository allowlists on readback. |
| Repository launch | `documented`, `observed` | Explicit repositories may include `startingRef`. A reported branch name does not prove a push; only `prUrl` does. |
| No-repository launch | `documented` | Omit all target/source options, or pass `noRepository: true`. Launch-enabled profiles allow this by default; `allowNoRepository: false` opts out. The same policy covers lifecycle access across sessions; readback must show an empty repository list and no named/non-cloud environment. |
| Multi-repository launch | `documented` | Supports up to 20 explicit repositories; every repository is authorized before launch and the exact set is verified on readback. |
| Usage | `documented`, `observed` | Token usage is published. Live REST responses also returned optional cost. |
| Artifacts | `documented`, `observed` | Agent-scoped files written under the VM artifact directory. The REST API returns a short-lived download URL. |
| Run stream | `documented`, `observed` | Full-history replay plus tail. REST remains the terminal-state authority; see `streaming.md`. |
| Replay retention | `uncertain` | Capture replay early with `cursor_export_run`. A retention duration without an established epoch is not an expiration deadline; upstream retention is not guaranteed by this server. |

**Recovery and follow-up limits.** Read existing output promptly when a launch
fails; do not assume a quota error makes existing output unavailable or guarantees
that it remains readable. See the [recovery guide](reference.md#recovering-evidence-from-a-stopped-run).
The REST OpenAPI omits follow-up `model`, but the published
[`@cursor/sdk@1.0.31` cloud implementation](https://cdn.jsdelivr.net/npm/@cursor/sdk@1.0.31/dist/esm/642.js)
sends it on the same runs POST (`client-code-derived`). The MCP forwards explicit
selections and profile pins on follow-ups. Request acceptance alone is not proof
of the executed model; the SDK also echoes its client selection into run/result
model fields. Account-specific behavior must be validated before claiming it.

## Agent status

The published two-value `ACTIVE | ARCHIVED` enum does not cover the `IDLE`
value the adapter must also accept. Treat that enum as incomplete.

Parse agent status as an open string. Treat `IDLE` as agent/machine or follow-up
eligibility, never as successful run completion. Run status remains the execution
ledger, and `ARCHIVED` remains the archival state.

## Terminal access to Cloud Agent VMs

The optional [terminal tools](terminal.md) run commands and manage interactive
shells on existing Cursor-hosted Cloud Agent VMs. Command execution returns output
and structured exit status. Interactive sessions support input, control keys,
resizing, and explicit reconnection. Multiple VMs can be addressed independently.

Terminal operations connect to the VM without starting an agent run or requiring
Cursor IDE. They use the configured API key and explicit terminal/profile
permissions. Use terminal status to check access to the selected VM.

A stopped agent run does not necessarily mean its VM is unavailable. Use terminal
status to check access and explicit wake to request recovery when appropriate.
Wake does not start an agent run or guarantee that a machine or its processes
survived. Run status, API throttling, model usage limits, and VM availability are
separate conditions.

Output retention is bounded. Interactive sessions can reconnect within the same
MCP process, but restarting MCP discards its terminal handles and retained output.
For jobs that must outlive that process, use a caller-owned detached tmux session
and save output and exit status to VM files. Neither tmux nor VM-local files
guarantee survival after machine loss. See [terminal behavior and limitations](terminal.md)
for configuration, cleanup, output paging, and recovery details.

## Environment definitions

Authority is `repo-commit` for `.cursor/environment.json`, and
`browser-session` for saved personal/team environments.

Cursor documents three setup paths:

1. agent-led setup,
2. a saved snapshot,
3. `.cursor/environment.json`.

The documented resolution order is repository definition, personal saved
environment, then team saved environment. The repository definition wins when
present.

The environment schema reviewed on 2026-09-07 includes:

- `name`, `user`, `install`, and `start`;
- `repositoryDependencies`;
- `disableAllMcpServers` and `mcpServerAllowlist`;
- `ports` and `terminals`;
- `egressAllowlist` and `egressMode`;
- `chromeExecutablePath` and `enable_testing`;
- container `image`, and `build` with `dockerfile`, `dockerfileContents`, or both,
  plus optional `build.context`;
- `snapshot` and `agentCanUpdateSnapshot`.

The schema permits comments and rejects unknown properties. Paths are relative to
`.cursor`; `.`, `./`, and `..` refer to the repository root.

| Phase | Evidence | Contract |
|---|---|---|
| `install` | `documented` | Runs while preparing a Build. It must be idempotent and should perform expensive setup. |
| `start` | `documented` | Runs for each agent start. Use it for lightweight services and session preparation. |
| `terminals` | `documented` | Commands started for each agent in managed terminal sessions. |

The environment schema's older description of `install` as a VM-start command is
`contradicted` by the current Builds documentation. Implement against the Builds
phase model.

## Builds and snapshots

There are no documented `/v1/environments` or `/v1/builds` paths in the Cloud
Agents OpenAPI. The published API-key surface therefore cannot yet be treated as
the environment control plane.

| Capability | Documented surface | Evidence |
|---|---|---|
| Prepare a Build | Cursor service | `documented` |
| Recurring Build | Dashboard/environment schedule | `documented` |
| Configuration-change Build | Save environment or change relevant configuration | `documented` |
| Manual Build | Dashboard `Trigger build` | `documented`; browser-session owner action |
| Agent-requested draft Build | Cloud MCP | `documented`, `observed`; draft and non-activating by the tool's own contract |
| List Builds and logs | Dashboard and Cloud MCP | `documented`, `observed` for delegated-run; no `buildId` filter; published API-key surface unavailable |
| Skip unchanged recurring Build | Cursor service | `documented`, `observed` |
| Cancel in-progress Build | Dashboard | `documented`; absent from a live delegated tool census, and no published API-key or SDK authority. |
| Activate/deactivate Build | Dashboard | `documented`, `browser-session`; absent from the live tool census. Only Builds from every repository's default branch are promotable, and **delegated** Build rows expose no promotability flag, ref, or commit SHA |
| Start from a specific Build | Dashboard | `documented`; a per-run boot override, not environment-wide activation. API-key contract `uncertain` |
| Restore environment version | Dashboard | `documented`, `browser-session`; "Restore from version history to make a prior environment version active again". Absent from the live tool census |
| Configure base snapshot | Environment schema and setup UI | `documented`; this is an environment-definition input |
| Take/check snapshot operation | Cloud MCP | `documented`; check requires a snapshot-operation id, which a read-only inspection may not have |
| Save proposed install/start | Configured compatible Cursor CLI, or dashboard owner action | CLI database Save requires its own grant and configuration readback; Cloud MCP proposal is not persistence. Repository-file managed environments persist by `repo-commit` instead; see [the operation reference](./reference.md#tools) |

Builds preserve disk state, not running processes, shell exports, or in-memory
caches. A failed Build does not displace the last successful active Build.
Recurring Builds can be skipped when relevant inputs did not change; manual and
configuration-triggered Builds still run.

Build status has no published stable enum. The delegated read model observed
`IN_PROGRESS`, `SUCCEEDED`, `FAILED`, and `SKIPPED`; `CANCELLED` is accepted as
a list filter value even though no delegated operation can produce it. Preserve
unknown future strings. Skipping was encoded in `status`, not a separate
boolean, and a failure reason appears in `failureType`.

Build trigger, monitoring, log, and cancellation semantics are recorded in
[environment-build-operations.md](./environment-build-operations.md).

## Cloud MCP

Authority is `delegated-run`. Cursor documents environment and run diagnostics,
Build inspection and triggering, environment proposals, and snapshot operations.
Team administrators can disable the server, and visibility is scoped to the
current user's runs.

The delegated adapter handles the following environment-scoped tools:

- `environment.environmentPublicId` and
  `environment.environmentVersionPublicId`;
- current-run Build provenance at `environment-info.build.buildId`;
- Build-list fields including `buildId`, `environmentVersionId`, `source`,
  `triggerType`, `status`, `userFacingSnapshotId`, and `hasMore`;
- no fields named `active`, `latest`, or `currentRun`;
- no repository commit SHA in the Cloud MCP Build objects;
- Build logs as text rather than a stable structured log schema.

See [cloud-mcp-environment-read-model.md](./cloud-mcp-environment-read-model.md)
for the sanitized shapes and authority boundaries.

Important boundary: proposing environment JSON is not equivalent to saving a
personal/team environment. Cloud MCP tool names also do not establish reusable
host routes or API-key authentication.

Four things stay separate: a **proposal** records review state; a **Save** is an
persisted configuration change through a compatible CLI or the owner dashboard;
a **repository commit** is the
configuration of record for repository-file managed environments; and
`trigger-environment-build` with `environmentJson` records config durably on that
Build only, never on active settings. `environment-info.environmentJson` can be
withheld as owner-restricted, in which case saved configuration is not readable
by a delegated run at all.

A 2026-08-29 live tool census counted 14 advertised tools, adding
`get-message-queue` to the previously recorded inventory of 13. The census, not
the documentation page, is the authority for whether an operation is absent.

Current Cloud MCP coverage does not establish host-side Save, Build
activation/deactivation, Build cancellation, environment restore, or rollback.
Build cancellation is now absent from a live census, not merely undocumented.
The configured Cursor CLI supplies a separate, gated database Save path with
configuration readback. The other operations remain structured owner actions;
Cloud MCP coverage alone does not establish a host contract for them.

See
[environment-control-plane-contract.md](./environment-control-plane-contract.md)
for the per-action authority matrix, proposal-versus-persistence boundary, and
residual owner-action contract.

## Selected workspace and account controls

This MCP exposes those controls as one Workspace Controls surface
(`cursor_list_workspace_controls`, `cursor_inspect_workspace`,
`cursor_get_workspace_control`). Writes appear as catalog rows, never as a verb. Tool names stay
stable if an internal integration changes. Only the three API-key reads below are
`supported` operations; the rest return explicit `unverified`, `unsupported`, or
`unavailable-on-plan` results rather than guessed dashboard routes.

| Capability | Authority | Evidence |
|---|---|---|
| Current API-key identity | `api-key` | `GET /v1/me`, `documented`, `observed` |
| Models | `api-key` | `GET /v1/models`, `documented`, `observed` |
| Connected repositories | `api-key` | `GET /v1/repositories`, `documented`, `observed` |
| Default model/repository/base branch | `browser-session` | Dashboard-documented; programmatic contract `uncertain` |
| Network mode and allowlist | `browser-session`, `admin` | Dashboard-documented; programmatic contract `uncertain` |
| Secret names and classes | `browser-session`, `admin` | Dashboard-documented. Secret values are never an MCP read surface. |
| MCP policy | `browser-session`, `admin` | Dashboard-documented; programmatic contract `uncertain` |
| Team follow-up policy | `admin` | Separate team/admin surface |
| Slack integration and notifications | `browser-session`, `admin` | Out of the initial lifecycle implementation scope |

Self-hosted pools, workers, claims, billing administration, and Cursor Origin are
outside the current project scope.

## `@cursor/sdk` coverage

Registry pin on 2026-08-28:

- `latest`: `1.0.30`;
- `next`: `1.0.27-beta.0`;
- Node requirement: `>=22.13`.

At this pin, SDK documentation covers agent creation, follow-up, waiting, cancellation,
listing, retrieval, archive/unarchive/delete, named cloud environments, usage,
artifact listing/downloading, and run streaming.

Environment CRUD, version Save/Restore, Build listing/trigger/cancel/activate,
snapshot lifecycle, and rollback are not documented SDK capabilities at this pin.

This MCP uses its HTTP client for authentication, retries, timeouts, origin
checks, and schema validation. Artifact downloads are returned as presigned URLs.
The SDK is not a project dependency.

## Advisory refresh checklist

Upstream drift is reported; it does not block unrelated development.

1. Re-fetch the official sources above.
2. Diff OpenAPI paths, create-agent fields, status schemas, usage fields, and
   rate-limit documentation.
3. Run `npm view @cursor/sdk version engines dist.unpackedSize dist-tags --json`.
4. Re-check SDK coverage for usage, artifacts, stream, named environments, and
   any new environment/Build methods.
5. Re-fetch the environment schema and compare phase descriptions with the
   Builds documentation.
6. Re-check Cloud MCP tools and Build trigger/activation/restore documentation.
7. Reconcile changes with dated live evidence without overwriting the evidence.
8. Keep contradictions labeled until an authoritative source or bounded live
   probe resolves them.

Do not refresh by triggering Builds, saving environments, activating versions,
or inspecting secrets.
