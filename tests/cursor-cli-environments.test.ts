/**
 * Projections of the CLI's environment reads.
 *
 * Two properties carry the weight: an internal numeric id never becomes a public
 * address, and a configuration document never leaves as text. Everything else is
 * classification -- readable versus withheld, agreeing versus disagreeing.
 */

import { describe, expect, it } from "vitest";
import {
  CursorCliSchema,
  ENV_HELP_ARGS,
  ENV_LIST_ARGS,
  FORBIDDEN_CLI_WRITE_FLAGS,
  assertPublicEnvironmentId,
  cursorCliWriteReadiness,
  envDeleteArgs,
  envGetArgs,
  envPublishArgs,
  envSaveArgs,
  type CliRun,
  type CliRunner,
  type CursorCli,
} from "../src/cursor-cli.js";
import {
  MAX_CATALOG_ENTRIES,
  MAX_CONFIG_CANDIDATES,
  WRITE_PREVIEW_TTL_MS,
  canonicalJson,
  environmentAbsentFromList,
  internalNumericIdOf,
  issueWritePreview,
  matchWriteBinding,
  normalizeEnvironmentCatalog,
  normalizeEnvironmentConfiguration,
  normalizeTimestamp,
  publicIdOf,
  readPullRequestUrl,
  resolveWriteTarget,
  verifyWriteConfirmation,
  type CliWriteBinding,
} from "../src/cursor-cli-environments.js";
import {
  deleteEnvironmentWithCli,
  publishEnvironmentWithCli,
  saveEnvironmentWithCli,
} from "../src/environment-operations.js";

