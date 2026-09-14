/**
 * Artifacts: the only way work leaves a cloud VM other than a branch or a PR.
 *
 * Three facts shape this module:
 *
 *   - Artifacts are agent-scoped, not run-scoped. The workspace persists across
 *     runs, so there is no run id in either path.
 *   - Code changes do not appear here. They land on the run's branch. This holds
 *     what the agent deliberately saved -- a log, a diff, a screenshot.
 *   - The directory is the VM's workspace artifacts directory, `/opt/cursor/
 *     artifacts` (a symlink to `/cursor/stores/<agentId>/artifacts`), and NOT a
 *     directory called `artifacts` in the checked-out repository. Verified by
 *     writing to both: the repository one lists nothing at all. Returned paths
 *     keep the `artifacts/` prefix and are what `cursor_get_artifact_url` wants
 *     back, unchanged.
 *
 * Download is deliberately two steps, matching the API: this server hands back the
 * presigned URL and stops. It does not fetch the bytes. Fetching them would mean a
 * second transport path to a different origin, with a content type we do not know
 * and a size the API does not tell us in advance -- and the existing client
 * refuses any off-origin request precisely so the Authorization header cannot
 * follow an API-supplied URL somewhere else. The caller downloads it.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentScope } from "../agent-scope.js";
import type { CursorClient } from "../client.js";
import { seg } from "../client.js";
import type { Policy } from "../config.js";
import { activeProfile } from "../config.js";
import { ArtifactListSchema, ArtifactUrlSchema, artifactLine } from "../schemas.js";
import { READ } from "./annotations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

const AgentId = z.string().min(1).max(128).describe("Agent id, in `bc-<uuid>` form.");

export function registerArtifactTools(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
  scope = new AgentScope(client, activeProfile(policy)),
): string[] {
  const profile = activeProfile(policy);
  const registered: string[] = [];

  const define = <C extends GateableConfig, A extends unknown[]>(
    spec: ToolSpec<C, A>,
  ) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  define({
    name: "cursor_list_artifacts",
    config: {
      title: "Cursor: list artifacts",
      description:
        "List files an agent saved to its workspace artifacts directory. Code changes land on the branch, not here.",
      inputSchema: { agentId: AgentId },
      outputSchema: {
        artifacts: z.array(
          z.object({
            path: z.string(),
            sizeBytes: z.number().optional(),
            updatedAt: z.string().optional(),
          }),
        ),
      },
      annotations: READ,
    },
    handler: async (args: { agentId: string }) => {
      await scope.assert(args.agentId);
      const path = `/v1/agents/${seg(args.agentId)}/artifacts`;
      const payload = await client.get(path, ArtifactListSchema);
      return ok({
        source: `GET ${path}`,
        text: payload.items.map(artifactLine).join("\n") || "(no artifacts)",
        structured: {
          artifacts: payload.items.map((a) => ({
            path: a.path,
            ...(a.sizeBytes === undefined ? {} : { sizeBytes: a.sizeBytes }),
            ...(a.updatedAt === undefined ? {} : { updatedAt: a.updatedAt }),
          })),
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_get_artifact_url",
    config: {
      title: "Cursor: get artifact download URL",
      description:
        "Mint a 15-minute presigned download URL for one artifact path from cursor_list_artifacts.",
      inputSchema: {
        agentId: AgentId,
        // Passed through as the API returned it. The relative form is the only one
        // v1 accepts, and this server does not rewrite it: a path it reconstructed
        // would be a path the caller cannot check against the listing.
        path: z
          .string()
          .min(1)
          .describe("Artifact path exactly as cursor_list_artifacts returned it."),
      },
      outputSchema: { url: z.string(), expiresAt: z.string().optional() },
      // A read: it mints a credential but changes nothing. The URL is itself a
      // bearer credential for that one object, which the description says so a
      // caller does not paste it somewhere durable.
      annotations: READ,
    },
    handler: async (args: { agentId: string; path: string }) => {
      await scope.assert(args.agentId);
      const route = `/v1/agents/${seg(args.agentId)}/artifacts/download`;
      const payload = await client.get(route, ArtifactUrlSchema, {
        // In the query string, not the path, so URLSearchParams does the encoding
        // and a path containing `/` or `..` cannot escape the route. Whether it
        // resolves inside `artifacts/` is the API's rule to enforce, and it does.
        query: { path: args.path },
      });
      return ok({
        source: `GET ${route}`,
        text: [
          payload.url,
          `expires=${payload.expiresAt ?? "(unstated; treat as 15 minutes)"}`,
        ].join("\n"),
        structured: {
          url: payload.url,
          ...(payload.expiresAt === undefined
            ? {}
            : { expiresAt: payload.expiresAt }),
        },
        policy,
      });
    },
  });

  return registered;
}
