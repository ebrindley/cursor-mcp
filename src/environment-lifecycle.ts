/**
 * Bounded in-process environment lifecycle: a thin composition of the atomic
 * agent, definition, Build, and activation operations.
 *
 * This is not a workflow engine. Nothing is stored, there is no resume handle
 * for the composition itself, and every atomic tool stays independently usable.
 * The product stages live in `lifecycle-model.ts`; this module sequences them
 * (plus monitor) and the cancel / rollback side paths.
 *
 * Unsupported mutations are addressed and fail closed: they are recorded as
 * `unsupported` with the same owner-action residual the atomic tool would
 * return, never as `completed`. A failed prerequisite or readback stops every
 * later mutation and preserves the known rollback target — which is never a
 * proven active Build on this authority.
 *
 * Two honesty rules follow from that. An intent whose only possible answer is a
 * residual launches nothing: cancel and rollback read no state first, because a
 * delegated inspect costs a VM and cannot change the answer. And a request this
 * composition cannot execute is answered `PLANNING_ONLY` before any mutation,
 * never by running the planner and presenting its output as an execution result.
 */

import {
  buildSynchronizationRequest,
  validateDefinition,
  type EnvironmentDefinition,
  type SynchronizationRequest,
  type ValidationResult,
} from "./environment-definition.js";
import {
  activateBuildResidual,
  cancelBuildResidual,
  manualTriggerResidual,
  promotionEligibility,
  rollbackBuildResidual,
  saveEnvironmentResidual,
  type EligibilityCode,
  type EnvironmentView,
  type IdentityGate,
  type MonitorResult,
  type ObservedBuild,
  type QualificationExpectations,
  type QualificationView,
  type TriggerAttribution,
} from "./environment-operations.js";
import { MAX_WAIT_MS } from "./delegated-run.js";
import type { OwnerActionResidual } from "./lifecycle-model.js";

/** The composed sequence, including monitor. Cancel and rollback are side paths. */
export const WORKFLOW_STEPS = [
  "inspect",
  "validate",
  "synchronize",
  "build",
  "monitor",
  "qualify",
  "activate",
  "verify",
] as const;

export type WorkflowStepName =
  | (typeof WORKFLOW_STEPS)[number]
  | "cancel"
  | "rollback"
  | "warm-launch";

export const WORKFLOW_INTENTS = ["lifecycle", "cancel", "rollback"] as const;
export type WorkflowIntent = (typeof WORKFLOW_INTENTS)[number];

/**
 * `PLANNING_ONLY` is not a dry run and not a confirmation prompt.
 *
 * It is the composition saying that on this authority it cannot execute the
 * requested intent at all, decided *before* any mutation. Confirming again would
 * change nothing, so a confirmed request must never be answered with a plan
 * relabelled as an execution result.
 */
export type WorkflowStatus =
  | "PLANNED"
  | "PLANNING_ONLY"
  | "CONFIRMATION_REQUIRED"
  | "COMPLETED"
  | "STOPPED"
  | "FAILED"
  | "TIMED_OUT";

export type StepStatus =
  | "completed"
  | "skipped"
  | "failed"
  | "unsupported"
  | "planned"
  | "timed_out";

/** Longest the composition will run. Same ceiling as a single delegated wait. */
export const MAX_WORKFLOW_MS = MAX_WAIT_MS;

/** Two warm launches is the verification bound; this is not a fan-out engine. */
export const MAX_WARM_LAUNCHES = 2;

/**
 * Why the delegated composition cannot execute a confirmed `lifecycle` run.
 *
 * Stated once, and stated as a limitation of the authority rather than of the
 * request: no supported operation boots a run from a Build this composition just
 * triggered, and Start execution has no authoritative readback, so `qualify`
 * could never pass on evidence the composition itself obtained.
 */
export const COMPOSED_EXECUTION_UNAVAILABLE_REASON =
  "The supported authority cannot boot a run from the newly triggered Build or read Start " +
  "execution authoritatively, so the composed lifecycle cannot execute a confirmed run and is " +
  "classified planning-only before any mutation.";

export const COMPOSED_EXECUTION_UNAVAILABLE_NEXT_STEPS = [
  "No lifecycle step executed and no mutation was dispatched.",
  "Use cursor_trigger_build, cursor_get_build, and cursor_get_build_logs as separate bounded operations.",
];

const RESIDUAL_INTENT_NO_INSPECT =
  "Skipped: this intent can only return its existing owner-action residual, and no inspected " +
  "field changes that, so no delegated run is launched.";

export type RollbackProvenance = "caller-supplied" | "current-run-boot" | "none";

export interface RollbackTarget {
  buildId?: string;
  provenance: RollbackProvenance;
  /** Always false: this authority cannot read the active Build. */
  provenActive: false;
  reason: string;
}

/**
 * The delegated run behind a step that did not finish.
 *
 * Kept structured rather than folded into the reason text: the caller needs the
 * exact pair to read the same run back, and a sentence a model has to re-parse is
 * not a handle.
 */
export interface PendingDelegation {
  agentId: string;
  runId: string;
}

export interface WorkflowStep {
  step: WorkflowStepName;
  status: StepStatus;
  startedAtMs: number;
  endedAtMs: number;
  durationMs: number;
  reason?: string;
  residual?: OwnerActionResidual;
  /** Present when this step timed out with a delegation still running. */
  pending?: PendingDelegation;
}

export interface MutationPreview {
  step: WorkflowStepName;
  action:
    | "SAVE_ENVIRONMENT"
    | "TRIGGER_BUILD"
    | "ACTIVATE_BUILD"
    | "CANCEL_BUILD"
    | "ROLLBACK_BUILD"
    | "CREATE_AGENT";
  dispatched: false;
  requiresConfirm: true;
  buildId?: string;
  reason: string;
}

export interface WarmLaunchResult {
  agentId: string;
  runId: string;
  environment: string;
  targetVerified: boolean;
  repos: string[];
}

export type InspectOutcome =
  | {
      kind: "report";
      identityGate: IdentityGate;
      reportedEnvironmentPublicId?: string;
      environment?: EnvironmentView;
      currentRunBuildId?: string;
    }
  | { kind: "pending"; resume: { agentId: string; runId: string }; reason: string }
  | { kind: "failed"; reason: string };

export type TriggerOutcome =
  | { kind: "attributed"; attribution: TriggerAttribution }
  | { kind: "residual"; residual: OwnerActionResidual }
  | { kind: "pending"; resume: { agentId: string; runId: string }; reason: string }
  | { kind: "failed"; reason: string };

