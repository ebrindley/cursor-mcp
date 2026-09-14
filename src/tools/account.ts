/**
 * Workspace Controls: identity, models, connected repositories, and the Cloud
 * Agent settings that actually affect a launch.
 *
 * This is the workspace/account slice of the public surface in
 * `docs/lifecycle-architecture.md`. Tool names stay stable if an internal
 * integration changes. Descriptions are one line -- they are resident in the
 * client's context on every request. Workflow guidance belongs in the README.
 *
 * Supported reads hit the published API-key surface (`GET /v1/me`,
 * `/v1/models`, `/v1/repositories`). Defaults, network, secret *names*, MCP
 * policy, and team follow-up have no proven non-browser contract, so they stay
 * addressable as capability results rather than nonfunctional tools. Writes are
 * gated by the existing tool allowlist plus `confirm: true`. Secret values are
 * never accepted, returned, or logged.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CursorClient } from "../client.js";
import type { Policy } from "../config.js";
import { activeProfile } from "../config.js";
import { CursorApiError, PolicyError } from "../errors.js";
import {
  MeSchema,
  ModelsSchema,
  ModelEntrySchema,
  type Models,
  RepositoriesSchema,
  modelIds,
  modelLines,
} from "../schemas.js";
import {
  WORKSPACE_CONTROL_IDS,
  WORKSPACE_GET_TOOL,
  WORKSPACE_INSPECT_TOOL,
  WORKSPACE_LIST_TOOL,
  capabilityResult,
  controlResultText,
  inspectWorkspaceText,
  isPlanGatedCode,
  listWorkspaceControls,
  planGatedResult,
  projectEntitlement,
  redactSecretFields,
  supportedIdentityResult,
  supportedModelsResult,
  supportedReposResult,
  workspaceControlSurface,
  type WorkspaceControlId,
  type WorkspaceControlKind,
  type WorkspaceControlResult,
  type WorkspaceControlStatus,
} from "../workspace-controls.js";
import { READ } from "./annotations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

/** Returns the tools actually registered, which the profile decides. */
export function registerAccountTools(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
): string[] {
  const profile = activeProfile(policy);
  const registered: string[] = [];

  const define = <C extends GateableConfig, A extends unknown[]>(
    spec: ToolSpec<C, A>,
  ) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  define({
    name: "cursor_whoami",
    config: {
      title: "Cursor: whoami",
      description:
        "Verify the Cursor API key and return its name, creation date, and owning email.",
      // No inputSchema: it advertises the same empty-object contract, but also
      // accepts a call that omits `arguments` entirely, which some clients do.
      outputSchema: {
        apiKeyName: z.string().optional(),
        createdAt: z.string().optional(),
        userEmail: z.string().optional(),
      },
      annotations: READ,
    },
    handler: async () => {
      const me = await client.get("/v1/me", MeSchema);
      return ok({
        source: "GET /v1/me",
        text: `key=${me.apiKeyName ?? "(unnamed)"} email=${me.userEmail ?? "(unknown)"}`,
        structured: {
          ...(me.apiKeyName === undefined ? {} : { apiKeyName: me.apiKeyName }),
          ...(me.createdAt === undefined ? {} : { createdAt: me.createdAt }),
          ...(me.userEmail === undefined ? {} : { userEmail: me.userEmail }),
        },
        policy,
      });
    },
  });

  define({
    name: "cursor_list_models",
    config: {
      title: "Cursor: list models",
      description:
        "List model ids accepted when launching a cloud agent. Omit the model to use the account default.",
      outputSchema: { models: z.array(z.string()) },
      annotations: READ,
    },
    handler: async () => {
      const payload = await client.get("/v1/models", ModelsSchema);
      const models = modelIds(payload);
      return ok({
        source: "GET /v1/models",
        text: modelLines(payload).join("\n") || "(no models returned)",
        structured: { models },
        policy,
      });
    },
  });

  define({
    name: "cursor_list_repos",
    config: {
      title: "Cursor: list repositories",
      description:
        "List GitHub repositories Cursor can launch an agent against. Rate limited to one call per minute.",
      outputSchema: { repos: z.array(z.string()) },
      annotations: READ,
    },
    handler: async () => {
      const payload = await client.get("/v1/repositories", RepositoriesSchema);
      const repos = payload.items.map((r) => r.url);
      return ok({
        source: "GET /v1/repositories",
        text: repos.join("\n") || "(no repositories connected)",
        structured: { repos },
        policy,
      });
    },
  });

  const ControlId = z.enum([...WORKSPACE_CONTROL_IDS]);
  const StatusFilter = z.enum([
    "supported",
    "unsupported",
    "unavailable-on-plan",
    "unverified",
  ]);
  const KindFilter = z.enum(["read", "write"]);
  const CapabilityBlock = z.object({
    id: z.string(),
    kind: z.string(),
    status: z.string(),
    authority: z.string(),
    evidence: z.string(),
    tool: z.string(),
    reason: z.string(),
    requiredReadback: z.string(),
    nextSteps: z.array(z.string()),
  });
  const ResultOut = {
    status: z.string(),
    action: z.string().optional(),
    id: z.string().optional(),
    control: z.string().optional(),
    kind: z.string().optional(),
    authority: z.string().optional(),
    evidence: z.string().optional(),
    tool: z.string().optional(),
    reason: z.string().optional(),
    requiredReadback: z.string().optional(),
    nextSteps: z.array(z.string()).optional(),
    entitlement: z
      .object({
        kind: z.string(),
        apiKeyName: z.string().optional(),
        createdAt: z.string().optional(),
        userEmail: z.string().optional(),
        userId: z.number().optional(),
      })
      .optional(),
    models: z.array(z.string()).optional(),
    details: z.array(ModelEntrySchema).optional(),
    repos: z.array(z.string()).optional(),
  };

  define({
    name: WORKSPACE_LIST_TOOL,
    config: {
      title: "Cursor: list workspace controls",
      description:
        "List Cloud Agent workspace and account controls and whether each is supported, unverified, unsupported, or unavailable.",
      inputSchema: {
        status: StatusFilter.optional().describe(
          "Keep controls whose read or write reports this status.",
        ),
        kind: KindFilter.optional().describe("Keep only reads or only writes."),
      },
      outputSchema: {
        controls: z.array(
          z.object({
            id: z.string(),
            read: CapabilityBlock,
            write: CapabilityBlock.optional(),
          }),
        ),
      },
      annotations: READ,
    },
    handler: async (call: {
      status?: WorkspaceControlStatus;
      kind?: WorkspaceControlKind;
    }) => {
      const controls = listWorkspaceControls({
        ...(call.status === undefined ? {} : { status: call.status }),
        ...(call.kind === undefined ? {} : { kind: call.kind }),
      });
      return ok({
        source: "workspace-controls catalog",
        text:
          controls
            .map((surface) => {
              const write =
                surface.write === undefined
                  ? "read-only"
                  : `write=${surface.write.status}`;
              return `${surface.id}  read=${surface.read.status}  ${write}`;
            })
            .join("\n") || "(no controls matched)",
        structured: { controls },
        policy,
      });
    },
  });

  define({
    name: WORKSPACE_INSPECT_TOOL,
    config: {
      title: "Cursor: inspect workspace",
      description:
        "Inspect API-key identity, entitlement, and the workspace-control surface. Does not list repositories.",
      outputSchema: {
        entitlement: z
          .object({
            kind: z.string(),
            apiKeyName: z.string().optional(),
            createdAt: z.string().optional(),
            userEmail: z.string().optional(),
            userId: z.number().optional(),
          })
          .optional(),
        controls: z
          .array(
            z.object({
              id: z.string(),
              read: CapabilityBlock,
              write: CapabilityBlock.optional(),
            }),
          )
          .optional(),
        status: z.string().optional(),
        action: z.string().optional(),
        id: z.string().optional(),
        control: z.string().optional(),
        kind: z.string().optional(),
        authority: z.string().optional(),
        evidence: z.string().optional(),
        tool: z.string().optional(),
        reason: z.string().optional(),
        requiredReadback: z.string().optional(),
        nextSteps: z.array(z.string()).optional(),
      },
      annotations: READ,
    },
    handler: async () => {
      try {
        const me = await client.get("/v1/me", MeSchema);
        const entitlement = projectEntitlement(me);
        return ok({
          source: "GET /v1/me",
          text: inspectWorkspaceText(entitlement),
          structured: {
            entitlement,
            controls: listWorkspaceControls(),
          },
          policy,
        });
      } catch (error) {
        const code = error instanceof CursorApiError ? error.code : undefined;
        if (error instanceof CursorApiError && isPlanGatedCode(code) && code !== undefined) {
          const residual = planGatedResult(
            workspaceControlSurface("identity").read,
            code,
          );
          return ok({
            source: "GET /v1/me",
            text: controlResultText(residual),
            structured: {
              ...residual,
              controls: listWorkspaceControls(),
            },
            policy,
          });
        }
        throw error;
      }
    },
  });

  define({
    name: WORKSPACE_GET_TOOL,
    config: {
      title: "Cursor: get workspace control",
      description:
        "Read one workspace or account control. Supported controls fetch live; others return a capability result.",
      inputSchema: {
        control: ControlId.describe("Workspace or account control to read."),
        detail: z.boolean().optional().describe("For models, include supported parameters and variants."),
      },
      outputSchema: ResultOut,
      annotations: READ,
    },
    handler: async (call: { control: WorkspaceControlId; detail?: boolean }) => {
      const result = await readWorkspaceControl(client, call.control, call.detail);
      const { details, ...controlResult } = result;
      // Model parameter values are public catalog data, not workspace secrets.
      const structured = { ...redactSecretFields(controlResult), ...(details === undefined ? {} : { details }) };
      return ok({
        source:
          result.status === "supported"
            ? supportedSource(call.control)
            : "workspace-controls catalog",
        text: controlResultText(structured),
        structured: { ...structured },
        policy,
      });
    },
  });

  return registered;
}

