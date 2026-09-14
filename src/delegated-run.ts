/**
 * Bounded environment-scoped delegation.
 *
 * Cursor's environment and Build operations exist on the delegated Cloud MCP
 * surface, which is only reachable from *inside* a run attached to that
 * environment. So an Environment Operations tool launches one credential-free
 * agent into the named environment, gives it exactly one scripted mission, and
 * reads back one structured document.
 *
 * This is an implementation detail of Environment Operations, deliberately not a
 * general delegation framework:
 *
 *   - the mission list is closed (`MISSIONS`), and a mission is a fixed script,
 *     not a caller-supplied prompt;
 *   - every argument that reaches a prompt is validated against a strict
 *     character class first, so a Build id or an opaque cursor cannot carry
 *     instructions into the mission;
 *   - nothing is stored between calls. A slow mission returns a handle the
 *     caller passes back, and this module keeps no state at all.
 *
 * **Launching a delegate is a secrets-and-egress grant**, not VM routing. It
 * runs under the same Agent Lifecycle policy as `cursor_create_agent`: the
 * environment must be named in `profiles.*.environments`, every repository
 * Cursor reports attaching must be named in `profiles.*.repos`, and both are
 * enforced on readback. `autoCreatePR` is requested as false, so a profile that
 * pins it true refuses delegation rather than opening pull requests.
 *
 * Everything a delegate says is agent-authored untrusted evidence. It is never
 * the sole authority for a high-impact mutation where an independent readback
 * exists, and it always leaves through the untrusted envelope.
 */

import { modelSelection } from "./model-selection.js";
import type { CursorClient } from "./client.js";
import { seg } from "./client.js";
import type { Profile } from "./config.js";
import { CursorContractError, PolicyError } from "./errors.js";
import { REPORT_CLOSE, REPORT_OPEN, type QualificationExpectations } from "./environment-operations.js";
import { log } from "./log.js";
import { resolveAutoCreatePR, resolveCreateAgentLaunch, resolveModel } from "./policy.js";
import {
  cancelRejectedRun,
  rejectedRunCleanupMessage,
} from "./rejected-run-cleanup.js";
import type { AgentScope } from "./agent-scope.js";
import {
  CreateAgentResponseSchema,
  IdResponseSchema,
  RunSchema,
  isTerminal,
} from "./schemas.js";

/** The closed set of scripted missions. Adding one is a code change, by design. */
export const MISSIONS = [
  "inspect",
  "list-builds",
  "get-build",
  "build-logs",
  "trigger-build",
  "qualify",
] as const;

export type MissionName = (typeof MISSIONS)[number];

/** Build statuses `list-environment-builds` accepts as a filter. */
export const BUILD_STATUS_FILTERS = [
  "IN_PROGRESS",
  "SUCCEEDED",
  "FAILED",
  "CANCELLED",
  "SKIPPED",
] as const;

/** Bounds on what a mission may ask for. Every one of these is a ceiling. */
export const MAX_PAGES = 5;
export const MAX_PAGE_LIMIT = 100;
export const MAX_MONITOR_ATTEMPTS = 40;
export const MAX_LOG_BODY_CHARS = 8_000;
export const MAX_EXPECTED_NAMES = 32;
/** Longest a tool call will block waiting for a delegate before handing back a handle. */
export const MAX_WAIT_MS = 300_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

export interface MissionRequest {
  mission: MissionName;
  /** Declared out of band, before the run starts. The mission gates on it. */
  environmentPublicId?: string | undefined;
  buildId?: string | undefined;
  statuses?: string[] | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  pages?: number | undefined;
  monitorAttempts?: number | undefined;
  monitorIntervalSeconds?: number | undefined;
  includeLogText?: boolean | undefined;
  expectations?: QualificationExpectations | undefined;
}

export interface DelegationHandle {
  agentId: string;
  runId: string;
  environment: string;
  mission: MissionName;
}

export type DelegatedOutcome =
  | { state: "pending"; handle: DelegationHandle; runStatus: string }
  | { state: "complete"; handle: DelegationHandle; runStatus: string; text: string }
  | {
      state: "failed";
      handle: DelegationHandle;
      runStatus: string;
      reason: string;
    };

