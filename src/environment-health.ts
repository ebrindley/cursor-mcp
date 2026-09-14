/**
 * Environment Build health and toolchain freshness.
 *
 * Cursor already rebuilds an environment on a schedule and skips the rebuild when
 * it has nothing to do. This module answers the three questions that schedule
 * cannot, and it keeps them apart because a caller acts on each differently --
 * see `docs/environment-freshness.md`:
 *
 *   - **Build health.** Are the environment's Builds succeeding, and how old is
 *     the newest successful one? A `SKIPPED` recurring row is Cursor working
 *     correctly, not a fault; a `FAILED` row is the pipeline being broken.
 *   - **Source freshness.** Has the configuration of record moved since the last
 *     successful Build? Cursor's recurring Build observes this, but nothing tells
 *     the caller, and a `CONFIG_CHANGE` row is not attributable to the definition
 *     because a secrets change emits one too.
 *   - **Toolchain drift.** Is an installed tool behind what the caller declared,
 *     or behind an upstream version the caller supplied? Cursor cannot observe
 *     this at all: a recurring Build re-runs Install, and whether that produces a
 *     newer compiler is a property of the caller's own scripts and of upstream.
 *
 * Everything here is a pure judgement over readback the caller holds. Nothing is
 * stored, no clock is read, no network is touched, and no Build is triggered:
 * `assessEnvironmentFreshness` returns a *recommendation*, and dispatching a
 * refresh is a separate, explicitly confirmed call. Two consecutive checks over
 * the same readback therefore produce the same answer and the same no-op.
 *
 * Four rules carry over from `environment-operations.ts` and are not relaxed here.
 *
 * 1. **`status` is an open string.** An unrecognised status is neither terminal
 *    nor healthy, and it never contributes to a `HEALTHY` verdict.
 * 2. **A draft Build is not the environment's Build.** Draft rows are excluded
 *    from health entirely: by Cursor's own contract they never become the Build
 *    new agents boot from, so a draft failure is not the pipeline failing.
 * 3. **The active Build stays unreadable.** A `SUCCEEDED` row is not activation,
 *    so `HEALTHY` describes Build history, never what new agents boot from.
 * 4. **An unproven condition never spends a write.** The trigger has no
 *    idempotency key, so a refresh is withheld unless drift is *established*.
 */

import {
  ACTIVE_BUILD_UNREADABLE_REASON,
  CONFIG_CHANGE_TRIGGER,
  DELEGATED_TRUST,
  buildOutcome,
  isTerminalBuild,
  type BuildOutcome,
  type ToolchainObservation,
} from "./environment-operations.js";
import {
  managedAsFromPath,
  unreadableActiveBuild,
  type ActiveBuildRef,
  type EnvironmentManagedAs,
} from "./lifecycle-model.js";

/** Longest id list this module will report per category. */
export const MAX_REPORTED_BUILD_IDS = 10;

/** A Build row as a caller passes it back, from `cursor_list_builds`. */
export interface HealthBuildRow {
  buildId: string;
  status: string;
  environmentPublicId?: string | undefined;
  source?: string | undefined;
  triggerType?: string | undefined;
  failureType?: string | null | undefined;
  isDraft?: boolean | undefined;
  createdAtMs?: number | undefined;
  completedAtMs?: number | undefined;
}

/* -------------------------------------------------------------- Build health */

/**
 * What the Build history says about the environment.
 *
 * `DEGRADED` exists so a failure that a later Build did not resolve is visible
 * even when the newest row is a `SKIPPED` recurring close: "the newest row is not
 * a failure" is not the same as "nothing failed".
 */
export type BuildHealth = "HEALTHY" | "DEGRADED" | "FAILING" | "UNKNOWN";

/**
 * How the rows were ordered before "newest" meant anything.
 *
 * `list-environment-builds` returns newest first, so list order is usable. It is
 * still reported, because a caller that reordered or merged pages needs to know
 * which of the two answers it got.
 */
export type HealthOrdering = "created-timestamp" | "list-order";

