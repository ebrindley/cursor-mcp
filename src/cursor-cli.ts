/**
 * The Cursor CLI as an *optional* read authority.
 *
 * This is a fourth authority alongside `api-key`, `delegated-run`, and
 * `repo-commit`: a locally installed binary the operator names by absolute path.
 * It is off unless the policy file configures it, and configuring it grants
 * nothing on its own -- environment reads and each write operation are separate
 * gates, so turning reads on can never turn writes on, and enabling one write
 * never enables another.
 *
 * Four rules shape everything below.
 *
 * **Nothing is inherited.** The child gets a minimal, rebuilt environment. This
 * server's `CURSOR_API_KEY` is never forwarded, never placed in argv, and never
 * logged: the CLI authenticates as whoever logged it in, and pretending
 * otherwise would silently widen one credential into another. Because the
 * identity is therefore *not* ours, it is verified against `GET /v1/me` before
 * any environment command runs.
 *
 * **Registration is proven, never assumed.** The Cursor CLI's root argument is an
 * agent prompt. Issuing `cursor env list` against a build where `env` is not a
 * registered command would submit "env list" as a prompt and launch an agent. So
 * the command set is read out of `--help` first, and a root help that advertises
 * no commands is reported as `FEATURE_GATED` -- a fail-closed state, not a
 * fallback.
 *
 * **The child is bounded.** No shell, a controlled working directory, a byte
 * ceiling per stream, a wall-clock timeout, and a process-group kill so a
 * descendant cannot outlive the timeout. Stdin is closed for reads; a write may
 * supply a document, and nothing else.
 *
 * **The output is untrusted.** It is sanitized on the way in, parsed strictly
 * (one whole JSON document, object or array at the top), and never scraped out of
 * surrounding prose.
 *
 * Integration uses commands and flags advertised by the configured CLI.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { sanitize } from "./untrusted.js";

/** The authority label these results carry. Not `api-key`, not `delegated-run`. */
export const CLI_AUTHORITY = "cursor-cli" as const;

export const DEFAULT_CLI_TIMEOUT_MS = 15_000;
export const DEFAULT_CLI_MAX_OUTPUT_BYTES = 262_144;

/** Grace between SIGTERM and SIGKILL for a child that ignored the first. */
export const CLI_KILL_GRACE_MS = 2_000;

/** Longest version string echoed back. A version line is short or it is wrong. */
export const MAX_CLI_VERSION_CHARS = 64;

/** Root commands this module will ever ask the CLI to run. */
export const ENVIRONMENT_COMMAND = "env";
export const IDENTITY_COMMAND = "status";

/**
 * Printable ASCII only.
 *
 * Every argument is either a module constant or an opaque Cursor identifier, so
 * anything else is a caller trying to build a different command line.
 */
const SAFE_ARG = new RegExp("^[\\u0020-\\u007E]+$");

/** A path with a control character or a NUL is refused rather than spawned. */
const SAFE_PATH = new RegExp("^[^\\u0000-\\u001F\\u007F]+$");

/* ------------------------------------------------------------------- config */

/**
 * Operator configuration for the CLI.
 *
 * `path` is absolute on purpose: resolving a bare name through `PATH` would let
 * whatever is first on the operator's `PATH` answer as the Cursor CLI.
 *
 * `compatibleVersions` is an explicit list, not a range. The command contract
 * this module depends on is unpublished, so an operator states the versions they
 * checked rather than trusting a comparison against a version that does not
 * exist yet.
 *
 * `environmentReads` and the write gates are independent. Enabling reads never
 * enables a write. `environmentWrites` is not an operation grant: publish, Save,
 * and delete each have their own flag, and team writes need yet another.
 */
export const CursorCliSchema = z.strictObject({
  path: z
    .string()
    .trim()
    .min(1)
    .refine((value) => SAFE_PATH.test(value), "path must contain no control characters")
    .refine(isAbsolute, "path must be absolute; a bare name would resolve through PATH"),
  compatibleVersions: z.array(z.string().trim().min(1)).min(1),
  /** Global environment discovery and configuration reads. Off by default. */
  environmentReads: z.boolean().default(false),
  /**
   * Not an operation grant. Kept so an operator who turned this on while writes
   * were unimplemented does not silently receive publish, Save, or delete.
   */
  environmentWrites: z.boolean().default(false),
  /** Personal publication to a pull request. Off by default; not implied by reads. */
  publishEnabled: z.boolean().default(false),
  /** Personal database Save. Off by default; not implied by publish or reads. */
  databaseSaveEnabled: z.boolean().default(false),
  /**
   * Environment deletion through the CLI. Off by default, and independent of the
   * policy-root `deleteEnabled` that gates agent deletion.
   */
  deleteEnabled: z.boolean().default(false),
  /**
   * Team-scoped writes. Off by default, and not implied by any personal write
   * gate: a working personal Save does not authorize a team Save.
   */
  teamWritesEnabled: z.boolean().default(false),
  timeoutMs: z.number().int().min(1_000).max(120_000).default(DEFAULT_CLI_TIMEOUT_MS),
  maxOutputBytes: z
    .number()
    .int()
    .min(1_024)
    .max(4_194_304)
    .default(DEFAULT_CLI_MAX_OUTPUT_BYTES),
  /**
   * Working directory for the child. Defaults to the system temporary directory:
   * the CLI must not read a repository this server happens to be started in.
   */
  cwd: z
    .string()
    .trim()
    .min(1)
    .refine((value) => SAFE_PATH.test(value), "cwd must contain no control characters")
    .refine(isAbsolute, "cwd must be absolute")
    .optional(),
});

export type CursorCli = z.infer<typeof CursorCliSchema>;

/* ------------------------------------------------------------------ digests */

