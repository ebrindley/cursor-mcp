/**
 * Environment lifecycle planning and owner-action judgments.
 *
 * Production full-lifecycle requests are planning-only. Cancel and rollback
 * intents judge caller-held evidence and return owner actions; they do not
 * mutate a Build. Atomic tools stay independently usable.
 *
 * The sequencer and delegated I/O wiring remain available to injected-operation
 * tests. The production boundary declares `planningOnly` before any mutation;
 * confirming a full lifecycle does not make that execution path available.
 */

import { modelSelection } from "../model-selection.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentScope } from "../agent-scope.js";
import type { CursorClient } from "../client.js";
import type { Policy } from "../config.js";
import { activeProfile } from "../config.js";
import {
  CursorDelegatedRunner,
  MAX_WAIT_MS,
  normalizeMissionRequest,
  type DelegatedRunner,
  type DelegationHandle,
  type MissionRequest,
} from "../delegated-run.js";
import {
  COMPOSED_EXECUTION_UNAVAILABLE_NEXT_STEPS,
  COMPOSED_EXECUTION_UNAVAILABLE_REASON,
  MAX_WORKFLOW_MS,
  MAX_WARM_LAUNCHES,
  atomicJudgements,
  runEnvironmentLifecycle,
  type InspectOutcome,
  type LifecycleOperations,
  type MonitorOutcome,
  type QualifyOutcome,
  type TriggerOutcome,
  type WarmLaunchResult,
} from "../environment-lifecycle.js";
import {
  ACTIVE_BUILD_UNREADABLE_REASON,
  attributeTriggeredBuild,
  extractReport,
  findBuild,
  identityGate,
  monitorOutcome,
  projectEnvironment,
  qualifyLayers,
  type DelegatedBuildPage,
  type DelegatedReport,
} from "../environment-operations.js";
import { CursorContractError, PolicyError } from "../errors.js";
import {
  assertAgentAccess,
  assertEnvironmentIdentity,
  resolveAutoCreatePR,
  resolveModel,
  resolveCreateAgentLaunch,
} from "../policy.js";
import {
  cancelRejectedRun,
  rejectedRunCleanupMessage,
} from "../rejected-run-cleanup.js";
import { CreateAgentResponseSchema } from "../schemas.js";
import { CREATE } from "./annotations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

const Block = z.record(z.string(), z.unknown());

const EnvironmentArg = z
  .string()
  .min(1)
  .describe(
    "Named cloud environment to delegate into. Must be listed in the profile; grants its secrets and network policy.",
  );

const DeclaredIdArg = z
  .string()
  .min(1)
  .describe(
    "environmentPublicId declared out of band before the run starts. The delegate's own answer is gated against it.",
  );

