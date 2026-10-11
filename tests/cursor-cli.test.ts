/**
 * The Cursor CLI read authority.
 *
 * Everything here runs a real child process against a fake CLI, because the
 * properties under test are properties of spawning: no shell, no inherited
 * credential, a controlled working directory, a byte ceiling, a timeout that
 * reaps descendants, and a registration check that refuses to issue a command an
 * agent-prompt build would swallow as a prompt.
 *
 * The fixtures in `fixtures/cli` are written to a temporary directory with a
 * shebang naming this test's own node binary, so they need no executable bit in
 * the repository and no `node` on PATH.
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createWaitScope } from "../src/wait.js";
import { currentRequestScope, withRequestSignal, withWaitScope } from "../src/request-context.js";
import {
  CliArgumentError,
  CLI_KILL_GRACE_MS,
  CursorCliSchema,
  ENV_LIST_ARGS,
  cliChildEnv,
  cliOperationTimeoutMs,
  boundedCliRunner,
  cursorCliReadiness,
  cursorCliRunner,
  detectCursorCliCapability,
  envGetArgs,
  isCompatibleCliVersion,
  parseCliJson,
  parseCliVersion,
  parseHelpCommands,
  verifyCursorCliIdentity,
  type CliRun,
  type CursorCli,
} from "../src/cursor-cli.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "cli");

const OWNER = "owner@example.com";

interface Installed {
  path: string;
  cwd: string;
}

/** Copy a fixture to a temporary directory as an executable script. */
async function install(fixture: string): Promise<Installed> {
  const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-cli-bin-"));
  const cwd = await mkdtemp(join(tmpdir(), "cursor-mcp-cli-cwd-"));
  const path = join(dir, fixture);
  const body = await readFile(join(FIXTURES, fixture), "utf8");
  await writeFile(path, `#!${process.execPath}\n${body}`, { mode: 0o755 });
  return { path, cwd };
}

function cliFor(
  installed: Installed,
  overrides: Record<string, unknown> = {},
): CursorCli {
  return CursorCliSchema.parse({
    path: installed.path,
    cwd: installed.cwd,
    compatibleVersions: ["1.2.3"],
    environmentReads: true,
    timeoutMs: 5_000,
    ...overrides,
  });
}

/** `null` means "/v1/me named no owner"; an explicit `undefined` would default. */
async function readinessFor(
  fixture: string,
  overrides: Record<string, unknown> = {},
  restEmail: string | null = OWNER,
) {
  const installed = await install(fixture);
  const cli = cliFor(installed, overrides);
  const readiness = await cursorCliReadiness({
    cli,
    runner: cursorCliRunner(cli),
    restEmail: restEmail ?? undefined,
  });
  return { installed, cli, readiness };
}

