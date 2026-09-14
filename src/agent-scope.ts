/**
 * Session cache for Agent Lifecycle policy checks.
 *
 * Repository and named-environment allowlisting both apply. Selecting an
 * environment is a secrets-and-egress grant, not just VM routing. Missing
 * repository metadata fails closed; empty repositories follow no-repository policy.
 * See `docs/lifecycle-architecture.md`.
 */

import type { CursorClient } from "./client.js";
import { seg } from "./client.js";
import type { Profile } from "./config.js";
import { assertAgentAccess } from "./policy.js";
import type { Agent } from "./schemas.js";
import { AgentSchema } from "./schemas.js";

interface CachedAgent {
  repos: string[] | undefined;
  environment: string | undefined;
}

export class AgentScope {
  readonly #agents = new Map<string, CachedAgent>();
  readonly #client: CursorClient;
  readonly #profile: Profile | undefined;

  constructor(client: CursorClient, profile: Profile | undefined) {
    this.#client = client;
    this.#profile = profile;
  }

  /**
   * Whether a profile is being enforced at all.
   *
   * No profile means no scope question to answer, so a caller that would
   * otherwise spend one `resolve` read per distinct agent to label its results
   * can skip the read instead of paying for a verdict that is always "allowed".
   */
  get enforcing(): boolean {
    return this.#profile !== undefined;
  }

  remember(agent: Agent): void {
    // A failed or incomplete fresh observation must not leave an older grant alive.
    this.#agents.delete(agent.id);
    assertAgentAccess(this.#profile, agent);
    const environment = agent.env?.name?.trim();
    // Cursor may omit env until provisioning finishes. Recheck through GET next time.
    if (!environment) return;
    this.#agents.set(agent.id, {
      repos: agent.repos?.map((repo) => repo.url),
      environment:
        environment === undefined || environment === "" ? undefined : environment,
    });
  }

  permits(agent: Agent): boolean {
    try {
      this.remember(agent);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Judge an observation where it stands, without a network call.
   *
   * `unresolved` is not a verdict. Cursor's list endpoint documents durable
   * identity fields only, so `repos` may simply be absent -- and absent
   * repository metadata is the reason a check fails closed, not evidence that
   * this agent is out of scope. Treating the two as one answer made every thin
   * summary vanish from a list as if the account were empty.
   *
   * A caller that needs a verdict for an unresolved summary gets it from
   * `resolve`, which reads the full record and judges that. `permits` is not
   * consulted for a thin summary: on a record that says nothing it answers
   * "denied", which is the confusion this method exists to undo.
   *
   * A cached grant does not survive one, though. A thin summary is still a
   * sighting: it can report an environment the record that earned the grant did
   * not, and the caller may never reach `resolve` -- an item past a bounded
   * page's detail reads makes this the only place the newer sighting is seen at
   * all. So the grant goes here, and whatever asks next pays for a fresh record
   * rather than answering from a record the account has moved on from.
   */
  classify(agent: Agent): "allowed" | "denied" | "unresolved" {
    if (this.#profile === undefined) return "allowed";
    if (agent.repos === undefined) {
      this.#agents.delete(agent.id);
      return "unresolved";
    }
    return this.permits(agent) ? "allowed" : "denied";
  }

  /**
   * Decide a summary `classify` could not, from the record itself.
   *
   * Always a fresh read, never the session cache. A grant is earned by an
   * observation and speaks only for that observation: an agent that has since
   * moved to an environment outside the profile would otherwise be admitted on
   * the strength of the record it used to be, which is exactly what `remember`
   * deleting first exists to prevent. The cached grant is dropped up front, so a
   * lookup that fails or comes back undecided leaves nothing standing either.
   *
   * The verdict is `unresolved` again when the full record still carries no
   * repository metadata. That is the one thing this must not turn into a
   * refusal: the record was read, and it still did not say.
   */
  async resolve(
    agentId: string,
    options: { signal?: AbortSignal } = {},
  ): Promise<{ verdict: "allowed" | "denied" | "unresolved"; agent: Agent }> {
    this.#agents.delete(agentId);
    const agent = await this.#client.get(
      `/v1/agents/${seg(agentId)}`,
      AgentSchema,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    return { verdict: this.classify(agent), agent };
  }

  /**
   * `signal` bounds the uncached lookup; a caller with its own deadline (such
   * as cursor_wait_run) passes it so the lookup cannot outlive that deadline.
   */
  async assert(agentId: string, options: { signal?: AbortSignal } = {}): Promise<void> {
    if (this.#profile === undefined) return;
    const cached = this.#agents.get(agentId);
    if (cached !== undefined) {
      // The same check `remember` ran, so a cache hit is judged against the
      // environment-narrowed allowlist, not the wider profile list.
      assertAgentAccess(this.#profile, {
        repos: cached.repos?.map((url) => ({ url })),
        ...(cached.environment === undefined ? {} : { env: { name: cached.environment } }),
      });
      return;
    }
    const agent = await this.#client.get(
      `/v1/agents/${seg(agentId)}`,
      AgentSchema,
      options.signal === undefined ? {} : { signal: options.signal },
    );
    this.remember(agent);
  }
}