export interface DelegatedRunner {
  start(args: { environment: string; request: MissionRequest }): Promise<DelegationHandle>;
  collect(args: {
    handle: DelegationHandle;
    waitMs: number;
  }): Promise<DelegatedOutcome>;
}

/* ------------------------------------------------------------ argument hygiene */

/**
 * Identifiers and names that reach a mission prompt.
 *
 * Strict character classes rather than escaping: an id is an opaque token, so
 * anything outside these classes is a caller or an upstream doing something
 * other than naming a resource. `bld-<date>-<uuid>` is the observed Build-id
 * shape, but the grammar is not depended on -- only the character class is.
 */
const ID = new RegExp("^[A-Za-z0-9_.:-]{1,128}$");
/** An opaque pagination cursor, which is Cursor-supplied and still validated. */
const CURSOR_TOKEN = new RegExp("^[A-Za-z0-9_.:=+/-]{1,512}$");
const COMMAND_NAME = new RegExp("^[A-Za-z0-9_.+-]{1,64}$");
const VARIABLE_NAME = new RegExp("^[A-Za-z_][A-Za-z0-9_]{0,127}$");
const PATH_OR_USER = new RegExp("^[A-Za-z0-9_./@-]{1,128}$");

function checked(value: string, pattern: RegExp, label: string): string {
  if (!pattern.test(value)) {
    throw new PolicyError(
      `${label} contains characters that are not valid in a Cursor identifier`,
    );
  }
  return value;
}

function bounded(value: number, max: number, label: string): number {
  const rounded = Math.trunc(value);
  if (!Number.isFinite(rounded) || rounded < 1) {
    throw new PolicyError(`${label} must be at least 1`);
  }
  return Math.min(rounded, max);
}

function checkedNames(
  values: string[],
  pattern: RegExp,
  label: string,
): string[] {
  if (values.length > MAX_EXPECTED_NAMES) {
    throw new PolicyError(`at most ${MAX_EXPECTED_NAMES} ${label} may be declared`);
  }
  return values.map((value) => checked(value, pattern, label));
}

/* ----------------------------------------------------------------- mission text */

const PREAMBLE = [
  "You are a bounded, read-mostly probe launched by an MCP server. Do exactly the numbered",
  "steps below, in order, then stop. Do not improvise, do not explore, and do not continue",
  "after the report.",
  "",
  "Forbidden, without exception: editing or committing any repository; opening a pull request;",
  "saving or proposing environment configuration; taking or checking a snapshot; activating,",
  "deactivating, restoring, or rolling back anything; cancelling a run; reading secret values;",
  "using a browser; and calling any tool a step below does not name.",
  "",
  "Never print a secret, credential, token, signed URL, or dashboard link. Report",
  "environment-variable names only, never their values.",
].join("\n");

function reportContract(shape: string): string {
  return [
    "",
    "Finally, print the report and nothing after it. It must be one JSON object between the two",
    `markers, on their own lines: ${REPORT_OPEN} then the JSON then ${REPORT_CLOSE}.`,
    "Copy structured fields verbatim from the tool results. Do not summarise them, do not invent",
    "a field, and omit any field you could not read rather than guessing it.",
    "",
    "Report shape:",
    shape,
  ].join("\n");
}

function listStep(request: MissionRequest, index: number): string[] {
  const params: string[] = [];
  if (request.statuses !== undefined && request.statuses.length > 0) {
    params.push(`statuses=[${request.statuses.join(", ")}]`);
  }
  if (request.limit !== undefined) params.push(`limit=${request.limit}`);
  if (request.cursor !== undefined) params.push(`cursor=${request.cursor}`);
  const pages = request.pages ?? 1;
  return [
    `${index}. Call list-environment-builds${params.length === 0 ? " with no arguments" : ` with ${params.join(", ")}`}.` +
      ` It has no buildId filter, so do not try to filter by one.`,
    pages > 1
      ? `   If hasMore is true, page forward with nextCursor at most ${pages - 1} more times, keeping each page separate and in order.`
      : "   Do not page forward.",
  ];
}

/** A Build-scoped mission without an id has no target: the list has no filter. */
function requireBuildId(request: MissionRequest): string {
  if (request.buildId === undefined) {
    throw new PolicyError(`the ${request.mission} mission requires an exact buildId`);
  }
  return request.buildId;
}