export interface BuildHealthReport {
  health: BuildHealth;
  orderedBy: HealthOrdering;
  /** Newest non-draft row with a SUCCEEDED status. Never "newest non-skipped". */
  latestSucceededBuildId?: string;
  latestSucceededAtMs?: number;
  /** Age of that Build against the caller's `asOfMs`. Omitted when not derivable. */
  ageMs?: number;
  ageDays?: number;
  /** `triggerType` and `source` on that Build: RECURRING is not MANUAL. */
  triggerType?: string;
  source?: string;
  /** Newest non-draft terminal row, whatever its outcome. */
  latestTerminalBuildId?: string;
  latestTerminalOutcome?: BuildOutcome;
  counts: Record<BuildOutcome, number>;
  /** Draft rows seen and excluded. A draft Build is never the environment's. */
  draftsExcluded: number;
  recentFailedBuildIds: string[];
  recentSkippedBuildIds: string[];
  inProgressBuildIds: string[];
  /** True when no unscanned page remained, so an absence is an absence. */
  conclusive: boolean;
  reason: string;
  /** Always unreadable on this authority; never omitted. */
  activeBuild: ActiveBuildRef;
  activeBuildReason: string;
  trust: typeof DELEGATED_TRUST;
}

/**
 * Judge Build health from rows the caller read back.
 *
 * `SKIPPED` is deliberately not a fault: Cursor emits it when a recurring Build
 * had nothing to rebuild, which is the schedule working. It is reported so the
 * caller can see the schedule ran, and it never lowers the verdict.
 */
export function assessBuildHealth(args: {
  asOfMs: number;
  builds?: HealthBuildRow[] | undefined;
  /** True when the last page read reported `hasMore: false`. */
  conclusive?: boolean | undefined;
}): BuildHealthReport {
  const supplied = args.builds ?? [];
  const drafts = supplied.filter((row) => row.isDraft === true);
  const rows = supplied.filter((row) => row.isDraft !== true);
  const orderedBy: HealthOrdering = rows.every((row) => row.createdAtMs !== undefined)
    ? "created-timestamp"
    : "list-order";
  const ordered =
    orderedBy === "created-timestamp"
      ? [...rows].sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0))
      : rows;

  const counts: Record<BuildOutcome, number> = {
    succeeded: 0,
    failed: 0,
    skipped: 0,
    cancelled: 0,
    "in-progress": 0,
    unknown: 0,
  };
  for (const row of ordered) counts[buildOutcome(row.status)] += 1;

  const succeededIndex = ordered.findIndex(
    (row) => buildOutcome(row.status) === "succeeded",
  );
  const succeeded = succeededIndex === -1 ? undefined : ordered[succeededIndex];
  const terminal = ordered.find((row) => isTerminalBuild(row.status));
  const failedIndex = ordered.findIndex((row) => buildOutcome(row.status) === "failed");
  // A failure the caller has not seen resolved: either newer than the newest
  // success, or present with no success in the window at all.
  const unresolvedFailure =
    failedIndex !== -1 && (succeededIndex === -1 || failedIndex < succeededIndex);

  const health: BuildHealth =
    ordered.length === 0
      ? "UNKNOWN"
      : terminal !== undefined && buildOutcome(terminal.status) === "failed"
        ? "FAILING"
        : unresolvedFailure
          ? "DEGRADED"
          : succeeded !== undefined
            ? "HEALTHY"
            : "UNKNOWN";

  const conclusive = args.conclusive === true;
  const report: BuildHealthReport = {
    health,
    orderedBy,
    counts,
    draftsExcluded: drafts.length,
    recentFailedBuildIds: idsOf(ordered, "failed"),
    recentSkippedBuildIds: idsOf(ordered, "skipped"),
    inProgressBuildIds: idsOf(ordered, "in-progress"),
    conclusive,
    reason: "",
    activeBuild: unreadableActiveBuild(),
    activeBuildReason: ACTIVE_BUILD_UNREADABLE_REASON,
    trust: DELEGATED_TRUST,
  };

  if (terminal !== undefined) {
    report.latestTerminalBuildId = terminal.buildId;
    report.latestTerminalOutcome = buildOutcome(terminal.status);
  }
  if (succeeded !== undefined) {
    report.latestSucceededBuildId = succeeded.buildId;
    if (succeeded.triggerType !== undefined) report.triggerType = succeeded.triggerType;
    if (succeeded.source !== undefined) report.source = succeeded.source;
    // completedAtMs is when the disk was finished; createdAtMs is the fallback,
    // and a Build with neither has no age rather than an age of zero.
    const at = succeeded.completedAtMs ?? succeeded.createdAtMs;
    if (at !== undefined) {
      report.latestSucceededAtMs = at;
      // A row newer than asOfMs has no age rather than a negative one: a clock
      // the caller supplied and a timestamp Cursor supplied are two clocks.
      if (args.asOfMs >= at) {
        const ageMs = args.asOfMs - at;
        report.ageMs = ageMs;
        report.ageDays = Math.floor(ageMs / 86_400_000);
      }
    }
  }

  report.reason = buildHealthReason(report, ordered.length);
  return report;
}

