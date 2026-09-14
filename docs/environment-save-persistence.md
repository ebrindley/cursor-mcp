# Environment Save and version persistence

Reference for the supported environment adapter, based on the delegated contracts
checked in August 2026. Examples use placeholders. Observed fields are not a
guarantee of future upstream behavior.

## Decision

**No published API-key, `@cursor/sdk`, or delegated Cloud MCP operation persists
Install/Start configuration.** A live 14-tool census contains no save, restore,
activate, deactivate, persist, update-environment, or commit-environment tool.
The OpenAPI still exposes no environment, build, or version paths.

Persistence is an owner authority, selected by managed type:

| Managed type | Discriminator | Persisting operation | Authority |
|---|---|---|---|
| Database-managed | `environmentJsonPath` is null | Dashboard Save | `browser-session` |
| Repository-file managed | `environmentJsonPath` present, defaulting to `.cursor/environment.json` | Commit that file to the **default** branch | `repo-commit` |

Classify **only** from `environment-info.environmentJsonPath`. Never probe
managed type by passing `environmentJson` to `trigger-environment-build`: on a
database-managed environment that call succeeds and burns a real Build.

Documented resolution order, first available wins:

1. `.cursor/environment.json` from the repository revision that started the agent
2. A personal saved environment for the repository
3. A team saved environment for the repository

A dashboard Save on a repository-file managed environment is therefore shadowed
by the committed file.

## Six things that must not be collapsed

Proposal, Save, repository synchronization, version creation, and Build trigger
are five distinct things. Build-scoped durable config is a sixth, and it is the
trap most likely to produce a false "saved" claim.

| Thing | Authority | Mints a version? | Build effect | Returned id |
|---|---|---|---|---|
| **Proposal** | `propose-environment-json` | No | None | **None** |
| **Save** | `browser-session`, database-managed | Expected new `environmentVersionPublicId` | Documented `triggerType=CONFIG_CHANGE` | Not programmatically observable |
| **Repository synchronization** | `repo-commit` to the default branch | **Unknown** | Unproven | Commit SHA, absent from delegated Build objects |
| **Version creation** | Consequence of Save | — | — | `environmentVersionPublicId`, plus a new numeric `builds[].environmentVersionId` |
| **Build trigger** | Delegated draft, dashboard, schedule, or configuration change | No; a draft trigger reused the existing numeric version | Creates a Build row | `buildId`, `isDraft` |
| **Build-scoped durable config** | `trigger-environment-build` with `environmentJson` | No | Recorded on that Build only, never on active settings | `buildId` |

`request-environment-setup-actions` records an owner action and does not save.
`take-environment-snapshot` persists a base disk snapshot, not Install/Start.

## Saved configuration can be owner-restricted

On the observed personal environment, `environment-info` returned
**`environmentJson: null`** alongside an `environmentJsonNote` explaining that
the configuration is owner-restricted for personal and override environments.

This is a hard limit on the delegated surface, and it has three consequences:

- The saved Install/Start document is **not readable** by a delegated run for
  such environments. Configuration-content readback is unavailable, not merely
  unproven.
- A persistence check of the form "saved Install/Start equals the intended
  document" **cannot be performed** delegated. The only delegated persistence
  signal left is the version identifier and the numeric version set.
- `propose-environment-json` cannot be given a verbatim current configuration,
  because there is no readable current configuration to echo.

A missing workspace `.cursor/environment.json` is **not** missing saved
configuration on a database-managed environment; the config lives in the
database and may be withheld from the run.

## Proposal cannot be exercised inertly

`propose-environment-json` accepts `environmentJson` with `install` and `start`
only, `additionalProperties: false`. A top-level JSONC comment cannot be sent as
an object field.

Combined with the owner-restriction above, every candidate payload is either
impossible or unsafe:

| Candidate payload | Verdict |
|---|---|
| Verbatim current configuration | **Impossible** — configuration is null/owner-restricted |
| Byte-identical configuration with no marker | **Impossible** — same reason |
| Inert top-level JSONC comment | **Impossible** — schema takes `install`/`start` only |
| A marker inside `install` or `start` | **Forbidden** — a real configuration delta |

The last row is the important one. Appending a marker to `install` or `start`
means that if an owner later pressed Save, it would change Start, mint a new
version, and fire a configuration-change Build, and undoing it is an owner-only
Restore. That is not a harmless probe.

Therefore the proposal negative control is **not performable** on an
owner-restricted personal environment.
Proposal and persistence are **distinct on advertised contract and census**, not
on a post-write experiment. State it that way; do not claim empirical proof.

Also **omit `buildId`** when proposing. Its documented purpose is letting Portal
Save reuse the snapshot a successful Build validated, so attaching a stale Build
id invites a Save that adopts a stale snapshot.

