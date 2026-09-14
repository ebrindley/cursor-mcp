# Technical reference

[Installation and first task](../README.md).

## Design

**One tool per Cursor capability.** Callers see Agent Lifecycle, Environment
Definition, Environment Operations, and Workspace Controls — not REST, SDK,
Cloud MCP, or dashboard boundaries. Atomic tools stay the contract. A bounded
in-process workflow may compose them; it stores nothing and does not replace
them. What Cursor can do, the tools do, including when the honest answer is a
structured owner-action residual.

**Terse tool descriptions.** Tool definitions sit in the client's context on every
request, and prose is the dominant cost there — measured at roughly 350 tokens per tool
for a chatty description against about 105 for a one-liner. Guidance lives here instead.

**stdio only.** No HTTP transport, so no port, no CORS surface, no unauthenticated
endpoint.

**A thin HTTP client.** The transport handles authentication, retries, timeouts,
origin checks, and parsing consistently across endpoints. Runtime dependencies
are `@modelcontextprotocol/sdk` and `zod`; `@cursor/sdk` is not a dependency. See
[cursor-capabilities.md](cursor-capabilities.md#cursorsdk-coverage) for dated SDK
coverage.

**Untrusted by default.** Everything Cursor returns passes through one envelope
(`src/untrusted.ts`) that labels its source, strips control and invisible characters, and
caps its size — and every tool returns through one builder (`src/tools/result.ts`) so
there is no second path. That includes error text and `structuredContent`, both of which
reach the model just as surely as the summary does. `maxResponseBytes` is one budget for
the whole structured payload, not a per-string limit, and a truncation is always reported
rather than silent. Required fields are emitted before optional free text, and sanitized
structured output is validated before it reaches the MCP SDK. This reduces
prompt-injection risk; it
does not eliminate it. Repository contents, PR text, and agent output are all written by
parties outside your control.

## Guardrails

The server enforces policy independently of client-specific approval hooks.

**The policy file — holds everywhere.** Operator-owned, read once at startup, never
writable by a tool. Default location `~/.config/cursor-mcp/policy.json`, overridable with
`CURSOR_MCP_POLICY`. See `policy.example.json`.

- `deleteEnabled` — permanent deletion is off unless you turn it on, *including* under
  `tools: ["*"]`. It is a second gate behind the allowlist, keyed on the tool's
  `destructiveHint` annotation rather than a name list, so `cursor_delete_agent` simply does
  not appear until you set it. Archive is reversible and is the normal path.
- `activationEnabled` — accepted for compatibility and reserved for a future
  promotion authority. It gates no current tool; setting it does not enable Build
  activation, deactivation, or rollback.
- `exportRoot` — an absolute directory where `cursor_export_run` may write. Absent is the
  normal state and means that tool is not registered at all, so no run replay can reach
  this filesystem; `CURSOR_MCP_EXPORT_ROOT` is the environment equivalent, and the policy
  field wins. It is not a second gate like `deleteEnabled` but the other half of one: the
  profile must also name the tool, because `read:*` is a grant to read Cursor and never a
  grant to write local files. A relative path is refused rather than resolved against
  whatever directory the host happened to launch the server in.
- `cursorCli` — an optional local Cursor CLI, used as a separate read authority for global
  environment discovery. Absent is the normal state and everything else keeps working
  without it. Present grants nothing on its own: `environmentReads`, `publishEnabled`,
  `databaseSaveEnabled`, and `deleteEnabled` are independent gates inside the block;
  `teamWritesEnabled` is an additional gate for team scope. The legacy
  `environmentWrites` field grants no operation.
  `path` must be absolute — a bare name would let whatever is first on your `PATH` answer as
  the Cursor CLI — and `compatibleVersions` is an explicit list of versions you checked,
  because the CLI's environment commands are not a published contract.
- Profile `model` optionally pins the supervisor for ordinary launches and internal
  environment delegates and follow-up runs. Accepts a model ID string or
  `{ "id": "...", "params": [{ "id": "...", "value": "..." }] }`.
  Conflicting per-call selections (including parameters) are refused before POST.
  An omitted pin leaves callers free to select a model. `modelRequested` records
  the sent choice, never verified model execution. Follow-up selection uses the
  REST field sent by the published Cursor SDK; see the capability evidence below.
- `profiles` — named sets of approved operations. Once a policy file exists, every call
  runs under a profile or it does not run; there is no ambient authority. A profile pins
  the repositories it may target, the named environments it may target, the tools it may
  invoke, and optionally `autoCreatePR`. Existing-agent reads and mutations use the same
  repository boundary; an agent spanning multiple repositories is permitted only when
  every repository is named by the profile. Selecting a named environment is a
  secrets-and-egress grant, not just VM routing.
- **An empty list permits nothing.** Widening is always
  explicit: `tools` accepts `"*"` for everything and `"read:*"` for every read-only tool,
  and is required rather than defaulted, so the operator states intent. `repos` accepts
  `"*"`, meaning any repository Cursor lets the API key use; `environmentAccess: "account"` permits environments available to the account.
  Without account access, `environments` is an explicit name list and an omitted
  list permits no named environments. Account access preserves declared identity pins.
- **`repos: ["*"]` makes Cursor's boundary the boundary.** Cursor already limits a launch
  to the repositories its GitHub installation grants, so when that installation covers a
  whole account an explicit list is a line drawn through your own repositories, and every
  repository connected after the file was written is silently unlaunchable until the file
  is edited and the server restarted. The wildcard grants repository scope to every
  operation the profile permits — launches, follow-ups, *and existing-agent reads*, which
  the repository boundary also governs and which no client hook confirms — for present and
  future repositories alike. Keep an explicit list when you want a narrower line than the
  installation's, and especially in a client with no confirmation step. References are
  still canonicalized under the wildcard, so a malformed or credentialed URL is refused as
  before, and the launch readback still requires the created agent's repositories to match
  the requested set.
- Each `environments` entry is either a bare name — the legacy form, still valid — or a
  binding `{ "name", "publicId", "scope", "repos" }`. `scope` is `personal` or `team`.
  `publicId` is the authoritative `environmentPublicId` declared out of band, so a call
  naming a different one is refused rather than trusted. A binding's `repos` *narrows* the
  profile's repository list for that environment and can never widen it; a repository the
  profile does not name stops startup. Under a `"*"` profile a binding without `repos`
  inherits the wildcard, a binding with `repos` is exactly that list, and `"*"` inside a
  binding's own `repos` stops startup.
- Enforcement is at **registration**: a tool the active profile does not permit is never
  registered, so it never appears in `tools/list` and cannot be called. It also costs the
  client no context.
- Fail-closed: no policy file at the default location means read-only. A configured policy
  path that is missing, a present policy without `defaultProfile`, or any invalid policy
  stops startup, so a typo can never quietly widen authority. A profile that permits *no*
  tools also stops
  startup — serving an empty tool list makes a client report the server as broken, so it is
  treated as the misconfiguration it is.

There is deliberately no cap on concurrent agents. One was specified and removed: the
server keeps no durable state, Cursor cannot attribute an existing agent to a profile, and
the field would have looked like a control while enforcing nothing. The only state held at
all is in-process: the agent allowlist cache and the resume handles for delegated
environment reads, both of which a restart discards (a stale resume handle is refused, not
guessed at).

**Optional client hooks.** An operator may separately configure a Claude Code
`PreToolUse` hook to ask before mutating `cursor_*` calls. This repository does not
install that hook. Server policy remains the permission boundary across clients.

`cursor_create_agent` always sends a client `agentId` and echoes it as `requestedAgentId`.
Cursor documents that replaying the same id returns `409 agent_id_conflict` instead of a
second agent — so pass your own `bc-<uuid>` whenever the call might be retried, and reuse it
on the retry. An id minted for you when you omit one is new on every call and protects
nothing across retries. `agentIdHonored: false` means Cursor did not use the id you sent, so
even a replay of that id would not be refused as a duplicate. A repository entry may carry `prUrl` to work on an existing pull request; it must be
a GitHub PR on that same repository, and it excludes `startingRef`, which Cursor would
ignore. `cursor_create_agent` intentionally exposes no `envVars`, inline MCP-server
configuration, or provider credential fields. Credential-bearing VM bootstrap is a privileged host-side
operation, not a model-facing MCP argument. Use this server for ordinary launches and for
run lifecycle, usage, and artifact operations after a privileged launcher has created an
agent. Legacy empty `allowedEnvVars` and `allowedMcpServers` arrays are accepted and ignored
so an older policy file still starts; remove those keys when next editing the file. Non-empty
values are rejected because no corresponding control exists.

Launches accept one `repo`, up to 20 `repos`, or one named `environment`; those target
forms are mutually exclusive. With all target/source options absent, a launch-enabled
profile permits a no-repository VM unless `allowNoRepository: false` denies it. Named environments must
be listed under `profiles.*.environments`, and every repository Cursor reports attaching
must also be listed under `profiles.*.repos`. Create results report the exact environment,
repository set, and starting refs Cursor returned. `targetVerified`, `sourcePinned`, and
`metadataVerified` distinguish readback proof from a requested option.

## Configuration

| Variable | Purpose |
|---|---|
| `CURSOR_API_KEY` | Required. Create one at <https://cursor.com/dashboard/api>. |
| `CURSOR_MCP_POLICY` | Optional path to the policy file. If set, the file must exist. |
| `CURSOR_MCP_LOG_LEVEL` | `debug`, `info` (default), `warn`, `error`. Always stderr. |
| `CURSOR_MCP_EXPORT_ROOT` | Optional absolute directory for `cursor_export_run`. Unset, or relative, and that tool is not registered. `exportRoot` in the policy file wins. |

The key is read from the environment only. Keychain retrieval would require a subprocess,
which this server does not do.

## Tools

| Tool | Endpoint | Write? |
|---|---|---|
| `cursor_whoami` | `GET /v1/me` | |
| `cursor_list_models` | `GET /v1/models` | |
| `cursor_list_repos` | `GET /v1/repositories` | |
| `cursor_list_workspace_controls` | catalog | |
| `cursor_inspect_workspace` | `GET /v1/me` plus catalog | |
| `cursor_get_workspace_control` | live API-key read, or a capability result | |
| `cursor_list_agents` | `GET /v1/agents`, optionally filtered by `prUrl`, plus one `GET /v1/agents/{id}` per listed summary too thin to check against the policy | |
| `cursor_get_agent` | `GET /v1/agents/{id}` | |
| `cursor_list_runs` | `GET /v1/agents/{id}/runs` | |
| `cursor_get_run` | `GET /v1/agents/{id}/runs/{runId}` | |
| `cursor_wait_run` | `GET /v1/agents/{id}/runs/{runId}`, polled until terminal or 45 s | |
| `cursor_inspect_runs` | one `GET /v1/agents/{id}/runs/{runId}` per distinct requested pair, sequentially, plus one `GET /v1/agents/{id}` per distinct agent when a profile is active; bounded at 45 s | |
| `cursor_tail_run` | `GET /v1/agents/{id}/runs/{runId}/stream`, bounded excerpt; status verified over REST | |
| `cursor_export_run` | `GET /v1/agents/{id}/runs/{runId}` then `.../stream`, whole replay to disk | yes, writes local files; needs a configured export root |
| `cursor_get_usage` | `GET /v1/agents/{id}/usage` | |
| `cursor_list_artifacts` | `GET /v1/agents/{id}/artifacts` | |
| `cursor_get_artifact_url` | `GET /v1/agents/{id}/artifacts/download` | |
| `cursor_create_agent` | `POST /v1/agents` | yes |
| `cursor_create_run` | `POST /v1/agents/{id}/runs` | yes |
| `cursor_cancel_run` | `POST /v1/agents/{id}/runs/{runId}/cancel` | yes |
| `cursor_archive_agent` | `POST /v1/agents/{id}/archive` | yes |
| `cursor_unarchive_agent` | `POST /v1/agents/{id}/unarchive` | yes |
| `cursor_delete_agent` | `DELETE /v1/agents/{id}` | yes, needs `deleteEnabled` and `confirm: true` |
| `cursor_validate_environment_definition` | local `.cursor/environment.json` or supplied text | |
| `cursor_inspect_environment_definition` | local `.cursor/environment.json` or supplied text | |
| `cursor_diff_environment_definition` | local `.cursor/environment.json` or supplied text | |
| `cursor_list_environments` | configured Cursor CLI, or an availability result | |
| `cursor_get_environment_configuration` | configured Cursor CLI, or an availability result | |
| `cursor_publish_environment` | configured Cursor CLI | yes, creates one pull request after preview and confirmation |
| `cursor_inspect_environment` | delegated run in the named environment | yes, it launches one |
| `cursor_list_builds` | delegated run in the named environment | yes, it launches one |
| `cursor_get_build` | delegated run in the named environment | yes, it launches one |
| `cursor_get_build_logs` | delegated run in the named environment | yes, it launches one; the log body is off unless `includeText: true` |
| `cursor_trigger_build` | delegated run in the named environment | yes, one draft Build, needs `confirm: true` |
| `cursor_list_owner_actions` | local catalog | no; the exact owner action for Build cancel, activate, deactivate, rollback, Restore, and host-wide trigger |
| `cursor_qualify_environment` | delegated run in the named environment | yes, it launches one |
| `cursor_save_environment` | configured Cursor CLI, owner action, or `repo-commit` | yes for a confirmed CLI database Save; otherwise returns or verifies `SAVE_ENVIRONMENT` |
| `cursor_delete_environment` | configured Cursor CLI | yes, permanently deletes after dry-run, confirmation, and fresh internal-id resolution; needs both delete gates |
| `cursor_run_environment_lifecycle` | local plan and owner-action judgments | no; the full lifecycle is planning-only, and cancel / rollback return guidance rather than performing the operation |
| `cursor_assess_environment_health` | readback you already hold | no, it launches nothing |
| `cursor_refresh_environment_toolchain` | delegated run in the named environment | yes, one draft Build, and only on established toolchain drift |

**Workspace Controls are one catalog, not a dashboard mirror.** Identity, models, and
connected repositories have published API-key reads. Default model/repository, base branch,
PR defaults, network policy, secret *names*, MCP policy, and team follow-up stay
addressable: reads return `unverified` until a non-browser contract exists, writes return
`unsupported` after the existing tool allowlist and `confirm: true`, and a live
`plan_required` / `feature_unavailable` / `role_forbidden` is `unavailable-on-plan`. Secret
values are never accepted, returned, or logged. Slack, Origin, billing, and self-hosted
fleets are not in the catalog.

**The three environment-definition tools never call Cursor.** They parse JSONC (comments
allowed, trailing commas not), validate the environment contract reviewed on
2026-09-07 against [Cursor's published schema](https://cursor.com/schemas/environment.schema.json), and
report schema errors, safety warnings, and capability limitations as three separate lists.
Only `.cursor/environment.json` in the server's current workspace is read, the file is never
created, and nothing is saved: persisting a definition is an owner Save on a database-managed
environment or a commit of that file on a repository-file managed one. `install`, `start`,
terminal commands, inline Dockerfiles, image references, egress allowlists, browser paths,
and MCP patterns are reported as digests rather than text, because a
definition can carry an inline credential even though the schema has no secret field.

The schema is checked locally; it is not downloaded at runtime. Tests use original
behavioral examples, so future upstream additions may require an update here.

**The two catalog reads use a local Cursor CLI, and say so when they cannot.** There is no
`/v1/environments`, and a delegated run only knows the one environment it is already inside,
so listing environments and reading one environment's configuration are answered by the
optional CLI configured under `cursorCli`. Both tools are registered whether or not a CLI
exists: without one you get `CLI_NOT_CONFIGURED`, and otherwise `CLI_READS_DISABLED`,
`CLI_MISSING`, `CLI_INCOMPATIBLE`, `CLI_FEATURE_GATED`, `CLI_AUTH_REQUIRED`, or
`CLI_IDENTITY_MISMATCH`, each with the version and contract fingerprint actually observed.
Neither ever falls back to a delegated run — that would spend quota and quietly change which
authority answered, so `cursor_inspect_environment` stays the explicit way to ask a delegate.
The child process gets no shell, no stdin, a controlled working directory, a rebuilt
environment that never carries `CURSOR_API_KEY`, a byte ceiling, and a timeout that reaps
descendants. Because the CLI authenticates as whoever logged it in rather than as this
server's key, its effective identity is verified against `GET /v1/me` first, and an
unverifiable one stops the read. Registration is proven from `--help` before any command is
issued: the CLI's root argument is an agent prompt, so a build that advertises no commands is
reported `FEATURE_GATED` rather than handed `env list` to run as a prompt. Internal numeric
ids stay provider-private, and configuration is reported as candidates with a source,
precedence, a normalized digest, and a `matched` / `different` / `unreadable` classification —
never as script text.

**The three CLI environment writes are independently gated.** Publication accepts only an
exactly bound personal, single-repository environment and returns
`PULL_REQUEST_CREATED`, never a persistence receipt. Database Save binds confirmation to
the intended digest and an immediate pre-read, then requires exact post-read agreement; it
reports that this is a client precheck because the CLI exposes no server compare-and-swap.
Deletion resolves the provider's internal numeric id from a fresh list, validates the CLI
dry-run, binds confirmation to that identity, dispatches once, and proves absence only from
a complete lossless post-list. No write retries or falls back after dispatch: an ambiguous
result is `STATE_UNKNOWN`. Team writes need `teamWritesEnabled`, and the compound
delete-personal-on-team-write option is never exposed.

**Seven environment operations run inside a delegated agent, and that is not free.**
Cursor's environment and Build control plane is only reachable from a run attached to the
environment, so each of these tools launches one credential-free agent there, gives it one
scripted mission, and reads back one structured document. That launch is a
secrets-and-egress grant: the environment must be listed under `profiles.*.environments`,
every repository Cursor reports attaching must be listed under `profiles.*.repos`, and a
profile that pins `autoCreatePR: true` refuses delegation outright. None of those seven is
annotated read-only, so `read:*` grants none of them. Builds take minutes, so a call does
not block: it returns `DELEGATION_PENDING` with a `resume` handle you pass back, and nothing
is remembered for you between those calls beyond an in-process resume handle. Build
logs come back without their body unless you pass `includeText: true`: install scripts
print what they print, tokens included. `cursor_trigger_build` needs `confirm: true`; it
is the one write on this surface without an idempotency key. The operations no supported
authority performs — Build cancellation, activation, deactivation, rollback, and
environment-version Restore — are not verbs. `cursor_list_owner_actions` returns each one
as a row naming the exact owner action and the readback that would prove it, with any ids
you pass filled in, and launches nothing. Everything a delegate says is labeled
`delegated-untrusted` and leaves through the same fence as any other Cursor text.

**Save is a tool; Restore, activate, deactivate, and roll back are catalog rows.**
No published API-key, SDK, or delegated operation persists Install/Start or promotes a
Build. `cursor_save_environment` is the one with a real path: through a configured Cursor
CLI it performs a database-managed Save, and for a repository-file managed environment it
reports the default-branch commit of that file to make (this server does not write your
repository), stopping rather than guessing when `environmentJsonPath` is unknown. The
others each return a row from `cursor_list_owner_actions` with the exact owner action and
the exact readback that would prove it — never a silent no-op and never a fake success —
and they were deliberately removed as callable verbs, because a verb that can only ever
answer "do it in the dashboard" costs a tool slot and, worse, invited a paid delegated
read first. The rows keep the distinctions the verbs enforced: deactivation names no
replacement, so it is not the inverse of activation, and Restore is never offered as an
equivalent to Build rollback, because it changes saved Install/Start and may mint a *new*
Build id. `activationEnabled` is still accepted in the policy file and gates nothing today;
it is reserved for a promotion authority that has not appeared. Pass `verify` to
`cursor_save_environment` to judge a Save an owner performed: a configuration-change Build
is adopted only when it is the sole candidate in an attested exclusive change window,
absent from the recorded Build and numeric-version baselines, and a version comparison
counts only from a freshly booted run. The saved document itself stays owner-restricted, so
persistence is never reported as a content match.

**A successful Build is not the active Build.** No supported authority exposes an
authoritative active-Build read, so `activeBuild` is always `{ readable: false }` with the
reason attached — never omitted, because absence would read as "none active".
`environment-info.build.buildId` is the Build the delegate's own pod booted from, and
`userFacingSnapshotId` is set on failed Builds too, so neither proves anything about
activation. `cursor_trigger_build` produces a *draft* Build, which by Cursor's own contract
never becomes the Build new agents boot from; ask for `kind: "manual"` and you get a
`TRIGGER_BUILD` owner action instead of a fake one. `SKIPPED` is terminal, informative, and
neither a failure nor a licence to trigger again — there is no idempotency key on the
trigger, so this server never retries it and never fires a second Build to resolve an
unknown outcome. Build cancellation is a `CANCEL_BUILD` row in
`cursor_list_owner_actions`: cancelling a *run* is a different resource and is not offered
as a substitute.

**Qualification is three answers, not one.** The prepared Build disk, the Start script's
execution, and the actual task shell are reported separately, with the divergences between
them named. An empty Start-execution record is `indeterminate`, never `failed`. Declared
expectations are command names and environment-variable *names*; a value is never requested
and never reported. `expect.toolchain` is the one exception, and it is deliberate: it names
command names whose installed *version* should be recorded, because a version string is not
a credential and is the only evidence of toolchain drift this surface has. Versions are
recorded, never judged — no layer verdict is derived from one.

**"Stale" is three questions, and Cursor's recurring Build answers only part of one.**
`cursor_assess_environment_health` judges Build health, source freshness, and toolchain drift
separately from readback you already hold: it launches nothing, makes no API call, is granted
by `read:*`, and returns a stable `exitCode` (0 healthy, 10 toolchain, 11 source, 20 Builds
failing, 30 indeterminate — never 1, so a scheduler can tell staleness from a check that did
not run). Cron, launchd, or a CI schedule consumes that directly; no scheduler, lock, or
stateful service is added here, and two consecutive checks of an unchanged environment are
byte-identical no-ops. A `SKIPPED` recurring row is that schedule finding nothing to rebuild,
so it never lowers the verdict; a `CONFIG_CHANGE` row is reported as an unconsumed
configuration change and *not* attributed to the definition, because a secrets change emits
one too; and installed-version drift is invisible to Cursor entirely, since whether a fresh
Install produces a newer compiler is a property of your definition and of upstream. Versions
are compared as strings after trimming one leading `v`, so drift never claims which side is
newer. `cursor_refresh_environment_toolchain` re-runs that judgement and spends **exactly one
draft Build**, only when drift is established and you pass `confirm: true` — an unchanged
environment, a failing pipeline, an unsaved definition change, and incomplete evidence each
dispatch nothing and say why before a VM exists. Because the Build is a draft, a refresh
proves what a fresh Install produces and does not deliver it: activation stays an owner
action. A response proving `isDraft=true` establishes only that the refresh does not
become the Build new agents boot from; active state itself remains unreadable.
`docs/environment-freshness.md` records the whole contract.

**The lifecycle tool plans and returns owner guidance.**
`cursor_run_environment_lifecycle` describes the inspect → validate → synchronize →
build → monitor → qualify → activate → verify sequence; it does not execute that
sequence with the supported integrations. Definition, Build, and warm-launch inputs
describe the plan. Atomic tools remain independently usable.

A confirmed `lifecycle` intent returns
`PLANNING_ONLY` with `executed: false`, decided before any mutation, because no supported
authority can boot a run from a Build this composition just triggered — confirming again
changes nothing. The `cancel` and `rollback` intents launch no delegated run at all: their
results are local judgments: invalid input or ineligible Build evidence is refused,
otherwise the result identifies the owner action still required. No Build is cancelled
or rolled back. The retained `executed` field can be true when such a local judgment
runs; it does not mean an upstream mutation completed. Step status and owner-action
details describe the outcome.

**An agent's `status` is not execution state.** Observed values include `ACTIVE`, `IDLE`,
and `ARCHIVED`; the field is parsed as an open string. `IDLE` is follow-up eligibility,
not a successful run. "Is my work done?" is a question about a *run*: read `latestRunId`
from the agent, then `cursor_wait_run`, which polls until the run is terminal or a bound
well under the client's request timeout (default 30 s, maximum 45 s) and reports
`timedOut: true` when it stops early — call it again with the same ids rather than
launching again. `cursor_get_run` is the single-shot form. Every run carries a `terminal`
boolean so a caller does not have to know the status enum, and an unrecognised future
status reads as non-terminal rather than failing the response. The agent's final reply is
in the fenced text block only; `structuredContent` carries `resultBytes`, never the reply
itself, so hosts that read structured output do not receive a second, unfenced copy of
third-party text. Branch metadata is agent-level state; only a `prUrl` proves that a run
pushed work to the remote.

**Archive is list hygiene.** Do not use it as a capacity-control operation.
Agents can accumulate and make lists difficult to navigate. Archive the
finished ones and pass `includeArchived: false` to hide them. Cursor's own default is
`true`, and this server does not override it.

**`cursor_list_agents` takes an optional `prUrl` filter.** Cursor documents it as "Filter
agents by GitHub pull request URL" (rechecked
2026-09-09, [list agents](https://cursor.com/docs/cloud-agent/api/endpoints#list-agents)), so
a pull request link is enough to find the agent behind it. The value must be
`https://github.com/<owner>/<name>/pull/<number>` with no credentials, query, or fragment —
the same shape rule launches use — and it is forwarded per call: continuing with `nextCursor`
means repeating `prUrl` yourself, because the server keeps no filter state between calls. The
filter narrows Cursor's answer, not the policy: an agent outside the active profile is still
hidden, and an unresolvable summary is still counted as unchecked. A filtered page reports
that the filter applied, and an empty one says so without claiming no agent ever touched that
pull request — Cursor decides what matches, pages may remain, and hidden items are not
counted.

**`cursor_inspect_runs` reads many runs you already hold ids for.** Monitoring a campaign
of dozens of agents through `cursor_get_run` alone means dozens of MCP round trips and
assembling the answers by hand. This tool takes up to 64 explicit `{agentId, runId}` pairs
and answers them in your order, at your indices. It removes round trips, not upstream
requests: each distinct pair is still one `GET`, run sequentially. It is a batch read and
nothing more — no scheduler, no stored campaign, no summary product, and no transcript. It
takes exact pairs only: it will not resolve an agent's latest run for you, so a recorded run
can never be silently replaced by a newer one. Repeats are read once upstream and reported
at every index you gave them.

Per item you get `outcome` and, except on a plain read, a stable machine `code`:
`read`, `denied` (`POLICY_DENIED`), `unresolved` (`SCOPE_UNRESOLVED`, or
`SCOPE_LOOKUP_FAILED` when the agent record could not be read), `error` (`HTTP_ERROR` with
`httpStatus`, `TRANSPORT_ERROR`, `CONTRACT_ERROR`, `IDENTITY_MISMATCH`, `TOOL_ERROR`) and
`notAttempted` (`NOT_ATTEMPTED`). Where `cursor_get_run` refuses the whole call for an agent
it cannot admit, a batch reports that item and keeps going: one undecidable agent among 64
must not hide the other 63. `unresolved` is the explicit statement that the profile question
was not answered — it is not a refusal, and it is not evidence the agent is out of scope.
Scope is not weakened for the batch: one fresh `AgentScope.resolve` per distinct agent, and
a run is never read for an agent that came back denied or unresolved. Cursor's own words
about a failure appear in the fenced text, never in a structured field.

A read item carries `status`, `terminal`, `durationMs` and `prUrls`. `prUrls` comes from the
run response's `git.branches[].prUrl`: agent-level git state Cursor reports alongside that
run, not proof this run opened the PR. Its absence is not proof no PR exists. The requested
`repos[].prUrl` — the PR a launch asked to work on — is deliberately never reported here.
An item too wide for the remaining budget to carry whole is reported with `compact: true`
and without its PR list, rather than silently as a run that reported no PR — and only when
dropping those parts is genuinely smaller, since on an item that had neither, `compact`
would be a field added and nothing removed. `status` is echoed capped at 32 bytes, which is
what lets the budget below be reserved before a read rather than after it.

Two bounds end a batch early, and both say so. One wall clock of 45 s covers scope
resolution and every read, from the same combined deadline and caller-cancellation signal
the other run tools use; retries and `Retry-After` stay the client's, with no second layer
on top. And the response budget is reserved before any item is admitted, so `summary` and
continuation can never be the fields that go missing: nothing is added that
`policy.maxResponseBytes` has not already covered, structured entry and text line together.
When either bound stops the batch, `complete` is `false`, `stoppedBy` names which one, and
`remaining` gives `{fromIndex, count, indices}` over *your* list — call again with the same
`runs` and that `fromIndex`. Successful reads are not repeated: the budget for an item's
compact form is reserved *before* its `GET`, so the batch stops one index early rather than
spending a request whose answer this response cannot carry and the next call has to buy
again. `complete` is never `true` while a requested index is undecided. At the 1024-byte
policy minimum a batch still returns a valid partial answer plus its continuation; with ids
long enough that not even one *decided* item fits alongside the summary, it refuses before
making any request, naming `maxResponseBytes` — a budget that could hold only
`notAttempted` lines is refused rather than spent, because reading 64 runs and reporting
none of them is a call that can only be made again.

`read:*` includes it. An explicit tool list must name `cursor_inspect_runs` for it to be
registered at all — the quickstart policy does not, so add it there when you start
monitoring campaigns.

**`cursor_get_usage` reports cost, not just tokens.** Alongside the REST-documented token
counts, the endpoint returns a `cost` object omitted from the REST OpenAPI and endpoint
field list, though current SDK documentation models it. `rawCostCents` and
`chargedCents` are surfaced per run and in total. `detail: true` includes token components. It is reported when present and omitted when absent — never defaulted to zero,
because "this cost nothing" is the one wrong answer about money.

**Artifacts are not your code changes.** Code lands on the run's branch or PR.
`artifacts/` holds what the agent deliberately wrote there — a saved diff, a log, a
screenshot. Download is two steps, matching the API: `cursor_get_artifact_url` returns a
15-minute presigned URL and stops. This server does not fetch the bytes, because that would
mean a second transport path to a different origin, and the client refuses off-origin
requests precisely so the `Authorization` header cannot follow an API-supplied URL
elsewhere. **That URL is itself a bearer credential for the object** — do not pass it to a
third-party fetcher and do not paste it anywhere durable.

**Bounded activity is optional.** `cursor_tail_run` reads an excerpt and returns a
resume cursor, with REST status checked separately. It consumes at most 1 MiB of
stream input and 200 events per call, with bounded text and a 45-second total
ceiling. Partial reads can replay their final event-ID group to avoid skipping
unread events sharing that ID. Use `cursor_get_run` for the final reply and PR
metadata. This is not continuous UI streaming or a lossless log. A client that
supplies a progress token also receives counter notifications from `cursor_tail_run`
and `cursor_wait_run` while they read — this server's own poll, event, byte, and
elapsed-time counts, never Cursor's text, with no total and no percentage; see
[progress notifications](streaming.md#progress-notifications) for the cadence and
the one client version whose handling was checked — a token arriving and
notifications being consumed without disturbing the read, which is not a promise
that any client displays them.
See [the activity guide](streaming.md) for timeout, truncation, resumption, and
expired-stream behavior. Explicit quickstart profiles must add `cursor_tail_run`;
`read:*` profiles already permit it. Cancelling the tool call stops monitoring;
`cursor_cancel_run` is the separate operation that requests cloud cancellation.

**The whole replay is a separate tool, and it writes to disk.** `cursor_export_run`
takes one terminal run and writes every byte of its SSE replay to
`<root>/<agentId>/<runId>.sse`, plus a tool-call index and a terminal log beside it.
A bounded excerpt cannot preserve a whole replay, and upstream retention is not a
durability guarantee. Nothing it captures reaches the model; the response contains
totals and paths only.
Because it is the one tool that creates files on the host, it takes **two** operator
acts and `read:*` does not include it: the active profile must name
`cursor_export_run` (or be `"*"`), *and* an absolute export root must be configured
via `exportRoot` in the policy file or `CURSOR_MCP_EXPORT_ROOT`. Without a root the
tool is not registered at all. It refuses a non-terminal run, refuses when an export
or an earlier partial capture already exists rather than replacing or appending to
one, and publishes the raw file only when the bytes arrived through `done`. A second
export queues behind the one that is streaming to bound API pressure, and a fifth
waiter is refused. See
[the export contract](run-export.md) for the byte boundary, the collision rules, and
what "complete" does and does not claim.

### Recovering evidence from a stopped run

A run that has finished, errored, been cancelled, or expired leaves evidence in
several places, and they decay at different rates. Work down this list; each step
names the endpoint it uses, and says whether a tool here calls it.

Capture promptly; retention and continued upstream availability are not guarantees.

1. **The recorded stream, first — it is the only complete record, and the only one
   with a clock on it.** `GET /v1/agents/{id}/runs/{runId}/stream` replays the whole
   run, including earlier events. A retention duration without a known epoch is
   not an expiration deadline. Capture early instead of assuming a recovery window.
   - `cursor_export_run` writes the whole replay to disk, when an operator has
     granted the tool and configured an export root. This is the step that preserves
     evidence past retention.
   - `cursor_tail_run` reads a **bounded excerpt** — at most 1 MiB and 200 events per
     call — and is not an archive. An excerpt is a sample, not a copy of a long run. It may replay events you
     have already seen (ids repeat and cannot deduplicate), and a single event or
     ID group larger than its budget can stop the cursor advancing. **If the cursor
     does not advance, stop repeating the call** — nothing changes — and use
     `cursor_export_run`, `cursor_get_run`, or Cursor's own UI instead. Chaining tail
     calls is not a recovery procedure and will not reconstruct a long run.
   - `done` means the stream ended. It is not proof the run succeeded and not proof
     Cursor delivered everything: delivery is documented as best-effort and a dropped
     event is never redelivered. `cursor_export_run` reporting `complete` means the
     bytes it received arrived through `done` under the contract in
     [`run-export.md`](run-export.md) — the same limit, stated precisely.
2. **Artifacts.** `cursor_list_artifacts` (`GET /v1/agents/{id}/artifacts`) and
   `cursor_get_artifact_url` (`GET /v1/agents/{id}/artifacts/download`). These hold
   only what the agent deliberately wrote to the artifact directory. Artifacts are
   agent-scoped, not run-scoped: an `updatedAt` close to a run is a **heuristic for
   which run produced a file, not proof of it**, and it is no evidence at all that
   the file corresponds to a push or a branch.
3. **The legacy conversation route, if the stream has expired.**
   `GET /v0/agents/{id}/conversation` returned user and assistant text only — no tool
   calls, no terminal output — and v1 has no equivalent. **There is no MCP tool here
   for it**, and this repository bundles no recovery script: call it yourself, with
   your own API key, if you decide you need it. Treat it as a last resort whose shape
   is a v0 surface Cursor may withdraw.
4. **Run detail and usage.** `cursor_get_run` (`GET /v1/agents/{id}/runs/{runId}`) is
   the authority for terminal status, and for the final reply and branch/PR metadata;
   a branch name is not a push, only `prUrl` is. `cursor_get_usage`
   (`GET /v1/agents/{id}/usage`) gives tokens and, when present, cost.
   `cursor_get_run` displays a returned `result` whatever the status. An absent
   result means Cursor sent none, not that the tool withheld it.

Quota exhaustion is a reason to stop launching and attempt to collect existing
evidence promptly; it does not guarantee continued read access.

**VM-only data needs a reachable machine.** Uncommitted files, scratch directories,
and output saved only on VM disk are not reconstructed by run-stream reads. When
the original machine remains reachable, the optional [direct terminal tools](terminal.md)
can inspect those files even after a run stops, without a further agent prompt or
running IDE. See [terminal access to Cloud Agent VMs](cursor-capabilities.md#terminal-access-to-cloud-agent-vms).
An existing agent record does not guarantee an accessible machine or surviving
files. Collect required results while access works; neither terminal access nor
VM-local logs guarantee recovery after machine loss. MCP restart also discards
local terminal handles and retained output; it does not adopt prior PTYs. Dropped
run-stream events cannot be reconstructed from VM access unless their contents
were independently saved there.

Out of scope: self-hosted fleet management (pools, workers, claim, worker tokens), which
needs a service-account key and a different operator model; and webhooks, which remain
v0-only until Cursor ships them on v1.

## Development

Use Node.js 24 LTS for source builds. The built server requires Node.js 20.3 or
later; the locked development and test tooling requires Node.js 20.19+, 22.12+,
or 24+.

```bash
npm ci
npm run typecheck
npm test
npm run build
```

`npm run smoke` and `npm run smoke:write` are maintainer live-API checks, not source
installation steps. Both need a real key; the write tier targets the maintainer's
repository and starts paid Cloud Agent work. Use the credential-free checks above
for source validation.

The unit tests use fake transports and need no credentials. Live smoke checks are
separate opt-in maintainer operations; they are not part of snapshot validation.

## Version

The server reports one version string in the MCP `initialize` handshake and from
`dist/bin.js --version`, which answers with no key and no policy file:

```
0.2.0+g0123456789ab
```

The base is `package.json`'s `version`, the authoritative source (the lockfile mirrors it);
`src/version.ts` reads it relative to itself, so the same code answers from `src/` and from a built release. The
build metadata is the commit the release was built from, stamped by `npm run build` into
`dist/build-info.json` when `CURSOR_MCP_RELEASE_SHA` is set to the
commit being packaged (see [package preparation](#preparing-a-package)). A build without it reports `+unknown`, so a working-tree build or an
older installer is never mistaken for a specific commit. Build metadata identifies the source commit; it does not order releases.

The version moves only when the client-visible contract does. A tool added, removed, or
renamed, an input or output schema change, or a change to the policy file's schema or gate
semantics bumps the minor version; a behavior fix with no contract change bumps the patch;
docs, tests, and refactors bump nothing. The bump lands in the same commit as the change, so
a machine tracking the branch tip never runs a mislabeled build. Published release tags
use `v0.x.y`, with release notes describing incompatible changes and policy updates.

### No-repository VMs by default

In a profile permitting `cursor_create_agent` (including `tools: ["*"]`), call
`cursor_create_agent` with just a prompt to start a repository-free VM. You can
also pass `noRepository: true` explicitly. Both omit `repos` and `env` from the
API request. Inference applies only when every repository, environment, and source
option is absent. Empty, invalid, denied, or conflicting target options still fail;
they never fall back to a plain VM. `noRepository: false` requires a target.
Model pins and caller-supplied agent IDs retain their existing behavior.

`allowNoRepository` remains an optional profile override: `false` denies these
launches and lifecycle access; `true` explicitly permits no-repository access.
It never grants tools that the profile does not permit. When omitted, profiles
without the create tool retain their previous access. `repos: []` permits no
repository targets but does not disable repository-free VMs; `repos: ["*"]`
permits any repository the Cursor account can access without naming each one.
Named environments still require their own allowlist entries.

Repository launches may select a saved repository environment. Named-environment
launches select that environment explicitly. No-repository mode requests neither;
it does **not** establish a clean filesystem. Inspect the VM before claiming clean
installation evidence. Returned metadata is reported, and unexpected attached
repositories or named environments cause the initial run to be cancelled.

The same policy permits reads, follow-ups, artifacts, and cancellation for
repository-free agents across MCP sessions, subject to each tool's permission.
It requires fresh metadata with an explicit empty repository list and no named
or non-cloud environment. Missing metadata still fails closed.

Migration in 0.3.0: launch-enabled profiles with the setting omitted now gain
no-repository access, including existing agents created elsewhere on the account.
Set `allowNoRepository: false` to retain a repository/environment-only profile.
The VM may receive runtime secrets and network access; this permission is not a
secret-free or egress boundary. The former session-local restriction caused
authorized repository-free runs to become inaccessible after a restart. Replacing it
with the existing profile decision preserves tool permissions, explicit target
allowlists, target readback and the separate deletion gate.

## Preparing a package

Use a clean checkout at the commit you intend to distribute, with Node 24 LTS.
Build with that commit's identity, then pack the built files locally:

```bash
npm ci
CURSOR_MCP_RELEASE_SHA="$(git rev-parse HEAD)" npm run build
npm run check:bin
npm pack --ignore-scripts --pack-destination /absolute/path/artifacts
```

`npm pack` does not publish. Test installation of the resulting tarball in an
empty directory and verify `cursor-mcp --version`, `--help`, setup, and offline
doctor there. Keep source-build (`+unknown`) and stamped-release identities distinct.
Use the source commit identity when building a public package. Publishing remains
a separate owner action. Use npm provenance from a supported release runner when
publishing; no automatic publishing workflow is installed here.

### Installing a package artifact

For a downloaded tarball, install it at a stable location:

```bash
npm install --prefix /absolute/path/cursor-install /absolute/path/cursor-mcp.tgz
```

Register `/absolute/path/cursor-install/node_modules/.bin/cursor-mcp` with your
client. Use its `setup`, `doctor`, and `--version` commands as in the
[quickstart](../README.md#quickstart).

The npm package is not published yet. Once published, clients can use `npx -y`
with `@ebrindley/cursor-mcp` pinned to a published version instead of a source
checkout. Verify that the version exists before registering it.


### Model parameters and usage detail (0.7)

`cursor_get_workspace_control({control: "models", detail: true})` returns
`details` alongside the ID list, including upstream `parameters` and `variants`
when available. `cursor_list_models` remains a compact no-argument call. Do not treat a truncated catalog as a complete
account catalog. The MCP has no provider-specific model default.

`cursor_create_agent` and `cursor_create_run` accept the same generic `model`
selection as a profile pin. A string remains shorthand for `{id}`. Parameter
order is insignificant; duplicate parameter IDs are refused. A pin with explicit
parameters requires the complete matching selection if a caller overrides it.

`cursor_get_usage({agentId, detail: true})` adds `usage` token components at the
total and per-run levels. `rawCostCents` and `chargedCents` are separately exposed
whenever returned, including zero. Missing cost is unknown, not zero. Compare
weighted input/output/cache pricing after settlement; this is billing evidence,
not proof of the executed model or an account-wide remaining balance.

The published `@cursor/sdk@1.0.31` cloud implementation sends `model` in the
same REST follow-up POST even though OpenAPI omits it. Its run/result model is
client-supplied, not execution attestation. This server adds no SDK dependency,
new tool, or new gate: it extends the existing model pin from creation to
follow-ups. Existing pins therefore now apply to both operations.