function idsOf(rows: HealthBuildRow[], outcome: BuildOutcome): string[] {
  return rows
    .filter((row) => buildOutcome(row.status) === outcome)
    .slice(0, MAX_REPORTED_BUILD_IDS)
    .map((row) => row.buildId);
}

function buildHealthReason(report: BuildHealthReport, rowCount: number): string {
  const paging = report.conclusive
    ? ""
    : " Further pages remained unread, so this window may omit older history and absence-based conclusions remain incomplete.";
  const age =
    report.ageDays === undefined
      ? ""
      : ` Its prepared disk is ${report.ageDays} day(s) old.`;
  switch (report.health) {
    case "HEALTHY":
      return (
        `Build ${report.latestSucceededBuildId} SUCCEEDED and no later Build failed.` +
        age +
        ` ${report.counts.skipped} skipped row(s) in this window are the recurring schedule finding ` +
        "nothing to rebuild, not a fault. SUCCEEDED is not activation: the active Build is unreadable here." +
        paging
      );
    case "FAILING":
      return (
        `The newest terminal Build ${report.latestTerminalBuildId} FAILED. Read its logs before ` +
        "triggering anything: the trigger has no idempotency key, so a retry is a second Build." +
        paging
      );
    case "DEGRADED":
      return (
        `Build ${report.recentFailedBuildIds[0]} FAILED and no later Build in this window SUCCEEDED. ` +
        "The newest row is not a failure, which is not the same as nothing having failed." +
        paging
      );
    default:
      return rowCount === 0
        ? "No non-draft Build rows were supplied, so Build health could not be judged." + paging
        : "No SUCCEEDED Build appears in this window, and no failure does either, so health is " +
            "indeterminate rather than healthy." +
            paging;
  }
}

/* ---------------------------------------------------------- source freshness */

/**
 * Whether the configuration of record moved since the last successful Build.
 *
 * `undeclared` and `unknown` are separate answers. Nothing declared is not
 * evidence of no change, and a baseline with no matching observation is not
 * evidence either.
 */
export type SourceDrift = "unchanged" | "changed" | "unknown" | "undeclared";

/**
 * One end of a source comparison.
 *
 * Three independent anchors, because the configuration of record depends on the
 * managed type: a database-managed environment moves its
 * `environmentVersionPublicId`, a repository-file managed one moves the commit of
 * `.cursor/environment.json`, and a definition digest compares the document text
 * itself without carrying it.
 */
export interface SourceAnchor {
  environmentVersionPublicId?: string | undefined;
  definitionDigest?: string | undefined;
  commitSha?: string | undefined;
}

export interface SourceFreshness {
  drift: SourceDrift;
  managedAs: EnvironmentManagedAs;
  /** Anchors that were comparable, and whether each matched. */
  comparisons: Array<{ anchor: keyof SourceAnchor; baseline: string; observed: string; changed: boolean }>;
  /**
   * `CONFIG_CHANGE` rows newer than the newest successful Build.
   *
   * Evidence that a configuration change has not been consumed by a successful
   * Build. Not attributable to the definition: a secrets change emits
   * `CONFIG_CHANGE` too, so this establishes staleness without naming its cause.
   */
  pendingConfigurationChangeBuildIds: string[];
  reason: string;
}

export function assessSourceFreshness(args: {
  /** Exactly as read from `environment-info`: null database, a path repository-file. */
  environmentJsonPath?: string | null | undefined;
  baseline?: SourceAnchor | undefined;
  observed?: SourceAnchor | undefined;
  builds?: HealthBuildRow[] | undefined;
  buildHealth: BuildHealthReport;
}): SourceFreshness {
  const anchors: Array<keyof SourceAnchor> = [
    "environmentVersionPublicId",
    "definitionDigest",
    "commitSha",
  ];
  const comparisons: SourceFreshness["comparisons"] = [];
  let declared = false;
  for (const anchor of anchors) {
    const baseline = args.baseline?.[anchor];
    const observed = args.observed?.[anchor];
    if (baseline !== undefined || observed !== undefined) declared = true;
    if (baseline === undefined || observed === undefined) continue;
    comparisons.push({ anchor, baseline, observed, changed: baseline !== observed });
  }

  const pending = pendingConfigurationChanges(args.builds ?? [], args.buildHealth);
  const changedAnchors = comparisons.filter((entry) => entry.changed);

  const drift: SourceDrift =
    changedAnchors.length > 0 || pending.length > 0
      ? "changed"
      : comparisons.length > 0
        ? "unchanged"
        : declared
          ? "unknown"
          : "undeclared";

  return {
    drift,
    managedAs: managedAsFromPath(args.environmentJsonPath),
    comparisons,
    pendingConfigurationChangeBuildIds: pending,
    reason: sourceReason({ drift, comparisons, changedAnchors, pending }),
  };
}