describe("capability detection", () => {
  it("reports REGISTERED with a version, command set, and fingerprint", async () => {
    const installed = await install("registered.mjs");
    const cli = cliFor(installed);
    const capability = await detectCursorCliCapability({
      cli,
      run: cursorCliRunner(cli),
    });
    expect(capability.availability).toBe("REGISTERED");
    expect(capability.authority).toBe("cursor-cli");
    expect(capability.version).toBe("cursor 1.2.3");
    expect(capability.compatible).toBe(true);
    expect(capability.commands).toEqual(["agent", "env", "status"]);
    expect(capability.environmentCommandRegistered).toBe(true);
    expect(capability.identityCommandRegistered).toBe(true);
    expect(capability.contractFingerprint).toMatch(/^sha256:[0-9a-f]{12}$/);
  });

  it("reports FEATURE_GATED for root agent help, and issues no command", async () => {
    const { installed, readiness } = await readinessFor("root-help.mjs");
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_FEATURE_GATED");
    expect(readiness.capability.commands).toEqual([]);
    expect(readiness.reason).toMatch(/agent-prompt help/);
    // The fixture records every non-flag invocation. Nothing may be recorded:
    // `env list` against this build would have been submitted as a prompt.
    expect(existsSync(join(installed.cwd, "prompts.log"))).toBe(false);
  });

  it("reports FEATURE_GATED when the parser exists but `env` is not registered", async () => {
    const { readiness } = await readinessFor("no-env-command.mjs");
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_FEATURE_GATED");
    expect(readiness.capability.commands).toEqual(["agent", "status"]);
    expect(readiness.capability.environmentCommandRegistered).toBe(false);
  });

  it("stops at INCOMPATIBLE without reading the command set", async () => {
    const { readiness } = await readinessFor("incompatible.mjs");
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_INCOMPATIBLE");
    expect(readiness.capability.version).toBe("cursor 9.9.9");
    expect(readiness.capability.compatible).toBe(false);
    // Help was never parsed, so no fingerprint claims a checked contract.
    expect(readiness.capability.commands).toEqual([]);
    expect(readiness.capability.contractFingerprint).toBeUndefined();
  });

  it("reports MISSING for a path with no executable behind it", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-cli-absent-"));
    const cli = CursorCliSchema.parse({
      path: join(dir, "cursor"),
      cwd: dir,
      compatibleVersions: ["1.2.3"],
      environmentReads: true,
    });
    const readiness = await cursorCliReadiness({
      cli,
      runner: cursorCliRunner(cli),
      restEmail: OWNER,
    });
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_MISSING");
  });

  it("reports UNREADABLE when help does not return within the timeout", async () => {
    const { readiness } = await readinessFor("slow.mjs", { timeoutMs: 1_000 });
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_UNREADABLE");
    expect(readiness.capability.version).toBe("cursor 1.2.3");
  });

  it("never trusts truncated version or help output", async () => {
    const installed = await install("registered.mjs");
    const cli = cliFor(installed);
    const truncated = (stdout: string): CliRun => ({
      outcome: "exited",
      exitCode: null,
      signal: "SIGTERM",
      stdout,
      stderr: "",
      truncated: true,
    });
    const versionCut = await detectCursorCliCapability({
      cli,
      run: async () => truncated("cursor 1.2.3"),
    });
    expect(versionCut.availability).toBe("UNREADABLE");
    expect(versionCut.contractFingerprint).toBeUndefined();

    const helpCut = await detectCursorCliCapability({
      cli,
      run: async (args) =>
        args[0] === "--version"
          ? { ...truncated("cursor 1.2.3"), exitCode: 0, signal: null, truncated: false }
          : truncated("Commands:\n  env  Manage environments"),
    });
    expect(helpCut.availability).toBe("UNREADABLE");
    expect(helpCut.commands).toEqual([]);
    expect(helpCut.contractFingerprint).toBeUndefined();
  });

  it("never suggests a delegated run as a fallback, and names the agent list that does exist", async () => {
    const { readiness } = await readinessFor("root-help.mjs");
    if (readiness.ready) throw new Error("expected an unavailable readiness");
    expect(readiness.nextSteps.join(" ")).toMatch(/does not fall back to a delegated run/);
    expect(readiness.nextSteps.join(" ")).toMatch(/cursor_list_agents/);
  });
});

describe("configuration gates", () => {
  it("reports NOT_CONFIGURED when the operator named no CLI", async () => {
    const readiness = await cursorCliReadiness({
      cli: undefined,
      runner: undefined,
      restEmail: OWNER,
    });
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_NOT_CONFIGURED");
  });

  it("reports READS_DISABLED for a configured CLI whose reads are off", async () => {
    const { readiness } = await readinessFor("registered.mjs", {
      environmentReads: false,
    });
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_READS_DISABLED");
  });
});