A proposal is **durable owner-visible review state**. Harmless means harmless to
configuration, not invisible. There is **no list-proposals tool**, so a pending
proposal left by any run is unobservable from the delegated surface, and
discarding it is an owner action.

## Durable identifier

No reachable programmatic write returns a durable configuration identifier. There
is no proposal id, no config-version id, and no Save receipt. The only durable id
a delegated write returns is `buildId`, which identifies a Build, not a
configuration.

The durable identity is **discovered by readback, not returned by a receipt**:

| After | Durable identity | Not a receipt |
|---|---|---|
| Proposal | None | Echoed install/start text, or result prose |
| Database-managed Save | A new `environmentVersionPublicId` | A new Build alone, or `environment-info.build.buildId` |
| Repository-file commit | The default-branch commit SHA | An assumed new environment version |
| Automatic Build | A separate `buildId` | Persistence |

Never equate the public `environmentVersionPublicId` with the numeric
`builds[].environmentVersionId`. No repository commit SHA appeared on any
delegated Build object; treat the SHA as git-local on this surface rather than as
a contradiction of dashboard documentation.

## Configuration freshness is uncertain

Whether `environment-info` reports a live environment record or a per-run boot
snapshot is **`uncertain`**.

An unchanged same-run or cross-run read does not distinguish live-and-unchanged
configuration from a frozen boot snapshot. Treat freshness as uncertain unless
explicit version or definition anchors establish it. A Save may be invisible to
an already-running run. Proving persistence requires a freshly booted run; an
unchanged same-run readback is indeterminate, not proof that Save failed.

## Does persistence trigger a Build?

Documented **yes** for dashboard Save and for secret changes, which is the
documentary source of `triggerType=CONFIG_CHANGE`. Configuration-change Builds
always run; only recurring checks may skip.

For repository-file commits, a repository change is **not** among the four
documented Build triggers, so an immediate automatic Build is unproven. A later
non-skipped recurring row would mean the schedule consumed the commit, not that
the commit issued a trigger.

Save, if it behaves as documented, is a **two-effect mutation** — a new version
*and* an immediate Build. It is not a cheap metadata write.

### Attributing a CONFIG_CHANGE Build

`triggerType` is the discriminator; `source` is not.

| Origin | `triggerType` | `source` |
|---|---|---|
| Save or secret change | `CONFIG_CHANGE` | Do not rely on `source` for this |
| Agent-requested draft | `MANUAL` | `AGENT` |
| Dashboard Trigger build | `MANUAL` | `WEBSITE` |
| Schedule | `RECURRING` | `SYSTEM` |

`MANUAL` alone cannot separate a dashboard trigger from an agent trigger. Do not
treat `source=WEBSITE` as official Save attribution.

A **secrets change also emits `CONFIG_CHANGE`**, so it is a confounder that the
change window must exclude.

Adopt a Build as attributable only when it was absent from the paged baseline,
belongs to the exact declared environment, falls inside the change window plus a
bounded queue allowance, is the **only** candidate, and carries a numeric
`environmentVersionId` absent from the recorded baseline set. Zero candidates is
unknown; two or more voids attribution. Never attribute by recency.

## Evidence ladder

Accept, in descending strength:

1. A Build row with `triggerType=CONFIG_CHANGE`, a timestamp inside the change
   window, a `buildId` absent from the pre-state, and an `environmentVersionId`
   **not** in the baseline numeric set.
2. A **freshly booted** run reporting a different `environmentVersionPublicId`.
3. For repository-file environments, two separate proofs: the remote blob at the
   exact commit SHA, **and** a fresh canary whose `environment-info` matches it
   with the path still present.

Reject as evidence: echoed proposal text; proposal result prose; any `SUCCEEDED`
status; `userFacingSnapshotId` being set, since it is set on failed Builds too;
`environment-info.build.buildId`, which is the boot Build; and mere absence of
contradiction. A same-run "unchanged" reading is unverified, never "preserved".

The **numeric `environmentVersionId` set** from the Build list is the preferred
version-creation instrument, because unlike `environment-info` it does not
depend on that payload's freshness.

## Gates before any persistence write

1. **Identity.** The out-of-band declared `environmentPublicId` equals the id on
   **both** `environment-info` and the `list-environment-builds` envelope. A
   single-surface check is insufficient, because identifiers a run reports about
   itself are self-confirming.
2. **Tamper.** The observed `environmentVersionPublicId` equals the declared
   baseline; otherwise the environment changed since declaration.
3. **Exclusivity.** No non-terminal baseline Build row, and no other actively
   running agent. Agent status `IDLE` means follow-up eligibility, **not** an
   active run, and must not be counted as one.
