/**
 * The Environment Catalog tool surface.
 *
 * End-to-end over an in-memory MCP transport, with the CLI replaced by a stub
 * runner: this file is about what crosses the MCP boundary, not about spawning
 * (`cursor-cli.test.ts` owns that against real child processes).
 *
 * Two invariants get the most attention. The tools exist whether or not a CLI
 * does, so an absent authority is an answer rather than a missing tool. And no
 * path through either tool reaches a delegated run.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { CursorClient } from "../src/client.js";
import type { Policy } from "../src/config.js";
import { CursorCliSchema } from "../src/cursor-cli.js";
import type { CliRun, CliRunner, CursorCli } from "../src/cursor-cli.js";
import {
  ENVIRONMENT_CONFIGURATION_TOOL,
  ENVIRONMENT_LIST_TOOL,
  registerEnvironmentCatalogTools,
} from "../src/tools/environment-catalog.js";

const OWNER = "owner@example.com";

const cursorCli = (overrides: Record<string, unknown> = {}): CursorCli =>
  CursorCliSchema.parse({
    path: "/opt/cursor/bin/cursor",
    compatibleVersions: ["1.2.3"],
    environmentReads: true,
    ...overrides,
  });

/** `null` means "no CLI at all"; an explicit `undefined` would take the default. */
const policyWith = (
  tools: string[],
  cli: CursorCli | null = cursorCli(),
  environments: Array<string | { name: string; publicId: string; scope: "personal" | "team" }> = [
    "alpha",
  ],
): Policy => ({
  deleteEnabled: false,
  activationEnabled: false,
  defaultProfile: "p",
  maxResponseBytes: 32_768,
  profiles: { p: { repos: [], tools, environments } },
  ...(cli === null ? {} : { cursorCli: cli }),
});

