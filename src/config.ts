/**
 * Operator-owned configuration.
 *
 * The policy file is the enforcement layer that holds for every client — Claude
 * Code, Codex, Grok, and Cursor alike. Client-side hooks are an extra interactive
 * layer, not a substitute: three of those four clients will never run them.
 *
 * No tool writes this file. It is read once at startup.
 *
 * Fail-closed rules:
 *   - file absent  -> read-only mode, no mutations, no delete
 *   - file invalid -> refuse to start
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { ModelInputSchema } from "./model-selection.js";
import { CursorCliSchema } from "./cursor-cli.js";
import { ConfigError } from "./errors.js";
import { log } from "./log.js";
import { environmentBindingProblems } from "./policy.js";

/** Bytes of Cursor-originated text any single tool result may carry. */
export const DEFAULT_MAX_RESPONSE_BYTES = 32_768;

/**
 * Bulk job pacing. Defaults sit about 20% under the per-endpoint limits measured
 * on 2026-09-25 (get_agent_status 300/min, archive_agent 100/min), which Cursor
 * does not publish and may change -- hence configurable.
 */
export const BulkSchema = z.strictObject({
  /** Archive/unarchive POST attempts in any 60-second window. */
  writesPerMinute: z.number().int().min(1).max(1_000).default(80),
  /** Scope-check GET attempts in any 60-second window. */
  readsPerMinute: z.number().int().min(1).max(1_000).default(240),
  /** Agents in progress at once. */
  maxInFlight: z.number().int().min(1).max(16).default(4),
  /** Rate-limited attempts per agent before it is marked failed. */
  maxRateLimitRetries: z.number().int().min(0).max(20).default(5),
  /** Transient (5xx/transport) scope-read retries per agent. */
  maxTransientRetries: z.number().int().min(0).max(10).default(3),
  /** First backoff when Cursor sends no Retry-After; doubles per attempt. */
  backoffBaseMs: z.number().int().min(100).max(60_000).default(2_000),
  /** Ceiling on a computed backoff. A Retry-After is honoured in full. */
  backoffMaxMs: z.number().int().min(1_000).max(600_000).default(60_000),
  /** Wall-clock limit on one job; unfinished agents are then reported not submitted. */
  jobTimeoutMinutes: z.number().int().min(1).max(240).default(60),
  /** Agent ids one job accepts. */
  maxAgents: z.number().int().min(1).max(5_000).default(1_000),
});

/**
 * Where a named environment lives.
 *
 * Cursor offers a personal environment and a team one, and they are not the same
 * grant: a team environment's secrets belong to the team. The scope is stated by
 * the operator rather than inferred, because a delegated run cannot answer it
 * about itself.
 */
export const ENVIRONMENT_SCOPES = ["personal", "team"] as const;

export type EnvironmentScope = (typeof ENVIRONMENT_SCOPES)[number];

/**
 * A structured environment binding.
 *
 * `publicId` is the authoritative `environmentPublicId` for this name, declared
 * out of band. Pinning it is what lets a later operation refuse an id a run
 * reported about itself.
 *
 * `repos` *narrows* the profile's repository allowlist for this environment and
 * can never widen it. The profile-level `"*"` is not accepted here; a binding
 * inherits it by omitting `repos`.
 */
export const EnvironmentBindingSchema = z.strictObject({
  name: z.string().trim().min(1),
  publicId: z
    .string()
    .trim()
    .min(1)
    .regex(
      /^[A-Za-z0-9_.:-]+$/,
      "publicId must be one opaque identifier token with no whitespace",
    ),
  scope: z.enum(ENVIRONMENT_SCOPES),
  repos: z.array(z.string().min(1)).min(1).optional(),
});

export type EnvironmentBinding = z.infer<typeof EnvironmentBindingSchema>;

/**
 * One entry of `profiles.*.environments`.
 *
 * A bare string is the legacy form and stays valid: it names the environment and
 * pins nothing else, so it inherits the profile's repositories and carries no
 * authoritative identity. A structured binding is the richer form.
 */
export const EnvironmentEntrySchema = z.union([
  z.string().trim().min(1),
  EnvironmentBindingSchema,
]);

export type EnvironmentEntry = z.infer<typeof EnvironmentEntrySchema>;

/**
 * A named set of approved operations. Every call runs under one; there is no
 * ambient authority once a policy file exists.
 *
 * One rule governs the lists below, without exception: **an empty list
 * permits nothing.** Widening is always explicit. An earlier version had
 * `tools: []` mean "every read tool", which read as "no tools" to an operator
 * and would have silently granted each new read tool -- run output, artifact
 * downloads -- as later milestones added them.
 */
