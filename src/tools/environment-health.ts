/**
 * Environment Build health and toolchain freshness: the MCP boundary.
 *
 * Two tools, and the split between them is the point.
 *
 * `cursor_assess_environment_health` is the **cheap check**. It launches nothing,
 * calls nothing, reads no clock unless the caller withholds `asOfMs`, and judges
 * only readback the caller already holds. It is annotated read-only, so `read:*`
 * grants it, and it is the tool an external scheduler runs: it returns a
 * `FreshnessState` and a stable `exitCode` that cron, launchd, or a CI step can
 * branch on without this server keeping any state for it. Running it twice over an
 * unchanged environment is a no-op both times, because it never writes.
 *
 * `cursor_refresh_environment_toolchain` is the **write**, and it is the same
 * judgement plus one dispatch. It refuses to spend a Build unless that judgement
 * establishes toolchain drift *and* the caller passes `confirm: true`: an
 * unchanged environment, a failing Build pipeline, unsaved configuration, or
 * missing evidence each return the withheld reason and dispatch nothing. When it
 * does dispatch, it dispatches exactly one **draft** Build through the same
 * mission `cursor_trigger_build` uses -- there is no idempotency key, so it never
 * retries, and a draft Build by Cursor's own contract never becomes the Build new
 * agents boot from. Active state remains unreadable, so neither outcome is
 * described as proof that a particular prior Build stayed active.
 *
 * Neither tool stores anything. The caller holds the baseline anchors and the
 * recorded toolchain versions between calls, exactly as every other Environment
 * Operations tool requires.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentScope } from "../agent-scope.js";
import type { CursorClient } from "../client.js";
import type { Policy } from "../config.js";
import { activeProfile } from "../config.js";
import {
  CursorDelegatedRunner,
  MAX_MONITOR_ATTEMPTS,
  MAX_WAIT_MS,
  type DelegatedRunner,
} from "../delegated-run.js";
import {
  assessEnvironmentFreshness,
  type FreshnessAssessment,
  type HealthBuildRow,
  type SourceAnchor,
  type ToolchainExpectation,
} from "../environment-health.js";
import {
  ACTIVE_BUILD_UNREADABLE_REASON,
  attributeTriggeredBuild,
  buildLine,
  findBuild,
  monitorOutcome,
  type BuildView,
  type ToolchainObservation,
} from "../environment-operations.js";
import { PolicyError } from "../errors.js";
import { CREATE, LOCAL_READ } from "./annotations.js";
import {
  EVIDENCE,
  collectMission,
  delegationResult,
  pagesOf,
  reportIdentity,
} from "./environment-operations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

/* ------------------------------------------------------------------- arguments */

const Block = z.record(z.string(), z.unknown());

/** Bounds on caller-supplied readback. Every one of these is a ceiling. */
const MAX_ROWS = 200;
const MAX_TOOLS = 32;

const TargetIdArg = z
  .string()
  .min(1)
  .describe(
    "environmentPublicId declared out of band before the call. An id a run reported about itself is not a substitute.",
  );

const BuildRowArg = z
  .strictObject({
    buildId: z.string().min(1),
    status: z
      .string()
      .min(1)
      .describe("status verbatim. An unrecognised value is never read as success."),
    environmentPublicId: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    triggerType: z
      .string()
      .min(1)
      .optional()
      .describe("RECURRING, MANUAL, or CONFIG_CHANGE as the row carried it."),
    failureType: z.string().min(1).nullable().optional(),
    isDraft: z
      .boolean()
      .optional()
      .describe("Draft rows are excluded from health: a draft Build is never the environment's Build."),
    createdAtMs: z.number().int().nonnegative().optional(),
    completedAtMs: z.number().int().nonnegative().optional(),
  })
  .describe("A Build row as cursor_list_builds reported it.");

const SourceAnchorArg = z
  .strictObject({
    environmentVersionPublicId: z
      .string()
      .min(1)
      .optional()
      .describe("Public opaque version. Never the numeric builds[].environmentVersionId."),
    definitionDigest: z
      .string()
      .min(1)
      .optional()
      .describe("Digest from cursor_inspect_environment_definition. Never the definition text."),
    commitSha: z
      .string()
      .min(1)
      .optional()
      .describe("Default-branch commit of .cursor/environment.json, for a repository-file managed environment."),
  })
  .describe("One end of a source comparison. Both ends must supply the same anchor to be compared.");