export function registerEnvironmentLifecycleTools(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
  scope = new AgentScope(client, activeProfile(policy)),
  runner: DelegatedRunner = new CursorDelegatedRunner(
    client,
    activeProfile(policy),
    scope,
  ),
  operations?: LifecycleOperations,
): string[] {
  const profile = activeProfile(policy);
  const registered: string[] = [];
  const usesConcreteOperations = operations === undefined;
  const ops =
    operations ??
    createDelegatedLifecycleOperations({ client, policy, scope, runner });

  const define = <C extends GateableConfig, A extends unknown[]>(
    spec: ToolSpec<C, A>,
  ) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  define({
    name: "cursor_run_environment_lifecycle",
    config: {
      title: "Cursor: plan environment lifecycle",
      description:
        "Plan the environment lifecycle or judge owner actions for Build cancel and rollback. " +
        "Launches nothing and performs no upstream mutation. A confirmed lifecycle returns PLANNING_ONLY; confirming again does not enable execution.",
      inputSchema: {
        environment: EnvironmentArg,
        environmentPublicId: DeclaredIdArg,
        intent: z
          .enum(["lifecycle", "cancel", "rollback"])
          .optional()
          .describe("lifecycle (default) plans the sequence; cancel and rollback return judgments and owner guidance for exact Builds."),
        dryRun: z
          .boolean()
          .optional()
          .describe("Return the plan without evaluating a confirmed cancel or rollback request. No intent launches a delegate or writes."),
        confirm: z
          .boolean()
          .optional()
          .describe("True evaluates cancel or rollback guidance; lifecycle remains PLANNING_ONLY. Omit or false returns a plan. Does not authorize an upstream mutation."),
        timeoutMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_WORKFLOW_MS)
          .optional()
          .describe(
            `Bound on local judgments in milliseconds. Does not enable lifecycle execution. Default and maximum ${MAX_WORKFLOW_MS}.`,
          ),
        definitionText: z
          .string()
          .optional()
          .describe("JSONC definition to include in the validation plan. Omit to skip that planned step; use the atomic definition tool to validate it."),
        environmentJsonPath: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Exactly as read from environment-info: null is database-managed, a path is repository-file managed.",
          ),
        environmentVersionPublicId: z.string().min(1).optional(),
        alreadySynchronized: z
          .boolean()
          .optional()
          .describe(
            "Caller attests the definition is already persisted. Skips the planned synchronization step; does not verify a Save.",
          ),
        buildId: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Exact Build for the lifecycle plan or cancel/rollback guidance. Setting it plans observation instead of triggering; neither is executed here.",
          ),
        supersededBuildId: z
          .string()
          .min(1)
          .optional()
          .describe("Build believed active now, for rollback. Never guessed."),
        observed: z
          .strictObject({
            buildId: z.string().min(1),
            status: z.string().min(1),
            isDraft: z.boolean().optional(),
            environmentPublicId: z.string().min(1).optional(),
            environmentPublicIdSource: z
              .enum(["row", "imputed"])
              .describe(
                "Exactly as cursor_get_build reported it; an imputed or omitted provenance authorizes nothing.",
              ),
            observedAtMs: z.number().int().nonnegative(),
          })
          .optional()
          .describe("Build row as cursor_get_build reported it, required for rollback."),
        expect: z
          .strictObject({
            commands: z.array(z.string().min(1)).max(32).optional(),
            environmentVariables: z.array(z.string().min(1)).max(32).optional(),
            user: z.string().min(1).optional(),
            workspace: z.string().min(1).optional(),
          })
          .optional(),
        kind: z
          .enum(["draft", "manual"])
          .optional()
          .describe("Trigger kind to describe in the plan: draft (default) or an owner-requested manual Build. This tool triggers neither."),
        warmLaunchCount: z
          .number()
          .int()
          .min(0)
          .max(MAX_WARM_LAUNCHES)
          .optional()
          .describe(`Named-environment launches to include in the plan, 0–${MAX_WARM_LAUNCHES}. This tool does not launch them.`),
        warmLaunchPrompt: z
          .string()
          .min(1)
          .optional()
          .describe("Task for planned warm launches. Required when warmLaunchCount > 0; not sent to an agent by this tool."),
      },
      outputSchema: {
        status: z.string(),
        intent: z.string().optional(),
        dryRun: z.boolean().optional(),
        confirmed: z.boolean().optional(),
        /** Includes local owner-action judgment; does not imply an upstream mutation. */
        executed: z.boolean().optional(),
        planningOnlyReason: z.string().optional(),
        /** Present when a delegation was still running: {agentId, runId, step}. */
        pending: Block.optional(),
        steps: z.array(Block).optional(),
        timings: Block.optional(),
        identityGate: z.string().optional(),
        oldBuildId: z.string().optional(),
        newBuildId: z.string().optional(),
        oldBuild: Block.optional(),
        newBuild: Block.optional(),
        rollbackTarget: Block.optional(),
        qualification: Block.optional(),
        residual: Block.optional(),
        mutationPreview: z.array(Block).optional(),
        warmLaunches: z.array(Block).optional(),
        manualActions: z.array(z.string()).optional(),
        stoppedAt: z.string().optional(),
        activeBuild: Block.optional(),
      },
      annotations: CREATE,
    },
    handler: async (call: {
      environment: string;
      environmentPublicId: string;
      intent?: "lifecycle" | "cancel" | "rollback";
      dryRun?: boolean;
      confirm?: boolean;
      timeoutMs?: number;
      definitionText?: string;
      environmentJsonPath?: string | null;
      environmentVersionPublicId?: string;
      alreadySynchronized?: boolean;
      buildId?: string;
      supersededBuildId?: string;
      observed?: {
        buildId: string;
        status: string;
        isDraft?: boolean;
        environmentPublicId?: string;
        environmentPublicIdSource: "row" | "imputed";
        observedAtMs: number;
      };
      expect?: {
        commands?: string[];
        environmentVariables?: string[];
        user?: string;
        workspace?: string;
      };
      kind?: "draft" | "manual";
      warmLaunchCount?: number;
      warmLaunchPrompt?: string;
    }, extra?: { signal?: AbortSignal }) => {
      // A pinned binding is the only out-of-band answer there is, so it decides
      // before anything else runs. With nothing pinned this is a no-op.
      assertEnvironmentIdentity(profile, call.environment, call.environmentPublicId);

      // Declared up front, from what this boundary actually wired up, so the
      // sequencer can answer PLANNING_ONLY *before* the confirm gate rather than
      // a plan being relabelled as an execution afterwards.
      const composedExecutionUnavailable =
        usesConcreteOperations &&
        (call.intent === undefined || call.intent === "lifecycle") &&
        call.dryRun !== true &&
        call.confirm === true;

      const request = {
          environment: call.environment,
          environmentPublicId: call.environmentPublicId,
          ...(extra?.signal instanceof AbortSignal ? { signal: extra.signal } : {}),
          ...(call.intent === undefined ? {} : { intent: call.intent }),
          ...(call.dryRun === undefined ? {} : { dryRun: call.dryRun }),
          ...(call.confirm === undefined ? {} : { confirm: call.confirm }),
          ...(call.timeoutMs === undefined ? {} : { timeoutMs: call.timeoutMs }),
          ...(call.definitionText === undefined ? {} : { definitionText: call.definitionText }),
          ...(call.environmentJsonPath === undefined
            ? {}
            : { environmentJsonPath: call.environmentJsonPath }),
          ...(call.environmentVersionPublicId === undefined
            ? {}
            : { environmentVersionPublicId: call.environmentVersionPublicId }),
          ...(call.alreadySynchronized === undefined
            ? {}
            : { alreadySynchronized: call.alreadySynchronized }),
          ...(call.buildId === undefined ? {} : { buildId: call.buildId }),
          ...(call.supersededBuildId === undefined
            ? {}
            : { supersededBuildId: call.supersededBuildId }),
          ...(call.observed === undefined ? {} : { observed: call.observed }),
          ...(call.expect === undefined ? {} : { expect: call.expect }),
          ...(call.kind === undefined ? {} : { kind: call.kind }),
          ...(call.warmLaunchCount === undefined
            ? {}
            : { warmLaunchCount: call.warmLaunchCount }),
          ...(call.warmLaunchPrompt === undefined
            ? {}
            : { warmLaunchPrompt: call.warmLaunchPrompt }),
          ...(composedExecutionUnavailable
            ? {
                planningOnly: true,
                planningOnlyReason: COMPOSED_EXECUTION_UNAVAILABLE_REASON,
                planningOnlyNextSteps: [...COMPOSED_EXECUTION_UNAVAILABLE_NEXT_STEPS],
              }
            : {}),
        };
      const result = await runEnvironmentLifecycle(request, ops);

      const lines = [
        `${result.status}  intent=${result.intent}  dryRun=${result.dryRun}` +
          `  confirm=${result.confirmed}  executed=${result.executed}`,
        `oldBuild=${result.oldBuildId ?? "(none)"}  newBuild=${result.newBuildId ?? "(none)"}`,
        `rollbackTarget=${result.rollbackTarget.buildId ?? "(none)"} provenance=${result.rollbackTarget.provenance} provenActive=false`,
        ...result.steps.map(
          (step) => `${step.step}=${step.status}${step.reason === undefined ? "" : `  ${step.reason}`}`,
        ),
      ];
      if (result.planningOnlyReason !== undefined) {
        lines.push(`planningOnly: ${result.planningOnlyReason}`);
      }
      if (result.pending !== undefined) {
        lines.push(
          `pending: step=${result.pending.step} agentId=${result.pending.agentId} runId=${result.pending.runId}`,
        );
      }
      if (result.residual !== undefined) {
        lines.push(`${result.residual.action}: ${result.residual.reason}`);
      }
      for (const action of result.manualActions) lines.push(`manual: ${action}`);

      return ok({
        source: "environment lifecycle composition",
        text: lines.join("\n"),
        structured: {
          status: result.status,
          intent: result.intent,
          dryRun: result.dryRun,
          confirmed: result.confirmed,
          executed: result.executed,
          ...(result.planningOnlyReason === undefined
            ? {}
            : { planningOnlyReason: result.planningOnlyReason }),
          // Structured, and before the step list: a truncated payload must not be
          // the reason a still-running delegation becomes unreachable.
          ...(result.pending === undefined ? {} : { pending: { ...result.pending } }),
          steps: result.steps.map((step) => ({ ...step })),
          timings: { ...result.timings },
          ...(result.identityGate === undefined ? {} : { identityGate: result.identityGate }),
          ...(result.oldBuildId === undefined ? {} : { oldBuildId: result.oldBuildId }),
          ...(result.newBuildId === undefined ? {} : { newBuildId: result.newBuildId }),
          ...(result.oldBuild === undefined ? {} : { oldBuild: { ...result.oldBuild } }),
          ...(result.newBuild === undefined ? {} : { newBuild: { ...result.newBuild } }),
          rollbackTarget: { ...result.rollbackTarget },
          ...(result.qualification === undefined
            ? {}
            : { qualification: { ...result.qualification } }),
          ...(result.residual === undefined ? {} : { residual: { ...result.residual } }),
          ...(result.mutationPreview === undefined
            ? {}
            : { mutationPreview: result.mutationPreview.map((item) => ({ ...item })) }),
          ...(result.warmLaunches === undefined
            ? {}
            : { warmLaunches: result.warmLaunches.map((item) => ({ ...item })) }),
          manualActions: [...result.manualActions],
          ...(result.stoppedAt === undefined ? {} : { stoppedAt: result.stoppedAt }),
          activeBuild: { readable: false, reason: ACTIVE_BUILD_UNREADABLE_REASON },
        },
        policy,
      });
    },
  });

  return registered;
}

