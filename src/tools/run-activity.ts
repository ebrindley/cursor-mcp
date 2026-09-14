import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { AgentScope } from "../agent-scope.js";
import { currentRequestProgress, currentRequestSignal, CursorCancelledError, seg, type CursorClient } from "../client.js";
import { activeProfile, type Policy } from "../config.js";
import { RESUME_ID } from "../run-stream.js";
import { isTerminal, RunSchema } from "../schemas.js";
import { defineTool } from "./register.js";
import { READ } from "./annotations.js";
import { ok } from "./result.js";

export function registerRunActivityTool(server: McpServer, client: CursorClient, policy: Policy, scope: AgentScope): string[] {
  const registered = defineTool(server, policy, activeProfile(policy), {
    name: "cursor_tail_run",
    config: {
      title: "Cursor: recent run activity",
      description: "Read a bounded run activity excerpt. Pass lastEventId back to resume; without it Cursor replays from the beginning. Status is checked separately. Does not cancel the cloud run.",
      inputSchema: {
        agentId: z.string().min(1).max(128), runId: z.string().min(1).max(128),
        lastEventId: z.string().regex(RESUME_ID).optional(),
        durationMs: z.number().int().min(1).max(30_000).default(10_000),
      },
      outputSchema: {
        eventsRead: z.number(), bytesRead: z.number(), done: z.boolean(), truncated: z.boolean(),
        stopReason: z.string(), lastEventId: z.string().optional(), replayRequired: z.boolean(),
        statusVerified: z.boolean(), status: z.string().optional(), terminal: z.boolean().optional(),
      },
      annotations: READ,
    },
    handler: async (args: { agentId: string; runId: string; durationMs: number; lastEventId?: string }) => {
      // Includes scope resolution, streaming, and final REST status, not just the body read.
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 45_000);
      const caller = currentRequestSignal();
      const signal = caller ? AbortSignal.any([controller.signal, caller]) : controller.signal;
      // Counts only, at most once a second: a busy run delivers hundreds of
      // events in that time, and the excerpt itself is Cursor's text, which
      // belongs in the tool result and nowhere else.
      const progress = currentRequestProgress();
      const started = Date.now();
      const onCounts = ({ eventsRead, bytesRead }: { eventsRead: number; bytesRead: number }) =>
        progress?.report(
          `reading run activity: ${eventsRead} event${eventsRead === 1 ? "" : "s"}, ` +
            `${bytesRead} bytes, ${Math.round((Date.now() - started) / 1000)}s elapsed`,
          1_000,
        );
      try {
        await scope.assert(args.agentId, { signal });
        const path = `/v1/agents/${seg(args.agentId)}/runs/${seg(args.runId)}`;
        const tail = await client.tailRun(`${path}/stream`, {
          durationMs: args.durationMs, maxBytes: Math.max(128, policy.maxResponseBytes - 512),
          deadlineSignal: controller.signal,
          ...(caller === undefined ? {} : { signal: caller }),
          ...(args.lastEventId === undefined ? {} : { lastEventId: args.lastEventId }),
          ...(progress === undefined ? {} : { onCounts }),
        });
        let status: string | undefined;
        try {
          const run = await client.get(path, RunSchema, { signal });
          if (run.id === args.runId && run.agentId === args.agentId && run.status.length <= 128) status = run.status;
        } catch {
          // Activity can still be useful when REST is unavailable. Never turn
          // its stream status or done event into a terminal-state claim.
        }
        if (caller?.aborted) throw new CursorCancelledError("Run activity read cancelled; the cloud run was not cancelled");
        const { text, ...metadata } = tail;
        return ok({
          source: `run activity ${args.agentId}/${args.runId}`, policy,
          text: `${status === undefined ? "Run status unverified; use cursor_get_run." : `REST run status: ${status}.`}\n` +
            `Activity: ${tail.stopReason}; ${tail.truncated ? "incomplete or clipped excerpt" : "stream done"}.\n` +
            (tail.lastEventId ? "Pass lastEventId back to continue.\n" : "No resume cursor; another tail starts a replay.\n") + text,
          structured: { ...metadata, replayRequired: tail.lastEventId === undefined, statusVerified: status !== undefined,
            ...(status === undefined ? {} : { status, terminal: isTerminal(status) }) },
        });
      } finally { clearTimeout(timer); }
    },
  });
  return registered ? ["cursor_tail_run"] : [];
}