export const ProfileSchema = z
  .strictObject({
    /**
     * Repositories this profile may target, as `owner/name` or a full URL. Empty
     * means no repository targets; no-repository VMs are independent. The single entry `"*"` means any
     * repository Cursor lets this API key use -- Cursor's own installation
     * boundary, rather than a hand-maintained subset of it. See `REPO_WILDCARD`
     * in `policy.ts`.
     */
    repos: z.array(z.string().min(1)).default([]),
    /**
     * Named environments this profile may target, as the `env.name` passed at
     * launch. In named mode, omitted or empty means none. Account mode
     * permits account environments while retaining declared identity pins.
     *
     * Each entry is either the legacy bare name or a structured binding. Both
     * forms may appear in one list; `policy.ts` resolves them to one shape.
     */
    environments: z.array(EnvironmentEntrySchema).optional(),
    /** Account access waives environment-name membership, not operation permissions. */
    environmentAccess: z.enum(["named", "account"]).optional(),
    /** Override no-repository launch/lifecycle access; defaults to create-tool permission. */
    allowNoRepository: z.boolean().optional(),
    /**
     * Tool names this profile may invoke. Required -- the operator states intent
     * rather than inheriting a default. Two wildcards are accepted: `"*"` for
     * every tool, and `"read:*"` for every read-only tool.
     */
    tools: z.array(z.string().min(1)),
    /** Pin `autoCreatePR`; when set, a call may not override it. */
    autoCreatePR: z.boolean().optional(),
    /** Pin the supervisor model for ordinary/delegated launches and follow-up runs. */
    model: ModelInputSchema.optional(),
    /** Removed policy surfaces; empty legacy values are accepted then discarded. */
    allowedEnvVars: z.array(z.string()).max(0).optional(),
    allowedMcpServers: z.array(z.string()).max(0).optional(),
  })
  .transform(({ allowedEnvVars: _env, allowedMcpServers: _mcp, ...profile }) => profile);

export type Profile = z.infer<typeof ProfileSchema>;

export const TOOL_WILDCARD = "*";
export const READ_TOOL_WILDCARD = "read:*";

/**
 * May this profile invoke this tool?
 *
 * `undefined` is read-only mode: no policy file exists, so read-only tools are
 * available and nothing else is. Any other decision is the profile's to make.
 */
export function isToolAllowed(
  profile: Profile | undefined,
  tool: string,
  readOnly: boolean,
): boolean {
  if (profile === undefined) return readOnly;
  if (profile.tools.includes(TOOL_WILDCARD)) return true;
  if (readOnly && profile.tools.includes(READ_TOOL_WILDCARD)) return true;
  return profile.tools.includes(tool);
}

/**
 * The profile a call runs under.
 *
 * `undefined` means read-only mode: either no policy file exists, or one exists
 * that names no default profile. Per-call profile selection arrives with the
 * mutating tools; until then the default is the only profile in play.
 */
export function activeProfile(policy: Policy): Profile | undefined {
  if (policy.defaultProfile === undefined) return undefined;
  return policy.profiles[policy.defaultProfile];
}

/**
 * The authorized export storage root, or undefined when there is none.
 *
 * Undefined is a decision, not a fallback: without a root the export tool is not
 * registered at all. The environment form is validated here rather than in the
 * schema, because it does not pass through the policy file -- an unusable value
 * declines the grant and says so, instead of writing somewhere unintended.
 */
export function resolveExportRoot(
  policy: Policy,
  env = process.env,
): string | undefined {
  if (policy.exportRoot !== undefined) return policy.exportRoot;
  const configured = env.CURSOR_MCP_EXPORT_ROOT?.trim();
  if (configured === undefined || configured === "") return undefined;
  if (!isAbsolute(configured)) {
    log.warn(
      "CURSOR_MCP_EXPORT_ROOT is not an absolute path; run export stays unavailable",
    );
    return undefined;
  }
  return configured;
}

export const PolicySchema = z.strictObject({
  /** Permanent deletion is off unless the operator turns it on. */
  deleteEnabled: z.boolean().default(false),
  /**
   * Reserved for a future Build promotion authority. Accepted for compatibility,
   * but no current tool uses this gate and setting it enables no operation.
   */
  activationEnabled: z.boolean().default(false),
  /** Profile used when a call does not name one. */
  defaultProfile: z.string().min(1).optional(),
  profiles: z.record(z.string().min(1), ProfileSchema).default({}),
  /**
   * An optional local Cursor CLI, used as a separate read authority for global
   * environment discovery and configuration reads.
   *
   * Absent is the normal state: the server starts and every existing tool works
   * without it. Present grants nothing on its own. Reads, publish, database
   * Save, delete, and team scope have independent gates inside the block, for
   * the same reason root deletion and activation are separate from `tools`.
   */
  cursorCli: CursorCliSchema.optional(),
  /** Optional direct terminal access; multiple targets require explicit profile opt-in. */
  terminal: z.strictObject({
    agentId: z.string().max(128).regex(/^bc-[A-Za-z0-9-]+$/).optional(),
    targets: z.enum(['pinned', 'profile']).default('pinned'),
    maxTargets: z.number().int().min(1).max(128).default(16),
    executeEnabled: z.boolean().default(false),
  }).refine(value => value.targets !== 'pinned' || value.agentId !== undefined,
    { message: 'agentId is required for pinned terminal targets', path: ['agentId'] }).optional(),
  /**
   * Where `cursor_export_run` may write run exports.
   *
   * Absent is the normal state, and it means no export tool: naming a directory
   * this server may create files in is an operator act with no sensible default,
   * so it is never inferred. `CURSOR_MCP_EXPORT_ROOT` expresses the same grant
   * for an operator who configures by environment; this value wins over it.
   *
   * Absolute only. A relative root would resolve against whatever directory
   * happened to launch the server, which is not a decision an operator made.
   */
  exportRoot: z
    .string()
    .trim()
    .min(1)
    .refine(isAbsolute, "exportRoot must be an absolute path")
    .optional(),
  maxResponseBytes: z
    .number()
    .int()
    .min(1_024)
    .default(DEFAULT_MAX_RESPONSE_BYTES),
  /**
   * Pacing for bulk archive/unarchive jobs. Absent means the defaults below,
   * which sit about 20% under Cursor's measured per-endpoint limits. Setting
   * this grants nothing: the bulk tools still need the profile allowlist.
   */
  bulk: BulkSchema.optional(),
});