function identityStep(request: MissionRequest, index: number): string {
  if (request.environmentPublicId === undefined) {
    return `${index}. Call environment-info and copy its environmentPublicId into the report.`;
  }
  return (
    `${index}. Call environment-info. Its environmentPublicId must equal ${request.environmentPublicId} exactly.` +
    ` If it does not, stop immediately, perform no further step, and report what you saw.`
  );
}

/**
 * The prompt for one mission.
 *
 * Every mission ends by printing one JSON document. The prose around it is
 * discarded: `extractReport` takes the marked region only.
 */
export function missionPrompt(request: MissionRequest): string {
  switch (request.mission) {
    case "inspect":
      return [
        PREAMBLE,
        "",
        identityStep(request, 1),
        ...listStep(request, 2),
        reportContract(
          '{ "mission": "inspect", "environmentInfo": <the environment-info structured result>, ' +
            '"builds": <the first list-environment-builds page>, "morePages": [<further pages, in order>] }',
        ),
      ].join("\n");

    case "list-builds":
      return [
        PREAMBLE,
        "",
        ...listStep(request, 1),
        reportContract(
          '{ "mission": "list-builds", "builds": <the first page>, "morePages": [<further pages, in order>] }',
        ),
      ].join("\n");

    case "get-build": {
      const attempts = request.monitorAttempts ?? 1;
      const interval = request.monitorIntervalSeconds ?? 15;
      const steps =
        attempts <= 1
          ? listStep(request, 1)
          : [
              ...listStep(request, 1),
              `2. Look for buildId ${requireBuildId(request)} in the pages you read, matching the exact id.`,
              `   While it is present and its status is IN_PROGRESS, wait ${interval} seconds and repeat step 1,`,
              `   at most ${attempts} times in total. Stop as soon as its status is SUCCEEDED, FAILED, SKIPPED,`,
              "   or CANCELLED, or when the attempts are used up. Report the last pages you read, the number",
              "   of attempts you made, and whether you ran out of attempts.",
            ];
      return [
        PREAMBLE,
        "",
        ...steps,
        reportContract(
          '{ "mission": "get-build", "builds": <the most recent first page you read>, "morePages": [<further pages, in order>], ' +
            '"monitorAttempts": <number>, "monitorDeadlineExceeded": <true only if you ran out of attempts> }',
        ),
      ].join("\n");
    }

    case "build-logs": {
      const buildId = requireBuildId(request);
      const body =
        request.includeLogText === false
          ? "   Do not put the log body in the report at all; report only its byte count."
          : `   Put at most the first ${MAX_LOG_BODY_CHARS} characters of the body in the report, and report the full byte count separately.`;
      return [
        PREAMBLE,
        "",
        `1. Call environment-build-logs with buildId=${buildId}.`,
        "   An accepted call that returns no body is a normal answer, not an error: logs materialise",
        "   only at a terminal state, and Builds older than about ten days return a retention note.",
        body,
        ...listStep(request, 2),
        `3. Find the row for buildId ${buildId} so the report carries its status.`,
        reportContract(
          '{ "mission": "build-logs", "logs": { "sizeBytes": <the reported byte count>, ' +
            '"text": <the log body, or omitted>, ' +
            '"retentionNote": <the retention sentence if there was one>, "notFound": <true only if Cursor did not recognise the buildId> }, ' +
            '"builds": <the list-environment-builds page> }',
        ),
      ].join("\n");
    }

    case "trigger-build": {
      const attempts = request.monitorAttempts ?? 1;
      const interval = request.monitorIntervalSeconds ?? 15;
      return [
        PREAMBLE,
        "",
        "This mission performs exactly one write. There is no idempotency key, so a second call",
        "would be a second Build. Never call trigger-environment-build more than once, whatever",
        "happens -- including a timeout, an error, or a result you cannot parse.",
        "",
        identityStep(request, 1),
        "2. Call list-environment-builds with no arguments and record every buildId on that page as",
        "   the baseline. Every row must be terminal: SUCCEEDED, FAILED, SKIPPED, or CANCELLED.",
        "   If any row has any other status, including an unrecognised future status, stop: set",
        "   triggerDispatched to false, describe that nonterminal baseline row in precondition, and",
        "   do not trigger.",
        "3. Call list-cloud-agents. Count agents in this environment that have a run in progress,",
        "   ignoring archived and IDLE agents and ignoring yourself. If the count is above zero, stop:",
        '   set triggerDispatched to false and precondition to "another run is active against this',
        '   environment", and do not trigger.',
        "4. Call trigger-environment-build once, with no arguments, so it uses the saved configuration",
        "   and builds every repository at its default branch. Set triggerDispatched to true as soon as",
        "   you have called it, even if it failed or you cannot read the result. Copy the structured",
        "   result verbatim.",
        ...(attempts <= 1
          ? [
              "5. Call list-environment-builds with no arguments once, so the report carries the row for",
              "   the new Build.",
            ]
          : [
              "5. Call list-environment-builds with no arguments. If the new Build's row is IN_PROGRESS,",
              `   wait ${interval} seconds and read the list again, at most ${attempts} times in total.`,
              "   Stop as soon as its status is SUCCEEDED, FAILED, SKIPPED, or CANCELLED, or when the",
              "   attempts are used up.",
            ]),
        reportContract(
          '{ "mission": "trigger-build", "environmentInfo": <the environment-info structured result>, ' +
            '"baselineBuildIds": [<every buildId on the pre-trigger page>], "otherActiveRuns": <number>, ' +
            '"triggerDispatched": <true or false>, "precondition": <omit unless you stopped before triggering>, ' +
            '"trigger": <the trigger-environment-build structured result, omitted if you could not read it>, ' +
            '"builds": <the post-trigger page>, "monitorAttempts": <number>, ' +
            '"monitorDeadlineExceeded": <true only if you ran out of attempts> }',
        ),
      ].join("\n");
    }

    case "qualify": {
      const expectations = request.expectations ?? {};
      const commands = expectations.commands ?? [];
      const variables = expectations.environmentVariables ?? [];
      const toolchain = expectations.toolchain ?? [];
      return [
        PREAMBLE,
        "",
        identityStep(request, 1),
        ...listStep(request, 2),
        "3. Call get-events. An empty list is a normal answer: report the count as you found it and do",
        "   not describe an empty list as a failed Start script.",
        "4. In one task shell, and using no other tool, report: the working directory, the current user",
        commands.length === 0
          ? "   name, and nothing else."
          : `   name, and which of these commands are on PATH: ${commands.join(", ")}.`,
        variables.length === 0
          ? "   Do not read any environment variable."
          : `   Also report which of these environment-variable NAMES are set, without printing any value: ${variables.join(", ")}.`,
        ...(toolchain.length === 0
          ? ["   Do not ask any tool for its version."]
          : [
              `   Also report the installed version of each of these tools: ${toolchain.join(", ")}.`,
              "   Ask each one for its own version with its usual version flag, and report only the version",
              "   string it printed. Omit a tool you could not run or whose version you could not read,",
              "   rather than guessing one, and do not upgrade or install anything.",
            ]),
        reportContract(
          '{ "mission": "qualify", "environmentInfo": <the environment-info structured result>, ' +
            '"builds": <the list-environment-builds page>, "events": { "count": <number> }, ' +
            '"shell": { "workspace": <string>, "user": <string>, "commandsPresent": [], "commandsMissing": [], ' +
            '"environmentVariablesPresent": [], "environmentVariablesMissing": [], ' +
            '"toolchain": [{ "name": <the tool name you were given>, "version": <the version string it printed> }] } }',
        ),
      ].join("\n");
    }
  }
}