/** A CursorClient whose only answer is `GET /v1/me`. */
function meClient(userEmail: string | undefined = OWNER): CursorClient {
  return new CursorClient({
    apiKey: "sk-test",
    baseUrl: "https://api.example.test",
    fetchImpl: async () =>
      new Response(
        JSON.stringify({
          apiKeyName: "test-key",
          createdAt: "2026-01-01T00:00:00.000Z",
          ...(userEmail === undefined ? {} : { userEmail }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
  });
}

const exited = (stdout: string, exitCode = 0): CliRun => ({
  outcome: "exited",
  exitCode,
  signal: null,
  stdout,
  stderr: "",
  truncated: false,
});

const HELP = ["Commands:", "  env     Manage environments", "  status  Show login"].join(
  "\n",
);

/**
 * A stub CLI that answers exactly the vectors it is given, and records the rest.
 *
 * An unexpected vector answers with an error rather than something plausible, so
 * a test cannot pass because the tool asked a different question.
 */
function stubRunner(answers: Record<string, CliRun>): CliRunner & { calls: string[] } {
  const calls: string[] = [];
  const runner = async (args: readonly string[]): Promise<CliRun> => {
    const key = args.join(" ");
    calls.push(key);
    return answers[key] ?? exited("", 64);
  };
  return Object.assign(runner, { calls });
}

const registeredAnswers = (
  extra: Record<string, CliRun> = {},
): Record<string, CliRun> => ({
  "--version": exited("cursor 1.2.3\n"),
  "--help": exited(HELP),
  "status --output json": exited(JSON.stringify({ user: { email: OWNER } })),
  ...extra,
});

async function connect(
  policy: Policy,
  runner: CliRunner | undefined,
  client: CursorClient = meClient(),
) {
  const server = new McpServer({ name: "cursor-mcp", version: "test" });
  registerEnvironmentCatalogTools(server, client, policy, runner);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(serverSide), mcp.connect(clientSide)]);
  return mcp;
}

async function invoke(
  policy: Policy,
  runner: CliRunner | undefined,
  name: string,
  args: Record<string, unknown> = {},
  client?: CursorClient,
) {
  const mcp = await connect(policy, runner, client);
  const result = await mcp.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    text: (result.content as Array<{ text: string }>)
      .map((entry) => entry.text)
      .join("\n"),
  };
}

describe("registration", () => {
  it("registers both tools under the read-only wildcard", () => {
    const server = new McpServer({ name: "t", version: "t" });
    const registered = registerEnvironmentCatalogTools(
      server,
      meClient(),
      policyWith(["read:*"]),
      stubRunner({}),
    );
    expect(registered.sort()).toEqual(
      [ENVIRONMENT_CONFIGURATION_TOOL, ENVIRONMENT_LIST_TOOL].sort(),
    );
  });

  it("registers both tools with no CLI configured at all", () => {
    const server = new McpServer({ name: "t", version: "t" });
    const registered = registerEnvironmentCatalogTools(
      server,
      meClient(),
      policyWith(["read:*"], null),
      undefined,
    );
    expect(registered).toHaveLength(2);
  });

  it("registers nothing when the profile permits nothing", () => {
    const server = new McpServer({ name: "t", version: "t" });
    expect(
      registerEnvironmentCatalogTools(
        server,
        meClient(),
        policyWith([]),
        stubRunner({}),
      ),
    ).toEqual([]);
  });
});

describe("availability results", () => {
  it("reports CLI_NOT_CONFIGURED without calling /v1/me", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new CursorClient({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test",
      fetchImpl,
    });
    const result = await invoke(
      policyWith(["read:*"], null),
      undefined,
      ENVIRONMENT_LIST_TOOL,
      {},
      client,
    );
    expect(result.structured.status).toBe("CLI_NOT_CONFIGURED");
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(result.structured.environments).toBeUndefined();
  });

  it("reports CLI_READS_DISABLED for a configured CLI whose reads are off", async () => {
    const runner = stubRunner(registeredAnswers());
    const result = await invoke(
      policyWith(["read:*"], cursorCli({ environmentReads: false })),
      runner,
      ENVIRONMENT_LIST_TOOL,
    );
    expect(result.structured.status).toBe("CLI_READS_DISABLED");
    // Nothing was asked of the CLI at all.
    expect(runner.calls).toEqual([]);
  });

  it("reports CLI_FEATURE_GATED and issues no environment command", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const client = new CursorClient({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test",
      fetchImpl,
    });
    const runner = stubRunner({
      "--version": exited("cursor 1.2.3\n"),
      "--help": exited("Usage: cursor <prompt>\n\nOptions:\n  --help  Show help\n"),
    });
    const result = await invoke(
      policyWith(["read:*"]),
      runner,
      ENVIRONMENT_LIST_TOOL,
      {},
      client,
    );
    expect(result.structured.status).toBe("CLI_FEATURE_GATED");
    expect(runner.calls).toEqual(["--version", "--help"]);
    const cli = result.structured.cli as Record<string, unknown>;
    expect(cli.authority).toBe("cursor-cli");
    expect(cli.availability).toBe("FEATURE_GATED");
    expect(cli.commands).toEqual([]);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports CLI_INCOMPATIBLE with the version it found", async () => {
    const runner = stubRunner({ "--version": exited("cursor 9.9.9\n") });
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_LIST_TOOL);
    expect(result.structured.status).toBe("CLI_INCOMPATIBLE");
    const cli = result.structured.cli as Record<string, unknown>;
    expect(cli.version).toBe("cursor 9.9.9");
    expect(cli.compatible).toBe(false);
  });

  it("reports CLI_IDENTITY_MISMATCH before any environment command runs", async () => {
    const runner = stubRunner(
      registeredAnswers({
        "status --output json": exited(
          JSON.stringify({ user: { email: "someone-else@example.com" } }),
        ),
        "env list --output json": exited(
          JSON.stringify({ environments: [{ environmentPublicId: "env-other" }] }),
        ),
      }),
    );
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_LIST_TOOL);
    expect(result.structured.status).toBe("CLI_IDENTITY_MISMATCH");
    expect(runner.calls).not.toContain("env list --output json");
    expect(result.text).not.toContain("someone-else@example.com");
    expect(result.text).not.toContain(OWNER);
  });

  it("names no delegated fallback in any unavailable result, but does name the agent list", async () => {
    const runner = stubRunner({ "--version": exited("cursor 9.9.9\n") });
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_LIST_TOOL);
    expect(result.text).toMatch(/does not fall back to a delegated run/);
    expect(result.text).toMatch(/cursor_list_agents/);
  });
});

