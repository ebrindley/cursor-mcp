/**
 * Environment Operations: inspect, monitor, trigger, log, qualify, cancel,
 * synchronize, activate, restore, roll back.
 *
 * Everything here is projection and judgement over what a *delegated run* can
 * observe. The authority classification is defined by the adapter contracts and is not
 * re-derived at runtime -- see `docs/cloud-mcp-environment-read-model.md`,
 * `docs/environment-build-operations.md`,
 * `docs/environment-save-persistence.md`, and
 * `docs/environment-control-plane-contract.md`:
 *
 *   - environment identity, Build rows, Build logs, and an agent-requested
 *     **draft** Build trigger are `observed` on the delegated Cloud MCP surface;
 *   - Build cancel, Build activation, and an authoritative active-Build read are
 *     absent from a live tool census, so they fail closed with a residual;
 *   - a host-wide manual Build is an owner action;
 *   - CLI publication, database Save, and deletion are independently gated on
 *     the cursor-cli authority and never share a path with Build activation,
 *     Restore, or rollback;
 *   - activation, deactivation, environment-version Restore, and Build rollback
 *     still have no executable contract, so each returns its own residual and
 *     none of them shares a code path with another. A generic `restore(target)`
 *     would perform the wrong operation on a type confusion.
 *
 * Four rules shape every function below.
 *
 * 1. **`status` is an open string.** An unrecognised value stays itself, is not
 *    terminal, and is never success. A reachable status vocabulary is not
 *    evidence of a reachable operation: `CANCELLED` is an accepted filter value
 *    that no delegated operation can produce.
 * 2. **Identifiers are never interchangeable.** `environment-info.build.buildId`
 *    is the Build the delegate's pod booted from, not the environment's active
 *    Build. `userFacingSnapshotId` is set on failed Builds, so it is not success.
 *    The numeric `environmentVersionId` is never the public version id.
 * 3. **Delegated output is agent-authored untrusted evidence.** Every projection
 *    carries `trust: "delegated-untrusted"`, and identifiers are emitted before
 *    optional log text so the response budget cannot drop them.
 * 4. **Unknown write outcomes fail closed.** Attribution adopts at most one
 *    candidate Build, never by recency, and never triggers a second Build.
 *
 * Nothing here is persisted. There is no provenance database: the caller holds
 * identifiers between atomic calls.
 */

import { z } from "zod";
import {
  ENV_LIST_ARGS,
  classifyCliRun,
  cliAuthorityBlock,
  cursorCliWriteReadiness,
  envDeleteArgs,
  envDeleteDryRunArgs,
  envGetArgs,
  envPublishArgs,
  envSaveArgs,
  parseCliJson,
  type CliRunner,
  type CliWriteOperation,
  type CliWriteReadiness,
  type CursorCli,
} from "./cursor-cli.js";
import {
  canonicalJson,
  databaseDigest,
  deleteDryRunMatchesTarget,
  deleteIdentityDigest,
  environmentAbsentFromList,
  issueWritePreview,
  matchWriteBinding,
  normalizeEnvironmentCatalog,
  normalizeEnvironmentConfiguration,
  readableContentDigest,
  readPullRequestUrl,
  resolveWriteTarget,
  summarizeConfiguration,
  verifyWriteConfirmation,
  type CliWriteBinding,
  type CliWritePreview,
  type CliWriteTarget,
} from "./cursor-cli-environments.js";
import {
  managedAsFromPath,
  ownerActionResidual,
  unreadableActiveBuild,
  type Build,
  type Environment,
  type EnvironmentManagedAs,
  type LayerResult,
  type OwnerActionResidual,
  type QualificationResult,
} from "./lifecycle-model.js";

/** Delegated output is always labeled. There is no trusted-evidence path. */
export const DELEGATED_TRUST = "delegated-untrusted" as const;

/** Why the active Build is not reported, in one sentence the caller can act on. */
export const ACTIVE_BUILD_UNREADABLE_REASON =
  "The delegated payloads expose no field named active, latest, or currentRun, so this " +
  "authority cannot read the environment's active Build. environment-info.build.buildId is " +
  "the Build the delegated run booted from, not the active Build.";

/* --------------------------------------------------------- delegated payloads */

/**
 * Wire shapes as a delegated run reports them.
 *
 * Loose and mostly optional, exactly like `schemas.ts`: the delegated projection
 * is narrower than Cursor's own Build model and gains fields during the beta. A
 * field is required only where an operation depends on it -- a Build row without
 * a `buildId` or a `status` cannot be monitored at all.
 */
export const DelegatedBuildRowSchema = z.looseObject({
  buildId: z.string(),
  status: z.string(),
  environmentPublicId: z.string().optional(),
  source: z.string().optional(),
  triggerType: z.string().optional(),
  failureType: z.string().nullish(),
  environmentVersionId: z.preprocess(
    (value) => {
      if (value === null) return undefined;
      if (typeof value !== "string" || !/^\d+$/.test(value)) return value;
      const parsed = Number(value);
      return Number.isSafeInteger(parsed) ? parsed : value;
    },
    z.number().optional(),
  ),
  userFacingSnapshotId: z.string().nullish(),
  createdAtMs: z.number().optional(),
  completedAtMs: z.number().optional(),
  isDraft: z.boolean().optional(),
});

export type DelegatedBuildRow = z.infer<typeof DelegatedBuildRowSchema>;

/** One `list-environment-builds` page. Newest first, opaque `nextCursor`. */
export const DelegatedBuildPageSchema = z.looseObject({
  builds: z.array(DelegatedBuildRowSchema),
  environmentPublicId: z.string().optional(),
  environmentDeleted: z.boolean().optional(),
  returned: z.number().optional(),
  limit: z.number().optional(),
  hasMore: z.boolean().optional(),
  nextCursor: z.string().optional(),
});

export type DelegatedBuildPage = z.infer<typeof DelegatedBuildPageSchema>;

/**
 * `environment-info`.
 *
 * `environmentJson` may be null with a note when the configuration is
 * owner-restricted. A null configuration is not an empty one, so the two cases
 * are kept apart by `environmentJsonReadable` below rather than defaulted.
 */
export const DelegatedEnvironmentInfoSchema = z.looseObject({
  environmentPublicId: z.string().optional(),
  name: z.string().optional(),
  environmentVersionPublicId: z.string().optional(),
  environmentJsonPath: z.string().nullish(),
  environmentDeleted: z.boolean().optional(),
  /** Absent, or null with a note when the owner restricts it. Never defaulted. */
  environmentJson: z.unknown().optional(),
  environmentJsonNote: z.string().optional(),
  agentCanUpdateSnapshot: z.boolean().nullish(),
  build: z
    .looseObject({
      buildId: z.string().optional(),
      snapshotId: z.string().nullish(),
      status: z.string().optional(),
      gitSetup: z.string().optional(),
      warmFork: z.string().optional(),
      resolution: z.string().optional(),
    })
    .optional(),
});

export type DelegatedEnvironmentInfo = z.infer<typeof DelegatedEnvironmentInfoSchema>;

/**
 * The `trigger-environment-build` result.
 *
 * `status`, `triggerType`, `source`, queue position, and ETA are absent here;
 * they come from a list readback only.
 */
export const DelegatedTriggerResultSchema = z.looseObject({
  buildId: z.string().optional(),
  environmentPublicId: z.string().optional(),
  createdDraftEnvironment: z.boolean().optional(),
  isDraft: z.boolean().optional(),
});

export type DelegatedTriggerResult = z.infer<typeof DelegatedTriggerResultSchema>;

/**
 * `environment-build-logs`.
 *
 * One combined install-and-setup stream: there are no `installLog` or `startLog`
 * keys. `sizeBytes` 0 with no body is the honest mid-flight and skipped answer,
 * not a fetch error.
 */
export const DelegatedLogResultSchema = z.looseObject({
  sizeBytes: z.number().optional(),
  text: z.string().optional(),
  retentionNote: z.string().optional(),
  notFound: z.boolean().optional(),
  environmentDeleted: z.boolean().optional(),
});

export type DelegatedLogResult = z.infer<typeof DelegatedLogResultSchema>;

/** `get-events`. An empty list is indeterminate, never a failed Start. */
export const DelegatedEventsSchema = z.looseObject({
  count: z.number().optional(),
  events: z.array(z.unknown()).optional(),
});

/**
 * One installed tool and the version string it printed.
 *
 * A version is an observation, never a judgement: this type carries no notion of
 * current, expected, or upstream. Comparison lives in `environment-health.ts`,
 * because "which version should be installed" is not something a delegated run
 * inside the environment can answer about itself.
 */
export const DelegatedToolVersionSchema = z.looseObject({
  name: z.string().min(1).max(64),
  version: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[^\r\n]*$/, "tool version must be a single line"),
});

export type ToolchainObservation = z.infer<typeof DelegatedToolVersionSchema>;

/**
 * Bounded task-shell observations.
 *
 * Environment-variable *names* only. A value is never requested and never
 * reported: presence is the whole question this layer answers.
 *
 * `toolchain` is the one place a *value* is reported, and it is reported only for
 * command names the caller declared: a version string is not a credential, and it
 * is the only evidence of installed-toolchain drift that exists on this surface.
 */
export const DelegatedShellReportSchema = z.looseObject({
  workspace: z.string().optional(),
  user: z.string().optional(),
  commandsPresent: z.array(z.string()).optional(),
  commandsMissing: z.array(z.string()).optional(),
  environmentVariablesPresent: z.array(z.string()).optional(),
  environmentVariablesMissing: z.array(z.string()).optional(),
  toolchain: z.array(DelegatedToolVersionSchema).optional(),
});

export type DelegatedShellReport = z.infer<typeof DelegatedShellReportSchema>;

/**
 * The one document a delegate returns, whatever its mission.
 *
 * `triggerDispatched` and `precondition` are how a mission reports that it
 * stopped *before* mutating. That distinction is load-bearing: "not dispatched"
 * and "dispatched with an unknown outcome" call for opposite next steps.
 */
export const DelegatedReportSchema = z.looseObject({
  mission: z.string(),
  environmentInfo: DelegatedEnvironmentInfoSchema.optional(),
  builds: DelegatedBuildPageSchema.optional(),
  /** Further pages in page order, when the mission paged forward. */
  morePages: z.array(DelegatedBuildPageSchema).optional(),
  baselineBuildIds: z.array(z.string()).optional(),
  otherActiveRuns: z.number().optional(),
  triggerDispatched: z.boolean().optional(),
  trigger: DelegatedTriggerResultSchema.optional(),
  precondition: z.string().optional(),
  monitorAttempts: z.number().optional(),
  monitorElapsedMs: z.number().optional(),
  monitorDeadlineExceeded: z.boolean().optional(),
  logs: DelegatedLogResultSchema.optional(),
  events: DelegatedEventsSchema.optional(),
  shell: DelegatedShellReportSchema.optional(),
  notes: z.string().optional(),
});

export type DelegatedReport = z.infer<typeof DelegatedReportSchema>;

/* ------------------------------------------------------------ report parsing */

/** Fence the delegate is told to put its one JSON document inside. */
export const REPORT_OPEN = "BEGIN_CURSOR_MCP_REPORT";
export const REPORT_CLOSE = "END_CURSOR_MCP_REPORT";

export type ReportExtraction =
  | { ok: true; report: DelegatedReport }
  | { ok: false; reason: string };

/**
 * Pull the structured document out of agent prose.
 *
 * Cloud MCP results themselves arrive as a mixed envelope -- a prose preamble,
 * then structured JSON -- and the delegate's own reply adds another layer of
 * prose. Only the explicitly marked region is accepted. Falling back to an
 * arbitrary object in prose would let a narration or prompt-injection payload
 * masquerade as the mission report.
 */
export function extractReport(text: string): ReportExtraction {
  const candidate = markedRegion(text);
  if (candidate === undefined) {
    return {
      ok: false,
      reason: "the delegated reply contained no marked JSON report",
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(candidate);
  } catch {
    return { ok: false, reason: "the delegated report region was not valid JSON" };
  }
  const parsed = DelegatedReportSchema.safeParse(value);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return { ok: false, reason: `the delegated report did not match the contract -- ${issues}` };
  }
  return { ok: true, report: parsed.data };
}

function markedRegion(text: string): string | undefined {
  const open = text.lastIndexOf(REPORT_OPEN);
  if (open === -1) return undefined;
  const close = text.indexOf(REPORT_CLOSE, open + REPORT_OPEN.length);
  if (close === -1) return undefined;
  const inner = text.slice(open + REPORT_OPEN.length, close);
  const start = inner.indexOf("{");
  const end = inner.lastIndexOf("}");
  if (start === -1 || end <= start) return undefined;
  return inner.slice(start, end + 1);
}

/* ------------------------------------------------------------ Build projection */

/**
 * Build statuses that will not change again.
 *
 * A set over an enum, for the same reason `schemas.ts` does it for runs: a
 * status Cursor adds during the beta must read as non-terminal rather than fail
 * the response or, worse, read as done.
 */
const TERMINAL_BUILD_STATUS = new Set([
  "SUCCEEDED",
  "FAILED",
  "SKIPPED",
  "CANCELLED",
]);

export function isTerminalBuild(status: string): boolean {
  return TERMINAL_BUILD_STATUS.has(status);
}

/**
 * What a Build status means for the caller.
 *
 * `skipped` is its own outcome. It is terminal, it consumes a trigger budget,
 * and it is neither a failure nor a cancellation.
 */
export type BuildOutcome =
  | "succeeded"
  | "failed"
  | "skipped"
  | "cancelled"
  | "in-progress"
  | "unknown";

