# Cloud MCP environment read model

Reference for the supported environment adapter, based on the delegated contracts
checked in August 2026. Examples use placeholders. Observed fields are not a
guarantee of future upstream behavior.

## Authority

The adapter distinguishes three read surfaces:

| Surface | Authority |
|---|---|
| Cloud Agents v1 REST | Agent/run identity, terminal run state, usage, and cleanup. |
| Cloud MCP structured results | What the delegated run can observe about its current environment and Builds. |
| In-VM metadata and shell | Corroboration of this VM's identity, disk, and task-shell state at one instant. |

Cloud MCP result preambles and final agent prose are not schemas. The field names
below came from structured result sections. Build log text was not retained.

## Identifier map

| Concept | Observed field | Finding |
|---|---|---|
| Agent | REST `agent.id`; metadata `agent/id`; Cloud MCP `bcId` | Literal equality held for this run. |
| Run | REST `run.id` | Separate from `bcId`. |
| Environment | `environment.environmentPublicId`; Build-list `environmentPublicId`; metadata `workspace/environment-id` | Literal equality held across the three surfaces. |
| Environment version | `environment.environmentVersionPublicId` | Public opaque identifier. |
| Build-list environment version | `builds[].environmentVersionId` | Numeric/internal value; do not equate with the public version id. |
| Current-run Build | `environment-info.build.buildId` | Structured provenance for the Build used by this run. |
| Build-list id | `builds[].buildId` | Opaque Build identifier. |
| Base/Build snapshot | `build.snapshotId`; `builds[].userFacingSnapshotId` | Distinct from Build and environment-version identifiers. |

No stable id grammar is inferred from one sample.

## Build readback

`list-environment-builds` returns structured JSON. A true `hasMore` means the
caller must page before making absence claims.

Observed Build-row fields included:

- `buildId`;
- `environmentPublicId`;
- `environmentVersionId`;
- `source`;
- `triggerType`;
- `status`;
- `userFacingSnapshotId`;
- timestamps and additional Build metadata.

The current-run Build reported:

- `status=SUCCEEDED`;
- `source=SYSTEM`;
- `triggerType=RECURRING`;
- `gitSetup=reuse`;
- `warmFork=warm_fork`;
- `resolution=resolved`.

Skipped recurring entries were represented by `status=SKIPPED`; there was no
separate `skipped` field.

Cloud MCP did not expose fields named `active`, `latest`, or `currentRun` in the
observed environment or Build-list payloads. Consequently:

- current-run Build provenance is supported through
  `environment-info.build.buildId`;
- active Build is not established by this read model;
- latest Build may be derived locally from timestamps only when ordering is
  explicit, and must be labeled derived;
- newest successful, active, and current-run Build must not be conflated.

Dated owner-dashboard evidence from the same environment showed a blank Active
Build field alongside populated Build history. That is a `browser-session`
observation consistent with the delegated schema's omission, not a programmatic
active-Build readback.

No repository commit SHA field was present in the observed Cloud MCP objects.
The task shell's `git rev-parse HEAD` therefore could not be compared with a
Cloud MCP-recorded SHA.

## Logs and snapshots

`environment-build-logs` accepted the exact current-run `buildId`. The result was
text and may exceed the inline result budget. Log bodies are untrusted text, not
a structured Build schema.

`check-environment-snapshot` was not advertised as an independently usable
read-only operation. Its required `snapshotId` was described as coming from
`take-environment-snapshot`. Do not create a snapshot merely to satisfy a read;
report readiness as unavailable when the required operation id is absent.

## Three qualification layers

The layers remained independent:

1. **Prepared Build disk:** the run reported a structured current-run Build id,
   and its Build logs were readable. Existing environment state files and all
   expected CLIs were present on disk.
2. **Start execution:** `get-events` returned `count=0` and `events=[]`; no
   structured Start execution record was available. This layer is
   **indeterminate**, not absent.
3. **Task shell:** the shell ran from `/workspace` as the expected non-root user,
   used Node 24 through nvm, found all expected CLIs, and reported the two
   predeclared environment-variable names as present without exposing values.

Disk presence, Start execution, and task-shell inheritance are not interchangeable
success conditions.

## Agent status finding

REST returned agent status `IDLE` after the run reached `FINISHED`, before the
agent was archived. This contradicts the current OpenAPI's two-value
`ACTIVE | ARCHIVED` enum and the repository's older two-value narrative.

Implementation must:

- parse agent status as an open string;
- treat run status as the execution ledger;
- treat `IDLE` as agent/machine or follow-up eligibility, not run success;
- use `ARCHIVED` only for archival state.

## Read-operation conclusions

