/**
 * Workspace Controls: identity, entitlement, and the Cloud Agent settings
 * that actually affect a launch.
 *
 * Callers see Cursor domain operations, not REST, SDK, or dashboard routes.
 * Tool names stay stable if an internal integration changes. Only controls with
 * a published, testable API-key contract are `supported`; everything else is an
 * explicit capability result. Secret *values* are never a read or write surface.
 *
 * Evidence and authority follow `docs/cursor-capabilities.md`. Slack,
 * notifications, Cursor Origin, self-hosted fleets, billing, and unrelated
 * organization administration stay out of this catalog.
 */

import type {
  CapabilityAuthority,
  CapabilityEvidence,
} from "./lifecycle-model.js";
import type { Me } from "./schemas.js";

/** Stable MCP names. An internal route change must not rename these. */
export const WORKSPACE_LIST_TOOL = "cursor_list_workspace_controls";
export const WORKSPACE_INSPECT_TOOL = "cursor_inspect_workspace";
export const WORKSPACE_GET_TOOL = "cursor_get_workspace_control";

export const WORKSPACE_CONTROL_IDS = [
  "identity",
  "models",
  "repositories",
  "default-model",
  "default-repository",
  "base-branch",
  "pr-behavior",
  "network-policy",
  "secrets",
  "mcp-policy",
  "team-follow-up",
] as const;

export type WorkspaceControlId = (typeof WORKSPACE_CONTROL_IDS)[number];

export const WRITABLE_WORKSPACE_CONTROLS = [
  "default-model",
  "default-repository",
  "base-branch",
  "pr-behavior",
  "network-policy",
  "secrets",
  "mcp-policy",
] as const;

export type WritableWorkspaceControl = (typeof WRITABLE_WORKSPACE_CONTROLS)[number];

/**
 * Distinct from Environment Operations residuals on purpose.
 *
 * `unsupported` -- no proven programmatic path; do not guess one.
 * `unavailable-on-plan` -- the control exists but this key/plan/role cannot use it.
 * `unverified` -- dashboard-documented; the API-key contract is not established.
 * `supported` -- live readback on the published API-key surface.
 */
export type WorkspaceControlStatus =
  | "supported"
  | "unsupported"
  | "unavailable-on-plan"
  | "unverified";

export type WorkspaceControlKind = "read" | "write";

export type AccountKind = "user" | "service-account";

export interface AccountEntitlement {
  kind: AccountKind;
  apiKeyName?: string;
  createdAt?: string;
  userEmail?: string;
  userId?: number;
}

export interface WorkspaceControlCapability {
  id: WorkspaceControlId;
  kind: WorkspaceControlKind;
  status: WorkspaceControlStatus;
  authority: CapabilityAuthority;
  evidence: CapabilityEvidence;
  tool: string;
  reason: string;
  requiredReadback: string;
  nextSteps: string[];
}

export interface WorkspaceControlSurface {
  id: WorkspaceControlId;
  read: WorkspaceControlCapability;
  write?: WorkspaceControlCapability;
}

export interface WorkspaceControlResult extends WorkspaceControlCapability {
  action: string;
  /** Same identifier as `id`; kept so tool output names the control explicitly. */
  control: WorkspaceControlId;
  entitlement?: AccountEntitlement;
  models?: string[];
  repos?: string[];
}

export class WorkspaceCapabilityError extends Error {
  readonly residual: WorkspaceControlResult;

  constructor(residual: WorkspaceControlResult) {
    super(residual.reason);
    this.name = "WorkspaceCapabilityError";
    this.residual = residual;
  }
}

const DASHBOARD =
  "Configure this in the Cloud Agents dashboard (https://cursor.com/dashboard/cloud-agents).";

const PROGRAMMATIC_READBACK =
  "a published API-key or SDK document that names this control, plus a matching live readback";

const PROGRAMMATIC_WRITE_READBACK =
  "a published API-key or SDK mutation for this control plus a matching live readback of the new setting; secret values are never a readback";

