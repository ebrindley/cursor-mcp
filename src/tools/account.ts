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
 * `/v1/models`, `/v1/repositories`, and the secret-name list endpoints).
 * Defaults, network, MCP policy, and team follow-up have no proven non-browser
 * contract, so they stay addressable as capability results rather than
 * nonfunctional tools. No write is performed. Secret values are never accepted,
 * returned, or logged.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CursorClient } from "../client.js";
import type { Policy, Profile } from "../config.js";
import { activeProfile } from "../config.js";
import { resolveEnvironmentTarget } from "../environment-api.js";
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
  SecretInventoryTooLargeError,
  readSecretInventory,
  type SecretInventory,
  type SecretInventoryScope,
  type SecretInventoryStop,
} from "../secret-inventory.js";
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
  secretInventoryRefusal,
  secretInventorySummary,
  workspaceAction,
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
import { ok, structuredCost } from "./result.js";

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
      title: "Cursor Cloud: whoami",
      description:
        "Verify the Cursor Cloud Agents API key and return its name, creation date, and owning email; this is not local CLI login status.",
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
      title: "Cursor Cloud: list models",
      description:
        "List model ids accepted by Cursor Cloud Agent launches, not the local Cursor CLI catalog. Omit the model to use the account default.",
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
      title: "Cursor Cloud: list repositories",
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
  const SecretScope = z.enum(["environment", "team", "account"]);
  const EnvName = z.string().trim().min(1).max(200);
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
    apiErrorCode: z.string().optional(),
    inventory: z
      .object({
        scope: z.string(),
        environmentPublicId: z.string().optional(),
        items: z.array(
          z.object({
            name: z.string(),
            type: z.string(),
            versionId: z.string().optional(),
            repos: z.array(z.string()),
            createdAt: z.string().optional(),
            owner: z.object({
              kind: z.string(),
              environmentPublicId: z.string().optional(),
              userEmail: z.string().nullable().optional(),
            }),
          }),
        ),
        returned: z.number(),
        pages: z.number(),
        complete: z.boolean(),
        resumed: z.boolean(),
        nextCursor: z.string().optional(),
        stoppedBecause: z.string().optional(),
        omitted: z.number().optional(),
      })
      .optional(),
  };

  define({
    name: WORKSPACE_LIST_TOOL,
    config: {
      title: "Cursor Cloud: list workspace controls",
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
      title: "Cursor Cloud: inspect workspace",
      description:
        "Inspect Cloud Agent API-key identity, entitlement, and workspace controls, not local CLI settings. Does not list repositories.",
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
      title: "Cursor Cloud: get workspace control",
      description:
        "Read a Cloud Agent account/workspace control, not local CLI settings. Supported controls fetch live; others return a capability result. Secrets: names only.",
      inputSchema: {
        control: ControlId.describe("Workspace or account control to read."),
        detail: z.boolean().optional().describe("For models, include supported parameters and variants."),
        scope: SecretScope.optional().describe(
          "For secrets: environment (needs environment or environmentPublicId), team, or account. Required; there is no default.",
        ),
        environment: EnvName.optional().describe(
          "For secrets with scope=environment: an environment name the active profile allows.",
        ),
        environmentPublicId: EnvName.optional().describe(
          "For secrets with scope=environment: the environment id.",
        ),
        allowAccountWide: z.boolean().optional().describe(
          "For secrets with scope=account: must be true. Account-wide listing can include other members' personal secret metadata for a team admin key.",
        ),
        cursor: z.string().min(1).max(512).optional().describe(
          "For secrets: a nextCursor from an earlier call that stopped early, with the same scope arguments.",
        ),
      },
      outputSchema: ResultOut,
      annotations: READ,
    },
    handler: async (call: SecretsCall & { control: WorkspaceControlId; detail?: boolean }) => {
      const result = await readWorkspaceControl(client, call.control, call.detail, {
        profile,
        maxResponseBytes: policy.maxResponseBytes,
        call,
      });
      const { details, ...controlResult } = result;
      // Model parameter values are public catalog data, not workspace secrets.
      const structured = { ...redactSecretFields(controlResult), ...(details === undefined ? {} : { details }) };
      return ok({
        source:
          result.status === "supported"
            ? supportedSource(call.control, result.inventory?.scope)
            : "workspace-controls catalog",
        text: controlResultText(structured),
        structured: { ...structured },
        policy,
      });
    },
  });

  return registered;
}

