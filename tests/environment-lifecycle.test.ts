/**
 * Bounded environment lifecycle composition.
 *
 * The sequencer is the subject: it calls the atomic operations in order, stops
 * at the first failed prerequisite or readback, never records an unsupported
 * mutation as completed, and preserves a rollback target that is not a proven
 * active Build. The atomic functions themselves are tested elsewhere.
 */

import { describe, expect, it } from "vitest";
import {
  WORKFLOW_STEPS,
  atomicJudgements,
  planEnvironmentLifecycle,
  runEnvironmentLifecycle,
  type InspectOutcome,
  type LifecycleOperations,
  type LifecycleRequest,
  type MonitorOutcome,
  type QualifyOutcome,
  type TriggerOutcome,
  type WarmLaunchResult,
  type WorkflowStepName,
} from "../src/environment-lifecycle.js";
import {
  attributeTriggeredBuild,
  findBuild,
  monitorOutcome,
  projectEnvironment,
  qualifyLayers,
  type DelegatedBuildPage,
  type DelegatedBuildRow,
} from "../src/environment-operations.js";
import { LIFECYCLE_STAGES } from "../src/lifecycle-model.js";

const ENV = "env-public";
const ENV_NAME = "example-environment";
const DEFINITION = `{ "name": "example-environment", "install": "true", "start": "true" }`;

const row = (over: Partial<DelegatedBuildRow> = {}): DelegatedBuildRow => ({
  buildId: "bld-new",
  status: "SUCCEEDED",
  environmentPublicId: ENV,
  source: "AGENT",
  triggerType: "MANUAL",
  userFacingSnapshotId: "bld-new",
  createdAtMs: 1_000,
  completedAtMs: 160_000,
  isDraft: false,
  ...over,
});

const page = (builds: DelegatedBuildRow[]): DelegatedBuildPage => ({
  builds,
  environmentPublicId: ENV,
  hasMore: false,
});

const inspectOk = (boot = "bld-boot"): InspectOutcome => ({
  kind: "report",
  identityGate: "verified",
  reportedEnvironmentPublicId: ENV,
  environment: projectEnvironment({
    environmentPublicId: ENV,
    name: ENV_NAME,
    environmentVersionPublicId: "ver-1",
    environmentJsonPath: null,
    build: { buildId: boot, status: "SUCCEEDED" },
  }),
  currentRunBuildId: boot,
});

const triggerAdopted = (buildId = "bld-new", isDraft = true): TriggerOutcome => ({
  kind: "attributed",
  attribution: attributeTriggeredBuild({
    declaredEnvironmentPublicId: ENV,
    reportedEnvironmentPublicId: ENV,
    dispatched: true,
    trigger: { buildId, isDraft },
  }),
});

const monitorFor = (over: Partial<DelegatedBuildRow> = {}): MonitorOutcome => {
  const build = row(over);
  return {
    kind: "result",
    result: monitorOutcome({
      buildId: build.buildId,
      environmentPublicId: ENV,
      match: findBuild([page([build])], build.buildId, ENV),
    }),
  };
};

const qualifyFor = (
  over: Partial<DelegatedBuildRow> = {},
  shellFailed = false,
): QualifyOutcome => ({
  kind: "result",
  result: qualifyLayers({
    environmentPublicId: ENV,
    report: {
      mission: "qualify",
      environmentInfo: {
        environmentPublicId: ENV,
        build: { buildId: over.buildId ?? "bld-new", status: over.status ?? "SUCCEEDED" },
      },
      builds: page([row(over)]),
      events: { count: 1, events: [{}] },
      shell: {
        workspace: "/workspace",
        user: "ubuntu",
        commandsPresent: shellFailed ? [] : ["node"],
        commandsMissing: shellFailed ? ["node"] : [],
        environmentVariablesPresent: ["PATH"],
        environmentVariablesMissing: [],
      },
    },
    expectations: { commands: ["node"] },
  }),
});