export type MonitorOutcome =
  | { kind: "result"; result: MonitorResult }
  | { kind: "pending"; resume: { agentId: string; runId: string }; reason: string }
  | { kind: "failed"; reason: string };

export type QualifyOutcome =
  | { kind: "result"; result: QualificationView }
  | { kind: "pending"; resume: { agentId: string; runId: string }; reason: string }
  | { kind: "failed"; reason: string };

export type SynchronizeOutcome =
  | { kind: "residual"; residual: OwnerActionResidual; request?: SynchronizationRequest }
  | { kind: "failed"; reason: string };

export type ActivateOutcome =
  | { eligible: true; completed: true }
  | { eligible: true; completed: false; residual: OwnerActionResidual }
  | { eligible: false; code: EligibilityCode; reason: string };

export type RollbackOutcome =
  | { eligible: true; residual: OwnerActionResidual }
  | { eligible: false; code: EligibilityCode; reason: string };

export interface LifecycleRequest {
  environment: string;
  environmentPublicId: string;
  intent?: WorkflowIntent;
  dryRun?: boolean;
  confirm?: boolean;
  timeoutMs?: number;
  signal?: AbortSignal;
  definitionText?: string;
  definitionSource?: "proposed" | "delegated-saved";
  environmentJsonPath?: string | null;
  environmentVersionPublicId?: string;
  alreadySynchronized?: boolean;
  /** Exact Build to monitor / activate / cancel / roll back to. */
  buildId?: string;
  supersededBuildId?: string;
  observed?: ObservedBuild;
  expect?: QualificationExpectations;
  kind?: "draft" | "manual";
  warmLaunchCount?: number;
  warmLaunchPrompt?: string;
  /**
   * The composed executor cannot execute this intent on this authority.
   *
   * Declared by the caller of the sequencer -- the MCP boundary knows which
   * operations it wired up -- and answered honestly as `PLANNING_ONLY` before any
   * mutation, rather than by running a plan and dressing it as an execution.
   */
  planningOnly?: boolean;
  planningOnlyReason?: string;
  planningOnlyNextSteps?: string[];
}

export interface LifecycleOperations {
  now(): number;
  inspect(input: {
    environment: string;
    environmentPublicId: string;
    waitMs: number;
  }): Promise<InspectOutcome>;
  validate(input: {
    text: string;
    source: "proposed" | "delegated-saved";
  }): Promise<ValidationResult>;
  synchronize(input: {
    environmentPublicId: string;
    environmentJsonPath?: string | null;
    environmentVersionPublicId?: string;
    definition?: EnvironmentDefinition;
  }): Promise<SynchronizeOutcome>;
  trigger(input: {
    environment: string;
    environmentPublicId: string;
    waitMs: number;
  }): Promise<TriggerOutcome>;
  monitor(input: {
    environment: string;
    environmentPublicId: string;
    buildId: string;
    waitMs: number;
  }): Promise<MonitorOutcome>;
  qualify(input: {
    environment: string;
    environmentPublicId: string;
    waitMs: number;
    expect?: QualificationExpectations;
  }): Promise<QualifyOutcome>;
  activate(input: {
    environmentPublicId: string;
    buildId: string;
    observed: ObservedBuild;
  }): Promise<ActivateOutcome>;
  cancel(input: {
    environmentPublicId: string;
    buildId: string;
  }): Promise<OwnerActionResidual>;
  rollback(input: {
    environmentPublicId: string;
    buildId: string;
    supersededBuildId: string;
    observed: ObservedBuild;
  }): Promise<RollbackOutcome>;
  launch(input: {
    environment: string;
    prompt: string;
  }): Promise<WarmLaunchResult>;
}

export interface WorkflowResult {
  status: WorkflowStatus;
  intent: WorkflowIntent;
  dryRun: boolean;
  confirmed: boolean;
  /**
   * Whether the composition actually invoked its operations.
   *
   * `confirmed` records what the caller asked for; this records what happened. A
   * plan, a confirmation refusal, and a planning-only answer are all `false`.
   */
  executed: boolean;
  /** Why execution was impossible, on a `PLANNING_ONLY` result. */
  planningOnlyReason?: string;
  /** The delegation still running when the composition stopped waiting. */
  pending?: PendingDelegation & { step: WorkflowStepName };
  steps: WorkflowStep[];
  timings: { startedAtMs: number; endedAtMs: number; durationMs: number };
  identityGate?: IdentityGate;
  oldBuildId?: string;
  newBuildId?: string;
  oldBuild?: { buildId: string; provenance: "current-run-boot"; provenActive: false };
  newBuild?: { buildId: string; isDraft?: boolean; status?: string };
  rollbackTarget: RollbackTarget;
  qualification?: QualificationView;
  residual?: OwnerActionResidual;
  mutationPreview?: MutationPreview[];
  warmLaunches?: WarmLaunchResult[];
  manualActions: string[];
  stoppedAt?: WorkflowStepName;
}

const UNREADABLE_ACTIVE =
  "No authoritative active-Build read exists on this authority, so a predecessor cannot be proven active.";

const NONE_TARGET: RollbackTarget = {
  provenance: "none",
  provenActive: false,
  reason: UNREADABLE_ACTIVE,
};

/**
 * Residual-only judgements used by the composition. Each one is the atomic
 * function of the same name; the sequencer does not re-derive eligibility,
 * Save, cancel, or promotion.
 */