function supportedSource(
  control: WorkspaceControlId,
  secretScope?: SecretInventoryScope,
): string {
  switch (control) {
    case "secrets":
      if (secretScope === "environment") return "GET /v1/environments/{id}/secrets";
      if (secretScope === "team") return "GET /v1/team/secrets";
      if (secretScope === "account") return "GET /v1/secrets";
      return "workspace-controls catalog";
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


const SECRET_INVENTORY_STOPS: readonly SecretInventoryStop[] = [
  "page_cap",
  "time_budget",
  "size_budget",
  "cursor_repeat",
  "interrupted",
];

/**
 * What to return when maxResponseBytes cannot hold even an empty inventory.
 * Deliberately bare so it stays schema-valid at small budgets: no inventory, no
 * guidance lists, one sentence.
 */
function secretsTooSmallResult(
  read: ReturnType<typeof workspaceControlSurface>["read"],
  maxResponseBytes: number,
): WorkspaceControlResult {
  return {
    id: read.id,
    kind: read.kind,
    status: read.status,
    authority: read.authority,
    evidence: read.evidence,
    tool: read.tool,
    reason: `No secrets returned: maxResponseBytes (${maxResponseBytes}) is too small for this read; raise it in the policy.`,
    requiredReadback: "",
    nextSteps: [],
    action: workspaceAction("read", "secrets"),
    control: "secrets",
  };
}

interface SecretsCall {
  scope?: SecretInventoryScope | undefined;
  environment?: string | undefined;
  environmentPublicId?: string | undefined;
  allowAccountWide?: boolean | undefined;
  cursor?: string | undefined;
}

async function readWorkspaceControl(
  client: CursorClient,
  control: WorkspaceControlId,
  detail = false,
  secrets?: { profile: Profile | undefined; maxResponseBytes: number; call: SecretsCall },
): Promise<WorkspaceControlResult & { details?: Models["items"] }> {
  const surface = workspaceControlSurface(control);
  if (control === "secrets" && secrets !== undefined) {
    return readSecretsControl(client, secrets.profile, secrets.maxResponseBytes, secrets.call);
  }
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

/**
 * Secret names and metadata. Values are not in any response and are not
 * requested; the projection and the redaction pass both drop value-like fields.
 *
 * There is no default scope. A secret list is a security-relevant read, and the
 * three scopes expose different people's metadata, so the caller names one.
 */
async function readSecretsControl(
  client: CursorClient,
  profile: Profile | undefined,
  maxResponseBytes: number,
  call: SecretsCall,
): Promise<WorkspaceControlResult> {
  const read = workspaceControlSurface("secrets").read;
  // `ok` truncates the whole structured result at maxResponseBytes, and a
  // truncated result fails output validation. So the judge measures the real
  // result, envelope and all, rather than reserving a guessed amount.
  const inventoryResult = (inventory: SecretInventory): WorkspaceControlResult =>
    capabilityResult(read, {
      inventory,
      reason: secretInventorySummary(inventory),
      nextSteps:
        inventory.nextCursor === undefined
          ? []
          : [
              `Call ${WORKSPACE_GET_TOOL} with control=secrets, the same scope arguments, and cursor=${inventory.nextCursor}.`,
            ],
    });
  const cost = (inventory: SecretInventory) =>
    structuredCost(redactSecretFields(inventoryResult(inventory)));
  const fits = (candidate: SecretInventory): boolean =>
    candidate.complete || candidate.stoppedBecause !== undefined
      ? cost(candidate) <= maxResponseBytes
      : SECRET_INVENTORY_STOPS.every(
          (stop) => cost({ ...candidate, stoppedBecause: stop }) <= maxResponseBytes,
        );
  const scope = call.scope;
  if (scope === undefined) {
    return capabilityResult(read, {
      reason:
        "No secret was read: pass scope=environment (with environment or environmentPublicId), scope=team, or scope=account with allowAccountWide=true. There is no default scope.",
    });
  }
  if (scope !== "environment" && (call.environment !== undefined || call.environmentPublicId !== undefined)) {
    throw new PolicyError("environment and environmentPublicId apply only to scope=environment");
  }
  if (scope === "account") {
    if (call.allowAccountWide !== true) {
      throw new PolicyError(
        "scope=account lists every secret the key can see, which for a team admin user key includes other members' personal secret metadata; pass allowAccountWide=true to accept that",
      );
    }
    if (profile?.environmentAccess !== "account") {
      throw new PolicyError(
        "scope=account includes environments outside a named-environment profile; it needs environmentAccess=account in the active profile",
      );
    }
  }
  try {
    const environmentPublicId =
      scope === "environment"
        ? (await resolveEnvironmentTarget(client, profile, call)).id
        : undefined;
    const inventory = await readSecretInventory(
      client,
      {
        scope,
        ...(environmentPublicId === undefined ? {} : { environmentPublicId }),
        ...(call.cursor === undefined ? {} : { cursor: call.cursor }),
      },
      { fits },
    );
    return inventoryResult(inventory);
  } catch (error) {
    if (error instanceof SecretInventoryTooLargeError) {
      return secretsTooSmallResult(read, maxResponseBytes);
    }
    if (error instanceof CursorApiError) {
      const refusal = secretInventoryRefusal(read, scope, error.code);
      if (refusal !== undefined) return refusal;
    }
    throw error;
  }
}