const HEALTH_INPUT = {
  environmentPublicId: TargetIdArg,
  builds: z
    .array(BuildRowArg)
    .max(MAX_ROWS)
    .optional()
    .describe("Build rows from cursor_list_builds, newest first."),
  buildsConclusive: z
    .boolean()
    .optional()
    .describe(
      "True only when the last page you read reported hasMore: false. Otherwise an absent row may just be unpaged.",
    ),
  asOfMs: z
    .number()
    .int()
    .nonnegative()
    .optional()
    .describe("Instant to age the newest successful Build against. Defaults to now."),
  environmentJsonPath: z
    .string()
    .min(1)
    .nullable()
    .optional()
    .describe(
      "Exactly as read from environment-info: null is database-managed, a path is repository-file managed.",
    ),
  baseline: SourceAnchorArg.optional().describe(
    "Source anchors you recorded when the environment was last known good.",
  ),
  observed: SourceAnchorArg.optional().describe("The same anchors as they read now."),
  toolchain: z
    .strictObject({
      observed: z
        .array(z.strictObject({ name: z.string().min(1), version: z.string().min(1) }))
        .max(MAX_TOOLS)
        .optional()
        .describe("Installed versions, as cursor_qualify_environment recorded them."),
      expect: z
        .array(
          z.strictObject({
            name: z.string().min(1),
            expectedVersion: z.string().min(1).optional(),
            upstreamVersion: z
              .string()
              .min(1)
              .optional()
              .describe("A current upstream version you obtained elsewhere. This server fetches none."),
          }),
        )
        .max(MAX_TOOLS)
        .optional()
        .describe(
          "What each tool's version should be. A name with neither reference is recorded, not judged.",
        ),
    })
    .optional(),
};

const MonitorArgs = {
  monitorAttempts: z
    .number()
    .int()
    .min(1)
    .max(MAX_MONITOR_ATTEMPTS)
    .optional()
    .describe("List readbacks the delegate may make while the refresh Build is IN_PROGRESS."),
  monitorIntervalSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe("Seconds the delegate waits between readbacks."),
};

const ResumeIdArg = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

const ResumeArg = z
  .strictObject({ agentId: ResumeIdArg, runId: ResumeIdArg })
  .optional()
  .describe("Handle from an earlier DELEGATION_PENDING result. Resuming launches nothing new.");

const WaitArg = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_MS)
  .optional()
  .describe(
    `Milliseconds to wait for the delegate before returning a resume handle. Default 0, maximum ${MAX_WAIT_MS}.`,
  );

/**
 * Only `status` is required, for the same reason as every other Environment
 * Operations result: one byte budget covers the whole payload, and a truncated
 * result must still be a legal result that names its own state. A pending
 * delegation carries no assessment at all, and that is a legal result too.
 */
const ASSESSMENT_OUT = {
  status: z.string(),
  /** Stable process exit code for an external scheduler. */
  exitCode: z.number().optional(),
  state: z.string().optional(),
  environmentPublicId: z.string().optional(),
  build: Block.optional(),
  source: Block.optional(),
  toolchain: Block.optional(),
  refresh: Block.optional(),
  activeBuild: Block.optional(),
  reason: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
  evidence: Block.optional(),
};

interface HealthCall {
  environmentPublicId: string;
  builds?: HealthBuildRow[];
  buildsConclusive?: boolean;
  asOfMs?: number;
  environmentJsonPath?: string | null;
  baseline?: SourceAnchor;
  observed?: SourceAnchor;
  toolchain?: {
    observed?: ToolchainObservation[];
    expect?: ToolchainExpectation[];
  };
}

/**
 * Run the judgement over one call's arguments.
 *
 * `now` is injected rather than read here so the two tools share one clock and a
 * test can pin it: an age is the only part of this assessment that depends on
 * when it ran.
 */
function assess(
  call: HealthCall,
  refreshRequested: boolean,
  now: () => number,
): FreshnessAssessment {
  return assessEnvironmentFreshness({
    environmentPublicId: call.environmentPublicId,
    asOfMs: call.asOfMs ?? now(),
    refreshRequested,
    ...(call.builds === undefined ? {} : { builds: call.builds }),
    ...(call.buildsConclusive === undefined
      ? {}
      : { buildsConclusive: call.buildsConclusive }),
    ...(call.environmentJsonPath === undefined
      ? {}
      : { environmentJsonPath: call.environmentJsonPath }),
    ...(call.baseline === undefined ? {} : { baseline: call.baseline }),
    ...(call.observed === undefined ? {} : { observed: call.observed }),
    ...(call.toolchain?.observed === undefined
      ? {}
      : { toolchainObserved: call.toolchain.observed }),
    ...(call.toolchain?.expect === undefined
      ? {}
      : { toolchainExpectations: call.toolchain.expect }),
  });
}

