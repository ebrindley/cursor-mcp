/**
 * Environment Operations: inspect, list and get Builds, logs, trigger, qualify,
 * CLI publication, Save and deletion, plus a catalog of owner actions.
 *
 * This module registers the MCP tools. Delegated operations run inside the named
 * environment; CLI writes use separately configured grants. Their response
 * models, judgments, and CLI workflows live in `environment-operations.ts`.
 *
 * Three properties are worth knowing before reading further.
 *
 * **A delegated read still launches a VM.** Delegated tools are not annotated
 * read-only: they cost quota, they are not idempotent, and `read:*` does not
 * grant them. Cursor's own state is unchanged by the read missions, which is why
 * they are not destructive either.
 *
 * **A tool call does not block on a Build.** A Build takes minutes. Each tool
 * starts its mission, waits up to `waitMs` (default none), and otherwise returns
 * `DELEGATION_PENDING` with a `resume` handle the caller passes back. This server
 * retains in-process resume bindings; the caller holds the identifiers. A server
 * restart loses those bindings.
 *
 * **Manual-only operations are catalog rows.** `cursor_list_owner_actions`
 * describes Build cancellation, activation, deactivation, rollback, version
 * Restore, and host-wide triggering without launching a delegate. They are not
 * separate callable mutation tools. `cursor_save_environment` has a gated CLI
 * path and can also judge readback of an owner Save. `activationEnabled` is
 * reserved and enables no current operation.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentScope } from "../agent-scope.js";
import type { CursorClient } from "../client.js";
import type { Policy } from "../config.js";
import { activeProfile } from "../config.js";
import { cursorCliRunner, type CliRunner } from "../cursor-cli.js";
import {
  BUILD_STATUS_FILTERS,
  CursorDelegatedRunner,
  MAX_MONITOR_ATTEMPTS,
  MAX_PAGES,
  MAX_PAGE_LIMIT,
  MAX_WAIT_MS,
  normalizeMissionRequest,
  type DelegatedRunner,
  type DelegationHandle,
  type MissionName,
  type MissionRequest,
} from "../delegated-run.js";
import {
  ACTIVE_BUILD_UNREADABLE_REASON,
  DELEGATED_TRUST,
  activateBuildResidual,
  attributeTriggeredBuild,
  buildLine,
  cancelBuildResidual,
  deactivateBuildResidual,
  extractReport,
  findBuild,
  identityGate,
  looksLikeNumericVersionId,
  manualTriggerResidual,
  monitorOutcome,
  projectBuild,
  projectBuildLogs,
  projectEnvironment,
  qualifyLayers,
  restoreEnvironmentVersionResidual,
  rollbackBuildResidual,
  saveEnvironmentResidual,
  deleteEnvironmentWithCli,
  publishEnvironmentWithCli,
  saveEnvironmentWithCli,
  verifySaveEffect,
  type CliWriteRequest,
  type DelegatedBuildPage,
  type DelegatedReport,
  type MonitorResult,
  type SaveCandidateRow,
} from "../environment-operations.js";
import { PolicyError } from "../errors.js";
import { CapabilityError } from "../lifecycle-model.js";
import { resolveEnvironmentBinding } from "../policy.js";
import { MeSchema } from "../schemas.js";
import {
  CREATE,
  DELEGATED_READ,
  DESTRUCTIVE,
  LOCAL_READ,
  PERSIST,
} from "./annotations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

/** The catalog that replaced the residual-only verbs. */
export const OWNER_ACTIONS_TOOL = "cursor_list_owner_actions";

/** Owner actions the catalog describes, in product order. */
export const OWNER_ACTIONS = [
  "TRIGGER_BUILD",
  "CANCEL_BUILD",
  "ACTIVATE_BUILD",
  "DEACTIVATE_BUILD",
  "ROLLBACK_BUILD",
  "RESTORE_ENVIRONMENT_VERSION",
] as const;

/* ------------------------------------------------------------------- arguments */

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

const BuildIdArg = z
  .string()
  .min(1)
  .describe("Exact Build id. There is no server-side filter, so it is matched client-side.");

/**
 * The same out-of-band declared id, for the operations that launch no delegate.
 *
 * There is no delegated answer to gate here, but the id must still come from
 * outside: an identifier a run reported about itself is self-confirming.
 */
const TargetIdArg = DeclaredIdArg.describe(
  "environmentPublicId declared out of band before the call. An id a run reported about itself is not a substitute.",
);

const VersionIdArg = z
  .string()
  .min(1)
  .describe(
    "Public opaque environmentVersionPublicId. Never the numeric builds[].environmentVersionId; they are different identifiers.",
  );

const ConfirmArg = z
  .boolean()
  .optional()
  .describe(
    "Must be true to request a draft Build trigger. Does not authorize promotion.",
  );

const CliPreviewArg = z.strictObject({
  operation: z.enum(["publish", "save", "delete"]),
  environmentPublicId: z.string().min(1),
  targetDigest: z.string().min(1),
  observedDigest: z.string().min(1).optional(),
  previewToken: z.string().min(1),
  expiresAtMs: z.number().int().nonnegative(),
});

const CliConfirmationArgs = {
  preview: CliPreviewArg.optional().describe(
    "Digest-bound preview returned by the immediately preceding unconfirmed call.",
  ),
  previewToken: z.string().min(1).optional(),
  confirm: z.boolean().optional(),
};

const ResumeIdArg = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9_.:-]+$/);

const ResumeArg = z
  .strictObject({
    agentId: ResumeIdArg,
    runId: ResumeIdArg,
  })
  .optional()
  .describe("Handle from an earlier DELEGATION_PENDING result. Resuming launches nothing new.");

const WaitArg = z
  .number()
  .int()
  .min(0)
  .max(MAX_WAIT_MS)
  .optional()
  .describe(
    `Milliseconds to wait for the delegate before returning a resume handle. Default 0, maximum ${MAX_WAIT_MS}. ` +
      "A long wait can exceed your own request timeout; resuming is cheaper than blocking.",
  );