export const atomicJudgements = {
  async validate(input: {
    text: string;
    source: "proposed" | "delegated-saved";
  }): Promise<ValidationResult> {
    return validateDefinition({
      text: input.text,
      source: input.source,
      origin:
        input.source === "delegated-saved"
          ? "delegated run (untrusted evidence)"
          : "caller-supplied definition text",
    });
  },

  async synchronize(input: {
    environmentPublicId: string;
    environmentJsonPath?: string | null;
    environmentVersionPublicId?: string;
    definition?: EnvironmentDefinition;
  }): Promise<SynchronizeOutcome> {
    const residual = saveEnvironmentResidual({
      environmentPublicId: input.environmentPublicId,
      ...(input.environmentJsonPath === undefined
        ? {}
        : { environmentJsonPath: input.environmentJsonPath }),
      ...(input.environmentVersionPublicId === undefined
        ? {}
        : { environmentVersionPublicId: input.environmentVersionPublicId }),
    });
    const request =
      input.definition === undefined
        ? undefined
        : buildSynchronizationRequest({
            environmentPublicId: input.environmentPublicId,
            definition: input.definition,
            ...(input.environmentJsonPath === undefined
              ? {}
              : { environmentJsonPath: input.environmentJsonPath }),
          });
    return request === undefined
      ? { kind: "residual", residual }
      : { kind: "residual", residual, request };
  },

  async activate(input: {
    environmentPublicId: string;
    buildId: string;
    observed: ObservedBuild;
  }): Promise<ActivateOutcome> {
    const eligibility = promotionEligibility({
      operation: "activate",
      declaredEnvironmentPublicId: input.environmentPublicId,
      requestedBuildId: input.buildId,
      build: input.observed,
      nowMs: Date.now(),
    });
    if (!eligibility.eligible) {
      return {
        eligible: false,
        code: eligibility.code,
        reason: eligibility.reason,
      };
    }
    return {
      eligible: true,
      completed: false,
      residual: activateBuildResidual({
        environmentPublicId: input.environmentPublicId,
        buildId: input.buildId,
      }),
    };
  },

  async cancel(input: {
    environmentPublicId: string;
    buildId: string;
  }): Promise<OwnerActionResidual> {
    return cancelBuildResidual(input);
  },

  async rollback(input: {
    environmentPublicId: string;
    buildId: string;
    supersededBuildId: string;
    observed: ObservedBuild;
  }): Promise<RollbackOutcome> {
    const eligibility = promotionEligibility({
      operation: "rollback",
      declaredEnvironmentPublicId: input.environmentPublicId,
      requestedBuildId: input.buildId,
      build: input.observed,
      supersededBuildId: input.supersededBuildId,
      nowMs: Date.now(),
    });
    if (!eligibility.eligible) {
      return {
        eligible: false,
        code: eligibility.code,
        reason: eligibility.reason,
      };
    }
    return {
      eligible: true,
      residual: rollbackBuildResidual({
        environmentPublicId: input.environmentPublicId,
        buildId: input.buildId,
        supersededBuildId: input.supersededBuildId,
      }),
    };
  },
};

export function clampTimeoutMs(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined) return MAX_WORKFLOW_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return 0;
  return Math.min(Math.trunc(timeoutMs), MAX_WORKFLOW_MS);
}

export function planEnvironmentLifecycle(
  request: LifecycleRequest,
  now: () => number = () => 0,
): WorkflowResult {
  const startedAtMs = now();
  const intent = request.intent ?? "lifecycle";
  const steps: WorkflowStep[] = [];
  const mutationPreview: MutationPreview[] = [];
  const manualActions: string[] = [];
  let residual: OwnerActionResidual | undefined;
  const rollbackTarget = plannedRollbackTarget(request);

  const planStep = (step: WorkflowStepName, reason: string): void => {
    const at = now();
    steps.push({
      step,
      status: "planned",
      startedAtMs: at,
      endedAtMs: at,
      durationMs: 0,
      reason,
    });
  };

  if (intent === "cancel") {
    const at = now();
    steps.push({
      step: "inspect",
      status: "skipped",
      startedAtMs: at,
      endedAtMs: at,
      durationMs: 0,
      reason: RESIDUAL_INTENT_NO_INSPECT,
    });
    const buildId = request.buildId;
    if (buildId === undefined || buildId === "") {
      const at = now();
      steps.push({
        step: "cancel",
        status: "failed",
        startedAtMs: at,
        endedAtMs: at,
        durationMs: 0,
        reason: "Cancel requires an exact buildId; this server never guesses one.",
      });
    } else {
      residual = cancelBuildResidual({
        environmentPublicId: request.environmentPublicId,
        buildId,
      });
      mutationPreview.push({
        step: "cancel",
        action: "CANCEL_BUILD",
        dispatched: false,
        requiresConfirm: true,
        buildId,
        reason: residual.reason,
      });
      planStep("cancel", residual.reason);
      manualActions.push(...residual.nextSteps);
    }
    return finishPlan({
      request,
      intent,
      startedAtMs,
      now,
      steps,
      mutationPreview,
      rollbackTarget,
      ...(residual === undefined ? {} : { residual }),
      manualActions,
    });
  }

  if (intent === "rollback") {
    const at = now();
    steps.push({
      step: "inspect",
      status: "skipped",
      startedAtMs: at,
      endedAtMs: at,
      durationMs: 0,
      reason: RESIDUAL_INTENT_NO_INSPECT,
    });
    const buildId = request.buildId;
    const supersededBuildId = request.supersededBuildId;
    if (
      buildId === undefined ||
      buildId === "" ||
      supersededBuildId === undefined ||
      request.observed === undefined
    ) {
      const at = now();
      steps.push({
        step: "rollback",
        status: "failed",
        startedAtMs: at,
        endedAtMs: at,
        durationMs: 0,
        reason:
          "Rollback requires the exact prior buildId, the superseded buildId, and the observed row.",
      });
    } else {
      residual = rollbackBuildResidual({
        environmentPublicId: request.environmentPublicId,
        buildId,
        supersededBuildId,
      });
      mutationPreview.push({
        step: "rollback",
        action: "ROLLBACK_BUILD",
        dispatched: false,
        requiresConfirm: true,
        buildId,
        reason: residual.reason,
      });
      planStep("rollback", residual.reason);
      manualActions.push(...residual.nextSteps);
    }
    return finishPlan({
      request,
      intent,
      startedAtMs,
      now,
      steps,
      mutationPreview,
      rollbackTarget,
      ...(residual === undefined ? {} : { residual }),
      manualActions,
    });
  }

  planStep("inspect", "Read identity, managed type, version, and boot provenance.");
  if (request.definitionText !== undefined) {
    planStep("validate", "Check the definition against the published schema.");
  } else {
    const at = now();
    steps.push({
      step: "validate",
      status: "skipped",
      startedAtMs: at,
      endedAtMs: at,
      durationMs: 0,
      reason: "No definition text was supplied.",
    });
  }

  if (request.alreadySynchronized === true) {
    const at = now();
    steps.push({
      step: "synchronize",
      status: "skipped",
      startedAtMs: at,
      endedAtMs: at,
      durationMs: 0,
      reason: "Caller attested the definition is already persisted.",
    });
  } else {
    residual = saveEnvironmentResidual({
      environmentPublicId: request.environmentPublicId,
      ...(request.environmentJsonPath === undefined
        ? {}
        : { environmentJsonPath: request.environmentJsonPath }),
      ...(request.environmentVersionPublicId === undefined
        ? {}
        : { environmentVersionPublicId: request.environmentVersionPublicId }),
    });
    mutationPreview.push({
      step: "synchronize",
      action: "SAVE_ENVIRONMENT",
      dispatched: false,
      requiresConfirm: true,
      reason: residual.reason,
    });
    planStep("synchronize", residual.reason);
    manualActions.push(...residual.nextSteps);
  }

  if (request.kind === "manual") {
    const triggerResidual = manualTriggerResidual(request.environmentPublicId);
    mutationPreview.push({
      step: "build",
      action: "TRIGGER_BUILD",
      dispatched: false,
      requiresConfirm: true,
      reason: triggerResidual.reason,
    });
    planStep("build", triggerResidual.reason);
    residual = triggerResidual;
    manualActions.push(...triggerResidual.nextSteps);
  } else if (request.buildId !== undefined) {
    const at = now();
    steps.push({
      step: "build",
      status: "skipped",
      startedAtMs: at,
      endedAtMs: at,
      durationMs: 0,
      reason: `Observing existing Build ${request.buildId}; no trigger.`,
    });
  } else {
    mutationPreview.push({
      step: "build",
      action: "TRIGGER_BUILD",
      dispatched: false,
      requiresConfirm: true,
      reason:
        "One draft trigger-environment-build. A draft Build never becomes the boot Build.",
    });
    planStep("build", "Trigger one draft Build from the saved configuration.");
  }

  planStep("monitor", "Read the exact buildId to a terminal status.");
  planStep(
    "qualify",
    "Qualify prepared Build disk, Start execution, and task-shell state independently.",
  );
  mutationPreview.push({
    step: "activate",
    action: "ACTIVATE_BUILD",
    dispatched: false,
    requiresConfirm: true,
    ...(request.buildId === undefined ? {} : { buildId: request.buildId }),
    reason:
      "Activation is an owner action on this authority. SUCCEEDED is not activation.",
  });
  planStep("activate", "Address activation; do not claim it completed.");
  planStep("verify", "Re-inspect. Active Build stays unverified on this authority.");

  const launches = clampWarmLaunches(request.warmLaunchCount);
  for (let index = 0; index < launches; index += 1) {
    mutationPreview.push({
      step: "warm-launch",
      action: "CREATE_AGENT",
      dispatched: false,
      requiresConfirm: true,
      reason: `Named-environment launch ${index + 1} of ${launches}.`,
    });
    planStep("warm-launch", `Launch ${index + 1} of ${launches} against the named environment.`);
  }

  return finishPlan({
    request,
    intent,
    startedAtMs,
    now,
    steps,
    mutationPreview,
    rollbackTarget,
    ...(residual === undefined ? {} : { residual }),
    manualActions,
  });
}

