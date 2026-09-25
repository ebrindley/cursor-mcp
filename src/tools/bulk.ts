/**
 * Bulk archive/unarchive jobs: start, status, cancel.
 *
 * Start returns at once; the job runs in this process at the pace set by the
 * policy `bulk` block (see `src/bulk-job.ts`). Start and cancel are gated like
 * any mutating tool; status is a read. Pacing settings grant nothing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentScope } from "../agent-scope.js";
import { BulkJobs, type BulkItem, type BulkJob, type Clock, realClock } from "../bulk-job.js";
import type { CursorClient } from "../client.js";
import { currentRequestSignal } from "../client.js";
import type { Policy } from "../config.js";
import { activeProfile, bulkSettings } from "../config.js";
import { CANCEL, READ } from "./annotations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok, structuredCost } from "./result.js";

const ITEM_STATES = [
  "pending",
  "inFlight",
  "retrying",
  "done",
  "denied",
  "unresolved",
  "failed",
  "uncertain",
  "notSubmitted",
] as const;

/** Starting a job: not idempotent (a second start is refused while one runs). */
const START = CANCEL;
const MAX_WAIT_S = 40;
const MAX_PAGE = 200;
const DEFAULT_PAGE = 50;

const JobId = z.string().regex(/^bulk-[0-9a-f-]{36}$/).describe("Job id from cursor_start_bulk_job.");

function itemLine(item: BulkItem): string {
  return [item.agentId, item.state, item.code, item.httpStatus]
    .filter((part) => part !== undefined)
    .join(" ");
}

function summaryLine(job: BulkJob): string {
  const s = job.snapshot();
  const counts = Object.entries(s.counts)
    .filter(([, n]) => n > 0)
    .map(([state, n]) => `${state}=${n}`)
    .join(" ");
  return (
    `${s.jobId} ${s.action} ${s.state}${s.stopReason ? ` (${s.stopReason})` : ""}: ` +
    `${counts || "no agents"} of ${s.total}`
  );
}

export function registerBulkTools(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
  scope: Pick<AgentScope, "classify">,
  clock: Clock = realClock,
): string[] {
  const profile = activeProfile(policy);
  const settings = bulkSettings(policy);
  const jobs = new BulkJobs(client, scope, settings, clock);
  const registered: string[] = [];
  const define = <C extends GateableConfig, A extends unknown[]>(spec: ToolSpec<C, A>) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  /** One page of items, shrunk until the whole result fits the response budget. */
  const view = (job: BulkJob, offset: number, limit: number, state?: string) => {
    const matching = state === undefined ? job.items : job.items.filter((i) => i.state === state);
    let size = limit;
    for (;;) {
      const page = matching.slice(offset, offset + size);
      const next = offset + page.length < matching.length ? offset + page.length : undefined;
      const structured = {
        ...job.snapshot(),
        items: page,
        matching: matching.length,
        ...(next === undefined ? {} : { nextOffset: next }),
      };
      if (size <= 1 || structuredCost(structured) <= policy.maxResponseBytes) {
        return ok({
          source: `bulk job ${job.jobId}`,
          text: [summaryLine(job), ...page.map(itemLine), ...(next === undefined ? [] : [`(more: nextOffset=${next})`])].join("\n"),
          structured,
          policy,
        });
      }
      size = Math.max(1, Math.floor(size / 2));
    }
  };

  const lookup = (jobId: string): BulkJob => {
    const job = jobs.get(jobId);
    if (job === undefined) {
      throw new Error(`no bulk job ${jobId} in this server; jobs do not survive a restart`);
    }
    return job;
  };

  define({
    name: "cursor_start_bulk_job",
    config: {
      title: "Cursor: start bulk archive/unarchive",
      description:
        `Archive or unarchive up to ${settings.maxAgents} agents in the background, paced under Cursor's rate limits. Returns a job id at once; read progress with cursor_get_bulk_job.`,
      inputSchema: {
        action: z.enum(["archive", "unarchive"]),
        agentIds: z
          .array(z.string().min(1).max(128))
          .min(1)
          .max(settings.maxAgents)
          .describe("Exact agent ids (bc-<uuid>). Repeats are processed once."),
      },
      annotations: START,
    },
    handler: async (args: { action: "archive" | "unarchive"; agentIds: string[] }) => {
      const job = jobs.start(args.action, args.agentIds);
      return view(job, 0, 0);
    },
  });

  define({
    name: "cursor_get_bulk_job",
    config: {
      title: "Cursor: bulk job status",
      description:
        "Status and per-agent results of a bulk job. waitSeconds returns early when the job finishes.",
      inputSchema: {
        jobId: JobId,
        waitSeconds: z.number().int().min(0).max(MAX_WAIT_S).optional()
          .describe(`Wait up to this long (max ${MAX_WAIT_S}s) for the job to finish first.`),
        state: z.enum(ITEM_STATES).optional().describe("Only items in this state."),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(0).max(MAX_PAGE).optional()
          .describe(`Items per page (default ${DEFAULT_PAGE}; 0 for counts only).`),
      },
      annotations: READ,
    },
    handler: async (args: {
      jobId: string;
      waitSeconds?: number;
      state?: (typeof ITEM_STATES)[number];
      offset?: number;
      limit?: number;
    }) => {
      const job = lookup(args.jobId);
      if (!job.finished && (args.waitSeconds ?? 0) > 0) {
        const signal = currentRequestSignal();
        await Promise.race([job.done, clock.sleep(args.waitSeconds! * 1000, signal)]);
      }
      return view(job, args.offset ?? 0, args.limit ?? DEFAULT_PAGE, args.state);
    },
  });

  define({
    name: "cursor_cancel_bulk_job",
    config: {
      title: "Cursor: cancel bulk job",
      description:
        "Stop starting new agents. Requests already sent finish; completed changes are not reverted.",
      inputSchema: { jobId: JobId },
      annotations: CANCEL,
    },
    handler: async (args: { jobId: string }) => {
      const job = lookup(args.jobId);
      job.cancel();
      return view(job, 0, 0);
    },
  });

  if (registered.length > 0) {
    const onclose = server.server.onclose;
    server.server.onclose = () => {
      jobs.close();
      onclose?.();
    };
  }
  return registered;
}