const qualifyPassed = (): QualifyOutcome => {
  const outcome = qualifyFor();
  if (outcome.kind !== "result") throw new Error("qualification fixture must be a result");
  return {
    kind: "result",
    result: {
      ...outcome.result,
      startExecution: "passed",
      layers: {
        ...outcome.result.layers,
        startExecution: {
          result: "passed",
          evidence: ["authoritative Start execution readback"],
        },
      },
    },
  };
};

const launchOk = (n: number): WarmLaunchResult => ({
  agentId: `bc-${n}`,
  runId: `run-${n}`,
  environment: ENV_NAME,
  targetVerified: true,
  repos: ["https://github.com/ExampleOrg/ExampleRepo"],
});

function recordingOps(
  over: Partial<LifecycleOperations> = {},
): LifecycleOperations & { calls: string[] } {
  const calls: string[] = [];
  let t = 1_000;
  const base: LifecycleOperations = {
    now: () => {
      t += 1;
      return t;
    },
    async inspect() {
      calls.push("inspect");
      return inspectOk();
    },
    validate: async (input) => {
      calls.push("validate");
      return atomicJudgements.validate(input);
    },
    synchronize: async (input) => {
      calls.push("synchronize");
      return atomicJudgements.synchronize(input);
    },
    async trigger() {
      calls.push("trigger");
      return triggerAdopted();
    },
    async monitor(input) {
      calls.push("monitor");
      return monitorFor({ buildId: input.buildId, isDraft: true, status: "SUCCEEDED" });
    },
    async qualify() {
      calls.push("qualify");
      return qualifyFor();
    },
    activate: async (input) => {
      calls.push("activate");
      return atomicJudgements.activate(input);
    },
    cancel: async (input) => {
      calls.push("cancel");
      return atomicJudgements.cancel(input);
    },
    rollback: async (input) => {
      calls.push("rollback");
      return atomicJudgements.rollback(input);
    },
    async launch() {
      calls.push("launch");
      return launchOk(calls.filter((name) => name === "launch").length);
    },
    ...over,
  };
  const wrapped: LifecycleOperations = {
    now: over.now ?? base.now,
    inspect: async (input) => {
      if (over.inspect === undefined) return base.inspect(input);
      calls.push("inspect");
      return over.inspect(input);
    },
    validate: async (input) => {
      if (over.validate === undefined) return base.validate(input);
      calls.push("validate");
      return over.validate(input);
    },
    synchronize: async (input) => {
      if (over.synchronize === undefined) return base.synchronize(input);
      calls.push("synchronize");
      return over.synchronize(input);
    },
    trigger: async (input) => {
      if (over.trigger === undefined) return base.trigger(input);
      calls.push("trigger");
      return over.trigger(input);
    },
    monitor: async (input) => {
      if (over.monitor === undefined) return base.monitor(input);
      calls.push("monitor");
      return over.monitor(input);
    },
    qualify: async (input) => {
      if (over.qualify === undefined) return base.qualify(input);
      calls.push("qualify");
      return over.qualify(input);
    },
    activate: async (input) => {
      if (over.activate === undefined) return base.activate(input);
      calls.push("activate");
      return over.activate(input);
    },
    cancel: async (input) => {
      if (over.cancel === undefined) return base.cancel(input);
      calls.push("cancel");
      return over.cancel(input);
    },
    rollback: async (input) => {
      if (over.rollback === undefined) return base.rollback(input);
      calls.push("rollback");
      return over.rollback(input);
    },
    launch: async (input) => {
      if (over.launch === undefined) return base.launch(input);
      calls.push("launch");
      return over.launch(input);
    },
  };
  return Object.assign(wrapped, { calls });
}

const lifecycle = (
  over: Partial<LifecycleRequest> = {},
): LifecycleRequest => ({
  environment: ENV_NAME,
  environmentPublicId: ENV,
  confirm: true,
  alreadySynchronized: true,
  definitionText: DEFINITION,
  timeoutMs: 60_000,
  ...over,
});