describe("identity", () => {
  it("verifies a matching login, case-insensitively", async () => {
    const { readiness } = await readinessFor("registered.mjs");
    expect(readiness.ready).toBe(true);
    if (!readiness.ready) return;
    expect(readiness.identity.state).toBe("verified");
    expect(readiness.identity.cliIdentityDigest).toBe(
      readiness.identity.restIdentityDigest,
    );
  });

  it("refuses a CLI logged in as another account, and names no address", async () => {
    const { readiness } = await readinessFor("identity-mismatch.mjs");
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_IDENTITY_MISMATCH");
    expect(readiness.identity?.cliIdentityDigest).not.toBe(
      readiness.identity?.restIdentityDigest,
    );
    const rendered = JSON.stringify(readiness);
    expect(rendered).not.toContain("someone-else@example.com");
    expect(rendered).not.toContain(OWNER);
  });

  it("reports auth-required rather than forwarding this server's key", async () => {
    const { readiness } = await readinessFor("auth-required.mjs");
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_AUTH_REQUIRED");
    expect(readiness.nextSteps.join(" ")).toMatch(/Log the CLI in/);
  });

  it("fails closed when /v1/me names no owner to compare against", async () => {
    const { readiness } = await readinessFor("registered.mjs", {}, null);
    expect(readiness.ready).toBe(false);
    if (readiness.ready) return;
    expect(readiness.status).toBe("CLI_IDENTITY_UNREADABLE");
  });

  it("fails closed when no identity command is registered", async () => {
    const installed = await install("registered.mjs");
    const cli = cliFor(installed);
    const identity = await verifyCursorCliIdentity({
      cli,
      run: cursorCliRunner(cli),
      capability: {
        availability: "REGISTERED",
        authority: "cursor-cli",
        compatible: true,
        commands: ["env"],
        environmentCommandRegistered: true,
        identityCommandRegistered: false,
        reason: "",
        nextSteps: [],
      },
      restEmail: OWNER,
    });
    expect(identity.state).toBe("unreadable");
  });
});

