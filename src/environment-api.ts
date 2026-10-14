import { z } from "zod";
import type { CursorClient } from "./client.js";
import { seg } from "./client.js";
import type { Profile } from "./config.js";
import { PolicyError } from "./errors.js";
import { assertEnvironmentIdentity, assertEnvironmentReposAllowed, assertAgentReposAllowed, resolveEnvironmentBinding } from "./policy.js";
import { normalizeEnvironmentConfiguration } from "./cursor-cli-environments.js";

export const EnvironmentSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1).optional(),
  owner: z.enum(["personal", "team"]),
  repos: z.array(z.object({ url: z.string().min(1) })),
  createdAt: z.string(),
  updatedAt: z.string(),
  repoFile: z.object({ url: z.string(), path: z.string() }).optional(),
  environmentJson: z.string().optional(),
  versionId: z.string().optional(),
});
export type Environment = z.infer<typeof EnvironmentSchema>;
export const EnvironmentListSchema = z.object({
  items: z.array(EnvironmentSchema),
  nextCursor: z.string().min(1).optional(),
});
export const EnvironmentHistorySchema = z.object({
  items: z.array(z.object({
    id: z.string(), createdAt: z.string(), kind: z.string(),
    title: z.string(), description: z.string(), current: z.boolean(),
    source: z.string().optional(), environmentJson: z.string().optional(),
  })),
  nextCursor: z.string().min(1).optional(),
});

export function assertEnvironmentRead(profile: Profile | undefined, environment: Environment): void {
  const pinned = profile?.environments?.find(e => typeof e !== "string" && e.publicId === environment.id);
  const name = typeof pinned === "object" ? pinned.name : environment.name;
  if (name === undefined) {
    if (profile?.environmentAccess !== "account") throw new PolicyError("unnamed environment is not in the active profile");
    assertAgentReposAllowed(profile, environment.repos.map(r => r.url));
    return;
  }
  const binding = assertEnvironmentIdentity(profile, name, environment.id);
  if (binding.scope !== undefined && binding.scope !== environment.owner)
    throw new PolicyError("environment ownership does not match the active profile");
  assertEnvironmentReposAllowed(profile, name, environment.repos.map(r => r.url));
}

export async function readEnvironment(client: CursorClient, profile: Profile | undefined, id: string): Promise<Environment> {
  const environment = await client.get(`/v1/environments/${seg(id)}`, EnvironmentSchema);
  if (environment.id !== id) throw new PolicyError("environment response identifies a different environment");
  assertEnvironmentRead(profile, environment);
  return environment;
}

/**
 * Resolve an allowed environment name or a public id to a profile-checked
 * environment. A name can exist in more than one ownership scope, so it is never
 * resolved by taking the first match.
 */
export async function resolveEnvironmentTarget(
  client: CursorClient,
  profile: Profile | undefined,
  args: { environment?: string | undefined; environmentPublicId?: string | undefined },
): Promise<Environment> {
  const binding = args.environment ? resolveEnvironmentBinding(profile, args.environment) : undefined;
  let id = args.environmentPublicId ?? binding?.publicId;
  if (!id && !args.environment) throw new PolicyError("pass environmentPublicId or an allowed environment name");
  if (!id) {
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
}

export function environmentEntry(environment: Environment, profile: Profile | undefined) {
  let inProfile = true;
  try { assertEnvironmentRead(profile, environment); } catch { inProfile = false; }
  return {
    environmentPublicId: environment.id, ...(environment.name ? { name: environment.name } : {}),
    scope: environment.owner, repos: environment.repos.map(r => r.url), inProfile,
    createdAt: environment.createdAt, updatedAt: environment.updatedAt,
  };
}

/** Configuration contents stay inside the adapter; only classified digests leave it. */
export function configurationRead(environment: Pick<Environment, "id" | "environmentJson" | "repoFile">) {
  let document: unknown;
  let note: string | undefined;
  if (environment.environmentJson !== undefined) {
    try { document = JSON.parse(environment.environmentJson); }
    catch { note = "Saved configuration is not valid JSON."; }
  }
  const normalized = normalizeEnvironmentConfiguration({
    environmentPublicId: environment.id,
    payload: {
      environmentJson: document,
      environmentJsonPath: environment.repoFile?.path ?? null,
      ...(note ? { environmentJsonNote: note } : {}),
    },
  });
  if (!normalized.ok) throw new Error("Could not summarize saved configuration");
  return normalized.read;
}