export async function runEnvironmentLifecycle(
  request: LifecycleRequest,
  ops: LifecycleOperations,
): Promise<WorkflowResult> {
  const intent = request.intent ?? "lifecycle";
  const startedAtMs = ops.now();
  const timeoutMs = clampTimeoutMs(request.timeoutMs);
  const deadline = startedAtMs + timeoutMs;

  if (request.dryRun === true) {
    return planEnvironmentLifecycle(request, () => ops.now());
  }
  // Answered before the confirm gate and before any operation: a request this
  // composition cannot execute is not made executable by confirming it, so
  // returning CONFIRMATION_REQUIRED here would promise something untrue.
  if (request.planningOnly === true) {
    const planned = planEnvironmentLifecycle(request, () => ops.now());
    const reason =
      request.planningOnlyReason ??
      "This composition cannot execute the requested intent on this authority.";
    return {
      ...planned,
      status: "PLANNING_ONLY",
      dryRun: false,
      confirmed: request.confirm === true,
      executed: false,
      planningOnlyReason: reason,
      manualActions: [
        ...planned.manualActions,
        ...(request.planningOnlyNextSteps ?? []),
      ],
    };
  }
  if (request.confirm !== true) {
    const planned = planEnvironmentLifecycle(request, () => ops.now());
    return {
      ...planned,
      status: "CONFIRMATION_REQUIRED",
      confirmed: false,
      dryRun: false,
      executed: false,
    };
  }

  const run: RunState = {
    request,
    intent,
    ops,
    deadline,
    startedAtMs,
    steps: [],
    manualActions: [],
    rollbackTarget: NONE_TARGET,
    warmLaunches: [],
    executed: false,
  };

  try {
    if (intent === "cancel") return await runCancel(run);
    if (intent === "rollback") return await runRollback(run);
    return await runLifecycle(run);
  } catch (error) {
    if (error instanceof WorkflowAborted) return await abortWithCancel(run);
    if (error instanceof WorkflowHalt) return finish(run, error.status);
    throw error;
  }
}

interface RunState {
  request: LifecycleRequest;
  intent: WorkflowIntent;
  ops: LifecycleOperations;
  deadline: number;
  startedAtMs: number;
  steps: WorkflowStep[];
  manualActions: string[];
  rollbackTarget: RollbackTarget;
  residual?: OwnerActionResidual;
  identityGate?: IdentityGate;
  oldBuildId?: string;
  newBuildId?: string;
  newBuildIsDraft?: boolean;
  newBuildStatus?: string;
  qualification?: QualificationView;
  warmLaunches: WarmLaunchResult[];
  stoppedAt?: WorkflowStepName;
  pending?: PendingDelegation & { step: WorkflowStepName };
  executed: boolean;
}

class WorkflowHalt extends Error {
  constructor(readonly status: WorkflowStatus) {
    super(status);
    this.name = "WorkflowHalt";
  }
}

async function runLifecycle(run: RunState): Promise<WorkflowResult> {
  const inspected = await stepInspect(run);
  const definition = await stepValidate(run);
  const persisted = await stepSynchronize(run, definition);
  if (!persisted) {
    run.stoppedAt = "synchronize";
    return finish(run, "STOPPED");
  }

  const buildId = await stepBuild(run);
  if (buildId === undefined) {
    run.stoppedAt = run.stoppedAt ?? "build";
    return finish(run, run.residual === undefined ? "FAILED" : "STOPPED");
  }

  const monitor = await stepMonitor(run, buildId, inspected);
  if (monitor === undefined) {
    return finish(run, run.stoppedAt === undefined ? "FAILED" : statusFromStop(run));
  }

  const qualified = await stepQualify(run);
  if (!qualified) return finish(run, "FAILED");

  const activated = await stepActivate(run, monitor);
  if (!activated) {
    return finish(run, run.residual === undefined ? "FAILED" : "STOPPED");
  }

  await stepVerify(run);
  await stepWarmLaunches(run);
  return finish(run, "COMPLETED");
}

