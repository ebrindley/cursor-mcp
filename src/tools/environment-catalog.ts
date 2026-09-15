/**
 * Environment discovery and configuration reads.
 * Account profiles can discover environment names and repository associations
 * from agent pages. A configured CLI provides the saved-environment catalog
 * and configuration reads. Agent observations are explicitly partial.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CursorClient } from "../client.js";
import type { Policy } from "../config.js";
import { AgentListSchema } from "../schemas.js";
import { activeProfile } from "../config.js";
import {
  AGENT_INVENTORY,
  ENV_LIST_ARGS,
  cliAuthorityBlock,
  cursorCliReadiness,
  cursorCliRunner,
  envGetArgs,
  parseCliJson,
  type CliReadiness,
  type CliRun,
  type CliRunner,
  type CursorCli,
} from "../cursor-cli.js";
import {
  catalogLine,
  configurationLine,
  normalizeEnvironmentCatalog,
  normalizeEnvironmentConfiguration,
  type CliEnvironmentEntry,
  type CliEnvironmentScope,
} from "../cursor-cli-environments.js";
import { PolicyError } from "../errors.js";
import { resolveEnvironmentBinding } from "../policy.js";
import type { Profile } from "../config.js";
import { MeSchema } from "../schemas.js";
import { READ } from "./annotations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

export const ENVIRONMENT_LIST_TOOL = "cursor_list_environments";
export const ENVIRONMENT_CONFIGURATION_TOOL = "cursor_get_environment_configuration";

const Block = z.record(z.string(), z.unknown());

/**
 * Only `status` and `cli` are required.
 *
 * Every result -- available or not -- names the authority and its state, so the
 * unavailable answers are the same shape as the successful ones rather than a
 * different, thinner error.
 */
const RESULT_OUT = {
  status: z.string(),
  cli: Block,
  reason: z.string().optional(),
  nextSteps: z.array(z.string()).optional(),
  environments: z.array(Block).optional(),
  catalog: Block.optional(),
  nextCursor: z.string().optional(),
  configuration: Block.optional(),
};

const ScopeFilter = z
  .enum(["personal", "team", "unknown"])
  .describe("Keep only environments the CLI reports with this ownership scope.");

const PublicIdArg = z
  .string()
  .trim()
  .min(1)
  .max(200)
  .regex(
    /^[A-Za-z0-9_.:-]+$/,
    "environmentPublicId must be one opaque identifier token with no whitespace",
  )
  // A leading dash is a legal character in the token grammar and an illegal
  // start: `--help` would reach the CLI as a flag rather than an identifier.
  .refine(
    (value) => !value.startsWith("-"),
    "environmentPublicId must not begin with a dash",
  )
  .describe(
    "Public opaque environmentPublicId, as cursor_list_environments reports it. Never a numeric internal id.",
  );

/** A read that could not run. Same fields as a successful one, minus the data. */
function unavailable(
  readiness: Extract<CliReadiness, { ready: false }>,
  policy: Policy,
): ReturnType<typeof ok> {
  return ok({
    source: "cursor CLI capability check",
    text: [`${readiness.status}: ${readiness.reason}`, ...readiness.nextSteps].join("\n"),
    structured: {
      status: readiness.status,
      cli: cliAuthorityBlock(readiness),
      reason: readiness.reason,
      nextSteps: readiness.nextSteps,
    },
    policy,
  });
}

/** A CLI that ran but did not produce a usable payload. Still not a fallback. */
function rejected(
  args: { status: string; reason: string; readiness: CliReadiness },
  policy: Policy,
): ReturnType<typeof ok> {
  return ok({
    source: "cursor CLI output",
    text: `${args.status}: ${args.reason}\n${AGENT_INVENTORY}`,
    structured: {
      status: args.status,
      cli: cliAuthorityBlock(args.readiness),
      reason: args.reason,
      nextSteps: [
        "The CLI answered, but not in a shape this server will parse. Nothing is retried through a delegated run.",
        AGENT_INVENTORY,
      ],
    },
    policy,
  });
}

/**
 * Why a command that did run produced no answer.
 *
 * Truncation is checked before the exit code on purpose: stopping an oversized
 * child leaves it dead by signal, and reporting that as a generic command failure
 * would hide the byte ceiling that actually caused it.
 */
function commandProblem(
  run: CliRun,
  cli: CursorCli,
  label: string,
): { status: string; reason: string } | undefined {
  if (run.truncated) {
    return {
      status: "CLI_OUTPUT_OVERSIZED",
      reason:
        `The CLI wrote more than ${cli.maxOutputBytes} bytes while ${label}; the payload was cut ` +
        "and is not parsed.",
    };
  }
  if (run.outcome === "timed-out") {
    return {
      status: "CLI_TIMED_OUT",
      reason: `The CLI did not finish ${label} within ${cli.timeoutMs} ms and was terminated.`,
    };
  }
  if (run.outcome === "spawn-failed") {
    return {
      status: "CLI_MISSING",
      reason: `The CLI could not be started while ${label}.`,
    };
  }
  if (run.exitCode !== 0) {
    return {
      status: "CLI_COMMAND_FAILED",
      reason: `The CLI exited ${run.exitCode ?? "on a signal"} while ${label}.`,
    };
  }
  return undefined;
}