/**
 * Validate and clamp a mission request before it can reach a prompt.
 *
 * Returns a fresh request: the caller's object is never mutated, and every
 * numeric bound is applied here rather than trusted from the tool argument.
 */
export function normalizeMissionRequest(request: MissionRequest): MissionRequest {
  const out: MissionRequest = { mission: request.mission };

  if (request.environmentPublicId !== undefined) {
    out.environmentPublicId = checked(
      request.environmentPublicId,
      ID,
      "environmentPublicId",
    );
  }
  if (request.buildId !== undefined) {
    out.buildId = checked(request.buildId, ID, "buildId");
  }
  if (request.statuses !== undefined) {
    for (const status of request.statuses) {
      if (!(BUILD_STATUS_FILTERS as readonly string[]).includes(status)) {
        throw new PolicyError(`${status} is not an accepted Build status filter`);
      }
    }
    out.statuses = [...request.statuses];
  }
  if (request.limit !== undefined) {
    out.limit = bounded(request.limit, MAX_PAGE_LIMIT, "limit");
  }
  if (request.cursor !== undefined) {
    out.cursor = checked(request.cursor, CURSOR_TOKEN, "cursor");
  }
  if (request.pages !== undefined) {
    out.pages = bounded(request.pages, MAX_PAGES, "pages");
  }
  if (request.monitorAttempts !== undefined) {
    out.monitorAttempts = bounded(
      request.monitorAttempts,
      MAX_MONITOR_ATTEMPTS,
      "monitorAttempts",
    );
  }
  if (request.monitorIntervalSeconds !== undefined) {
    out.monitorIntervalSeconds = bounded(
      request.monitorIntervalSeconds,
      300,
      "monitorIntervalSeconds",
    );
  }
  if (request.includeLogText !== undefined) out.includeLogText = request.includeLogText;

  if (request.expectations !== undefined) {
    const expectations: QualificationExpectations = {};
    if (request.expectations.commands !== undefined) {
      expectations.commands = checkedNames(
        request.expectations.commands,
        COMMAND_NAME,
        "command names",
      );
    }
    if (request.expectations.environmentVariables !== undefined) {
      expectations.environmentVariables = checkedNames(
        request.expectations.environmentVariables,
        VARIABLE_NAME,
        "environment-variable names",
      );
    }
    if (request.expectations.toolchain !== undefined) {
      expectations.toolchain = checkedNames(
        request.expectations.toolchain,
        COMMAND_NAME,
        "toolchain command names",
      );
    }
    if (request.expectations.user !== undefined) {
      expectations.user = checked(request.expectations.user, PATH_OR_USER, "user");
    }
    if (request.expectations.workspace !== undefined) {
      expectations.workspace = checked(
        request.expectations.workspace,
        PATH_OR_USER,
        "workspace",
      );
    }
    out.expectations = expectations;
  }

  // A mission that names a Build cannot run without one: the list has no buildId
  // filter, so the id is the only thing that identifies the target.
  if (
    (request.mission === "get-build" || request.mission === "build-logs") &&
    out.buildId === undefined
  ) {
    throw new PolicyError(`the ${request.mission} mission requires an exact buildId`);
  }
  return out;
}

