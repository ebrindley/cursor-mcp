/**
 * Wire schemas for the Cursor Cloud Agents v1 API.
 *
 * Verified against the published OpenAPI document and against live responses
 * from api.cursor.com. Where the two disagree, the live response wins and the
 * difference is noted.
 *
 * Two rules:
 *   1. Every object is loose -- v1 is in beta and adds fields, which we pass
 *      through rather than drop.
 *   2. A field is required only where the spec marks it required AND the calling
 *      operation depends on it.
 */

import { z } from "zod";

/** GET /v1/me -- `ApiKeyInfo`. Owner fields are absent for service-account keys. */
export const MeSchema = z.looseObject({
  apiKeyName: z.string(),
  createdAt: z.string(),
  userId: z.number().int().nonnegative().optional(),
  userEmail: z.string().optional(),
  userFirstName: z.string().optional(),
  userLastName: z.string().optional(),
});

export type Me = z.infer<typeof MeSchema>;

/** An entry in GET /v1/models. `id` is what you pass as `model.id` on create. */
export const ModelEntrySchema = z.looseObject({
  id: z.string(),
  displayName: z.string(),
  description: z.string().optional(),
  aliases: z.array(z.string()).optional(),
});

/** The envelope key is `items`, not `models`. Confirmed live. */
export const ModelsSchema = z.looseObject({
  items: z.array(ModelEntrySchema),
});

export type Models = z.infer<typeof ModelsSchema>;

export function modelIds(payload: Models): string[] {
  return payload.items.map((entry) => entry.id);
}

export function modelLines(payload: Models): string[] {
  return payload.items.map((entry) => `${entry.id}  ${entry.displayName}`);
}

/** GET /v1/repositories -- `{ items: [{ url }] }`. Rate limited to 1/min. */
export const RepositoriesSchema = z.looseObject({
  items: z.array(z.looseObject({ url: z.string() })),
});

export type Repositories = z.infer<typeof RepositoriesSchema>;

/** A repo entry on an agent, and the `repos` element on create. */
export const RepoConfigSchema = z.looseObject({
  url: z.string(),
  startingRef: z.string().optional(),
  prUrl: z.string().optional(),
});

/**
 * An agent. `status` is an open string and never reflects execution -- that
 * lives on runs. Observed values include ACTIVE, IDLE, and ARCHIVED. IDLE is
 * follow-up eligibility, not run success. `latestRunId` is the handle to the
 * current run.
 *
 * The list endpoint may return a thinner summary than `GET /v1/agents/{id}`:
 * the published docs say list items carry the durable identity fields only, and
 * a live response once carried the full shape. Both are handled, because the
 * optional fields make the thin form legal here -- but `repos` is one of the
 * fields that can be missing, and a policy check that needs it must resolve it
 * rather than read its absence as a denial. See `AgentScope.classify`.
 */
export const AgentSchema = z.looseObject({
  id: z.string(),
  status: z.string(),
  url: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  name: z.string().optional(),
  env: z.looseObject({ type: z.string(), name: z.string().optional() }).optional(),
  repos: z.array(RepoConfigSchema).optional(),
  autoCreatePR: z.boolean().optional(),
  workOnCurrentBranch: z.boolean().optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  latestRunId: z.string().optional(),
});

export type Agent = z.infer<typeof AgentSchema>;

/** `nextCursor` is omitted, not null, on the last page. */
export const AgentListSchema = z.looseObject({
  items: z.array(AgentSchema),
  nextCursor: z.string().optional(),
});

/**
 * A run. `durationMs` and `result` populate only at a terminal status.
 *
 * `git` is per-*agent* state, not per-run: every run on an agent returns the
 * same snapshot. The spec says `repoUrl` comes back without a scheme; live
 * responses include one. Treated as opaque either way.
 */
