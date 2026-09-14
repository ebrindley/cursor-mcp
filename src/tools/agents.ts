/**
 * Agent Lifecycle: list, inspect, launch, follow up, cancel.
 *
 * This is the agent/run slice of the public surface in
 * `docs/lifecycle-architecture.md`. Environment definition, Build operations,
 * and workspace controls (including `cursor_list_repos`) are separate domains;
 * this module does not speak REST/SDK/Cloud-MCP vocabulary to callers.
 *
 * Descriptions are one line -- they are resident in the client's context on every
 * request. Workflow guidance belongs in the README.
 *
 * Two facts shape this module, both confirmed against the live API:
 *
 *   - An agent's `status` is an open string (observed: ACTIVE, IDLE, ARCHIVED).
 *     It never reflects execution. IDLE is follow-up eligibility, not run
 *     success. "Is my work done?" is a question about a *run*, which is why
 *     `cursor_get_agent` reports `latestRunId` and the run tools exist.
 *   - `POST /v1/agents` returns the agent *and* its first run, so a launch needs
 *     no follow-up call to find out what to watch. Named-environment launches
 *     omit `repos` on the wire and enforce both allowlists on readback.
 */

import { ModelInputSchema, modelSelection, type ModelInput } from "../model-selection.js";
import { randomUUID } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentScope } from "../agent-scope.js";
import type { CursorClient } from "../client.js";
import {
  CursorCancelledError,
  currentRequestProgress,
  currentRequestSignal,
  pause,
  seg,
} from "../client.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import type { Policy } from "../config.js";
import { activeProfile } from "../config.js";
import { USAGE_LIMITED_CLASS } from "../api-errors.js";
import {
  CursorApiError,
  CursorContractError,
  CursorTransportError,
  CursorUsageExhaustedError,
  PolicyError,
} from "../errors.js";
import { followUpAcceptance, type FollowUpAcceptance } from "../lifecycle-model.js";
import {
  cancelRejectedRun,
  rejectedRunCleanupMessage,
} from "../rejected-run-cleanup.js";
import {
  assertAgentAccess,
  assertPullRequestUrlShape,
  repoKey,
  resolveAutoCreatePR,
  resolveModel,
  resolveCreateAgentLaunch,
  type LaunchRepo,
  type ResolvedCreateAgentLaunch,
} from "../policy.js";
import {
  AgentListSchema,
  AgentSchema,
  CreateAgentResponseSchema,
  CreateRunResponseSchema,
  IdResponseSchema,
  RunListSchema,
  RunSchema,
  UsageSchema,
  TokenUsageSchema,
  agentLine,
  isTerminal,
  runLine,
  usageLine,
  type Agent,
  type Run,
} from "../schemas.js";
import { capBytes, sanitize } from "../untrusted.js";
import { CANCEL, CREATE, READ } from "./annotations.js";
import { defineTool } from "./register.js";
import { ok, structuredCost } from "./result.js";

const FollowUpSchema = z.enum(["accepted", "refused", "unknown"]);

const PrUrlArg = z
  .string()
  .min(1)
  .max(512)
  .describe(
    "Existing pull request on this repository (https://github.com/<owner>/<name>/pull/<n>) for the agent to work on. Cursor ignores startingRef when set.",
  );

/**
 * The documented optional `prUrl` filter on list-agents, rechecked against
 * https://cursor.com/docs/cloud-agent/api/endpoints#list-agents on 2026-09-09:
 * "Filter agents by GitHub pull request URL."
 *
 * Same length bound and shape rules as the launch argument, and deliberately a
 * separate constant: this one names an existing PR to look up, not a target to
 * push to, so its description must not read as a launch instruction.
 */
const PrUrlFilter = z
  .string()
  .min(1)
  .max(512)
  .describe(
    "Return only agents Cursor associates with this pull request (https://github.com/<owner>/<name>/pull/<n>). Repeat it on every page.",
  );

const LaunchRepoInput = z.object({
  url: z.string().min(1).describe("Repository as `owner/name` or a GitHub URL."),
  startingRef: z
    .string()
    .min(1)
    .optional()
    .describe("Branch or commit to start from for this repository."),
  prUrl: PrUrlArg.optional(),
});

const AgentId = z
  .string()
  .min(1)
  .max(128)
  .describe("Agent id, in `bc-<uuid>` form.");
const RunIdArg = z.string().min(1).max(128).describe("Run id, in `run-<uuid>` form.");

/** The documented client-supplied agent id shape. Anything else is refused. */
const CLIENT_AGENT_ID = new RegExp(
  "^bc-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$",
  "i",
);

/**
 * Bounds for `cursor_wait_run`.
 *
 * The ceiling sits under the MCP SDK's default 60 s request timeout so a wait
 * returns a result the client is still listening for, instead of a timeout the
 * model reads as failure and answers by launching again.
 */
export const DEFAULT_RUN_WAIT_MS = 30_000;
export const MAX_RUN_WAIT_MS = 45_000;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * Detail reads one `cursor_list_agents` call may spend resolving thin summaries.
 *
 * Cursor's list returns durable identity fields only, so under a policy profile
 * a page of summaries needs the full record to judge. That is one GET each, and
 * the ceiling is the API's own default page size: a default page resolves whole,
 * while a caller who asks for `limit: 100` is told how many items went unchecked
 * rather than kept waiting past the client's request timeout. It bounds one
 * page, never a walk of the account.
 */
const MAX_SCOPE_LOOKUPS = 20;

/**
 * Pairs one `cursor_inspect_runs` call accepts.
 *
 * The limit bounds request size, not response size: the wall clock and
 * `maxResponseBytes` both end a batch early, and the continuation index says
 * where it stopped.
 */
const MAX_BATCH_ITEMS = 64;

/**
 * One wall-clock bound over a whole batch -- every scope lookup, every run read.
 *
 * Same ceiling and the same reason as `cursor_wait_run`: a result the client is
 * still listening for beats a request timeout the model reads as failure. The
 * batch answers with what it decided and where to continue instead.
 */
const MAX_BATCH_MS = 45_000;

/** Longest Cursor-authored diagnostic echoed per failed item, inside the fence. */
const MAX_ITEM_DETAIL_BYTES = 200;

/**
 * Longest Cursor status echoed per batch item.
 *
 * A cap here is what makes a batch item's minimal reportable size knowable
 * *before* its read: the budget reservation below is only an upper bound if the
 * one server-authored string in a read entry has a width this side owns. Every
 * status Cursor has ever returned is one short word.
 */
const MAX_BATCH_STATUS_BYTES = 32;

/**
 * What to tell a caller whose run creation was refused for exhausted usage.
 *
 * One line, and ours rather than Cursor's, so `fail` renders it outside the
 * untrusted fence. A refused launch says nothing about the evidence already
 * recorded for earlier runs, which sits on a retention clock: the useful next
 * action is to preserve that evidence, not to retry the launch.
 *
 * Read availability after exhaustion and the replay retention window are not
 * guaranteed by Cursor, so the guidance asks for prompt capture rather than
 * promising either. Enabling paid usage is deliberately named as the operator's
 * decision: nothing here does it, and nothing here should read as advice that it
 * is automatic.
 */
const USAGE_EXHAUSTED_GUIDANCE =
  "Included Cloud Agent usage is exhausted, so no run was created. Reads may still " +
  "answer, so preserve existing run evidence promptly with cursor_get_run, " +
  "cursor_list_artifacts / cursor_get_artifact_url, and the run stream (cursor_tail_run, " +
  "or cursor_export_run where registered); stream replay retention is not guaranteed. " +
  "Enabling on-demand usage is an operator decision this server never takes.";

