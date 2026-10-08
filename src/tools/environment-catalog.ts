/** Saved-environment discovery, configuration digests, and history through REST. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { seg, type CursorClient } from "../client.js";
import { activeProfile, type Policy } from "../config.js";
import { EnvironmentListSchema, EnvironmentHistorySchema, readEnvironment, environmentEntry, configurationRead } from "../environment-api.js";
import { READ } from "./annotations.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

export const ENVIRONMENT_LIST_TOOL = "cursor_list_environments";
export const ENVIRONMENT_CONFIGURATION_TOOL = "cursor_get_environment_configuration";
export const ENVIRONMENT_HISTORY_TOOL = "cursor_list_environment_history";
const Block = z.record(z.string(), z.unknown());
const PublicId = z.string().trim().min(1).max(200).regex(/^[A-Za-z0-9_.:-]+$/);
const Cursor = z.string().min(1).max(512).optional();

export function registerEnvironmentCatalogTools(server: McpServer, client: CursorClient, policy: Policy): string[] {
  const profile = activeProfile(policy);
  const names: string[] = [];
  if (defineTool(server, policy, profile, {
    name: ENVIRONMENT_LIST_TOOL,
    config: {
      title: "Cursor Cloud: list environments",
      description: "List saved environments through the public API. Follow nextCursor; visibility checks and concurrent updates can make the catalog incomplete.",
      inputSchema: { scope: z.enum(["personal", "team"]).optional(), cursor: Cursor, limit: z.number().int().min(1).max(100).default(20) },
      outputSchema: { status: z.string(), authority: z.string(), environments: z.array(Block), catalog: Block, nextCursor: z.string().optional() },
      annotations: READ,
    },
    handler: async (args: { scope?: string; cursor?: string; limit: number }) => {
      const page = await client.get("/v1/environments", EnvironmentListSchema, { query: { limit: args.limit, cursor: args.cursor } });
      const environments = page.items.filter(e => args.scope === undefined || e.owner === args.scope).map(e => environmentEntry(e, profile));
      return ok({ source: "GET /v1/environments", policy,
        text: environments.map(e => `${e.name ?? "(unnamed)"}  ${e.environmentPublicId}  ${e.scope}`).join("\n") || "(no matching environments on this page)",
        structured: { status: "LISTED", authority: "api-key", environments,
          catalog: { source: "api", complete: false, returned: environments.length, reported: page.items.length },
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) },
      });
    },
  })) names.push(ENVIRONMENT_LIST_TOOL);
  if (defineTool(server, policy, profile, {
    name: ENVIRONMENT_CONFIGURATION_TOOL,
    config: {
      title: "Cursor Cloud: get environment configuration",
      description: "Read saved environment configuration as classified digests through the public API. Enforces environment and repository grants; scripts are omitted.",
      inputSchema: { environmentPublicId: PublicId },
      outputSchema: { status: z.string(), authority: z.string(), configuration: Block, versionId: z.string().optional() },
      annotations: READ,
    },
    handler: async (args: { environmentPublicId: string }) => {
      const environment = await readEnvironment(client, profile, args.environmentPublicId);
      const configuration = configurationRead(environment);
      return ok({ source: "GET /v1/environments/{id}", policy,
        text: `Configuration ${configuration.classification}: ${configuration.digest ?? "unavailable"}`,
        structured: { status: "READ", authority: "api-key", configuration,
          ...(environment.versionId ? { versionId: environment.versionId } : {}) },
      });
    },
  })) names.push(ENVIRONMENT_CONFIGURATION_TOOL);
  if (defineTool(server, policy, profile, {
    name: ENVIRONMENT_HISTORY_TOOL,
    config: {
      title: "Cursor Cloud: environment history",
      description: "Read a page of environment history through the public API. Saved configurations are represented by digests. Follow nextCursor.",
      inputSchema: { environmentPublicId: PublicId, cursor: Cursor, limit: z.number().int().min(1).max(100).default(20) },
      outputSchema: { status: z.string(), authority: z.string(), environmentPublicId: z.string(), events: z.array(Block), nextCursor: z.string().optional() },
      annotations: READ,
    },
    handler: async (args: { environmentPublicId: string; cursor?: string; limit: number }) => {
      const environment = await readEnvironment(client, profile, args.environmentPublicId);
      const page = await client.get(`/v1/environments/${seg(environment.id)}/history`, EnvironmentHistorySchema, { query: { limit: args.limit, cursor: args.cursor } });
      const events = page.items.map(({ environmentJson, ...event }) => ({
        ...event,
        ...(environmentJson === undefined ? {} : { configuration: configurationRead({ id: environment.id, environmentJson }) }),
      }));
      return ok({ source: "GET /v1/environments/{id}/history", policy,
        text: events.map(e => `${e.createdAt}  ${e.kind}  ${e.title}`).join("\n") || "(no history on this page)",
        structured: { status: "READ", authority: "api-key", environmentPublicId: environment.id, events,
          ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}) },
      });
    },
  })) names.push(ENVIRONMENT_HISTORY_TOOL);
  return names;
}