export function createDelegatedLifecycleOperations(args: {
  client: CursorClient;
  policy: Policy;
  scope: AgentScope;
  runner: DelegatedRunner;
}): LifecycleOperations {
  const profile = activeProfile(args.policy);
  const runner = args.runner;
  const client = args.client;
  const scope = args.scope;

  return {
    now: () => Date.now(),
    validate: atomicJudgements.validate,
    synchronize: atomicJudgements.synchronize,
    activate: atomicJudgements.activate,
    cancel: atomicJudgements.cancel,
    rollback: atomicJudgements.rollback,

    async inspect(input): Promise<InspectOutcome> {
      const collected = await collectReport({
        runner,
        environment: input.environment,
        request: { mission: "inspect", environmentPublicId: input.environmentPublicId },
        waitMs: input.waitMs,
      });
      if (collected.kind !== "report") return collected;
      const identity = reportIdentity(collected.report, input.environmentPublicId);
      const environment =
        collected.report.environmentInfo === undefined ||
        identity.conflicting ||
        identity.reported === undefined
          ? undefined
          : projectEnvironment(collected.report.environmentInfo, identity.reported);
      return {
        kind: "report",
        identityGate: identity.conflicting ? "failed" : identity.gate,
        ...(identity.reported === undefined
          ? {}
          : { reportedEnvironmentPublicId: identity.reported }),
        ...(environment === undefined ? {} : { environment }),
        ...(environment?.currentRunBuildId === undefined
          ? {}
          : { currentRunBuildId: environment.currentRunBuildId }),
      };
    },

    async trigger(input): Promise<TriggerOutcome> {
      const collected = await collectReport({
        runner,
        environment: input.environment,
        request: {
          mission: "trigger-build",
          environmentPublicId: input.environmentPublicId,
        },
        waitMs: input.waitMs,
      });
      if (collected.kind !== "report") return collected;
      const report = collected.report;
      const pages = pagesOf(report);
      const identity = reportIdentity(report, input.environmentPublicId);
      const attribution = attributeTriggeredBuild({
        declaredEnvironmentPublicId: input.environmentPublicId,
        reportedEnvironmentPublicId: identity.conflicting ? undefined : identity.reported,
        dispatched: report.triggerDispatched,
        ...(report.precondition === undefined ? {} : { precondition: report.precondition }),
        ...(report.trigger === undefined ? {} : { trigger: report.trigger }),
        ...(report.baselineBuildIds === undefined
          ? {}
          : { baselineBuildIds: report.baselineBuildIds }),
        rows: pages.flatMap((page) => page.builds),
        ...(report.otherActiveRuns === undefined
          ? {}
          : { otherActiveRuns: report.otherActiveRuns }),
      });
      return { kind: "attributed", attribution };
    },

    async monitor(input): Promise<MonitorOutcome> {
      const collected = await collectReport({
        runner,
        environment: input.environment,
        request: {
          mission: "get-build",
          environmentPublicId: input.environmentPublicId,
          buildId: input.buildId,
        },
        waitMs: input.waitMs,
      });
      if (collected.kind !== "report") return collected;
      const pages = pagesOf(collected.report);
      return {
        kind: "result",
        result: monitorOutcome({
          buildId: input.buildId,
          environmentPublicId: input.environmentPublicId,
          match: findBuild(pages, input.buildId, input.environmentPublicId),
          ...(collected.report.monitorAttempts === undefined
            ? {}
            : { attempts: collected.report.monitorAttempts }),
          ...(collected.report.monitorElapsedMs === undefined
            ? {}
            : { elapsedMs: collected.report.monitorElapsedMs }),
          ...(collected.report.monitorDeadlineExceeded === undefined
            ? {}
            : { deadlineExceeded: collected.report.monitorDeadlineExceeded }),
        }),
      };
    },

    async qualify(input): Promise<QualifyOutcome> {
      const collected = await collectReport({
        runner,
        environment: input.environment,
        request: {
          mission: "qualify",
          environmentPublicId: input.environmentPublicId,
          ...(input.expect === undefined ? {} : { expectations: input.expect }),
        },
        waitMs: input.waitMs,
      });
      if (collected.kind !== "report") return collected;
      const identity = reportIdentity(collected.report, input.environmentPublicId);
      if (identity.conflicting || identity.gate === "failed" || identity.gate === "unreadable") {
        return {
          kind: "failed",
          reason:
            "Qualify identity gate failed. No layer result is reported from an ungated run.",
        };
      }
      return {
        kind: "result",
        result: qualifyLayers({
          environmentPublicId: input.environmentPublicId,
          report: collected.report,
          ...(input.expect === undefined ? {} : { expectations: input.expect }),
        }),
      };
    },

    async launch(input): Promise<WarmLaunchResult> {
      const launch = resolveCreateAgentLaunch(profile, {
        environment: input.environment,
      });
      if (launch.kind !== "environment") {
        throw new CursorContractError("lifecycle warm launch requires a named environment");
      }
      const autoCreatePR = resolveAutoCreatePR(profile, false);
      const model = resolveModel(profile, undefined);
      const created = await client.post("/v1/agents", CreateAgentResponseSchema, {
        body: {
          prompt: { text: input.prompt },
          ...(model === undefined ? {} : { model: modelSelection(model) }),
          autoCreatePR,
          env: { type: "cloud" as const, name: launch.name },
        },
      });
      const name = created.agent.env?.name?.trim();
      try {
        if (name === undefined || name === "") {
          throw new CursorContractError(
            `agent ${created.agent.id} did not read back the named environment; attached secrets cannot be verified`,
          );
        }
        if (name !== launch.name) {
          throw new CursorContractError(
            `agent ${created.agent.id} read back environment ${name}, not ${launch.name}`,
          );
        }
        assertAgentAccess(profile, created.agent);
        scope.remember(created.agent);
      } catch (error) {
        const cleanup = await cancelRejectedRun(
          client,
          created.agent.id,
          created.run.id,
        );
        const suffix = rejectedRunCleanupMessage(cleanup);
        if (error instanceof PolicyError) {
          throw new PolicyError(`${error.message}; ${suffix}`);
        }
        if (error instanceof CursorContractError) {
          throw new CursorContractError(`${error.message}; ${suffix}`);
        }
        throw error;
      }
      return {
        agentId: created.agent.id,
        runId: created.run.id,
        environment: name,
        targetVerified: true,
        repos: (created.agent.repos ?? []).map((repo) => repo.url),
      };
    },
  };
}