/** `sha256:<12 hex>`. One-way, and never a secret value. */
export function cliDigest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12)}`;
}

/* ------------------------------------------------------------------- runner */

export type CliOutcome = "exited" | "timed-out" | "spawn-failed";

export interface CliRun {
  outcome: CliOutcome;
  /** null when the child was killed or never started. */
  exitCode: number | null;
  signal: string | null;
  /** Sanitized and byte-bounded. */
  stdout: string;
  stderr: string;
  /** True when either stream hit the ceiling and was cut. */
  truncated: boolean;
  /** Present only for `spawn-failed`, and only the errno code, never a path. */
  errorCode?: string;
}

/** Optional stdin for a write that must supply a document. Reads omit this. */
export interface CliRunOptions {
  stdin?: string;
}

/** The one seam tests replace. Production builds it from a `CursorCli`. */
export type CliRunner = (
  args: readonly string[],
  options?: CliRunOptions,
) => Promise<CliRun>;

export class CliArgumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgumentError";
  }
}

/**
 * The child's whole environment.
 *
 * Rebuilt rather than filtered, so a variable added to this server's environment
 * later cannot reach the child by default. `HOME` is deliberately present: it is
 * where the CLI keeps its own login, which is the credential this module wants it
 * to use instead of ours.
 */
export function cliChildEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    PATH: source.PATH ?? "/usr/bin:/bin",
    LANG: "C",
    LC_ALL: "C",
  };
  for (const name of ["HOME", "TMPDIR", "USERPROFILE", "SYSTEMROOT", "APPDATA"]) {
    const value = source[name];
    if (value !== undefined) env[name] = value;
  }
  // Belt and braces: the two names that would forward this server's credential
  // are removed even though the object above never adds them.
  delete env.CURSOR_API_KEY;
  delete env.CURSOR_MCP_POLICY;
  return env;
}

/** Accumulate a stream up to a ceiling, reporting when it was cut. */
class BoundedStream {
  readonly #limit: number;
  readonly #chunks: Buffer[] = [];
  #bytes = 0;
  truncated = false;

  constructor(limit: number) {
    this.#limit = limit;
  }

  /** Returns true when this chunk pushed the stream past its ceiling. */
  push(chunk: Buffer): boolean {
    if (this.truncated) return false;
    const room = this.#limit - this.#bytes;
    if (chunk.byteLength <= room) {
      this.#chunks.push(chunk);
      this.#bytes += chunk.byteLength;
      return false;
    }
    if (room > 0) this.#chunks.push(chunk.subarray(0, room));
    this.#bytes = this.#limit;
    this.truncated = true;
    return true;
  }

  text(): string {
    return sanitize(Buffer.concat(this.#chunks).toString("utf8"));
  }
}

function killGroup(pid: number, signal: NodeJS.Signals): void {
  // Negative pid targets the group, so an install script the CLI spawned dies
  // with it. Windows has no groups; the direct kill is the fallback.
  try {
    process.kill(-pid, signal);
    return;
  } catch {
    /* fall through */
  }
  try {
    process.kill(pid, signal);
  } catch {
    /* already gone */
  }
}

/**
 * Build the production runner.
 *
 * No shell, a fixed working directory, and a rebuilt environment. Stdin is
 * closed unless the caller supplies a document. The promise always resolves: a
 * spawn failure, a timeout, and a non-zero exit are all outcomes a caller must
 * classify, not exceptions to bubble.
 */
export function cursorCliRunner(cli: CursorCli): CliRunner {
  const cwd = cli.cwd ?? tmpdir();
  return (args: readonly string[], options?: CliRunOptions) => {
    for (const arg of args) {
      if (!SAFE_ARG.test(arg)) {
        throw new CliArgumentError(
          "a Cursor CLI argument contained a character outside printable ASCII",
        );
      }
    }
    const stdin = options?.stdin;
    if (stdin !== undefined && Buffer.byteLength(stdin, "utf8") > cli.maxOutputBytes) {
      throw new CliArgumentError(
        "CLI stdin exceeds cursorCli.maxOutputBytes; the document is not sent",
      );
    }
    return new Promise<CliRun>((resolve) => {
      const stdout = new BoundedStream(cli.maxOutputBytes);
      const stderr = new BoundedStream(cli.maxOutputBytes);
      let settled = false;
      let timedOut = false;
      let killTimer: NodeJS.Timeout | undefined;
      const useStdin = stdin !== undefined;

      const child = spawn(cli.path, [...args], {
        cwd,
        env: cliChildEnv(),
        stdio: [useStdin ? "pipe" : "ignore", "pipe", "pipe"],
        shell: false,
        detached: true,
        windowsHide: true,
      });

      const finish = (run: CliRun) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (killTimer !== undefined) clearTimeout(killTimer);
        resolve(run);
      };

      const stop = () => {
        if (child.pid === undefined) return;
        const pid = child.pid;
        killGroup(pid, "SIGTERM");
        killTimer = setTimeout(() => killGroup(pid, "SIGKILL"), CLI_KILL_GRACE_MS);
        killTimer.unref();
      };

      const timer = setTimeout(() => {
        timedOut = true;
        stop();
      }, cli.timeoutMs);
      timer.unref();

      // An oversized stream is stopped rather than drained: reading past the
      // ceiling costs work and buys nothing, and `truncated` already reports it.
      child.stdout?.on("data", (chunk: Buffer) => {
        if (stdout.push(chunk)) stop();
      });
      child.stderr?.on("data", (chunk: Buffer) => {
        if (stderr.push(chunk)) stop();
      });
      child.stdout?.on("error", () => undefined);
      child.stderr?.on("error", () => undefined);
      if (useStdin) {
        child.stdin?.on("error", () => undefined);
        child.stdin?.end(stdin, "utf8");
      }

      child.on("error", (error: NodeJS.ErrnoException) => {
        finish({
          outcome: "spawn-failed",
          exitCode: null,
          signal: null,
          stdout: "",
          stderr: "",
          truncated: false,
          ...(error.code === undefined ? {} : { errorCode: error.code }),
        });
      });

      child.on("close", (code, signal) => {
        finish({
          outcome: timedOut ? "timed-out" : "exited",
          exitCode: code,
          signal,
          stdout: stdout.text(),
          stderr: stderr.text(),
          truncated: stdout.truncated || stderr.truncated,
        });
      });
    });
  };
}

/* ------------------------------------------------------------ command lines */

/**
 * The only argument vectors this module issues, and only once `--help` has
 * proven the root command is registered.
 */
export const ENV_LIST_ARGS: readonly string[] = [
  ENVIRONMENT_COMMAND,
  "list",
  "--output",
  "json",
];

/** Subcommand help, used only to prove a write verb is registered. */
export const ENV_HELP_ARGS: readonly string[] = [ENVIRONMENT_COMMAND, "--help"];

export const ENV_PUBLISH_COMMAND = "publish";
export const ENV_SAVE_COMMAND = "save";
export const ENV_DELETE_COMMAND = "delete";
export type CliWriteOperation = "publish" | "save" | "delete";

export function envWriteHelpArgs(operation: CliWriteOperation): string[] {
  return [ENVIRONMENT_COMMAND, writeSubcommand(operation), "--help"];
}

export function parseHelpFlags(stdout: string): string[] {
  const flags = new Set<string>();
  for (const raw of stdout.split("\n")) {
    const trimmed = raw.trim();
    if (!trimmed.startsWith("-")) continue;
    for (const match of trimmed.matchAll(/(?:^|[\s,])(--[a-z][a-z0-9-]*)(?=[\s,=]|$)/g)) {
      if (match[1] !== undefined) flags.add(match[1]);
    }
  }
  return [...flags].sort();
}

/**
 * Flags this module will never put on a write vector.
 *
 * `SetTeamEnvironmentJson` advertises a compound delete-personal-on-team-write
 * option. That is a second mutation smuggled into a Save, so it is not exposed
 * as an argument, a flag, or a default.
 */
export const FORBIDDEN_CLI_WRITE_FLAGS = [
  "--delete-personal",
  "--delete-personal-environment",
  "--delete_personal_environment",
  "--deletePersonalEnvironment",
] as const;

/** One opaque identifier token: the same grammar `config.ts` pins a binding to. */
const PUBLIC_ID = /^[A-Za-z0-9_.:-]+$/;
const ALL_DIGITS = /^\d+$/;

/**
 * A public opaque id, refused when it would be a flag, a subcommand, or the
 * provider's internal numeric row key.
 */
export function assertPublicEnvironmentId(environmentPublicId: string): string {
  if (
    !PUBLIC_ID.test(environmentPublicId) ||
    environmentPublicId.startsWith("-") ||
    ALL_DIGITS.test(environmentPublicId)
  ) {
    throw new CliArgumentError(
      "environmentPublicId must be one opaque identifier token, must not begin with a dash, " +
        "and must not be an all-digits internal id",
    );
  }
  return environmentPublicId;
}

/**
 * A freshly resolved internal row key, only as a decimal argument.
 *
 * Callers never supply this; a write resolves it from a just-issued `env list`.
 */
export function assertInternalEnvironmentId(id: number): string {
  if (!Number.isInteger(id) || id <= 0 || !Number.isSafeInteger(id)) {
    throw new CliArgumentError(
      "internal environment id must be a positive integer resolved from a fresh CLI list",
    );
  }
  return String(id);
}

function assertSafeWriteArgs(args: readonly string[]): void {
  for (const arg of args) {
    const token = arg.split("=")[0] ?? arg;
    if ((FORBIDDEN_CLI_WRITE_FLAGS as readonly string[]).includes(token)) {
      throw new CliArgumentError(
        "the compound delete-personal-on-team-write option is not exposed",
      );
    }
  }
}

/**
 * Build the `env get` vector.
 *
 * The id is checked here as well as in the tool's input schema. An id beginning
 * with `-` would become a flag, and a bare word would become a second
 * subcommand; either way the CLI would run something other than the read.
 */
export function envGetArgs(environmentPublicId: string): string[] {
  return [ENVIRONMENT_COMMAND, "get", assertPublicEnvironmentId(environmentPublicId), "--output", "json"];
}

export function envPublishArgs(environmentPublicId: string): string[] {
  const args = [
    ENVIRONMENT_COMMAND,
    ENV_PUBLISH_COMMAND,
    assertPublicEnvironmentId(environmentPublicId),
    "--output",
    "json",
  ];
  assertSafeWriteArgs(args);
  return args;
}

export function envSaveArgs(environmentPublicId: string): string[] {
  const args = [
    ENVIRONMENT_COMMAND,
    ENV_SAVE_COMMAND,
    assertPublicEnvironmentId(environmentPublicId),
    "--stdin",
    "--output",
    "json",
  ];
  assertSafeWriteArgs(args);
  return args;
}

/** Dry-run uses the public id the caller already holds. */
export function envDeleteDryRunArgs(environmentPublicId: string): string[] {
  const args = [
    ENVIRONMENT_COMMAND,
    ENV_DELETE_COMMAND,
    "--dry-run",
    assertPublicEnvironmentId(environmentPublicId),
    "--output",
    "json",
  ];
  assertSafeWriteArgs(args);
  return args;
}

/** Dispatch uses the internal id resolved from a fresh list, never from the caller. */
export function envDeleteArgs(internalId: number): string[] {
  const args = [
    ENVIRONMENT_COMMAND,
    ENV_DELETE_COMMAND,
    assertInternalEnvironmentId(internalId),
    "--output",
    "json",
  ];
  assertSafeWriteArgs(args);
  return args;
}

export function writeSubcommand(operation: CliWriteOperation): string {
  if (operation === "publish") return ENV_PUBLISH_COMMAND;
  if (operation === "save") return ENV_SAVE_COMMAND;
  return ENV_DELETE_COMMAND;
}

export function writeGateName(
  operation: CliWriteOperation,
): "publishEnabled" | "databaseSaveEnabled" | "deleteEnabled" {
  if (operation === "publish") return "publishEnabled";
  if (operation === "save") return "databaseSaveEnabled";
  return "deleteEnabled";
}

export function writeGateDisabledStatus(operation: CliWriteOperation): string {
  if (operation === "publish") return "CLI_PUBLISH_DISABLED";
  if (operation === "save") return "CLI_DATABASE_SAVE_DISABLED";
  return "CLI_DELETE_DISABLED";
}

/* --------------------------------------------------------------- JSON parsing */

export type CliJsonError =
  | "CLI_OUTPUT_EMPTY"
  | "CLI_OUTPUT_OVERSIZED"
  | "CLI_OUTPUT_NOT_JSON"
  | "CLI_OUTPUT_NOT_STRUCTURED";

export type CliJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; code: CliJsonError; message: string };

/** Dropped rather than assigned: `__proto__` from JSON is never a data field. */
function withoutPrototypeKey(key: string, value: unknown): unknown {
  return key === "__proto__" ? undefined : value;
}

/**
 * Parse a CLI payload strictly.
 *
 * The whole output must be one JSON document with an object or array at the top.
 * Scraping JSON out of surrounding prose is exactly how an agent-help or
 * error-banner build gets mistaken for a structured answer.
 */
export function parseCliJson(
  run: Pick<CliRun, "stdout" | "truncated">,
  maxBytes: number,
): CliJsonResult {
  if (run.truncated) {
    return {
      ok: false,
      code: "CLI_OUTPUT_OVERSIZED",
      message: `the CLI wrote more than ${maxBytes} bytes; the payload was cut and is not parsed`,
    };
  }
  const text = run.stdout.trim();
  if (text === "") {
    return { ok: false, code: "CLI_OUTPUT_EMPTY", message: "the CLI wrote nothing on stdout" };
  }
  let value: unknown;
  try {
    value = JSON.parse(text, withoutPrototypeKey);
  } catch {
    return {
      ok: false,
      code: "CLI_OUTPUT_NOT_JSON",
      message: "the CLI output was not one whole JSON document",
    };
  }
  if (value === null || typeof value !== "object") {
    return {
      ok: false,
      code: "CLI_OUTPUT_NOT_STRUCTURED",
      message: "the CLI output parsed, but its top level was not an object or an array",
    };
  }
  return { ok: true, value };
}

/* ----------------------------------------------------------- version / help */

/**
 * The version token from a `--version` line.
 *
 * Bounded and sanitized. `cursor 1.2.3` and `1.2.3` both yield `1.2.3` so an
 * operator's `compatibleVersions` entry does not have to include the product
 * name, and the raw line is also matched in case a build prints something else.
 */
export function parseCliVersion(stdout: string): string | undefined {
  const line = stdout
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  if (line === undefined) return undefined;
  return line.slice(0, MAX_CLI_VERSION_CHARS);
}

const VERSION_TOKEN = /\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/;

export function isCompatibleCliVersion(
  line: string | undefined,
  compatible: readonly string[],
): boolean {
  if (line === undefined) return false;
  if (compatible.includes(line)) return true;
  const token = VERSION_TOKEN.exec(line);
  return token !== null && compatible.includes(token[0]);
}

const COMMAND_SECTION = /^\s*(?:available\s+)?(?:sub)?commands\b/i;
const COMMAND_NAME = /^([a-z][a-z0-9-]*)(?:\s|$)/;
/** A help entry is indented under its section header; a new header is not. */
const INDENTED = /^\s/;

/**
 * Root commands a `--help` output advertises.
 *
 * Only names listed under a commands section count. An empty result is the
 * signal that matters: the Cursor CLI's root help describes an agent prompt, so
 * "no commands section" means no operational command is registered on this
 * build, and none may be issued.
 */
export function parseHelpCommands(stdout: string): string[] {
  const commands = new Set<string>();
  let inSection = false;
  let commandIndent: number | undefined;
  for (const raw of stdout.split("\n")) {
    if (raw.trim() === "") continue;
    if (COMMAND_SECTION.test(raw)) {
      inSection = true;
      commandIndent = undefined;
      continue;
    }
    if (!INDENTED.test(raw)) {
      inSection = false;
      continue;
    }
    if (!inSection) continue;
    const trimmed = raw.trim();
    // A flag is not a command, and neither is prose that starts with a capital.
    if (trimmed.startsWith("-")) continue;
    const match = COMMAND_NAME.exec(trimmed);
    if (match?.[1] === undefined) continue;
    const indent = raw.length - raw.trimStart().length;
    // The first command establishes the entry indentation. Wrapped description
    // prose is indented further and must never fabricate an executable command.
    commandIndent ??= indent;
    if (indent === commandIndent) commands.add(match[1]);
  }
  return [...commands].sort();
}

/* -------------------------------------------------------------- capability */

/**
 * What the CLI is, factually.
 *
 * `FEATURE_GATED` is the honest name for "the command is not registered on this
 * build" -- including the root-agent-help case. It is not a maturity claim about
 * Cursor's product, and it never becomes a reason to try the command anyway.
 */
export type CliAvailability =
  | "NOT_CONFIGURED"
  | "READS_DISABLED"
  | "WRITES_DISABLED"
  | "MISSING"
  | "UNREADABLE"
  | "INCOMPATIBLE"
  | "FEATURE_GATED"
  | "REGISTERED";

export interface CliCapability {
  availability: CliAvailability;
  authority: typeof CLI_AUTHORITY;
  /** Exactly what `--version` printed, bounded. Absent when unreadable. */
  version?: string;
  compatible: boolean;
  /** Root commands `--help` advertised. Empty means root agent help. */
  commands: string[];
  environmentCommandRegistered: boolean;
  identityCommandRegistered: boolean;
  /** Digest over version plus the advertised command set. */
  contractFingerprint?: string;
  reason: string;
  nextSteps: string[];
}

const RECHECK =
  "Re-check with cursor_list_environments; it reports availability and never issues an unregistered command.";

function capability(args: {
  availability: CliAvailability;
  version?: string | undefined;
  compatible: boolean;
  commands: string[];
  contractFingerprint?: string | undefined;
  reason: string;
  nextSteps: string[];
}): CliCapability {
  const result: CliCapability = {
    availability: args.availability,
    authority: CLI_AUTHORITY,
    compatible: args.compatible,
    commands: args.commands,
    environmentCommandRegistered: args.commands.includes(ENVIRONMENT_COMMAND),
    identityCommandRegistered: args.commands.includes(IDENTITY_COMMAND),
    reason: args.reason,
    nextSteps: args.nextSteps,
  };
  if (args.version !== undefined) result.version = args.version;
  if (args.contractFingerprint !== undefined) {
    result.contractFingerprint = args.contractFingerprint;
  }
  return result;
}

/** No `cursorCli` block in the policy file. */
export function notConfiguredCapability(): CliCapability {
  return capability({
    availability: "NOT_CONFIGURED",
    compatible: false,
    commands: [],
    reason:
      "No Cursor CLI is configured. Global environment discovery has no published API-key contract, " +
      "so without a CLI this read has no authority at all.",
    nextSteps: [
      "Set `cursorCli.path` to the absolute path of a Cursor CLI you have checked, and list its version in `cursorCli.compatibleVersions`.",
    ],
  });
}

/** Configured, but the operator has not opted into environment reads. */
export function readsDisabledCapability(): CliCapability {
  return capability({
    availability: "READS_DISABLED",
    compatible: false,
    commands: [],
    reason:
      "A Cursor CLI is configured but `cursorCli.environmentReads` is false. Configuring the CLI " +
      "grants nothing on its own.",
    nextSteps: ["Set `cursorCli.environmentReads` to true in the policy file."],
  });
}

/**
 * Probe the CLI: version first, then the command set.
 *
 * An incompatible version stops the probe. Reading `--help` from a build nobody
 * checked would fingerprint a contract this module has no basis to trust.
 */
export async function detectCursorCliCapability(args: {
  cli: CursorCli;
  run: CliRunner;
}): Promise<CliCapability> {
  const { cli, run } = args;
  const versionRun = await run(["--version"]);
  if (versionRun.outcome === "spawn-failed") {
    const missing =
      versionRun.errorCode === "ENOENT" ||
      versionRun.errorCode === "ENOTDIR" ||
      versionRun.errorCode === "EACCES";
    return capability({
      availability: missing ? "MISSING" : "UNREADABLE",
      compatible: false,
      commands: [],
      reason: missing
        ? `No executable Cursor CLI at the configured path (${versionRun.errorCode ?? "spawn failed"}).`
        : `The configured Cursor CLI could not be started (${versionRun.errorCode ?? "spawn failed"}).`,
      nextSteps: [
        "Correct `cursorCli.path`, or remove the `cursorCli` block to run without a CLI.",
      ],
    });
  }
  if (versionRun.outcome === "timed-out") {
    return capability({
      availability: "UNREADABLE",
      compatible: false,
      commands: [],
      reason: `The Cursor CLI did not print a version within ${cli.timeoutMs} ms and was terminated.`,
      nextSteps: ["Raise `cursorCli.timeoutMs`, or check the CLI by hand.", RECHECK],
    });
  }
  if (versionRun.truncated) {
    return capability({
      availability: "UNREADABLE",
      compatible: false,
      commands: [],
      reason:
        `The Cursor CLI wrote more than ${cli.maxOutputBytes} bytes for --version; the cut output ` +
        "cannot establish a version.",
      nextSteps: ["Check the CLI by hand, then re-check.", RECHECK],
    });
  }

  const version = parseCliVersion(versionRun.stdout);
  if (versionRun.exitCode !== 0 || version === undefined) {
    return capability({
      availability: "UNREADABLE",
      ...(version === undefined ? {} : { version }),
      compatible: false,
      commands: [],
      reason:
        `The Cursor CLI exited ${versionRun.exitCode ?? "on a signal"} for --version, so its ` +
        "version is unknown and no command may be issued.",
      nextSteps: ["Check the CLI by hand, then re-check.", RECHECK],
    });
  }

  if (!isCompatibleCliVersion(version, cli.compatibleVersions)) {
    return capability({
      availability: "INCOMPATIBLE",
      version,
      compatible: false,
      commands: [],
      reason:
        `The installed Cursor CLI reports ${JSON.stringify(version)}, which is not in ` +
        "`cursorCli.compatibleVersions`. The command contract is unpublished, so an unlisted " +
        "version is not assumed to match.",
      nextSteps: [
        "Check this version's environment commands yourself, then add it to `cursorCli.compatibleVersions`.",
      ],
    });
  }

  const helpRun = await run(["--help"]);
  if (helpRun.truncated) {
    return capability({
      availability: "UNREADABLE",
      version,
      compatible: true,
      commands: [],
      reason:
        `The Cursor CLI wrote more than ${cli.maxOutputBytes} bytes for --help; a cut command ` +
        "contract cannot authorize any command.",
      nextSteps: [
        "Raise `cursorCli.maxOutputBytes`, or check the CLI by hand.",
        RECHECK,
      ],
    });
  }
  if (helpRun.outcome !== "exited" || helpRun.exitCode !== 0) {
    return capability({
      availability: "UNREADABLE",
      version,
      compatible: true,
      commands: [],
      reason:
        helpRun.outcome === "timed-out"
          ? `The Cursor CLI did not print help within ${cli.timeoutMs} ms and was terminated.`
          : "The Cursor CLI did not print help successfully, so its command set is unknown.",
      nextSteps: [
        "No command is issued while the command set is unknown; that is deliberate.",
        RECHECK,
      ],
    });
  }
  const commands = parseHelpCommands(helpRun.stdout);
  const fingerprint = cliDigest(`${version}\n${commands.join(",")}`);

  if (commands.length === 0) {
    return capability({
      availability: "FEATURE_GATED",
      version,
      compatible: true,
      commands,
      contractFingerprint: fingerprint,
      reason:
        "The CLI's root help advertises no commands, which is agent-prompt help. Issuing an " +
        "environment command against this build would submit it as a prompt and launch an agent, " +
        "so nothing is issued.",
      nextSteps: [
        "No environment read is available on this build. Nothing is retried through a delegated run.",
        RECHECK,
      ],
    });
  }

  if (!commands.includes(ENVIRONMENT_COMMAND)) {
    return capability({
      availability: "FEATURE_GATED",
      version,
      compatible: true,
      commands,
      contractFingerprint: fingerprint,
      reason:
        `The CLI advertises commands but not \`${ENVIRONMENT_COMMAND}\`, so environment reads are ` +
        "not registered on this build.",
      nextSteps: [
        "No environment read is available on this build. Nothing is retried through a delegated run.",
        RECHECK,
      ],
    });
  }

  return capability({
    availability: "REGISTERED",
    version,
    compatible: true,
    commands,
    contractFingerprint: fingerprint,
    reason: `The CLI advertises \`${ENVIRONMENT_COMMAND}\` and reports a compatible version.`,
    nextSteps: [],
  });
}

