# Environment freshness

Design record for `src/environment-health.ts` and `src/tools/environment-health.ts`,
written 2026-08-29. It derives no new capability: every fact about Builds,
triggers, and active state comes from
[environment-build-operations.md](./environment-build-operations.md),
[cloud-mcp-environment-read-model.md](./cloud-mcp-environment-read-model.md), and
[environment-save-persistence.md](./environment-save-persistence.md).

## Three kinds of stale, and why they are not one field

"Is this environment fresh?" is three questions with three different answers and
three different owners. Merging them produces a single boolean that is wrong for
at least one of them.

| Axis | What moves | Who observes it | Who fixes it |
|---|---|---|---|
| **Build health** | Whether the environment's Builds succeed | Cursor runs them; nobody reports the outcome to you | Fix Install/Start, then let a Build run |
| **Source freshness** | The configuration of record — the saved definition, or `.cursor/environment.json` on the default branch | Cursor rebuilds on a configuration change | An owner Save, or a repository commit |
| **Toolchain drift** | The versions a fresh Install actually produces | **Nobody.** Not Cursor, and not this server | Change the definition, or accept the new upstream |

### Cursor's recurring Build is not a freshness check

A recurring Build is a *schedule*, and its `SKIPPED` outcome is the schedule
working: Cursor had nothing to rebuild. Three consequences follow, and the
implementation depends on all three.

- A `SKIPPED` row is **never** a fault. It is terminal, it consumes the trigger
  budget, and it is neither a failure nor a cancellation. `assessBuildHealth`
  counts skipped rows and reports them, and they never lower the verdict.
- A recurring Build re-runs Install. Whether that installs a *newer* compiler
  depends entirely on how the definition pins versions and on what upstream
  published. Cursor cannot know which of those a caller wanted, so a successful
  recurring Build is not evidence that the toolchain is current — and a `SKIPPED`
  one is evidence that it was not even re-attempted.
- The schedule is not visible from a Build row alone. `triggerType=RECURRING`
  distinguishes a scheduled Build from `MANUAL` and `CONFIG_CHANGE`; the observed
  values are recorded in
  [environment-build-operations.md](./environment-build-operations.md).

### `CONFIG_CHANGE` is not definition attribution

A `CONFIG_CHANGE` Build proves that *some* configuration change landed. It does
not prove the definition changed, because a **secrets change emits
`CONFIG_CHANGE` too**. So `assessSourceFreshness` reports
`pendingConfigurationChangeBuildIds` — configuration-change Builds newer than the
newest successful Build — as evidence that the current configuration has not been
consumed by a successful Build, and says in the same sentence that the cause may
be a secret rather than Install/Start.

Definition change itself is proved only by comparing anchors the caller recorded:
`environmentVersionPublicId` for a database-managed environment, the default-branch
commit of `.cursor/environment.json` for a repository-file managed one, or a
definition digest from `cursor_inspect_environment_definition`. A baseline with no
matching observation is `unknown`, not `unchanged`.

## Verdicts

### Build health

| Verdict | Rule |
|---|---|
| `HEALTHY` | A `SUCCEEDED` non-draft row exists and no failure is newer than it |
| `FAILING` | The newest non-draft terminal row is `FAILED` |
| `DEGRADED` | A failure is newer than the newest success, but the newest terminal row is not a failure — a `FAILED` then `SKIPPED` sequence |
| `UNKNOWN` | No rows, or neither a success nor a failure in the window |

Draft rows are excluded entirely and counted separately. A draft Build never
becomes the Build new agents boot from, so a draft failure is not the pipeline
failing.

An unrecognised `status` is neither terminal nor healthy and never contributes to
`HEALTHY`. Rows are ordered by `createdAtMs` when every row carries one and by list
order otherwise; which was used is reported, because a caller that merged pages
needs to know.

Age is reported (`ageMs`, `ageDays`) and **not** judged. There is no maximum-age
threshold here: what counts as too old is a property of the caller's release
cadence, and a policy engine for it is out of scope.

### Toolchain drift

| Verdict | Rule |
|---|---|
| `matched` | The installed version equals every declared reference |
| `drifted` | It differs from the declared or the upstream version |
| `unreported` | No version came back for a declared name |
| `undeclared` | A version is installed and nothing was declared to compare it against |

Comparison is exact after trimming whitespace and one leading `v`. **Nothing is
parsed as semver and nothing is ordered**: this authority can say two version
strings differ, and cannot say which is newer, so `drifted` never claims a
direction. A caller declaring a string the tool does not print gets `drifted`, and
the false-positive cost is bounded by the refresh gate below.

`unreported` is deliberately not `drifted`. A missing version is missing evidence,
and spending a Build on missing evidence is the mistake the separation prevents.

### The combined state

`FreshnessState` is ordered, and the order is the point: when the pipeline is
failing, the actionable finding is the failure, and refreshing onto a broken
Install spends a Build reproducing it.