/**
 * Configuration-change Builds no successful Build has superseded.
 *
 * Rows are already newest-first from `assessBuildHealth`'s ordering contract, so
 * "newer than the newest success" is a prefix of that order. When there is no
 * successful row at all, every configuration-change row is still pending.
 */
function pendingConfigurationChanges(
  rows: HealthBuildRow[],
  health: BuildHealthReport,
): string[] {
  const nonDraft = rows.filter((row) => row.isDraft !== true);
  const ordered =
    health.orderedBy === "created-timestamp"
      ? [...nonDraft].sort((left, right) => (right.createdAtMs ?? 0) - (left.createdAtMs ?? 0))
      : nonDraft;
  const succeededIndex =
    health.latestSucceededBuildId === undefined
      ? ordered.length
      : ordered.findIndex((row) => row.buildId === health.latestSucceededBuildId);
  const cutoff = succeededIndex === -1 ? ordered.length : succeededIndex;
  return ordered
    .slice(0, cutoff)
    .filter((row) => row.triggerType === CONFIG_CHANGE_TRIGGER)
    .slice(0, MAX_REPORTED_BUILD_IDS)
    .map((row) => row.buildId);
}

function sourceReason(args: {
  drift: SourceDrift;
  comparisons: SourceFreshness["comparisons"];
  changedAnchors: SourceFreshness["comparisons"];
  pending: string[];
}): string {
  const pendingSentence =
    args.pending.length === 0
      ? ""
      : ` ${args.pending.length} CONFIG_CHANGE Build(s) (${args.pending.join(", ")}) are newer than ` +
        "the newest successful Build, so a configuration change has not been consumed by a " +
        "successful Build. That change may be Install/Start or a secret: a secrets change emits " +
        "CONFIG_CHANGE too, so it is not attributed to the definition.";
  switch (args.drift) {
    case "changed":
      return (
        (args.changedAnchors.length === 0
          ? "The declared anchors matched, but the Build history still shows unconsumed configuration change."
          : `${args.changedAnchors.map((entry) => entry.anchor).join(", ")} differ from the recorded baseline, ` +
            "so the configuration of record moved.") + pendingSentence
      );
    case "unchanged":
      return (
        `${args.comparisons.map((entry) => entry.anchor).join(", ")} match the recorded baseline, and no ` +
        "unconsumed configuration-change Build appears in this window."
      );
    case "unknown":
      return (
        "A source comparison needs both a recorded baseline anchor and an observed one; only one side " +
        "was supplied, so source freshness is unproven rather than unchanged." + pendingSentence
      );
    default:
      return (
        "No source baseline was declared, so nothing is claimed about the configuration of record. " +
        "Record environmentVersionPublicId for a database-managed environment, or the default-branch " +
        "commit of .cursor/environment.json for a repository-file managed one." + pendingSentence
      );
  }
}

/* ------------------------------------------------------- toolchain freshness */

/** What the caller believes an installed tool's version should be. */
export interface ToolchainExpectation {
  name: string;
  /** The version the caller declared. Compared exactly, after normalization. */
  expectedVersion?: string | undefined;
  /** A current upstream version the caller obtained elsewhere. */
  upstreamVersion?: string | undefined;
}

/**
 * One tool's verdict.
 *
 * `unreported` is not `drifted`: a version the delegate could not read is missing
 * evidence, and spending a Build on missing evidence is the mistake this
 * separation prevents.
 */
export type ToolchainVerdict = "matched" | "drifted" | "unreported" | "undeclared";

export interface ToolchainFinding {
  name: string;
  verdict: ToolchainVerdict;
  observedVersion?: string;
  expectedVersion?: string;
  upstreamVersion?: string;
  reason: string;
}

export type ToolchainDrift = "matched" | "drifted" | "unknown" | "undeclared";

export interface ToolchainFreshness {
  drift: ToolchainDrift;
  findings: ToolchainFinding[];
  driftedNames: string[];
  unreportedNames: string[];
  reason: string;
  trust: typeof DELEGATED_TRUST;
}