async function abortWithCancel(run: RunState): Promise<WorkflowResult> {
  const buildId = run.newBuildId;
  if (buildId !== undefined) {
    const started = run.ops.now();
    run.executed = true;
    const residual = await run.ops.cancel({
      environmentPublicId: run.request.environmentPublicId,
      buildId,
    });
    record(run, "cancel", "unsupported", {
      startedAtMs: started,
      reason: residual.reason,
      residual,
    });
    adoptResidual(run, residual);
    run.stoppedAt = "cancel";
    return finish(run, "STOPPED");
  }
  const stoppedAt = run.steps.at(-1)?.step;
  if (stoppedAt !== undefined) run.stoppedAt = stoppedAt;
  return finish(run, "FAILED");
}

/**
 * Why the residual-only side paths read no state first.
 *
 * A delegated inspect costs a VM. Cancel and rollback can only ever return the
 * residual the atomic tool would return, and no field an inspect reports changes
 * that answer, so launching one would spend quota to tell the caller something it
 * already knew.
 */
async function runCancel(run: RunState): Promise<WorkflowResult> {
  record(run, "inspect", "skipped", { reason: RESIDUAL_INTENT_NO_INSPECT });
  run.rollbackTarget = plannedRollbackTarget(run.request);
  const buildId = run.request.buildId;
  if (buildId === undefined || buildId === "") {
    record(run, "cancel", "failed", {
      reason: "Cancel requires an exact buildId; this server never guesses one.",
    });
    run.stoppedAt = "cancel";
    return finish(run, "FAILED");
  }
  assertNotCancelled(run);
  assertTime(run, "cancel");
  const started = run.ops.now();
  run.executed = true;
  const residual = await run.ops.cancel({
    environmentPublicId: run.request.environmentPublicId,
    buildId,
  });
  record(run, "cancel", "unsupported", {
    startedAtMs: started,
    reason: residual.reason,
    residual,
  });
  adoptResidual(run, residual);
  run.stoppedAt = "cancel";
  return finish(run, "STOPPED");
}

async function runRollback(run: RunState): Promise<WorkflowResult> {
  record(run, "inspect", "skipped", { reason: RESIDUAL_INTENT_NO_INSPECT });
  run.rollbackTarget = plannedRollbackTarget(run.request);
  const buildId = run.request.buildId;
  const supersededBuildId = run.request.supersededBuildId;
  const observed = run.request.observed;
  if (
    buildId === undefined ||
    buildId === "" ||
    supersededBuildId === undefined ||
    observed === undefined
  ) {
    record(run, "rollback", "failed", {
      reason:
        "Rollback requires the exact prior buildId, the superseded buildId, and the observed row.",
    });
    run.stoppedAt = "rollback";
    return finish(run, "FAILED");
  }
  assertNotCancelled(run);
  assertTime(run, "rollback");
  const started = run.ops.now();
  run.executed = true;
  const outcome = await run.ops.rollback({
    environmentPublicId: run.request.environmentPublicId,
    buildId,
    supersededBuildId,
    observed,
  });
  if (!outcome.eligible) {
    record(run, "rollback", "failed", {
      startedAtMs: started,
      reason: outcome.reason,
    });
    run.stoppedAt = "rollback";
    return finish(run, "FAILED");
  }
  record(run, "rollback", "unsupported", {
    startedAtMs: started,
    reason: outcome.residual.reason,
    residual: outcome.residual,
  });
  adoptResidual(run, outcome.residual);
  run.stoppedAt = "rollback";
  return finish(run, "STOPPED");
}

async function stepInspect(run: RunState): Promise<InspectOutcome> {
  assertNotCancelled(run);
  assertTime(run, "inspect");
  const started = run.ops.now();
  run.executed = true;
  const outcome = await run.ops.inspect({
    environment: run.request.environment,
    environmentPublicId: run.request.environmentPublicId,
    waitMs: remainingMs(run),
  });
  if (outcome.kind === "pending") {
    record(run, "inspect", "timed_out", {
      startedAtMs: started,
      reason: outcome.reason ?? "Inspect did not finish inside the workflow timeout.",
      pending: outcome.resume,
    });
    run.stoppedAt = "inspect";
    throw new WorkflowHalt("TIMED_OUT");
  }
  if (outcome.kind === "failed") {
    record(run, "inspect", "failed", {
      startedAtMs: started,
      reason: outcome.reason ?? "Inspect failed.",
    });
    run.stoppedAt = "inspect";
    throw new WorkflowHalt("FAILED");
  }
  const gate = outcome.identityGate;
  run.identityGate = gate;
  if (gate === "failed" || gate === "unreadable") {
    record(run, "inspect", "failed", {
      startedAtMs: started,
      reason:
        gate === "failed"
          ? `Identity gate failed: the delegate reported ${outcome.reportedEnvironmentPublicId ?? "(none)"}, not ${run.request.environmentPublicId}.`
          : "Identity gate failed: the delegate reported no environmentPublicId.",
    });
    run.stoppedAt = "inspect";
    throw new WorkflowHalt("FAILED");
  }
  record(run, "inspect", "completed", {
    startedAtMs: started,
    reason: "Identity verified. Active Build is unreadable on this authority.",
  });
  if (outcome.currentRunBuildId !== undefined) {
    run.oldBuildId = outcome.currentRunBuildId;
  }
  run.rollbackTarget = resolveRollbackTarget(run.request, outcome.currentRunBuildId);
  return outcome;
}

async function stepValidate(run: RunState): Promise<EnvironmentDefinition | undefined> {
  const text = run.request.definitionText;
  if (text === undefined) {
    record(run, "validate", "skipped", { reason: "No definition text was supplied." });
    return undefined;
  }
  assertNotCancelled(run);
  assertTime(run, "validate");
  const started = run.ops.now();
  run.executed = true;
  const result = await run.ops.validate({
    text,
    source: run.request.definitionSource ?? "proposed",
  });
  if (result.status !== "valid" || result.definition === undefined) {
    record(run, "validate", "failed", {
      startedAtMs: started,
      reason:
        result.errors[0] === undefined
          ? "The definition did not validate."
          : `${result.errors[0].path}: ${result.errors[0].message}`,
    });
    run.stoppedAt = "validate";
    throw new WorkflowHalt("FAILED");
  }
  record(run, "validate", "completed", {
    startedAtMs: started,
    reason: `Definition valid. safety=${result.safety.length} limitations=${result.limitations.length}`,
  });
  return result.definition;
}