/**
 * Keys that must never appear in MCP output or logs.
 *
 * An allowlist would miss the next credential field Cursor adds. Dropping any
 * field whose name is a value-bearer is the fail-closed rule.
 */
const SECRET_VALUE_KEY =
  /^(values?|secret|secrets|token|tokens|password|passphrase|authorization|auth|api[_-]?key|credential|credentials|private[_-]?key|client[_-]?secret|headers|env)$/i;

export function isWritableWorkspaceControl(
  control: WorkspaceControlId,
): control is WritableWorkspaceControl {
  return (WRITABLE_WORKSPACE_CONTROLS as readonly string[]).includes(control);
}

export function workspaceAction(
  kind: WorkspaceControlKind,
  id: WorkspaceControlId,
): string {
  const verb = kind === "read" ? "GET" : "SET";
  return `${verb}_${id.replace(/-/g, "_").toUpperCase()}`;
}

/**
 * Strip secret-bearing fields from any structure.
 *
 * Presence of a name is kept. The value is dropped, not masked, so a later
 * length or prefix cannot leak it. Applied before any tool result or log line.
 */
export function redactSecretFields<T>(value: T): T {
  return redactUnknown(value) as T;
}

function redactUnknown(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactUnknown);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SECRET_VALUE_KEY.test(key)) continue;
    Object.defineProperty(out, key, {
      value: redactUnknown(entry),
      enumerable: true,
      writable: true,
      configurable: true,
    });
  }
  return out;
}

export function projectEntitlement(me: Me): AccountEntitlement {
  const entitlement: AccountEntitlement = {
    kind:
      me.userEmail !== undefined || me.userId !== undefined
        ? "user"
        : "service-account",
  };
  if (me.apiKeyName !== "") entitlement.apiKeyName = me.apiKeyName;
  if (me.createdAt !== "") entitlement.createdAt = me.createdAt;
  if (me.userEmail !== undefined) entitlement.userEmail = me.userEmail;
  if (me.userId !== undefined) entitlement.userId = me.userId;
  return entitlement;
}

/** Documented Cloud Agents API error codes that mean this plan or role cannot use the control. */
export const PLAN_GATED_CODES = new Set([
  "plan_required",
  "feature_unavailable",
  "role_forbidden",
]);

export function isPlanGatedCode(code: string | undefined): boolean {
  return code !== undefined && PLAN_GATED_CODES.has(code);
}

function capability(args: {
  id: WorkspaceControlId;
  kind: WorkspaceControlKind;
  status: WorkspaceControlStatus;
  authority: CapabilityAuthority;
  evidence: CapabilityEvidence;
  tool: string;
  reason: string;
  requiredReadback: string;
  nextSteps: string[];
}): WorkspaceControlCapability {
  return args;
}

const SUPPORTED_READBACK = {
  identity: "GET /v1/me fields apiKeyName, createdAt, and owner identity when present",
  models: "GET /v1/models items[].id",
  repositories: "GET /v1/repositories items[].url",
} as const;

function supportedRead(
  id: "identity" | "models" | "repositories",
  tool: string,
  reason: string,
): WorkspaceControlCapability {
  return capability({
    id,
    kind: "read",
    status: "supported",
    authority: "api-key",
    evidence: "observed",
    tool,
    reason,
    requiredReadback: SUPPORTED_READBACK[id],
    nextSteps: [`Call ${tool} or ${WORKSPACE_GET_TOOL} with control=${id}.`],
  });
}

function unverifiedRead(
  id: WorkspaceControlId,
  authority: CapabilityAuthority,
  reason: string,
): WorkspaceControlCapability {
  return capability({
    id,
    kind: "read",
    status: "unverified",
    authority,
    evidence: "uncertain",
    tool: WORKSPACE_GET_TOOL,
    reason,
    requiredReadback: PROGRAMMATIC_READBACK,
    nextSteps: [
      DASHBOARD,
      `Call ${WORKSPACE_GET_TOOL} with control=${id} to re-check; it will not guess a route.`,
    ],
  });
}

