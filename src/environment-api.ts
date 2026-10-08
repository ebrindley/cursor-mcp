import { z } from "zod";
import type { CursorClient } from "./client.js";
import { seg } from "./client.js";
import type { Profile } from "./config.js";
import { PolicyError } from "./errors.js";
import { assertEnvironmentIdentity, assertEnvironmentReposAllowed, assertAgentReposAllowed } from "./policy.js";
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
  const name = environment.name ?? (typeof pinned === "object" ? pinned.name : undefined);
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