export function buildOutcome(status: string): BuildOutcome {
  switch (status) {
    case "SUCCEEDED":
      return "succeeded";
    case "FAILED":
      return "failed";
    case "SKIPPED":
      return "skipped";
    case "CANCELLED":
      return "cancelled";
    case "IN_PROGRESS":
      return "in-progress";
    default:
      return "unknown";
  }
}

/**
 * State of the snapshot *field* on a Build.
 *
 * Observed behaviour, not inference: `userFacingSnapshotId` is null while a
 * Build is in progress and on skipped rows, and is set equal to the Build's own
 * id once the Build runs to completion -- including when it fails. `ready`
 * therefore describes the snapshot field, never Build success.
 */
export type SnapshotState = "ready" | "warming" | "absent" | "unknown";

export function snapshotState(row: {
  status: string;
  userFacingSnapshotId?: string | null | undefined;
}): SnapshotState {
  if (typeof row.userFacingSnapshotId === "string" && row.userFacingSnapshotId !== "") {
    return "ready";
  }
  switch (buildOutcome(row.status)) {
    case "in-progress":
      return "warming";
    case "skipped":
      // A skipped Build never ran, so there is no disk to snapshot. Absent, not
      // warming: nothing is coming.
      return "absent";
    case "succeeded":
    case "failed":
    case "cancelled":
      // Completed with no snapshot field is drift, not readiness.
      return "unknown";
    default:
      return "unknown";
  }
}

/**
 * Where a projected `environmentPublicId` came from.
 *
 * `row` is the Build's own field. `imputed` means the row carried none and the
 * value was filled in from the page or the request, purely so the projection has
 * one -- see `authoritativeEnvironmentIdentity`.
 */
export type EnvironmentIdentitySource = "row" | "imputed";

/** A Build row as the caller sees it: the domain resource plus derived state. */
export interface BuildView extends Build {
  outcome: BuildOutcome;
  terminal: boolean;
  snapshot: SnapshotState;
  /**
   * How `environmentPublicId` above was obtained.
   *
   * A projected row is a display value. `imputed` is reported rather than hidden
   * because a filled-in id looks exactly like a read one, and only a read one
   * may authorize a mutation.
   */
  environmentPublicIdSource: EnvironmentIdentitySource;
  /** When this projection was produced, for bounded mutation preconditions. */
  observedAtMs: number;
  createdAtMs?: number;
  completedAtMs?: number;
  /** Reported only when both timestamps are present and ordered. */
  durationMs?: number;
  trust: typeof DELEGATED_TRUST;
}

export function projectBuild(
  row: DelegatedBuildRow,
  environmentPublicId: string,
  observedAtMs: number = Date.now(),
): BuildView {
  const view: BuildView = {
    buildId: row.buildId,
    environmentPublicId: row.environmentPublicId ?? environmentPublicId,
    environmentPublicIdSource: row.environmentPublicId === undefined ? "imputed" : "row",
    observedAtMs,
    status: row.status,
    outcome: buildOutcome(row.status),
    terminal: isTerminalBuild(row.status),
    snapshot: snapshotState(row),
    trust: DELEGATED_TRUST,
  };
  if (row.source !== undefined) view.source = row.source;
  if (row.triggerType !== undefined) view.triggerType = row.triggerType;
  if (row.failureType !== undefined) view.failureType = row.failureType;
  if (row.userFacingSnapshotId !== undefined) {
    view.userFacingSnapshotId = row.userFacingSnapshotId;
  }
  if (row.environmentVersionId !== undefined) {
    view.environmentVersionId = row.environmentVersionId;
  }
  if (row.isDraft !== undefined) view.isDraft = row.isDraft;
  if (row.createdAtMs !== undefined) view.createdAtMs = row.createdAtMs;
  if (row.completedAtMs !== undefined) view.completedAtMs = row.completedAtMs;
  if (
    row.createdAtMs !== undefined &&
    row.completedAtMs !== undefined &&
    row.completedAtMs >= row.createdAtMs
  ) {
    view.durationMs = row.completedAtMs - row.createdAtMs;
  }
  return view;
}

/** One line per Build for the summary text. */
export function buildLine(build: BuildView): string {
  const parts = [build.buildId, build.status];
  if (build.triggerType !== undefined) parts.push(build.triggerType);
  if (build.source !== undefined) parts.push(build.source);
  if (build.failureType !== undefined && build.failureType !== null) {
    parts.push(build.failureType);
  }
  parts.push(`snapshot=${build.snapshot}`);
  if (build.durationMs !== undefined) {
    parts.push(`${Math.round(build.durationMs / 1000)}s`);
  }
  return parts.join("  ");
}

/* ------------------------------------------------------- environment projection */

/** Whether saved Install/Start could be read at all, which is not the same as empty. */
export type ConfigurationReadability = "readable" | "owner-restricted" | "unknown";

/**
 * The snapshot preflight.
 *
 * Taking a snapshot persists base-disk state. The take-then-check integration
 * has not been verified, so this server refuses creation even when
 * `agentCanUpdateSnapshot` grants authority. An id returned by creation could
 * support later readiness checks; requiring that id before creation would not
 * establish whether the integration works.
 */
export type SnapshotUpdateAuthority = "granted" | "withheld" | "unreadable";

export interface SnapshotPreflight {
  status: "CAPABILITY_UNAVAILABLE";
  operation: "TAKE_ENVIRONMENT_SNAPSHOT";
  updateAuthority: SnapshotUpdateAuthority;
  allowed: false;
  reason: string;
  requiredReadback: string;
  nextSteps: string[];
}

export function snapshotPreflight(args: {
  agentCanUpdateSnapshot?: boolean | null | undefined;
  configuration: ConfigurationReadability;
}): SnapshotPreflight {
  const authority: SnapshotUpdateAuthority =
    args.agentCanUpdateSnapshot === true
      ? "granted"
      : args.agentCanUpdateSnapshot === false
        ? "withheld"
        : "unreadable";
  const reason =
    authority === "withheld"
      ? "The environment does not grant agentCanUpdateSnapshot, so no agent may update the base snapshot."
      : authority === "unreadable"
        ? "Snapshot-update authority could not be read" +
          (args.configuration === "owner-restricted"
            ? " because the environment configuration is owner-restricted; a null configuration is not an empty one."
            : ".") +
          " Taking a snapshot persists base-disk state, and the take-then-check integration has not been verified."
        : "Snapshot-update authority is granted, but creation is disabled: taking a snapshot persists base-disk state, and the take-then-check integration has not been verified.";
  return {
    status: "CAPABILITY_UNAVAILABLE",
    operation: "TAKE_ENVIRONMENT_SNAPSHOT",
    updateAuthority: authority,
    allowed: false,
    reason,
    requiredReadback:
      "a verified take-then-check contract that returns a snapshot-operation id from creation and confirms readiness for that same id",
    nextSteps: [
      "Take and verify the base snapshot from the environment dashboard, where readiness is shown.",
      "Read a Build's userFacingSnapshotId for that Build's disk provenance; it is a Build field, not an independently addressable snapshot.",
    ],
  };
}

export interface EnvironmentView extends Environment {
  managedAs: EnvironmentManagedAs;
  configuration: ConfigurationReadability;
  environmentDeleted?: boolean;
  /** The Build the delegated run booted from. Never the active Build. */
  currentRunBuildId?: string;
  currentRunSnapshotId?: string | null;
  activeBuildReason: string;
  snapshot: SnapshotPreflight;
  trust: typeof DELEGATED_TRUST;
}

export function projectEnvironment(
  info: DelegatedEnvironmentInfo,
  reportedEnvironmentPublicId: string | undefined = info.environmentPublicId,
): EnvironmentView {
  if (reportedEnvironmentPublicId === undefined || reportedEnvironmentPublicId === "") {
    throw new Error(
      "environment projection requires an environmentPublicId proven by the delegated report",
    );
  }
  // A null configuration is not an empty one. Only a document that is actually
  // there counts as readable; null, absent, or owner-restricted are three
  // separate answers and none of them is "no Install/Start".
  const configuration: ConfigurationReadability =
    info.environmentJsonNote !== undefined
      ? "owner-restricted"
      : info.environmentJson === undefined || info.environmentJson === null
        ? "unknown"
        : "readable";
  const view: EnvironmentView = {
    environmentPublicId: reportedEnvironmentPublicId,
    // Active state is a distinct slot this authority cannot read. It is reported
    // unreadable rather than omitted: absence would read as "none active".
    activeBuild: unreadableActiveBuild(),
    managedAs: managedAsFromPath(info.environmentJsonPath),
    configuration,
    activeBuildReason: ACTIVE_BUILD_UNREADABLE_REASON,
    snapshot: snapshotPreflight({
      ...(info.agentCanUpdateSnapshot === undefined
        ? {}
        : { agentCanUpdateSnapshot: info.agentCanUpdateSnapshot }),
      configuration,
    }),
    trust: DELEGATED_TRUST,
  };
  if (info.name !== undefined) view.name = info.name;
  if (info.environmentVersionPublicId !== undefined) {
    view.environmentVersionPublicId = info.environmentVersionPublicId;
  }
  if (info.environmentJsonPath !== undefined) {
    view.environmentJsonPath = info.environmentJsonPath;
  }
  if (info.environmentDeleted !== undefined) {
    view.environmentDeleted = info.environmentDeleted;
  }
  if (info.build?.buildId !== undefined) view.currentRunBuildId = info.build.buildId;
  if (info.build?.snapshotId !== undefined) {
    view.currentRunSnapshotId = info.build.snapshotId;
  }
  return view;
}

/* ---------------------------------------------------------------- identity gate */

/**
 * Whether the delegated run proved it was talking about the declared environment.
 *
 * The declared id must come from outside the run. An identifier a run reports
 * about itself is self-confirming, so `ungated` is a real state and is never
 * upgraded to `verified` by agreement between two of the run's own answers.
 */
export type IdentityGate = "verified" | "failed" | "unreadable" | "ungated";

export function identityGate(args: {
  declared?: string | undefined;
  reported?: string | undefined;
}): IdentityGate {
  if (args.reported === undefined || args.reported === "") return "unreadable";
  if (args.declared === undefined) return "ungated";
  return args.reported === args.declared ? "verified" : "failed";
}

/* --------------------------------------------------------------- exact matching */

export interface BuildMatch {
  status: "matched" | "absent" | "ambiguous";
  build?: BuildView;
  pagesScanned: number;
  /**
   * True when no unscanned page remained, so `absent` means absent.
   *
   * A new Build is prepended to page 1 and pushes the oldest row off it, so an
   * inconclusive absence is a paging artifact, not a disappearance.
   */
  conclusive: boolean;
  /** Statuses a repeated id disagreed on across pages. */
  conflictingStatuses?: string[];
}

/**
 * Find one exact Build across the pages a delegate returned.
 *
 * `list-environment-builds` has no `buildId` filter, so monitoring one Build is
 * a client-side match. Never by recency, and never by "the newest non-skipped
 * row": both can pin the wrong Build.
 */
export function findBuild(
  pages: DelegatedBuildPage[],
  buildId: string,
  environmentPublicId: string,
): BuildMatch {
  const matches: DelegatedBuildRow[] = [];
  for (const page of pages) {
    for (const row of page.builds) {
      if (row.buildId === buildId) matches.push(row);
    }
  }
  const last = pages.at(-1);
  const conclusive = pages.length > 0 && last?.hasMore !== true;

  if (matches.length === 0) {
    return { status: "absent", pagesScanned: pages.length, conclusive };
  }
  const statuses = [...new Set(matches.map((row) => row.status))];
  if (statuses.length > 1) {
    // The same Build reported two statuses inside one readback: the pages do not
    // describe one instant. Refuse to pick, rather than pick the hopeful one.
    return {
      status: "ambiguous",
      pagesScanned: pages.length,
      conclusive,
      conflictingStatuses: statuses,
    };
  }
  return {
    status: "matched",
    build: projectBuild(matches[0]!, environmentPublicId),
    pagesScanned: pages.length,
    conclusive,
  };
}

/* -------------------------------------------------------------------- monitoring */

export type MonitorStatus =
  | "TERMINAL"
  | "IN_PROGRESS"
  | "TIMED_OUT"
  | "READBACK_STALE"
  | "NOT_FOUND";

export interface MonitorResult {
  status: MonitorStatus;
  buildId: string;
  environmentPublicId: string;
  outcome: BuildOutcome;
  terminal: boolean;
  build?: BuildView;
  attempts: number;
  elapsedMs?: number;
  conclusive: boolean;
  reason: string;
  requiredReadback: string;
  nextSteps: string[];
  trust: typeof DELEGATED_TRUST;
}

const NEVER_RETRIGGER =
  "Do not trigger another Build: trigger-environment-build has no idempotency key, so a " +
  "second call is a second write.";

/**
 * Classify one monitoring readback of an exact Build.
 *
 * `previousStatus` is what the caller last saw, passed back in -- this server
 * stores nothing between calls. It is what makes a *stale* readback detectable:
 * a Build that was terminal cannot become non-terminal, and a row that was seen
 * cannot vanish from a fully-paged readback.
 */