/**
 * Normalize a version string before comparing it.
 *
 * Whitespace and one leading `v` only. Nothing is parsed as semver and nothing is
 * ordered: this authority can say two version strings differ, and cannot say
 * which of them is newer, so `drifted` never claims a direction.
 */
export function normalizeVersion(value: string): string {
  const trimmed = value.trim();
  return /^v(?=\d)/i.test(trimmed) ? trimmed.slice(1) : trimmed;
}

export function assessToolchainFreshness(args: {
  observed?: ToolchainObservation[] | undefined;
  expectations?: ToolchainExpectation[] | undefined;
}): ToolchainFreshness {
  const observed = new Map<string, string>();
  for (const entry of args.observed ?? []) {
    if (!observed.has(entry.name)) observed.set(entry.name, entry.version);
  }
  const expectations = args.expectations ?? [];
  const declaredNames = new Set(expectations.map((entry) => entry.name));
  const findings: ToolchainFinding[] = [];

  for (const expectation of expectations) {
    findings.push(finding(expectation, observed.get(expectation.name)));
  }
  // Installed versions nobody declared an expectation for are still recorded:
  // "what is installed" is the evidence a later comparison needs.
  for (const [name, version] of observed) {
    if (declaredNames.has(name)) continue;
    findings.push({
      name,
      verdict: "undeclared",
      observedVersion: version,
      reason: `${name} ${version} is installed, and no expected or upstream version was declared for it.`,
    });
  }

  const driftedNames = findings
    .filter((entry) => entry.verdict === "drifted")
    .map((entry) => entry.name);
  const unreportedNames = findings
    .filter((entry) => entry.verdict === "unreported")
    .map((entry) => entry.name);
  const matched = findings.some((entry) => entry.verdict === "matched");

  const drift: ToolchainDrift =
    driftedNames.length > 0
      ? "drifted"
      : unreportedNames.length > 0
        ? "unknown"
        : matched
          ? "matched"
          : "undeclared";

  return {
    drift,
    findings,
    driftedNames,
    unreportedNames,
    reason: toolchainReason(drift, driftedNames, unreportedNames),
    trust: DELEGATED_TRUST,
  };
}

function finding(
  expectation: ToolchainExpectation,
  observedVersion: string | undefined,
): ToolchainFinding {
  const base: ToolchainFinding = {
    name: expectation.name,
    verdict: "undeclared",
    ...(observedVersion === undefined ? {} : { observedVersion }),
    ...(expectation.expectedVersion === undefined
      ? {}
      : { expectedVersion: expectation.expectedVersion }),
    ...(expectation.upstreamVersion === undefined
      ? {}
      : { upstreamVersion: expectation.upstreamVersion }),
    reason: "",
  };

  if (observedVersion === undefined) {
    return {
      ...base,
      verdict: "unreported",
      reason:
        `No installed version of ${expectation.name} was reported, so drift is unproven. Declare it ` +
        "in the qualification expectations so the run records it; a missing version is never read as a match.",
    };
  }
  if (expectation.expectedVersion === undefined && expectation.upstreamVersion === undefined) {
    return {
      ...base,
      verdict: "undeclared",
      reason: `${expectation.name} ${observedVersion} is installed, and no expected or upstream version was declared for it.`,
    };
  }

  const installed = normalizeVersion(observedVersion);
  const references: Array<[string, string]> = [
    ...(expectation.expectedVersion === undefined
      ? []
      : ([["declared", expectation.expectedVersion]] as Array<[string, string]>)),
    ...(expectation.upstreamVersion === undefined
      ? []
      : ([["upstream", expectation.upstreamVersion]] as Array<[string, string]>)),
  ];
  const differing = references.filter(([, value]) => normalizeVersion(value) !== installed);
  if (differing.length === 0) {
    return {
      ...base,
      verdict: "matched",
      reason: `${expectation.name} ${observedVersion} matches every declared reference version.`,
    };
  }
  return {
    ...base,
    verdict: "drifted",
    reason:
      `${expectation.name} reports ${observedVersion}, which differs from the ` +
      `${differing.map(([label, value]) => `${label} ${value}`).join(" and ")} version. The strings ` +
      "differ; which is newer is not established here.",
  };
}