const statusOf = (
  steps: { step: WorkflowStepName; status: string }[],
  step: WorkflowStepName,
) => steps.filter((entry) => entry.step === step).map((entry) => entry.status);

describe("composition contract", () => {
  it("sequences monitor between build and qualify, without turning stages into stored workflow state", () => {
    expect([...WORKFLOW_STEPS]).toEqual([
      "inspect",
      "validate",
      "synchronize",
      "build",
      "monitor",
      "qualify",
      "activate",
      "verify",
    ]);
    expect([...LIFECYCLE_STAGES]).not.toContain("monitor");
  });
});

describe("dry-run and confirmation", () => {
  it("plans mutations without calling inspect, trigger, or launch", async () => {
    const ops = recordingOps();
    const result = await runEnvironmentLifecycle(
      lifecycle({ dryRun: true, confirm: false, warmLaunchCount: 2, warmLaunchPrompt: "check" }),
      ops,
    );
    expect(result.status).toBe("PLANNED");
    expect(result.dryRun).toBe(true);
    expect(ops.calls).toEqual([]);
    expect(result.mutationPreview?.map((item) => item.action)).toEqual([
      "TRIGGER_BUILD",
      "ACTIVATE_BUILD",
      "CREATE_AGENT",
      "CREATE_AGENT",
    ]);
    expect(result.mutationPreview?.every((item) => item.dispatched === false)).toBe(true);
    expect(statusOf(result.steps, "activate")).toEqual(["planned"]);
    expect(statusOf(result.steps, "synchronize")).toEqual(["skipped"]);
  });

  it("refuses to mutate without confirm, still returning the preview", async () => {
    const ops = recordingOps();
    const result = await runEnvironmentLifecycle(lifecycle({ confirm: false }), ops);
    expect(result.status).toBe("CONFIRMATION_REQUIRED");
    expect(ops.calls).toEqual([]);
    expect(result.mutationPreview?.length).toBeGreaterThan(0);
  });

  it("previews residual-only intents with inspect explicitly skipped", () => {
    for (const intent of ["cancel", "rollback"] as const) {
      const result = planEnvironmentLifecycle(
        lifecycle({
          intent,
          buildId: "bld-prior",
          supersededBuildId: "bld-current",
          observed: {
            buildId: "bld-prior",
            status: "SUCCEEDED",
            isDraft: false,
            environmentPublicId: ENV,
            environmentPublicIdSource: "row",
            observedAtMs: Date.now(),
          },
        }),
      );
      expect(statusOf(result.steps, "inspect")).toEqual(["skipped"]);
    }
  });
});

