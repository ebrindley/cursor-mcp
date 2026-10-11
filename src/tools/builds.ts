import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CursorCancelledError, seg, type CursorClient } from "../client.js";
import { requestScope, withWaitScope } from "../request-context.js";
import { within, sleep, WaitStoppedError } from "../wait.js";
import { activeProfile, type Policy } from "../config.js";
import { EnvironmentListSchema, readEnvironment } from "../environment-api.js";
import { PolicyError, CursorTransportError } from "../errors.js";
import { resolveEnvironmentBinding } from "../policy.js";
import { buildOutcome, isTerminalBuild } from "../environment-operations.js";
import { defineTool } from "./register.js";
import { READ } from "./annotations.js";
import { ok } from "./result.js";

const BuildSchema = z.object({
  id: z.string(), environmentId: z.string(), status: z.string(), trigger: z.string(),
  draft: z.boolean(), createdAt: z.string(), updatedAt: z.string(), completedAt: z.string().optional(),
  failure: z.object({ type: z.string(), code: z.string().optional() }).optional(),
});
const BuildPageSchema = z.object({ items: z.array(BuildSchema), nextCursor: z.string().min(1).optional() });
const ActiveSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("build"), buildId: z.string().min(1) }),
  z.object({ type: z.literal("universal_image") }),
]);
const Block = z.record(z.string(), z.unknown());
const Id = z.string().trim().min(1).max(200);
const Target = { environment: Id.optional(), environmentPublicId: Id.optional() };
type TargetArgs = { environment?: string; environmentPublicId?: string };

