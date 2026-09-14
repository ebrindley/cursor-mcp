/**
 * Agent Lifecycle record operations: archive, unarchive, delete.
 *
 * Environment Operations (Build trigger, activate, rollback, Save) are a
 * different public domain -- see `docs/lifecycle-architecture.md`. They must not
 * land in this module: archive is not rollback, and delete is not environment
 * teardown.
 *
 * Archive is list hygiene, not a capacity-control operation. Use it to hide
 * finished agents from lists; do not treat it as freeing a concurrency slot.
 *
 * Delete is separate and opt-in: it needs `deleteEnabled` in the policy file, and
 * `defineTool` enforces that from the `destructiveHint` annotation, so a profile
 * with `tools: ["*"]` still does not get it. Build promotion has no current
 * executable authority; `activationEnabled` is reserved and gates no current
 * tool. Granting deletion does not grant promotion.
 *
 * Every lifecycle operation resolves the agent's repositories and named
 * environment through the shared session cache before mutating it. Agents created
 * outside this server therefore receive the same allowlists as newly launched
 * agents. Selecting an environment is a secrets-and-egress grant, not VM routing.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { AgentScope } from "../agent-scope.js";
import type { CursorClient } from "../client.js";
import { seg } from "../client.js";
import type { Policy } from "../config.js";
import { activeProfile } from "../config.js";
import { PolicyError } from "../errors.js";
import { IdResponseSchema } from "../schemas.js";
import { DESTRUCTIVE, REVERSIBLE } from "./annotations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

const AgentId = z.string().min(1).max(128).describe("Agent id, in `bc-<uuid>` form.");
const ConfirmArg = z
  .boolean()
  .optional()
  .describe("Must be true. Deletion is irreversible and is refused without it.");

export function registerLifecycleTools(
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

  /** All three endpoints take an agent id and return `{ id }`. */
  const idTool = (args: {
    name: string;
    title: string;
    description: string;
    annotations: NonNullable<GateableConfig["annotations"]>;
    call: (agentId: string) => Promise<{ source: string; id: string }>;
    verb: string;
    /** Refuse the call unless `confirm: true` was passed. */
    requireConfirm?: boolean;
  }) =>
    define({
      name: args.name,
      config: {
        title: args.title,
        description: args.description,
        inputSchema: args.requireConfirm
          ? { agentId: AgentId, confirm: ConfirmArg }
          : { agentId: AgentId },
        outputSchema: { agentId: z.string() },
        annotations: args.annotations,
      },
      handler: async (call: { agentId: string; confirm?: boolean }) => {
        // Checked before the scope lookup so a refused call costs no request.
        if (args.requireConfirm && call.confirm !== true) {
          throw new PolicyError(
            `${args.name} requires confirm: true; it permanently removes the agent and its run history`,
          );
        }
        await scope.assert(call.agentId);
        const { source, id } = await args.call(call.agentId);
        return ok({
          source,
          text: `${args.verb} ${id}`,
          structured: { agentId: id },
          policy,
        });
      },
    });

  idTool({
    name: "cursor_archive_agent",
    title: "Cursor: archive agent",
    description:
      "Archive an agent to hide it from the default list. Reversible; its runs and artifacts are kept.",
    annotations: REVERSIBLE,
    verb: "archived",
    call: async (agentId) => {
      const path = `/v1/agents/${seg(agentId)}/archive`;
      const { id } = await client.post(path, IdResponseSchema);
      return { source: `POST ${path}`, id };
    },
  });

  idTool({
    name: "cursor_unarchive_agent",
    title: "Cursor: unarchive agent",
    description:
      "Unarchive an agent so it shows in the default list again.",
    annotations: REVERSIBLE,
    verb: "unarchived",
    call: async (agentId) => {
      const path = `/v1/agents/${seg(agentId)}/unarchive`;
      const { id } = await client.post(path, IdResponseSchema);
      return { source: `POST ${path}`, id };
    },
  });

  idTool({
    name: "cursor_delete_agent",
    title: "Cursor: delete agent permanently",
    description:
      "Permanently delete an agent and its run history. Irreversible, requires confirm: true, and no substitute for archive.",
    annotations: DESTRUCTIVE,
    verb: "deleted",
    requireConfirm: true,
    call: async (agentId) => {
      const path = `/v1/agents/${seg(agentId)}`;
      const { id } = await client.delete(path, IdResponseSchema);
      return { source: `DELETE ${path}`, id };
    },
  });

  return registered;
}