describe("success", () => {
  it("runs through warm launches only after completed activation and exact active-Build readback", async () => {
    let inspections = 0;
    const ops = recordingOps({
      inspect: async () => {
        inspections += 1;
        const outcome = inspectOk();
        if (inspections === 1 || outcome.kind !== "report" || outcome.environment === undefined) {
          return outcome;
        }
        return {
          ...outcome,
          environment: {
            ...outcome.environment,
            activeBuild: { readable: true, buildId: "bld-new" },
          },
        };
      },
      monitor: async () => monitorFor({ buildId: "bld-new", isDraft: false }),
      qualify: async () => qualifyPassed(),
      activate: async () => ({ eligible: true, completed: true }),
    });
    const result = await runEnvironmentLifecycle(
      lifecycle({
        buildId: "bld-new",
        warmLaunchCount: 2,
        warmLaunchPrompt: "exercise the named environment",
      }),
      ops,
    );

    expect(result.status).toBe("COMPLETED");
    expect(ops.calls).toEqual([
      "inspect",
      "validate",
      "monitor",
      "qualify",
      "activate",
      "inspect",
      "launch",
      "launch",
    ]);
    expect(statusOf(result.steps, "inspect")).toEqual(["completed"]);
    expect(statusOf(result.steps, "validate")).toEqual(["completed"]);
    expect(statusOf(result.steps, "synchronize")).toEqual(["skipped"]);
    expect(statusOf(result.steps, "build")).toEqual(["skipped"]);
    expect(statusOf(result.steps, "monitor")).toEqual(["completed"]);
    expect(statusOf(result.steps, "qualify")).toEqual(["completed"]);
    expect(statusOf(result.steps, "activate")).toEqual(["completed"]);
    expect(statusOf(result.steps, "verify")).toEqual(["completed"]);
    expect(statusOf(result.steps, "warm-launch")).toEqual(["completed", "completed"]);

    expect(result.oldBuildId).toBe("bld-boot");
    expect(result.newBuildId).toBe("bld-new");
    expect(result.oldBuild?.provenActive).toBe(false);
    expect(result.rollbackTarget).toMatchObject({
      buildId: "bld-boot",
      provenance: "current-run-boot",
      provenActive: false,
    });
    expect(result.qualification?.preparedBuild).toBe("passed");
    expect(result.qualification?.startExecution).toBe("passed");
    expect(result.qualification?.taskShell).toBe("passed");
    expect(result.residual).toBeUndefined();
    expect(result.warmLaunches).toHaveLength(2);
    expect(result.steps.every((step) => step.status !== "completed" || step.residual === undefined)).toBe(
      true,
    );
  });

  it("stops at the owner-action residual instead of verifying or launching", async () => {
    const ops = recordingOps({
      monitor: async () => monitorFor({ buildId: "bld-new", isDraft: false }),
      qualify: async () => qualifyPassed(),
    });
    const result = await runEnvironmentLifecycle(
      lifecycle({
        buildId: "bld-new",
        warmLaunchCount: 2,
        warmLaunchPrompt: "must not launch",
      }),
      ops,
    );

    expect(result.status).toBe("STOPPED");
    expect(result.executed).toBe(true);
    expect(result.stoppedAt).toBe("activate");
    expect(result.residual?.action).toBe("ACTIVATE_BUILD");
    expect(statusOf(result.steps, "activate")).toEqual(["unsupported"]);
    expect(statusOf(result.steps, "verify")).toEqual([]);
    expect(ops.calls).not.toContain("launch");
  });
});

describe("cold path", () => {
  it("stops at the Save residual and does not trigger, qualify, or activate", async () => {
    const ops = recordingOps();
    const result = await runEnvironmentLifecycle(
      lifecycle({ alreadySynchronized: false, environmentJsonPath: null }),
      ops,
    );

    expect(result.status).toBe("STOPPED");
    expect(ops.calls).toEqual(["inspect", "validate", "synchronize"]);
    expect(statusOf(result.steps, "synchronize")).toEqual(["unsupported"]);
    expect(result.residual?.action).toBe("SAVE_ENVIRONMENT");
    expect(result.stoppedAt).toBe("synchronize");
    expect(result.rollbackTarget.provenActive).toBe(false);
    expect(result.steps.some((step) => step.step === "build")).toBe(false);
    expect(result.steps.some((step) => step.status === "completed" && step.step === "synchronize")).toBe(
      false,
    );
  });
});

describe("Build failure", () => {
  it("stops subsequent mutations and keeps the known rollback target", async () => {
    const ops = recordingOps({
      monitor: async () =>
        monitorFor({ status: "FAILED", failureType: "INSTALL_FAILED", isDraft: true }),
    });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("FAILED");
    expect(ops.calls).toEqual(["inspect", "validate", "trigger", "monitor"]);
    expect(ops.calls).not.toContain("qualify");
    expect(ops.calls).not.toContain("activate");
    expect(ops.calls).not.toContain("launch");
    expect(result.stoppedAt).toBe("monitor");
    expect(result.newBuildId).toBe("bld-new");
    expect(result.rollbackTarget).toMatchObject({
      buildId: "bld-boot",
      provenance: "current-run-boot",
      provenActive: false,
    });
  });
});