export function registerBuildReadTools(server: McpServer, client: CursorClient, policy: Policy): string[] {
  const profile = activeProfile(policy), names: string[] = [];
  const target = async (args: TargetArgs) => {
    const binding = args.environment ? resolveEnvironmentBinding(profile, args.environment) : undefined;
    let id = args.environmentPublicId ?? binding?.publicId;
    if (!id && !args.environment) throw new PolicyError("pass environmentPublicId or an allowed environment name");
    if (!id) {
      // A name can exist in more than one ownership scope. Never choose the first match.
      const matches = new Set<string>(); let cursor: string | undefined;
      for (let page = 0; page < 10; page++) {
        const listed = await client.get("/v1/environments", EnvironmentListSchema, { query: { limit: 100, cursor } });
        for (const e of listed.items) if (e.name === args.environment && (!binding?.scope || binding.scope === e.owner)) matches.add(e.id);
        cursor = listed.nextCursor;
        if (!cursor) break;
      }
      if (cursor || matches.size !== 1) throw new PolicyError("environment name is unresolved or ambiguous; pass environmentPublicId");
      id = [...matches][0]!;
    }
    if (binding?.publicId && id !== binding.publicId) throw new PolicyError("environmentPublicId does not match the profile binding");
    const environment = await readEnvironment(client, profile, id);
    if (args.environment && environment.name !== undefined && environment.name !== args.environment)
      throw new PolicyError("environment response name does not match the requested environment");
    return environment;
  };
  const view = (build: z.infer<typeof BuildSchema>, id: string) => {
    if (build.environmentId !== id) throw new PolicyError("Build belongs to a different environment");
    const createdAtMs = Date.parse(build.createdAt);
    const completedAtMs = build.completedAt ? Date.parse(build.completedAt) : NaN;
    return { buildId: build.id, environmentPublicId: id, environmentPublicIdSource: "row",
      observedAtMs: Date.now(),
      status: build.status, outcome: buildOutcome(build.status), terminal: isTerminalBuild(build.status),
      triggerType: build.trigger, isDraft: build.draft, createdAt: build.createdAt, updatedAt: build.updatedAt,
      ...(Number.isFinite(createdAtMs) ? { createdAtMs } : {}),
      ...(Number.isFinite(completedAtMs) ? { completedAtMs } : {}),
      ...(Number.isFinite(createdAtMs) && Number.isFinite(completedAtMs) && completedAtMs >= createdAtMs
        ? { durationMs: completedAtMs - createdAtMs } : {}),
      ...(build.completedAt ? { completedAt: build.completedAt } : {}),
      ...(build.failure ? { failure: build.failure, failureType: build.failure.type } : {}), trust: "api-key" };
  };
  if (defineTool(server, policy, profile, {
    name: "cursor_list_builds",
    config: {
      title: "Cursor Cloud: list Builds",
      description: "Read environment Builds through the public API. Follow nextCursor, including on filtered empty pages. No agent run is launched.",
      inputSchema: { ...Target, cursor: z.string().min(1).max(512).optional(), statuses: z.array(z.string()).optional() },
      outputSchema: { status: z.string(), authority: z.string(), builds: z.array(Block), page: Block, nextCursor: z.string().optional() },
      annotations: READ,
    },
    handler: async (args: TargetArgs & { cursor?: string; statuses?: string[] }) => {
      const environment = await target(args);
      const page = await client.get(`/v1/environments/${seg(environment.id)}/builds`, BuildPageSchema, { query: { cursor: args.cursor } });
      const builds = page.items.map(b => view(b, environment.id)).filter(b => !args.statuses?.length || args.statuses.includes(b.status));
      return ok({ source: "GET /v1/environments/{id}/builds", policy,
        text: builds.map(b => `${b.buildId}  ${b.status}`).join("\n") || "(no matching Builds on this page)",
        structured: { status: "BUILDS_LISTED", authority: "api-key", builds,
          page: { hasMore: Boolean(page.nextCursor), returned: builds.length },
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) },
      });
    },
  })) names.push("cursor_list_builds");
  if (defineTool(server, policy, profile, {
    name: "cursor_get_build",
    waitBudgetMs: null,
    config: {
      title: "Cursor Cloud: get Build",
      description: "Read an exact Build through the public API. Optional bounded monitoring stops at terminal status; success does not imply activation.",
      inputSchema: { ...Target, buildId: Id, previousStatus: z.string().optional(),
        monitorAttempts: z.number().int().min(1).max(10).default(1),
        monitorIntervalSeconds: z.number().int().min(1).max(30).default(5) },
      outputSchema: { status: z.string(), authority: z.string(), build: Block, monitor: Block },
      annotations: READ,
    },
    handler: async (args: TargetArgs & { buildId: string; previousStatus?: string; monitorAttempts: number; monitorIntervalSeconds: number }) => {
      const observation = requestScope(45_000), started = observation.clock.now();
      const signal = observation.signal;
      try { return await withWaitScope(observation, async () => {
        const environment = await within(observation, () => target(args));
        let attempts = 0;
        let build: ReturnType<typeof view> | undefined;
        for (; attempts < args.monitorAttempts;) {
          let row: z.infer<typeof BuildSchema>;
          try {
            row = await within(observation, () => client.get(`/v1/environments/${seg(environment.id)}/builds/${seg(args.buildId)}`, BuildSchema, { signal }));
          } catch (error) {
            if (error instanceof WaitStoppedError && error.reason === "deadline") {
              if (build) break;
              throw new CursorTransportError("Build read exceeded the 45000ms total deadline");
            }
            throw error;
          }
          if (row.id !== args.buildId) throw new PolicyError("Build response identifies a different Build");
          build = view(row, environment.id); attempts++;
          if (build.terminal || (args.previousStatus && isTerminalBuild(args.previousStatus)) || attempts >= args.monitorAttempts) break;
          try { await sleep(observation, args.monitorIntervalSeconds * 1000); }
          catch (error) { if (!(error instanceof WaitStoppedError) || error.reason !== "deadline") throw error; break; }
        }
        if (!build) throw new Error("Build was not read");
        const stale = args.previousStatus !== undefined && isTerminalBuild(args.previousStatus) && args.previousStatus !== build.status;
        const status = stale ? "READBACK_STALE" : build.terminal ? "TERMINAL" : "PENDING";
        return ok({ source: "GET /v1/environments/{id}/builds/{buildId}", policy,
          text: `${build.buildId}  ${build.status}; activation is reported separately.`,
          structured: { status, authority: "api-key", build, monitor: { status, outcome: build.outcome, terminal: build.terminal, attempts,
            elapsedMs: Math.round(observation.clock.now() - started), deadlineExceeded: observation.stopReason() === "deadline" } },
        });
      }); } catch (error) {
        if (error instanceof WaitStoppedError) {
          const detail = error.reason === "deadline" ? "reached its deadline before a Build status was observed" : error.reason === "shutdown" ? "stopped because the server shut down" : "was cancelled by the caller";
          const message = `Build observation ${detail}; no Build was cancelled. Retry cursor_get_build with the same target.`;
          throw error.reason === "deadline" ? new CursorTransportError(message) : new CursorCancelledError(message);
        }
        throw error;
      } finally { observation.dispose(); }
    },
  })) names.push("cursor_get_build");
  if (defineTool(server, policy, profile, {
    name: "cursor_get_active_build",
    config: {
      title: "Cursor Cloud: active Build",
      description: "Read the Build or default image used by new agents in an environment. Does not activate a Build or change existing agents.",
      inputSchema: Target,
      outputSchema: { status: z.string(), authority: z.string(), environmentPublicId: z.string(), activeBuild: Block },
      annotations: READ,
    },
    handler: async (args: TargetArgs) => {
      const environment = await target(args);
      const active = await client.get(`/v1/environments/${seg(environment.id)}/builds/active`, ActiveSchema);
      return ok({ source: "GET /v1/environments/{id}/builds/active", policy,
        text: active.type === "build" ? `Active Build: ${active.buildId}` : "New agents use the default image.",
        structured: { status: "READ", authority: "api-key", environmentPublicId: environment.id, activeBuild: { readable: true, ...active } },
      });
    },
  })) names.push("cursor_get_active_build");
  return names;
}