async function stepSynchronize(
  run: RunState,
  definition: EnvironmentDefinition | undefined,
): Promise<boolean> {
  if (run.request.alreadySynchronized === true) {
    record(run, "synchronize", "skipped", {
      reason: "Caller attested the definition is already persisted.",
    });
    return true;
  }
  assertNotCancelled(run);
  assertTime(run, "synchronize");
  const started = run.ops.now();
  run.executed = true;
  const outcome = await run.ops.synchronize({
    environmentPublicId: run.request.environmentPublicId,
    ...(run.request.environmentJsonPath === undefined
      ? {}
      : { environmentJsonPath: run.request.environmentJsonPath }),
    ...(run.request.environmentVersionPublicId === undefined
      ? {}
      : { environmentVersionPublicId: run.request.environmentVersionPublicId }),
    ...(definition === undefined ? {} : { definition }),
  });
  if (outcome.kind === "failed") {
    record(run, "synchronize", "failed", {
      startedAtMs: started,
      reason: outcome.reason,
    });
    run.stoppedAt = "synchronize";
    throw new WorkflowHalt("FAILED");
  }
  record(run, "synchronize", "unsupported", {
    startedAtMs: started,
    reason: outcome.residual.reason,
    residual: outcome.residual,
  });
  adoptResidual(run, outcome.residual);
  return false;
}

async function stepBuild(run: RunState): Promise<string | undefined> {
  if (run.request.kind === "manual") {
    const residual = manualTriggerResidual(run.request.environmentPublicId);
    record(run, "build", "unsupported", {
      reason: residual.reason,
      residual,
    });
    adoptResidual(run, residual);
    run.stoppedAt = "build";
    return undefined;
  }
  if (run.request.buildId !== undefined) {
    record(run, "build", "skipped", {
      reason: `Observing existing Build ${run.request.buildId}; no trigger.`,
    });
    run.newBuildId = run.request.buildId;
    return run.request.buildId;
  }
  assertNotCancelled(run);
  assertTime(run, "build");
  const started = run.ops.now();
  run.executed = true;
  const outcome = await run.ops.trigger({
    environment: run.request.environment,
    environmentPublicId: run.request.environmentPublicId,
    waitMs: remainingMs(run),
  });
  if (outcome.kind === "pending") {
    record(run, "build", "timed_out", {
      startedAtMs: started,
      reason: outcome.reason ?? "Trigger did not finish inside the workflow timeout.",
      pending: outcome.resume,
    });
    run.stoppedAt = "build";
    throw new WorkflowHalt("TIMED_OUT");
  }
  if (outcome.kind === "residual") {
    record(run, "build", "unsupported", {
      startedAtMs: started,
      reason: outcome.residual.reason,
      residual: outcome.residual,
    });
    adoptResidual(run, outcome.residual);
    run.stoppedAt = "build";
    return undefined;
  }
  if (outcome.kind !== "attributed" || outcome.attribution.status !== "ADOPTED") {
    record(run, "build", "failed", {
      startedAtMs: started,
      reason:
        outcome.kind === "failed"
          ? outcome.reason
          : outcome.attribution.reason,
    });
    run.stoppedAt = "build";
    return undefined;
  }
  const buildId = outcome.attribution.buildId;
  if (buildId === undefined) {
    record(run, "build", "failed", {
      startedAtMs: started,
      reason: "The trigger reported ADOPTED without a buildId.",
    });
    run.stoppedAt = "build";
    return undefined;
  }
  run.newBuildId = buildId;
  if (outcome.attribution.isDraft === false) {
    record(run, "build", "failed", {
      startedAtMs: started,
      reason:
        "The draft trigger reported isDraft=false. The response contradicts the invoked operation, so the Build is not adopted.",
    });
    run.stoppedAt = "build";
    return undefined;
  }
  // This workflow invokes only the proven draft trigger. The live tool contract,
  // rather than a missing optional response field, establishes that property.
  run.newBuildIsDraft = true;
  record(run, "build", "completed", {
    startedAtMs: started,
    reason: outcome.attribution.reason,
  });
  return buildId;
}

async function stepMonitor(
  run: RunState,
  buildId: string,
  _inspected: InspectOutcome,
): Promise<MonitorResult | undefined> {
  assertNotCancelled(run);
  assertTime(run, "monitor");
  const started = run.ops.now();
  run.executed = true;
  const outcome = await run.ops.monitor({
    environment: run.request.environment,
    environmentPublicId: run.request.environmentPublicId,
    buildId,
    waitMs: remainingMs(run),
  });
  if (outcome.kind === "pending") {
    record(run, "monitor", "timed_out", {
      startedAtMs: started,
      reason: outcome.reason ?? "Monitor did not finish inside the workflow timeout.",
      pending: outcome.resume,
    });
    run.stoppedAt = "monitor";
    throw new WorkflowHalt("TIMED_OUT");
  }
  if (outcome.kind === "failed") {
    record(run, "monitor", "failed", {
      startedAtMs: started,
      reason: outcome.reason,
    });
    run.stoppedAt = "monitor";
    return undefined;
  }
  const result = outcome.result;
  run.newBuildId = result.buildId;
  if (
    run.newBuildIsDraft !== undefined &&
    result.build?.isDraft !== undefined &&
    result.build.isDraft !== run.newBuildIsDraft
  ) {
    record(run, "monitor", "failed", {
      startedAtMs: started,
      reason:
        `Build ${buildId} reported contradictory draft state: trigger=${run.newBuildIsDraft} ` +
        `row=${result.build.isDraft}.`,
    });
    run.stoppedAt = "monitor";
    return undefined;
  }
  if (result.build?.isDraft !== undefined) run.newBuildIsDraft = result.build.isDraft;
  if (result.build?.status !== undefined) run.newBuildStatus = result.build.status;

  if (result.status === "TIMED_OUT") {
    record(run, "monitor", "timed_out", {
      startedAtMs: started,
      reason: result.reason,
    });
    run.stoppedAt = "monitor";
    throw new WorkflowHalt("TIMED_OUT");
  }
  if (result.status !== "TERMINAL" || result.build === undefined) {
    record(run, "monitor", "failed", {
      startedAtMs: started,
      reason: result.reason,
    });
    run.stoppedAt = "monitor";
    return undefined;
  }
  if (result.outcome !== "succeeded") {
    record(run, "monitor", "failed", {
      startedAtMs: started,
      reason: result.reason,
    });
    run.stoppedAt = "monitor";
    return undefined;
  }
  record(run, "monitor", "completed", {
    startedAtMs: started,
    reason: result.reason,
  });
  return result;
}