describe("timeout", () => {
  it("records a monitor timeout without activating", async () => {
    const ops = recordingOps({
      monitor: async () => ({
        kind: "result",
        result: monitorOutcome({
          buildId: "bld-new",
          environmentPublicId: ENV,
          match: findBuild(
            [page([row({ status: "IN_PROGRESS", userFacingSnapshotId: null, isDraft: true })])],
            "bld-new",
            ENV,
          ),
          deadlineExceeded: true,
        }),
      }),
    });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("TIMED_OUT");
    expect(ops.calls).toEqual(["inspect", "validate", "trigger", "monitor"]);
    expect(ops.calls).not.toContain("activate");
    expect(statusOf(result.steps, "monitor")).toEqual(["timed_out"]);
    expect(result.rollbackTarget.buildId).toBe("bld-boot");
    expect(result.rollbackTarget.provenActive).toBe(false);
  });
});

describe("cancellation", () => {
  it("requests CANCEL_BUILD for an adopted Build when the caller aborts", async () => {
    const controller = new AbortController();
    const ops = recordingOps({
      trigger: async () => {
        controller.abort();
        return triggerAdopted();
      },
    });
    const result = await runEnvironmentLifecycle(
      lifecycle({ signal: controller.signal }),
      ops,
    );

    expect(result.status).toBe("STOPPED");
    expect(ops.calls).toEqual(["inspect", "validate", "trigger", "cancel"]);
    expect(statusOf(result.steps, "cancel")).toEqual(["unsupported"]);
    expect(result.residual?.action).toBe("CANCEL_BUILD");
    expect(result.newBuildId).toBe("bld-new");
    expect(result.rollbackTarget.provenActive).toBe(false);
  });

  it("addresses cancel as CANCEL_BUILD and does not claim the Build cancelled", async () => {
    const ops = recordingOps();
    const result = await runEnvironmentLifecycle(
      lifecycle({ intent: "cancel", buildId: "bld-new" }),
      ops,
    );

    expect(result.status).toBe("STOPPED");
    // Zero delegated launches: inspect costs a VM and cannot change a residual.
    expect(ops.calls).toEqual(["cancel"]);
    expect(ops.calls).not.toContain("inspect");
    expect(ops.calls).not.toContain("trigger");
    expect(statusOf(result.steps, "inspect")).toEqual(["skipped"]);
    expect(statusOf(result.steps, "cancel")).toEqual(["unsupported"]);
    expect(result.residual?.action).toBe("CANCEL_BUILD");
    expect(result.residual?.buildId).toBe("bld-new");
    expect(result.rollbackTarget.provenActive).toBe(false);
  });

  it("launches nothing when cancel cannot even name a Build", async () => {
    const ops = recordingOps();
    const result = await runEnvironmentLifecycle(lifecycle({ intent: "cancel" }), ops);

    expect(result.status).toBe("FAILED");
    expect(ops.calls).toEqual([]);
    expect(result.executed).toBe(false);
    expect(result.stoppedAt).toBe("cancel");
  });
});

describe("qualification failure", () => {
  it("covers Build, Start, and task-shell, and stops before activate", async () => {
    const ops = recordingOps({
      qualify: async () => qualifyFor({ status: "FAILED", failureType: "INSTALL_FAILED" }),
    });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("FAILED");
    expect(ops.calls).toEqual(["inspect", "validate", "trigger", "monitor", "qualify"]);
    expect(ops.calls).not.toContain("activate");
    expect(result.qualification?.preparedBuild).toBe("failed");
    expect(result.qualification).toHaveProperty("startExecution");
    expect(result.qualification).toHaveProperty("taskShell");
    expect(result.stoppedAt).toBe("qualify");
    expect(result.rollbackTarget.buildId).toBe("bld-boot");
  });

  it("treats an indeterminate layer as unqualified and stops before activation", async () => {
    const ops = recordingOps();
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("FAILED");
    expect(result.qualification?.startExecution).toBe("indeterminate");
    expect(result.stoppedAt).toBe("qualify");
    expect(ops.calls).not.toContain("activate");
  });
});