function toolchainReason(
  drift: ToolchainDrift,
  driftedNames: string[],
  unreportedNames: string[],
): string {
  switch (drift) {
    case "drifted":
      return (
        `${driftedNames.join(", ")} do not match their declared or upstream version. Cursor's ` +
        "recurring Build cannot observe this: it re-runs Install, and whether that installs a " +
        "different version is a property of your scripts and of upstream."
      );
    case "unknown":
      return (
        `No installed version was reported for ${unreportedNames.join(", ")}, so toolchain drift is ` +
        "unproven. A missing version is missing evidence, not a match and not a drift."
      );
    case "matched":
      return "Every declared tool reports the version the caller declared for it.";
    default:
      return "No toolchain expectation was declared, so nothing is claimed about installed versions.";
  }
}

/* ------------------------------------------------------- combined assessment */

/**
 * The one machine-readable answer an external scheduler consumes.
 *
 * `BUILD_UNHEALTHY` outranks the two staleness states deliberately: when the
 * pipeline is failing, the actionable finding is the failure, and refreshing onto
 * a broken Install spends a Build to reproduce it.
 */
export type FreshnessState =
  | "HEALTHY"
  | "STALE_SOURCE"
  | "STALE_TOOLCHAIN"
  | "BUILD_UNHEALTHY"
  | "INDETERMINATE";

/**
 * Process exit codes for cron, launchd, or a CI step.
 *
 * Stable and part of the contract. `1` is deliberately unused: a crash, a usage
 * error, or a policy refusal already exits `1`, and a scheduler must be able to
 * tell "the environment is stale" from "the check did not run".
 */
export const FRESHNESS_EXIT_CODES = {
  HEALTHY: 0,
  STALE_TOOLCHAIN: 10,
  STALE_SOURCE: 11,
  BUILD_UNHEALTHY: 20,
  INDETERMINATE: 30,
} as const satisfies Record<FreshnessState, number>;

export function exitCodeFor(state: FreshnessState): number {
  return FRESHNESS_EXIT_CODES[state];
}

/**
 * Whether a refresh Build is warranted.
 *
 * `NOT_NEEDED` is the answer for an unchanged environment, and it is the reason
 * repeating this check is free: nothing was requested, so nothing is dispatched.
 */
export type RefreshDisposition = "NOT_NEEDED" | "ELIGIBLE" | "WITHHELD";

export interface RefreshRecommendation {
  disposition: RefreshDisposition;
  /** Whether the caller asked for a Build at all. */
  requested: boolean;
  /** This judgement never writes. A dispatch is a separate confirmed call. */
  dispatched: false;
  /**
   * Active state is unreadable on this authority. A verified draft response says
   * only that the refresh does not become the Build new agents boot from; it does
   * not establish which Build was active before or after the call.
   */
  priorActiveBuild: "unverified";
  reason: string;
  nextSteps: string[];
}

export interface FreshnessAssessment {
  state: FreshnessState;
  exitCode: number;
  environmentPublicId: string;
  asOfMs: number;
  build: BuildHealthReport;
  source: SourceFreshness;
  toolchain: ToolchainFreshness;
  refresh: RefreshRecommendation;
  activeBuild: ActiveBuildRef;
  activeBuildReason: string;
  reason: string;
  nextSteps: string[];
  trust: typeof DELEGATED_TRUST;
}

/**
 * Assess one environment from readback the caller holds.
 *
 * Pure: the same inputs always produce the same assessment, the same exit code,
 * and the same refresh disposition. That is what makes a second consecutive check
 * over an unchanged environment a no-op rather than a second Build.
 */