export function monitorOutcome(args: {
  buildId: string;
  environmentPublicId: string;
  match: BuildMatch;
  previousStatus?: string | undefined;
  attempts?: number | undefined;
  elapsedMs?: number | undefined;
  deadlineExceeded?: boolean | undefined;
}): MonitorResult {
  const base = {
    buildId: args.buildId,
    environmentPublicId: args.environmentPublicId,
    attempts: args.attempts ?? 0,
    conclusive: args.match.conclusive,
    trust: DELEGATED_TRUST,
    ...(args.elapsedMs === undefined ? {} : { elapsedMs: args.elapsedMs }),
  };
  const rowReadback = `a list-environment-builds row for ${args.buildId} matched client-side on the exact id`;

  if (args.match.status === "ambiguous") {
    return {
      ...base,
      status: "READBACK_STALE",
      outcome: "unknown",
      terminal: false,
      reason:
        `The readback reported ${args.buildId} with more than one status ` +
        `(${(args.match.conflictingStatuses ?? []).join(", ")}), so the pages do not describe one instant.`,
      requiredReadback: rowReadback,
      nextSteps: ["Read the Build again once; do not adopt either status.", NEVER_RETRIGGER],
    };
  }

  if (args.match.status === "absent") {
    // A row that was already observed cannot disappear from a fully-paged
    // readback. Absent-and-conclusive after a sighting is staleness, not a
    // missing Build.
    const vanished = args.previousStatus !== undefined && args.match.conclusive;
    return {
      ...base,
      status: vanished ? "READBACK_STALE" : "NOT_FOUND",
      outcome: "unknown",
      terminal: false,
      reason: vanished
        ? `Build ${args.buildId} was previously reported as ${args.previousStatus} and is now absent from a fully paged readback.`
        : args.match.conclusive
          ? `Build ${args.buildId} is not in this environment's Build list.`
          : `Build ${args.buildId} was not on the pages read, and further pages remained.`,
      requiredReadback: rowReadback,
      nextSteps: args.match.conclusive
        ? ["Confirm the buildId and the environment.", NEVER_RETRIGGER]
        : ["Page forward before concluding the Build is absent.", NEVER_RETRIGGER],
    };
  }

  const build = args.match.build!;
  const regressed =
    args.previousStatus !== undefined &&
    args.previousStatus !== build.status &&
    isTerminalBuild(args.previousStatus);
  if (regressed) {
    return {
      ...base,
      status: "READBACK_STALE",
      outcome: build.outcome,
      terminal: build.terminal,
      build,
      reason:
        `Build ${args.buildId} was previously terminal as ${args.previousStatus} and now reads ` +
        `${build.status}; a terminal Build does not change again.`,
      requiredReadback: rowReadback,
      nextSteps: ["Read the Build again once; do not adopt the newer status.", NEVER_RETRIGGER],
    };
  }

  if (build.terminal) {
    return {
      ...base,
      status: "TERMINAL",
      outcome: build.outcome,
      terminal: true,
      build,
      reason: terminalReason(build),
      requiredReadback: rowReadback,
      nextSteps: terminalNextSteps(build),
    };
  }

  if (args.deadlineExceeded === true) {
    return {
      ...base,
      status: "TIMED_OUT",
      outcome: build.outcome,
      terminal: false,
      build,
      reason:
        `Monitoring stopped at status ${build.status} without a terminal state. The Build may ` +
        "still be running; the wait ended, the Build did not.",
      requiredReadback: rowReadback,
      nextSteps: [
        "Read the same buildId again to reach a terminal state.",
        NEVER_RETRIGGER,
      ],
    };
  }

  return {
    ...base,
    status: "IN_PROGRESS",
    outcome: build.outcome,
    terminal: false,
    build,
    reason:
      build.outcome === "unknown"
        ? `Build ${args.buildId} reports the unrecognised status ${build.status}, which is not treated as terminal or successful.`
        : `Build ${args.buildId} is ${build.status}.`,
    requiredReadback: rowReadback,
    nextSteps: [
      "Read the same buildId again; Build logs materialise only at a terminal state.",
      NEVER_RETRIGGER,
    ],
  };
}

function terminalReason(build: BuildView): string {
  switch (build.outcome) {
    case "succeeded":
      return (
        `Build ${build.buildId} SUCCEEDED. That is not activation: a successful Build is not ` +
        "the environment's active Build, and this authority cannot read active state."
      );
    case "failed":
      return (
        `Build ${build.buildId} FAILED` +
        (build.failureType === undefined || build.failureType === null
          ? "."
          : ` (${build.failureType}).`) +
        " The previously active Build is not claimed preserved, because it was never readable."
      );
    case "skipped":
      return (
        `Build ${build.buildId} was SKIPPED. Skipped is terminal and informative -- Cursor had ` +
        "nothing to rebuild -- and is neither a failure nor a cancellation. It consumes the " +
        "trigger budget."
      );
    case "cancelled":
      return (
        `Build ${build.buildId} is CANCELLED. No delegated operation can produce that status, so ` +
        "it was cancelled outside this server."
      );
    default:
      return `Build ${build.buildId} reports ${build.status}.`;
  }
}

function terminalNextSteps(build: BuildView): string[] {
  const steps: string[] = [];
  if (build.outcome === "succeeded" || build.outcome === "failed") {
    steps.push("Fetch the Build's logs; they are one combined install-and-setup stream.");
  }
  if (build.outcome === "skipped") {
    steps.push("Do not re-trigger: a skipped Build is a terminal close, not a retry licence.");
  }
  steps.push(
    "Activation is an owner action; read active state as unverified rather than inferring it.",
  );
  return steps;
}

/* ------------------------------------------------------------------- triggering */

export type TriggerStatus =
  | "ADOPTED"
  | "NOT_DISPATCHED"
  | "PRECONDITION_UNMET"
  | "IDENTITY_GATE_FAILED"
  | "NOT_ACCEPTED_UNKNOWN"
  | "ATTRIBUTION_AMBIGUOUS";

export interface TriggerAttribution {
  status: TriggerStatus;
  buildId?: string;
  /** How the id was obtained. A baseline difference is weaker than a returned id. */
  source: "trigger-result" | "baseline-difference" | "none";
  /** null means the delegate did not prove whether request bytes were sent. */
  dispatched: boolean | null;
  isDraft?: boolean;
  createdDraftEnvironment?: boolean;
  candidates?: string[];
  reason: string;
  requiredReadback: string;
  nextSteps: string[];
  trust: typeof DELEGATED_TRUST;
}

/**
 * Decide which Build, if any, a dispatched trigger produced.
 *
 * The order matters. Identity is checked before attribution, because a Build in
 * the wrong environment must never be adopted; and "did not dispatch" is
 * separated from "dispatched, outcome unknown", because only the first is safe
 * to retry.
 *
 * When the trigger result carried no id, the candidates are the rows absent from
 * the pre-trigger baseline. Exactly one may be adopted. Zero is
 * `NOT_ACCEPTED_UNKNOWN`; two or more voids attribution. Never by recency, and
 * never preferring a non-`SKIPPED` row.
 */
export function attributeTriggeredBuild(args: {
  declaredEnvironmentPublicId: string;
  reportedEnvironmentPublicId?: string | undefined;
  dispatched?: boolean | undefined;
  precondition?: string | undefined;
  trigger?: DelegatedTriggerResult | undefined;
  baselineBuildIds?: string[] | undefined;
  rows?: DelegatedBuildRow[] | undefined;
  otherActiveRuns?: number | undefined;
}): TriggerAttribution {
  const rowReadback =
    "a list-environment-builds row for the adopted buildId, matched client-side on the exact id";
  const base = {
    dispatched: args.dispatched ?? null,
    trust: DELEGATED_TRUST,
    requiredReadback: rowReadback,
  };

  const gate = identityGate({
    declared: args.declaredEnvironmentPublicId,
    reported: args.reportedEnvironmentPublicId,
  });
  if (gate === "failed" || gate === "unreadable") {
    return {
      ...base,
      status: "IDENTITY_GATE_FAILED",
      source: "none",
      reason:
        gate === "failed"
          ? `The delegated run reported environment ${args.reportedEnvironmentPublicId}, not the declared ${args.declaredEnvironmentPublicId}. No Build is adopted.`
          : "The delegated run reported no environmentPublicId, so the target could not be gated against the declared id. No Build is adopted.",
      nextSteps: [
        "Confirm the environment name and the out-of-band declared environmentPublicId, then inspect before triggering again.",
        NEVER_RETRIGGER,
      ],
    };
  }

  if (args.precondition !== undefined && args.precondition !== "") {
    if (args.dispatched !== false || args.trigger !== undefined) {
      return {
        ...base,
        status: "NOT_ACCEPTED_UNKNOWN",
        source: "none",
        reason:
          "The delegated report claimed a pre-trigger stop but did not prove that no trigger " +
          "was dispatched. The write outcome is unknown.",
        nextSteps: [
          "Read the Build list and reconcile exact identifiers before acting.",
          NEVER_RETRIGGER,
        ],
      };
    }
    return {
      ...base,
      status: "PRECONDITION_UNMET",
      source: "none",
      dispatched: false,
      reason:
        `The delegated run stopped before triggering: ${args.precondition}. A non-terminal ` +
        "baseline row, or another active run against the environment, removes the exclusivity " +
        "attribution depends on.",
      nextSteps: [
        "Wait for the environment's in-flight Build and other runs to finish, then trigger once.",
      ],
    };
  }

  if (args.dispatched === undefined) {
    return {
      ...base,
      status: "NOT_ACCEPTED_UNKNOWN",
      source: "none",
      reason:
        "The delegated report omitted triggerDispatched, so it did not prove whether request " +
        "bytes reached Cursor. The write outcome is unknown.",
      nextSteps: [
        "Read the Build list and reconcile exact identifiers before acting.",
        NEVER_RETRIGGER,
      ],
    };
  }

  if (args.dispatched === false) {
    if (args.trigger !== undefined) {
      return {
        ...base,
        status: "NOT_ACCEPTED_UNKNOWN",
        source: "none",
        reason:
          "The delegated report says no trigger was dispatched but also contains a trigger " +
          "result. The write outcome is contradictory and unknown.",
        nextSteps: [
          "Read the Build list and reconcile exact identifiers before acting.",
          NEVER_RETRIGGER,
        ],
      };
    }
    return {
      ...base,
      status: "NOT_DISPATCHED",
      source: "none",
      reason:
        "No trigger was dispatched, so nothing was written. This is the one trigger state that " +
        "is safe to retry.",
      nextSteps: [
        "It is safe to retry once because the report explicitly proves no request bytes reached Cursor.",
      ],
    };
  }

  const returnedId = args.trigger?.buildId;
  const draftFlags = {
    ...(args.trigger?.isDraft === undefined ? {} : { isDraft: args.trigger.isDraft }),
    ...(args.trigger?.createdDraftEnvironment === undefined
      ? {}
      : { createdDraftEnvironment: args.trigger.createdDraftEnvironment }),
  };

  if (returnedId !== undefined && returnedId !== "") {
    return {
      ...base,
      ...draftFlags,
      status: "ADOPTED",
      buildId: returnedId,
      source: "trigger-result",
      reason:
        "The trigger returned an exact buildId. Its status, source, and triggerType are absent " +
        "from that result and come only from a list readback.",
      nextSteps: [
        "Monitor that exact buildId to a terminal status.",
        "A draft Build never becomes the Build new agents boot from.",
      ],
    };
  }

  const baseline = new Set(args.baselineBuildIds ?? []);
  const candidates = (args.rows ?? [])
    .filter((row) => !baseline.has(row.buildId))
    .map((row) => row.buildId);
  const unique = [...new Set(candidates)];

  if (
    unique.length === 1 &&
    (args.otherActiveRuns === undefined || args.otherActiveRuns > 0)
  ) {
    // Attribution by difference depends on this server's write being the only
    // one in the window. Another active run removes that, so the single new row
    // cannot be claimed as ours.
    return {
      ...base,
      ...draftFlags,
      status: "ATTRIBUTION_AMBIGUOUS",
      source: "none",
      candidates: unique,
      reason:
        args.otherActiveRuns === undefined
          ? "One row was absent from the pre-trigger baseline, but the delegate did not attest whether another run was active, so that row cannot be attributed to this trigger."
          : `One row was absent from the pre-trigger baseline, but ${args.otherActiveRuns} other run(s) ` +
            "were active against this environment, so that row cannot be attributed to this trigger.",
      nextSteps: [
        "Identify the Build from its own identifiers before acting on it.",
        NEVER_RETRIGGER,
      ],
    };
  }

  if (unique.length === 1) {
    return {
      ...base,
      ...draftFlags,
      status: "ADOPTED",
      buildId: unique[0]!,
      source: "baseline-difference",
      reason:
        "The trigger result carried no buildId, and exactly one row was absent from the " +
        "pre-trigger baseline, so that row is the Build.",
      nextSteps: [
        "Monitor that exact buildId to a terminal status.",
        "Re-read the baseline before any further trigger; a new Build is prepended to page 1.",
      ],
    };
  }

  if (unique.length === 0) {
    return {
      ...base,
      ...draftFlags,
      status: "NOT_ACCEPTED_UNKNOWN",
      source: "none",
      reason:
        "The trigger was dispatched, returned no buildId, and no new Build row appeared. The " +
        "write outcome is unknown.",
      nextSteps: [
        "Read the Build list again before concluding anything; page forward past page 1.",
        NEVER_RETRIGGER,
      ],
    };
  }

  return {
    ...base,
    ...draftFlags,
    status: "ATTRIBUTION_AMBIGUOUS",
    source: "none",
    candidates: unique,
    reason:
      `${unique.length} rows were absent from the pre-trigger baseline, so attribution is void. ` +
      "Adopting by recency, or preferring a non-SKIPPED row, can pin the wrong Build.",
    nextSteps: [
      "Identify the Build from its own identifiers before acting on it.",
      NEVER_RETRIGGER,
    ],
  };
}

/**
 * A host-wide manual Build, which no supported authority exposes.
 *
 * The proven programmatic trigger is a draft Build, scoped to the delegated
 * run's own environment and non-activating by its own contract. One tool, two
 * capability outcomes.
 */
export function manualTriggerResidual(environmentPublicId: string): OwnerActionResidual {
  return ownerActionResidual({
    action: "TRIGGER_BUILD",
    authority: "browser-session",
    environmentPublicId,
    reason:
      "No published API-key, SDK, or delegated Cloud MCP operation triggers a host-wide manual " +
      "Build. The delegated trigger produces a DRAFT Build that never becomes the Build new " +
      "agents boot from, so it is not a substitute.",
    requiredReadback:
      "a list-environment-builds row for the new buildId with a non-draft trigger and a terminal status",
    nextSteps: [
      "Trigger the Build from the environment dashboard, then monitor the exact buildId here.",
      "Or trigger a draft Build with kind=draft to test configuration without activating it.",
    ],
  });
}