function unsupportedWrite(
  id: WritableWorkspaceControl,
  authority: CapabilityAuthority,
  reason: string,
): WorkspaceControlCapability {
  return capability({
    id,
    kind: "write",
    status: "unsupported",
    authority,
    evidence: "uncertain",
    // No tool performs the write. The catalog row is where the capability
    // stays addressable; a verb that could only ever answer "unsupported" was
    // removed rather than kept as a decoy.
    tool: WORKSPACE_LIST_TOOL,
    reason,
    requiredReadback: PROGRAMMATIC_WRITE_READBACK,
    nextSteps: [
      DASHBOARD,
      "Do not paste a secret value into this tool; values are never accepted.",
    ],
  });
}

/**
 * The coherent surface. Order is product order: identity and entitlement first,
 * then launch defaults, then security controls. Writes are attached to the same
 * row rather than listed as a second catalog.
 */
export const WORKSPACE_CONTROLS: readonly WorkspaceControlSurface[] = [
  {
    id: "identity",
    read: supportedRead(
      "identity",
      "cursor_whoami",
      "GET /v1/me is the published API-key identity read.",
    ),
  },
  {
    id: "models",
    read: supportedRead(
      "models",
      "cursor_list_models",
      "GET /v1/models lists ids accepted when launching a cloud agent.",
    ),
  },
  {
    id: "repositories",
    read: supportedRead(
      "repositories",
      "cursor_list_repos",
      "GET /v1/repositories lists GitHub repositories the key can launch against.",
    ),
  },
  {
    id: "default-model",
    read: unverifiedRead(
      "default-model",
      "browser-session",
      "The default model is dashboard-documented. No published API-key or SDK read names the account default.",
    ),
    write: unsupportedWrite(
      "default-model",
      "browser-session",
      "No published API-key or SDK operation sets the account default model.",
    ),
  },
  {
    id: "default-repository",
    read: unverifiedRead(
      "default-repository",
      "browser-session",
      "The default repository is dashboard-documented. No published API-key or SDK read names it.",
    ),
    write: unsupportedWrite(
      "default-repository",
      "browser-session",
      "No published API-key or SDK operation sets the account default repository.",
    ),
  },
  {
    id: "base-branch",
    read: unverifiedRead(
      "base-branch",
      "browser-session",
      "The PR base branch is dashboard-documented. No published API-key or SDK read names it.",
    ),
    write: unsupportedWrite(
      "base-branch",
      "browser-session",
      "No published API-key or SDK operation sets the account base branch.",
    ),
  },
  {
    id: "pr-behavior",
    read: unverifiedRead(
      "pr-behavior",
      "browser-session",
      "Account-level PR defaults are dashboard-documented. Per-agent autoCreatePR on create is a different control.",
    ),
    write: unsupportedWrite(
      "pr-behavior",
      "browser-session",
      "No published API-key or SDK operation sets account-level PR behavior. Per-agent autoCreatePR remains on cursor_create_agent.",
    ),
  },
  {
    id: "network-policy",
    read: unverifiedRead(
      "network-policy",
      "browser-session",
      "Network mode and allowlist are dashboard-documented. No published API-key or SDK read names them.",
    ),
    write: unsupportedWrite(
      "network-policy",
      "browser-session",
      "No published API-key or SDK operation mutates Cloud Agent network policy.",
    ),
  },
  {
    id: "secrets",
    read: unverifiedRead(
      "secrets",
      "browser-session",
      "Secret names and classes are dashboard-documented. Secret values are never an MCP read surface.",
    ),
    write: unsupportedWrite(
      "secrets",
      "browser-session",
      "No published API-key or SDK operation creates or deletes Cloud Agent secrets, and this tool never accepts a secret value.",
    ),
  },
  {
    id: "mcp-policy",
    read: unverifiedRead(
      "mcp-policy",
      "admin",
      "Account and team MCP policy is dashboard-documented. Environment-definition MCP allowlists are a different control.",
    ),
    write: unsupportedWrite(
      "mcp-policy",
      "admin",
      "No published API-key or SDK operation mutates account or team MCP policy.",
    ),
  },
  {
    id: "team-follow-up",
    read: unverifiedRead(
      "team-follow-up",
      "admin",
      "Team follow-up policy is an admin setting. No published API-key or SDK read names it.",
    ),
  },
];