describe("activation failure", () => {
  it("refuses an ineligible Build instead of handing it to an owner as ACTIVATE_BUILD", async () => {
    const ops = recordingOps({
      monitor: async () => monitorFor({ buildId: "bld-new", isDraft: false }),
      qualify: async () => qualifyPassed(),
      activate: async () => ({
        eligible: false,
        code: "NOT_SUCCEEDED",
        reason: "Build bld-new is FAILED, so it prepared no bootable disk to promote.",
      }),
    });
    const result = await runEnvironmentLifecycle(lifecycle({ buildId: "bld-new" }), ops);

    expect(result.status).toBe("FAILED");
    expect(ops.calls).toContain("activate");
    expect(ops.calls).not.toContain("launch");
    expect(statusOf(result.steps, "activate")).toEqual(["failed"]);
    expect(result.residual?.action).not.toBe("ACTIVATE_BUILD");
    expect(result.rollbackTarget.provenActive).toBe(false);
  });

  it("refuses to activate on an environment id the Build row never carried", async () => {
    const ops = recordingOps({
      monitor: async () =>
        monitorFor({ buildId: "bld-new", isDraft: false, environmentPublicId: undefined }),
      qualify: async () => qualifyPassed(),
    });
    const result = await runEnvironmentLifecycle(lifecycle({ buildId: "bld-new" }), ops);

    expect(result.status).toBe("FAILED");
    expect(result.stoppedAt).toBe("activate");
    expect(result.steps.at(-1)?.reason).toContain("filled in from page or request context");
    expect(result.residual).toBeUndefined();
    expect(ops.calls).not.toContain("launch");
  });

  it("refuses a draft Build before invoking activation", async () => {
    const ops = recordingOps({ qualify: async () => qualifyPassed() });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("FAILED");
    expect(result.stoppedAt).toBe("activate");
    expect(statusOf(result.steps, "activate")).toEqual(["failed"]);
    expect(ops.calls).not.toContain("activate");
    expect(ops.calls).not.toContain("launch");
  });
});

describe("trigger attribution", () => {
  it("does not retry or continue after an unknown trigger outcome", async () => {
    const ops = recordingOps({
      trigger: async () => ({ kind: "failed", reason: "dispatch outcome unknown" }),
    });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("FAILED");
    expect(ops.calls.filter((call) => call === "trigger")).toHaveLength(1);
    expect(ops.calls).not.toContain("monitor");
  });

  it("fails closed when trigger and Build row disagree about draft state", async () => {
    const ops = recordingOps({
      monitor: async () => monitorFor({ buildId: "bld-new", isDraft: false }),
    });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("FAILED");
    expect(result.stoppedAt).toBe("monitor");
    expect(result.steps.at(-1)?.reason).toContain("contradictory draft state");
    expect(ops.calls).not.toContain("qualify");
  });
});

describe("rollback", () => {
  it("addresses an exact predecessor as ROLLBACK_BUILD and never as Restore", async () => {
    const ops = recordingOps();
    const result = await runEnvironmentLifecycle(
      lifecycle({
        intent: "rollback",
        buildId: "bld-prev",
        supersededBuildId: "bld-new",
        observed: {
          buildId: "bld-prev",
          status: "SUCCEEDED",
          isDraft: false,
          environmentPublicId: ENV,
          environmentPublicIdSource: "row",
          observedAtMs: Date.now(),
        },
      }),
      ops,
    );

    expect(result.status).toBe("STOPPED");
    expect(ops.calls).toEqual(["rollback"]);
    expect(ops.calls).not.toContain("inspect");
    expect(statusOf(result.steps, "inspect")).toEqual(["skipped"]);
    expect(statusOf(result.steps, "rollback")).toEqual(["unsupported"]);
    expect(result.residual?.action).toBe("ROLLBACK_BUILD");
    expect(result.residual?.buildId).toBe("bld-prev");
    expect(result.residual?.supersededBuildId).toBe("bld-new");
    expect(result.residual?.environmentVersionPublicId).toBeUndefined();
    expect(result.rollbackTarget).toMatchObject({
      buildId: "bld-new",
      provenance: "caller-supplied",
      provenActive: false,
    });
  });
});