const PageArgs = {
  statuses: z
    .array(z.enum([...BUILD_STATUS_FILTERS]))
    .optional()
    .describe(
      "Build status filter. CANCELLED is accepted as a filter even though no supported operation produces it.",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_LIMIT)
    .optional()
    .describe("Rows per page. Cursor's default is 25."),
  cursor: z.string().min(1).optional().describe("Opaque nextCursor from an earlier page."),
  pages: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGES)
    .optional()
    .describe(
      `Pages to read, up to ${MAX_PAGES}. A new Build is prepended to page 1, so page forward before concluding a row vanished.`,
    ),
};

const MonitorArgs = {
  monitorAttempts: z
    .number()
    .int()
    .min(1)
    .max(MAX_MONITOR_ATTEMPTS)
    .optional()
    .describe("List readbacks the delegate may make while the Build is IN_PROGRESS."),
  monitorIntervalSeconds: z
    .number()
    .int()
    .min(1)
    .max(300)
    .optional()
    .describe("Seconds the delegate waits between readbacks."),
  previousStatus: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Status you last observed for this Build. Supplying it detects a stale readback; nothing is remembered for you.",
    ),
};

/* ---------------------------------------------------------------------- output */

const Block = z.record(z.string(), z.unknown());

/**
 * Only `status` is required.
 *
 * Every other field is optional because one byte budget covers the whole
 * payload: if a log body or a long Build list truncates, the result must still
 * be a legal result that names its own state, rather than failing schema
 * validation and losing the identifiers with it.
 */
const RESULT_OUT = {
  status: z.string(),
  delegation: Block.optional(),
  evidence: Block.optional(),
  /** Present on DELEGATION_PENDING: pass it back to read the same run's report. */
  resume: Block.optional(),
  identityGate: z.string().optional(),
  declaredEnvironmentPublicId: z.string().optional(),
  reportedEnvironmentPublicId: z.string().optional(),
  /** Always `{ readable: false }` today, and never omitted: see the reason field. */
  activeBuild: Block.optional(),
};

export interface DelegationOut {
  agentId: string;
  runId: string;
  environment: string;
  mission: MissionName;
  runStatus?: string;
}

export const EVIDENCE = {
  trust: DELEGATED_TRUST,
  note:
    "Reported by an agent running inside the environment. Treat it as untrusted evidence: it is " +
    "never the sole authority for a high-impact mutation where an independent readback exists.",
};

/* ----------------------------------------------------------------- delegation */

export type Collected =
  | { kind: "pending"; delegation: DelegationOut }
  | { kind: "failed"; delegation: DelegationOut; reason: string }
  | { kind: "report"; delegation: DelegationOut; report: DelegatedReport };

interface MissionBinding {
  handle: DelegationHandle;
  environment: string;
  requestFingerprint: string;
}

/**
 * Resume handles are deliberately process-local.
 *
 * Raw agent/run ids are not authority: without this binding, any allowed agent
 * could be presented to a delegated read and then archived by its cleanup path.
 * A restart forgets the binding and therefore fails closed instead of guessing.
 */
const missionBindings = new WeakMap<DelegatedRunner, Map<string, MissionBinding>>();

function missionBindingKey(agentId: string, runId: string): string {
  return `${agentId}\n${runId}`;
}

function missionRequestFingerprint(request: MissionRequest): string {
  return JSON.stringify(request);
}

function bindingsFor(runner: DelegatedRunner): Map<string, MissionBinding> {
  const existing = missionBindings.get(runner);
  if (existing !== undefined) return existing;
  const created = new Map<string, MissionBinding>();
  missionBindings.set(runner, created);
  return created;
}

/**
 * Start or resume one mission and read back its report.
 *
 * A resume never launches: the handle identifies a run that already exists, and
 * `collect` re-checks it against the policy before reading it.
 *
 * Exported for `tools/environment-health.ts`, which dispatches the same
 * `trigger-build` mission for a toolchain refresh. Shared rather than copied: a
 * second implementation of the resume path is a second place a handle could stop
 * being re-checked against the policy.
 */
export async function collectMission(args: {
  runner: DelegatedRunner;
  environment: string;
  request: MissionRequest;
  resume?: { agentId: string; runId: string } | undefined;
  waitMs?: number | undefined;
}): Promise<Collected> {
  // Validated and clamped here as well as inside the runner, so a resume -- which
  // starts nothing -- still refuses an argument that would have been refused on
  // the way out.
  const request = normalizeMissionRequest(args.request);
  const bindings = bindingsFor(args.runner);
  const requestFingerprint = missionRequestFingerprint(request);
  let handle: DelegationHandle;
  let bindingKey: string;
  if (args.resume === undefined) {
    handle = await args.runner.start({
      environment: args.environment,
      request,
    });
    bindingKey = missionBindingKey(handle.agentId, handle.runId);
    bindings.set(bindingKey, {
      handle,
      environment: args.environment,
      requestFingerprint,
    });
  } else {
    bindingKey = missionBindingKey(args.resume.agentId, args.resume.runId);
    const binding = bindings.get(bindingKey);
    if (binding === undefined) {
      throw new PolicyError(
        "resume handle was not issued by this server process; start a new bounded delegation",
      );
    }
    if (
      binding.environment !== args.environment ||
      binding.requestFingerprint !== requestFingerprint
    ) {
      throw new PolicyError(
        "resume handle does not match the original environment and request",
      );
    }
    handle = binding.handle;
  }

  const outcome = await args.runner.collect({
    handle,
    waitMs: args.waitMs ?? 0,
  });
  if (outcome.state !== "pending") bindings.delete(bindingKey);
  const delegation: DelegationOut = {
    agentId: handle.agentId,
    runId: handle.runId,
    environment: handle.environment,
    mission: handle.mission,
    runStatus: outcome.runStatus,
  };

  if (outcome.state === "pending") return { kind: "pending", delegation };
  if (outcome.state === "failed") {
    return { kind: "failed", delegation, reason: outcome.reason };
  }
  const extracted = extractReport(outcome.text);
  if (!extracted.ok) {
    return { kind: "failed", delegation, reason: extracted.reason };
  }
  if (extracted.report.mission !== request.mission) {
    return {
      kind: "failed",
      delegation,
      reason:
        `the delegated report names mission ${extracted.report.mission}, not ${request.mission}`,
    };
  }
  return { kind: "report", delegation, report: extracted.report };
}