/** The assessment as structured output, identifiers and verdict first. */
function assessmentFields(assessment: FreshnessAssessment): Record<string, unknown> {
  return {
    state: assessment.state,
    exitCode: assessment.exitCode,
    environmentPublicId: assessment.environmentPublicId,
    build: { ...assessment.build },
    source: { ...assessment.source },
    toolchain: { ...assessment.toolchain },
    refresh: { ...assessment.refresh },
    activeBuild: { readable: false, reason: ACTIVE_BUILD_UNREADABLE_REASON },
    reason: assessment.reason,
    nextSteps: [...assessment.nextSteps],
  };
}

function assessmentLines(assessment: FreshnessAssessment): string[] {
  return [
    `${assessment.state}  exitCode=${assessment.exitCode}  build=${assessment.build.health}` +
      `  source=${assessment.source.drift}  toolchain=${assessment.toolchain.drift}`,
    `latestSucceeded=${assessment.build.latestSucceededBuildId ?? "(none)"}` +
      `  trigger=${assessment.build.triggerType ?? "(unreported)"}` +
      `  ageDays=${assessment.build.ageDays ?? "(unknown)"}`,
    "activeBuild=unreadable on this authority",
    assessment.reason,
    `refresh=${assessment.refresh.disposition}: ${assessment.refresh.reason}`,
    ...assessment.toolchain.findings.map(
      (entry) => `${entry.name}: ${entry.verdict}  ${entry.reason}`,
    ),
  ];
}

/* ---------------------------------------------------------------- registration */