/* --------------------------------------------------------------------- runner */

export interface DelegatedRunnerOptions {
  pollIntervalMs?: number;
  /** Test seams. Nothing here reads the clock or sleeps directly. */
  sleepImpl?: (ms: number) => Promise<void>;
  nowImpl?: () => number;
  /** Archive a finished delegate so it does not accumulate in the agent list. */
  archiveOnFinish?: boolean;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * The one implementation, over the existing API-key client.
 *
 * There is no second transport and no adapter interface: this is the API-key
 * client launching an agent, plus a mission the agent performs with its own
 * Cloud MCP tools.
 */
export class CursorDelegatedRunner implements DelegatedRunner {
  readonly #client: CursorClient;
  readonly #profile: Profile | undefined;
  readonly #scope: AgentScope;
  readonly #pollIntervalMs: number;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #now: () => number;
  readonly #archive: boolean;

  constructor(
    client: CursorClient,
    profile: Profile | undefined,
    scope: AgentScope,
    options: DelegatedRunnerOptions = {},
  ) {
    this.#client = client;
    this.#profile = profile;
    this.#scope = scope;
    this.#pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.#sleep = options.sleepImpl ?? sleep;
    this.#now = options.nowImpl ?? Date.now;
    this.#archive = options.archiveOnFinish ?? true;
  }