export type Policy = z.infer<typeof PolicySchema>;
export type BulkSettings = z.infer<typeof BulkSchema>;

/** The effective bulk pacing: the policy's block, or every default. */
export function bulkSettings(policy: Policy): BulkSettings {
  return policy.bulk ?? BulkSchema.parse({});
}

/** What we run as when no policy file exists: reads only, nothing else. */
export const READ_ONLY_POLICY: Policy = {
  deleteEnabled: false,
  activationEnabled: false,
  profiles: {},
  maxResponseBytes: DEFAULT_MAX_RESPONSE_BYTES,
};

export function policyPath(): string {
  return (
    process.env.CURSOR_MCP_POLICY ??
    join(homedir(), ".config", "cursor-mcp", "policy.json")
  );
}

/**
 * Load the policy file.
 *
 * Absent file is a normal, safe state: we degrade to read-only. Anything else —
 * unreadable, unparseable, or failing the schema — stops startup, so a typo can
 * never silently widen authority.
 */
export async function loadPolicy(
  path?: string,
  requireFile?: boolean,
): Promise<Policy> {
  const configuredPath = process.env.CURSOR_MCP_POLICY;
  const resolvedPath = path ?? policyPath();
  const mustExist =
    requireFile ?? (path === undefined && configuredPath !== undefined);
  let raw: string;
  try {
    raw = await readFile(resolvedPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      if (mustExist) {
        throw new ConfigError(`configured policy file ${resolvedPath} does not exist`);
      }
      log.warn(
        `no policy file at ${resolvedPath}; running read-only (no launches, no delete)`,
      );
      return READ_ONLY_POLICY;
    }
    throw new ConfigError(`cannot read policy file ${resolvedPath}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new ConfigError(`policy file ${resolvedPath} is not valid JSON`);
  }

  const result = PolicySchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("; ");
    throw new ConfigError(`policy file ${resolvedPath} is invalid -- ${issues}`);
  }

  const policy = result.data;
  if (policy.defaultProfile === undefined) {
    throw new ConfigError(
      `policy file ${resolvedPath}: defaultProfile is required; remove the policy file ` +
        "to use read-only mode",
    );
  }
  if (
    !Object.hasOwn(policy.profiles, policy.defaultProfile)
  ) {
    throw new ConfigError(
      `policy file ${resolvedPath}: defaultProfile "${policy.defaultProfile}" is not defined in profiles`,
    );
  }
  // Cross-field, so it cannot live in the entry schema: a binding's repositories
  // are checked against the profile's own list, and two bindings must not
  // disagree about one name or one environmentPublicId.
  for (const [name, profile] of Object.entries(policy.profiles)) {
    const problems = environmentBindingProblems(profile);
    if (problems.length > 0) {
      throw new ConfigError(
        `policy file ${resolvedPath}: profile "${name}" has invalid environment bindings -- ` +
          problems.join("; "),
      );
    }
  }
  return policy;
}

/**
 * Read the API key.
 *
 * Environment only. Keychain retrieval would need a subprocess, which this
 * server does not do.
 */
export function readApiKey(env = process.env): string {
  const key = env.CURSOR_API_KEY?.trim();
  if (!key) {
    throw new ConfigError(
      "CURSOR_API_KEY is not set. Create a key at https://cursor.com/dashboard/api " +
        "and export it in the environment that launches this server.",
    );
  }
  // The key goes straight into an Authorization header. A stray character -- a
  // newline from a copy-paste is the common one -- would otherwise surface as an
  // opaque transport failure on every call, or smuggle a second header.
  // Deliberately does not echo the value.
  if (!VALID_KEY.test(key)) {
    throw new ConfigError(
      "CURSOR_API_KEY contains a character that is not valid in an HTTP header " +
        "(often a newline from copying). Re-copy the key without surrounding whitespace.",
    );
  }
  return key;
}

/** Printable ASCII only: the character set an Authorization header allows. */
const VALID_KEY = new RegExp("^[\\u0021-\\u007E]+$");