function supportedSource(control: WorkspaceControlId): string {
  switch (control) {
    case "identity":
      return "GET /v1/me";
    case "models":
      return "GET /v1/models";
    case "repositories":
      return "GET /v1/repositories";
    default:
      return "workspace-controls catalog";
  }
}


async function readWorkspaceControl(
  client: CursorClient,
  control: WorkspaceControlId,
  detail = false,
): Promise<WorkspaceControlResult & { details?: Models["items"] }> {
  const surface = workspaceControlSurface(control);
  if (control === "identity" || control === "models" || control === "repositories") {
    try {
      if (control === "identity") {
        const me = await client.get("/v1/me", MeSchema);
        return supportedIdentityResult(me);
      }
      if (control === "models") {
        const payload = await client.get("/v1/models", ModelsSchema);
        return { ...supportedModelsResult(modelIds(payload)), ...(detail ? { details: payload.items } : {}) };
      }
      const payload = await client.get("/v1/repositories", RepositoriesSchema);
      return supportedReposResult(payload.items.map((repo) => repo.url));
    } catch (error) {
      const code = error instanceof CursorApiError ? error.code : undefined;
      if (error instanceof CursorApiError && isPlanGatedCode(code) && code !== undefined) {
        return planGatedResult(surface.read, code);
      }
      throw error;
    }
  }
  return capabilityResult(surface.read);
}