async function stepQualify(run: RunState): Promise<boolean> {
  assertNotCancelled(run);
  assertTime(run, "qualify");
  const started = run.ops.now();
  run.executed = true;
  const outcome = await run.ops.qualify({
    environment: run.request.environment,
    environmentPublicId: run.request.environmentPublicId,
    waitMs: remainingMs(run),
    ...(run.request.expect === undefined ? {} : { expect: run.request.expect }),
  });
  if (outcome.kind === "pending") {
    record(run, "qualify", "timed_out", {
      startedAtMs: started,
      reason: outcome.reason ?? "Qualify did not finish inside the workflow timeout.",
      pending: outcome.resume,
    });
    run.stoppedAt = "qualify";
    throw new WorkflowHalt("TIMED_OUT");
  }
  if (outcome.kind === "failed") {
    record(run, "qualify", "failed", {
      startedAtMs: started,
      reason: outcome.reason,
    });
    run.stoppedAt = "qualify";
    return false;
  }
  const qualification = outcome.result;
  run.qualification = qualification;
  const qualified =
    qualification.preparedBuild === "passed" &&
    qualification.startExecution === "passed" &&
    qualification.taskShell === "passed";
  if (!qualified) {
    record(run, "qualify", "failed", {
      startedAtMs: started,
      reason:
        `preparedBuild=${qualification.preparedBuild} startExecution=${qualification.startExecution} ` +
        `taskShell=${qualification.taskShell}; every layer must pass before activation`,
    });
    run.stoppedAt = "qualify";
    return false;
  }
  record(run, "qualify", "completed", {
    startedAtMs: started,
    reason:
      `preparedBuild=${qualification.preparedBuild} startExecution=${qualification.startExecution} ` +
      `taskShell=${qualification.taskShell}`,
  });
  return true;
}

async function stepActivate(run: RunState, monitor: MonitorResult): Promise<boolean> {
  const build = monitor.build;
  const buildId = run.newBuildId ?? monitor.buildId;
  if (build?.isDraft === true) {
    record(run, "activate", "failed", {
      reason:
        `Build ${buildId} is a draft Build, which is never an activation target.`,
    });
    run.stoppedAt = "activate";
    return false;
  }
  // The monitored row's identity is carried forward with its provenance intact:
  // a row whose environment was filled in from request context may be displayed,
  // but it must not be the thing that authorizes the promotion.
  const observed: ObservedBuild = run.request.observed ?? {
    buildId,
    status: build?.status ?? "SUCCEEDED",
    ...(build?.isDraft === undefined ? {} : { isDraft: build.isDraft }),
    environmentPublicId: build?.environmentPublicId ?? run.request.environmentPublicId,
    environmentPublicIdSource: build?.environmentPublicIdSource ?? "imputed",
    ...(build?.observedAtMs === undefined ? {} : { observedAtMs: build.observedAtMs }),
  };
  assertNotCancelled(run);
  assertTime(run, "activate");
  const started = run.ops.now();
  run.executed = true;
  const outcome = await run.ops.activate({
    environmentPublicId: run.request.environmentPublicId,
    buildId,
    observed,
  });
  if (!outcome.eligible) {
    record(run, "activate", "failed", {
      startedAtMs: started,
      reason: outcome.reason,
    });
    run.stoppedAt = "activate";
    return false;
  }
  if (outcome.completed) {
    record(run, "activate", "completed", {
      startedAtMs: started,
      reason: `Activation dispatched for exact Build ${buildId}; authoritative verification is still required.`,
    });
    return true;
  }
  record(run, "activate", "unsupported", {
    startedAtMs: started,
    reason: outcome.residual.reason,
    residual: outcome.residual,
  });
  adoptResidual(run, outcome.residual);
  run.stoppedAt = "activate";
  return false;
}

async function stepVerify(run: RunState): Promise<void> {
  assertNotCancelled(run);
  assertTime(run, "verify");
  const started = run.ops.now();
  run.executed = true;
  const outcome = await run.ops.inspect({
    environment: run.request.environment,
    environmentPublicId: run.request.environmentPublicId,
    waitMs: remainingMs(run),
  });
  if (outcome.kind === "pending") {
    record(run, "verify", "timed_out", {
      startedAtMs: started,
      reason: outcome.reason ?? "Verify did not finish inside the workflow timeout.",
      pending: outcome.resume,
    });
    run.stoppedAt = "verify";
    throw new WorkflowHalt("TIMED_OUT");
  }
  if (outcome.kind === "failed") {
    record(run, "verify", "failed", {
      startedAtMs: started,
      reason: outcome.reason ?? "Verify inspect failed.",
    });
    run.stoppedAt = "verify";
    throw new WorkflowHalt("FAILED");
  }
  if (outcome.identityGate === "failed" || outcome.identityGate === "unreadable") {
    record(run, "verify", "failed", {
      startedAtMs: started,
      reason: "Verify identity gate failed. Active state is not inferred.",
    });
    run.stoppedAt = "verify";
    throw new WorkflowHalt("FAILED");
  }
  const activeBuild = outcome.environment?.activeBuild;
  if (
    activeBuild?.readable !== true ||
    activeBuild.buildId !== run.newBuildId
  ) {
    record(run, "verify", "failed", {
      startedAtMs: started,
      reason:
        activeBuild?.readable === true
          ? `Verify read active Build ${activeBuild.buildId ?? "(none)"}, not ${run.newBuildId ?? "(none)"}.`
          : "Verify could not read the active Build authoritatively.",
    });
    run.stoppedAt = "verify";
    throw new WorkflowHalt("FAILED");
  }
  record(run, "verify", "completed", {
    startedAtMs: started,
    reason: `Authoritative readback confirms active Build ${activeBuild.buildId}.`,
  });
}

async function stepWarmLaunches(run: RunState): Promise<void> {
  const count = clampWarmLaunches(run.request.warmLaunchCount);
  if (count === 0) return;
  const prompt = run.request.warmLaunchPrompt;
  if (prompt === undefined || prompt === "") {
    record(run, "warm-launch", "failed", {
      reason: "warmLaunchCount requires warmLaunchPrompt.",
    });
    run.stoppedAt = "warm-launch";
    throw new WorkflowHalt("FAILED");
  }
  for (let index = 0; index < count; index += 1) {
    assertNotCancelled(run);
    assertTime(run, "warm-launch");
    const started = run.ops.now();
    run.executed = true;
    const launched = await run.ops.launch({
      environment: run.request.environment,
      prompt,
    });
    if (!launched.targetVerified) {
      record(run, "warm-launch", "failed", {
        startedAtMs: started,
        reason: `Launch ${index + 1} did not read back the named environment.`,
      });
      run.stoppedAt = "warm-launch";
      throw new WorkflowHalt("FAILED");
    }
    run.warmLaunches.push(launched);
    record(run, "warm-launch", "completed", {
      startedAtMs: started,
      reason: `agent=${launched.agentId} run=${launched.runId}`,
    });
  }
}