describe(ENVIRONMENT_LIST_TOOL, () => {
  const listAnswers = registeredAnswers({
    "env list --output json": exited(
      JSON.stringify({
        environments: [
          {
            id: 1234,
            environmentPublicId: "env-alpha",
            name: "alpha",
            scope: "personal",
            repos: ["ExampleOrg/ExampleRepo"],
            updatedAtMs: 1_756_100_000_000,
          },
          {
            environmentPublicId: "env-beta",
            name: "beta",
            owningTeam: 7,
          },
          { id: 4321 },
        ],
      }),
    ),
  });

  it("normalizes the catalog and keeps internal ids out of the result", async () => {
    const result = await invoke(
      policyWith(["read:*"]),
      stubRunner(listAnswers),
      ENVIRONMENT_LIST_TOOL,
    );
    expect(result.structured.status).toBe("LISTED");
    const environments = result.structured.environments as Array<Record<string, unknown>>;
    expect(environments.map((entry) => entry.environmentPublicId)).toEqual([
      "env-alpha",
      "env-beta",
    ]);
    expect(environments[0]?.scope).toBe("personal");
    expect(environments[1]?.scope).toBe("team");
    // alpha is named by the profile; beta is listed for discovery but not granted.
    expect(environments[0]?.inProfile).toBe(true);
    expect(environments[1]?.inProfile).toBe(false);
    expect(result.text).toContain("[in profile]");
    expect(result.structured.catalog).toMatchObject({
      returned: 2,
      reported: 2,
      dropped: 1,
      truncated: false,
    });
    expect(JSON.stringify(result.structured)).not.toContain("1234");
    expect(JSON.stringify(result.structured)).not.toContain("4321");
  });

  it("filters by scope without asking the CLI a second time", async () => {
    const runner = stubRunner(listAnswers);
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_LIST_TOOL, {
      scope: "team",
    });
    const environments = result.structured.environments as Array<Record<string, unknown>>;
    expect(environments.map((entry) => entry.environmentPublicId)).toEqual(["env-beta"]);
    expect(runner.calls.filter((call) => call.startsWith("env list"))).toHaveLength(1);
  });

  it("reports an oversized answer instead of parsing the fragment", async () => {
    const runner = stubRunner(
      registeredAnswers({
        "env list --output json": {
          ...exited('{"environments":[{"environmentPublicId":"env-a"'),
          truncated: true,
        },
      }),
    );
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_LIST_TOOL);
    expect(result.structured.status).toBe("CLI_OUTPUT_OVERSIZED");
    expect(result.structured.environments).toBeUndefined();
  });

  it("reports prose-wrapped output as unparseable", async () => {
    const runner = stubRunner(
      registeredAnswers({
        "env list --output json": exited('Fetching...\n{"environments":[]}\nDone.\n'),
      }),
    );
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_LIST_TOOL);
    expect(result.structured.status).toBe("CLI_OUTPUT_NOT_JSON");
  });

  it("reports a failing command as a failure, not an empty catalog", async () => {
    const runner = stubRunner(
      registeredAnswers({ "env list --output json": exited("", 1) }),
    );
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_LIST_TOOL);
    expect(result.structured.status).toBe("CLI_COMMAND_FAILED");
    expect(result.structured.environments).toBeUndefined();
    expect(result.text).toMatch(/cursor_list_agents/);
  });

  it("reports a timeout as a timeout", async () => {
    const runner = stubRunner(
      registeredAnswers({
        "env list --output json": {
          outcome: "timed-out",
          exitCode: null,
          signal: "SIGTERM",
          stdout: "",
          stderr: "",
          truncated: false,
        },
      }),
    );
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_LIST_TOOL);
    expect(result.structured.status).toBe("CLI_TIMED_OUT");
  });
});