export function assessEnvironmentFreshness(args: {
  environmentPublicId: string;
  asOfMs: number;
  builds?: HealthBuildRow[] | undefined;
  buildsConclusive?: boolean | undefined;
  environmentJsonPath?: string | null | undefined;
  baseline?: SourceAnchor | undefined;
  observed?: SourceAnchor | undefined;
  toolchainObserved?: ToolchainObservation[] | undefined;
  toolchainExpectations?: ToolchainExpectation[] | undefined;
  /** The caller asking for a Build when toolchain drift is established. */
  refreshRequested?: boolean | undefined;
}): FreshnessAssessment {
  const build = assessBuildHealth({
    asOfMs: args.asOfMs,
    ...(args.builds === undefined ? {} : { builds: args.builds }),
    ...(args.buildsConclusive === undefined ? {} : { conclusive: args.buildsConclusive }),
  });
  const source = assessSourceFreshness({
    ...(args.environmentJsonPath === undefined
      ? {}
      : { environmentJsonPath: args.environmentJsonPath }),
    ...(args.baseline === undefined ? {} : { baseline: args.baseline }),
    ...(args.observed === undefined ? {} : { observed: args.observed }),
    ...(args.builds === undefined ? {} : { builds: args.builds }),
    buildHealth: build,
  });
  const toolchain = assessToolchainFreshness({
    ...(args.toolchainObserved === undefined ? {} : { observed: args.toolchainObserved }),
    ...(args.toolchainExpectations === undefined
      ? {}
      : { expectations: args.toolchainExpectations }),
  });

  const state: FreshnessState =
    build.health === "FAILING" || build.health === "DEGRADED"
      ? "BUILD_UNHEALTHY"
      : source.drift === "changed"
        ? "STALE_SOURCE"
        : toolchain.drift === "drifted"
          ? "STALE_TOOLCHAIN"
          : build.health === "UNKNOWN" ||
              source.drift === "unknown" ||
              toolchain.drift === "unknown"
            ? "INDETERMINATE"
            : "HEALTHY";

  const unboundBuildEvidence =
    args.refreshRequested === true &&
    (args.builds ?? []).some(
      (row) => row.environmentPublicId !== args.environmentPublicId,
    );
  const refresh = unboundBuildEvidence
    ? {
        requested: true,
        dispatched: false as const,
        priorActiveBuild: "unverified" as const,
        disposition: "WITHHELD" as const,
        reason:
          "A refresh write requires every Build row to carry the requested environmentPublicId. Missing or foreign provenance cannot authorize a Build.",
        nextSteps: [
          "Re-read Build history for the exact environment and preserve environmentPublicId on every row before requesting refresh.",
        ],
      }
    : recommendRefresh({
        state,
        requested: args.refreshRequested === true,
        toolchain,
        build,
        source,
      });

  return {
    state,
    exitCode: exitCodeFor(state),
    environmentPublicId: args.environmentPublicId,
    asOfMs: args.asOfMs,
    build,
    source,
    toolchain,
    refresh,
    activeBuild: unreadableActiveBuild(),
    activeBuildReason: ACTIVE_BUILD_UNREADABLE_REASON,
    reason: stateReason(state, build, source, toolchain),
    nextSteps: stateNextSteps(state, build, source, toolchain),
    trust: DELEGATED_TRUST,
  };
}

const DRAFT_REFRESH_LIMIT =
  "The only supported trigger produces a DRAFT Build, which never becomes the Build new agents " +
  "boot from, so a refresh proves the toolchain a new Install produces and does not deliver it. " +
  "Activation stays an owner action.";

function recommendRefresh(args: {
  state: FreshnessState;
  requested: boolean;
  toolchain: ToolchainFreshness;
  build: BuildHealthReport;
  source: SourceFreshness;
}): RefreshRecommendation {
  const base = {
    requested: args.requested,
    dispatched: false as const,
    priorActiveBuild: "unverified" as const,
  };

  if (args.state === "HEALTHY") {
    return {
      ...base,
      disposition: "NOT_NEEDED",
      reason:
        "Nothing changed, so no Build is requested. The trigger has no idempotency key, so a Build " +
        "is never spent confirming a state that already reads healthy; repeating this check is a no-op.",
      nextSteps: ["Re-run this check on your schedule. It launches nothing and changes nothing."],
    };
  }

  if (args.state === "BUILD_UNHEALTHY") {
    return {
      ...base,
      disposition: "WITHHELD",
      reason:
        `Build health is ${args.build.health}, so a refresh is withheld: triggering onto a failing ` +
        "Install spends another Build reproducing the same failure.",
      nextSteps: [
        `Fetch the logs for ${args.build.recentFailedBuildIds[0] ?? args.build.latestTerminalBuildId ?? "the failed Build"} before triggering anything.`,
        "Fix the cause, then re-run this check; active state remains unreadable on this authority.",
      ],
    };
  }

  if (args.state === "STALE_SOURCE") {
    const pending = args.source.pendingConfigurationChangeBuildIds;
    return {
      ...base,
      disposition: "WITHHELD",
      reason:
        pending.length > 0
          ? `Configuration-change Build ${pending.join(", ")} has not yet been consumed by a successful Build, so another refresh is withheld.`
          : "The configuration of record moved, and a Build from the saved configuration would not carry " +
            "a change that is not saved yet. Persisting configuration is an owner Save or a repository " +
            "commit, which no supported authority performs here.",
      nextSteps:
        pending.length > 0
          ? [
              `Monitor ${pending.join(", ")} to a terminal status before considering another Build.`,
              "A CONFIG_CHANGE row may have come from a secrets change, so do not read it as a definition change.",
            ]
          : [
              "Persist the definition first: cursor_save_environment names the exact owner action for this managed type.",
              "Then re-run this check; a Save fires its own CONFIG_CHANGE Build.",
            ],
    };
  }

  if (args.state === "INDETERMINATE") {
    return {
      ...base,
      disposition: "WITHHELD",
      reason:
        "Drift was not established, so no Build is requested. A Build is a write, and this server " +
        "never spends one on an unproven condition.",
      nextSteps: [
        ...(args.toolchain.unreportedNames.length === 0
          ? []
          : [
              `Declare ${args.toolchain.unreportedNames.join(", ")} in cursor_qualify_environment's expect.toolchain so a run records their versions.`,
            ]),
        ...(args.build.conclusive
          ? []
          : ["Page the Build list forward so an absent row means an absent row."]),
        "Re-run this check once the evidence is complete.",
      ],
    };
  }

  if (!args.requested) {
    return {
      ...base,
      disposition: "WITHHELD",
      reason:
        `Toolchain drift is established for ${args.toolchain.driftedNames.join(", ")}, but no Build was ` +
        "requested. This check never triggers on its own.",
      nextSteps: [
        "Call cursor_refresh_environment_toolchain with confirm: true to spend exactly one draft Build.",
        DRAFT_REFRESH_LIMIT,
      ],
    };
  }

  return {
    ...base,
    disposition: "ELIGIBLE",
    reason:
      `Toolchain drift is established for ${args.toolchain.driftedNames.join(", ")}, Build health is ` +
      "healthy, and the configuration of record has not moved, so exactly one draft Build is warranted.",
    nextSteps: [
      "Dispatch exactly one draft Build and monitor that exact buildId to a terminal status.",
      DRAFT_REFRESH_LIMIT,
    ],
  };
}