export function workspaceControlSurface(
  id: WorkspaceControlId,
): WorkspaceControlSurface {
  const surface = WORKSPACE_CONTROLS.find((entry) => entry.id === id);
  if (surface === undefined) {
    throw new Error(`unknown workspace control ${id}`);
  }
  return surface;
}

export function listWorkspaceControls(filter?: {
  status?: WorkspaceControlStatus;
  kind?: WorkspaceControlKind;
}): WorkspaceControlSurface[] {
  return WORKSPACE_CONTROLS.filter((surface) => matchesFilter(surface, filter));
}

function matchesFilter(
  surface: WorkspaceControlSurface,
  filter: { status?: WorkspaceControlStatus; kind?: WorkspaceControlKind } | undefined,
): boolean {
  if (filter === undefined) return true;
  const caps: WorkspaceControlCapability[] = [];
  if (filter.kind !== "write") caps.push(surface.read);
  if (filter.kind !== "read" && surface.write !== undefined) caps.push(surface.write);
  if (caps.length === 0) return false;
  if (filter.status === undefined) return true;
  return caps.some((cap) => cap.status === filter.status);
}

export function capabilityResult(
  capability: WorkspaceControlCapability,
  extra: {
    status?: WorkspaceControlStatus;
    reason?: string;
    entitlement?: AccountEntitlement;
    models?: string[];
    repos?: string[];
  } = {},
): WorkspaceControlResult {
  const status = extra.status ?? capability.status;
  const result: WorkspaceControlResult = {
    ...capability,
    status,
    action: workspaceAction(capability.kind, capability.id),
    control: capability.id,
    reason: extra.reason ?? capability.reason,
  };
  if (extra.entitlement !== undefined) result.entitlement = extra.entitlement;
  if (extra.models !== undefined) result.models = extra.models;
  if (extra.repos !== undefined) result.repos = extra.repos;
  return result;
}

export function supportedIdentityResult(me: Me): WorkspaceControlResult {
  const entitlement = projectEntitlement(me);
  return capabilityResult(workspaceControlSurface("identity").read, {
    entitlement,
  });
}

export function supportedModelsResult(models: string[]): WorkspaceControlResult {
  return capabilityResult(workspaceControlSurface("models").read, { models });
}

export function supportedReposResult(repos: string[]): WorkspaceControlResult {
  return capabilityResult(workspaceControlSurface("repositories").read, { repos });
}

export function planGatedResult(
  capability: WorkspaceControlCapability,
  code: string,
): WorkspaceControlResult {
  return capabilityResult(capability, {
    status: "unavailable-on-plan",
    reason:
      `This control is unavailable on the current plan or role (${code}). ` +
      capability.reason,
  });
}

export function inspectWorkspaceText(entitlement: AccountEntitlement): string {
  const key = entitlement.apiKeyName ?? "(unnamed)";
  const email = entitlement.userEmail ?? "(none)";
  return `kind=${entitlement.kind} key=${key} email=${email}`;
}

export function controlResultText(result: WorkspaceControlResult): string {
  const parts = [`${result.action}  ${result.status}  ${result.control}`];
  if (result.entitlement !== undefined) {
    parts.push(inspectWorkspaceText(result.entitlement));
  }
  if (result.models !== undefined) {
    parts.push(result.models.join("\n") || "(no models returned)");
  }
  if (result.repos !== undefined) {
    parts.push(result.repos.join("\n") || "(no repositories connected)");
  }
  parts.push(result.reason);
  return parts.join("\n");
}