  async start(args: {
    environment: string;
    request: MissionRequest;
  }): Promise<DelegationHandle> {
    // Both allowlists, through the same resolver `cursor_create_agent` uses.
    // Launching a delegate grants it the environment's secrets and network
    // policy, so it is gated exactly like any other named-environment launch.
    const launch = resolveCreateAgentLaunch(this.#profile, {
      environment: args.environment,
    });
    if (launch.kind !== "environment") {
      throw new PolicyError("a delegated run must target a named environment");
    }
    const request = normalizeMissionRequest(args.request);
    // Requested false explicitly: a profile pinning autoCreatePR true refuses
    // delegation rather than letting a probe open pull requests.
    const autoCreatePR = resolveAutoCreatePR(this.#profile, false);
    const model = resolveModel(this.#profile, undefined);

    const created = await this.#client.post("/v1/agents", CreateAgentResponseSchema, {
      body: {
        prompt: { text: missionPrompt(request) },
        env: { type: "cloud" as const, name: launch.name },
        autoCreatePR,
        name: `cursor-mcp ${request.mission}`,
        ...(model === undefined ? {} : { model: modelSelection(model) }),
      },
    });

    try {
      const reported = created.agent.env?.name?.trim();
      if (reported === undefined || reported === "") {
        throw new CursorContractError(
          `delegate ${created.agent.id} did not read back the named environment; its attached secrets cannot be verified`,
        );
      }
      if (reported !== launch.name) {
        throw new CursorContractError(
          `delegate ${created.agent.id} read back environment ${reported}, not ${launch.name}`,
        );
      }
      if (created.agent.env?.type !== undefined && created.agent.env.type !== "cloud") {
        throw new CursorContractError(
          `delegate ${created.agent.id} read back environment type ${created.agent.env.type}, not cloud`,
        );
      }
      // Enforces the repository allowlist against what Cursor says it attached.
      this.#scope.remember(created.agent);
    } catch (error) {
      // The VM already exists and has received the environment's secrets.
      // Archive is list hygiene, not cancellation, so contain the exact run.
      const cleanup = await cancelRejectedRun(
        this.#client,
        created.agent.id,
        created.run.id,
      );
      const suffix = rejectedRunCleanupMessage(cleanup);
      if (error instanceof PolicyError) {
        throw new PolicyError(
          `delegate ${created.agent.id} is outside this profile after launch: ${error.message}; ${suffix}`,
        );
      }
      if (error instanceof CursorContractError) {
        throw new CursorContractError(`${error.message}; ${suffix}`);
      }
      throw error;
    }

    return {
      agentId: created.agent.id,
      runId: created.run.id,
      environment: launch.name,
      mission: request.mission,
    };
  }

  async collect(args: {
    handle: DelegationHandle;
    waitMs: number;
  }): Promise<DelegatedOutcome> {
    const handle = {
      ...args.handle,
      agentId: checked(args.handle.agentId, ID, "agentId"),
      runId: checked(args.handle.runId, ID, "runId"),
    };
    // A handle can come back from a caller, so it is re-checked against the
    // policy exactly like any other agent id.
    await this.#scope.assert(handle.agentId);
    const deadline = this.#now() + Math.max(Math.min(args.waitMs, MAX_WAIT_MS), 0);
    const path = `/v1/agents/${seg(handle.agentId)}/runs/${seg(handle.runId)}`;

    for (;;) {
      const run = await this.#client.get(path, RunSchema);
      if (isTerminal(run.status)) {
        await this.#archiveQuietly(handle.agentId);
        if (run.status !== "FINISHED") {
          return {
            state: "failed",
            handle,
            runStatus: run.status,
            reason: `the delegated run ended as ${run.status} without reporting`,
          };
        }
        const text = run.result ?? "";
        if (text === "") {
          return {
            state: "failed",
            handle,
            runStatus: run.status,
            reason: "the delegated run finished without a reply to read",
          };
        }
        return { state: "complete", handle, runStatus: run.status, text };
      }
      // Hand back a handle rather than hold the tool call open. The Build itself
      // takes minutes, so a pending delegation is the normal case, not a fault.
      if (this.#now() + this.#pollIntervalMs > deadline) {
        return { state: "pending", handle, runStatus: run.status };
      }
      await this.#sleep(this.#pollIntervalMs);
    }
  }

  /**
   * Archive a finished delegate. Best effort: failing to tidy up is not a reason
   * to lose the evidence the delegate just produced.
   */
  async #archiveQuietly(agentId: string): Promise<void> {
    if (!this.#archive) return;
    try {
      await this.#client.post(
        `/v1/agents/${seg(agentId)}/archive`,
        IdResponseSchema,
      );
    } catch (error) {
      log.debug(
        `could not archive delegate ${agentId}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