describe("the bounded runner", () => {
  const savedKey = process.env.CURSOR_API_KEY;

  afterEach(() => {
    vi.useRealTimers();
    if (savedKey === undefined) delete process.env.CURSOR_API_KEY;
    else process.env.CURSOR_API_KEY = savedKey;
  });

  it("selects and validates the whole-operation budget before admission", async () => {
    const installed = await install("registered.mjs");
    const cli = cliFor(installed);
    expect(cliOperationTimeoutMs(cli)).toBe(45_000);
    expect(cliOperationTimeoutMs(cliFor(installed, { timeoutMs: 120_000 }))).toBe(362_000);
    expect(() => cliFor(installed, { operationTimeoutMs: 11_999, publishEnabled: true })).toThrow();
    expect(() => cliFor(installed, { operationTimeoutMs: 12_000, publishEnabled: true })).toThrow();
    expect(cliOperationTimeoutMs(cliFor(installed, { operationTimeoutMs: 12_001, publishEnabled: true }))).toBe(12_001);
    expect(cliOperationTimeoutMs(cliFor(installed, { operationTimeoutMs: 1000 }))).toBe(1000);
    expect(cliOperationTimeoutMs(cliFor(installed, { operationTimeoutMs: 12_000 }))).toBe(12_000);
  });

  it("returns cancellation uncertainty without terminating an accepted write before its process deadline", async () => {
    const installed = await install("write-cancellation.mjs");
    const cli = cliFor(installed, { timeoutMs: 1_000 });
    const controller = new AbortController();
    const started = performance.now();
    const result = withRequestSignal(controller.signal, () => cursorCliRunner(cli)(["env", "save", "env-alpha"], { write: true }));
    const marker = join(installed.cwd, "started");
    const term = join(installed.cwd, "term");
    const readyDeadline = performance.now() + 600;
    while (!existsSync(marker) && performance.now() < readyDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(marker)).toBe(true);
    await new Promise(resolve => setTimeout(resolve, 30));
    controller.abort();
    expect(await result).toMatchObject({ outcome: "timed-out", stopReason: "caller_cancelled", submitted: true, stdout: "accepted write\n" });
    await new Promise(resolve => setTimeout(resolve, 100));
    expect(existsSync(term)).toBe(false);
    const containmentDeadline = performance.now() + 1_500;
    while (!existsSync(term) && performance.now() < containmentDeadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(existsSync(term)).toBe(true);
    expect(performance.now() - started).toBeGreaterThanOrEqual(950);
  });

  it("gives an injected accepted write an independent owner without repeating dispatch", async () => {
    const installed = await install("registered.mjs");
    const cli = cliFor(installed, { timeoutMs: 1_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const controller = new AbortController();
    const observedStops: boolean[] = [];
    let dispatches = 0;
    const runner = boundedCliRunner(cli, async () => {
      dispatches++;
      currentRequestScope()!.signal.addEventListener("abort", () => observedStops.push(true));
      return new Promise<CliRun>(() => {});
    });
    const pending = withRequestSignal(controller.signal, () => runner(["env", "save", "env-alpha"], { write: true }));
    controller.abort();
    expect(await pending).toMatchObject({ stopReason: "caller_cancelled", submitted: true });
    expect(observedStops).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(observedStops).toEqual([true]);
    expect(dispatches).toBe(1);
  });

  it("does not replenish a parent deadline between readiness children", async () => {
    const installed = await install("registered.mjs");
    const cli = cliFor(installed, { timeoutMs: 1_000 });
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
    const scope = createWaitScope({ timeoutMs: 1_000 });
    const calls: string[] = [];
    const runner = async (args: readonly string[]): Promise<CliRun> => {
      calls.push(args.join(" "));
      await new Promise(resolve => setTimeout(resolve, 600));
      return { outcome: "exited", exitCode: 0, signal: null, stdout: args[0] === "--version" ? "cursor 1.2.3" : "Commands:\n  env  environments\n  status identity\n", stderr: "", truncated: false };
    };
    try {
      const pending = withWaitScope(scope, () => cursorCliReadiness({ cli, runner, restEmail: OWNER }));
      await vi.advanceTimersByTimeAsync(1_000);
      expect(await pending).toMatchObject({ ready: false });
      expect(calls).toEqual(["--version", "--help"]);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(calls).toEqual(["--version", "--help"]);
    } finally { scope.dispose(); }
  });

  it("settles with partial output and releases inherited pipes after containment grace", async () => {
    const installed = await install("ignores-term.mjs");
    const cli = cliFor(installed, { timeoutMs: 1_000 });
    const pipeCount = () => process.getActiveResourcesInfo().filter(name => name === "PipeWrap").length;
    const originalPipes = pipeCount();
    const started = performance.now();
    const result = await cursorCliRunner(cli)(ENV_LIST_ARGS);
    expect(result).toMatchObject({ outcome: "timed-out", stopReason: "deadline", stdout: "partial output\n" });
    expect(performance.now() - started).toBeLessThan(2_500);
    await new Promise(resolve => setTimeout(resolve, CLI_KILL_GRACE_MS + 200));
    expect(pipeCount()).toBeLessThanOrEqual(originalPipes);
  });

  it("gives the child no credential, a literal argv, and the configured cwd", async () => {
    process.env.CURSOR_API_KEY = "key_must_not_reach_the_cli";
    const installed = await install("reflect.mjs");
    const cli = cliFor(installed);
    const run = await cursorCliRunner(cli)(["report", "$HOME;echo hi"]);
    expect(run.outcome).toBe("exited");
    expect(run.exitCode).toBe(0);
    const parsed = parseCliJson(run, cli.maxOutputBytes);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const value = parsed.value as {
      envKeys: string[];
      argv: string[];
      cwd: string;
    };
    expect(value.envKeys).not.toContain("CURSOR_API_KEY");
    expect(value.envKeys).not.toContain("CURSOR_MCP_POLICY");
    // No shell ran, so neither the variable nor the separator was interpreted.
    expect(value.argv).toEqual(["report", "$HOME;echo hi"]);
    expect(value.cwd).toContain("cursor-mcp-cli-cwd-");
  });

  it("rebuilds the child environment rather than filtering it", () => {
    const env = cliChildEnv({
      PATH: "/usr/bin",
      HOME: "/home/tester",
      CURSOR_API_KEY: "key_secret",
      SOME_OTHER_TOKEN: "also_secret",
    });
    expect(Object.keys(env).sort()).toEqual(["HOME", "LANG", "LC_ALL", "PATH"]);
  });

  it("refuses an argument outside printable ASCII", async () => {
    const installed = await install("reflect.mjs");
    const run = cursorCliRunner(cliFor(installed));
    expect(() => run(["report", `bad${String.fromCharCode(10)}arg`])).toThrow(
      CliArgumentError,
    );
  });

  it("refuses an environmentPublicId that would become a flag", () => {
    expect(() => envGetArgs("--help")).toThrow(CliArgumentError);
    expect(() => envGetArgs("env alpha")).toThrow(CliArgumentError);
    expect(envGetArgs("env-alpha")).toEqual([
      "env",
      "get",
      "env-alpha",
      "--output",
      "json",
    ]);
  });

  it(
    "terminates on timeout and reaps the descendant the child left behind",
    async () => {
      const installed = await install("slow.mjs");
      const cli = cliFor(installed, { timeoutMs: 1_000 });
      const run = await cursorCliRunner(cli)(["env", "list", "--output", "json"]);
      expect(run.outcome).toBe("timed-out");
      // The grandchild would write this 1.5s in. The group kill must have taken
      // it with the parent, so waiting past its deadline must find nothing.
      await new Promise((resolve) => setTimeout(resolve, 2_500));
      expect(existsSync(join(installed.cwd, "descendant.log"))).toBe(false);
    },
    20_000,
  );

  it("cuts an oversized answer and refuses to parse the fragment", async () => {
    const installed = await install("oversized.mjs");
    const cli = cliFor(installed, { maxOutputBytes: 2_048 });
    const run = await cursorCliRunner(cli)(ENV_LIST_ARGS);
    expect(run.truncated).toBe(true);
    const parsed = parseCliJson(run, cli.maxOutputBytes);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("CLI_OUTPUT_OVERSIZED");
  });

  it("refuses JSON wrapped in prose rather than scraping it out", async () => {
    const installed = await install("malformed.mjs");
    const cli = cliFor(installed);
    const run = await cursorCliRunner(cli)(ENV_LIST_ARGS);
    expect(run.exitCode).toBe(0);
    const parsed = parseCliJson(run, cli.maxOutputBytes);
    expect(parsed.ok).toBe(false);
    if (parsed.ok) return;
    expect(parsed.code).toBe("CLI_OUTPUT_NOT_JSON");
  });
});

describe("parsing", () => {
  it("refuses a top-level scalar, empty output, and a bad document", () => {
    const base = { truncated: false };
    expect(parseCliJson({ ...base, stdout: "" }, 1_024)).toMatchObject({
      code: "CLI_OUTPUT_EMPTY",
    });
    expect(parseCliJson({ ...base, stdout: '"just a string"' }, 1_024)).toMatchObject({
      code: "CLI_OUTPUT_NOT_STRUCTURED",
    });
    expect(parseCliJson({ ...base, stdout: "{" }, 1_024)).toMatchObject({
      code: "CLI_OUTPUT_NOT_JSON",
    });
  });

  it("drops a __proto__ key rather than letting it reach an object", () => {
    const parsed = parseCliJson(
      { stdout: '{"__proto__":{"polluted":true},"ok":1}', truncated: false },
      1_024,
    );
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(Object.getPrototypeOf(parsed.value)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  it("reads a version from either a bare or a prefixed line", () => {
    expect(parseCliVersion("cursor 1.2.3\n")).toBe("cursor 1.2.3");
    expect(parseCliVersion("\n\n  2.0.0  \n")).toBe("2.0.0");
    expect(parseCliVersion("   \n")).toBeUndefined();
    expect(isCompatibleCliVersion("cursor 1.2.3", ["1.2.3"])).toBe(true);
    expect(isCompatibleCliVersion("cursor 1.2.3", ["cursor 1.2.3"])).toBe(true);
    expect(isCompatibleCliVersion("cursor 1.2.4", ["1.2.3"])).toBe(false);
    expect(isCompatibleCliVersion(undefined, ["1.2.3"])).toBe(false);
  });

  it("finds commands only under a commands section", () => {
    expect(
      parseHelpCommands(
        [
          "Usage: cursor <command>",
          "",
          "Commands:",
          "  env      Manage environments",
          "  status   Show login",
          "",
          "Options:",
          "  --help   Show help",
        ].join("\n"),
      ),
    ).toEqual(["env", "status"]);
    // Agent-prompt help: prose and flags, and therefore no commands at all.
    expect(
      parseHelpCommands(
        ["Usage: cursor <prompt>", "", "Options:", "  --help  Show help"].join("\n"),
      ),
    ).toEqual([]);
    expect(
      parseHelpCommands(
        [
          "Commands:",
          "  agent   Start an agent using configured",
          "          env variables and project settings",
          "  status  Show login",
        ].join("\n"),
      ),
    ).toEqual(["agent", "status"]);
  });
});