describe("normalizeEnvironmentCatalog", () => {
  it("normalizes ids, names, scope, repositories, and timestamps", () => {
    const result = normalizeEnvironmentCatalog({
      environments: [
        {
          id: 1234,
          environmentPublicId: "env-alpha",
          name: "alpha",
          scope: "personal",
          repos: [{ url: "https://github.com/ExampleOrg/ExampleRepo" }],
          createdAtMs: 1_756_000_000_000,
          updatedAtMs: 1_756_100_000_000,
        },
        {
          environmentPublicId: "env-beta",
          displayName: "beta",
          owningTeam: 77,
          repositories: ["ExampleOrg/Other"],
          createdAt: "2026-08-01T00:00:00.000Z",
        },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.entries).toEqual([
      {
        environmentPublicId: "env-alpha",
        name: "alpha",
        scope: "personal",
        repos: ["https://github.com/ExampleOrg/ExampleRepo"],
        createdAt: new Date(1_756_000_000_000).toISOString(),
        updatedAt: new Date(1_756_100_000_000).toISOString(),
      },
      {
        environmentPublicId: "env-beta",
        name: "beta",
        scope: "team",
        repos: ["https://github.com/ExampleOrg/Other"],
        createdAt: "2026-08-01T00:00:00.000Z",
      },
    ]);
  });

  it("keeps an internal numeric id private, dropping a row that has only one", () => {
    const result = normalizeEnvironmentCatalog([
      { id: 4321, name: "internal-only" },
      { id: "999999", name: "numeric-string" },
      { environmentPublicId: "env-ok" },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.entries.map((entry) => entry.environmentPublicId)).toEqual([
      "env-ok",
    ]);
    expect(result.catalog.dropped).toBe(2);
    expect(JSON.stringify(result.catalog)).not.toContain("4321");
    expect(JSON.stringify(result.catalog)).not.toContain("999999");
  });

  it("says unknown rather than guessing an unstated scope", () => {
    const result = normalizeEnvironmentCatalog([{ environmentPublicId: "env-a" }]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.entries[0]?.scope).toBe("unknown");
    expect(result.catalog.entries[0]?.repos).toEqual([]);
  });

  it("caps the list and reports the cap", () => {
    const rows = Array.from({ length: MAX_CATALOG_ENTRIES + 5 }, (_value, index) => ({
      environmentPublicId: `env-${index}`,
    }));
    const result = normalizeEnvironmentCatalog({ environments: rows });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.entries).toHaveLength(MAX_CATALOG_ENTRIES);
    expect(result.catalog.truncated).toBe(true);
  });

  it("refuses a payload that carries no recognizable row list", () => {
    const result = normalizeEnvironmentCatalog({ total: 3 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe("CLI_LIST_SHAPE_UNKNOWN");
  });

  it("refuses an internal id even when it is the only field named id", () => {
    expect(publicIdOf({ id: 12 })).toBeUndefined();
    expect(publicIdOf({ id: "env-x" })).toBe("env-x");
    expect(publicIdOf({ environmentPublicId: "env-y", id: "env-x" })).toBe("env-y");
    expect(publicIdOf({ environmentPublicId: "--help" })).toBeUndefined();
    expect(publicIdOf({ environmentPublicId: "env with spaces" })).toBeUndefined();
  });

  it("drops credential-bearing and malformed repository values", () => {
    const result = normalizeEnvironmentCatalog([
      {
        environmentPublicId: "env-safe",
        repos: [
          "https://token@github.com/ExampleOrg/Private",
          "not-github.example/repo",
          "ExampleOrg/ExampleRepo",
        ],
      },
    ]);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.catalog.entries[0]?.repos).toEqual([
      "https://github.com/ExampleOrg/ExampleRepo",
    ]);
    expect(JSON.stringify(result.catalog)).not.toContain("token");
  });

  it("normalizes epoch milliseconds and refuses nonsense", () => {
    expect(normalizeTimestamp(0)).toBe(new Date(0).toISOString());
    expect(normalizeTimestamp("2026-08-01")).toBe("2026-08-01T00:00:00.000Z");
    expect(normalizeTimestamp("not a date")).toBeUndefined();
    expect(normalizeTimestamp(-1)).toBeUndefined();
    expect(normalizeTimestamp(null)).toBeUndefined();
  });
});

describe("normalizeEnvironmentConfiguration", () => {
  const install = "npm ci && echo TOKEN_VALUE_SHOULD_NEVER_APPEAR";

  it("reports source, precedence, and a digest instead of the document", () => {
    const result = normalizeEnvironmentConfiguration({
      environmentPublicId: "env-alpha",
      payload: {
        candidates: [
          {
            source: "database",
            environmentJsonPath: null,
            environmentJson: { install, start: "npm start" },
          },
          {
            source: "repository",
            environmentJsonPath: ".cursor/environment.json",
            environmentJson: { start: "npm start", install },
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Highest precedence first: the repository file wins where it exists.
    expect(result.read.candidates.map((candidate) => candidate.source)).toEqual([
      "repository-file",
      "database",
    ]);
    expect(result.read.candidates[0]?.precedence).toBe(1);
    // Same document, different key order, so the two agree.
    expect(result.read.classification).toBe("matched");
    expect(result.read.digest).toMatch(/^sha256:[0-9a-f]{12}$/);
    expect(JSON.stringify(result.read)).not.toContain("TOKEN_VALUE_SHOULD_NEVER_APPEAR");
    expect(JSON.stringify(result.read)).not.toContain("npm ci");
  });

  it("calls two disagreeing candidates different rather than choosing one", () => {
    const result = normalizeEnvironmentConfiguration({
      environmentPublicId: "env-alpha",
      payload: [
        {
          source: "repository",
          environmentJsonPath: ".cursor/environment.json",
          environmentJson: { install: "npm ci" },
        },
        { source: "database", environmentJson: { install: "pnpm i" } },
      ],
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.read.classification).toBe("different");
    expect(result.read.digest).toBeUndefined();
  });

  it("treats a withheld document as unreadable, never as an empty configuration", () => {
    const result = normalizeEnvironmentConfiguration({
      environmentPublicId: "env-alpha",
      payload: {
        candidates: [
          {
            source: "database",
            environmentJson: null,
            environmentJsonNote: "Configuration is owner-restricted for this environment.",
          },
        ],
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.read.classification).toBe("unreadable");
    expect(result.read.candidates[0]?.readable).toBe(false);
    expect(result.read.candidates[0]?.digest).toBeUndefined();
    expect(result.read.candidates[0]?.reason).toMatch(/owner-restricted/);
  });

  it("reads a single-object payload as one candidate", () => {
    const result = normalizeEnvironmentConfiguration({
      environmentPublicId: "env-alpha",
      payload: {
        environmentJsonPath: ".cursor/environment.json",
        environmentJson: { install: "npm ci" },
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.read.candidates).toHaveLength(1);
    expect(result.read.candidates[0]?.source).toBe("repository-file");
    expect(result.read.classification).toBe("matched");
  });

  it("caps the candidate list and reports the cap", () => {
    const rows = Array.from({ length: MAX_CONFIG_CANDIDATES + 2 }, (_value, index) => ({
      source: "database",
      environmentJson: { install: `step-${index}` },
    }));
    const result = normalizeEnvironmentConfiguration({
      environmentPublicId: "env-alpha",
      payload: { candidates: rows },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.read.candidates).toHaveLength(MAX_CONFIG_CANDIDATES);
    expect(result.read.truncated).toBe(true);
  });

  it("canonicalizes key order so the same document digests the same", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: 4, c: 3 }] })).toBe(
      '{"a":[2,{"c":3,"d":4}],"b":1}',
    );
  });

  it("classifies over-deep documents unreadable instead of assigning a shared digest", () => {
    let document: Record<string, unknown> = { leaf: "one" };
    for (let depth = 0; depth < 40; depth += 1) document = { nested: document };
    const result = normalizeEnvironmentConfiguration({
      environmentPublicId: "env-alpha",
      payload: {
        source: "database",
        environmentJson: document,
        environmentJsonNote: "provider note that must not replace our refusal",
      },
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.read.classification).toBe("unreadable");
    expect(result.read.candidates[0]?.digest).toBeUndefined();
    expect(result.read.candidates[0]?.reason).toContain("nesting depth");
  });
});

/* --------------------------------------------------------------- writes */

const OWNER = "owner@example.com";
const ENV_ID = "env-alpha";
const INTERNAL_ID = 987654321;
const REPO = "https://github.com/ExampleOrg/ExampleRepo";
const PR_URL = "https://github.com/ExampleOrg/ExampleRepo/pull/42";
const INTENDED = { install: "npm ci", start: "npm start" };
const CURRENT = { install: "pnpm i", start: "npm start" };
const NOW = 1_700_000_000_000;

const ROOT_HELP = ["Commands:", "  env     Manage environments", "  status  Show login"].join(
  "\n",
);
const WRITE_ENV_HELP = [
  "Usage: cursor env [command]",
  "",
  "Commands:",
  "  list     List environments",
  "  get      Get one environment",
  "  publish  Open a pull request",
  "  save     Save to the database",
  "  delete   Delete an environment",
].join("\n");
const PUBLISH_HELP = "Options:\n  --output <format>  Output format";
const SAVE_HELP = "Options:\n  --stdin            Read the definition from stdin\n  --output <format>  Output format";
const DELETE_HELP = "Options:\n  --dry-run          Preview deletion\n  --output <format>  Output format";
const READ_ONLY_ENV_HELP = [
  "Usage: cursor env [command]",
  "",
  "Commands:",
  "  list     List environments",
  "  get      Get one environment",
].join("\n");

const binding = (overrides: Partial<CliWriteBinding> = {}): CliWriteBinding => ({
  name: "alpha",
  publicId: ENV_ID,
  scope: "personal",
  repos: [REPO],
  identityPinned: true,
  ...overrides,
});

const exited = (stdout: string, exitCode = 0): CliRun => ({
  outcome: "exited",
  exitCode,
  signal: null,
  stdout,
  stderr: "",
  truncated: false,
});

const timedOut = (): CliRun => ({
  outcome: "timed-out",
  exitCode: null,
  signal: "SIGTERM",
  stdout: "",
  stderr: "",
  truncated: false,
});

function cliConfig(overrides: Record<string, unknown> = {}): CursorCli {
  return CursorCliSchema.parse({
    path: "/opt/cursor/bin/cursor",
    compatibleVersions: ["1.2.3"],
    environmentReads: true,
    publishEnabled: true,
    databaseSaveEnabled: true,
    deleteEnabled: true,
    ...overrides,
  });
}

class FakeWriteCli {
  calls: string[] = [];
  stdins: Array<string | undefined> = [];
  email = OWNER;
  envHelp = WRITE_ENV_HELP;
  publishHelp = PUBLISH_HELP;
  saveHelp = SAVE_HELP;
  deleteHelp = DELETE_HELP;
  environments: Record<string, unknown>[] = [
    {
      id: INTERNAL_ID,
      environmentPublicId: ENV_ID,
      name: "alpha",
      scope: "personal",
      repos: [REPO],
    },
  ];
  databaseJson: unknown = { ...CURRENT };
  repoJson: unknown = { ...INTENDED };
  publishRun: CliRun | undefined;
  saveRun: CliRun | undefined;
  deleteRun: CliRun | undefined;
  deleteDryRunPayload: unknown = { dryRun: true, environmentPublicId: ENV_ID };

  runner(): CliRunner {
    return async (args, options) => {
      const key = args.join(" ");
      this.calls.push(key);
      this.stdins.push(options?.stdin);
      if (key === "--version") return exited("cursor 1.2.3\n");
      if (key === "--help") return exited(ROOT_HELP);
      if (key === ENV_HELP_ARGS.join(" ")) return exited(this.envHelp);
      if (key === "env publish --help") return exited(this.publishHelp);
      if (key === "env save --help") return exited(this.saveHelp);
      if (key === "env delete --help") return exited(this.deleteHelp);
      if (key === "status --output json") {
        return exited(JSON.stringify({ user: { email: this.email } }));
      }
      if (key === ENV_LIST_ARGS.join(" ")) {
        return exited(JSON.stringify({ environments: this.environments }));
      }
      if (args[0] === "env" && args[1] === "get" && args[3] === "--output") {
        return exited(
          JSON.stringify({
            environmentPublicId: args[2],
            candidates: [
              {
                source: "repository",
                environmentJsonPath: ".cursor/environment.json",
                environmentJson: this.repoJson,
              },
              {
                source: "database",
                environmentJsonPath: null,
                environmentJson: this.databaseJson,
              },
            ],
          }),
        );
      }
      if (args[0] === "env" && args[1] === "publish") {
        return this.publishRun ?? exited(JSON.stringify({ prUrl: PR_URL }));
      }
      if (args[0] === "env" && args[1] === "save") {
        if (this.saveRun !== undefined) return this.saveRun;
        if (options?.stdin !== undefined) this.databaseJson = JSON.parse(options.stdin);
        return exited(JSON.stringify({ ok: true }));
      }
      if (args[0] === "env" && args[1] === "delete" && args[2] === "--dry-run") {
        return exited(JSON.stringify(this.deleteDryRunPayload));
      }
      if (args[0] === "env" && args[1] === "delete") {
        if (this.deleteRun !== undefined) return this.deleteRun;
        if (args[2] === String(INTERNAL_ID)) {
          this.environments = this.environments.filter(
            (row) => publicIdOf(row as Record<string, unknown>) !== ENV_ID,
          );
        }
        return exited(JSON.stringify({ deleted: true }));
      }
      return exited("", 64);
    };
  }

  writeInvocations(): string[] {
    return this.calls.filter(
      (line) =>
        !line.endsWith(" --help") &&
        !line.includes("--dry-run") &&
        (line.startsWith("env publish ") ||
          line.startsWith("env save ") ||
          line.startsWith("env delete ")),
    );
  }
}

async function confirmPublish(fake: FakeWriteCli, extras: Record<string, unknown> = {}) {
  const previewed = await publishEnvironmentWithCli({
    cli: cliConfig(),
    runner: fake.runner(),
    binding: binding(),
    nowMs: NOW,
    restEmail: OWNER,
  });
  return publishEnvironmentWithCli({
    cli: cliConfig(),
    runner: fake.runner(),
    binding: binding(),
    nowMs: NOW,
    restEmail: OWNER,
    confirm: true,
    preview: previewed.preview,
    previewToken: previewed.preview?.previewToken,
    ...extras,
  });
}

describe("write target resolution", () => {
  it("resolves a public id to an internal id without emitting the internal id from the catalog", () => {
    const payload = {
      environments: [
        {
          id: INTERNAL_ID,
          environmentPublicId: ENV_ID,
          scope: "personal",
          repos: [REPO],
        },
      ],
    };
    const resolved = resolveWriteTarget(payload, ENV_ID);
    expect(resolved.ok).toBe(true);
    if (!resolved.ok) return;
    expect(resolved.target.internalId).toBe(INTERNAL_ID);
    const catalog = normalizeEnvironmentCatalog(payload);
    expect(catalog.ok).toBe(true);
    if (!catalog.ok) return;
    expect(JSON.stringify(catalog.catalog)).not.toContain(String(INTERNAL_ID));
    expect(internalNumericIdOf({ id: INTERNAL_ID })).toBe(INTERNAL_ID);
    expect(internalNumericIdOf({ environmentPublicId: ENV_ID })).toBeUndefined();
  });

  it("refuses an all-digits public id rather than treating it as an address", () => {
    expect(() => assertPublicEnvironmentId(String(INTERNAL_ID))).toThrow(/internal id/);
    expect(() => envGetArgs(String(INTERNAL_ID))).toThrow(/internal id/);
  });

  it("never puts the compound delete-personal-on-team-write option on a vector", () => {
    const vectors = [
      envPublishArgs(ENV_ID),
      envSaveArgs(ENV_ID),
      envDeleteArgs(INTERNAL_ID),
    ];
    for (const args of vectors) {
      expect(args.some((arg) => (FORBIDDEN_CLI_WRITE_FLAGS as readonly string[]).includes(arg))).toBe(
        false,
      );
      expect(args.join(" ")).not.toMatch(/delete-personal/i);
    }
  });

  it("reads a GitHub pull-request URL and ignores other urls", () => {
    expect(readPullRequestUrl({ prUrl: PR_URL })).toBe(PR_URL);
    expect(readPullRequestUrl({ url: "https://example.com/not-a-pr" })).toBeUndefined();
  });
});

describe("write binding", () => {
  const target = {
    environmentPublicId: ENV_ID,
    scope: "personal" as const,
    repos: [REPO],
    internalId: INTERNAL_ID,
  };

  it("requires a pinned identity, exact repos, and matching scope", () => {
    expect(matchWriteBinding(target, binding(), "save").ok).toBe(true);
    expect(matchWriteBinding(target, binding({ identityPinned: false }), "save")).toMatchObject({
      status: "IDENTITY_UNPINNED",
    });
    expect(
      matchWriteBinding(target, binding({ repos: ["ExampleOrg/Other"] }), "save"),
    ).toMatchObject({ status: "WRONG_REPO" });
    expect(matchWriteBinding(target, binding({ scope: "team" }), "save")).toMatchObject({
      status: "WRONG_SCOPE",
    });
    expect(
      matchWriteBinding(
        { ...target, repos: [REPO, "https://github.com/ExampleOrg/Other"] },
        binding({ repos: [REPO, "https://github.com/ExampleOrg/Other"] }),
        "publish",
      ),
    ).toMatchObject({ status: "NOT_SINGLE_REPOSITORY" });
  });
});

describe("CLI environment writes", () => {
  it("previews publish, then creates a pull request and never reports PERSISTED", async () => {
    const fake = new FakeWriteCli();
    const previewed = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(previewed.status).toBe("CONFIRMATION_REQUIRED");
    expect(previewed.dispatched).toBe(false);
    expect(previewed.preview?.previewToken).toMatch(/^hmac-sha256:[0-9a-f]{64}$/);
    expect(fake.writeInvocations()).toEqual([]);

    const result = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
      preview: previewed.preview,
      previewToken: previewed.preview?.previewToken,
    });
    expect(result.status).toBe("PULL_REQUEST_CREATED");
    expect(result.status).not.toBe("PERSISTED");
    expect(result.dispatched).toBe(true);
    expect(result.prUrl).toBe(PR_URL);
    expect(result.reason).toMatch(/not a database Save/i);
    expect(JSON.stringify(result)).not.toContain("PERSISTED");
    expect(JSON.stringify(result)).not.toMatch(/"internalId"/);
    expect(fake.writeInvocations()).toEqual([`env publish ${ENV_ID} --output json`]);
  });

  it("saves with a digest-bound preview, client precheck, and exact post-read", async () => {
    const fake = new FakeWriteCli();
    const previewed = await saveEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(previewed.status).toBe("CONFIRMATION_REQUIRED");
    expect(previewed.clientPrecheck).toBe(true);
    expect(previewed.serverCompareAndSwap).toBe(false);
    expect(previewed.dispatched).toBe(false);

    const result = await saveEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
      preview: previewed.preview,
      previewToken: previewed.preview?.previewToken,
    });
    expect(result.status).toBe("DATABASE_SAVED");
    expect(result.status).not.toBe("PERSISTED");
    expect(result.dispatched).toBe(true);
    expect(result.clientPrecheck).toBe(true);
    expect(result.serverCompareAndSwap).toBe(false);
    expect(result.reason).toMatch(/no server compare-and-swap/i);
    expect(fake.writeInvocations()).toEqual([`env save ${ENV_ID} --stdin --output json`]);
    expect(fake.stdins.some((stdin) => stdin === canonicalJson(INTENDED))).toBe(true);
    expect(JSON.stringify(result)).not.toContain("pnpm i");
    expect(JSON.stringify(result)).not.toContain("npm ci");
  });

  it("deletes after dry-run, internal-id resolution, and post-list absence", async () => {
    const fake = new FakeWriteCli();
    const previewed = await deleteEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(previewed.status).toBe("CONFIRMATION_REQUIRED");
    expect(previewed.dispatched).toBe(false);
    expect(fake.calls.some((line) => line.startsWith("env delete --dry-run"))).toBe(true);
    expect(fake.writeInvocations()).toEqual([]);

    const result = await deleteEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
      preview: previewed.preview,
      previewToken: previewed.preview?.previewToken,
    });
    expect(result.status).toBe("DELETED");
    expect(result.dispatched).toBe(true);
    expect(result.listConclusive).toBe(true);
    expect(fake.writeInvocations()).toEqual([`env delete ${INTERNAL_ID} --output json`]);
    expect(JSON.stringify(result)).not.toMatch(/"internalId"/);
    expect(JSON.stringify(result)).not.toMatch(/delete-personal/i);
  });

  it("refuses delete when the dry-run identifies a different environment", async () => {
    const fake = new FakeWriteCli();
    fake.deleteDryRunPayload = {
      dryRun: true,
      environmentPublicId: "env-other",
    };
    const result = await deleteEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(result).toMatchObject({ status: "DRIFT", dispatched: false });
    expect(fake.writeInvocations()).toEqual([]);
  });

  it("does not prove delete absence from a catalog that dropped malformed rows", () => {
    const normalized = normalizeEnvironmentCatalog({
      environments: [null, { environmentPublicId: "env-other", name: "other" }],
    });
    expect(normalized.ok).toBe(true);
    if (!normalized.ok) return;
    expect(environmentAbsentFromList(normalized.catalog, ENV_ID)).toEqual({
      absent: true,
      conclusive: false,
    });
  });

  it("refuses save when the database digest drifted after preview", async () => {
    const fake = new FakeWriteCli();
    const previewed = await saveEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
    });
    fake.databaseJson = { install: "bun i", start: "npm start" };
    const result = await saveEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
      preview: previewed.preview,
      previewToken: previewed.preview?.previewToken,
    });
    expect(result.status).toBe("DRIFT");
    expect(result.dispatched).toBe(false);
    expect(result.clientPrecheck).toBe(true);
    expect(result.serverCompareAndSwap).toBe(false);
    expect(fake.writeInvocations()).toEqual([]);
  });

  it("refuses publish when saved database content drifts while the repo file is unchanged", async () => {
    const fake = new FakeWriteCli();
    const previewed = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
    });
    fake.databaseJson = { install: "bun i", start: "npm start" };
    const result = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
      preview: previewed.preview,
      previewToken: previewed.preview?.previewToken,
    });
    expect(result).toMatchObject({ status: "DRIFT", dispatched: false });
    expect(fake.writeInvocations()).toEqual([]);
  });

  it("reports STATE_UNKNOWN for malformed publish output and does not retry", async () => {
    const fake = new FakeWriteCli();
    fake.publishRun = exited("opened a PR, probably");
    const result = await confirmPublish(fake);
    expect(result.status).toBe("STATE_UNKNOWN");
    expect(result.dispatched).toBe(true);
    expect(result.nextSteps.join(" ")).toMatch(/Do not retry/);
    expect(result.status).not.toBe("PULL_REQUEST_CREATED");
    expect(result.status).not.toBe("PERSISTED");
    expect(fake.writeInvocations()).toHaveLength(1);
  });

  it("reports STATE_UNKNOWN when the write times out after dispatch", async () => {
    const fake = new FakeWriteCli();
    fake.saveRun = timedOut();
    const previewed = await saveEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
    });
    const result = await saveEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
      preview: previewed.preview,
      previewToken: previewed.preview?.previewToken,
    });
    expect(result.status).toBe("STATE_UNKNOWN");
    expect(result.dispatched).toBe(true);
    expect(result.nextSteps.join(" ")).toMatch(/Do not retry/);
    expect(fake.writeInvocations()).toHaveLength(1);
  });

  it("treats a publish receipt without a pull-request URL as STATE_UNKNOWN", async () => {
    const fake = new FakeWriteCli();
    fake.publishRun = exited(JSON.stringify({ ok: true, persisted: true }));
    const result = await confirmPublish(fake);
    expect(result.status).toBe("STATE_UNKNOWN");
    expect(result.dispatched).toBe(true);
    expect(JSON.stringify(result)).not.toContain("PERSISTED");
  });

  it("stops at identity mismatch before any environment write", async () => {
    const fake = new FakeWriteCli();
    fake.email = "someone-else@example.com";
    const result = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
    });
    expect(result.status).toBe("CLI_IDENTITY_MISMATCH");
    expect(result.dispatched).toBe(false);
    expect(fake.calls.some((line) => line.startsWith("env "))).toBe(false);
  });

  it("refuses a write against the wrong environment, repository, or scope", async () => {
    const fake = new FakeWriteCli();
    const wrongEnv = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding({ publicId: "env-other" }),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(wrongEnv.status).toBe("WRONG_ENVIRONMENT");
    expect(wrongEnv.dispatched).toBe(false);

    const wrongRepo = await saveEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding({ repos: ["https://github.com/ExampleOrg/Other"] }),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(wrongRepo.status).toBe("WRONG_REPO");
    expect(wrongRepo.dispatched).toBe(false);

    const wrongScope = await deleteEnvironmentWithCli({
      cli: cliConfig({ teamWritesEnabled: true }),
      runner: fake.runner(),
      binding: binding({ scope: "team" }),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(wrongScope.status).toBe("WRONG_SCOPE");
    expect(wrongScope.dispatched).toBe(false);

    const unpinned = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding({ identityPinned: false }),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(unpinned.status).toBe("IDENTITY_UNPINNED");
    expect(unpinned.dispatched).toBe(false);
    expect(fake.writeInvocations()).toEqual([]);
  });

  it("saves a team environment only when teamWritesEnabled is on", async () => {
    const fake = new FakeWriteCli();
    fake.environments[0] = {
      id: INTERNAL_ID,
      environmentPublicId: ENV_ID,
      scope: "team",
      repos: [REPO],
    };
    const previewed = await saveEnvironmentWithCli({
      cli: cliConfig({ teamWritesEnabled: true }),
      runner: fake.runner(),
      binding: binding({ scope: "team" }),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(previewed.status).toBe("CONFIRMATION_REQUIRED");
    const result = await saveEnvironmentWithCli({
      cli: cliConfig({ teamWritesEnabled: true }),
      runner: fake.runner(),
      binding: binding({ scope: "team" }),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
      preview: previewed.preview,
      previewToken: previewed.preview?.previewToken,
    });
    expect(result.status).toBe("DATABASE_SAVED");
    expect(result.dispatched).toBe(true);
  });

  it("does not enable team writes merely because personal operations are gated on", async () => {
    const fake = new FakeWriteCli();
    fake.environments[0] = {
      id: INTERNAL_ID,
      environmentPublicId: ENV_ID,
      scope: "team",
      repos: [REPO],
    };
    const result = await saveEnvironmentWithCli({
      cli: cliConfig({ teamWritesEnabled: false }),
      runner: fake.runner(),
      binding: binding({ scope: "team" }),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
      confirm: true,
    });
    expect(result.status).toBe("CLI_TEAM_WRITES_DISABLED");
    expect(result.dispatched).toBe(false);
    expect(fake.writeInvocations()).toEqual([]);
  });

  it("keeps publish, save, and delete independently gated", async () => {
    const fake = new FakeWriteCli();
    const publishOff = await publishEnvironmentWithCli({
      cli: cliConfig({ publishEnabled: false, environmentWrites: true }),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(publishOff.status).toBe("CLI_PUBLISH_DISABLED");
    expect(publishOff.dispatched).toBe(false);

    const saveOff = await saveEnvironmentWithCli({
      cli: cliConfig({ databaseSaveEnabled: false }),
      runner: fake.runner(),
      binding: binding(),
      document: INTENDED,
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(saveOff.status).toBe("CLI_DATABASE_SAVE_DISABLED");
    expect(saveOff.dispatched).toBe(false);

    const deleteOff = await deleteEnvironmentWithCli({
      cli: cliConfig({ deleteEnabled: false }),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(deleteOff.status).toBe("CLI_DELETE_DISABLED");
    expect(deleteOff.dispatched).toBe(false);
    expect(fake.writeInvocations()).toEqual([]);
  });

  it("issues no write when the installed CLI's env help omits write verbs", async () => {
    const fake = new FakeWriteCli();
    fake.envHelp = READ_ONLY_ENV_HELP;
    const result = await cursorCliWriteReadiness({
      cli: cliConfig(),
      runner: fake.runner(),
      operation: "publish",
      scope: "personal",
      restEmail: OWNER,
    });
    expect(result.ready).toBe(false);
    if (result.ready) return;
    expect(result.status).toBe("CLI_FEATURE_GATED");
    expect(fake.writeInvocations()).toEqual([]);
    expect(fake.calls).toEqual(["--version", "--help", "status --output json", "env --help"]);
  });

  it("issues no delete when subcommand help does not prove dry-run support", async () => {
    const fake = new FakeWriteCli();
    fake.deleteHelp = "Options:\n  --output <format>  Output format";
    const result = await deleteEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
    });
    expect(result).toMatchObject({ status: "CLI_FEATURE_GATED", dispatched: false });
    expect(fake.calls).toContain("env delete --help");
    expect(fake.calls).not.toContain(`env delete --dry-run ${ENV_ID} --output json`);
    expect(fake.writeInvocations()).toEqual([]);
  });

  it("refuses an expired preview instead of dispatching", async () => {
    const fake = new FakeWriteCli();
    const previewed = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW,
      restEmail: OWNER,
    });
    const result = await publishEnvironmentWithCli({
      cli: cliConfig(),
      runner: fake.runner(),
      binding: binding(),
      nowMs: NOW + WRITE_PREVIEW_TTL_MS + 1,
      restEmail: OWNER,
      confirm: true,
      preview: previewed.preview,
      previewToken: previewed.preview?.previewToken,
    });
    expect(result.status).toBe("PREVIEW_EXPIRED");
    expect(result.dispatched).toBe(false);
    expect(fake.writeInvocations()).toEqual([]);
  });

  it("binds preview tokens so a swapped payload cannot confirm", () => {
    const preview = issueWritePreview({
      operation: "delete",
      environmentPublicId: ENV_ID,
      targetDigest: "sha256:aaaaaaaaaaaa",
      nowMs: NOW,
    });
    const forged = { ...preview, targetDigest: "sha256:bbbbbbbbbbbb" };
    expect(forged.previewToken).toBe(preview.previewToken);
    expect(forged.previewToken).not.toBe(
      issueWritePreview({
        operation: "delete",
        environmentPublicId: ENV_ID,
        targetDigest: "sha256:bbbbbbbbbbbb",
        nowMs: NOW,
      }).previewToken,
    );
    const check = verifyWriteConfirmation({
      confirm: true,
      preview: forged,
      previewToken: forged.previewToken,
      operation: "delete",
      environmentPublicId: ENV_ID,
      nowMs: NOW,
    });
    expect(check.ok).toBe(false);
    if (check.ok) return;
    expect(check.status).toBe("PREVIEW_MISMATCH");
  });
});
