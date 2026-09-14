/**
 * Policy decisions that the write tools enforce.
 *
 * Kept out of `config.ts`, which is about loading and validating the file, and
 * out of the tools, so every launch path answers "may I?" the same way.
 */

import type {
  EnvironmentEntry,
  EnvironmentScope,
  Profile,
} from "./config.js";
import { sameModel, type ModelInput } from "./model-selection.js";
import { PolicyError } from "./errors.js";
import { isToolAllowed } from "./config.js";

/**
 * Reduce a repository reference to `owner/name`, lowercased.
 *
 * An operator writes `ExampleOrg/ExampleRepo` in the policy file; the API returns
 * `https://github.com/ExampleOrg/ExampleRepo`; a model might pass either, or an SSH
 * remote. Comparing the raw strings would let a spelling difference read as a
 * different repository -- which fails open if the allowlist is checked by
 * exclusion, so both sides are normalised to one key instead.
 */
export interface CanonicalRepo {
  key: string;
  url: string;
}

const REPO_PATH = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]+)$/;

export function canonicalRepo(value: string): CanonicalRepo {
  const trimmed = value.trim();
  let path: string;

  const scp = /^git@github\.com:([^?#]+)$/.exec(trimmed);
  if (scp !== null) {
    path = scp[1]!;
  } else if (/^[^/:]+\/[^/]+\/?$/.test(trimmed)) {
    path = trimmed;
  } else {
    let url: URL;
    try {
      url = new URL(trimmed.includes("://") ? trimmed : `https://${trimmed}`);
    } catch {
      throw new PolicyError("repository must be a GitHub owner/name or URL");
    }
    if (
      url.hostname.toLowerCase() !== "github.com" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.password !== "" ||
      (url.protocol === "https:" && url.username !== "") ||
      (url.protocol === "ssh:" && url.username !== "git") ||
      (url.protocol !== "https:" && url.protocol !== "ssh:")
    ) {
      throw new PolicyError("repository must be an uncredentialed GitHub URL");
    }
    path = url.pathname.replace(/^\/+/, "");
  }

  path = path.replace(/\/+$/, "").replace(/\.git$/i, "");
  const match = REPO_PATH.exec(path);
  if (match === null) {
    throw new PolicyError("repository must identify exactly one GitHub owner/name");
  }
  const owner = match[1]!;
  const name = match[2]!;
  return {
    key: `${owner}/${name}`.toLowerCase(),
    url: `https://github.com/${owner}/${name}`,
  };
}

export function repoKey(value: string): string {
  return canonicalRepo(value).key;
}

/**
 * The one entry in a profile's `repos` that is not a repository.
 *
 * It means: any repository Cursor itself lets this API key use. Cursor already
 * bounds a launch to the repositories its GitHub installation grants, so for an
 * operator whose installation covers a whole account an explicit list is a line
 * drawn through their own repositories, and one that silently excludes every
 * repository connected after the file was written. The wildcard makes Cursor's
 * boundary the boundary. It is still explicit -- an empty list permits nothing
 * -- and it is only valid on the profile, never on an environment binding.
 */
export const REPO_WILDCARD = "*";

export function allowsAnyRepo(repos: readonly string[]): boolean {
  return repos.includes(REPO_WILDCARD);
}

/**
 * Refuse a launch against a repository the profile does not name.
 *
 * Under the wildcard the reference is still canonicalized, so a malformed or
 * credentialed URL is refused exactly as before; only the membership test is
 * waived. Read-only mode (no policy file) reaches this only if a write tool was
 * somehow registered, so it refuses rather than assuming.
 */
export function assertRepoAllowed(
  profile: Profile | undefined,
  repo: string,
): string {
  if (profile === undefined) {
    throw new PolicyError(
      "no policy file, so this server is read-only; no agent may be launched",
    );
  }
  if (profile.repos.length === 0) {
    throw new PolicyError(
      "the active profile names no repositories, so no agent may be launched; " +
        "add them to `repos` in the policy file",
    );
  }
  const canonical = canonicalRepo(repo);
  if (allowsAnyRepo(profile.repos)) return canonical.url;
  const wanted = canonical.key;
  if (!profile.repos.some((allowed) => repoKey(allowed) === wanted)) {
    throw new PolicyError(
      `repository ${wanted} is not in the active profile; permitted: ` +
        profile.repos.map(repoKey).join(", "),
    );
  }
  return canonical.url;
}

export function assertAgentReposAllowed(
  profile: Profile | undefined,
  repos: string[] | undefined,
): void {
  if (profile === undefined) return;
  if (repos === undefined || repos.length === 0) {
    throw new PolicyError("agent repository metadata is unavailable");
  }
  for (const repo of repos) assertRepoAllowed(profile, repo);
}

/* ------------------------------------------------------ environment bindings */

/**
 * One environment allowlist entry, in the single shape callers work with.
 *
 * The legacy bare name and the structured binding resolve to this. `repos` is
 * always the *effective* allowlist for the environment: the profile's list, or
 * the binding's subset of it. It is never wider than the profile's.
 */
export interface ResolvedEnvironmentBinding {
  name: string;
  /** Authoritative id the operator pinned out of band, when there is one. */
  publicId?: string;
  scope?: EnvironmentScope;
  repos: string[];
  /**
   * True when the operator pinned an `environmentPublicId` for this name.
   *
   * Unpinned is a real state and is not an authorization: with no pinned id
   * there is nothing outside a run to gate the run's own answer against.
   */
  identityPinned: boolean;
}

function entryName(entry: EnvironmentEntry): string {
  return typeof entry === "string" ? entry.trim() : entry.name;
}

/**
 * Canonical keys for the repositories a profile names.
 *
 * One that cannot be canonicalized is skipped rather than thrown on:
 * `assertRepoAllowed` already refuses it at launch, and a binding must not be
 * judged a subset of a name that nothing can match.
 */
function canonicalizableKeys(repos: string[]): string[] {
  const keys: string[] = [];
  for (const repo of repos) {
    try {
      keys.push(repoKey(repo));
    } catch {
      continue;
    }
  }
  return keys;
}

/** Resolve one entry against its profile, narrowing repositories only. */
function resolveEntry(
  profile: Profile,
  entry: EnvironmentEntry,
): ResolvedEnvironmentBinding {
  if (typeof entry === "string") {
    return { name: entry.trim(), repos: [...profile.repos], identityPinned: false };
  }
  // Intersection, not replacement: a binding that names a repository the profile
  // does not is rejected at load, and is dropped here as well so a hand-built
  // profile cannot widen the grant either. Under the profile wildcard every
  // canonicalizable repository is inside the profile, so a binding's own list
  // stands as written and a binding without one inherits the wildcard.
  const wildcard = allowsAnyRepo(profile.repos);
  const profileKeys = canonicalizableKeys(profile.repos);
  return {
    name: entry.name,
    publicId: entry.publicId,
    scope: entry.scope,
    repos: (entry.repos ?? profile.repos).filter((repo) => {
      if (repo === REPO_WILDCARD) return wildcard;
      try {
        return wildcard || profileKeys.includes(repoKey(repo));
      } catch {
        return false;
      }
    }),
    identityPinned: true,
  };
}

/**
 * Structural problems with a profile's environment bindings; empty when sound.
 *
 * Returned rather than thrown so `config.ts` can report them as a configuration
 * error at startup, where a typo must stop the server rather than narrow or
 * widen a grant at the first call.
 */
export function environmentBindingProblems(profile: Profile): string[] {
  const entries = profile.environments ?? [];
  const problems: string[] = [];
  const names = new Set<string>();
  const publicIds = new Map<string, string>();
  const wildcard = allowsAnyRepo(profile.repos);
  const profileKeys = canonicalizableKeys(profile.repos);

  for (const entry of entries) {
    const name = entryName(entry);
    if (names.has(name)) {
      problems.push(`environment ${name} is listed more than once`);
    }
    names.add(name);

    if (typeof entry === "string") continue;

    const previous = publicIds.get(entry.publicId);
    if (previous !== undefined && previous !== name) {
      problems.push(
        `environments ${previous} and ${name} both claim publicId ${entry.publicId}; ` +
          "one environmentPublicId identifies one environment",
      );
    }
    publicIds.set(entry.publicId, name);

    for (const repo of entry.repos ?? []) {
      if (repo === REPO_WILDCARD) {
        problems.push(
          `environment ${name} uses "${REPO_WILDCARD}" in repos; the wildcard belongs on the profile, ` +
            "and a binding inherits it by omitting repos",
        );
        continue;
      }
      let key: string;
      try {
        key = repoKey(repo);
      } catch {
        problems.push(
          `environment ${name} names repository ${repo}, which is not a GitHub owner/name or URL`,
        );
        continue;
      }
      if (!wildcard && !profileKeys.includes(key)) {
        problems.push(
          `environment ${name} names repository ${key}, which is not in the profile's repos; ` +
            "a per-environment list narrows the profile allowlist and can never widen it",
        );
      }
    }
  }
  return problems;
}

/**
 * Resolve a named-environment target, refusing one the profile does not name.
 *
 * Match is exact after trim: environment names are Cursor identifiers, not
 * GitHub paths, so they are not case-folded. An empty or omitted list permits
 * nothing — the same fail-closed rule as `repos`.
 */
export function resolveEnvironmentBinding(
  profile: Profile | undefined,
  name: string,
): ResolvedEnvironmentBinding {
  if (profile === undefined) {
    throw new PolicyError(
      "no policy file, so this server is read-only; no named environment may be targeted",
    );
  }
  const entries = profile.environments ?? [];
  const wanted = name.trim();
  if (!wanted) throw new PolicyError("environment name must be non-empty");
  if (profile.environmentAccess === "account") {
    const declared = entries.find(e => entryName(e) === wanted);
    return declared === undefined
      ? { name: wanted, repos: [...profile.repos], identityPinned: false }
      : resolveEntry(profile, declared);
  }
  if (entries.length === 0) {
    throw new PolicyError(`the active profile names no environments; observed environment ${wanted} is not allowed; configure account access or add an environment grant`);
  }
  const entry = entries.find((candidate) => entryName(candidate) === wanted);
  if (entry === undefined) {
    throw new PolicyError(
      `environment ${wanted} is not in the active profile; permitted: ` +
        entries.map(entryName).join(", "),
    );
  }
  return resolveEntry(profile, entry);
}

export function assertEnvironmentAllowed(
  profile: Profile | undefined,
  name: string,
): string {
  return resolveEnvironmentBinding(profile, name).name;
}

/**
 * Refuse an `environmentPublicId` that contradicts the pinned one.
 *
 * Only a pinned binding can decide this. With nothing pinned there is no
 * out-of-band answer to compare against, so the caller's declared id stands and
 * the absence is reported rather than treated as agreement.
 */
export function assertEnvironmentIdentity(
  profile: Profile | undefined,
  name: string,
  environmentPublicId: string,
): ResolvedEnvironmentBinding {
  const binding = resolveEnvironmentBinding(profile, name);
  if (binding.publicId !== undefined && binding.publicId !== environmentPublicId) {
    throw new PolicyError(
      `environment ${binding.name} is pinned to environmentPublicId ${binding.publicId} in the ` +
        `active profile, not ${environmentPublicId}; the two identify different environments`,
    );
  }
  return binding;
}

/**
 * Enforce an environment's own repository allowlist for an existing agent.
 *
 * A per-environment list is the narrower grant, so it is the one that decides.
 * Missing repository metadata fails closed exactly as it does on the profile
 * path: this server does not opt into no-repository agents.
 */
export function assertEnvironmentReposAllowed(
  profile: Profile | undefined,
  name: string,
  repos: string[] | undefined,
): void {
  if (profile === undefined) return;
  const binding = resolveEnvironmentBinding(profile, name);
  if (repos === undefined || repos.length === 0) {
    throw new PolicyError("agent repository metadata is unavailable");
  }
  if (allowsAnyRepo(binding.repos)) {
    // Still canonicalized: the wildcard waives membership, not validity.
    for (const repo of repos) canonicalRepo(repo);
    return;
  }
  const allowed = binding.repos.map(repoKey);
  for (const repo of repos) {
    const canonical = canonicalRepo(repo);
    if (!allowed.includes(canonical.key)) {
      throw new PolicyError(
        `repository ${canonical.key} is not attached to environment ${binding.name} in the ` +
          `active profile; permitted: ${allowed.join(", ") || "(none)"}`,
      );
    }
  }
}

/**
 * Decide `autoCreatePR`.
 *
 * A profile that pins it wins, and a call that asks for the opposite is refused
 * rather than silently corrected -- the caller should learn that the operator
 * decided this, not watch its argument disappear.
 */
export function resolveAutoCreatePR(
  profile: Profile | undefined,
  requested: boolean | undefined,
): boolean {
  const pinned = profile?.autoCreatePR;
  if (pinned !== undefined) {
    if (requested !== undefined && requested !== pinned) {
      throw new PolicyError(
        `the active profile pins autoCreatePR to ${pinned}; it cannot be set to ${requested}`,
      );
    }
    return pinned;
  }
  return requested ?? false;
}

/** One supervisor choice for all agent creation paths; no transport/readback claim. */
export function resolveModel(profile: Profile | undefined, requested: ModelInput | undefined): ModelInput | undefined {
  const pinned = profile?.model;
  if (pinned !== undefined && requested !== undefined && !sameModel(requested, pinned)) {
    throw new PolicyError(`the active profile pins model to ${typeof pinned === "string" ? pinned : JSON.stringify(pinned)}; it cannot be set to ${typeof requested === "string" ? requested : JSON.stringify(requested)}`);
  }
  return pinned ?? requested;
}

/** Cursor documents a maximum of 20 repositories on create. */
const MAX_LAUNCH_REPOS = 20;

export interface LaunchRepo {
  url: string;
  startingRef?: string;
  /** An existing pull request on `url` for the agent to work on. */
  prUrl?: string;
}

export type ResolvedCreateAgentLaunch =
  | { kind: "no-repository" }
  | {
      kind: "repository";
      repos: LaunchRepo[];
      workOnCurrentBranch?: boolean;
    }
  | {
      kind: "environment";
      name: string;
    };

export interface CreateAgentLaunchArgs {
  noRepository?: boolean;
  repo?: string;
  repos?: Array<{ url: string; startingRef?: string; prUrl?: string }>;
  startingRef?: string;
  prUrl?: string;
  environment?: string;
  workOnCurrentBranch?: boolean;
}

/**
 * Decide the create-agent target, refusing combinations Cursor cannot honor
 * and inferring no-repository mode only when all target/source options are absent.
 *
 * Named-environment selection is a secrets-and-egress grant. Explicit `repos`
 * are omitted on that path; attached repositories are enforced on readback.
 */
export function resolveCreateAgentLaunch(
  profile: Profile | undefined,
  args: CreateAgentLaunchArgs,
): ResolvedCreateAgentLaunch {
  const hasTargetOptions = args.repo !== undefined || args.repos !== undefined ||
    args.environment !== undefined || args.startingRef !== undefined ||
    args.prUrl !== undefined || args.workOnCurrentBranch !== undefined;
  if (args.noRepository === true || (args.noRepository === undefined && !hasTargetOptions)) {
    if (hasTargetOptions) {
      throw new PolicyError("noRepository cannot be combined with repository, environment, or source options");
    }
    if (!allowsNoRepository(profile)) {
      throw new PolicyError("no-repository agents are not permitted in this profile (allowNoRepository)");
    }
    return { kind: "no-repository" };
  }

  if (args.environment !== undefined && args.environment.trim() === "") {
    throw new PolicyError("environment name must be non-empty");
  }

  const environment =
    args.environment === undefined ? undefined : args.environment.trim();
  const repoEntries = args.repos;
  const namesExplicitRepos = args.repo !== undefined || repoEntries !== undefined;

  if (args.repo !== undefined && repoEntries !== undefined) {
    throw new PolicyError(
      "pass repo or repos, not both; the launch target would be ambiguous",
    );
  }

  if (environment !== undefined && namesExplicitRepos) {
    throw new PolicyError(
      "named environments cannot be combined with explicit repositories; Cursor will not honor both",
    );
  }

  if (environment !== undefined && args.startingRef !== undefined) {
    throw new PolicyError(
      "startingRef cannot be set on a named-environment launch; Cursor omits repos and cannot honor the ref",
    );
  }

  if (environment !== undefined && args.prUrl !== undefined) {
    throw new PolicyError(
      "prUrl cannot be set on a named-environment launch; Cursor omits repos and cannot attach the pull request",
    );
  }

  if (environment !== undefined && args.workOnCurrentBranch !== undefined) {
    throw new PolicyError(
      "workOnCurrentBranch cannot be set on a named-environment launch; Cursor omits repos and cannot honor source pinning",
    );
  }

  if (
    environment === undefined &&
    args.repo === undefined &&
    (repoEntries === undefined || repoEntries.length === 0)
  ) {
    throw new PolicyError(
      "missing launch target; pass repo, repos, an allowed environment, or explicit noRepository",
    );
  }

  if (environment !== undefined) {
    const binding = resolveEnvironmentBinding(profile, environment);
    if (profile === undefined || binding.repos.length === 0) {
      throw new PolicyError(
        "named-environment launch requires the profile to name the repositories that environment attaches; " +
          "an empty repos list permits none",
      );
    }
    return { kind: "environment", name: binding.name };
  }

  if (repoEntries !== undefined) {
    if (args.startingRef !== undefined) {
      throw new PolicyError(
        "startingRef applies to repo, not to repos; set startingRef on each repository entry",
      );
    }
    if (args.prUrl !== undefined) {
      throw new PolicyError(
        "prUrl applies to repo, not to repos; set prUrl on each repository entry",
      );
    }
    if (repoEntries.length > MAX_LAUNCH_REPOS) {
      throw new PolicyError(
        `at most ${MAX_LAUNCH_REPOS} repositories may be targeted`,
      );
    }
    return repositoryLaunch(
      repoEntries.map((entry) =>
        launchRepo(profile, entry.url, entry.startingRef, entry.prUrl),
      ),
      args.workOnCurrentBranch,
    );
  }

  if (args.repo === undefined) {
    throw new PolicyError(
      "missing launch target; pass repo, repos, an allowed environment, or explicit noRepository",
    );
  }

  return repositoryLaunch(
    [launchRepo(profile, args.repo, args.startingRef, args.prUrl)],
    args.workOnCurrentBranch,
  );
}

/** `https://github.com/<owner>/<name>/pull/<number>`, nothing more. */
const PULL_REQUEST_PATH = new RegExp("^/([^/]+)/([^/]+)/pull/([1-9][0-9]*)/?$");

/** One pull request URL that passed the shape check. */
export interface PullRequestUrl {
  /** `https://github.com/<owner>/<name>/pull/<number>`, with nothing else. */
  canonical: string;
  /** The repository the pull request lives on, as a `repoKey`. */
  repo: string;
}

/**
 * Check the *shape* of a pull request URL: https, github.com, no credentials, no
 * query, no fragment, and an owner/name/number path.
 *
 * Separated from the repository match below because a filter has no repository
 * to match against -- `cursor_list_agents` asks Cursor which agents a PR belongs
 * to, so the URL is a query value rather than a push target. The rules a filter
 * does need are the same ones, and they are stated once.
 */
export function assertPullRequestUrlShape(prUrl: string): PullRequestUrl {
  let parsed: URL;
  try {
    parsed = new URL(prUrl.trim());
  } catch {
    throw new PolicyError(`prUrl ${JSON.stringify(prUrl)} is not a URL`);
  }
  const match = PULL_REQUEST_PATH.exec(parsed.pathname);
  if (
    parsed.protocol !== "https:" ||
    parsed.hostname !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    match === null
  ) {
    throw new PolicyError(
      `prUrl must be https://github.com/<owner>/<name>/pull/<number>; got ${JSON.stringify(prUrl)}`,
    );
  }
  return {
    canonical: `https://github.com/${match[1]}/${match[2]}/pull/${match[3]}`,
    repo: repoKey(`${match[1]}/${match[2]}`),
  };
}

/**
 * Check that a pull request URL belongs to the repository it is attached to.
 *
 * Cursor documents `prUrl` as the PR the agent works on and ignores
 * `startingRef` when it is present. A PR on a different repository would have
 * the agent push somewhere the allowlist never named, so the owner/name must
 * canonicalize to the same key as `url`.
 */
export function assertPullRequestUrl(repoUrl: string, prUrl: string): string {
  const pr = assertPullRequestUrlShape(prUrl);
  if (pr.repo !== repoKey(repoUrl)) {
    throw new PolicyError(
      `prUrl belongs to ${pr.repo}, not to the repository it is attached to (${repoKey(repoUrl)})`,
    );
  }
  return pr.canonical;
}

function launchRepo(
  profile: Profile | undefined,
  repo: string,
  startingRef: string | undefined,
  prUrl: string | undefined,
): LaunchRepo {
  const url = assertRepoAllowed(profile, repo);
  if (prUrl !== undefined && startingRef !== undefined) {
    throw new PolicyError(
      `repository ${repoKey(url)} names both prUrl and startingRef; Cursor ignores startingRef when ` +
        "prUrl is set, so pass one or the other",
    );
  }
  const entry: LaunchRepo = { url };
  if (startingRef !== undefined) entry.startingRef = startingRef;
  if (prUrl !== undefined) entry.prUrl = assertPullRequestUrl(url, prUrl);
  return entry;
}

function repositoryLaunch(
  repos: LaunchRepo[],
  workOnCurrentBranch: boolean | undefined,
): Extract<ResolvedCreateAgentLaunch, { kind: "repository" }> {
  const seen = new Set<string>();
  for (const repo of repos) {
    const key = repoKey(repo.url);
    if (seen.has(key)) {
      throw new PolicyError(
        `repository ${key} is named more than once; list each repository once`,
      );
    }
    seen.add(key);
  }
  if (workOnCurrentBranch === true && repos[0]?.startingRef === undefined) {
    throw new PolicyError(
      "workOnCurrentBranch requires a startingRef Cursor can push to; without it source pinning cannot be honored",
    );
  }
  return workOnCurrentBranch === undefined
    ? { kind: "repository", repos }
    : { kind: "repository", repos, workOnCurrentBranch };
}

/**
 * Enforce both allowlists for an existing agent.
 *
 * A named `env.name` is a secrets-and-egress grant, not merely VM routing.
 * Empty repository metadata is a no-repository target; missing metadata still
 * fails closed. No-repository access follows the same policy as creation.
 */
export function assertAgentAccess(
  profile: Profile | undefined,
  agent: {
    repos?: Array<{ url: string }> | undefined;
    env?: { name?: string | undefined; type?: string | undefined } | undefined;
  },
): void {
  if (profile === undefined) return;
  const envName = agent.env?.name?.trim();
  const repos = agent.repos?.map((repo) => repo.url);
  if (!envName && repos !== undefined && repos.length === 0) {
    if (!allowsNoRepository(profile)) {
      throw new PolicyError("no-repository agents are not permitted in this profile (allowNoRepository)");
    }
    if (agent.env?.type !== undefined && agent.env.type !== "cloud") {
      throw new PolicyError("no-repository agent reported a non-cloud environment");
    }
    return;
  }
  if (envName !== undefined && envName !== "") {
    // The environment's own list is the narrower grant, so it decides. It
    // defaults to the profile's list, so an unbound name behaves as before.
    assertEnvironmentReposAllowed(profile, envName, repos);
    return;
  }
  assertAgentReposAllowed(profile, repos);
}

/** An explicit override wins; otherwise only launch-enabled profiles opt in. */
export function allowsNoRepository(profile: Profile | undefined): boolean {
  return profile?.allowNoRepository ?? isToolAllowed(profile, "cursor_create_agent", false);
}