/**
 * Create a run, replacing an exhausted-usage refusal with the same error plus
 * that guidance. Every other failure passes through untouched.
 */
async function withUsageGuidance<T>(create: () => Promise<T>): Promise<T> {
  try {
    return await create();
  } catch (error) {
    if (
      error instanceof CursorApiError &&
      !(error instanceof CursorUsageExhaustedError) &&
      error.classification === USAGE_LIMITED_CLASS
    ) {
      throw new CursorUsageExhaustedError(error, USAGE_EXHAUSTED_GUIDANCE);
    }
    throw error;
  }
}

/** Test seams for the wait loop. Production uses real time. */
export interface AgentToolHooks {
  sleep: (ms: number) => Promise<void>;
  now: () => number;
}

const REAL_TIME: AgentToolHooks = {
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};
const Page = {
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().min(1).optional(),
};

export function registerAgentTools(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
  scope = new AgentScope(client, activeProfile(policy)),
  hooks: AgentToolHooks = REAL_TIME,
): string[] {
  const profile = activeProfile(policy);
  const registered: string[] = [];
  // Cancellation only: this ledger never authorizes reads or further execution.
  const createdRuns = new Set<string>();
  const runKey = (agentId: string, runId: string) => JSON.stringify([agentId, runId]);

  const define = <C extends GateableConfig, A extends unknown[]>(
    spec: ToolSpec<C, A>,
  ) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  define({
    name: "cursor_list_agents",
    config: {
      title: "Cursor: list agents",
      description:
        "List cloud agents, newest first. Status is not execution state; use cursor_get_run.",
      inputSchema: {
        ...Page,
        // Upstream default is true, so an archived agent clutters the list by
        // default. Passed through only when the caller states it, so we do not
        // pin a default the API may change during the beta.
        includeArchived: z
          .boolean()
          .optional()
          .describe("Include archived agents. Cursor's default is true."),
        prUrl: PrUrlFilter.optional(),
      },
      outputSchema: {
        agents: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            followUp: FollowUpSchema,
            name: z.string().optional(),
            latestRunId: z.string().optional(),
            environment: z.string().optional(),
          }),
        ),
        /**
         * Listed agents whose scope could not be decided, so they are neither
         * shown nor denied. Absent when every item was decided.
         */
        unresolved: z.number().int().positive().optional(),
        nextCursor: z.string().optional(),
      },
      annotations: READ,
    },
    handler: async (args: {
      limit?: number;
      cursor?: string;
      includeArchived?: boolean;
      prUrl?: string;
    }) => {
      // Forwarded per call and never remembered: a caller continuing with
      // `cursor` repeats `prUrl` itself, so a page can never inherit a filter
      // the caller did not ask for. The canonical form is what goes on the wire,
      // so surrounding whitespace or a trailing slash cannot reach a query
      // parameter.
      const prUrl =
        args.prUrl === undefined
          ? undefined
          : assertPullRequestUrlShape(args.prUrl).canonical;
      const payload = await client.get("/v1/agents", AgentListSchema, {
        query: {
          limit: args.limit,
          cursor: args.cursor,
          includeArchived: args.includeArchived,
          prUrl,
        },
      });
      const agents: Agent[] = [];
      let unresolved = 0;
      let lookups = 0;
      for (const agent of payload.items) {
        const verdict = scope.classify(agent);
        if (verdict === "allowed") {
          agents.push(agent);
          continue;
        }
        if (verdict === "denied") continue;
        // A summary too thin to judge. One read of the full record decides it,
        // for the items that need it and no others.
        if (lookups >= MAX_SCOPE_LOOKUPS) {
          unresolved += 1;
          continue;
        }
        lookups += 1;
        try {
          const resolved = await scope.resolve(agent.id);
          // The record that was checked is the record that is reported: a
          // verdict reached on the full record does not license the thinner,
          // possibly different summary it replaced.
          if (resolved.verdict === "allowed") agents.push(resolved.agent);
          // A full record that still carries no repository metadata is
          // undecided, not refused.
          else if (resolved.verdict === "unresolved") unresolved += 1;
        } catch (error) {
          // Cancellation is the caller's decision, not a scope answer.
          if (error instanceof CursorCancelledError) throw error;
          // Neither permitted nor refused: a failed read leaves the scope
          // unknown, and an unknown scope must not read as an empty account.
          unresolved += 1;
        }
      }
      const lines = agents.map(agentLine);
      if (unresolved > 0) {
        lines.push(
          `(${unresolved} listed agent${unresolved === 1 ? "" : "s"} could not be checked ` +
            "against the profile and stayed hidden; retry, or narrow the page with `limit`)",
        );
      }
      // A filtered page is one page of Cursor's answer, not a census. Saying so
      // matters most when it is empty: "no agents" would otherwise read as "no
      // agent ever worked on this pull request", which neither pagination nor a
      // hidden unresolved item supports.
      if (prUrl !== undefined) {
        lines.push(
          "(" +
            (agents.length === 0
              ? "no agents on this page matched that pull request; "
              : "") +
            `filtered by prUrl=${prUrl}; this is one page of Cursor's matches, not proof ` +
            "of what else exists" +
            (payload.nextCursor === undefined
              ? ""
              : "; more pages remain -- pass the same prUrl with `cursor` to continue") +
            ")",
        );
      }
      return ok({
        source: "GET /v1/agents",
        text: lines.join("\n") || "(no agents in profile)",
        structured: {
          agents: agents.map((a) => {
            const environment = a.env?.name?.trim();
            return {
              id: a.id,
              status: a.status,
              followUp: followUpAcceptance(a.status),
              ...(a.name === undefined ? {} : { name: a.name }),
              ...(a.latestRunId === undefined
                ? {}
                : { latestRunId: a.latestRunId }),
              ...(environment ? { environment } : {}),
            };
          }),
          ...(unresolved === 0 ? {} : { unresolved }),
          ...(payload.nextCursor === undefined
            ? {}
            : { nextCursor: payload.nextCursor }),
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_get_agent",
    config: {
      title: "Cursor: get agent",
      description:
        "Inspect one agent: repos, settings, web URL, and the id of its most recent run.",
      inputSchema: { agentId: AgentId },
      outputSchema: {
        id: z.string(),
        status: z.string(),
        followUp: FollowUpSchema,
        url: z.string(),
        name: z.string().optional(),
        latestRunId: z.string().optional(),
        repos: z.array(z.string()),
        repoDetails: z.array(RepoDetail),
        environment: z.string().optional(),
        workOnCurrentBranch: z.boolean().optional(),
        autoCreatePR: z.boolean().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
      },
      annotations: READ,
    },
    handler: async (args: { agentId: string }) => {
      const agent = await client.get(
        `/v1/agents/${seg(args.agentId)}`,
        AgentSchema,
      );
      scope.remember(agent);
      return ok({
        source: `GET /v1/agents/${args.agentId}`,
        text: [
          agentLine(agent),
          `url=${agent.url}`,
          `latestRun=${agent.latestRunId ?? "(none)"}`,
          `followUp=${followUpAcceptance(agent.status)}`,
        ].join("\n"),
        structured: inspectAgent(agent),
        policy,
      });
    },
  });

  define({
    name: "cursor_list_runs",
    config: {
      title: "Cursor: list runs",
      description:
        "List an agent's runs, newest first. Run status carries the execution state: CREATING, RUNNING, or a terminal value.",
      inputSchema: { agentId: AgentId, ...Page },
      outputSchema: {
        runs: z.array(
          z.object({
            id: z.string(),
            status: z.string(),
            terminal: z.boolean(),
            durationMs: z.number().optional(),
          }),
        ),
        nextCursor: z.string().optional(),
      },
      annotations: READ,
    },
    handler: async (args: {
      agentId: string;
      limit?: number;
      cursor?: string;
    }) => {
      await scope.assert(args.agentId);
      const payload = await client.get(
        `/v1/agents/${seg(args.agentId)}/runs`,
        RunListSchema,
        { query: { limit: args.limit, cursor: args.cursor } },
      );
      return ok({
        source: `GET /v1/agents/${args.agentId}/runs`,
        text: payload.items.map(runLine).join("\n") || "(no runs)",
        structured: {
          runs: payload.items.map((r) => ({
            id: r.id,
            status: r.status,
            terminal: isTerminal(r.status),
            ...(r.durationMs === undefined ? {} : { durationMs: r.durationMs }),
          })),
          ...(payload.nextCursor === undefined
            ? {}
            : { nextCursor: payload.nextCursor }),
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_get_run",
    config: {
      title: "Cursor: get run",
      description:
        "Inspect one run: status, duration, reported branch or PR, and the final reply once it has finished.",
      inputSchema: { agentId: AgentId, runId: RunIdArg },
      outputSchema: RUN_OUT,
      annotations: READ,
    },
    handler: async (args: { agentId: string; runId: string }) => {
      await scope.assert(args.agentId);
      const run = await client.get(
        `/v1/agents/${seg(args.agentId)}/runs/${seg(args.runId)}`,
        RunSchema,
      );
      return ok({
        source: `GET /v1/agents/${args.agentId}/runs/${args.runId}`,
        text: runText(run),
        structured: runStructured(run),
        policy,
      });
    },
  });

  define({
    name: "cursor_inspect_runs",
    config: {
      title: "Cursor: inspect several runs",
      // Short on purpose: every registered description costs the client context
      // on every request. The contract is in docs/reference.md.
      description:
        `Read status for up to ${MAX_BATCH_ITEMS} agent/run id pairs you hold, in your order, under one ${MAX_BATCH_MS / 1000}s bound. Exact pairs only; continue at remaining.fromIndex unless complete.`,
      inputSchema: {
        runs: z
          .array(z.object({ agentId: AgentId, runId: RunIdArg }))
          .min(1)
          .max(MAX_BATCH_ITEMS)
          .describe(
            `Agent/run id pairs to read, in order. At most ${MAX_BATCH_ITEMS}. Repeats are read once and reported at every index you gave them. Each item is reported as read, denied, unresolved, error or notAttempted, so one undecidable agent does not refuse the whole call.`,
          ),
        fromIndex: z
          .number()
          .int()
          .min(0)
          .max(MAX_BATCH_ITEMS - 1)
          .optional()
          .describe(
            "Resume at this index of the same list, from the previous call's remaining.fromIndex. Earlier items are not read again.",
          ),
      },
      outputSchema: BATCH_OUT,
      annotations: READ,
    },
    handler: async (args: {
      runs: Array<{ agentId: string; runId: string }>;
      fromIndex?: number;
    }) => {
      const pairs = args.runs;
      const from = args.fromIndex ?? 0;
      if (from >= pairs.length) {
        throw new Error(
          `fromIndex ${from} is past the end of a ${pairs.length}-item list; the continuation index belongs to the list it came from`,
        );
      }
      // Summary and continuation are paid for before any item is admitted, at
      // their widest, so the fields that say what is missing can never be the
      // fields that go missing. `sanitizeDeep` truncating a batch would drop
      // items the caller asked for by index and leave `complete` claiming
      // otherwise, so nothing is admitted that the budget has not already
      // covered -- in the structured payload and in the fenced text alike.
      const widest = pairs.length;
      const worstRemaining = {
        fromIndex: widest,
        count: widest,
        indices: `${widest}-${widest}`,
      };
      const reserved =
        structuredCost({
          requested: widest,
          checked: widest,
          upstreamReads: widest,
          fromIndex: widest,
          complete: false,
          stoppedBy: "output-limit",
          remaining: worstRemaining,
          items: [],
        }) +
        Buffer.byteLength(
          batchFooter({
            checked: widest,
            requested: widest,
            from: widest,
            remaining: worstRemaining,
            stoppedBy: "output-limit",
            maxResponseBytes: policy.maxResponseBytes,
          }).join("\n"),
          "utf8",
        );
      let left = policy.maxResponseBytes - reserved;
      // The item that costs the most to *decide*, not the one that costs the
      // least to decline. A budget that holds only `notAttempted` lines holds no
      // answer: it reads every run, reports none of them, and hands back
      // `fromIndex` unchanged for the caller to try again forever.
      const widestDecided = Math.max(
        ...pairs.slice(from).map((pair, offset) => batchReservation(from + offset, pair)),
      );
      if (left < widestDecided) {
        // Before any read, because a batch that cannot report even one item is
        // a request no amount of upstream work makes answerable.
        throw new PolicyError(
          `maxResponseBytes is ${policy.maxResponseBytes}, which cannot hold one decided item of this batch plus its summary and continuation; raise maxResponseBytes in the policy, or send shorter ids`,
        );
      }

      const started = hooks.now();
      const bound = new AbortController();
      const boundTimer = setTimeout(() => bound.abort(), MAX_BATCH_MS);
      const caller = currentRequestSignal();
      const signal =
        caller === undefined ? bound.signal : AbortSignal.any([caller, bound.signal]);
      const boundHit = () => bound.signal.aborted && caller?.aborted !== true;

      // One verdict per distinct agent and one read per distinct pair. A repeated
      // pair still gets its own entry at its own index: deduplication is of
      // upstream work, never of the caller's requested entries.
      const verdicts = new Map<string, "allowed" | "denied" | "unresolved">();
      const codes = new Map<string, BatchCode | undefined>();
      const decisions = new Map<string, BatchDecision>();
      const entries: BatchEntry[] = [];
      const lines: string[] = [];
      let upstreamReads = 0;
      let checked = 0;
      let stoppedBy: BatchStop | undefined;
      let remainingFrom = pairs.length;

      /** Admit an item only if the reserved-out budget already covers it. */
      const admit = (index: number, pair: BatchPair, decision: BatchDecision) => {
        let admitted = decision;
        let cost = batchCost(index, pair, admitted);
        if (cost > left) {
          // This item does not fit whole, and its read is already spent. A
          // compact form beats discarding the answer -- but only when compacting
          // is actually smaller: on an item with no PR list and no diagnostic,
          // the `compact` flag is a field added and nothing removed.
          const compacted = batchCompact(decision);
          const compactedCost = batchCost(index, pair, compacted);
          if (compactedCost < cost) {
            admitted = compacted;
            cost = compactedCost;
          }
        }
        if (cost > left) return false;
        left -= cost;
        entries.push(batchEntry(index, pair, admitted));
        lines.push(batchLine(index, pair, admitted));
        if (admitted.outcome !== "notAttempted") checked += 1;
        return true;
      };

      const decide = async (pair: BatchPair): Promise<BatchDecision> => {
        let verdict = verdicts.get(pair.agentId);
        if (verdict === undefined) {
          if (!scope.enforcing) {
            verdict = "allowed";
          } else {
            // A fresh record per distinct agent, never the session cache: the
            // verdict this batch reports is the verdict of a record read now.
            try {
              upstreamReads += 1;
              verdict = (await scope.resolve(pair.agentId, { signal })).verdict;
            } catch (error) {
              if (error instanceof CursorCancelledError) throw error;
              // Neither permitted nor refused. A failed lookup leaves the scope
              // unknown, and an unknown scope must not read as a denial.
              verdict = "unresolved";
              codes.set(pair.agentId, "SCOPE_LOOKUP_FAILED");
            }
          }
          verdicts.set(pair.agentId, verdict);
        }
        if (verdict === "denied") return { outcome: "denied", code: "POLICY_DENIED" };
        if (verdict === "unresolved") {
          return {
            outcome: "unresolved",
            code: codes.get(pair.agentId) ?? "SCOPE_UNRESOLVED",
          };
        }
        try {
          upstreamReads += 1;
          const run = await client.get(
            `/v1/agents/${seg(pair.agentId)}/runs/${seg(pair.runId)}`,
            RunSchema,
            { signal },
          );
          // The run that answers for an index is the run that index asked for.
          if (run.id !== pair.runId || run.agentId !== pair.agentId) {
            return {
              outcome: "error",
              code: "IDENTITY_MISMATCH",
              detail: `requested ${pair.agentId}/${pair.runId}, read ${run.agentId}/${run.id}`,
            };
          }
          return readDecision(run);
        } catch (error) {
          if (error instanceof CursorCancelledError) throw error;
          // A request error stays this item's answer. The next item is still
          // attempted: one dead run must not hide the other 63.
          return batchErrorDecision(error);
        }
      };

      try {
        for (let index = from; index < pairs.length; index += 1) {
          const pair = pairs[index]!;
          const key = runKey(pair.agentId, pair.runId);
          let decision = decisions.get(key);
          if (decision === undefined) {
            // The bound stops scheduling, and says so, rather than starting work
            // it cannot finish. An already-decided repeat costs nothing and is
            // still emitted.
            if (hooks.now() - started >= MAX_BATCH_MS) {
              stoppedBy = "time-limit";
              remainingFrom = index;
              admit(index, pair, { outcome: "notAttempted", code: "NOT_ATTEMPTED" });
              break;
            }
            if (batchReservation(index, pair) > left) {
              // Stop before the GET rather than after it. The preflight above
              // guarantees the first item of this call was affordable, so
              // something is always reported, and no upstream read is spent on
              // an answer this response cannot carry. No item line for it: the
              // budget is what ran out, and `remaining` already names the index.
              stoppedBy = "output-limit";
              remainingFrom = index;
              break;
            }
            try {
              decision = await decide(pair);
            } catch (error) {
              // The caller's cancellation is the caller's decision and stays an
              // error. Our own deadline is not: it answers with what it has.
              if (!(error instanceof CursorCancelledError) || !boundHit()) throw error;
              stoppedBy = "time-limit";
              remainingFrom = index;
              admit(index, pair, { outcome: "notAttempted", code: "NOT_ATTEMPTED" });
              break;
            }
            decisions.set(key, decision);
          }
          if (!admit(index, pair, decision)) {
            stoppedBy = "output-limit";
            remainingFrom = index;
            break;
          }
        }
      } finally {
        clearTimeout(boundTimer);
      }

      const remaining =
        remainingFrom >= pairs.length
          ? undefined
          : {
              fromIndex: remainingFrom,
              count: pairs.length - remainingFrom,
              indices: indexRange(remainingFrom, pairs.length - 1),
            };
      const footer = batchFooter({
        checked,
        requested: pairs.length,
        from,
        remaining,
        stoppedBy,
        maxResponseBytes: policy.maxResponseBytes,
      });
      return ok({
        source: `batch run read (${upstreamReads} upstream request${upstreamReads === 1 ? "" : "s"})`,
        text: [...lines, ...footer].join("\n"),
        structured: {
          requested: pairs.length,
          checked,
          upstreamReads,
          // Never true while an item of the caller's list is undecided.
          complete: remaining === undefined,
          ...(from === 0 ? {} : { fromIndex: from }),
          ...(stoppedBy === undefined ? {} : { stoppedBy }),
          ...(remaining === undefined ? {} : { remaining }),
          items: entries,
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_wait_run",
    config: {
      title: "Cursor: wait for run",
      description:
        `Poll one run until it is terminal or waitMs elapses (default ${DEFAULT_RUN_WAIT_MS / 1000}s, maximum ${MAX_RUN_WAIT_MS / 1000}s). Returns what cursor_get_run returns plus timedOut; call again to keep waiting.`,
      inputSchema: {
        agentId: AgentId,
        runId: RunIdArg,
        waitMs: z
          .number()
          .int()
          .min(0)
          .max(MAX_RUN_WAIT_MS)
          .optional()
          .describe("Upper bound on the wait. Kept under the client's request timeout on purpose."),
        pollIntervalMs: z
          .number()
          .int()
          .min(1_000)
          .max(30_000)
          .optional()
          .describe("Delay between polls. Default 5000."),
      },
      outputSchema: {
        ...RUN_OUT,
        timedOut: z.boolean(),
        polls: z.number().int(),
        elapsedMs: z.number().int(),
      },
      annotations: READ,
    },
    handler: async (args: {
      agentId: string;
      runId: string;
      waitMs?: number;
      pollIntervalMs?: number;
    }) => {
      const waitMs = Math.min(args.waitMs ?? DEFAULT_RUN_WAIT_MS, MAX_RUN_WAIT_MS);
      const interval = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
      const path = `/v1/agents/${seg(args.agentId)}/runs/${seg(args.runId)}`;
      // One wall-clock bound over everything this call does: the scope lookup,
      // every GET, and every sleep. A slow upstream cannot stretch a 45 s wait
      // into a client timeout, which the model would read as failure.
      const started = hooks.now();
      const bound = new AbortController();
      const boundTimer = setTimeout(() => bound.abort(), waitMs);
      const caller = currentRequestSignal();
      const signal =
        caller === undefined ? bound.signal : AbortSignal.any([caller, bound.signal]);
      const boundHit = () => bound.signal.aborted && caller?.aborted !== true;
      // One notification per completed poll, when the client asked for them. The
      // poll interval is at least a second, so the cadence needs no extra gate,
      // and the run's own status stays out of the message: it is Cursor's text,
      // and the tool result is where it belongs.
      const progress = currentRequestProgress();
      let last: Run | undefined;
      let polls = 0;
      const finish = (run: Run, timedOut: boolean) => {
        const elapsedMs = hooks.now() - started;
        return ok({
          source: `GET ${path} (polled ${polls}x)`,
          text: [
            runText(run),
            timedOut
              ? `still ${run.status} after ${elapsedMs}ms; call cursor_wait_run again with the same ids`
              : `terminal after ${elapsedMs}ms`,
          ].join("\n"),
          structured: { ...runStructured(run), timedOut, polls, elapsedMs },
          policy,
        });
      };
      try {
        // Under the same bound as the polls: an uncached scope lookup must not
        // run to the client's own deadline. Aborted here there is no state to
        // answer with, so the cancellation error propagates.
        await scope.assert(args.agentId, { signal });
        for (;;) {
          let run: Run;
          try {
            run = await client.get(path, RunSchema, { signal });
          } catch (error) {
            // Our own deadline, not the caller's: answer with the last state
            // seen rather than an error the model would read as failure.
            if (boundHit() && last !== undefined) return finish(last, true);
            throw error;
          }
          last = run;
          polls += 1;
          if (isTerminal(run.status)) return finish(run, false);
          // The next poll would land at or past the bound, so stop here.
          if (hooks.now() - started + interval >= waitMs) return finish(run, true);
          // Reported only once this call has decided to keep waiting: a poll that
          // returns the result immediately needs no notification about it.
          progress?.report(
            `waiting for a terminal run status: ${polls} poll${polls === 1 ? "" : "s"}, ` +
              `${Math.round((hooks.now() - started) / 1000)}s of ${Math.round(waitMs / 1000)}s elapsed`,
          );
          try {
            await pause(interval, signal, hooks.sleep);
          } catch (error) {
            if (boundHit()) return finish(run, true);
            throw error;
          }
        }
      } finally {
        clearTimeout(boundTimer);
      }
    },
  });

  define({
    name: "cursor_get_usage",
    config: {
      title: "Cursor: get usage",
      description:
        "Report an agent's token usage, totalled and broken down per run. Pass runId to scope it to one run.",
      inputSchema: {
        agentId: AgentId,
        runId: RunIdArg.optional(),
        detail: z.boolean().optional().describe("Include token components for cost reconciliation."),
      },
      outputSchema: {
        totalTokens: z.number(),
        rawCostCents: z.number().optional(),
        usage: TokenUsageSchema.optional(),
        chargedCents: z.number().optional(),
        runs: z.array(
          z.object({
            id: z.string(),
            totalTokens: z.number(),
            rawCostCents: z.number().optional(),
            usage: TokenUsageSchema.optional(),
            chargedCents: z.number().optional(),
          }),
        ),
      },
      annotations: READ,
    },
    handler: async (args: { agentId: string; runId?: string; detail?: boolean }) => {
      await scope.assert(args.agentId);
      const path = `/v1/agents/${seg(args.agentId)}/usage`;
      const payload = await client.get(path, UsageSchema, {
        query: { runId: args.runId },
      });
      // Keep the default compact. Detailed token counts support weighted cost
      // reconciliation; raw and charged costs remain distinct and optional.
      return ok({
        source: `GET ${path}`,
        text: [
          usageLine("total", payload.totalUsage, payload.cost),
          ...payload.runs.map((r) => usageLine(r.id, r.usage, r.cost)),
        ].join("\n"),
        structured: {
          totalTokens: payload.totalUsage.totalTokens,
          ...(args.detail ? { usage: payload.totalUsage } : {}),
          ...(payload.cost?.rawCostCents === undefined ? {} : { rawCostCents: payload.cost.rawCostCents }),
          ...(payload.cost?.chargedCents === undefined
            ? {}
            : { chargedCents: payload.cost.chargedCents }),
          runs: payload.runs.map((r) => ({
            id: r.id,
            totalTokens: r.usage.totalTokens,
            ...(args.detail ? { usage: r.usage } : {}),
            ...(r.cost?.rawCostCents === undefined ? {} : { rawCostCents: r.cost.rawCostCents }),
            ...(r.cost?.chargedCents === undefined
              ? {}
              : { chargedCents: r.cost.chargedCents }),
          })),
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_create_agent",
    config: {
      title: "Cursor: launch agent",
      description:
        "Launch a cloud agent; no target defaults to a no-repository VM for launch-enabled profiles. Explicit repos or environments retain their policy checks.",
      inputSchema: {
        repo: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Repository as owner/name or a GitHub URL. For work in the current project, resolve that project's Git remote using your host workspace context and pass it here; no repository registration is needed in account mode. Ask only if the task target is ambiguous. Mutually exclusive with repos and environment.",
          ),
        repos: z
          .array(LaunchRepoInput)
          .max(20)
          .optional()
          .describe("Multiple repositories. Mutually exclusive with repo and environment."),
        environment: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Named cloud environment. Mutually exclusive with repo and repos; grants its secrets and network policy.",
          ),
        noRepository: z.boolean().optional().describe("No-repository launch; inferred when all target/source options are absent. Allowed by default for launch-enabled profiles; allowNoRepository:false opts out. False requires a target. Does not prove a clean filesystem; true conflicts with target/source options."),
        prompt: z.string().min(1).describe("The task for the agent."),
        model: ModelInputSchema.optional().describe("Model id or selection with params from cursor_get_workspace_control models detail. Omit for the profile/account default."),
        startingRef: z
          .string()
          .min(1)
          .optional()
          .describe(
            "Branch or commit for `repo`. Not honored with environment or with `repos`.",
          ),
        prUrl: PrUrlArg.optional().describe(
          "Existing pull request on `repo` for the agent to work on. Not honored with environment or with `repos`.",
        ),
        agentId: z
          .string()
          .regex(CLIENT_AGENT_ID, "agentId must be bc-<uuid>")
          .optional()
          .describe(
            "Your own bc-<uuid>. Pass one whenever you might retry this call: replaying it returns 409 agent_id_conflict instead of a second agent. When omitted one is minted per call, which protects nothing across retries.",
          ),
        workOnCurrentBranch: z
          .boolean()
          .optional()
          .describe("Push to startingRef instead of a new cursor/ branch. Requires startingRef."),
        metadata: z
          .record(z.string().min(1), z.string())
          .optional()
          .describe("Caller tags persisted on the agent. Echoed only when read back."),
        name: z.string().min(1).max(100).optional(),
        autoCreatePR: z.boolean().optional(),
        mode: z.enum(["agent", "plan"]).optional(),
      },
      outputSchema: {
        agentId: z.string(),
        runId: z.string(),
        status: z.string(),
        url: z.string(),
        agentStatus: z.string(),
        followUp: FollowUpSchema,
        repos: z.array(z.string()),
        repoDetails: z.array(RepoDetail),
        targetVerified: z.boolean().describe("Requested target matched; not image cleanliness."),
        environmentVerified: z.boolean(),
        modelRequested: ModelInputSchema.optional(),
        requestedAgentId: z.string(),
        agentIdHonored: z.boolean(),
        startingRefs: z.array(
          z.object({ repoUrl: z.string(), startingRef: z.string() }),
        ),
        sourcePinned: z.boolean().optional(),
        environment: z.string().optional(),
        workOnCurrentBranch: z.boolean().optional(),
        metadata: z.record(z.string(), z.string()).optional(),
        metadataVerified: z.boolean().optional(),
      },
      annotations: CREATE,
    },
    handler: async (args: {
      noRepository?: boolean;
      repo?: string;
      repos?: Array<{ url: string; startingRef?: string; prUrl?: string }>;
      environment?: string;
      prompt: string;
      model?: ModelInput;
      startingRef?: string;
      prUrl?: string;
      agentId?: string;
      workOnCurrentBranch?: boolean;
      metadata?: Record<string, string>;
      name?: string;
      autoCreatePR?: boolean;
      mode?: "agent" | "plan";
    }) => {
      const launch = resolveCreateAgentLaunch(profile, args);
      const autoCreatePR = resolveAutoCreatePR(profile, args.autoCreatePR);
      const model = resolveModel(profile, args.model);
      const metadata =
        args.metadata === undefined || Object.keys(args.metadata).length === 0
          ? undefined
          : args.metadata;
      // Always sent, so the id is known before the request rather than only in
      // a response that may never arrive. Only a CALLER-supplied id makes a
      // retried tool call safe: a fresh mint per call is, by construction, a new
      // agent on every retry. The description says so; this code does not
      // pretend otherwise.
      const agentId = (args.agentId ?? `bc-${randomUUID()}`).toLowerCase();

      const created = await withUsageGuidance(() =>
        client.post("/v1/agents", CreateAgentResponseSchema, {
          body: {
            agentId,
            prompt: { text: args.prompt },
            autoCreatePR,
            ...(launch.kind === "environment"
              ? { env: { type: "cloud" as const, name: launch.name } }
              : launch.kind === "no-repository" ? {} : {
                  repos: launch.repos,
                  ...(launch.workOnCurrentBranch === undefined
                    ? {}
                    : { workOnCurrentBranch: launch.workOnCurrentBranch }),
                }),
            ...(model === undefined ? {} : { model: modelSelection(model) }),
            ...(args.name === undefined ? {} : { name: args.name }),
            ...(args.mode === undefined ? {} : { mode: args.mode }),
            ...(metadata === undefined ? {} : { metadata }),
          },
        }),
      );

      createdRuns.add(runKey(created.agent.id, created.run.id));
      const environment = created.agent.env?.name?.trim();
      const startingRefs = (created.agent.repos ?? []).flatMap((repo) =>
        repo.startingRef === undefined
          ? []
          : [{ repoUrl: repo.url, startingRef: repo.startingRef }],
      );
      const requestedRefs =
        launch.kind === "repository"
          ? launch.repos.filter(
              (repo): repo is Required<LaunchRepo> => repo.startingRef !== undefined,
            )
          : [];
      const sourcePinned =
        requestedRefs.length === 0
          ? undefined
          : requestedRefs.every((requested) =>
              startingRefs.some(
                (reported) =>
                  repoKey(reported.repoUrl) === repoKey(requested.url) &&
                  reported.startingRef === requested.startingRef,
              ),
            );
      // Cursor honoring the client id is what makes a replay of a caller-supplied
      // id a 409 instead of a second agent. When the readback id differs the
      // launch still happened, so it is reported as-is with
      // `agentIdHonored: false` rather than cancelled.
      const agentIdHonored = created.agent.id.toLowerCase() === agentId;
      try {
        assertLaunchReadback(launch, created.agent);
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
          throw new PolicyError(
            `agent ${created.agent.id} run ${created.run.id} is outside this profile after launch: ${error.message}; ${suffix}`,
          );
        }
        if (error instanceof CursorContractError) {
          throw new CursorContractError(`agent ${created.agent.id} run ${created.run.id}: ${error.message}; ${suffix}`);
        }
        throw error;
      }
      const metadataVerified =
        metadata === undefined
          ? undefined
          : Object.entries(metadata).every(
              ([key, value]) => created.agent.metadata?.[key] === value,
            );
      return ok({
        source: "POST /v1/agents",
        text: [
          `agent=${created.agent.id} run=${created.run.id} status=${created.run.status}`,
          created.agent.url,
          ...(!environment ? ["Environment unknown in launch readback; image cleanliness is unverified."] : []),
          ...(agentIdHonored
            ? []
            : [
                `requested agentId ${agentId} was not honored; replaying it would not be refused as a duplicate`,
              ]),
          ...(metadataVerified === false
            ? ["metadata was requested but not confirmed by readback"]
            : []),
          ...(sourcePinned === false
            ? ["source pinning was requested but not confirmed by readback"]
            : []),
        ].join("\n"),
        structured: {
          agentId: created.agent.id,
          runId: created.run.id,
          status: created.run.status,
          url: created.agent.url,
          agentStatus: created.agent.status,
          followUp: followUpAcceptance(created.agent.status),
          repos: (created.agent.repos ?? []).map((repo) => repo.url),
          repoDetails: repoDetails(created.agent),
          targetVerified: true,
          environmentVerified: Boolean(environment),
          ...(model === undefined ? {} : { modelRequested: model }),
          requestedAgentId: agentId,
          agentIdHonored,
          startingRefs,
          ...(sourcePinned === undefined ? {} : { sourcePinned }),
          ...(environment ? { environment } : {}),
          ...(created.agent.workOnCurrentBranch === undefined
            ? {}
            : { workOnCurrentBranch: created.agent.workOnCurrentBranch }),
          ...(created.agent.metadata === undefined
            ? {}
            : { metadata: created.agent.metadata }),
          ...(metadataVerified === undefined ? {} : { metadataVerified }),
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_create_run",
    config: {
      title: "Cursor: follow up",
      description:
        "Send a follow-up prompt to an existing agent, reusing its workspace. Fails with agent_busy if a run is active.",
      inputSchema: {
        agentId: AgentId,
        prompt: z.string().min(1),
        model: ModelInputSchema.optional().describe("Explicit selection; a profile pin is applied on every run. SDK-derived REST field; modelRequested is not execution proof."),
        mode: z.enum(["agent", "plan"]).optional(),
      },
      outputSchema: { runId: z.string(), status: z.string(), modelRequested: ModelInputSchema.optional() },
      annotations: CREATE,
    },
    handler: async (args: {
      agentId: string;
      prompt: string;
      model?: ModelInput;
      mode?: "agent" | "plan";
    }) => {
      const model = resolveModel(profile, args.model);
      await scope.assert(args.agentId);
      const created = await withUsageGuidance(() =>
        client.post(
          `/v1/agents/${seg(args.agentId)}/runs`,
          CreateRunResponseSchema,
          {
            body: {
              prompt: { text: args.prompt },
              ...(model === undefined ? {} : { model: modelSelection(model) }),
              ...(args.mode === undefined ? {} : { mode: args.mode }),
            },
          },
        ),
      );
      createdRuns.add(runKey(args.agentId, created.run.id));
      return ok({
        source: `POST /v1/agents/${args.agentId}/runs`,
        text: `run=${created.run.id} status=${created.run.status}`,
        structured: { runId: created.run.id, status: created.run.status, ...(model === undefined ? {} : { modelRequested: model }) },
        policy,
      });
    },
  });

  define({
    name: "cursor_cancel_run",
    config: {
      title: "Cursor: cancel run",
      description:
        "Request that an in-progress run stop. Asynchronous: confirm with cursor_get_run. Pushed work stays.",
      inputSchema: { agentId: AgentId, runId: RunIdArg },
      outputSchema: { runId: z.string() },
      annotations: CANCEL,
    },
    handler: async (args: { agentId: string; runId: string }) => {
      if (!createdRuns.has(runKey(args.agentId, args.runId))) {
        await scope.assert(args.agentId);
      }
      const path = `/v1/agents/${seg(args.agentId)}/runs/${seg(args.runId)}/cancel`;
      const cancelled = await client.post(path, IdResponseSchema);
      return ok({
        source: `POST ${path}`,
        // "requested", not "cancelled". A 200 here does not mean the run
        // stopped: one run took a 200 and then reached FINISHED anyway.
        text: `cancel requested for ${cancelled.id}`,
        structured: { runId: cancelled.id },
        policy,
      });
    },
  });

  return registered;
}

/** One attached repository with what Cursor reported about it. */
const RepoDetail = z.object({
  url: z.string(),
  startingRef: z.string().optional(),
  prUrl: z.string().optional(),
});

interface RepoDetailOut {
  url: string;
  startingRef?: string;
  prUrl?: string;
}

function repoDetails(agent: Agent): RepoDetailOut[] {
  return (agent.repos ?? []).map((repo) => ({
    url: repo.url,
    ...(repo.startingRef === undefined ? {} : { startingRef: repo.startingRef }),
    ...(repo.prUrl === undefined ? {} : { prUrl: repo.prUrl }),
  }));
}

/**
 * The structured shape of a run, shared by get and wait.
 *
 * The final reply is deliberately absent. It is free text written by the agent
 * from repository and PR content, so it travels only inside the fenced `content`
 * block; `structuredContent` carries its size so a caller can tell "no reply yet"
 * from "an empty reply" without a second unfenced copy of the text.
 */
const RUN_OUT = {
  id: z.string(),
  status: z.string(),
  terminal: z.boolean(),
  durationMs: z.number().optional(),
  resultBytes: z.number().int().optional(),
  branches: z.array(
    z.object({
      repoUrl: z.string(),
      branch: z.string().optional(),
      prUrl: z.string().optional(),
    }),
  ),
};

function runStructured(run: Run): {
  id: string;
  status: string;
  terminal: boolean;
  durationMs?: number;
  resultBytes?: number;
  branches: Array<{ repoUrl: string; branch?: string; prUrl?: string }>;
} {
  // `git` is per-agent state, not per-run: the same snapshot comes back on
  // every run of the agent. Reported as-is rather than attributed.
  //
  // A branch entry is not proof that work landed. A cancelled run reported
  // `cursor/...-f07f` for a branch that never reached the remote (verified:
  // git ls-remote found nothing). Cursor names the branch when it allocates
  // it, not when it pushes. Only `prUrl` implies something was pushed.
  const branches = (run.git?.branches ?? []).map((b) => ({
    repoUrl: b.repoUrl,
    ...(b.branch === undefined ? {} : { branch: b.branch }),
    ...(b.prUrl === undefined ? {} : { prUrl: b.prUrl }),
  }));
  return {
    id: run.id,
    status: run.status,
    terminal: isTerminal(run.status),
    branches,
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(run.result === undefined
      ? {}
      : { resultBytes: Buffer.byteLength(run.result, "utf8") }),
  };
}

/**
 * The batch read's per-item vocabulary.
 *
 * Five outcomes, because four of them are not the fifth: a denial is a policy
 * answer, an unresolved item is the absence of one, a request error is upstream,
 * and notAttempted work was never asked about at all. Collapsing any pair of them
 * would let a caller monitoring a campaign read "no PR" off an item nobody read.
 *
 * The code is a stable machine token this server chooses. Cursor's own words for
 * a failure travel in the fenced text instead, never in a structured field.
 */
const BATCH_OUTCOMES = ["read", "denied", "unresolved", "error", "notAttempted"] as const;
const BATCH_CODES = [
  "POLICY_DENIED",
  "SCOPE_UNRESOLVED",
  "SCOPE_LOOKUP_FAILED",
  "IDENTITY_MISMATCH",
  "HTTP_ERROR",
  "TRANSPORT_ERROR",
  "CONTRACT_ERROR",
  "TOOL_ERROR",
  "NOT_ATTEMPTED",
] as const;

type BatchCode = (typeof BATCH_CODES)[number];
type BatchStop = "time-limit" | "output-limit";
interface BatchPair {
  agentId: string;
  runId: string;
}

const BATCH_OUT = {
  requested: z.number().int(),
  /** Items this response decided. Never counts notAttempted work. */
  checked: z.number().int(),
  /** Upstream GETs spent: one per distinct agent judged, one per distinct pair. */
  upstreamReads: z.number().int(),
  /** False whenever any requested index is still undecided. */
  complete: z.boolean(),
  fromIndex: z.number().int().optional(),
  stoppedBy: z.enum(["time-limit", "output-limit"]).optional(),
  remaining: z.object({
    fromIndex: z.number().int(),
    count: z.number().int(),
    indices: z.string(),
  }).optional(),
  items: z.array(
    z.object({
      index: z.number().int(),
      agentId: z.string(),
      runId: z.string(),
      outcome: z.enum(BATCH_OUTCOMES),
      code: z.enum(BATCH_CODES).optional(),
      status: z.string().optional(),
      terminal: z.boolean().optional(),
      durationMs: z.number().optional(),
      httpStatus: z.number().int().optional(),
      prUrls: z.array(z.string()).optional(),
      /** Reported without its PR list and diagnostic, for want of budget. */
      compact: z.boolean().optional(),
    }),
  ),
};

interface BatchDecision {
  outcome: (typeof BATCH_OUTCOMES)[number];
  code?: BatchCode;
  status?: string;
  terminal?: boolean;
  durationMs?: number;
  httpStatus?: number;
  prUrls?: string[];
  compact?: boolean;
  /** Cursor-authored diagnostic. Fenced text only, never structured output. */
  detail?: string;
}

interface BatchEntry extends Omit<BatchDecision, "detail"> {
  index: number;
  agentId: string;
  runId: string;
}

/**
 * One read run, compactly.
 *
 * `git` is agent-level state Cursor reports alongside the run, so a `prUrls`
 * entry says the agent has that PR, not that this run opened it -- and its
 * absence is not evidence no PR exists. `repos[].prUrl` is the PR a launch
 * *asked* for and is deliberately not read here: reporting a requested PR as a
 * produced one is the confusion this field would create at 64 items a time.
 *
 * The final reply is absent by design, as in `cursor_get_run`: this is a status
 * batch, not a transcript.
 */
function readDecision(run: Run): BatchDecision {
  const prUrls = (run.git?.branches ?? []).flatMap((branch) =>
    branch.prUrl === undefined ? [] : [branch.prUrl],
  );
  return {
    outcome: "read",
    status: capBytes(sanitize(run.status), MAX_BATCH_STATUS_BYTES).text,
    terminal: isTerminal(run.status),
    ...(run.durationMs === undefined ? {} : { durationMs: run.durationMs }),
    ...(prUrls.length === 0 ? {} : { prUrls }),
  };
}

function batchErrorDecision(error: unknown): BatchDecision {
  const detail = capBytes(
    sanitize(error instanceof Error ? error.message : String(error)),
    MAX_ITEM_DETAIL_BYTES,
  ).text;
  if (error instanceof CursorApiError) {
    return { outcome: "error", code: "HTTP_ERROR", httpStatus: error.status, detail };
  }
  if (error instanceof CursorTransportError) {
    return { outcome: "error", code: "TRANSPORT_ERROR", detail };
  }
  if (error instanceof CursorContractError) {
    return { outcome: "error", code: "CONTRACT_ERROR", detail };
  }
  return { outcome: "error", code: "TOOL_ERROR", detail };
}

/**
 * The same answer with the wide parts removed, and saying so.
 *
 * `compact` exists because dropping `prUrls` quietly would turn a budget
 * shortfall into "this run reported no PR", which is a different claim about the
 * work than the one the read supports.
 */
function batchCompact(decision: BatchDecision): BatchDecision {
  const { detail: _detail, prUrls: _prUrls, ...rest } = decision;
  return { ...rest, compact: true };
}

function batchEntry(index: number, pair: BatchPair, decision: BatchDecision): BatchEntry {
  const { detail: _detail, ...rest } = decision;
  return { index, agentId: pair.agentId, runId: pair.runId, ...rest };
}

function batchLine(index: number, pair: BatchPair, decision: BatchDecision): string {
  const parts = [`[${index}]`, pair.agentId, pair.runId];
  parts.push(
    decision.outcome === "read"
      ? (decision.status ?? "(no status)")
      : `${decision.outcome} ${decision.code ?? ""}`.trim(),
  );
  if (decision.httpStatus !== undefined) parts.push(`http=${decision.httpStatus}`);
  if (decision.durationMs !== undefined) {
    parts.push(`${Math.round(decision.durationMs / 1000)}s`);
  }
  for (const url of decision.prUrls ?? []) parts.push(`pr=${url}`);
  if (decision.compact === true) parts.push("(compact: pr list and diagnostic omitted)");
  if (decision.detail !== undefined) parts.push(`-- ${decision.detail}`);
  return parts.join("  ");
}

/**
 * What admitting one item costs, structured payload and fenced line together.
 *
 * Charged against one budget so neither half of the result can exceed
 * `maxResponseBytes` on its own. That halves the usable width, which is the
 * right trade: the alternative is two budgets that each look satisfied while the
 * text quietly loses the lines explaining the structured entries.
 */
function batchCost(index: number, pair: BatchPair, decision: BatchDecision): number {
  return (
    structuredCost([batchEntry(index, pair, decision)]) +
    Buffer.byteLength(batchLine(index, pair, decision), "utf8") +
    1
  );
}

/**
 * The widest a double prints as, in JSON and in `String`, at 24 bytes.
 *
 * A double carries at most 17 significant digits, so every form -- sign, point,
 * exponent -- fits inside `-1.7976931348623157e+308`. Reserving that much for
 * each number means a duration or an HTTP status this side never saw cannot
 * overflow a reservation made before the read.
 */
const WIDEST_NUMBER = -Number.MAX_VALUE;

/**
 * What one item is guaranteed to cost at its most compact, before it is read.
 *
 * Admission used to be tested only after the upstream GET, against the size of
 * the answer that came back. A boundary item then paid for a successful read
 * that no longer fit, was dropped, and the continuation read it again at the
 * same index. So the budget is reserved first, against an upper bound over
 * *every* compact shape: the longest outcome and code, a capped status, and the
 * widest number in each numeric field. No real compact entry can exceed it, so
 * a read that happens is a read that can be reported.
 */
function batchReservation(index: number, pair: BatchPair): number {
  return batchCost(index, pair, {
    outcome: "notAttempted",
    code: "SCOPE_LOOKUP_FAILED",
    status: "s".repeat(MAX_BATCH_STATUS_BYTES),
    terminal: true,
    durationMs: WIDEST_NUMBER,
    httpStatus: WIDEST_NUMBER,
    compact: true,
  });
}

function indexRange(first: number, last: number): string {
  return first === last ? `${first}` : `${first}-${last}`;
}

/** The lines that say what was covered, what was not, and how to continue. */
function batchFooter(args: {
  checked: number;
  requested: number;
  from: number;
  remaining: { fromIndex: number; count: number; indices: string } | undefined;
  stoppedBy: BatchStop | undefined;
  maxResponseBytes: number;
}): string[] {
  const { checked, requested, from, remaining, stoppedBy, maxResponseBytes } = args;
  const lines = [
    `checked ${checked} of ${requested}${from === 0 ? "" : ` (from index ${from})`}`,
  ];
  if (remaining !== undefined) {
    lines.push(
      `incomplete: ${remaining.count} item${remaining.count === 1 ? "" : "s"} at ${remaining.indices} not decided` +
        (stoppedBy === "time-limit"
          ? `, stopped by the ${MAX_BATCH_MS / 1000}s bound`
          : `, stopped by the ${maxResponseBytes}-byte response budget`) +
        `; call cursor_inspect_runs again with the same runs and fromIndex=${remaining.fromIndex}`,
    );
  }
  lines.push(
    "pr= is agent-level git state reported with the run, not proof that run opened it; no pr= is not proof none exists",
  );
  return lines;
}

function runText(run: Run): string {
  return [runLine(run), run.result ?? "(no result yet)"].join("\n");
}

function inspectAgent(agent: Agent): {
  id: string;
  status: string;
  followUp: FollowUpAcceptance;
  url: string;
  repos: string[];
  repoDetails: RepoDetailOut[];
  name?: string;
  latestRunId?: string;
  environment?: string;
  workOnCurrentBranch?: boolean;
  autoCreatePR?: boolean;
  metadata?: Record<string, string>;
} {
  const environment = agent.env?.name?.trim();
  return {
    id: agent.id,
    status: agent.status,
    followUp: followUpAcceptance(agent.status),
    url: agent.url,
    repos: (agent.repos ?? []).map((repo) => repo.url),
    repoDetails: repoDetails(agent),
    ...(agent.name === undefined ? {} : { name: agent.name }),
    ...(agent.latestRunId === undefined ? {} : { latestRunId: agent.latestRunId }),
    ...(environment ? { environment } : {}),
    ...(agent.workOnCurrentBranch === undefined
      ? {}
      : { workOnCurrentBranch: agent.workOnCurrentBranch }),
    ...(agent.autoCreatePR === undefined ? {} : { autoCreatePR: agent.autoCreatePR }),
    ...(agent.metadata === undefined ? {} : { metadata: agent.metadata }),
  };
}

/**
 * Confirm Cursor honored the requested target. Source pinning and named
 * environment selection are claimed only when readback shows they applied.
 */
function assertLaunchReadback(
  launch: ResolvedCreateAgentLaunch,
  agent: Agent,
): void {
  if (launch.kind === "no-repository") {
    if (agent.repos === undefined || agent.repos.length !== 0 || agent.env?.name?.trim() ||
        (agent.env?.type !== undefined && agent.env.type !== "cloud")) {
      throw new CursorContractError("no-repository launch did not read back empty repositories and an unnamed cloud environment");
    }
    return;
  }
  if (launch.kind === "environment") {
    const name = agent.env?.name?.trim();
    if (name === undefined || name === "") {
      throw new CursorContractError(
        `agent ${agent.id} did not read back the named environment; attached secrets cannot be verified`,
      );
    }
    if (name !== launch.name) {
      throw new CursorContractError(
        `agent ${agent.id} read back environment ${name}, not ${launch.name}`,
      );
    }
    if (agent.env?.type !== undefined && agent.env.type !== "cloud") {
      throw new CursorContractError(
        `agent ${agent.id} read back environment type ${agent.env.type}, not cloud`,
      );
    }
    return;
  }

  const reported = agent.repos ?? [];
  let requestedKeys: string[];
  let reportedKeys: string[];
  try {
    requestedKeys = launch.repos.map((repo) => repoKey(repo.url)).sort();
    reportedKeys = reported.map((repo) => repoKey(repo.url)).sort();
  } catch (error) {
    throw new CursorContractError(
      `agent ${agent.id} returned invalid repository readback: ${String(error)}`,
    );
  }
  if (
    requestedKeys.length !== reportedKeys.length ||
    requestedKeys.some((key, index) => key !== reportedKeys[index])
  ) {
    throw new CursorContractError(
      `agent ${agent.id} did not read back the exact requested repository set`,
    );
  }

  // A requested pull request must come back on the same repository. Unlike a
  // startingRef, which is reported as unconfirmed, a dropped or different PR
  // means the agent would push somewhere other than where it was pointed, so
  // the launch is failed (and cancelled by the caller) rather than reported.
  for (const requested of launch.repos) {
    if (requested.prUrl === undefined) continue;
    const key = repoKey(requested.url);
    const readBack = reported.find((repo) => repoKey(repo.url) === key)?.prUrl;
    if (readBack === undefined || readBack.toLowerCase() !== requested.prUrl.toLowerCase()) {
      throw new CursorContractError(
        `agent ${agent.id} did not read back prUrl ${requested.prUrl} on ${key}` +
          `${readBack === undefined ? "" : ` (reported ${readBack})`}; the pull request target is not confirmed`,
      );
    }
  }

  if (launch.workOnCurrentBranch === true && agent.workOnCurrentBranch !== true) {
    throw new CursorContractError(
      `agent ${agent.id} did not read back workOnCurrentBranch=true; source pinning is not claimed`,
    );
  }
}