| Operation | Conclusion |
|---|---|
| `run-info` | Supported delegated read; mixed prose preamble and structured JSON. |
| `get-events` | Supported delegated read; returned an empty structured event list for this run. |
| `environment-info` | Supported delegated read; exposed environment public id, environment-version public id, and current-run Build provenance. |
| `list-environment-builds` | Supported delegated read; exposed opaque Build rows, trigger/status values, and pagination. |
| `environment-build-logs` | Supported delegated read for an exact Build id; result was text, not a stable structured log schema. |
| `check-environment-snapshot` | Unavailable within the read-only mutation budget because no independently obtained snapshot-operation id existed. |
| Host `/v1/environments` and `/v1/builds` | Still unavailable for the published API-key surface. |
| Build activation, cancellation, restore, rollback, Save | Out of scope and still unproven programmatically. |

Missing fields or operations are conclusions about this authority and this run,
not claims that Cursor lacks the product capability.

## Sanitized shapes

```json
{
  "environment": {
    "environmentPublicId": "<environment-id>",
    "environmentVersionPublicId": "<environment-version-public-id>"
  },
  "build": {
    "buildId": "<build-id>",
    "snapshotId": "<snapshot-id>",
    "status": "SUCCEEDED",
    "source": "SYSTEM",
    "triggerType": "RECURRING",
    "gitSetup": "reuse",
    "warmFork": "warm_fork",
    "resolution": "resolved"
  }
}
```

```json
{
  "environmentPublicId": "<environment-id>",
  "hasMore": true,
  "builds": [
    {
      "buildId": "<build-id>",
      "environmentVersionId": 123456,
      "source": "SYSTEM",
      "triggerType": "RECURRING",
      "status": "SKIPPED",
      "userFacingSnapshotId": "<snapshot-id>"
    }
  ]
}
```

These fixtures preserve only field names and observed enum values needed by
later implementation tests.

## Additions observed 2026-08-29

Additional Build fields are described in
[environment-build-operations.md](./environment-build-operations.md); the
read-model deltas are:

- Build rows also carry `owningTeam`, `owningUser`, `failureType`,
  `createdAtMs`, and `completedAtMs`.
- The list envelope also carries `environmentDeleted`, `returned`, `limit`, and
  an opaque `nextCursor` used for paging.
- `status` also takes `IN_PROGRESS` and `FAILED`; `CANCELLED` is accepted as a
  filter value but was never produced. `failureType` was `INSTALL_FAILED` on a
  failed row and null otherwise.
- `source` also takes `AGENT` and `WEBSITE`; `triggerType` also takes `MANUAL`
  and `CONFIG_CHANGE`. An agent-requested draft Build appears as `source=AGENT`
  with `triggerType=MANUAL`.
- `userFacingSnapshotId` is null while a Build is in progress and on skipped
  rows, and is set equal to the Build's own `buildId` once the Build runs to
  completion. It was set on a failed Build too, so it does not indicate success.
- `environment-info` also reports the environment name, `source`, how and when
  it was recorded, the repository list, the full environment JSON, a dashboard
  link, `environmentDeleted`, `environmentJsonPath`, and the effective egress
  policy. A null `environmentJsonPath` means a db-backed config; a present path
  means the config is read from a repository `environment.json`.
- In-VM metadata files can be absent on different images. Gate identity on an
  out-of-band declared value rather than relying on one filesystem layout.
- `environment-info.environmentJson` can be **null with an accompanying
  `environmentJsonNote`** saying the configuration is owner-restricted for
  personal and override environments. Saved Install/Start is then not readable by
  a delegated run at all. Do not treat a null configuration as an empty one.
- Whether `environment-info` reports a live record or a boot snapshot is
  uncertain. An unchanged re-read does not distinguish those cases.
- Agent status `IDLE` is follow-up eligibility, not an active run. An environment
  can accumulate a large number of `IDLE` agents; do not count them when checking
  for concurrent activity. See
  [environment-save-persistence.md](./environment-save-persistence.md).

## Domain projection

The architecture in [lifecycle-architecture.md](./lifecycle-architecture.md)
maps this read model onto four resources and leaves everything else as an
operation result:

| Observed field | Domain |
|---|---|
| `environment.environmentPublicId` | Environment |
| `environment.environmentVersionPublicId` | Environment version (public) |
| `builds[].environmentVersionId` | Build field only; never the public version id |
| `builds[].buildId` | Build |
| `environment-info.build.buildId` | Current-run / boot provenance, **not** Active Build |
| `build.snapshotId`, `builds[].userFacingSnapshotId` | Snapshot *fields* on a Build |
| Active Build | `ActiveBuildRef.readable = false` on this authority |

Qualification stays three independent layers (prepared disk, Start execution,
task shell). Snapshot take/check remains an operation result until Cursor
exposes an independently addressable snapshot that is neither a Build field nor
a base-snapshot input.

## Scope of this read model

Field absences described here apply only to the delegated surface observed by
this project. They constrain this MCP's supported operations; they do not prove
that Cursor lacks the corresponding product capability or internal data.