| State | Exit code | Meaning |
|---|---|---|
| `HEALTHY` | 0 | Builds succeed, no declared anchor moved, every declared version matched |
| `STALE_TOOLCHAIN` | 10 | An installed version differs from a declared or upstream one |
| `STALE_SOURCE` | 11 | A declared anchor moved, or a configuration change no successful Build consumed |
| `BUILD_UNHEALTHY` | 20 | `FAILING` or `DEGRADED` |
| `INDETERMINATE` | 30 | An axis had incomplete evidence |

`1` is deliberately unused: a crash, a usage error, and a policy refusal already
exit `1`, and a scheduler must be able to tell "the environment is stale" from
"the check did not run".

`HEALTHY` is reachable with nothing declared. Source and toolchain then read
`undeclared`, which is honest — the check says only what its evidence supports —
and it is what makes the cheap check useful on day one.

## The refresh gate

`cursor_assess_environment_health` never triggers anything. It is annotated
read-only, `read:*` grants it, it launches no delegate, and it makes no API call:
two consecutive checks of an unchanged environment produce byte-identical results
and no Build either time.

`cursor_refresh_environment_toolchain` re-runs the same judgement and dispatches at
most one Build. Every one of these stops it before a VM exists:

| Condition | Result |
|---|---|
| `HEALTHY` | `REFRESH_NOT_NEEDED`, nothing dispatched, no confirmation asked for |
| `BUILD_UNHEALTHY` | `REFRESH_WITHHELD` — read the failed Build's logs first |
| `STALE_SOURCE` | `REFRESH_WITHHELD` — a Build from the *saved* configuration would not carry an unsaved change |
| `INDETERMINATE` | `REFRESH_WITHHELD` — a Build is a write, never spent on an unproven condition |
| `STALE_TOOLCHAIN` without `confirm: true` | Refused by policy, nothing dispatched |
| `STALE_TOOLCHAIN` with `confirm: true` | Exactly one draft Build |

The dispatch reuses the same `trigger-build` mission as `cursor_trigger_build`, so
every rule there still holds: one call, **no retry** — the trigger has no
idempotency key — and attribution by exact returned `buildId` or by a single
baseline difference, never by recency.

### What a refresh does and does not do

The only supported trigger produces a **draft** Build. So:

- A refresh **proves** what a fresh Install produces. That is its whole value.
- A refresh **does not deliver** it. A draft Build never becomes the Build new
  agents boot from, so activation remains an owner action.
- A response proving `isDraft=true` establishes that the refresh does not become
  the Build new agents boot from. It does **not** establish which Build was active
  before or after the call. Nothing in this path activates, deactivates, saves, or
  restores anything.

Active state is unreadable on every authority this project may use, so `HEALTHY`
describes Build history and never what new agents boot from. `activeBuild` is
always `{ readable: false }` with the reason attached, never omitted.

## Running it from a scheduler

No scheduler lives in cursor-mcp, and none is installed by it. The contract is the
`exitCode`, so any external scheduler works. One invocation, with no stateful
service beyond the file holding the baseline the caller recorded:

```sh
#!/bin/sh
# cron: 0 7 * * *   launchd: StartCalendarInterval   GitHub Actions: schedule
# Reads Build rows and installed versions with the two delegated tools, then
# judges them locally. STATE_FILE holds the anchors and versions last known good.
state=$(cat "$STATE_FILE")

exit_code=$(
  mcp-call cursor_assess_environment_health "$state" |
    jq -r '.exitCode'
)

case "$exit_code" in
  0)  echo "fresh" ;;
  10) echo "toolchain drift; refresh with confirm to spend one draft Build" ;;
  11) echo "source moved; persist the definition first" ;;
  20) echo "Builds failing; read the logs" ;;
  30) echo "evidence incomplete" ;;
  *)  echo "the check did not run"; exit 1 ;;
esac

exit "$exit_code"
```

`mcp-call` stands for whatever the caller already uses to invoke an MCP tool; this
repository ships no such wrapper, deliberately. Nothing above is persisted by the
server: `$STATE_FILE` is the caller's, and the caller owns updating it once a
refresh is qualified.

## Out of scope, and why

- **A scheduler.** cron, launchd, systemd timers, and CI schedules already exist,
  and none of them needs a process inside an MCP server.
- **Distributed locks.** The refresh's own precondition is stronger than a lock
  would be: the `trigger-build` mission refuses to trigger when any baseline row is
  non-terminal or when another run is active against the environment.
- **A freshness-policy engine.** Thresholds, escalation, and notification are the
  caller's. This module reports evidence and one ordered state.
- **Reimplementing the recurring Build.** Cursor owns the schedule and the skip
  decision. This module observes their consequences and never second-guesses them.
- **Activating a refreshed Build.** Unqualified promotion is exactly the mistake
  the draft contract prevents. Qualify with `cursor_qualify_environment`, then
  promote through the owner action.