export function registerEnvironmentHealthTools(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
  scope = new AgentScope(client, activeProfile(policy)),
  runner: DelegatedRunner = new CursorDelegatedRunner(
    client,
    activeProfile(policy),
    scope,
  ),
  now: () => number = () => Date.now(),
): string[] {
  const profile = activeProfile(policy);
  const registered: string[] = [];

  const define = <C extends GateableConfig, A extends unknown[]>(
    spec: ToolSpec<C, A>,
  ) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  define({
    name: "cursor_assess_environment_health",
    config: {
      title: "Cursor: assess environment health and freshness",
      description:
        "Judge Build health, source drift, and toolchain drift from readback you hold. Launches nothing and returns a scheduler exit code.",
      inputSchema: HEALTH_INPUT,
      outputSchema: ASSESSMENT_OUT,
      annotations: LOCAL_READ,
    },
    handler: async (call: HealthCall) => {
      // refreshRequested is false: this tool never asks for a Build, so an
      // established drift reads as WITHHELD with the exact next call rather than
      // as something this tool was about to do.
      const assessment = assess(call, false, now);
      return ok({
        source: "caller-supplied readback of a delegated read",
        text: assessmentLines(assessment).join("\n"),
        structured: {
          status: assessment.state,
          ...assessmentFields(assessment),
          evidence: EVIDENCE,
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_refresh_environment_toolchain",
    config: {
      title: "Cursor: refresh environment toolchain",
      description:
        "Spend exactly one draft Build when toolchain drift is established. Withheld for an unchanged, stale-by-source, failing, or unproven environment.",
      inputSchema: {
        environment: z
          .string()
          .min(1)
          .describe(
            "Named cloud environment to delegate into. Must be listed in the profile; grants its secrets and network policy.",
          ),
        ...HEALTH_INPUT,
        confirm: z
          .boolean()
          .optional()
          .describe(
            "Must be true to dispatch. Required only when drift is established; a no-op needs no confirmation.",
          ),
        ...MonitorArgs,
        resume: ResumeArg,
        waitMs: WaitArg,
      },
      outputSchema: {
        ...ASSESSMENT_OUT,
        delegation: Block.optional(),
        resume: Block.optional(),
        trigger: Block.optional(),
        monitor: Block.optional(),
        refreshBuild: Block.optional(),
      },
      annotations: CREATE,
    },
    handler: async (
      call: HealthCall & {
        environment: string;
        confirm?: boolean;
        monitorAttempts?: number;
        monitorIntervalSeconds?: number;
        resume?: { agentId: string; runId: string };
        waitMs?: number;
      },
    ) => {
      const assessment = assess(call, true, now);

      // Judged before anything is launched. An unchanged environment, a failing
      // pipeline, unsaved configuration, and missing evidence all stop here, so
      // none of them can spend a VM or a Build discovering that.
      if (assessment.refresh.disposition !== "ELIGIBLE") {
        const status =
          assessment.refresh.disposition === "NOT_NEEDED"
            ? "REFRESH_NOT_NEEDED"
            : "REFRESH_WITHHELD";
        return ok({
          source: "caller-supplied readback of a delegated read",
          text: [
            `${status}  ${assessment.state}  exitCode=${assessment.exitCode}`,
            assessment.refresh.reason,
            ...assessment.refresh.nextSteps.map((step) => `next: ${step}`),
          ].join("\n"),
          structured: {
            status,
            ...assessmentFields(assessment),
            evidence: EVIDENCE,
          },
          policy,
        });
      }

      // Only an eligible refresh needs confirmation, and it needs it explicitly:
      // the trigger has no idempotency key, so this is the last gate before a
      // write that cannot be taken back.
      if (call.confirm !== true) {
        throw new PolicyError(
          "cursor_refresh_environment_toolchain requires confirm: true, because it dispatches one " +
            "Build and the trigger has no idempotency key",
        );
      }

      const collected = await collectMission({
        runner,
        environment: call.environment,
        request: {
          mission: "trigger-build",
          environmentPublicId: call.environmentPublicId,
          ...(call.monitorAttempts === undefined
            ? {}
            : { monitorAttempts: call.monitorAttempts }),
          ...(call.monitorIntervalSeconds === undefined
            ? {}
            : { monitorIntervalSeconds: call.monitorIntervalSeconds }),
        },
        resume: call.resume,
        waitMs: call.waitMs,
      });
      if (collected.kind !== "report") return delegationResult(collected, policy);

      const report = collected.report;
      const pages = pagesOf(report);
      const identity = reportIdentity(report, call.environmentPublicId);
      const attribution = attributeTriggeredBuild({
        declaredEnvironmentPublicId: call.environmentPublicId,
        reportedEnvironmentPublicId: identity.conflicting ? undefined : identity.reported,
        dispatched: report.triggerDispatched,
        precondition: report.precondition,
        trigger: report.trigger,
        baselineBuildIds: report.baselineBuildIds,
        rows: pages.flatMap((page) => page.builds),
        otherActiveRuns: report.otherActiveRuns,
      });

      const monitor =
        attribution.buildId === undefined
          ? undefined
          : monitorOutcome({
              buildId: attribution.buildId,
              environmentPublicId: call.environmentPublicId,
              match: findBuild(pages, attribution.buildId, call.environmentPublicId),
              attempts: report.monitorAttempts,
              elapsedMs: report.monitorElapsedMs,
              deadlineExceeded: report.monitorDeadlineExceeded,
            });
      // The Build is reported once, as its own field, so a caller does not have
      // to decide which of two copies is authoritative.
      let verdict: Record<string, unknown> | undefined;
      let monitoredBuild: BuildView | undefined;
      if (monitor !== undefined) {
        const { build, ...rest } = monitor;
        verdict = { ...rest };
        monitoredBuild = build;
      }

      const draftVerified =
        attribution.status === "ADOPTED" && attribution.isDraft === true;
      const refreshStatus =
        attribution.status === "ADOPTED" && !draftVerified
          ? "DRAFT_STATUS_UNVERIFIED"
          : attribution.status;
      const refreshExecution = {
        ...assessment.refresh,
        dispatched: attribution.dispatched === true,
        priorActiveBuild: "unverified",
      };

      return ok({
        source: `delegated run ${collected.delegation.runId}`,
        text: [
          `${refreshStatus}  build=${attribution.buildId ?? "(none adopted)"}  dispatched=${attribution.dispatched}`,
          `refreshed for toolchain drift: ${assessment.toolchain.driftedNames.join(", ")}`,
          attribution.reason,
          ...(monitor === undefined ? [] : [`${monitor.status}: ${monitor.reason}`]),
          ...(monitoredBuild === undefined ? [] : [buildLine(monitoredBuild)]),
          ...(draftVerified
            ? [
                "The trigger reported isDraft=true, so this refresh does not become the Build new agents boot from. Active state remains unreadable.",
              ]
            : attribution.status === "ADOPTED"
              ? [
                  "The trigger did not prove isDraft=true. Do not treat this Build as a safe refresh, do not retry, and reconcile the exact buildId.",
                ]
              : []),
        ].join("\n"),
        structured: {
          status: refreshStatus,
          ...assessmentFields(assessment),
          refresh: refreshExecution,
          delegation: { ...collected.delegation },
          trigger: { ...attribution },
          ...(monitor === undefined ? {} : { monitor: { ...verdict } }),
          ...(monitoredBuild === undefined
            ? {}
            : { refreshBuild: { ...monitoredBuild } }),
          evidence: EVIDENCE,
        },
        policy,
      });
    },
  });

  return registered;
}