/* ---------------------------------------------------------------- identity */

/**
 * Whether the CLI is logged in as the account this server's API key belongs to.
 *
 * `ungated` is not one of these states on purpose. The CLI's credential is not
 * ours, so an unverifiable identity is `unreadable` and stops the read: reading
 * one account's environments while reporting under another's authority is the
 * failure this gate exists to prevent.
 */
export type CliIdentityState = "verified" | "mismatch" | "auth-required" | "unreadable";

export interface CliIdentity {
  state: CliIdentityState;
  /** Digest of the CLI's account identity. The address itself is not reported. */
  cliIdentityDigest?: string;
  restIdentityDigest?: string;
  reason: string;
}

const AUTH_REQUIRED =
  /\b(not\s+logged\s+in|not\s+authenticated|unauthenti[ct]ated|unauthori[sz]ed|please\s+log\s*in|login\s+required|no\s+credentials)\b/i;

function normalizeIdentity(value: string): string {
  return value.trim().toLowerCase();
}

/** The account field, from the shapes a `status --output json` may use. */
export function readCliAccountIdentity(value: unknown): string | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  for (const key of ["email", "userEmail", "account", "accountEmail"]) {
    const entry = record[key];
    if (typeof entry === "string" && entry.trim() !== "") return entry;
  }
  for (const key of ["user", "auth", "identity"]) {
    const nested = record[key];
    if (nested !== null && typeof nested === "object") {
      const found = readCliAccountIdentity(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

/**
 * Verify the CLI's effective identity against `GET /v1/me`.
 *
 * `restEmail` is the caller's already-fetched `/v1/me` value, passed in rather
 * than fetched here so this module never holds the API key or a client.
 */
export async function verifyCursorCliIdentity(args: {
  cli: CursorCli;
  run: CliRunner;
  capability: CliCapability;
  restEmail: string | undefined;
}): Promise<CliIdentity> {
  const { cli, run, capability: cap, restEmail } = args;
  if (!cap.identityCommandRegistered) {
    return {
      state: "unreadable",
      reason:
        `The CLI does not advertise a \`${IDENTITY_COMMAND}\` command, so its effective identity ` +
        "cannot be verified against GET /v1/me. The read fails closed rather than trusting an " +
        "unverified account.",
    };
  }
  if (restEmail === undefined || restEmail.trim() === "") {
    return {
      state: "unreadable",
      reason:
        "GET /v1/me reported no owning email -- a service-account key -- so there is nothing to " +
        "compare the CLI's login against.",
    };
  }

  const identityRun = await run([IDENTITY_COMMAND, "--output", "json"]);
  if (identityRun.outcome === "timed-out") {
    return {
      state: "unreadable",
      reason: `The CLI did not report its identity within ${cli.timeoutMs} ms and was terminated.`,
    };
  }
  if (identityRun.outcome === "spawn-failed") {
    return {
      state: "unreadable",
      reason: "The CLI could not be started to report its identity.",
    };
  }

  const combined = `${identityRun.stdout}\n${identityRun.stderr}`;
  if (AUTH_REQUIRED.test(combined)) {
    return {
      state: "auth-required",
      reason:
        "The CLI is not logged in. It authenticates as whoever logged it in; this server never " +
        "forwards its own API key to it.",
    };
  }
  if (identityRun.exitCode !== 0) {
    return {
      state: "unreadable",
      reason: `The CLI exited ${identityRun.exitCode ?? "on a signal"} instead of reporting its identity.`,
    };
  }

  const parsed = parseCliJson(identityRun, cli.maxOutputBytes);
  if (!parsed.ok) {
    return { state: "unreadable", reason: `Identity readback rejected: ${parsed.message}` };
  }
  const account = readCliAccountIdentity(parsed.value);
  if (account === undefined) {
    return {
      state: "unreadable",
      reason: "The CLI's identity output named no account, so it cannot be compared with GET /v1/me.",
    };
  }

  const cliDigestValue = cliDigest(normalizeIdentity(account));
  const restDigestValue = cliDigest(normalizeIdentity(restEmail));
  if (cliDigestValue !== restDigestValue) {
    return {
      state: "mismatch",
      cliIdentityDigest: cliDigestValue,
      restIdentityDigest: restDigestValue,
      reason:
        "The CLI is logged in as a different account than this server's API key. Reading that " +
        "account's environments under this server's authority is refused.",
    };
  }
  return {
    state: "verified",
    cliIdentityDigest: cliDigestValue,
    restIdentityDigest: restDigestValue,
    reason: "The CLI's login matches the account GET /v1/me reports for this API key.",
  };
}

/* --------------------------------------------------------------- readiness */

/**
 * The one decision an environment read consults.
 *
 * `ready: false` carries the same factual fields as `ready: true`, so a caller
 * always learns availability, version, and fingerprint state -- and never gets a
 * delegated run substituted for the answer.
 *
 * The ready branch carries the configuration and the runner it verified. Handing
 * them back is what makes "a command may be issued" and "here is what to issue it
 * with" the same fact, rather than two the caller has to re-establish.
 */
export type CliReadiness =
  | {
      ready: true;
      cli: CursorCli;
      run: CliRunner;
      capability: CliCapability;
      identity: CliIdentity;
    }
  | {
      ready: false;
      /** Stable machine status for a tool result. */
      status: string;
      capability: CliCapability;
      identity?: CliIdentity;
      reason: string;
      nextSteps: string[];
    };

const NO_VM_FALLBACK =
  "This read does not fall back to a delegated run. Delegated inspection is a distinct authority; " +
  "call cursor_inspect_environment explicitly if you want it.";

function identityStatus(state: Exclude<CliIdentityState, "verified">): string {
  if (state === "mismatch") return "CLI_IDENTITY_MISMATCH";
  if (state === "auth-required") return "CLI_AUTH_REQUIRED";
  return "CLI_IDENTITY_UNREADABLE";
}

/**
 * Resolve configuration, registration, and identity in that order.
 *
 * Order matters: identity is only probed once the command set is known, so a
 * build where `status` is not registered never has an argument vector guessed at
 * it.
 */
export async function cursorCliReadiness(args: {
  cli: CursorCli | undefined;
  runner: CliRunner | undefined;
  restEmail?: string | undefined;
  /** Fetched only after version and command registration have passed. */
  getRestEmail?: (() => Promise<string | undefined>) | undefined;
}): Promise<CliReadiness> {
  const { cli, runner } = args;
  if (cli === undefined || runner === undefined) {
    const cap = notConfiguredCapability();
    return {
      ready: false,
      status: "CLI_NOT_CONFIGURED",
      capability: cap,
      reason: cap.reason,
      nextSteps: [...cap.nextSteps, NO_VM_FALLBACK],
    };
  }
  if (!cli.environmentReads) {
    const cap = readsDisabledCapability();
    return {
      ready: false,
      status: "CLI_READS_DISABLED",
      capability: cap,
      reason: cap.reason,
      nextSteps: [...cap.nextSteps, NO_VM_FALLBACK],
    };
  }

  const cap = await detectCursorCliCapability({ cli, run: runner });
  if (cap.availability !== "REGISTERED") {
    return {
      ready: false,
      status: `CLI_${cap.availability}`,
      capability: cap,
      reason: cap.reason,
      nextSteps: [...cap.nextSteps, NO_VM_FALLBACK],
    };
  }

  const restEmail =
    args.getRestEmail === undefined ? args.restEmail : await args.getRestEmail();

  const identity = await verifyCursorCliIdentity({
    cli,
    run: runner,
    capability: cap,
    restEmail,
  });
  if (identity.state !== "verified") {
    return {
      ready: false,
      status: identityStatus(identity.state),
      capability: cap,
      identity,
      reason: identity.reason,
      nextSteps: [
        identity.state === "auth-required"
          ? "Log the CLI in as the account this API key belongs to; this server will not do it for you."
          : "Reconcile the CLI's login with this server's API key before retrying.",
        NO_VM_FALLBACK,
      ],
    };
  }

  return { ready: true, cli, run: runner, capability: cap, identity };
}

/** The structured block every CLI-authority result carries, ready or not. */
export function cliAuthorityBlock(readiness: {
  capability: CliCapability;
  identity?: CliIdentity;
}): Record<string, unknown> {
  const cap = readiness.capability;
  const identity: CliIdentity | undefined = readiness.identity;
  return {
    authority: CLI_AUTHORITY,
    availability: cap.availability,
    compatible: cap.compatible,
    ...(cap.version === undefined ? {} : { version: cap.version }),
    ...(cap.contractFingerprint === undefined
      ? {}
      : { contractFingerprint: cap.contractFingerprint }),
    commands: cap.commands,
    environmentCommandRegistered: cap.environmentCommandRegistered,
    identityCommandRegistered: cap.identityCommandRegistered,
    ...(identity === undefined ? {} : { identity: { ...identity } }),
  };
}

/**
 * Why a command that ran produced no usable answer.
 *
 * Truncation is checked before the exit code: stopping an oversized child leaves
 * it dead by signal, and reporting that as a generic command failure would hide
 * the byte ceiling that actually caused it.
 */
export function classifyCliRun(
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

/* ---------------------------------------------------------- write readiness */

const NO_WRITE_FALLBACK =
  "This write does not fall back to a delegated run, a browser session, or a second CLI command.";

function writesDisabledCapability(args: {
  gate: string;
  statusReason: string;
}): CliCapability {
  return capability({
    availability: "WRITES_DISABLED",
    compatible: false,
    commands: [],
    reason: args.statusReason,
    nextSteps: [`Set \`cursorCli.${args.gate}\` to true in the policy file.`],
  });
}

export type CliWriteReadiness =
  | {
      ready: true;
      cli: CursorCli;
      run: CliRunner;
      capability: CliCapability;
      identity: CliIdentity;
      operation: CliWriteOperation;
      writeCommand: string;
      envCommands: string[];
      writeFlags: string[];
    }
  | {
      ready: false;
      status: string;
      capability: CliCapability;
      identity?: CliIdentity;
      reason: string;
      nextSteps: string[];
    };

/**
 * Resolve registration, identity, the operation-specific gate, and the write
 * subcommand, in that order.
 *
 * Reads must already be enabled: a write without a pre-read has no current-state
 * proof. `environmentWrites` is ignored as a grant. Team scope needs
 * `teamWritesEnabled` on top of the personal operation gate.
 *
 * The write subcommand is read from `env --help`. That vector is never a
 * mutation, and a missing verb is `FEATURE_GATED` rather than a guessed argv.
 */
export async function cursorCliWriteReadiness(args: {
  cli: CursorCli | undefined;
  runner: CliRunner | undefined;
  operation: CliWriteOperation;
  scope: "personal" | "team";
  restEmail?: string | undefined;
  getRestEmail?: (() => Promise<string | undefined>) | undefined;
}): Promise<CliWriteReadiness> {
  const read = await cursorCliReadiness({
    cli: args.cli,
    runner: args.runner,
    restEmail: args.restEmail,
    getRestEmail: args.getRestEmail,
  });
  if (!read.ready) {
    return {
      ready: false,
      status: read.status,
      capability: read.capability,
      ...(read.identity === undefined ? {} : { identity: read.identity }),
      reason: read.reason,
      nextSteps: read.nextSteps,
    };
  }

  const gate = writeGateName(args.operation);
  if (!read.cli[gate]) {
    const status = writeGateDisabledStatus(args.operation);
    const cap = writesDisabledCapability({
      gate,
      statusReason:
        `A Cursor CLI is configured but \`cursorCli.${gate}\` is false. ` +
        "Each write operation has its own gate; enabling reads or another write never enables this one.",
    });
    return {
      ready: false,
      status,
      capability: read.capability,
      identity: read.identity,
      reason: cap.reason,
      nextSteps: [...cap.nextSteps, NO_WRITE_FALLBACK],
    };
  }

  if (args.scope === "team" && !read.cli.teamWritesEnabled) {
    return {
      ready: false,
      status: "CLI_TEAM_WRITES_DISABLED",
      capability: read.capability,
      identity: read.identity,
      reason:
        "Team-scoped environment writes need `cursorCli.teamWritesEnabled`. A working personal " +
        "publish, Save, or delete does not grant this.",
      nextSteps: [
        "Set `cursorCli.teamWritesEnabled` to true only after checking team writes on this CLI.",
        NO_WRITE_FALLBACK,
      ],
    };
  }

  const helpRun = await read.run(ENV_HELP_ARGS);
  const helpProblem = classifyCliRun(helpRun, read.cli, "reading environment command help");
  if (helpProblem !== undefined) {
    return {
      ready: false,
      status: helpProblem.status,
      capability: read.capability,
      identity: read.identity,
      reason: helpProblem.reason,
      nextSteps: [
        "No write is issued while the environment command set is unknown; that is deliberate.",
        NO_WRITE_FALLBACK,
      ],
    };
  }

  const envCommands = parseHelpCommands(helpRun.stdout);
  const needed = writeSubcommand(args.operation);
  if (!envCommands.includes(needed)) {
    return {
      ready: false,
      status: "CLI_FEATURE_GATED",
      capability: read.capability,
      identity: read.identity,
      reason:
        `The CLI advertises \`${ENVIRONMENT_COMMAND}\` but not \`${needed}\`, so this write is ` +
        "not registered on this build.",
      nextSteps: [
        "No write is issued while the verb is unregistered. Nothing is retried through a delegated run.",
        NO_WRITE_FALLBACK,
      ],
    };
  }

  const writeHelp = await read.run(envWriteHelpArgs(args.operation));
  const writeHelpProblem = classifyCliRun(
    writeHelp,
    read.cli,
    `reading environment ${needed} help`,
  );
  if (writeHelpProblem !== undefined) {
    return {
      ready: false,
      status: writeHelpProblem.status,
      capability: read.capability,
      identity: read.identity,
      reason: writeHelpProblem.reason,
      nextSteps: [
        "No write is issued until the subcommand's exact flags are readable.",
        NO_WRITE_FALLBACK,
      ],
    };
  }
  const writeFlags = parseHelpFlags(writeHelp.stdout);
  const requiredFlags = args.operation === "delete"
    ? ["--dry-run", "--output"]
    : args.operation === "save"
      ? ["--stdin", "--output"]
      : ["--output"];
  const missingFlags = requiredFlags.filter((flag) => !writeFlags.includes(flag));
  if (missingFlags.length > 0) {
    return {
      ready: false,
      status: "CLI_FEATURE_GATED",
      capability: read.capability,
      identity: read.identity,
      reason:
        `The CLI advertises \`${needed}\` but not its required ${missingFlags.join(", ")} ` +
        "flag contract, so no write is issued.",
      nextSteps: [
        "Use a compatible CLI build whose subcommand help proves the complete write contract.",
        NO_WRITE_FALLBACK,
      ],
    };
  }

  return {
    ready: true,
    cli: read.cli,
    run: read.run,
    capability: read.capability,
    identity: read.identity,
    operation: args.operation,
    writeCommand: needed,
    envCommands,
    writeFlags,
  };
}