/** The pages a mission read, first page first. */
export function pagesOf(report: DelegatedReport): DelegatedBuildPage[] {
  return [
    ...(report.builds === undefined ? [] : [report.builds]),
    ...(report.morePages ?? []),
  ];
}

function pageSummary(pages: DelegatedBuildPage[]): Record<string, unknown> {
  const last = pages.at(-1);
  return {
    pagesRead: pages.length,
    hasMore: last?.hasMore === true,
    ...(last?.returned === undefined ? {} : { returned: last.returned }),
    ...(last?.limit === undefined ? {} : { limit: last.limit }),
    ...(last?.nextCursor === undefined ? {} : { nextCursor: last.nextCursor }),
  };
}

/**
 * The environment id a report speaks about.
 *
 * The declared id wins when it was supplied and verified. Otherwise the report's
 * own value is used and the gate says `ungated`, so a caller can see that the id
 * was self-reported.
 */
export function reportIdentity(
  report: DelegatedReport,
  declared?: string | undefined,
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

/**
 * The monitor verdict without its Build.
 *
 * The Build is reported once, as its own field, so a caller does not have to
 * decide which of two copies is authoritative.
 */
function verdict(monitor: MonitorResult): Record<string, unknown> {
  const { build: _build, ...rest } = monitor;
  return { ...rest };
}

/** A pending or failed delegation, rendered the same way for every tool. */
export function delegationResult(
  collected: Exclude<Collected, { kind: "report" }>,
  policy: Policy,
): ReturnType<typeof ok> {
  const delegation = collected.delegation;
  if (collected.kind === "pending") {
    return ok({
      source: `delegated run ${delegation.runId}`,
      text: [
        `delegation pending  run=${delegation.runId}  status=${delegation.runStatus ?? "(unknown)"}`,
        "Call the same tool again with resume={agentId, runId} to read the report.",
      ].join("\n"),
      structured: {
        status: "DELEGATION_PENDING",
        delegation: { ...delegation },
        resume: { agentId: delegation.agentId, runId: delegation.runId },
      },
      policy,
    });
  }
  return ok({
    source: `delegated run ${delegation.runId}`,
    text: `delegation failed  run=${delegation.runId}: ${collected.reason}`,
    structured: {
      status: "DELEGATION_FAILED",
      delegation: { ...delegation },
      evidence: { ...EVIDENCE, reason: collected.reason },
    },
    policy,
  });
}

/** An identity gate that did not verify. No projected data is reported with it. */
function identityFailure(
  args: {
    delegation: DelegationOut;
    declared?: string | undefined;
    reported?: string | undefined;
    conflicting?: boolean | undefined;
  },
  policy: Policy,
): ReturnType<typeof ok> {
  return ok({
    source: `delegated run ${args.delegation.runId}`,
    text: args.conflicting
      ? "identity gate failed: the delegated report contained conflicting environment ids. No data is reported."
      : args.declared === undefined
        ? "identity gate failed: the delegate reported no environmentPublicId. No data is reported."
        : `identity gate failed: the delegate reported environment ` +
          `${args.reported ?? "(none)"}, not the declared ${args.declared}. No data is reported.`,
    structured: {
      status: "IDENTITY_GATE_FAILED",
      delegation: { ...args.delegation },
      ...(args.declared === undefined
        ? {}
        : { declaredEnvironmentPublicId: args.declared }),
      ...(args.reported === undefined ? {} : { reportedEnvironmentPublicId: args.reported }),
      evidence: EVIDENCE,
    },
    policy,
  });
}

/* ------------------------------------------------------- mutation preconditions */

/**
 * Refuse an all-digits version id.
 *
 * The numeric `builds[].environmentVersionId` and the public opaque
 * `environmentVersionPublicId` are different identifier types, and passing the
 * first where the second belongs would target the wrong thing.
 */
function assertPublicVersionId(value: string | undefined, field: string): void {
  if (value !== undefined && looksLikeNumericVersionId(value)) {
    throw new PolicyError(
      `${field} is all digits, which is the numeric builds[].environmentVersionId rather than ` +
        "the public environmentVersionPublicId; the two identifiers are not interchangeable",
    );
  }
}

/* ------------------------------------------------------------------ registration */

export function registerEnvironmentOperationTools(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
  scope = new AgentScope(client, activeProfile(policy)),
  runner: DelegatedRunner = new CursorDelegatedRunner(
    client,
    activeProfile(policy),
    scope,
  ),
  now: () => number = Date.now,
  cliRunner: CliRunner | undefined = policy.cursorCli === undefined
    ? undefined
    : cursorCliRunner(policy.cursorCli),
): string[] {
  const profile = activeProfile(policy);
  const registered: string[] = [];

  const define = <C extends GateableConfig, A extends unknown[]>(
    spec: ToolSpec<C, A>,
  ) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  const cliWriteRequest = (
    environment: string,
    call: {
      confirm?: boolean;
      preview?: CliWriteRequest["preview"];
      previewToken?: string;
    },
  ): CliWriteRequest => {
    const binding = resolveEnvironmentBinding(profile, environment);
    if (
      !binding.identityPinned ||
      binding.publicId === undefined ||
      binding.scope === undefined
    ) {
      throw new PolicyError(
        "a Cursor CLI environment write requires a structured policy binding with publicId and scope",
      );
    }
    return {
      cli: policy.cursorCli,
      runner: cliRunner,
      binding: {
        name: binding.name,
        publicId: binding.publicId,
        scope: binding.scope,
        repos: binding.repos,
        identityPinned: true,
      },
      confirm: call.confirm,
      preview: call.preview,
      previewToken: call.previewToken,
      nowMs: now(),
      getRestEmail: async () => (await client.get("/v1/me", MeSchema)).userEmail,
    };
  };

  const cliWriteResult = (
    operation: string,
    result: { status: string; reason: string; dispatched: boolean },
  ) =>
    ok({
      source: `Cursor CLI environment ${operation}`,
      text: `${result.status}: ${result.reason}`,
      structured: { status: result.status, result: { ...result } },
      policy,
    });

  define({
    name: "cursor_publish_environment",
    config: {
      title: "Cursor: publish environment",
      description:
        "Create a pull request for one exactly bound personal, single-repository environment. A pull request is not persistence.",
      inputSchema: { environment: EnvironmentArg, ...CliConfirmationArgs },
      outputSchema: { status: z.string(), result: Block },
      annotations: PERSIST,
    },
    handler: async (call: {
      environment: string;
      confirm?: boolean;
      preview?: CliWriteRequest["preview"];
      previewToken?: string;
    }) => {
      const result = await publishEnvironmentWithCli(
        cliWriteRequest(call.environment, call),
      );
      return cliWriteResult("publish", result);
    },
  });

  define({
    name: "cursor_delete_environment",
    config: {
      title: "Cursor: delete environment",
      description:
        "Dry-run, confirm, and delete one exactly bound environment, then prove absence from a complete list.",
      inputSchema: { environment: EnvironmentArg, ...CliConfirmationArgs },
      outputSchema: { status: z.string(), result: Block },
      annotations: DESTRUCTIVE,
    },
    handler: async (call: {
      environment: string;
      confirm?: boolean;
      preview?: CliWriteRequest["preview"];
      previewToken?: string;
    }) => {
      const result = await deleteEnvironmentWithCli(
        cliWriteRequest(call.environment, call),
      );
      return cliWriteResult("delete", result);
    },
  });

  define({
    name: "cursor_inspect_environment",
    config: {
      title: "Cursor: inspect environment",
      description:
        "Report an environment's identity, managed type, version, Build history, and boot Build. Active Build is unreadable.",
      inputSchema: {
        environment: EnvironmentArg,
        environmentPublicId: DeclaredIdArg.optional(),
        ...PageArgs,
        resume: ResumeArg,
        waitMs: WaitArg,
      },
      outputSchema: {
        ...RESULT_OUT,
        environment: Block.optional(),
        snapshot: Block.optional(),
        builds: z.array(Block).optional(),
        page: Block.optional(),
      },
      annotations: DELEGATED_READ,
    },
    handler: async (call: {
      environment: string;
      environmentPublicId?: string;
      statuses?: string[];
      limit?: number;
      cursor?: string;
      pages?: number;
      resume?: { agentId: string; runId: string };
      waitMs?: number;
    }) => {
      const collected = await collectMission({
        runner,
        environment: call.environment,
        request: request("inspect", call),
        resume: call.resume,
        waitMs: call.waitMs,
      });
      if (collected.kind !== "report") return delegationResult(collected, policy);

      const report = collected.report;
      const identity = reportIdentity(report, call.environmentPublicId);
      const { gate, reported } = identity;
      if (gate === "failed" || gate === "unreadable") {
        return identityFailure(
          {
            delegation: collected.delegation,
            declared: call.environmentPublicId,
            reported,
            conflicting: identity.conflicting,
          },
          policy,
        );
      }

      const info = report.environmentInfo;
      const environmentId = call.environmentPublicId ?? reported;
      const pages = pagesOf(report);
      const builds =
        environmentId === undefined
          ? []
          : pages.flatMap((page) =>
              page.builds.map((row) => projectBuild(row, environmentId)),
            );
      const environment =
        info === undefined || environmentId === undefined
          ? undefined
          : projectEnvironment(info, environmentId);

      return ok({
        source: `delegated run ${collected.delegation.runId}`,
        text: [
          environment === undefined
            ? "environment: (not reported)"
            : `environment=${environment.environmentPublicId}` +
              `  version=${environment.environmentVersionPublicId ?? "(none)"}` +
              `  managedAs=${environment.managedAs}` +
              `  bootBuild=${environment.currentRunBuildId ?? "(none)"}`,
          "activeBuild=unreadable on this authority",
          ...builds.map(buildLine),
        ].join("\n"),
        structured: {
          status: "INSPECTED",
          identityGate: gate,
          delegation: { ...collected.delegation },
          ...(environment === undefined ? {} : { environment: { ...environment } }),
          activeBuild: { readable: false, reason: ACTIVE_BUILD_UNREADABLE_REASON },
          ...(environment === undefined ? {} : { snapshot: { ...environment.snapshot } }),
          builds: builds.map((build) => ({ ...build })),
          page: pageSummary(pages),
          evidence: EVIDENCE,
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_list_builds",
    config: {
      title: "Cursor: list Builds",
      description:
        "List an environment's Builds, newest first. No buildId filter exists; page forward before concluding a row moved.",
      inputSchema: {
        environment: EnvironmentArg,
        environmentPublicId: DeclaredIdArg.optional(),
        ...PageArgs,
        resume: ResumeArg,
        waitMs: WaitArg,
      },
      outputSchema: {
        ...RESULT_OUT,
        builds: z.array(Block).optional(),
        page: Block.optional(),
      },
      annotations: DELEGATED_READ,
    },
    handler: async (call: {
      environment: string;
      environmentPublicId?: string;
      statuses?: string[];
      limit?: number;
      cursor?: string;
      pages?: number;
      resume?: { agentId: string; runId: string };
      waitMs?: number;
    }) => {
      const collected = await collectMission({
        runner,
        environment: call.environment,
        request: request("list-builds", call),
        resume: call.resume,
        waitMs: call.waitMs,
      });
      if (collected.kind !== "report") return delegationResult(collected, policy);

      const report = collected.report;
      const identity = reportIdentity(report, call.environmentPublicId);
      const { gate, reported } = identity;
      if (gate === "failed" || gate === "unreadable") {
        return identityFailure(
          {
            delegation: collected.delegation,
            declared: call.environmentPublicId,
            reported,
            conflicting: identity.conflicting,
          },
          policy,
        );
      }
      const environmentId = call.environmentPublicId ?? reported ?? "";
      const pages = pagesOf(report);
      const builds = pages.flatMap((page) =>
        page.builds.map((row) => projectBuild(row, environmentId)),
      );

      return ok({
        source: `delegated run ${collected.delegation.runId}`,
        text: builds.map(buildLine).join("\n") || "(no Builds on the pages read)",
        structured: {
          status: "BUILDS_LISTED",
          delegation: { ...collected.delegation },
          builds: builds.map((build) => ({ ...build })),
          page: pageSummary(pages),
          evidence: EVIDENCE,
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_get_build",
    config: {
      title: "Cursor: get Build",
      description:
        "Read one exact Build, optionally waiting for it to reach a terminal status. SUCCEEDED is not activated.",
      inputSchema: {
        environment: EnvironmentArg,
        buildId: BuildIdArg,
        environmentPublicId: DeclaredIdArg.optional(),
        ...PageArgs,
        ...MonitorArgs,
        resume: ResumeArg,
        waitMs: WaitArg,
      },
      outputSchema: {
        ...RESULT_OUT,
        build: Block.optional(),
        monitor: Block.optional(),
        page: Block.optional(),
      },
      annotations: DELEGATED_READ,
    },
    handler: async (call: {
      environment: string;
      buildId: string;
      environmentPublicId?: string;
      statuses?: string[];
      limit?: number;
      cursor?: string;
      pages?: number;
      monitorAttempts?: number;
      monitorIntervalSeconds?: number;
      previousStatus?: string;
      resume?: { agentId: string; runId: string };
      waitMs?: number;
    }) => {
      const collected = await collectMission({
        runner,
        environment: call.environment,
        request: request("get-build", call),
        resume: call.resume,
        waitMs: call.waitMs,
      });
      if (collected.kind !== "report") return delegationResult(collected, policy);

      const report = collected.report;
      const identity = reportIdentity(report, call.environmentPublicId);
      const { gate, reported } = identity;
      if (gate === "failed" || gate === "unreadable") {
        return identityFailure(
          {
            delegation: collected.delegation,
            declared: call.environmentPublicId,
            reported,
            conflicting: identity.conflicting,
          },
          policy,
        );
      }
      const environmentId = call.environmentPublicId ?? reported ?? "";
      const pages = pagesOf(report);
      const monitor = monitorOutcome({
        buildId: call.buildId,
        environmentPublicId: environmentId,
        match: findBuild(pages, call.buildId, environmentId),
        previousStatus: call.previousStatus,
        attempts: report.monitorAttempts,
        elapsedMs: report.monitorElapsedMs,
        deadlineExceeded: report.monitorDeadlineExceeded,
      });

      return ok({
        source: `delegated run ${collected.delegation.runId}`,
        text: [
          `${monitor.status}  ${call.buildId}  outcome=${monitor.outcome}`,
          monitor.reason,
          ...(monitor.build === undefined ? [] : [buildLine(monitor.build)]),
        ].join("\n"),
        structured: {
          status: monitor.status,
          delegation: { ...collected.delegation },
          monitor: verdict(monitor),
          ...(monitor.build === undefined ? {} : { build: { ...monitor.build } }),
          page: pageSummary(pages),
          evidence: EVIDENCE,
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_get_build_logs",
    config: {
      title: "Cursor: get Build logs",
      description:
        "Fetch one Build's combined install-and-setup log. Terminal Builds only carry a body; retention is about ten days.",
      inputSchema: {
        environment: EnvironmentArg,
        buildId: BuildIdArg,
        environmentPublicId: DeclaredIdArg.optional(),
        includeText: z
          .boolean()
          .optional()
          .describe(
            "Include the log body. Default false: install scripts print whatever they print, tokens included. Identifiers are emitted before it.",
          ),
        resume: ResumeArg,
        waitMs: WaitArg,
      },
      outputSchema: {
        ...RESULT_OUT,
        logs: Block.optional(),
        build: Block.optional(),
      },
      annotations: DELEGATED_READ,
    },
    handler: async (call: {
      environment: string;
      buildId: string;
      environmentPublicId?: string;
      includeText?: boolean;
      resume?: { agentId: string; runId: string };
      waitMs?: number;
    }) => {
      // Off unless asked for, at both ends: the delegate is told not to return
      // the body, and the projection would drop it anyway.
      const includeText = call.includeText ?? false;
      const collected = await collectMission({
        runner,
        environment: call.environment,
        request: request("build-logs", { ...call, includeText }),
        resume: call.resume,
        waitMs: call.waitMs,
      });
      if (collected.kind !== "report") return delegationResult(collected, policy);

      const report = collected.report;
      const identity = reportIdentity(report, call.environmentPublicId);
      const { gate, reported } = identity;
      if (gate === "failed" || gate === "unreadable") {
        return identityFailure(
          {
            delegation: collected.delegation,
            declared: call.environmentPublicId,
            reported,
            conflicting: identity.conflicting,
          },
          policy,
        );
      }
      const environmentId = call.environmentPublicId ?? reported ?? "";
      const match = findBuild(pagesOf(report), call.buildId, environmentId);
      const logs = projectBuildLogs({
        buildId: call.buildId,
        environmentPublicId: environmentId,
        logs: report.logs,
        buildStatus: match.build?.status,
        includeText,
      });

      return ok({
        source: `delegated run ${collected.delegation.runId}`,
        text: [
          `${logs.availability}  ${call.buildId}  bytes=${logs.sizeBytes ?? "(unreported)"}`,
          logs.reason,
        ].join("\n"),
        structured: {
          status: logs.availability,
          delegation: { ...collected.delegation },
          ...(match.build === undefined ? {} : { build: { ...match.build } }),
          evidence: EVIDENCE,
          // Last: the body is the one field that can exhaust the byte budget on
          // its own, and every identifier above must survive that.
          logs: { ...logs },
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_trigger_build",
    config: {
      title: "Cursor: trigger Build",
      description:
        "Trigger one draft Build from an environment's saved configuration. Draft Builds never become the boot Build.",
      inputSchema: {
        environment: EnvironmentArg,
        environmentPublicId: DeclaredIdArg,
        kind: z
          .enum(["draft", "manual"])
          .optional()
          .describe(
            "draft (default) is the supported agent-requested Build. manual is a host-wide Build and returns TRIGGER_BUILD.",
          ),
        confirm: ConfirmArg,
        ...MonitorArgs,
        resume: ResumeArg,
        waitMs: WaitArg,
      },
      outputSchema: {
        ...RESULT_OUT,
        trigger: Block.optional(),
        build: Block.optional(),
        monitor: Block.optional(),
        environment: Block.optional(),
      },
      annotations: CREATE,
    },
    handler: async (call: {
      environment: string;
      environmentPublicId: string;
      kind?: "draft" | "manual";
      confirm?: boolean;
      monitorAttempts?: number;
      monitorIntervalSeconds?: number;
      previousStatus?: string;
      resume?: { agentId: string; runId: string };
      waitMs?: number;
    }) => {
      // Refused before anything is launched: a host-wide Build has no supported
      // authority, so spending a VM to discover that would be dishonest.
      if (call.kind === "manual") {
        throw new CapabilityError(manualTriggerResidual(call.environmentPublicId));
      }
      // A resume reads back a dispatch that was already confirmed; a fresh call
      // launches a delegate into the environment and writes a Build, so it is
      // gated the same way every other write on this surface is.
      if (call.resume === undefined && call.confirm !== true) {
        throw new PolicyError(
          "cursor_trigger_build requires confirm: true; it launches a delegate into the " +
            "environment and dispatches a draft Build, and there is no idempotency key to undo a second one",
        );
      }

      const collected = await collectMission({
        runner,
        environment: call.environment,
        request: request("trigger-build", call),
        resume: call.resume,
        waitMs: call.waitMs,
      });
      if (collected.kind !== "report") return delegationResult(collected, policy);

      const report = collected.report;
      const pages = pagesOf(report);
      const rows = pages.flatMap((page) => page.builds);
      const identity = reportIdentity(report, call.environmentPublicId);
      const attribution = attributeTriggeredBuild({
        declaredEnvironmentPublicId: call.environmentPublicId,
        reportedEnvironmentPublicId: identity.conflicting
          ? undefined
          : identity.reported,
        dispatched: report.triggerDispatched,
        precondition: report.precondition,
        trigger: report.trigger,
        baselineBuildIds: report.baselineBuildIds,
        rows,
        otherActiveRuns: report.otherActiveRuns,
      });

      const environment =
        report.environmentInfo === undefined || identity.conflicting || identity.reported === undefined
          ? undefined
          : projectEnvironment(report.environmentInfo, identity.reported);

      // Independent readback for the adopted id. The trigger result is delegated
      // prose plus a JSON body; the Build row is what proves the Build exists.
      const monitor =
        attribution.buildId === undefined
          ? undefined
          : monitorOutcome({
              buildId: attribution.buildId,
              environmentPublicId: call.environmentPublicId,
              match: findBuild(pages, attribution.buildId, call.environmentPublicId),
              previousStatus: call.previousStatus,
              attempts: report.monitorAttempts,
              elapsedMs: report.monitorElapsedMs,
              deadlineExceeded: report.monitorDeadlineExceeded,
            });

      return ok({
        source: `delegated run ${collected.delegation.runId}`,
        text: [
          `${attribution.status}  build=${attribution.buildId ?? "(none adopted)"}  dispatched=${attribution.dispatched}`,
          attribution.reason,
          ...(monitor === undefined ? [] : [`${monitor.status}: ${monitor.reason}`]),
          ...(monitor?.build === undefined ? [] : [buildLine(monitor.build)]),
        ].join("\n"),
        structured: {
          status: attribution.status,
          delegation: { ...collected.delegation },
          trigger: { ...attribution },
          // The version the mutation ran against, as the delegate read it. A
          // draft trigger was observed to reuse the existing version rather than
          // mint one, so this is reported for comparison, never as a receipt.
          ...(environment === undefined ? {} : { environment: { ...environment } }),
          ...(monitor === undefined ? {} : { monitor: verdict(monitor) }),
          ...(monitor?.build === undefined ? {} : { build: { ...monitor.build } }),
          activeBuild: { readable: false, reason: ACTIVE_BUILD_UNREADABLE_REASON },
          evidence: EVIDENCE,
        },
        policy,
      });
    },
  });

  define({
    name: OWNER_ACTIONS_TOOL,
    config: {
      title: "Cursor: list owner actions",
      description:
        "Catalog of Build and environment operations no supported authority performs: cancel, activate, deactivate, roll back, Restore, host-wide trigger. Returns the exact owner action for the ids you pass; launches nothing.",
      inputSchema: {
        environmentPublicId: TargetIdArg.optional(),
        buildId: BuildIdArg.optional(),
        supersededBuildId: BuildIdArg.optional().describe(
          "For ROLLBACK_BUILD: the Build the rollback would supersede.",
        ),
        environmentVersionPublicId: VersionIdArg.optional(),
        action: z
          .enum(OWNER_ACTIONS)
          .optional()
          .describe("Return one row only."),
      },
      outputSchema: { actions: z.array(Block) },
      annotations: LOCAL_READ,
    },
    handler: async (call: {
      environmentPublicId?: string;
      buildId?: string;
      supersededBuildId?: string;
      environmentVersionPublicId?: string;
      action?: (typeof OWNER_ACTIONS)[number];
    }) => {
      assertPublicVersionId(call.environmentVersionPublicId, "environmentVersionPublicId");
      // These are the operations that used to be registered as verbs. Each
      // verb spent a tool slot, and some required a paid delegated read first,
      // only to answer that the operation must be done in the dashboard. A
      // catalog keeps every owner action addressable -- including the
      // distinction that a run cancel is not a Build cancel -- without
      // pretending any of them can be performed here.
      const environmentPublicId = call.environmentPublicId ?? "(environmentPublicId)";
      const buildId = call.buildId ?? "(buildId)";
      const environmentVersionPublicId =
        call.environmentVersionPublicId ?? "(environmentVersionPublicId)";
      const rows = [
        manualTriggerResidual(environmentPublicId),
        cancelBuildResidual({ environmentPublicId, buildId }),
        activateBuildResidual({ environmentPublicId, buildId }),
        deactivateBuildResidual({ environmentPublicId, buildId }),
        rollbackBuildResidual({
          environmentPublicId,
          buildId,
          ...(call.supersededBuildId === undefined
            ? {}
            : { supersededBuildId: call.supersededBuildId }),
        }),
        restoreEnvironmentVersionResidual({ environmentPublicId, environmentVersionPublicId }),
      ].filter((row) => call.action === undefined || row.action === call.action);
      return ok({
        source: "owner-actions catalog",
        text: rows
          .map((row) => `${row.action}  ${row.authority}  ${row.nextSteps[0] ?? ""}`)
          .join("\n"),
        structured: { actions: rows.map((row) => ({ ...row })) },
        policy,
      });
    },
  });

  define({
    name: "cursor_save_environment",
    config: {
      title: "Cursor: save environment configuration",
      description:
        "Save a validated database-managed definition through the configured Cursor CLI, or verify a Save performed through another authority.",
      inputSchema: {
        environment: EnvironmentArg.optional().describe(
          "Named structured policy binding. Required with document for a Cursor CLI Save.",
        ),
        environmentPublicId: TargetIdArg,
        document: Block.optional().describe(
          "Complete intended environment definition for a Cursor CLI Save. It is sent over stdin, never argv.",
        ),
        ...CliConfirmationArgs,
        environmentJsonPath: z
          .string()
          .min(1)
          .nullable()
          .optional()
          .describe(
            "Exactly as read from environment-info: null is database-managed, a path is " +
              "repository-file managed, omitted is unknown and stops synchronization.",
          ),
        environmentVersionPublicId: VersionIdArg.optional().describe(
          "Baseline version recorded before the Save. It is the anchor a later Restore would target.",
        ),
        verify: z
          .strictObject({
            freshlyBooted: z
              .boolean()
              .describe(
                "True only if the readback came from a run that booted after the Save. A same-run readback is indeterminate.",
              ),
            exclusiveChangeWindow: z
              .literal(true)
              .describe(
                "Attests that Save was the only configuration mutation and no secret changed in the recorded window.",
              ),
            changeStartedAtMs: z.number().int().nonnegative().optional(),
            changeEndedAtMs: z.number().int().nonnegative().optional(),
            queueAllowanceMs: z.number().int().min(0).max(3_600_000).optional(),
            observedVersionPublicId: VersionIdArg.optional().describe(
              "environmentVersionPublicId that run reported.",
            ),
            baselineBuildIds: z
              .array(z.string().min(1))
              .max(200)
              .optional()
              .describe("Build ids from the paged pre-Save baseline."),
            baselineEnvironmentVersionIds: z
              .array(z.number())
              .max(200)
              .optional()
              .describe("Numeric builds[].environmentVersionId values from that same baseline."),
            builds: z
              .array(
                z.strictObject({
                  buildId: z.string().min(1),
                  status: z.string().min(1),
                  triggerType: z.string().min(1).optional(),
                  environmentPublicId: z.string().min(1).optional(),
                  environmentVersionId: z.number().optional(),
                  createdAtMs: z.number().int().nonnegative().optional(),
                }),
              )
              .max(100)
              .optional()
              .describe("Build rows read after the Save, from cursor_list_builds."),
          })
          .optional()
          .describe(
            "Readback of a Save an owner already performed. Omit it to get the owner action instead.",
          ),
      },
      outputSchema: {
        ...RESULT_OUT,
        verification: Block.optional(),
        result: Block.optional(),
      },
      annotations: PERSIST,
    },
    handler: async (call: {
      environment?: string;
      environmentPublicId: string;
      document?: Record<string, unknown>;
      confirm?: boolean;
      preview?: CliWriteRequest["preview"];
      previewToken?: string;
      environmentJsonPath?: string | null;
      environmentVersionPublicId?: string;
      verify?: {
        freshlyBooted: boolean;
        exclusiveChangeWindow: true;
        changeStartedAtMs?: number;
        changeEndedAtMs?: number;
        queueAllowanceMs?: number;
        observedVersionPublicId?: string;
        baselineBuildIds?: string[];
        baselineEnvironmentVersionIds?: number[];
        builds?: SaveCandidateRow[];
      };
    }) => {
      if (call.environment !== undefined || call.document !== undefined) {
        if (call.environment === undefined || call.document === undefined) {
          throw new PolicyError(
            "a Cursor CLI Save requires both environment and document",
          );
        }
        const request = cliWriteRequest(call.environment, call);
        if (request.binding.publicId !== call.environmentPublicId) {
          throw new PolicyError(
            "environmentPublicId does not match the structured policy binding",
          );
        }
        const result = await saveEnvironmentWithCli({
          ...request,
          document: call.document,
        });
        return cliWriteResult("save", result);
      }

      assertPublicVersionId(call.environmentVersionPublicId, "environmentVersionPublicId");
      assertPublicVersionId(
        call.verify?.observedVersionPublicId,
        "verify.observedVersionPublicId",
      );

      // Verification is a judgement over readback the caller holds; it performs
      // no write, so it returns a result rather than a residual.
      if (call.verify !== undefined) {
        const verification = verifySaveEffect({
          environmentPublicId: call.environmentPublicId,
          freshlyBooted: call.verify.freshlyBooted,
          exclusiveChangeWindow: call.verify.exclusiveChangeWindow,
          ...(call.verify.changeStartedAtMs === undefined
            ? {}
            : { changeStartedAtMs: call.verify.changeStartedAtMs }),
          ...(call.verify.changeEndedAtMs === undefined
            ? {}
            : { changeEndedAtMs: call.verify.changeEndedAtMs }),
          ...(call.verify.queueAllowanceMs === undefined
            ? {}
            : { queueAllowanceMs: call.verify.queueAllowanceMs }),
          ...(call.environmentVersionPublicId === undefined
            ? {}
            : { baselineVersionPublicId: call.environmentVersionPublicId }),
          ...(call.verify.observedVersionPublicId === undefined
            ? {}
            : { observedVersionPublicId: call.verify.observedVersionPublicId }),
          ...(call.verify.baselineBuildIds === undefined
            ? {}
            : { baselineBuildIds: call.verify.baselineBuildIds }),
          ...(call.verify.baselineEnvironmentVersionIds === undefined
            ? {}
            : { baselineEnvironmentVersionIds: call.verify.baselineEnvironmentVersionIds }),
          ...(call.verify.builds === undefined ? {} : { rows: call.verify.builds }),
        });
        return ok({
          source: "caller-supplied readback of a delegated read",
          text: [
            `${verification.status}  versionChanged=${verification.versionChanged ?? "unknown"}` +
              `  build=${verification.attributedBuildId ?? "(none attributed)"}`,
            verification.reason,
          ].join("\n"),
          structured: {
            status: verification.status,
            verification: { ...verification },
            evidence: EVIDENCE,
          },
          policy,
        });
      }

      // No delegation and no VM: no published API-key, SDK, or delegated
      // operation persists Install/Start, so there is nothing to attempt.
      throw new CapabilityError(
        saveEnvironmentResidual({
          environmentPublicId: call.environmentPublicId,
          ...(call.environmentJsonPath === undefined
            ? {}
            : { environmentJsonPath: call.environmentJsonPath }),
          ...(call.environmentVersionPublicId === undefined
            ? {}
            : { environmentVersionPublicId: call.environmentVersionPublicId }),
        }),
      );
    },
  });

  define({
    name: "cursor_qualify_environment",
    config: {
      title: "Cursor: qualify environment",
      description:
        "Qualify three independent layers: prepared Build disk, Start execution, and the actual task shell.",
      inputSchema: {
        environment: EnvironmentArg,
        environmentPublicId: DeclaredIdArg.optional(),
        expect: z
          .strictObject({
            commands: z
              .array(z.string().min(1))
              .max(32)
              .optional()
              .describe("Command names that must be on PATH in the task shell."),
            environmentVariables: z
              .array(z.string().min(1))
              .max(32)
              .optional()
              .describe("Variable NAMES that must be set. Values are never requested or reported."),
            toolchain: z
              .array(z.string().min(1))
              .max(32)
              .optional()
              .describe(
                "Command names whose installed VERSION should be recorded. Recording only: no layer " +
                  "result is derived from a version, and a run inside the environment cannot say which " +
                  "version is correct. Judge them with cursor_assess_environment_health.",
              ),
            user: z.string().min(1).optional(),
            workspace: z.string().min(1).optional(),
          })
          .optional()
          .describe("What the task shell should look like. Nothing declared means nothing proven."),
        resume: ResumeArg,
        waitMs: WaitArg,
      },
      outputSchema: {
        ...RESULT_OUT,
        qualification: Block.optional(),
        environment: Block.optional(),
        toolchain: z.array(Block).optional(),
      },
      annotations: DELEGATED_READ,
    },
    handler: async (call: {
      environment: string;
      environmentPublicId?: string;
      expect?: {
        commands?: string[];
        environmentVariables?: string[];
        toolchain?: string[];
        user?: string;
        workspace?: string;
      };
      resume?: { agentId: string; runId: string };
      waitMs?: number;
    }) => {
      const collected = await collectMission({
        runner,
        environment: call.environment,
        request: {
          mission: "qualify",
          ...(call.environmentPublicId === undefined
            ? {}
            : { environmentPublicId: call.environmentPublicId }),
          ...(call.expect === undefined ? {} : { expectations: call.expect }),
        },
        resume: call.resume,
        waitMs: call.waitMs,
      });
      if (collected.kind !== "report") return delegationResult(collected, policy);

      const report = collected.report;
      const identity = reportIdentity(report, call.environmentPublicId);
      const { gate, reported } = identity;
      if (gate === "failed" || gate === "unreadable") {
        return identityFailure(
          {
            delegation: collected.delegation,
            declared: call.environmentPublicId,
            reported,
            conflicting: identity.conflicting,
          },
          policy,
        );
      }
      const environmentId = call.environmentPublicId ?? reported ?? "";
      const qualification = qualifyLayers({
        environmentPublicId: environmentId,
        report,
        expectations: call.expect,
      });
      const environment =
        report.environmentInfo === undefined || identity.conflicting || reported === undefined
          ? undefined
          : projectEnvironment(report.environmentInfo, reported);

      return ok({
        source: `delegated run ${collected.delegation.runId}`,
        text: [
          `preparedBuild=${qualification.preparedBuild}  startExecution=${qualification.startExecution}  taskShell=${qualification.taskShell}`,
          ...qualification.toolchain.map((tool) => `installed: ${tool.name} ${tool.version}`),
          ...qualification.divergences.map((line) => `divergence: ${line}`),
        ].join("\n"),
        structured: {
          status: "QUALIFIED",
          delegation: { ...collected.delegation },
          // Reported alongside the qualification rather than inside it only: the
          // freshness check consumes this list directly, and a version is
          // evidence for that judgement rather than a layer verdict.
          toolchain: qualification.toolchain.map((tool) => ({ ...tool })),
          qualification: { ...qualification },
          ...(environment === undefined ? {} : { environment: { ...environment } }),
          evidence: EVIDENCE,
        },
        policy,
      });
    },
  });

  return registered;
}

/**
 * Build a mission request from tool arguments.
 *
 * Bounds and character classes are applied inside `delegated-run.ts`, so a value
 * cannot reach a prompt without passing them; this only assembles the fields the
 * mission uses.
 */
function request(
  mission: MissionName,
  call: {
    environmentPublicId?: string | undefined;
    buildId?: string | undefined;
    statuses?: string[] | undefined;
    limit?: number | undefined;
    cursor?: string | undefined;
    pages?: number | undefined;
    monitorAttempts?: number | undefined;
    monitorIntervalSeconds?: number | undefined;
    includeText?: boolean | undefined;
  },
): MissionRequest {
  return {
    mission,
    ...(call.environmentPublicId === undefined
      ? {}
      : { environmentPublicId: call.environmentPublicId }),
    ...(call.buildId === undefined ? {} : { buildId: call.buildId }),
    ...(call.statuses === undefined ? {} : { statuses: call.statuses }),
    ...(call.limit === undefined ? {} : { limit: call.limit }),
    ...(call.cursor === undefined ? {} : { cursor: call.cursor }),
    ...(call.pages === undefined ? {} : { pages: call.pages }),
    ...(call.monitorAttempts === undefined
      ? {}
      : { monitorAttempts: call.monitorAttempts }),
    ...(call.monitorIntervalSeconds === undefined
      ? {}
      : { monitorIntervalSeconds: call.monitorIntervalSeconds }),
    ...(call.includeText === undefined ? {} : { includeLogText: call.includeText }),
  };
}