type Collected =
  | { kind: "pending"; reason: string; resume: { agentId: string; runId: string } }
  | { kind: "failed"; reason: string }
  | { kind: "report"; report: DelegatedReport };

async function collectReport(args: {
  runner: DelegatedRunner;
  environment: string;
  request: MissionRequest;
  waitMs: number;
}): Promise<Collected> {
  const request = normalizeMissionRequest(args.request);
  const handle: DelegationHandle = await args.runner.start({
    environment: args.environment,
    request,
  });
  const waitMs = Math.max(0, Math.min(args.waitMs, MAX_WAIT_MS));
  const outcome = await args.runner.collect({ handle, waitMs });
  const resume = { agentId: handle.agentId, runId: handle.runId };
  if (outcome.state === "pending") {
    return {
      kind: "pending",
      resume,
      reason: `delegation pending  run=${handle.runId}  status=${outcome.runStatus}`,
    };
  }
  if (outcome.state === "failed") {
    return { kind: "failed", reason: outcome.reason };
  }
  const extracted = extractReport(outcome.text);
  if (!extracted.ok) return { kind: "failed", reason: extracted.reason };
  if (extracted.report.mission !== request.mission) {
    return {
      kind: "failed",
      reason: `the delegated report names mission ${extracted.report.mission}, not ${request.mission}`,
    };
  }
  return { kind: "report", report: extracted.report };
}

function pagesOf(report: DelegatedReport): DelegatedBuildPage[] {
  return [
    ...(report.builds === undefined ? [] : [report.builds]),
    ...(report.morePages ?? []),
  ];
}

function reportIdentity(
  report: DelegatedReport,
  declared?: string,
): { gate: ReturnType<typeof identityGate>; reported?: string; conflicting: boolean } {
  const ids = new Set<string>();
  const add = (value: string | undefined) => {
    if (value !== undefined && value !== "") ids.add(value);
  };
  add(report.environmentInfo?.environmentPublicId);
  add(report.trigger?.environmentPublicId);
  for (const page of pagesOf(report)) {
    add(page.environmentPublicId);
    for (const row of page.builds) add(row.environmentPublicId);
  }
  if (ids.size > 1) return { gate: "failed", conflicting: true };
  const reported = ids.values().next().value as string | undefined;
  return {
    gate: identityGate({ declared, reported }),
    ...(reported === undefined ? {} : { reported }),
    conflicting: false,
  };
}