4. **Census.** Re-enumerate the tools. If a save, restore, activate, or
   deactivate tool has appeared, **stop and re-scope**; do not opportunistically
   call it.
5. **Managed type.** Record `environmentJsonPath`. A present path on a shared or
   production repository means no commit; emit the residual instead.
6. **Health.** `environmentDeleted` must be false.

Page the Build list **forward** before concluding a baseline row vanished: new
rows prepend, so a prepended row pushes the oldest row off the first page.

## Owner Save recipe

Specified, not executed. This MCP does not press Save.

1. The owner opens the **pre-declared** environment, verified out of band rather
   than through a URL learned from a run.
2. The owner discards any stale pending proposal so the document on screen is
   the intended one.
3. The owner presses **Save exactly once**, and records the wall-clock window.
   No secret edits in the same window.
4. A **second, freshly booted** run performs the readback. A same-run readback is
   indeterminate.
5. Persistence requires a changed `environmentVersionPublicId`. Where the
   configuration is owner-restricted, the content half of the check is
   unavailable, so record `CONFIG_CONTENT_UNREADABLE` rather than claiming a
   content match.
6. Attribute an automatic Build only under the candidate rule above.
7. Preserve the baseline `environmentVersionPublicId` as the rollback anchor a
   later Restore would target. Do not Restore.

There is no idempotency key on any delegated write, so a retry is a second
write. Save is zero-retry after dispatch. A repository commit is one commit;
verify the remote ref before any second push, and never amend as a retry. An
unknown write outcome fails closed and is resolved by readback only.

## Residual owner action

Database-managed:

```json
{
  "status": "OWNER_ACTION_REQUIRED",
  "action": "SAVE_ENVIRONMENT",
  "authority": "browser-session",
  "environmentPublicId": "<environment-id>",
  "environmentVersionPublicId": "<baseline-version-id>",
  "reason": "No published API-key, SDK, or delegated Cloud MCP save operation. Live census contains no save tool, and propose-environment-json records a proposal only.",
  "requiredReadback": "a new environmentVersionPublicId on a freshly booted run, plus a list-environment-builds row with triggerType=CONFIG_CHANGE and an environmentVersionId absent from the recorded baseline set"
}
```

For repository-file managed environments, switch `authority` to `repo-commit`,
keep the action from implying a dashboard Save, state that the configuration of
record is the file at `environmentJsonPath` and that this MCP will not commit the
caller's repository, and set `requiredReadback` to the default-branch SHA of that
file plus a fresh run whose `environment-info` matches it.

Never attach a Build `buildId` to a Save residual; a `buildId` is not a Save
receipt.

The typed proposal result stays exactly:

```json
{
  "persisted": false,
  "requiresOwnerSave": true
}
```

Do not add speculative receipt or version fields.

## Go / no-go

| Path | Verdict |
|---|---|
| Save through API key, SDK, or delegated Cloud MCP | **NO-GO** — emit `SAVE_ENVIRONMENT` |
| Proposal as persistence | **NO-GO** — it is not Save |
| `trigger-environment-build` with `environmentJson` as Save | **NO-GO** — Build-scoped only, and rejected for repository-file environments |
| Dashboard Save on a repository-file environment | **NO-GO** — the committed file wins |
| Commit `.cursor/environment.json` to a shared or production repository | **NO-GO** |
| Commit to a pre-declared throwaway repository-file environment | **GO** only with explicit owner authorization, as `repo-commit`, never labelled Save |
| Writing when the target id is not pre-declared out of band | **NO-GO** |
| Missing or unknown `environmentJsonPath` | **STOP**, do not write |

Implementations must not create `.cursor/environment.json` in a caller's
workspace. Because repository configuration takes precedence, introducing that
file could change how the environment resolves configuration for every user of
that repository.

## Open questions and what would settle them

| Question | Settling evidence |
|---|---|
| Does a repository-file commit mint an environment version, or only change what the next Build resolves? | One commit on a pre-declared throwaway repository-file environment, then look for a new `environmentVersionPublicId` and a new numeric version on the next Build row |
| Is `environment-info` configuration live or boot-frozen? | A fresh-run diff taken after a known out-of-band Save |
| Does Save mint a version and emit `CONFIG_CHANGE` in practice? | One owner Save, then the second-run readback and the Build candidate rule above |
| Does this surface ever expose the resolved commit SHA? | Absent so far; do not treat absence as contradicting dashboard documentation |

The downstream Save task must **not** implement Save. It should implement the
typed proposal result, the two residual bodies, and a fixture of the proposal
result's key set so that "no durable identifier" is testable offline.