describe(ENVIRONMENT_CONFIGURATION_TOOL, () => {
  const configAnswers = registeredAnswers({
    "env list --output json": exited(
      JSON.stringify({
        environments: [
          { environmentPublicId: "env-alpha", name: "alpha", scope: "personal" },
          { environmentPublicId: "env-beta", name: "beta", scope: "personal" },
        ],
      }),
    ),
    "env get env-beta --output json": exited(
      JSON.stringify({ environmentPublicId: "env-beta", candidates: [] }),
    ),
    "env get env-alpha --output json": exited(
      JSON.stringify({
        environmentPublicId: "env-alpha",
        candidates: [
          {
            source: "repository",
            environmentJsonPath: ".cursor/environment.json",
            environmentJson: {
              install: "npm ci && export TOKEN=hunter2",
              start: "npm start",
            },
          },
          {
            source: "database",
            environmentJson: null,
            environmentJsonNote: "Configuration is owner-restricted.",
          },
        ],
      }),
    ),
  });

  it("returns classified candidates and no script text", async () => {
    const result = await invoke(
      policyWith(["read:*"]),
      stubRunner(configAnswers),
      ENVIRONMENT_CONFIGURATION_TOOL,
      { environmentPublicId: "env-alpha" },
    );
    expect(result.structured.status).toBe("CONFIGURATION_READ");
    const configuration = result.structured.configuration as Record<string, unknown>;
    expect(configuration.environmentPublicId).toBe("env-alpha");
    expect(configuration.classification).toBe("matched");
    expect(configuration.digest).toMatch(/^sha256:[0-9a-f]{12}$/);
    const candidates = configuration.candidates as Array<Record<string, unknown>>;
    expect(candidates[0]).toMatchObject({
      source: "repository-file",
      precedence: 1,
      readable: true,
    });
    expect(candidates[1]).toMatchObject({
      source: "database",
      precedence: 2,
      readable: false,
    });
    const rendered = `${result.text}\n${JSON.stringify(result.structured)}`;
    expect(rendered).not.toContain("hunter2");
    expect(rendered).not.toContain("npm ci");
  });

  it("refuses configuration for an environment the profile does not name, after resolving it", async () => {
    const runner = stubRunner(configAnswers);
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_CONFIGURATION_TOOL, {
      environmentPublicId: "env-beta",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Refused by policy");
    expect(result.text).toContain("add beta to");
    expect(runner.calls).not.toContain("env get env-beta --output json");
  });

  it("refuses an id the CLI catalog does not report", async () => {
    const runner = stubRunner(configAnswers);
    const result = await invoke(policyWith(["read:*"]), runner, ENVIRONMENT_CONFIGURATION_TOOL, {
      environmentPublicId: "env-ghost",
    });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("no environment with that id");
  });

  it("trusts a pinned binding without a catalog round trip", async () => {
    const runner = stubRunner(configAnswers);
    const result = await invoke(
      policyWith(["read:*"], cursorCli(), [
        { name: "beta", publicId: "env-beta", scope: "personal" },
      ]),
      runner,
      ENVIRONMENT_CONFIGURATION_TOOL,
      { environmentPublicId: "env-beta" },
    );
    expect(result.isError).toBe(false);
    expect(runner.calls).not.toContain("env list --output json");
    expect(runner.calls).toContain("env get env-beta --output json");
  });

  it("refuses a pinned binding whose catalog id disagrees", async () => {
    const runner = stubRunner(configAnswers);
    const result = await invoke(
      policyWith(["read:*"], cursorCli(), [
        { name: "alpha", publicId: "env-elsewhere", scope: "personal" },
      ]),
      runner,
      ENVIRONMENT_CONFIGURATION_TOOL,
      { environmentPublicId: "env-alpha" },
    );
    expect(result.isError).toBe(true);
    expect(result.text).toContain("Refused by policy");
  });

  it("refuses an id that would become a flag before spawning anything", async () => {
    const runner = stubRunner(configAnswers);
    const result = await invoke(
      policyWith(["read:*"]),
      runner,
      ENVIRONMENT_CONFIGURATION_TOOL,
      { environmentPublicId: "--help" },
    );
    expect(result.isError).toBe(true);
    expect(runner.calls).not.toContain("env get --help --output json");
  });
});


it("discovers agent environments in account mode without a CLI, with pagination and unknown ownership", async () => {
  const policy = policyWith([ENVIRONMENT_LIST_TOOL], null);
  policy.profiles.p!.repos = ["*"];
  policy.profiles.p!.environmentAccess = "account";
  const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
    items: [
      { id: "a", status: "ACTIVE", url: "https://example.test/a", createdAt: "now", updatedAt: "now", env: { type: "cloud", name: "dev" }, repos: [{ url: "O/First" }] },
      { id: "b", status: "ACTIVE", url: "https://example.test/b", createdAt: "now", updatedAt: "now", env: { type: "cloud", name: "dev" }, repos: [{ url: "O/Second" }] },
      { id: "c", status: "ACTIVE", url: "https://example.test/c", createdAt: "now", updatedAt: "now" },
    ], nextCursor: "next-page",
  })));
  const client = new CursorClient({ apiKey: "sk-test", baseUrl: "https://api.example.test", fetchImpl });
  const result = await invoke(policy, undefined, ENVIRONMENT_LIST_TOOL, { cursor: "first-page" }, client);
  expect(result.structured).toMatchObject({ status: "OBSERVED", nextCursor: "next-page", catalog: { complete: false, scanned: 3 }, environments: [{ name: "dev", repos: ["O/First", "O/Second"], scope: "unknown" }] });
  expect(result.structured.nextSteps).toEqual([expect.stringContaining("cursor_list_agents")]);
  expect(String(fetchImpl.mock.calls[0]![0])).toContain("cursor=first-page");
});