function stateReason(
  state: FreshnessState,
  build: BuildHealthReport,
  source: SourceFreshness,
  toolchain: ToolchainFreshness,
): string {
  switch (state) {
    case "HEALTHY":
      return `The environment appears healthy. ${build.reason}`;
    case "BUILD_UNHEALTHY":
      return `The environment's Builds are not healthy. ${build.reason}`;
    case "STALE_SOURCE":
      return `The environment is stale by source. ${source.reason}`;
    case "STALE_TOOLCHAIN":
      return `The environment is stale by toolchain. ${toolchain.reason}`;
    default:
      return (
        "Freshness is indeterminate: at least one axis had incomplete evidence. " +
        `build=${build.health} source=${source.drift} toolchain=${toolchain.drift}`
      );
  }
}

function stateNextSteps(
  state: FreshnessState,
  build: BuildHealthReport,
  source: SourceFreshness,
  toolchain: ToolchainFreshness,
): string[] {
  const activeState =
    "Read active state from the environment dashboard if you need it: no supported authority here " +
    "reports the environment's active Build, so HEALTHY describes Build history only.";
  switch (state) {
    case "HEALTHY":
      return [activeState];
    case "BUILD_UNHEALTHY":
      return [
        `Fetch the logs for ${build.recentFailedBuildIds[0] ?? build.latestTerminalBuildId ?? "the failed Build"} with cursor_get_build_logs.`,
        "Do not re-trigger to see whether it passes this time: the trigger has no idempotency key.",
        activeState,
      ];
    case "STALE_SOURCE":
      return [
        source.pendingConfigurationChangeBuildIds.length === 0
          ? "Persist the definition through the owner action cursor_save_environment names for this managed type."
          : `Monitor ${source.pendingConfigurationChangeBuildIds.join(", ")} to a terminal status: a configuration change is not yet in a successful Build.`,
        "A CONFIG_CHANGE row may have come from a secrets change, so do not read it as a definition change.",
        activeState,
      ];
    case "STALE_TOOLCHAIN":
      return [
        `Refresh with exactly one draft Build if you want to prove a new Install fixes ${toolchain.driftedNames.join(", ")}.`,
        DRAFT_REFRESH_LIMIT,
        activeState,
      ];
    default:
      return [
        ...(toolchain.unreportedNames.length === 0
          ? []
          : [`Record the installed version of ${toolchain.unreportedNames.join(", ")} through cursor_qualify_environment.`]),
        ...(source.drift === "unknown"
          ? ["Supply both a baseline and an observed source anchor, or neither."]
          : []),
        ...(build.conclusive ? [] : ["Page the Build list forward before concluding anything."]),
        activeState,
      ];
  }
}