/**
 * `undefined` when the key names no owner.
 *
 * Fetched here rather than inside `cursor-cli.ts`, which deliberately holds
 * neither the API key nor a client: the identity gate compares two values it is
 * handed, and never obtains the CLI's credential or ours.
 */
/**
 * Is this catalog entry one the active profile names?
 *
 * The CLI lists every environment the login can see; the profile lists the
 * ones this server may act on. A name the profile does not list, or a pinned
 * binding whose id disagrees with the CLI's, is outside the grant.
 */
function inProfile(profile: Profile | undefined, entry: CliEnvironmentEntry): boolean {
  if (entry.name === undefined) return false;
  try {
    const binding = resolveEnvironmentBinding(profile, entry.name);
    return binding.publicId === undefined || binding.publicId === entry.environmentPublicId;
  } catch {
    return false;
  }
}

/** True when a structured binding pins exactly this id. */
function pinnedInProfile(profile: Profile | undefined, environmentPublicId: string): boolean {
  return (profile?.environments ?? []).some(
    (entry) => typeof entry !== "string" && entry.publicId === environmentPublicId,
  );
}

async function restEmail(client: CursorClient): Promise<string | undefined> {
  const me = await client.get("/v1/me", MeSchema);
  return me.userEmail;
}

export function registerEnvironmentCatalogTools(
  server: McpServer,
  client: CursorClient,
  policy: Policy,
  /** Test seam. Production builds it from the operator's `cursorCli` block. */
  runner: CliRunner | undefined = policy.cursorCli === undefined
    ? undefined
    : cursorCliRunner(policy.cursorCli),
): string[] {
  const profile = activeProfile(policy);
  const registered: string[] = [];

  const define = <C extends GateableConfig, A extends unknown[]>(
    spec: ToolSpec<C, A>,
  ) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  /**
   * Configuration, registration, and identity, in that order.
   *
   * `/v1/me` is only called once a CLI is configured and reads are enabled:
   * otherwise the answer is already known and a REST round trip would buy
   * nothing.
   */
  const readiness = async (): Promise<CliReadiness> => {
    const cli = policy.cursorCli;
    if (cli === undefined || runner === undefined || !cli.environmentReads) {
      return cursorCliReadiness({ cli, runner, restEmail: undefined });
    }
    return cursorCliReadiness({
      cli,
      runner,
      getRestEmail: () => restEmail(client),
    });
  };

  define({
    name: ENVIRONMENT_LIST_TOOL,
    config: {
      title: "Cursor: list environments",
      description:
        "Discover environments and their repositories. Uses a configured CLI catalog when available. Profiles with environmentAccess \"account\" otherwise report environment names observed on agents launched with a named environment (partial); other profiles report the CLI status only. Existing agents themselves are listed by cursor_list_agents. Use these associations with the current project Git remote; ask only if the task target is ambiguous.",
      inputSchema: { scope: ScopeFilter.optional(), cursor: z.string().optional() },
      outputSchema: RESULT_OUT,
      annotations: READ,
    },
    handler: async (call: { scope?: CliEnvironmentScope; cursor?: string }) => {
      const state = await readiness();
      if (!state.ready && profile?.environmentAccess === "account") {
        const page = await client.get("/v1/agents", AgentListSchema, {
          query: { limit: 100, cursor: call.cursor, includeArchived: true },
        });
        const observed = new Map<string, Set<string>>();
        for (const agent of page.items) {
          const name = agent.env?.name?.trim();
          if (!name || agent.env?.type !== "cloud") continue;
          const repos = observed.get(name) ?? new Set<string>();
          for (const repo of agent.repos ?? []) repos.add(repo.url);
          observed.set(name, repos);
        }
        const environments = call.scope && call.scope !== "unknown" ? [] :
          [...observed].map(([name, repos]) => ({ name, repos: [...repos], scope: "unknown" }));
        return ok({
          source: "GET /v1/agents",
          text: "Environments observed on this agent page; not a complete saved-environment catalog. Ownership scope is unknown.\n" +
            (environments.map(e => `${e.name}: ${e.repos.join(", ") || "repositories not reported"}`).join("\n") || "(no matching names on this page)") +
            `\n${AGENT_INVENTORY}`,
          structured: {
            status: "OBSERVED",
            cli: cliAuthorityBlock(state),
            nextSteps: [AGENT_INVENTORY],
            environments,
            catalog: { source: "agents", complete: false, scanned: page.items.length, returned: environments.length },
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          },
          policy,
        });
      }
      if (!state.ready) return unavailable(state, policy);
      // Issued only because `state.ready` proves `env` is a registered command
      // and the CLI's login matches this key's account.
      const cli = state.cli;
      const run = await state.run(ENV_LIST_ARGS);
      const problem = commandProblem(run, cli, "listing environments");
      if (problem !== undefined) {
        return rejected({ ...problem, readiness: state }, policy);
      }

      const parsed = parseCliJson(run, cli.maxOutputBytes);
      if (!parsed.ok) {
        return rejected(
          { status: parsed.code, reason: parsed.message, readiness: state },
          policy,
        );
      }
      const normalized = normalizeEnvironmentCatalog(parsed.value);
      if (!normalized.ok) {
        return rejected(
          { status: normalized.code, reason: normalized.message, readiness: state },
          policy,
        );
      }

      const entries =
        call.scope === undefined
          ? normalized.catalog.entries
          : normalized.catalog.entries.filter((entry) => entry.scope === call.scope);

      return ok({
        source: "cursor CLI env list",
        text:
          entries
            .map(
              (entry) =>
                `${catalogLine(entry)}${inProfile(profile, entry) ? "  [in profile]" : ""}`,
            )
            .join("\n") || "(no environments reported)",
        structured: {
          status: "LISTED",
          cli: cliAuthorityBlock(state),
          // Names are discovery, not a grant: every environment the login can
          // see is listed, and `inProfile` says which ones this server may act
          // on or read configuration for.
          environments: entries.map((entry) => ({
            ...entry,
            inProfile: inProfile(profile, entry),
          })),
          catalog: {
            returned: entries.length,
            reported: normalized.catalog.entries.length,
            dropped: normalized.catalog.dropped,
            truncated: normalized.catalog.truncated,
          },
        },
        policy,
      });
    },
  });

  define({
    name: ENVIRONMENT_CONFIGURATION_TOOL,
    config: {
      title: "Cursor: get environment configuration",
      description:
        "Read one environment's configuration candidates, source, precedence, and digest through a configured Cursor CLI. Scripts stay digests.",
      inputSchema: { environmentPublicId: PublicIdArg },
      outputSchema: RESULT_OUT,
      annotations: READ,
    },
    handler: async (call: { environmentPublicId: string }) => {
      // Validated first so a malformed id is refused before any process spawns.
      const getArgs = envGetArgs(call.environmentPublicId);
      const state = await readiness();
      if (!state.ready) return unavailable(state, policy);
      const cli = state.cli;

      // Configuration digests describe an environment's Install and Start
      // scripts, so they are read only for environments the profile names. A
      // pinned id is authoritative on its own; an unpinned name is resolved
      // through the CLI's own catalog first.
      if (!pinnedInProfile(profile, call.environmentPublicId)) {
        const listing = await state.run(ENV_LIST_ARGS);
        const listProblem = commandProblem(listing, cli, "listing environments");
        if (listProblem !== undefined) {
          return rejected({ ...listProblem, readiness: state }, policy);
        }
        const listed = parseCliJson(listing, cli.maxOutputBytes);
        if (!listed.ok) {
          return rejected(
            { status: listed.code, reason: listed.message, readiness: state },
            policy,
          );
        }
        const catalog = normalizeEnvironmentCatalog(listed.value);
        if (!catalog.ok) {
          return rejected(
            { status: catalog.code, reason: catalog.message, readiness: state },
            policy,
          );
        }
        const entry = catalog.catalog.entries.find(
          (candidate) => candidate.environmentPublicId === call.environmentPublicId,
        );
        if (entry === undefined || !inProfile(profile, entry)) {
          throw new PolicyError(
            `environment ${call.environmentPublicId} is not in the active profile` +
              (entry?.name === undefined
                ? "; the CLI catalog reports no environment with that id"
                : `; add ${entry.name} to \`environments\` in the policy file`),
          );
        }
      }

      const run = await state.run(getArgs);
      const problem = commandProblem(run, cli, "reading the configuration");
      if (problem !== undefined) {
        return rejected({ ...problem, readiness: state }, policy);
      }

      const parsed = parseCliJson(run, cli.maxOutputBytes);
      if (!parsed.ok) {
        return rejected(
          { status: parsed.code, reason: parsed.message, readiness: state },
          policy,
        );
      }
      const normalized = normalizeEnvironmentConfiguration({
        environmentPublicId: call.environmentPublicId,
        payload: parsed.value,
      });
      if (!normalized.ok) {
        return rejected(
          { status: normalized.code, reason: normalized.message, readiness: state },
          policy,
        );
      }

      const read = normalized.read;
      return ok({
        source: "cursor CLI env get",
        text: [
          `environment=${read.environmentPublicId}  classification=${read.classification}` +
            `  digest=${read.digest ?? "(none agreed)"}`,
          ...read.candidates.map(configurationLine),
        ].join("\n"),
        structured: {
          status: "CONFIGURATION_READ",
          cli: cliAuthorityBlock(state),
          configuration: {
            environmentPublicId: read.environmentPublicId,
            classification: read.classification,
            ...(read.digest === undefined ? {} : { digest: read.digest }),
            truncated: read.truncated,
            candidates: read.candidates.map((candidate) => ({ ...candidate })),
          },
        },
        policy,
      });
    },
  });

  return registered;
}