/* ----------------------------------------------------------------- cancellation */

/**
 * Build cancel: absent from a live 14-tool delegated census, from the published
 * API key, and from the SDK.
 *
 * Run cancellation is a different resource and must never substitute: the
 * OpenAPI cancel path is run-scoped. `CANCELLED` being an accepted Build filter
 * value is a status vocabulary, not a reachable operation.
 */
export function cancelBuildResidual(args: {
  environmentPublicId: string;
  buildId: string;
}): OwnerActionResidual {
  return ownerActionResidual({
    action: "CANCEL_BUILD",
    authority: "browser-session",
    environmentPublicId: args.environmentPublicId,
    buildId: args.buildId,
    reason:
      "No published API-key, SDK, or delegated Cloud MCP Build-cancel operation exists. The live " +
      "delegated tool census contained no cancel operation and no tool accepting a Build-cancel " +
      "argument. Run cancellation is a different resource and must not be used.",
    requiredReadback:
      "a list-environment-builds row for that buildId with a terminal cancelled status",
    nextSteps: [
      "Cancel the Build from the environment dashboard, then read the buildId back here.",
      "Do not cancel a run instead: cursor_cancel_run stops an agent run, not a Build.",
    ],
  });
}

/* --------------------------------------------------------- synchronization */

/**
 * The only `triggerType` that attributes a Build to a configuration change.
 *
 * `source` is not a discriminator: `MANUAL` cannot separate a dashboard trigger
 * from an agent trigger, and `source=WEBSITE` is not Save attribution. A secrets
 * change also emits `CONFIG_CHANGE`, so the change window must exclude one.
 */
export const CONFIG_CHANGE_TRIGGER = "CONFIG_CHANGE";

/** The one readback that proves a database-managed Save, stated once. */
const SAVE_READBACK =
  "a new environmentVersionPublicId on a freshly booted run, plus a list-environment-builds " +
  "row with triggerType=CONFIG_CHANGE and an environmentVersionId absent from the recorded " +
  "baseline set";

/**
 * Persisting a definition, which no programmatic authority does.
 *
 * The managed type selects the owner authority and is read from
 * `environmentJsonPath` alone -- null is database-managed, a path is
 * repository-file managed, and an omitted value is *unknown*, which is a stop
 * rather than a default. Probing the managed type by submitting `environmentJson`
 * to a Build trigger is never an option: on a database-managed environment that
 * call succeeds and burns a real Build.
 *
 * No `buildId` is ever attached. A Build id is not a Save receipt, and a stale
 * one invites a Save that adopts a stale snapshot.
 */
export function saveEnvironmentResidual(args: {
  environmentPublicId: string;
  /** Exactly as read from `environment-info`. `undefined` means unknown. */
  environmentJsonPath?: string | null | undefined;
  /** The baseline version, which is the anchor a later Restore would target. */
  environmentVersionPublicId?: string | undefined;
}): OwnerActionResidual {
  const version =
    args.environmentVersionPublicId === undefined
      ? {}
      : { environmentVersionPublicId: args.environmentVersionPublicId };

  if (args.environmentJsonPath === null) {
    return ownerActionResidual({
      action: "SAVE_ENVIRONMENT",
      authority: "browser-session",
      environmentPublicId: args.environmentPublicId,
      ...version,
      reason:
        "No published API-key, SDK, or delegated Cloud MCP save operation exists. A live " +
        "delegated tool census contained no save, restore, activate, or deactivate tool, and " +
        "propose-environment-json records owner-visible review state without persisting " +
        "anything. Save is documented to mint a version and fire a CONFIG_CHANGE Build, so it " +
        "is not a cheap metadata write.",
      requiredReadback: SAVE_READBACK,
      nextSteps: [
        "Open the pre-declared environment, verified out of band rather than through a URL a run reported, and discard any stale pending proposal.",
        "Press Save exactly once, and change no secret in the same window: a secrets change also emits CONFIG_CHANGE.",
        "Read back from a second, freshly booted run; a same-run readback is indeterminate, not a failed Save.",
        "Keep the baseline environmentVersionPublicId: it is the anchor a later Restore would target.",
      ],
    });
  }

  if (typeof args.environmentJsonPath === "string") {
    return ownerActionResidual({
      action: "SAVE_ENVIRONMENT",
      authority: "repo-commit",
      environmentPublicId: args.environmentPublicId,
      ...version,
      reason:
        `The configuration of record is the file at ${args.environmentJsonPath} on the default ` +
        "branch, and this server does not write your repository. A dashboard Save does not " +
        "apply here: the committed file wins over a saved environment.",
      requiredReadback:
        `the default-branch commit SHA of ${args.environmentJsonPath}, plus a freshly booted ` +
        "run whose environment-info matches it with the path still present",
      nextSteps: [
        `Commit ${args.environmentJsonPath} to the default branch yourself.`,
        "One commit only: verify the remote ref before any second push, and never amend as a retry.",
        "A repository change is not among the documented Build triggers, so an immediate automatic Build is unproven; a later non-skipped recurring row means the schedule consumed the commit.",
      ],
    });
  }

  return ownerActionResidual({
    status: "CAPABILITY_UNCERTAIN",
    action: "SAVE_ENVIRONMENT",
    authority: "delegated-run",
    environmentPublicId: args.environmentPublicId,
    ...version,
    reason:
      "environmentJsonPath was not supplied, so it is unknown whether the file or the database " +
      "is the configuration of record. Persisting without knowing that could change what every " +
      "user of the repository resolves.",
    requiredReadback:
      "environmentJsonPath from environment-info: null is database-managed, a path is repository-file managed",
    nextSteps: [
      "Inspect the environment, record environmentJsonPath, and synchronize with that value.",
      "Never probe the managed type by submitting environmentJson to a Build trigger: on a database-managed environment that call succeeds and burns a real Build.",
    ],
  });
}

/** A Build row as a caller passes it back for Save attribution. */
export interface SaveCandidateRow {
  buildId: string;
  status: string;
  triggerType?: string | undefined;
  environmentPublicId?: string | undefined;
  /** Numeric/internal. Never the public `environmentVersionPublicId`. */
  environmentVersionId?: number | undefined;
  createdAtMs?: number | undefined;
}

export type SavePersistenceStatus = "PERSISTED" | "NOT_PERSISTED" | "INDETERMINATE";

/** How the configuration-change Build was resolved, if it was resolved at all. */
export type SaveBuildAttribution =
  | "attributed"
  | "no-candidate"
  | "ambiguous"
  | "not-checked";

export interface SaveVerification {
  status: SavePersistenceStatus;
  environmentPublicId: string;
  /** Whether the readback came from a run that booted after the Save. */
  freshlyBooted: boolean;
  baselineVersionPublicId?: string;
  observedVersionPublicId?: string;
  /** null when no version comparison could be made at all. */
  versionChanged: boolean | null;
  /**
   * The content half of a persistence check, which is never available: saved
   * Install/Start is owner-restricted on personal and override environments, so
   * "saved configuration equals the intended document" cannot be checked here.
   */
  configurationContent: "CONFIG_CONTENT_UNREADABLE";
  buildAttribution: SaveBuildAttribution;
  attributedBuildId?: string;
  /** Every row that met the candidate rule. Two or more voids attribution. */
  candidates?: string[];
  reason: string;
  requiredReadback: string;
  nextSteps: string[];
  trust: typeof DELEGATED_TRUST;
}

/**
 * Judge whether an owner Save actually persisted, from readback the caller holds.
 *
 * The evidence ladder is defined by the Save contract. A Build is attributed only when
 * it carries `triggerType=CONFIG_CHANGE`, belongs to the declared environment, was
 * absent from the paged baseline, carries a numeric `environmentVersionId` absent
 * from the baseline set, and is the *only* such row. Zero candidates is unknown;
 * two or more void attribution. Never by recency.
 *
 * A version comparison counts only from a freshly booted run: a same-run
 * unchanged reading cannot distinguish live-and-unchanged from frozen-at-boot, so
 * it is indeterminate rather than a failed Save.
 */
export function verifySaveEffect(args: {
  environmentPublicId: string;
  /** The caller's assertion that the readback run booted after the Save. */
  freshlyBooted: boolean;
  /** True only when Save was the sole configuration mutation in the window. */
  exclusiveChangeWindow: boolean;
  changeStartedAtMs?: number | undefined;
  changeEndedAtMs?: number | undefined;
  queueAllowanceMs?: number | undefined;
  baselineVersionPublicId?: string | undefined;
  observedVersionPublicId?: string | undefined;
  baselineBuildIds?: string[] | undefined;
  baselineEnvironmentVersionIds?: number[] | undefined;
  rows?: SaveCandidateRow[] | undefined;
}): SaveVerification {
  const baselineBuilds = new Set(args.baselineBuildIds ?? []);
  const baselineVersions = new Set(args.baselineEnvironmentVersionIds ?? []);

  let buildAttribution: SaveBuildAttribution = "not-checked";
  let candidates: string[] = [];
  const completeBuildEvidence =
    args.exclusiveChangeWindow &&
    args.rows !== undefined &&
    args.baselineBuildIds !== undefined &&
    args.baselineEnvironmentVersionIds !== undefined &&
    args.changeStartedAtMs !== undefined &&
    args.changeEndedAtMs !== undefined &&
    args.changeEndedAtMs >= args.changeStartedAtMs;
  if (completeBuildEvidence) {
    const latestAcceptedMs =
      args.changeEndedAtMs! + Math.max(0, args.queueAllowanceMs ?? 0);
    candidates = [
      ...new Set(
        args.rows!
          .filter(
            (row) =>
              row.triggerType === CONFIG_CHANGE_TRIGGER &&
              !baselineBuilds.has(row.buildId) &&
              row.environmentPublicId === args.environmentPublicId &&
              row.createdAtMs !== undefined &&
              row.createdAtMs >= args.changeStartedAtMs! &&
              row.createdAtMs <= latestAcceptedMs &&
              // A row without a numeric version cannot satisfy the ladder's
              // version-creation half, so it is not a candidate at all.
              row.environmentVersionId !== undefined &&
              !baselineVersions.has(row.environmentVersionId),
          )
          .map((row) => row.buildId),
      ),
    ];
    buildAttribution =
      candidates.length === 1
        ? "attributed"
        : candidates.length === 0
          ? "no-candidate"
          : "ambiguous";
  }

  const comparable =
    args.freshlyBooted &&
    args.observedVersionPublicId !== undefined &&
    args.baselineVersionPublicId !== undefined;
  const versionChanged = comparable
    ? args.observedVersionPublicId !== args.baselineVersionPublicId
    : null;

  const view: SaveVerification = {
    status: "INDETERMINATE",
    environmentPublicId: args.environmentPublicId,
    freshlyBooted: args.freshlyBooted,
    versionChanged,
    configurationContent: "CONFIG_CONTENT_UNREADABLE",
    buildAttribution,
    reason: "",
    requiredReadback: SAVE_READBACK,
    nextSteps: [],
    trust: DELEGATED_TRUST,
  };
  if (args.baselineVersionPublicId !== undefined) {
    view.baselineVersionPublicId = args.baselineVersionPublicId;
  }
  if (args.observedVersionPublicId !== undefined) {
    view.observedVersionPublicId = args.observedVersionPublicId;
  }
  if (candidates.length > 0) view.candidates = candidates;
  const attributed = buildAttribution === "attributed" ? candidates[0] : undefined;
  if (attributed !== undefined) view.attributedBuildId = attributed;

  if (attributed !== undefined && versionChanged === false) {
    view.reason =
      `Build ${attributed} meets the CONFIG_CHANGE candidate rule, but a freshly booted run ` +
      "reported the baseline environmentVersionPublicId unchanged. The readbacks conflict, so persistence is not claimed.";
    view.nextSteps = [
      "Repeat only the readback from another freshly booted run; do not repeat Save.",
      "Re-page Build history and preserve both conflicting identifiers for owner review.",
    ];
    return view;
  }

  if (attributed !== undefined) {
    view.status = "PERSISTED";
    view.reason =
      `Build ${attributed} carries triggerType=CONFIG_CHANGE, was absent from the baseline, ` +
      "and carries a numeric environmentVersionId absent from the baseline set, so a version " +
      "was created. That Build is not the active Build, and its status is not activation.";
    view.nextSteps = [
      "Record the new environmentVersionPublicId; the previous one is the anchor a later Restore would target.",
      "Monitor that exact buildId to a terminal status. A SUCCEEDED Build is still not the active Build.",
    ];
    return view;
  }

  if (versionChanged === true && args.exclusiveChangeWindow) {
    view.status = "PERSISTED";
    view.reason =
      "A freshly booted run reported a different environmentVersionPublicId than the baseline, " +
      "so the configuration persisted. The saved document itself is owner-restricted, so the " +
      "content half of the check is unavailable rather than matched." +
      (buildAttribution === "ambiguous"
        ? ` ${candidates.length} rows met the candidate rule, so no Build is attributed to this Save.`
        : "");
    view.nextSteps = [
      "Record the new environmentVersionPublicId; the previous one is the anchor a later Restore would target.",
      "Find the configuration-change Build by the candidate rule if you need it; never attribute by recency.",
    ];
    return view;
  }

  if (versionChanged === false && buildAttribution === "no-candidate") {
    view.status = "NOT_PERSISTED";
    view.reason =
      "A freshly booted run reported the baseline environmentVersionPublicId unchanged, and no " +
      "Build row met the configuration-change candidate rule. Nothing was persisted.";
    view.nextSteps = [
      "Confirm the owner pressed Save on the pre-declared environment, then read back from another freshly booted run.",
      "Do not retry a write here: no supported authority saves configuration, so there is nothing to retry.",
    ];
    return view;
  }

  view.reason =
    !args.exclusiveChangeWindow
      ? "The caller did not attest that Save was the only configuration mutation in the change window, so persistence cannot be attributed to that Save."
      : buildAttribution === "ambiguous"
      ? `${candidates.length} rows met the configuration-change candidate rule, so attribution is void and persistence is unproven.`
      : buildAttribution === "not-checked" && versionChanged === false
        ? "The freshly booted run reported the baseline version unchanged, but the Build readback did not include the complete baseline and bounded change window needed to prove there was no configuration-change candidate."
      : args.freshlyBooted
        ? "A version comparison needs both the baseline and an observed environmentVersionPublicId; one of them is missing, so persistence is unproven."
        : "The readback did not come from a freshly booted run. A same-run reading cannot distinguish live-and-unchanged from frozen-at-boot, so it is indeterminate rather than a failed Save.";
  view.nextSteps = [
    "Read back from a second, freshly booted run, with the baseline version recorded before the Save.",
    "Page the Build list forward: a new Build is prepended to page 1 and pushes the oldest row off it.",
  ];
  return view;
}