function record(
  run: RunState,
  step: WorkflowStepName,
  status: StepStatus,
  extra: {
    startedAtMs?: number;
    reason?: string;
    residual?: OwnerActionResidual;
    pending?: PendingDelegation;
  } = {},
): void {
  const endedAtMs = run.ops.now();
  const startedAtMs = extra.startedAtMs ?? endedAtMs;
  const entry: WorkflowStep = {
    step,
    status,
    startedAtMs,
    endedAtMs,
    durationMs: Math.max(0, endedAtMs - startedAtMs),
  };
  if (extra.reason !== undefined) entry.reason = extra.reason;
  if (extra.residual !== undefined) entry.residual = extra.residual;
  if (extra.pending !== undefined) {
    entry.pending = { ...extra.pending };
    // Also hoisted to the result: a caller that only reads the top level must
    // still get the handle, because without it the run cannot be read back.
    run.pending = { step, ...extra.pending };
  }
  run.steps.push(entry);
}

function adoptResidual(run: RunState, residual: OwnerActionResidual): void {
  run.residual = residual;
  for (const step of residual.nextSteps) {
    if (!run.manualActions.includes(step)) run.manualActions.push(step);
  }
}

function remainingMs(run: RunState): number {
  return Math.max(0, run.deadline - run.ops.now());
}

function assertTime(run: RunState, step: WorkflowStepName): void {
  if (remainingMs(run) > 0) return;
  record(run, step, "timed_out", {
    reason: `No time remained for ${step} inside the workflow timeout.`,
  });
  run.stoppedAt = step;
  throw new WorkflowHalt("TIMED_OUT");
}

function assertNotCancelled(run: RunState): void {
  if (run.request.signal?.aborted !== true) return;
  throw new WorkflowAborted();
}

class WorkflowAborted extends Error {
  constructor() {
    super("aborted");
    this.name = "WorkflowAborted";
  }
}

function statusFromStop(run: RunState): WorkflowStatus {
  const last = run.steps.at(-1);
  if (last?.status === "timed_out") return "TIMED_OUT";
  return "FAILED";
}

function finish(run: RunState, status: WorkflowStatus): WorkflowResult {
  const endedAtMs = run.ops.now();
  const result: WorkflowResult = {
    status,
    intent: run.intent,
    dryRun: false,
    confirmed: true,
    executed: run.executed,
    steps: run.steps,
    timings: {
      startedAtMs: run.startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - run.startedAtMs),
    },
    rollbackTarget: run.rollbackTarget,
    manualActions: run.manualActions,
  };
  if (run.identityGate !== undefined) result.identityGate = run.identityGate;
  if (run.oldBuildId !== undefined) {
    result.oldBuildId = run.oldBuildId;
    result.oldBuild = {
      buildId: run.oldBuildId,
      provenance: "current-run-boot",
      provenActive: false,
    };
  }
  if (run.newBuildId !== undefined) {
    result.newBuildId = run.newBuildId;
    result.newBuild = {
      buildId: run.newBuildId,
      ...(run.newBuildIsDraft === undefined ? {} : { isDraft: run.newBuildIsDraft }),
      ...(run.newBuildStatus === undefined ? {} : { status: run.newBuildStatus }),
    };
  }
  if (run.qualification !== undefined) result.qualification = run.qualification;
  if (run.residual !== undefined) result.residual = run.residual;
  if (run.warmLaunches.length > 0) result.warmLaunches = run.warmLaunches;
  if (run.stoppedAt !== undefined) result.stoppedAt = run.stoppedAt;
  if (run.pending !== undefined) result.pending = { ...run.pending };
  return result;
}

function finishPlan(args: {
  request: LifecycleRequest;
  intent: WorkflowIntent;
  startedAtMs: number;
  now: () => number;
  steps: WorkflowStep[];
  mutationPreview: MutationPreview[];
  rollbackTarget: RollbackTarget;
  residual?: OwnerActionResidual;
  manualActions: string[];
}): WorkflowResult {
  const endedAtMs = args.now();
  const result: WorkflowResult = {
    status: "PLANNED",
    intent: args.intent,
    dryRun: true,
    confirmed: false,
    executed: false,
    steps: args.steps,
    timings: {
      startedAtMs: args.startedAtMs,
      endedAtMs,
      durationMs: Math.max(0, endedAtMs - args.startedAtMs),
    },
    rollbackTarget: args.rollbackTarget,
    mutationPreview: args.mutationPreview,
    manualActions: args.manualActions,
  };
  if (args.residual !== undefined) result.residual = args.residual;
  if (args.request.buildId !== undefined) result.newBuildId = args.request.buildId;
  return result;
}

function plannedRollbackTarget(request: LifecycleRequest): RollbackTarget {
  if (request.supersededBuildId !== undefined) {
    return {
      buildId: request.supersededBuildId,
      provenance: "caller-supplied",
      provenActive: false,
      reason: UNREADABLE_ACTIVE,
    };
  }
  if (request.buildId !== undefined && request.intent === "cancel") {
    return {
      provenance: "none",
      provenActive: false,
      reason: UNREADABLE_ACTIVE,
    };
  }
  return NONE_TARGET;
}

function resolveRollbackTarget(
  request: LifecycleRequest,
  currentRunBuildId: string | undefined,
): RollbackTarget {
  if (request.supersededBuildId !== undefined) {
    return {
      buildId: request.supersededBuildId,
      provenance: "caller-supplied",
      provenActive: false,
      reason: UNREADABLE_ACTIVE,
    };
  }
  if (currentRunBuildId !== undefined) {
    return {
      buildId: currentRunBuildId,
      provenance: "current-run-boot",
      provenActive: false,
      reason:
        "environment-info.build.buildId is the Build this run booted from, not the active Build. " +
        UNREADABLE_ACTIVE,
    };
  }
  return NONE_TARGET;
}

function clampWarmLaunches(count: number | undefined): number {
  if (count === undefined || !Number.isFinite(count) || count <= 0) return 0;
  return Math.min(Math.trunc(count), MAX_WARM_LAUNCHES);
}