export const RunSchema = z.looseObject({
  id: z.string(),
  agentId: z.string(),
  status: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  durationMs: z.number().optional(),
  result: z.string().optional(),
  git: z
    .looseObject({
      branches: z.array(
        z.looseObject({
          repoUrl: z.string(),
          branch: z.string().optional(),
          prUrl: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

export type Run = z.infer<typeof RunSchema>;

export const RunListSchema = z.looseObject({
  items: z.array(RunSchema),
  nextCursor: z.string().optional(),
});

/** POST /v1/agents returns the agent *and* its first run. */
export const CreateAgentResponseSchema = z.looseObject({
  agent: AgentSchema,
  run: RunSchema,
});

export const CreateRunResponseSchema = z.looseObject({
  run: RunSchema,
});

/** Cancel, archive, unarchive, and delete all return `{ id }`. */
export const IdResponseSchema = z.looseObject({ id: z.string() });

/**
 * An artifact the agent wrote to its workspace. `path` is relative to
 * `artifacts/` and is the value the download endpoint wants back -- v0's absolute
 * `/opt/cursor/artifacts/...` form is rejected, so it is passed through opaquely
 * rather than reconstructed.
 *
 * Artifacts are agent-scoped, not run-scoped: the workspace outlives a run.
 */
export const ArtifactSchema = z.looseObject({
  path: z.string(),
  sizeBytes: z.number().optional(),
  updatedAt: z.string().optional(),
});

export type Artifact = z.infer<typeof ArtifactSchema>;

export const ArtifactListSchema = z.looseObject({
  items: z.array(ArtifactSchema),
});

/** A presigned download URL, valid for 15 minutes. */
export const ArtifactUrlSchema = z.looseObject({
  url: z.string(),
  expiresAt: z.string().optional(),
});

/**
 * Token counts for one run, or summed across runs.
 *
 * `totalTokens` is required: it is the number the caller actually asked for, and
 * defaulting a missing field to zero would report "this cost nothing" when the
 * truth is "we do not know". Loud drift beats a quiet lie about spend. The
 * component counts stay optional -- the total is what the operation depends on.
 */
export const TokenUsageSchema = z.looseObject({
  totalTokens: z.number(),
  inputTokens: z.number().optional(),
  outputTokens: z.number().optional(),
  cacheWriteTokens: z.number().optional(),
  cacheReadTokens: z.number().optional(),
});

export type TokenUsage = z.infer<typeof TokenUsageSchema>;

/**
 * Money, in cents. Omitted from the REST OpenAPI and endpoint field list, but
 * returned live at both the top level and per run and represented by current SDK
 * documentation. It is the number an operator actually wants when deciding
 * whether a fan-out is affordable.
 *
 * Optional because the REST contract does not promise it: it may be
 * plan-dependent or may go away. `chargedCents` is what is billed;
 * `rawCostCents` is before whatever the plan absorbs, and the two differ on an
 * included-usage plan.
 */
export const CostSchema = z.looseObject({
  rawCostCents: z.number().optional(),
  chargedCents: z.number().optional(),
});

export type Cost = z.infer<typeof CostSchema>;

/**
 * GET /v1/agents/{id}/usage. Every run appears, including ones with no recorded
 * usage yet, which report zeros rather than being omitted.
 */
export const UsageSchema = z.looseObject({
  totalUsage: TokenUsageSchema,
  cost: CostSchema.optional(),
  runs: z.array(
    z.looseObject({
      id: z.string(),
      usageUuid: z.string().optional(),
      usage: TokenUsageSchema,
      cost: CostSchema.optional(),
    }),
  ),
});

export type Usage = z.infer<typeof UsageSchema>;

/**
 * Run statuses that will not change again.
 *
 * Kept as a set over `z.string()` rather than a zod enum: a status Cursor adds
 * during the beta should read as non-terminal, not fail the whole response.
 */
const TERMINAL = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);

export function isTerminal(status: string): boolean {
  return TERMINAL.has(status);
}

/** One line describing a run, for the summary text. */
export function runLine(run: Run): string {
  const parts = [run.id, run.status];
  if (run.durationMs !== undefined) {
    parts.push(`${Math.round(run.durationMs / 1000)}s`);
  }
  const branch = run.git?.branches.find((b) => b.branch !== undefined);
  if (branch?.branch !== undefined) parts.push(branch.branch);
  if (branch?.prUrl !== undefined) parts.push(branch.prUrl);
  return parts.join("  ");
}

/** One line describing an artifact, for the summary text. */
export function artifactLine(artifact: Artifact): string {
  const parts = [artifact.path];
  if (artifact.sizeBytes !== undefined) parts.push(`${artifact.sizeBytes}B`);
  if (artifact.updatedAt !== undefined) parts.push(artifact.updatedAt);
  return parts.join("  ");
}

/** One line of token counts and cost, for the summary text. */
export function usageLine(
  label: string,
  usage: TokenUsage,
  cost?: Cost,
): string {
  const parts = [label, `total=${usage.totalTokens}`];
  // Cents first among the extras: it is the number that decides whether to launch
  // ten more agents, and tokens are the number that explains it.
  if (cost?.rawCostCents !== undefined) parts.push(`raw=${cost.rawCostCents}c`);
  if (cost?.chargedCents !== undefined) parts.push(`charged=${cost.chargedCents}c`);
  if (usage.inputTokens !== undefined) parts.push(`in=${usage.inputTokens}`);
  if (usage.outputTokens !== undefined) parts.push(`out=${usage.outputTokens}`);
  if (usage.cacheReadTokens !== undefined) {
    parts.push(`cacheRead=${usage.cacheReadTokens}`);
  }
  if (usage.cacheWriteTokens !== undefined) {
    parts.push(`cacheWrite=${usage.cacheWriteTokens}`);
  }
  return parts.join("  ");
}

/** One line describing an agent, for the summary text. */
export function agentLine(agent: Agent): string {
  const parts = [agent.id, agent.status];
  if (agent.name !== undefined) parts.push(agent.name);
  const env = agent.env?.name;
  if (env !== undefined) parts.push(`env=${env}`);
  const repo = agent.repos?.[0]?.url;
  if (repo !== undefined) parts.push(repo);
  return parts.join("  ");
}