/* ------------------------------------------ activation, restore, rollback */

/**
 * The numeric Build-row `environmentVersionId` is never the public version id.
 *
 * They are separate identifier types, and an all-digits value in a public-version
 * argument is the confusion this rejects before it targets a mutation.
 */
export function looksLikeNumericVersionId(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

/** The three Build-family promotions, which never share a code path. */
export type PromotionOperation = "activate" | "deactivate" | "rollback";

/** The Build facts a caller read back before asking for a promotion. */
export interface ObservedBuild {
  buildId: string;
  status: string;
  /** The environment on that Build row, when the row carried one. */
  environmentPublicId?: string | undefined;
  /**
   * How that id was obtained. Omitted provenance is unproven and fails closed;
   * only an explicit `row` value says the readback itself carried the id.
   */
  environmentPublicIdSource?: EnvironmentIdentitySource | undefined;
  isDraft?: boolean | undefined;
  /** When the row was read, for callers that check freshness. */
  observedAtMs?: number | undefined;
}

/**
 * Why an operation is refused, as one stable vocabulary.
 *
 * There is exactly one list: identity refusals and Build-qualification refusals
 * share it, so a caller does not have to reconcile two overlapping policies for
 * the same operation. Codes are added, never renamed.
 */
export type EligibilityCode =
  | "ELIGIBLE"
  | "BUILD_ID_MISMATCH"
  | "WRONG_ENVIRONMENT"
  | "ENVIRONMENT_UNPROVEN"
  | "ENVIRONMENT_IMPUTED"
  | "IDENTITY_CONFLICTING"
  | "IDENTITY_STALE"
  | "NOT_TERMINAL"
  | "NOT_SUCCEEDED"
  | "UNKNOWN_STATUS"
  | "DRAFT"
  | "DRAFT_STATE_UNKNOWN"
  | "SUPERSEDED_BUILD_REQUIRED"
  | "SAME_BUILD";

/**
 * How old identity evidence may be and still authorize a mutation.
 *
 * Only applied when the caller supplies a clock, because a caller that supplies
 * none is not claiming freshness at all. Ten minutes is well inside a Build's own
 * runtime, so a row read before a Build finished cannot authorize its promotion.
 */
export const MAX_IDENTITY_EVIDENCE_AGE_MS = 600_000;

export interface IdentityDecision {
  code: EligibilityCode;
  authoritative: boolean;
  reason: string;
}

/**
 * Whether the environment id on a read-back row is authoritative enough to
 * authorize a mutation against the declared environment.
 *
 * Displaying an id and acting on one are different bars. A Build row whose
 * environment id was filled in from page or request context agrees with the
 * declared id by construction, so it can never disagree, so it proves nothing.
 * Absent, imputed, conflicting, and stale evidence all fail closed with their own
 * code rather than collapsing into one "wrong environment".
 */
export function authoritativeEnvironmentIdentity(args: {
  declaredEnvironmentPublicId: string;
  /** The id on the row, exactly as read. */
  environmentPublicId?: string | undefined;
  source?: EnvironmentIdentitySource | undefined;
  /** Every id the same readback reported, when the caller collected them. */
  reportedEnvironmentPublicIds?: string[] | undefined;
  observedAtMs?: number | undefined;
  /** Supplying a clock opts into the freshness check. */
  nowMs?: number | undefined;
  maxAgeMs?: number | undefined;
}): IdentityDecision {
  const distinct = [
    ...new Set((args.reportedEnvironmentPublicIds ?? []).filter((id) => id !== "")),
  ];
  if (distinct.length > 1) {
    return {
      code: "IDENTITY_CONFLICTING",
      authoritative: false,
      reason:
        `The readback reported more than one environment (${distinct.join(", ")}), so it does not ` +
        "describe one environment and no part of it authorizes a mutation.",
    };
  }

  if (args.environmentPublicId === undefined || args.environmentPublicId === "") {
    return {
      code: "ENVIRONMENT_UNPROVEN",
      authoritative: false,
      reason:
        "The row carries no environmentPublicId, so membership in " +
        `${args.declaredEnvironmentPublicId} is unproven.`,
    };
  }

  if (args.source !== "row") {
    return {
      code: "ENVIRONMENT_IMPUTED",
      authoritative: false,
      reason:
        `The environmentPublicId ${args.environmentPublicId} was filled in from page or request ` +
        "context, or its provenance was omitted, rather than proven read from the row. A projected identity may be displayed, but it " +
        "agrees with the declared id by construction, so it authorizes nothing.",
    };
  }

  if (args.environmentPublicId !== args.declaredEnvironmentPublicId) {
    return {
      code: "WRONG_ENVIRONMENT",
      authoritative: false,
      reason:
        `The row was read back in environment ${args.environmentPublicId}, not the declared ` +
        `${args.declaredEnvironmentPublicId}. A row of another environment never authorizes a mutation.`,
    };
  }

  if (args.nowMs !== undefined) {
    const maxAgeMs = args.maxAgeMs ?? MAX_IDENTITY_EVIDENCE_AGE_MS;
    if (args.observedAtMs === undefined) {
      return {
        code: "IDENTITY_STALE",
        authoritative: false,
        reason:
          "Freshness was requested but the row carries no observedAtMs, so its age is unknown. " +
          "Unknown age is not fresh.",
      };
    }
    const ageMs = args.nowMs - args.observedAtMs;
    if (ageMs < 0 || ageMs > maxAgeMs) {
      return {
        code: "IDENTITY_STALE",
        authoritative: false,
        reason:
          ageMs < 0
            ? "The row reports observedAtMs in the future relative to the supplied clock, so its age cannot be trusted."
            : `The row was read ${ageMs}ms ago, beyond the ${maxAgeMs}ms identity-evidence bound. Read it again before mutating.`,
      };
    }
  }

  return {
    code: "ELIGIBLE",
    authoritative: true,
    reason:
      `The row's own environmentPublicId reads ${args.environmentPublicId}, matching the ` +
      "declared id, so its environment membership is proven.",
  };
}

/**
 * Whether a Build *would* be eligible if a promotion operation existed.
 *
 * Qualification failures are typed client errors, not owner residuals: a residual
 * says "an owner can do this in the dashboard", which is the wrong answer for a
 * Build that must not be promoted at all. Only an eligible target earns a
 * residual.
 */
export interface PromotionEligibility {
  code: EligibilityCode;
  eligible: boolean;
  reason: string;
}

export function promotionEligibility(args: {
  operation: PromotionOperation;
  declaredEnvironmentPublicId: string;
  requestedBuildId: string;
  build: ObservedBuild;
  /** The Build the caller believes is active, for a rollback. */
  supersededBuildId?: string | undefined;
  /** Every environment id the same readback reported, when the caller has them. */
  reportedEnvironmentPublicIds?: string[] | undefined;
  /** Supplying a clock opts into the identity-evidence freshness bound. */
  nowMs?: number | undefined;
  maxIdentityAgeMs?: number | undefined;
}): PromotionEligibility {
  const target = args.requestedBuildId;

  if (args.build.buildId !== target) {
    return {
      code: "BUILD_ID_MISMATCH",
      eligible: false,
      reason:
        `The observed row is for ${args.build.buildId}, not the requested Build ${target}. ` +
        "Facts from one Build must never qualify another.",
    };
  }

  // Identity before qualification, and authoritative identity before any of it:
  // a Build in the wrong environment, or one whose environment was never read,
  // must not reach a status check at all.
  const identity = authoritativeEnvironmentIdentity({
    declaredEnvironmentPublicId: args.declaredEnvironmentPublicId,
    ...(args.build.environmentPublicId === undefined
      ? {}
      : { environmentPublicId: args.build.environmentPublicId }),
    ...(args.build.environmentPublicIdSource === undefined
      ? {}
      : { source: args.build.environmentPublicIdSource }),
    ...(args.reportedEnvironmentPublicIds === undefined
      ? {}
      : { reportedEnvironmentPublicIds: args.reportedEnvironmentPublicIds }),
    ...(args.build.observedAtMs === undefined
      ? {}
      : { observedAtMs: args.build.observedAtMs }),
    ...(args.nowMs === undefined ? {} : { nowMs: args.nowMs }),
    ...(args.maxIdentityAgeMs === undefined ? {} : { maxAgeMs: args.maxIdentityAgeMs }),
  });
  if (!identity.authoritative) {
    return {
      code: identity.code,
      eligible: false,
      reason: `Build ${target}: ${identity.reason}`,
    };
  }

  if (
    args.operation === "rollback" &&
    args.supersededBuildId === undefined
  ) {
    return {
      code: "SUPERSEDED_BUILD_REQUIRED",
      eligible: false,
      reason:
        "Rollback requires the exact Build the caller believes will be superseded; the server never guesses current or latest.",
    };
  }

  if (
    args.operation === "rollback" &&
    args.supersededBuildId === target
  ) {
    return {
      code: "SAME_BUILD",
      eligible: false,
      reason:
        `The rollback target and the superseded Build are both ${target}. A rollback names a ` +
        "different prior Build; this server never guesses one.",
    };
  }

  // Deactivation names no replacement and does not promote the named Build, so
  // success/draft qualification is inapplicable after exact identity is proven.
  if (args.operation === "deactivate") {
    return {
      code: "ELIGIBLE",
      eligible: true,
      reason:
        `Build ${target} is in the declared environment, so an owner may address that exact ` +
        "Build for deactivation. This does not prove it is currently active.",
    };
  }

  if (args.build.isDraft === undefined) {
    return {
      code: "DRAFT_STATE_UNKNOWN",
      eligible: false,
      reason:
        `Whether Build ${target} is draft is unproven. A draft Build is never a promotion ` +
        "target, so absence cannot be read as false.",
    };
  }

  if (args.build.isDraft) {
    return {
      code: "DRAFT",
      eligible: false,
      reason:
        `Build ${target} is a draft Build, which by Cursor's own contract never becomes the ` +
        "Build new agents boot from, so it is never a promotion target.",
    };
  }

  const outcome = buildOutcome(args.build.status);
  if (outcome === "unknown") {
    return {
      code: "UNKNOWN_STATUS",
      eligible: false,
      reason:
        `Build ${target} reports the unrecognised status ${args.build.status}, which is never ` +
        "read as success or as a terminal state. Read the Build row again before promoting it.",
    };
  }
  if (outcome === "in-progress") {
    return {
      code: "NOT_TERMINAL",
      eligible: false,
      reason: `Build ${target} is ${args.build.status} and has not reached a terminal status.`,
    };
  }
  if (outcome !== "succeeded") {
    return {
      code: "NOT_SUCCEEDED",
      eligible: false,
      reason:
        `Build ${target} is ${args.build.status}, so it prepared no bootable disk to promote. ` +
        "userFacingSnapshotId is set on failed Builds too and proves nothing here.",
    };
  }

  return {
    code: "ELIGIBLE",
    eligible: true,
    reason:
      `Build ${target} is SUCCEEDED, non-draft, and in the declared environment, so it would be ` +
      "eligible if a promotion operation existed on a supported authority.",
  };
}

/** What an authoritative promotion readback would have to be, stated once. */
function activeBuildReadback(buildId: string): string {
  return (
    `an authoritative active-Build read on the same authority reporting ${buildId}, with ` +
    "read-your-write freshness and none-active expressible as a value distinguishable from unreadable"
  );
}

/**
 * Making an exact Build the one new agents boot from.
 *
 * Two legs of the blocking triad are missing at once, and the reason says so:
 * there is no activate verb on a supported authority, and no authoritative
 * active-Build read to confirm one with. A verb arriving without the read would
 * still be unimplementable.
 */
export function activateBuildResidual(args: {
  environmentPublicId: string;
  buildId: string;
}): OwnerActionResidual {
  return ownerActionResidual({
    action: "ACTIVATE_BUILD",
    authority: "browser-session",
    environmentPublicId: args.environmentPublicId,
    buildId: args.buildId,
    reason:
      "No activate or promote operation exists on the published API key, the SDK, or a live " +
      "delegated tool census, and no authoritative active-Build read exists on those " +
      "authorities, so a promotion could be neither performed nor confirmed. SUCCEEDED is not " +
      "activation, and environment-info.build.buildId is a run's boot provenance.",
    requiredReadback: activeBuildReadback(args.buildId),
    nextSteps: [
      "Activate that exact buildId from the environment dashboard, where active state is shown.",
      "Record the currently active Build out of band first: it cannot be read here, so no rollback target can be preserved for you.",
      "Do not read a later successful recurring or CONFIG_CHANGE Build as this activation: pin durability is unpublished.",
    ],
  });
}

/**
 * Clearing an exact Build's activation, which names no replacement.
 *
 * Deactivate is not the inverse of Activate: the resulting selection is
 * unpublished, so this must never be offered as a way to restore a predecessor.
 */
export function deactivateBuildResidual(args: {
  environmentPublicId: string;
  buildId: string;
}): OwnerActionResidual {
  return ownerActionResidual({
    action: "DEACTIVATE_BUILD",
    authority: "browser-session",
    environmentPublicId: args.environmentPublicId,
    buildId: args.buildId,
    reason:
      "No deactivate operation exists on the published API key, the SDK, or a live delegated " +
      "tool census, and the active Build is unreadable on those authorities. Deactivate also " +
      "names no replacement: the resulting selection is unspecified, so it is not the inverse " +
      "of Activate.",
    requiredReadback:
      `an authoritative active-Build read on the same authority showing ${args.buildId} is ` +
      "no longer active and reporting the resulting selection, with unreadable distinct from none active",
    nextSteps: [
      "Deactivate that exact buildId from the environment dashboard.",
      "If you want a particular predecessor to boot new agents, roll back to that exact buildId instead; deactivation does not select it.",
    ],
  });
}

/**
 * Returning to an explicitly named prior Build.
 *
 * `supersededBuildId` preserves the caller's intent, because the dashboard
 * gesture is identical to Activate. The predecessor field stays null with a
 * reason: emitting a predecessor described as proven active would be a
 * fabrication, since no authority here can read active state.
 */
export function rollbackBuildResidual(args: {
  environmentPublicId: string;
  /** The prior Build the caller selected. Never inferred, never "latest". */
  buildId: string;
  supersededBuildId?: string | undefined;
}): OwnerActionResidual {
  return ownerActionResidual({
    action: "ROLLBACK_BUILD",
    authority: "browser-session",
    environmentPublicId: args.environmentPublicId,
    buildId: args.buildId,
    ...(args.supersededBuildId === undefined
      ? {}
      : { supersededBuildId: args.supersededBuildId }),
    reason:
      "Build rollback is not a published primitive. Its only honest meaning is activating a " +
      "prior successful, promotable buildId without changing saved configuration, and no " +
      "activate operation or authoritative active-Build read exists on a supported authority.",
    requiredReadback: activeBuildReadback(args.buildId),
    nextSteps: [
      "Activate that exact prior buildId from the environment dashboard; never select by recency or by newest-successful.",
      "Do not use environment-version Restore instead: it changes saved Install/Start and may mint a new Build.",
    ],
  });
}

/**
 * Restoring a saved environment version.
 *
 * A different resource from every Build operation: it changes saved Install/Start
 * and may fire a configuration-change Build whose `buildId` is *new*. It
 * therefore never carries a Build id, and it is never presented as an alternative
 * to Build rollback.
 */
export function restoreEnvironmentVersionResidual(args: {
  environmentPublicId: string;
  environmentVersionPublicId: string;
}): OwnerActionResidual {
  return ownerActionResidual({
    action: "RESTORE_ENVIRONMENT_VERSION",
    authority: "browser-session",
    environmentPublicId: args.environmentPublicId,
    environmentVersionPublicId: args.environmentVersionPublicId,
    reason:
      "No restore operation exists on the published API key, the SDK, or a live delegated tool " +
      "census. Restore is a dashboard owner action, it changes saved Install/Start, and it may " +
      "fire a CONFIG_CHANGE Build whose buildId is new rather than the predecessor.",
    requiredReadback:
      `authoritative version history identifying ${args.environmentVersionPublicId} as the ` +
      "Restore source and reporting the resulting current environmentVersionPublicId, plus any CONFIG_CHANGE Build as a new buildId",
    nextSteps: [
      "Restore that exact environment version from the environment dashboard, then read the version back from a freshly booted run.",
      "If the Restore fires a configuration-change Build, treat its buildId as new; never adopt it as the predecessor.",
      "Compensate a further mistake with another forward Restore, not with a Build rollback: they are different resources.",
    ],
  });
}

/* ---------------------------------------------------------------- qualification */

/**
 * What the caller expects the task shell to look like.
 *
 * Names only, and bounded. An environment-variable *value* is never requested:
 * presence is the whole question, and a value would leave a secret in a tool
 * result.
 */
export interface QualificationExpectations {
  commands?: string[];
  environmentVariables?: string[];
  user?: string;
  workspace?: string;
  /**
   * Command names whose installed *version* should be recorded.
   *
   * Recording only. Declaring a name here asks the delegate to print that tool's
   * version; it declares nothing about which version is correct, because a run
   * inside the environment cannot answer that about itself.
   */
  toolchain?: string[];
}

export interface QualificationLayer {
  result: LayerResult;
  evidence: string[];
}

export interface QualificationView extends QualificationResult {
  environmentPublicId: string;
  layers: {
    preparedBuild: QualificationLayer;
    startExecution: QualificationLayer;
    taskShell: QualificationLayer;
  };
  /** Where the three layers disagree. Disk is not Start, and Start is not the shell. */
  divergences: string[];
  /**
   * Installed versions the run exposed, for the names the caller declared.
   *
   * Empty when nothing was declared or nothing was reported. No layer result is
   * derived from it: an installed version is evidence for a freshness judgement,
   * not a qualification verdict.
   */
  toolchain: ToolchainObservation[];
  trust: typeof DELEGATED_TRUST;
}

/**
 * Qualify three independent layers.
 *
 * They are not interchangeable success conditions, and no layer is inferred from
 * another. An absent Start-execution record is `indeterminate`, never `failed`
 * and never `passed`: `get-events` returned an empty list for a run that had
 * certainly booted.
 */
export function qualifyLayers(args: {
  environmentPublicId: string;
  report: DelegatedReport;
  expectations?: QualificationExpectations | undefined;
}): QualificationView {
  const info = args.report.environmentInfo;
  const currentRunBuildId = info?.build?.buildId;
  const rows = [
    ...(args.report.builds?.builds ?? []),
    ...(args.report.morePages ?? []).flatMap((page) => page.builds),
  ];
  const currentRow =
    currentRunBuildId === undefined
      ? undefined
      : rows.find((row) => row.buildId === currentRunBuildId);

  const preparedBuild: QualificationLayer = { result: "indeterminate", evidence: [] };
  if (currentRunBuildId === undefined) {
    preparedBuild.evidence.push(
      "No structured current-run buildId was reported, so the prepared disk cannot be attributed to a Build.",
    );
  } else {
    preparedBuild.evidence.push(`current-run buildId=${currentRunBuildId} (boot provenance, not the active Build)`);
    if (currentRow === undefined) {
      preparedBuild.evidence.push(
        "That buildId was not matched in the Build rows read, so its status is unknown.",
      );
    } else if (buildOutcome(currentRow.status) === "failed") {
      preparedBuild.result = "failed";
      preparedBuild.evidence.push(`its Build row reports ${currentRow.status}`);
    } else if (buildOutcome(currentRow.status) === "succeeded") {
      preparedBuild.result = "passed";
      preparedBuild.evidence.push(`its Build row reports ${currentRow.status}`);
    } else {
      preparedBuild.evidence.push(
        `its Build row reports ${currentRow.status}, which is not a completed preparation`,
      );
    }
  }

  const events = args.report.events;
  const startExecution: QualificationLayer = { result: "indeterminate", evidence: [] };
  if (events === undefined) {
    startExecution.evidence.push("No Start-execution record was collected.");
  } else {
    const count = events.count ?? events.events?.length ?? 0;
    startExecution.evidence.push(`get-events reported count=${count}`);
    // The supported get-events contract is a structured list. It does
    // not establish an event type or success field for Start, so neither an
    // empty nor a non-empty list proves execution succeeded or failed.
    startExecution.evidence.push(
      count === 0
        ? "An empty event list is a missing record, not a failed Start script."
        : "No documented event shape identifies a successful or failed Start execution.",
    );
  }

  const shell = args.report.shell;
  const expectations = args.expectations ?? {};
  const toolchain = observedToolchain(expectations.toolchain ?? [], shell?.toolchain ?? []);
  const taskShell: QualificationLayer = { result: "indeterminate", evidence: [] };
  if (shell === undefined) {
    taskShell.evidence.push("No task-shell observations were collected.");
  } else {
    const problems: string[] = [];
    const unreported: string[] = [];
    if (shell.workspace !== undefined) taskShell.evidence.push(`cwd=${shell.workspace}`);
    if (shell.user !== undefined) taskShell.evidence.push(`user=${shell.user}`);
    if (expectations.workspace !== undefined) {
      if (shell.workspace === undefined) {
        unreported.push("workspace");
      } else if (shell.workspace !== expectations.workspace) {
        problems.push(`workspace is ${shell.workspace}, not ${expectations.workspace}`);
      }
    }
    if (expectations.user !== undefined) {
      if (shell.user === undefined) {
        unreported.push("user");
      } else if (shell.user !== expectations.user) {
        problems.push(`user is ${shell.user}, not ${expectations.user}`);
      }
    }
    const commands = classifyNames(
      expectations.commands ?? [],
      shell.commandsPresent ?? [],
      shell.commandsMissing ?? [],
    );
    const variables = classifyNames(
      expectations.environmentVariables ?? [],
      shell.environmentVariablesPresent ?? [],
      shell.environmentVariablesMissing ?? [],
    );
    if (commands.missing.length > 0) {
      problems.push(`commands absent from the task shell: ${commands.missing.join(", ")}`);
    }
    if (variables.missing.length > 0) {
      problems.push(
        `environment-variable names absent from the task shell: ${variables.missing.join(", ")}`,
      );
    }
    const versionsSeen = new Set(toolchain.map((entry) => entry.name));
    unreported.push(
      ...commands.unreported.map((name) => `command ${name}`),
      ...variables.unreported.map((name) => `environment-variable name ${name}`),
      // A declared tool whose version never came back is unreported, not absent:
      // the freshness judgement must not read a missing version as a match.
      ...(expectations.toolchain ?? [])
        .filter((name) => !versionsSeen.has(name))
        .map((name) => `installed version of ${name}`),
    );
    const declared =
      (expectations.commands?.length ?? 0) +
      (expectations.environmentVariables?.length ?? 0) +
      (expectations.toolchain?.length ?? 0) +
      (expectations.user === undefined ? 0 : 1) +
      (expectations.workspace === undefined ? 0 : 1);
    if (problems.length > 0) {
      taskShell.result = "failed";
      taskShell.evidence.push(...problems);
    } else if (unreported.length > 0) {
      taskShell.evidence.push(
        `The delegate did not report: ${unreported.join(", ")}. Absence of readback is indeterminate.`,
      );
    } else if (declared === 0) {
      taskShell.evidence.push(
        "Nothing was declared to check, so the shell was observed but not qualified.",
      );
    } else {
      taskShell.result = "passed";
      taskShell.evidence.push("every declared command and variable name was present");
    }
  }

  const layers = { preparedBuild, startExecution, taskShell };
  return {
    // Empty when the run reported no current-run Build. The prepared-disk layer
    // is then `indeterminate` and says so, rather than this field being filled
    // from another layer's Build id.
    buildId: currentRunBuildId ?? "",
    environmentPublicId: args.environmentPublicId,
    preparedBuild: preparedBuild.result,
    startExecution: startExecution.result,
    taskShell: taskShell.result,
    layers,
    divergences: divergences(layers),
    toolchain,
    trust: DELEGATED_TRUST,
  };
}

/**
 * Keep the versions that answer a declared name, and only those.
 *
 * A delegate could report a tool nobody asked about; an undeclared observation is
 * dropped rather than recorded, so the caller's declaration bounds what leaves the
 * environment. The first reading of a name wins: two answers for one tool do not
 * describe one shell, and picking the later one would be picking arbitrarily.
 */
function observedToolchain(
  declared: string[],
  reported: ToolchainObservation[],
): ToolchainObservation[] {
  const wanted = new Set(declared);
  const seen = new Set<string>();
  const out: ToolchainObservation[] = [];
  for (const entry of reported) {
    if (!wanted.has(entry.name) || seen.has(entry.name)) continue;
    if (entry.version === "") continue;
    seen.add(entry.name);
    out.push({ name: entry.name, version: entry.version });
  }
  return out;
}

/** Separate an explicit negative from a name the delegate never accounted for. */
function classifyNames(
  declared: string[],
  present: string[],
  absent: string[],
): { missing: string[]; unreported: string[] } {
  const seen = new Set(present);
  const reportedMissing = new Set(absent);
  return {
    missing: declared.filter((name) => reportedMissing.has(name)),
    unreported: declared.filter(
      (name) => !seen.has(name) && !reportedMissing.has(name),
    ),
  };
}

/**
 * Say where the layers disagree, in the caller's terms.
 *
 * This is the whole point of keeping them apart: "the disk is fine and the shell
 * is not" is the finding, and a single merged verdict would hide it.
 */
function divergences(layers: {
  preparedBuild: QualificationLayer;
  startExecution: QualificationLayer;
  taskShell: QualificationLayer;
}): string[] {
  const out: string[] = [];
  const named = [
    ["prepared Build disk", layers.preparedBuild.result],
    ["Start execution", layers.startExecution.result],
    ["task shell", layers.taskShell.result],
  ] as const;
  for (let left = 0; left < named.length; left += 1) {
    for (let right = left + 1; right < named.length; right += 1) {
      const [leftName, leftResult] = named[left]!;
      const [rightName, rightResult] = named[right]!;
      if (leftResult !== rightResult) {
        out.push(`${leftName} is ${leftResult} while ${rightName} is ${rightResult}`);
      }
    }
  }
  return out;
}

/* ------------------------------------------------------------------------- logs */

export type BuildLogAvailability =
  | "TERMINAL_BODY"
  | "IN_PROGRESS_NO_BODY"
  | "SKIPPED_NO_BODY"
  | "RETENTION_EXPIRED"
  | "NOT_FOUND"
  | "UNKNOWN";

export interface BuildLogView {
  buildId: string;
  environmentPublicId: string;
  availability: BuildLogAvailability;
  available: boolean;
  /** One stream. There are no separate install and start logs to ask for. */
  combinedInstallAndStart: true;
  sizeBytes?: number;
  reason: string;
  trust: typeof DELEGATED_TRUST;
  /**
   * Log text, last on purpose.
   *
   * `ok()` spends one byte budget over the whole structure in key order, so
   * every identifier above is emitted before a body that can exceed the budget
   * on its own.
   */
  text?: string;
}

/**
 * Project a log fetch.
 *
 * An empty body is a state, not an error: logs materialise at a terminal state,
 * so a mid-flight fetch is accepted and returns nothing. Retention is about ten
 * days, after which an older Build returns a note and no body.
 */
export function projectBuildLogs(args: {
  buildId: string;
  environmentPublicId: string;
  logs?: DelegatedLogResult | undefined;
  /** The Build's own status, when a row for it was read. */
  buildStatus?: string | undefined;
  includeText?: boolean | undefined;
}): BuildLogView {
  const logs = args.logs;
  const view: BuildLogView = {
    buildId: args.buildId,
    environmentPublicId: args.environmentPublicId,
    availability: "UNKNOWN",
    available: false,
    combinedInstallAndStart: true,
    reason: "No log result was collected.",
    trust: DELEGATED_TRUST,
  };
  if (logs === undefined) return view;
  if (logs.sizeBytes !== undefined) view.sizeBytes = logs.sizeBytes;

  if (logs.notFound === true) {
    view.availability = "NOT_FOUND";
    view.reason = `Cursor did not recognise buildId ${args.buildId}. Only Builds of the delegated run's own environment are accessible.`;
    return view;
  }

  const body = logs.text ?? "";
  if (body !== "") {
    view.availability = "TERMINAL_BODY";
    view.available = true;
    view.reason =
      "Logs cover the Docker image build plus clone, install, and setup output as one combined stream.";
    if (args.includeText !== false) view.text = body;
    return view;
  }

  const outcome = args.buildStatus === undefined ? "unknown" : buildOutcome(args.buildStatus);
  if (outcome === "in-progress") {
    view.availability = "IN_PROGRESS_NO_BODY";
    view.reason =
      "The Build is still running. Progress is not streamable: logs materialise at a terminal state. An empty body here is not a fetch error.";
    return view;
  }
  if (outcome === "skipped") {
    view.availability = "SKIPPED_NO_BODY";
    view.reason = "A skipped Build never ran, so it has no log body.";
    return view;
  }
  if (logs.retentionNote !== undefined) {
    view.availability = "RETENTION_EXPIRED";
    view.reason =
      "The fetch was accepted with no body and a retention note. Build logs are retained for about ten days.";
    return view;
  }
  view.reason =
    "The fetch was accepted and returned no body. That is not treated as success or as failure.";
  return view;
}

/* ----------------------------------------------------------- CLI writes */

const NO_WRITE_RETRY =
  "Do not retry this write. Re-read the environment and reconcile identifiers; a second dispatch is a second mutation.";

const NEVER_PERSISTED =
  "Publication opens a pull request. It is not a database Save or a persistence receipt.";

export const CLI_WRITE_TRUST = "cursor-cli" as const;

export interface CliWriteRequest {
  cli: CursorCli | undefined;
  runner: CliRunner | undefined;
  binding: CliWriteBinding;
  confirm?: boolean | undefined;
  preview?: CliWritePreview | undefined;
  previewToken?: string | undefined;
  nowMs?: number | undefined;
  restEmail?: string | undefined;
  getRestEmail?: (() => Promise<string | undefined>) | undefined;
}

interface CliWritePrepared {
  readiness: Extract<CliWriteReadiness, { ready: true }>;
  target: CliWriteTarget;
}

type CliWritePrepareResult =
  | { ok: true; prepared: CliWritePrepared }
  | {
      ok: false;
      status: string;
      reason: string;
      nextSteps: string[];
      readiness: CliWriteReadiness;
    };

async function readCliJson(args: {
  readiness: Extract<CliWriteReadiness, { ready: true }>;
  argv: readonly string[];
  label: string;
}): Promise<
  | { ok: true; value: unknown }
  | { ok: false; status: string; reason: string }
> {
  const run = await args.readiness.run(args.argv);
  const problem = classifyCliRun(run, args.readiness.cli, args.label);
  if (problem !== undefined) return { ok: false, ...problem };
  const parsed = parseCliJson(run, args.readiness.cli.maxOutputBytes);
  if (!parsed.ok) return { ok: false, status: parsed.code, reason: parsed.message };
  return { ok: true, value: parsed.value };
}

async function prepareCliWrite(args: {
  request: CliWriteRequest;
  operation: CliWriteOperation;
}): Promise<CliWritePrepareResult> {
  const readiness = await cursorCliWriteReadiness({
    cli: args.request.cli,
    runner: args.request.runner,
    operation: args.operation,
    scope: args.request.binding.scope,
    restEmail: args.request.restEmail,
    getRestEmail: args.request.getRestEmail,
  });
  if (!readiness.ready) {
    return {
      ok: false,
      status: readiness.status,
      reason: readiness.reason,
      nextSteps: readiness.nextSteps,
      readiness,
    };
  }

  const listed = await readCliJson({
    readiness,
    argv: ENV_LIST_ARGS,
    label: "listing environments before a write",
  });
  if (!listed.ok) {
    return { ...listed, ok: false, nextSteps: [NO_WRITE_RETRY], readiness };
  }

  const resolved = resolveWriteTarget(listed.value, args.request.binding.publicId);
  if (!resolved.ok) {
    return {
      ok: false,
      status: resolved.status,
      reason: resolved.reason,
      nextSteps: [
        "Confirm the pinned environmentPublicId against cursor_list_environments.",
        NO_WRITE_RETRY,
      ],
      readiness,
    };
  }

  const matched = matchWriteBinding(resolved.target, args.request.binding, args.operation);
  if (!matched.ok) {
    return {
      ok: false,
      status: matched.status,
      reason: matched.reason,
      nextSteps: [
        "Correct the structured environment binding; caller-supplied membership is not proof.",
        NO_WRITE_RETRY,
      ],
      readiness,
    };
  }

  return { ok: true, prepared: { readiness, target: resolved.target } };
}

function writeCliBlock(readiness: CliWriteReadiness): Record<string, unknown> {
  return cliAuthorityBlock(readiness);
}

function unknownAfterDispatch<O extends CliWriteOperation>(args: {
  operation: O;
  environmentPublicId: string;
  readiness: Extract<CliWriteReadiness, { ready: true }>;
  reason: string;
}): {
  status: "STATE_UNKNOWN";
  operation: O;
  dispatched: true;
  environmentPublicId: string;
  reason: string;
  nextSteps: string[];
  cli: Record<string, unknown>;
  trust: typeof CLI_WRITE_TRUST;
} {
  return {
    status: "STATE_UNKNOWN",
    operation: args.operation,
    dispatched: true,
    environmentPublicId: args.environmentPublicId,
    reason: args.reason,
    nextSteps: [NO_WRITE_RETRY],
    cli: writeCliBlock(args.readiness),
    trust: CLI_WRITE_TRUST,
  };
}

export type CliPublishStatus =
  | "PULL_REQUEST_CREATED"
  | "CONFIRMATION_REQUIRED"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_MISMATCH"
  | "DRIFT"
  | "UNREADABLE_CONTENT"
  | "WRONG_ENVIRONMENT"
  | "WRONG_REPO"
  | "WRONG_SCOPE"
  | "NOT_SINGLE_REPOSITORY"
  | "IDENTITY_UNPINNED"
  | "AMBIGUOUS_ENVIRONMENT"
  | "STATE_UNKNOWN"
  | string;

export interface CliPublishResult {
  status: CliPublishStatus;
  operation: "publish";
  dispatched: boolean;
  environmentPublicId: string;
  reason: string;
  nextSteps: string[];
  cli: Record<string, unknown>;
  preview?: CliWritePreview;
  prUrl?: string;
  trust: typeof CLI_WRITE_TRUST;
}

export type CliSaveStatus =
  | "DATABASE_SAVED"
  | "CONFIRMATION_REQUIRED"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_MISMATCH"
  | "DRIFT"
  | "NO_CHANGE"
  | "UNREADABLE_CONTENT"
  | "WRONG_ENVIRONMENT"
  | "WRONG_REPO"
  | "WRONG_SCOPE"
  | "IDENTITY_UNPINNED"
  | "AMBIGUOUS_ENVIRONMENT"
  | "STATE_UNKNOWN"
  | string;

export interface CliSaveResult {
  status: CliSaveStatus;
  operation: "save";
  dispatched: boolean;
  environmentPublicId: string;
  reason: string;
  nextSteps: string[];
  cli: Record<string, unknown>;
  preview?: CliWritePreview;
  /** Always true: this client compared digests before dispatch. */
  clientPrecheck: true;
  /** Always false: the CLI exposes no compare-and-swap / expected-current token. */
  serverCompareAndSwap: false;
  observedDigest?: string;
  intendedDigest?: string;
  trust: typeof CLI_WRITE_TRUST;
}

export type CliDeleteStatus =
  | "DELETED"
  | "CONFIRMATION_REQUIRED"
  | "PREVIEW_EXPIRED"
  | "PREVIEW_MISMATCH"
  | "DRIFT"
  | "INTERNAL_ID_UNREADABLE"
  | "WRONG_ENVIRONMENT"
  | "WRONG_REPO"
  | "WRONG_SCOPE"
  | "IDENTITY_UNPINNED"
  | "AMBIGUOUS_ENVIRONMENT"
  | "STATE_UNKNOWN"
  | string;

export interface CliDeleteResult {
  status: CliDeleteStatus;
  operation: "delete";
  dispatched: boolean;
  environmentPublicId: string;
  reason: string;
  nextSteps: string[];
  cli: Record<string, unknown>;
  preview?: CliWritePreview;
  listConclusive?: boolean;
  trust: typeof CLI_WRITE_TRUST;
}

async function readConfiguration(args: {
  readiness: Extract<CliWriteReadiness, { ready: true }>;
  environmentPublicId: string;
}): Promise<
  | { ok: true; digest: string | undefined; databaseDigest: string | undefined }
  | { ok: false; status: string; reason: string }
> {
  const got = await readCliJson({
    readiness: args.readiness,
    argv: envGetArgs(args.environmentPublicId),
    label: "reading environment configuration",
  });
  if (!got.ok) return got;
  const normalized = normalizeEnvironmentConfiguration({
    environmentPublicId: args.environmentPublicId,
    payload: got.value,
  });
  if (!normalized.ok) {
    return { ok: false, status: normalized.code, reason: normalized.message };
  }
  return {
    ok: true,
    digest: readableContentDigest(normalized.read),
    databaseDigest: databaseDigest(normalized.read),
  };
}

/**
 * Publish a personal single-repository environment as a pull request.
 *
 * Success is `PULL_REQUEST_CREATED`. That is not persistence: a PR is not a
 * database Save, and this path never returns `PERSISTED`.
 */
export async function publishEnvironmentWithCli(
  request: CliWriteRequest,
): Promise<CliPublishResult> {
  const nowMs = request.nowMs ?? Date.now();
  const prepared = await prepareCliWrite({ request, operation: "publish" });
  const environmentPublicId = request.binding.publicId;
  if (!prepared.ok) {
    return {
      status: prepared.status,
      operation: "publish",
      dispatched: false,
      environmentPublicId,
      reason: prepared.reason,
      nextSteps: prepared.nextSteps,
      cli: writeCliBlock(prepared.readiness),
      trust: CLI_WRITE_TRUST,
    };
  }

  const { readiness, target } = prepared.prepared;
  const content = await readConfiguration({
    readiness,
    environmentPublicId: target.environmentPublicId,
  });
  if (!content.ok) {
    return {
      status: content.status,
      operation: "publish",
      dispatched: false,
      environmentPublicId,
      reason: content.reason,
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      trust: CLI_WRITE_TRUST,
    };
  }
  if (content.databaseDigest === undefined) {
    return {
      status: "UNREADABLE_CONTENT",
      operation: "publish",
      dispatched: false,
      environmentPublicId,
      reason:
        "The saved database configuration is unreadable, so the content that publication would use is unproven.",
      nextSteps: [
        "Read the configuration until a candidate is readable, then preview again.",
        NO_WRITE_RETRY,
      ],
      cli: writeCliBlock(readiness),
      trust: CLI_WRITE_TRUST,
    };
  }

  const preview = issueWritePreview({
    operation: "publish",
    environmentPublicId,
    targetDigest: content.databaseDigest,
    nowMs,
  });
  const confirmed = verifyWriteConfirmation({
    confirm: request.confirm,
    preview: request.preview,
    previewToken: request.previewToken,
    operation: "publish",
    environmentPublicId,
    nowMs,
  });
  if (!confirmed.ok) {
    return {
      status: confirmed.status,
      operation: "publish",
      dispatched: false,
      environmentPublicId,
      reason: confirmed.reason,
      nextSteps: [
        "Pass confirm: true with this preview and previewToken. The token expires.",
      ],
      cli: writeCliBlock(readiness),
      preview,
      trust: CLI_WRITE_TRUST,
    };
  }
  const heldPublish = request.preview;
  if (heldPublish === undefined || heldPublish.targetDigest !== content.databaseDigest) {
    return {
      status: "DRIFT",
      operation: "publish",
      dispatched: false,
      environmentPublicId,
      reason:
        "The saved database configuration digest changed after the preview was issued. Nothing was dispatched.",
      nextSteps: ["Issue a new preview against the current configuration.", NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      trust: CLI_WRITE_TRUST,
    };
  }

  const writeRun = await readiness.run(envPublishArgs(environmentPublicId));
  const problem = classifyCliRun(writeRun, readiness.cli, "publishing the environment");
  if (problem !== undefined) {
    return unknownAfterDispatch({
      operation: "publish",
      environmentPublicId,
      readiness,
      reason: `${problem.reason} After dispatch the outcome is unknown. ${NEVER_PERSISTED}`,
    });
  }
  const parsed = parseCliJson(writeRun, readiness.cli.maxOutputBytes);
  if (!parsed.ok) {
    return unknownAfterDispatch({
      operation: "publish",
      environmentPublicId,
      readiness,
      reason: `${parsed.message} After dispatch the outcome is unknown. ${NEVER_PERSISTED}`,
    });
  }
  const prUrl = readPullRequestUrl(parsed.value);
  if (prUrl === undefined) {
    return unknownAfterDispatch({
      operation: "publish",
      environmentPublicId,
      readiness,
      reason:
        "The publish command returned no GitHub pull-request URL, so creation is unproven. " +
        NEVER_PERSISTED,
    });
  }

  return {
    status: "PULL_REQUEST_CREATED",
    operation: "publish",
    dispatched: true,
    environmentPublicId,
    prUrl,
    reason: `A pull request was created at ${prUrl}. ${NEVER_PERSISTED}`,
    nextSteps: [
      "Review and merge the pull request yourself. Merging is not performed here.",
      NEVER_PERSISTED,
    ],
    cli: writeCliBlock(readiness),
    trust: CLI_WRITE_TRUST,
  };
}

/**
 * Save a definition to the personal (or gated team) database environment.
 *
 * Success is `DATABASE_SAVED`, not `PERSISTED`. `PERSISTED` is the delegated
 * verification of an owner dashboard Save and is a different judgement.
 */
export async function saveEnvironmentWithCli(
  request: CliWriteRequest & { document: unknown },
): Promise<CliSaveResult> {
  const nowMs = request.nowMs ?? Date.now();
  const environmentPublicId = request.binding.publicId;
  const disclose = { clientPrecheck: true as const, serverCompareAndSwap: false as const };
  const prepared = await prepareCliWrite({ request, operation: "save" });
  if (!prepared.ok) {
    return {
      status: prepared.status,
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason: prepared.reason,
      nextSteps: prepared.nextSteps,
      cli: writeCliBlock(prepared.readiness),
      ...disclose,
      trust: CLI_WRITE_TRUST,
    };
  }

  const { readiness, target } = prepared.prepared;
  let intended: { digest: string; bytes: number };
  try {
    intended = summarizeConfiguration(request.document);
  } catch {
    return {
      status: "UNREADABLE_CONTENT",
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason: "The intended configuration could not be digested, so it is not sent.",
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      ...disclose,
      trust: CLI_WRITE_TRUST,
    };
  }
  if (intended.bytes > readiness.cli.maxOutputBytes) {
    return {
      status: "UNREADABLE_CONTENT",
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason: "The intended configuration exceeds cursorCli.maxOutputBytes and is not sent.",
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      ...disclose,
      trust: CLI_WRITE_TRUST,
    };
  }

  const content = await readConfiguration({
    readiness,
    environmentPublicId: target.environmentPublicId,
  });
  if (!content.ok) {
    return {
      status: content.status,
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason: content.reason,
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      ...disclose,
      intendedDigest: intended.digest,
      trust: CLI_WRITE_TRUST,
    };
  }
  if (content.databaseDigest === undefined) {
    return {
      status: "UNREADABLE_CONTENT",
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason:
        "The database configuration candidate is unreadable, so a pre-Save digest cannot be bound.",
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      ...disclose,
      intendedDigest: intended.digest,
      trust: CLI_WRITE_TRUST,
    };
  }

  const preview = issueWritePreview({
    operation: "save",
    environmentPublicId,
    targetDigest: intended.digest,
    observedDigest: content.databaseDigest,
    nowMs,
  });
  const confirmed = verifyWriteConfirmation({
    confirm: request.confirm,
    preview: request.preview,
    previewToken: request.previewToken,
    operation: "save",
    environmentPublicId,
    nowMs,
  });
  if (!confirmed.ok) {
    return {
      status: confirmed.status,
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason: confirmed.reason,
      nextSteps: [
        "Pass confirm: true with this preview and previewToken before the expiry.",
        "The server has no compare-and-swap; only this client precheck stands between preview and dispatch.",
      ],
      cli: writeCliBlock(readiness),
      preview,
      ...disclose,
      observedDigest: content.databaseDigest,
      intendedDigest: intended.digest,
      trust: CLI_WRITE_TRUST,
    };
  }

  const heldSave = request.preview;
  if (heldSave === undefined || heldSave.targetDigest !== intended.digest) {
    return {
      status: "PREVIEW_MISMATCH",
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason: "The intended configuration digest does not match the preview that was confirmed.",
      nextSteps: ["Issue a new preview for this document.", NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      ...disclose,
      observedDigest: content.databaseDigest,
      intendedDigest: intended.digest,
      trust: CLI_WRITE_TRUST,
    };
  }
  if (heldSave.observedDigest !== content.databaseDigest) {
    return {
      status: "DRIFT",
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason:
        "The database configuration changed after the preview was issued. The client precheck " +
        "refused dispatch. The CLI has no server compare-and-swap.",
      nextSteps: ["Issue a new preview against the current database digest.", NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      ...disclose,
      observedDigest: content.databaseDigest,
      intendedDigest: intended.digest,
      trust: CLI_WRITE_TRUST,
    };
  }
  if (content.databaseDigest === intended.digest) {
    return {
      status: "NO_CHANGE",
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason:
        "The database already matches the intended digest, so a Save would not be distinguishable " +
        "from a no-op and is not dispatched.",
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      ...disclose,
      observedDigest: content.databaseDigest,
      intendedDigest: intended.digest,
      trust: CLI_WRITE_TRUST,
    };
  }

  let stdin: string;
  try {
    stdin = canonicalJson(request.document);
  } catch {
    return {
      status: "UNREADABLE_CONTENT",
      operation: "save",
      dispatched: false,
      environmentPublicId,
      reason: "The intended configuration could not be canonicalized, so it is not sent.",
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      ...disclose,
      intendedDigest: intended.digest,
      trust: CLI_WRITE_TRUST,
    };
  }

  const writeRun = await readiness.run(envSaveArgs(environmentPublicId), { stdin });
  const problem = classifyCliRun(writeRun, readiness.cli, "saving the environment");
  if (problem !== undefined) {
    return {
      ...unknownAfterDispatch({
        operation: "save",
        environmentPublicId,
        readiness,
        reason:
          `${problem.reason} After dispatch the outcome is unknown. The CLI has no server ` +
          "compare-and-swap.",
      }),
      ...disclose,
      intendedDigest: intended.digest,
    };
  }

  const post = await readConfiguration({
    readiness,
    environmentPublicId: target.environmentPublicId,
  });
  if (!post.ok || post.databaseDigest !== intended.digest) {
    return {
      ...unknownAfterDispatch({
        operation: "save",
        environmentPublicId,
        readiness,
        reason:
          "The Save command returned, but the post-read database digest does not exactly match " +
          "the intended digest. The outcome is unknown and is not retried.",
      }),
      ...disclose,
      intendedDigest: intended.digest,
      ...(post.ok && post.databaseDigest !== undefined
        ? { observedDigest: post.databaseDigest }
        : {}),
    };
  }

  return {
    status: "DATABASE_SAVED",
    operation: "save",
    dispatched: true,
    environmentPublicId,
    reason:
      "The post-read database digest matches the intended digest. The client performed the " +
      "precheck; there is no server compare-and-swap.",
    nextSteps: [
      "Record the new configuration digest. A CONFIG_CHANGE Build is not attributed here.",
    ],
    cli: writeCliBlock(readiness),
    ...disclose,
    observedDigest: post.databaseDigest,
    intendedDigest: intended.digest,
    trust: CLI_WRITE_TRUST,
  };
}

/**
 * Delete one environment after a CLI dry-run and exact public-to-internal
 * resolution.
 *
 * The internal numeric id is resolved from a fresh list, bound into the preview
 * digest, and used only as argv. It is never accepted from the caller and never
 * returned.
 */
export async function deleteEnvironmentWithCli(
  request: CliWriteRequest,
): Promise<CliDeleteResult> {
  const nowMs = request.nowMs ?? Date.now();
  const environmentPublicId = request.binding.publicId;
  const prepared = await prepareCliWrite({ request, operation: "delete" });
  if (!prepared.ok) {
    return {
      status: prepared.status,
      operation: "delete",
      dispatched: false,
      environmentPublicId,
      reason: prepared.reason,
      nextSteps: prepared.nextSteps,
      cli: writeCliBlock(prepared.readiness),
      trust: CLI_WRITE_TRUST,
    };
  }

  const { readiness, target } = prepared.prepared;
  if (target.internalId === undefined) {
    return {
      status: "INTERNAL_ID_UNREADABLE",
      operation: "delete",
      dispatched: false,
      environmentPublicId,
      reason:
        "The CLI list row carried no internal numeric id, so delete cannot be addressed without " +
        "accepting a caller-supplied id.",
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      trust: CLI_WRITE_TRUST,
    };
  }

  const identity = deleteIdentityDigest(target);
  if (identity === undefined) {
    return {
      status: "INTERNAL_ID_UNREADABLE",
      operation: "delete",
      dispatched: false,
      environmentPublicId,
      reason: "The delete identity digest could not be bound.",
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      trust: CLI_WRITE_TRUST,
    };
  }

  const dryRun = await readCliJson({
    readiness,
    argv: envDeleteDryRunArgs(environmentPublicId),
    label: "dry-running environment deletion",
  });
  if (!dryRun.ok) {
    return {
      status: dryRun.status,
      operation: "delete",
      dispatched: false,
      environmentPublicId,
      reason: dryRun.reason,
      nextSteps: [NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      trust: CLI_WRITE_TRUST,
    };
  }
  if (!deleteDryRunMatchesTarget(dryRun.value, target)) {
    return {
      status: "DRIFT",
      operation: "delete",
      dispatched: false,
      environmentPublicId,
      reason:
        "The CLI dry-run did not identify the exact public environment selected by the fresh list.",
      nextSteps: ["Re-list the environment and request a new delete preview.", NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      trust: CLI_WRITE_TRUST,
    };
  }

  const preview = issueWritePreview({
    operation: "delete",
    environmentPublicId,
    targetDigest: identity,
    nowMs,
  });
  const confirmed = verifyWriteConfirmation({
    confirm: request.confirm,
    preview: request.preview,
    previewToken: request.previewToken,
    operation: "delete",
    environmentPublicId,
    nowMs,
  });
  if (!confirmed.ok) {
    return {
      status: confirmed.status,
      operation: "delete",
      dispatched: false,
      environmentPublicId,
      reason: confirmed.reason,
      nextSteps: ["Pass confirm: true with this preview and previewToken before the expiry."],
      cli: writeCliBlock(readiness),
      preview,
      trust: CLI_WRITE_TRUST,
    };
  }
  const heldDelete = request.preview;
  if (heldDelete === undefined || heldDelete.targetDigest !== identity) {
    return {
      status: "DRIFT",
      operation: "delete",
      dispatched: false,
      environmentPublicId,
      reason:
        "The public-to-internal identity changed after the preview was issued. Nothing was dispatched.",
      nextSteps: ["Issue a new delete preview.", NO_WRITE_RETRY],
      cli: writeCliBlock(readiness),
      trust: CLI_WRITE_TRUST,
    };
  }

  const writeRun = await readiness.run(envDeleteArgs(target.internalId));
  const problem = classifyCliRun(writeRun, readiness.cli, "deleting the environment");
  if (problem !== undefined) {
    return unknownAfterDispatch({
      operation: "delete",
      environmentPublicId,
      readiness,
      reason: `${problem.reason} After dispatch the outcome is unknown.`,
    });
  }

  const listed = await readCliJson({
    readiness,
    argv: ENV_LIST_ARGS,
    label: "listing environments after delete",
  });
  if (!listed.ok) {
    return unknownAfterDispatch({
      operation: "delete",
      environmentPublicId,
      readiness,
      reason: `${listed.reason} After dispatch, absence could not be proven.`,
    });
  }
  const catalog = normalizeEnvironmentCatalog(listed.value);
  if (!catalog.ok) {
    return unknownAfterDispatch({
      operation: "delete",
      environmentPublicId,
      readiness,
      reason: `${catalog.message} After dispatch, absence could not be proven.`,
    });
  }
  const absence = environmentAbsentFromList(catalog.catalog, environmentPublicId);
  if (!absence.absent || !absence.conclusive) {
    return {
      ...unknownAfterDispatch({
        operation: "delete",
        environmentPublicId,
        readiness,
        reason: absence.absent
          ? "The environment is missing from a truncated list, so absence is inconclusive."
          : "The environment is still present in the post-delete list. The outcome is unknown and is not retried.",
      }),
      listConclusive: absence.conclusive,
    };
  }

  return {
    status: "DELETED",
    operation: "delete",
    dispatched: true,
    environmentPublicId,
    listConclusive: true,
    reason:
      "The environment is absent from a complete post-delete list. The internal id was resolved " +
      "from that list and is not returned.",
    nextSteps: ["Do not dispatch delete again for this environment."],
    cli: writeCliBlock(readiness),
    trust: CLI_WRITE_TRUST,
  };
}