describe("fail-closed readbacks", () => {
  it("stops immediately when the identity gate fails", async () => {
    const ops = recordingOps({
      inspect: async () => ({
        kind: "report",
        identityGate: "failed",
        reportedEnvironmentPublicId: "env-other",
      }),
    });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("FAILED");
    expect(ops.calls).toEqual(["inspect"]);
    expect(result.stoppedAt).toBe("inspect");
  });
});

describe("pending delegations", () => {
  it("returns the agent and run ids structurally, not only in prose", async () => {
    const ops = recordingOps({
      monitor: async () => ({
        kind: "pending",
        resume: { agentId: "bc-monitor", runId: "run-monitor" },
        reason: "delegation pending  run=run-monitor  status=ACTIVE",
      }),
    });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("TIMED_OUT");
    expect(result.pending).toEqual({
      step: "monitor",
      agentId: "bc-monitor",
      runId: "run-monitor",
    });
    const monitorStep = result.steps.find((step) => step.step === "monitor");
    expect(monitorStep?.pending).toEqual({
      agentId: "bc-monitor",
      runId: "run-monitor",
    });
    expect(ops.calls).not.toContain("qualify");
  });

  it("carries the handle from an inspect that never finished", async () => {
    const ops = recordingOps({
      inspect: async () => ({
        kind: "pending",
        resume: { agentId: "bc-inspect", runId: "run-inspect" },
        reason: "still booting",
      }),
    });
    const result = await runEnvironmentLifecycle(lifecycle(), ops);

    expect(result.status).toBe("TIMED_OUT");
    expect(result.pending).toEqual({
      step: "inspect",
      agentId: "bc-inspect",
      runId: "run-inspect",
    });
  });
});

describe("planning-only", () => {
  it("classifies an unexecutable confirmed request before any mutation, without claiming execution", async () => {
    const ops = recordingOps();
    const result = await runEnvironmentLifecycle(
      lifecycle({
        planningOnly: true,
        planningOnlyReason: "this authority cannot execute the composed lifecycle",
        planningOnlyNextSteps: ["Use the atomic operations instead."],
      }),
      ops,
    );

    expect(result.status).toBe("PLANNING_ONLY");
    expect(result.confirmed).toBe(true);
    expect(result.executed).toBe(false);
    expect(result.dryRun).toBe(false);
    expect(result.planningOnlyReason).toContain("cannot execute");
    expect(result.manualActions).toContain("Use the atomic operations instead.");
    expect(ops.calls).toEqual([]);
    expect(result.mutationPreview?.every((item) => item.dispatched === false)).toBe(true);
    // No step is dressed up as having run.
    expect(result.steps.every((step) => step.status !== "completed")).toBe(true);
  });

  it("marks a genuine execution as executed and a plan as not", async () => {
    const executedResult = await runEnvironmentLifecycle(
      lifecycle({ alreadySynchronized: false, environmentJsonPath: null }),
      recordingOps(),
    );
    expect(executedResult.executed).toBe(true);
    expect(planEnvironmentLifecycle(lifecycle()).executed).toBe(false);
  });
});

describe("plan", () => {
  it("is a pure preview: dispatched is always false", () => {
    const planned = planEnvironmentLifecycle(
      lifecycle({ alreadySynchronized: false, environmentJsonPath: null }),
    );
    expect(planned.status).toBe("PLANNED");
    expect(planned.mutationPreview?.every((item) => item.dispatched === false)).toBe(true);
    expect(planned.residual?.action).toBe("SAVE_ENVIRONMENT");
  });
});
