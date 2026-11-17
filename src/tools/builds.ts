import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { CursorCancelledError, seg, type CursorClient } from "../client.js";
import { requestScope, withWaitScope } from "../request-context.js";
import { within, sleep, WaitStoppedError } from "../wait.js";
import { activeProfile, type Policy } from "../config.js";
import { resolveEnvironmentTarget } from "../environment-api.js";
import { PolicyError, CursorTransportError } from "../errors.js";
import { buildOutcome, isTerminalBuild } from "../environment-operations.js";
import { defineTool } from "./register.js";
import { READ } from "./annotations.js";
import { sanitize } from "../untrusted.js";
import { fitsStructuredResponse, ok } from "./result.js";

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
// Metadata on public Build rows that downstream tools accept alongside their
// own required evidence. Keep their row inputs strict so misspellings fail.
export const buildReadbackMetadata = {
  outcome: z.string().optional(),
  terminal: z.boolean().optional(),
  trust: z.literal("api-key").optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  completedAt: z.string().optional(),
  durationMs: z.number().nonnegative().optional(),
  failure: BuildSchema.shape.failure,
  compact: z.literal(true).optional(),
  triggerType: z.string().min(1).optional(),
  failureType: z.string().min(1).nullable().optional(),
  createdAtMs: z.number().int().nonnegative().optional(),
  completedAtMs: z.number().int().nonnegative().optional(),
};

const Block = z.record(z.string(), z.unknown());
const Id = z.string().trim().min(1).max(200);
const Target = { environment: Id.optional(), environmentPublicId: Id.optional() };
type TargetArgs = { environment?: string; environmentPublicId?: string };

// Upstream cursors stay opaque. Only a split page needs a local position and a
// fingerprint of the result set, so an intervening insertion cannot shift it.
const CURSOR_PREFIX = "cursor-mcp:builds:";
const UpstreamCursor = z.string().min(1).max(512);
const Slice = z.tuple([UpstreamCursor.nullable(), z.number().int().nonnegative(), z.string()]);

function buildCursor(upstream: string | undefined, offset: number, fingerprint: string): string {
  return CURSOR_PREFIX + Buffer.from(JSON.stringify([upstream ?? null, offset, fingerprint])).toString("base64url");
}

function readBuildCursor(input?: string): z.infer<typeof Slice> {
  if (input?.startsWith(CURSOR_PREFIX)) {
    try {
      return Slice.parse(JSON.parse(Buffer.from(input.slice(CURSOR_PREFIX.length), "base64url").toString()));
    } catch { /* An existing caller may have a plain upstream token with this prefix. */ }
  }
  return [UpstreamCursor.nullable().parse(input ?? null), 0, ""];
}

export function registerBuildReadTools(server: McpServer, client: CursorClient, policy: Policy): string[] {
  const profile = activeProfile(policy), names: string[] = [];
  const target = (args: TargetArgs) => resolveEnvironmentTarget(client, profile, args);
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
      inputSchema: { ...Target, cursor: z.string().min(1).max(4096).optional(), statuses: z.array(z.string()).optional() },
      outputSchema: { status: z.string(), authority: z.string(), builds: z.array(Block), page: Block, nextCursor: z.string().optional() },
      annotations: READ,
    },
    handler: async (args: TargetArgs & { cursor?: string; statuses?: string[] }) => {
      const environment = await target(args);
      const [upstream, offset, expectedPage] = readBuildCursor(args.cursor);
      const page = await client.get(`/v1/environments/${seg(environment.id)}/builds`, BuildPageSchema, { query: { cursor: upstream ?? undefined } });
      const builds = page.items.map(b => view(b, environment.id)).filter(b => !args.statuses?.length || args.statuses.includes(b.status));
      const fingerprint = createHash("sha256").update(JSON.stringify([
        environment.id, builds.map(row => row.buildId),
      ])).digest("base64url");
      if (offset && (expectedPage !== fingerprint || offset >= builds.length)) {
        throw new Error("The Build page changed since the previous read. Restart cursor_list_builds without a cursor.");
      }

      const upstreamNext = page.nextCursor && UpstreamCursor.parse(page.nextCursor);
      const next = upstreamNext && (upstreamNext.startsWith(CURSOR_PREFIX) || sanitize(upstreamNext) !== upstreamNext)
        ? buildCursor(upstreamNext, 0, "") : upstreamNext;
      type BuildRow = { buildId: string; status: string; [field: string]: unknown };
      const resultPage = (rows: BuildRow[], nextCursor?: string) => ({
        status: "BUILDS_LISTED", authority: "api-key", builds: rows,
        page: { hasMore: Boolean(nextCursor), returned: rows.length }, ...(nextCursor ? { nextCursor } : {}),
      });
      let structured = resultPage(builds.slice(offset), next);
      if (!fitsStructuredResponse(structured, policy.maxResponseBytes)) {
        const rows: BuildRow[] = [];
        for (let index = offset; index < builds.length; index++) {
          const row = builds[index]!;
          const continuation = index + 1 === builds.length ? next : buildCursor(upstream ?? undefined, index + 1, fingerprint);
          let candidate = resultPage([...rows, row], continuation);
          if (!fitsStructuredResponse(candidate, policy.maxResponseBytes)) {
            if (rows.length) break;
            // A single unusually wide row still has an exact-detail lookup.
            const { buildId, environmentPublicId, status, isDraft, triggerType, createdAtMs, completedAtMs } = row;
            candidate = resultPage([{ buildId, environmentPublicId, status, isDraft, triggerType,
              ...(createdAtMs === undefined ? {} : { createdAtMs }),
              ...(completedAtMs === undefined ? {} : { completedAtMs }), compact: true }], continuation);
            if (!fitsStructuredResponse(candidate, policy.maxResponseBytes)) break;
          }
          structured = candidate;
          rows.push(candidate.builds[candidate.builds.length - 1]!);
        }
        if (!rows.length) throw new Error("maxResponseBytes cannot hold the Build identity and continuation. Increase maxResponseBytes and retry the same cursor.");
      }
      return ok({ source: "GET /v1/environments/{id}/builds", policy,
        text: structured.builds.map(b => `${b.buildId}  ${b.status}`).join("\n") || "(no matching Builds on this page)",
        structured,
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
