/**
 * Environment Definition: read, validate, inspect, compare, and prepare a
 * Cursor environment document.
 *
 * This module is local and generic. It never calls Cursor, never writes a
 * caller's repository, and holds no customer, repository, or runtime list. Its
 * authority is `repo-commit` plus the documented environment contract reviewed
 * at https://cursor.com/schemas/environment.schema.json on 2026-09-07, and
 * nothing here persists a definition -- see `docs/environment-save-persistence.md`.
 *
 * Three result classes stay separate, because a caller acts on each differently:
 *
 *   - **schema errors** -- the document is not a legal environment definition;
 *   - **safety findings** -- the document is legal but a script looks like it
 *     persists credentials or mutates state that outlives a Build;
 *   - **capability limitations** -- what this authority cannot tell or do.
 *
 * A finding never quotes the script that produced it. Scripts and MCP patterns
 * are the fields most likely to carry an inline credential, so inspection and
 * diff report a digest, a byte count, and a line number instead of the text. The
 * digest is a one-way hash of the whole field, not a secret value.
 *
 * Strict shell mode (`set -euo pipefail`) is advisory here, not a schema
 * requirement: the published schema types `install` and `start` as plain strings.
 */

import { createHash } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { CapabilityAuthority, EnvironmentManagedAs } from "./lifecycle-model.js";
import { managedAsFromPath } from "./lifecycle-model.js";

/** Definition paths resolve against the directory holding the file. */
export const DEFINITION_DIR = ".cursor";

/** Where a repository-owned definition lives, relative to the repository root. */
export const DEFINITION_PATH = ".cursor/environment.json";

/** A definition larger than this is refused rather than parsed. */
export const MAX_DEFINITION_BYTES = 262_144;

/** Bounds on reported output. Every list below is capped, never "all of them". */
export const MAX_SAFETY_FINDINGS = 32;
export const MAX_DEFINITION_ERRORS = 32;
export const MAX_DIFF_CHANGES = 100;
export const MAX_DIFF_VALUE_CHARS = 120;

/* ------------------------------------------------------------------ schema */

/**
 * One entry of `mcpServerAllowlist`.
 *
 * The published schema sets `additionalProperties: false` here and requires at
 * least one of `serverUrl` or `command` (`anyOf`), so both rules are enforced.
 */
export const McpAllowlistEntrySchema = z
  .strictObject({
    name: z.string().optional(),
    serverUrl: z.string().optional(),
    command: z.string().optional(),
    toolAllowlist: z.array(z.string()).optional(),
  })
  .refine(
    (entry) => entry.serverUrl !== undefined || entry.command !== undefined,
    { message: "an mcpServerAllowlist entry requires serverUrl or command" },
  );

/**
 * A forwarded port.
 *
 * Loose, not strict: the published schema constrains `port` and marks it
 * required but does *not* set `additionalProperties: false` on this item, and
 * rejecting a document the published schema accepts would fail a legal customer
 * definition. Same reasoning for `terminals` items below.
 */
export const PortSchema = z.looseObject({
  name: z.string().optional(),
  port: z.number().int().min(1).max(65535),
});

export const TerminalSchema = z.looseObject({
  name: z.string().optional(),
  command: z.string(),
  description: z.string().optional(),
});

/**
 * A `terminals` element. The published schema's `oneOf` accepts a terminal
 * object or an array of terminal objects; the nested-array form is the legacy
 * shape and stays supported.
 */
export const TerminalEntrySchema = z.union([TerminalSchema, z.array(TerminalSchema)]);

export const ContainerBuildSchema = z.strictObject({
  dockerfile: z.string().optional(),
  dockerfileContents: z.string().optional(),
  context: z.string().optional(),
}).refine(
  (build) => build.dockerfile !== undefined || build.dockerfileContents !== undefined,
  { message: "build requires dockerfile or dockerfileContents" },
);

/**
 * The environment definition.
 *
 * Strict, mirroring the published schema's root `unevaluatedProperties: false`
 * over `definitions.container` plus `definitions.common`. Editor-only
 * properties are not exempt: accepting one would claim Cursor accepts a
 * document its current published schema rejects.
 */
export const EnvironmentDefinitionSchema = z.strictObject({
  name: z.string().optional(),
  user: z.string().optional(),
  install: z.string().optional(),
  start: z.string().optional(),
  repositoryDependencies: z.array(z.string()).optional(),
  disableAllMcpServers: z.boolean().optional(),
  mcpServerAllowlist: z.array(McpAllowlistEntrySchema).optional(),
  egressAllowlist: z.array(z.string()).optional(),
  egressMode: z.enum([
    "allow_all",
    "parent_plus_network_settings",
    "default_with_network_settings",
    "network_settings_only",
  ]).optional(),
  chromeExecutablePath: z.string().optional(),
  enable_testing: z.union([z.boolean(), z.enum(["true", "false"])]).optional(),
  image: z.string().optional(),
  ports: z.array(PortSchema).optional(),
  terminals: z.array(TerminalEntrySchema).optional(),
  build: ContainerBuildSchema.optional(),
  snapshot: z.string().optional(),
  agentCanUpdateSnapshot: z.boolean().optional(),
});

export type EnvironmentDefinition = z.infer<typeof EnvironmentDefinitionSchema>;
export type Terminal = z.infer<typeof TerminalSchema>;

/** Top-level property names this implementation accepts, for conformance tests. */
export const DEFINITION_PROPERTIES = [
  "name",
  "user",
  "install",
  "start",
  "repositoryDependencies",
  "disableAllMcpServers",
  "mcpServerAllowlist",
  "egressAllowlist",
  "egressMode",
  "chromeExecutablePath",
  "enable_testing",
  "image",
  "ports",
  "terminals",
  "build",
  "snapshot",
  "agentCanUpdateSnapshot",
] as const;

/* ------------------------------------------------------------------- JSONC */

export interface DefinitionIssue {
  code: string;
  /** Dotted/indexed path inside the document, or `(root)`. */
  path: string;
  message: string;
}

export type JsoncResult =
  | { ok: true; value: unknown }
  | { ok: false; issue: DefinitionIssue };

/** A trailing comma left before `}` or `]` in comment-stripped text. */
const TRAILING_COMMA = /,\s*[}\]]/;

/**
 * Parse JSONC the way the published schema declares it: comments are allowed
 * (`allowComments: true`), trailing commas are not (`allowTrailingCommas:
 * false`).
 *
 * Comments are blanked rather than removed so byte offsets in a parser message
 * still point at the original text.
 */
export function parseJsonc(text: string): JsoncResult {
  let out = "";
  let index = 0;
  let inString = false;
  while (index < text.length) {
    const char = text.charAt(index);
    if (inString) {
      // Copy an escape pair whole: a `\"` must not end the string, and a `\\`
      // must not make the next quote look escaped.
      if (char === "\\") {
        out += char + text.charAt(index + 1);
        index += 2;
        continue;
      }
      if (char === '"') inString = false;
      out += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      inString = true;
      out += char;
      index += 1;
      continue;
    }
    if (char === "/" && text.charAt(index + 1) === "/") {
      while (index < text.length && text.charAt(index) !== "\n") {
        out += " ";
        index += 1;
      }
      continue;
    }
    if (char === "/" && text.charAt(index + 1) === "*") {
      const end = text.indexOf("*/", index + 2);
      if (end === -1) {
        return {
          ok: false,
          issue: {
            code: "JSONC_UNTERMINATED_COMMENT",
            path: "(root)",
            message: "a block comment is never closed",
          },
        };
      }
      for (let scan = index; scan < end + 2; scan += 1) {
        out += text.charAt(scan) === "\n" ? "\n" : " ";
      }
      index = end + 2;
      continue;
    }
    out += char;
    index += 1;
  }

  try {
    return { ok: true, value: JSON.parse(out) };
  } catch {
    // Report the trailing comma specifically: it is the one JSONC habit the
    // published schema rejects, and "Unexpected token }" does not say so.
    const code = TRAILING_COMMA.test(out) ? "JSONC_TRAILING_COMMA" : "JSON_SYNTAX";
    const message =
      code === "JSONC_TRAILING_COMMA"
        ? "trailing commas are not allowed in an environment definition"
        : "invalid JSON syntax in the environment definition";
    return { ok: false, issue: { code, path: "(root)", message } };
  }
}

/* -------------------------------------------------------------- normalizing */

export interface TextSummary {
  bytes: number;
  lines: number;
  digest: string;
}

export interface ScriptSummary {
  bytes: number;
  lines: number;
  /** `sha256:<12 hex>` over the whole field. Never the field's text. */
  digest: string;
  errexit: boolean;
  nounset: boolean;
  pipefail: boolean;
  /** All three shell options together. Advisory, never a schema requirement. */
  strictShellMode: boolean;
}

export interface ResolvedPath {
  /** Exactly what the document said. */
  declared: string;
  /** Repository-root-relative form, or undefined when the path is absolute. */
  repoRelative?: string;
  absolute: boolean;
  escapesRepositoryRoot: boolean;
  /** True only for Cursor's omitted build-context default. */
  defaulted?: boolean;
}

export type McpPolicy = "blocked" | "allowlist" | "inherit";

export interface NormalizedMcpEntry {
  name?: string;
  kind: "http" | "stdio" | "http+stdio";
  /** Digest of the URL or command pattern; patterns can embed a token. */
  patternDigest: string;
  toolAllowlist: string[];
  /** Empty or absent `toolAllowlist` allows every tool of that server. */
  allowsAllTools: boolean;
}

export interface NormalizedTerminal {
  name?: string;
  description?: string;
  command: ScriptSummary;
  /** `object` is the current form; `array` is the legacy nested form. */
  form: "object" | "array";
  path: string;
}

export interface NormalizedDefinition {
  name?: string;
  user?: string;
  install: ScriptSummary | null;
  start: ScriptSummary | null;
  terminals: NormalizedTerminal[];
  ports: Array<{ name?: string; port: number }>;
  repositoryDependencies: string[];
  mcp: {
    disableAllMcpServers: boolean;
    policy: McpPolicy;
    entries: NormalizedMcpEntry[];
  };
  container: {
    dockerfile: ResolvedPath | null;
    dockerfileContents: TextSummary | null;
    imageDigest: string | null;
    context: ResolvedPath | null;
  };
  network: {
    egressMode: EnvironmentDefinition["egressMode"] | null;
    allowlistDigest: string | null;
    allowlistCount: number;
  };
  testing: {
    /** Configured value; null leaves the decision to Cursor. */
    enabled: boolean | null;
    chromeExecutablePathDigest: string | null;
  };
  snapshot: {
    baseSnapshotId: string | null;
    /** Which base the document selects; `snapshot` outranks `build` and `image`. */
    base: SnapshotBase;
    /** Exactly what the document said, or null when it said nothing. */
    agentCanUpdateSnapshotConfigured: boolean | null;
    /** What Cursor applies, after the base and the documented default. */
    agentCanUpdateSnapshot: boolean;
  };
  /** Digest of the validated document, for a later synchronization readback. */
  digest: string;
}

export type SnapshotBase = "snapshot" | "build" | "image" | "default";

/**
 * Which base a document selects, and who may write to it.
 *
 * Both rules are the published schema's rather than ours: `snapshot` takes
 * precedence over `build` and `image` when set, and `agentCanUpdateSnapshot`
 * defaults to true on a snapshot or default base while being always false on a
 * `build` or `image` base. Reading the field as `=== true` reported neither --
 * an omitted field looked like no snapshot authority where Cursor grants it, and
 * an explicit `true` looked like authority where Cursor ignores it. Both values
 * are kept, because "the document asked for this" and "Cursor does this" are
 * different answers and the difference is the interesting part.
 */
function snapshotAuthority(
  definition: EnvironmentDefinition,
): NormalizedDefinition["snapshot"] {
  const base: SnapshotBase =
    definition.snapshot !== undefined
      ? "snapshot"
      : definition.build !== undefined
        ? "build"
        : definition.image !== undefined
          ? "image"
          : "default";
  const configured = definition.agentCanUpdateSnapshot ?? null;
  return {
    baseSnapshotId: definition.snapshot ?? null,
    base,
    agentCanUpdateSnapshotConfigured: configured,
    agentCanUpdateSnapshot:
      base === "build" || base === "image" ? false : (configured ?? true),
  };
}

function digest(text: string): string {
  return `sha256:${createHash("sha256").update(text, "utf8").digest("hex").slice(0, 12)}`;
}

const ERREXIT = /(^|\n|;|&&|\|\|)\s*set\s+-[a-zA-Z]*e[a-zA-Z]*\b|set\s+-o\s+errexit\b/;
const NOUNSET = /(^|\n|;|&&|\|\|)\s*set\s+-[a-zA-Z]*u[a-zA-Z]*\b|set\s+-o\s+nounset\b/;
/** Matches both `set -o pipefail` and the combined `set -euo pipefail`. */
const PIPEFAIL = /set\s+-[a-zA-Z]*o\s+pipefail\b/;

function summarizeText(text: string): TextSummary {
  return {
    bytes: Buffer.from(text, "utf8").byteLength,
    lines: text.split("\n").length,
    digest: digest(text),
  };
}

export function summarizeScript(script: string): ScriptSummary {
  const errexit = ERREXIT.test(script);
  const nounset = NOUNSET.test(script);
  const pipefail = PIPEFAIL.test(script);
  return {
    bytes: Buffer.from(script, "utf8").byteLength,
    lines: script.split("\n").length,
    digest: digest(script),
    errexit,
    nounset,
    pipefail,
    strictShellMode: errexit && nounset && pipefail,
  };
}

/**
 * Resolve a definition path the way Cursor documents it.
 *
 * Paths are relative to the directory holding `environment.json` -- `.cursor` --
 * and `.`, `./`, and `..` refer to the repository root (see
 * `docs/cursor-capabilities.md`). An absolute path is reported as declared: it
 * is not repository-relative and cannot be checked against the root.
 */
export function resolveDefinitionPath(
  declared: string,
  definitionDir: string = DEFINITION_DIR,
): ResolvedPath {
  if (declared.startsWith("/")) {
    return { declared, absolute: true, escapesRepositoryRoot: false };
  }
  const trimmed = declared.trim();
  if (trimmed === "." || trimmed === "./") {
    return {
      declared,
      repoRelative: ".",
      absolute: false,
      escapesRepositoryRoot: false,
    };
  }
  const segments = [...definitionDir.split("/"), ...trimmed.split("/")];
  const stack: string[] = [];
  let escapes = false;
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (stack.length === 0) {
        escapes = true;
        continue;
      }
      stack.pop();
      continue;
    }
    stack.push(segment);
  }
  return {
    declared,
    repoRelative: stack.length === 0 ? "." : stack.join("/"),
    absolute: false,
    escapesRepositoryRoot: escapes,
  };
}

function mcpEntryKind(entry: z.infer<typeof McpAllowlistEntrySchema>): NormalizedMcpEntry["kind"] {
  if (entry.serverUrl !== undefined && entry.command !== undefined) return "http+stdio";
  return entry.serverUrl !== undefined ? "http" : "stdio";
}

function mcpPolicy(definition: EnvironmentDefinition): McpPolicy {
  if (definition.disableAllMcpServers === true) return "blocked";
  // An empty allowlist on its own does not disable MCP; the published schema
  // says so explicitly, and reading it as "deny everything" is the mistake this
  // classification exists to prevent.
  return (definition.mcpServerAllowlist ?? []).length > 0 ? "allowlist" : "inherit";
}

/** Flatten both `terminals` forms into one list, keeping each entry's form. */
function normalizeTerminals(definition: EnvironmentDefinition): NormalizedTerminal[] {
  const out: NormalizedTerminal[] = [];
  const entries = definition.terminals ?? [];
  entries.forEach((entry, index) => {
    const group = Array.isArray(entry) ? entry : [entry];
    const form: NormalizedTerminal["form"] = Array.isArray(entry) ? "array" : "object";
    group.forEach((terminal, inner) => {
      const path =
        form === "array"
          ? `terminals[${index}][${inner}]`
          : `terminals[${index}]`;
      const normalized: NormalizedTerminal = {
        command: summarizeScript(terminal.command),
        form,
        path,
      };
      if (terminal.name !== undefined) normalized.name = terminal.name;
      if (terminal.description !== undefined) {
        normalized.description = terminal.description;
      }
      out.push(normalized);
    });
  });
  return out;
}

export function normalizeDefinition(
  definition: EnvironmentDefinition,
  definitionDir: string = DEFINITION_DIR,
): NormalizedDefinition {
  const build = definition.build;
  const normalized: NormalizedDefinition = {
    install: definition.install === undefined ? null : summarizeScript(definition.install),
    start: definition.start === undefined ? null : summarizeScript(definition.start),
    terminals: normalizeTerminals(definition),
    ports: (definition.ports ?? []).map((port) => {
      const entry: { name?: string; port: number } = { port: port.port };
      if (port.name !== undefined) entry.name = port.name;
      return entry;
    }),
    repositoryDependencies: [...(definition.repositoryDependencies ?? [])],
    mcp: {
      disableAllMcpServers: definition.disableAllMcpServers === true,
      policy: mcpPolicy(definition),
      entries: (definition.mcpServerAllowlist ?? []).map((entry) => {
        const tools = entry.toolAllowlist ?? [];
        const out: NormalizedMcpEntry = {
          kind: mcpEntryKind(entry),
          patternDigest: digest(`${entry.serverUrl ?? ""} ${entry.command ?? ""}`),
          toolAllowlist: [...tools],
          allowsAllTools: tools.length === 0,
        };
        if (entry.name !== undefined) out.name = entry.name;
        return out;
      }),
    },
    container: {
      dockerfile:
        build?.dockerfile === undefined
          ? null : resolveDefinitionPath(build.dockerfile, definitionDir),
      dockerfileContents: build?.dockerfileContents === undefined
        ? null : summarizeText(build.dockerfileContents),
      imageDigest: definition.image === undefined ? null : digest(definition.image),
      context:
        build === undefined
          ? null
          : build.context === undefined
            ? {
                declared: "",
                repoRelative: definitionDir,
                absolute: false,
                escapesRepositoryRoot: false,
                defaulted: true,
              }
            : resolveDefinitionPath(build.context, definitionDir),
    },
    network: {
      egressMode: definition.egressMode ?? null,
      allowlistDigest: definition.egressAllowlist === undefined
        ? null : digest(JSON.stringify(definition.egressAllowlist)),
      allowlistCount: definition.egressAllowlist?.length ?? 0,
    },
    testing: {
      enabled: definition.enable_testing === undefined
        ? null : definition.enable_testing === true || definition.enable_testing === "true",
      chromeExecutablePathDigest: definition.chromeExecutablePath === undefined
        ? null : digest(definition.chromeExecutablePath),
    },
    snapshot: snapshotAuthority(definition),
    digest: digest(JSON.stringify(definition)),
  };
  if (definition.name !== undefined) normalized.name = definition.name;
  if (definition.user !== undefined) normalized.user = definition.user;
  return normalized;
}

/* ------------------------------------------------------------------- safety */

export type SafetySeverity = "warning" | "advisory";

export interface SafetyFinding {
  code: string;
  severity: SafetySeverity;
  /** What was matched, in our words. Never the text that matched. */
  label: string;
  path: string;
  /** 1-based line inside the field, when the finding came from a script. */
  line?: number;
}

interface ScriptPattern {
  code: string;
  label: string;
  pattern: RegExp;
  /** Only meaningful for a script that runs while preparing a Build. */
  installOnly?: boolean;
}

/**
 * Shapes that leave a credential on the Build disk.
 *
 * A Build preserves disk state, so a credential written by `install` is baked
 * into every agent booted from that Build. These are heuristics on generic
 * tooling names -- never a repository-specific or customer-specific list -- and
 * a match reports the pattern's name, not the line that matched.
 */
const CREDENTIAL_PATTERNS: ScriptPattern[] = [
  {
    code: "CREDENTIAL_PERSISTENCE",
    label: "git credential helper storing credentials on disk",
    pattern: /credential\.helper[\s=]+\S*store/i,
  },
  {
    code: "CREDENTIAL_PERSISTENCE",
    label: "git credential file",
    pattern: /\.git-credentials\b/i,
  },
  { code: "CREDENTIAL_PERSISTENCE", label: "netrc file", pattern: /\.netrc\b/i },
  {
    code: "CREDENTIAL_PERSISTENCE",
    label: "npm registry auth token",
    pattern: /_authToken/i,
  },
  {
    code: "CREDENTIAL_PERSISTENCE",
    label: "gh auth login with a token",
    pattern: /gh\s+auth\s+login[^\n]*--with-token/i,
  },
  {
    code: "CREDENTIAL_PERSISTENCE",
    label: "aws credential written to the shared config",
    pattern: /aws\s+configure\s+set\b/i,
  },
  {
    code: "CREDENTIAL_PERSISTENCE",
    label: "docker login password on the command line",
    pattern: /docker\s+login[^\n]*(--password|\s-p\s)/i,
  },
  {
    code: "CREDENTIAL_PERSISTENCE",
    label: "private key material",
    pattern: /(id_rsa|id_ed25519|BEGIN [A-Z ]*PRIVATE KEY)/,
  },
  {
    code: "CREDENTIAL_PERSISTENCE",
    label: "ssh agent identity added",
    pattern: /\bssh-add\b/,
  },
];

/** A secret-looking variable redirected into a file, or piped through tee. */
const SECRET_VARIABLE =
  /\$\{?(?:[A-Za-z0-9_]*_)?(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|KEY|CREDENTIALS?)S?\}?/;
const WRITES_TO_FILE = /(>>?\s*\S|\|\s*(sudo\s+)?tee\b)/;

/**
 * Behavior that changes state a Build cannot roll back, or that makes a Build
 * non-reproducible.
 */
const STATE_PATTERNS: ScriptPattern[] = [
  {
    code: "UNSAFE_STATE_UPDATE",
    label: "push to a git remote",
    pattern: /\bgit\s+push\b/,
  },
  {
    code: "UNSAFE_STATE_UPDATE",
    label: "commit to a git repository",
    pattern: /\bgit\s+commit\b/,
  },
  {
    code: "UNSAFE_STATE_UPDATE",
    label: "package publish",
    pattern: /\b(npm|pnpm|yarn|poetry|cargo|gem)\s+publish\b/,
  },
  {
    code: "UNSAFE_STATE_UPDATE",
    label: "remote script piped into a shell",
    pattern: /\b(curl|wget)\b[^\n]*\|\s*(sudo\s+)?(ba|z|da)?sh\b/,
  },
  {
    code: "UNSAFE_STATE_UPDATE",
    label: "recursive delete",
    pattern: /\brm\s+-[a-zA-Z]*r[a-zA-Z]*\b/,
  },
  {
    code: "NON_IDEMPOTENT_APPEND",
    label: "append into a shell or tooling dotfile",
    pattern:
      />>\s*\S*(\.bashrc|\.zshrc|\.profile|\.bash_profile|\.zprofile|\.npmrc|\.gitconfig)\b/,
    installOnly: true,
  },
];

function lineOf(script: string, pattern: RegExp): number | undefined {
  const match = pattern.exec(script);
  if (match === null) return undefined;
  return script.slice(0, match.index).split("\n").length;
}

interface ScriptTarget {
  path: string;
  script: string;
  /** True for `install`, which runs while preparing the Build disk. */
  buildPhase: boolean;
}

function scanScript(target: ScriptTarget): SafetyFinding[] {
  const findings: SafetyFinding[] = [];
  const add = (
    code: string,
    severity: SafetySeverity,
    label: string,
    line: number | undefined,
  ) => {
    const finding: SafetyFinding = { code, severity, label, path: target.path };
    if (line !== undefined) finding.line = line;
    findings.push(finding);
  };

  for (const entry of CREDENTIAL_PATTERNS) {
    if (entry.pattern.test(target.script)) {
      add(entry.code, "warning", entry.label, lineOf(target.script, entry.pattern));
    }
  }

  // Line by line, so a secret-looking variable and a redirect must appear
  // together rather than anywhere in the same script.
  target.script.split("\n").forEach((line, index) => {
    if (SECRET_VARIABLE.test(line) && WRITES_TO_FILE.test(line)) {
      add(
        "CREDENTIAL_ENV_PERSISTENCE",
        "warning",
        "a secret-looking variable written to a file",
        index + 1,
      );
    }
  });

  for (const entry of STATE_PATTERNS) {
    if (entry.installOnly === true && !target.buildPhase) continue;
    if (entry.pattern.test(target.script)) {
      const severity: SafetySeverity =
        entry.code === "NON_IDEMPOTENT_APPEND" ? "advisory" : "warning";
      add(entry.code, severity, entry.label, lineOf(target.script, entry.pattern));
    }
  }

  return findings;
}

/**
 * Safety findings for a validated definition.
 *
 * Bounded: at most `MAX_SAFETY_FINDINGS`, and the caller is told when the list
 * was cut. Nothing here assumes the definition contains a secret *value*; it
 * reports script behavior and definition authority.
 */
export function analyzeSafety(
  definition: EnvironmentDefinition,
  definitionDir: string = DEFINITION_DIR,
): { findings: SafetyFinding[]; truncated: boolean } {
  const normalized = normalizeDefinition(definition, definitionDir);
  const findings: SafetyFinding[] = [];

  const targets: ScriptTarget[] = [];
  if (definition.install !== undefined) {
    targets.push({ path: "install", script: definition.install, buildPhase: true });
  }
  if (definition.start !== undefined) {
    targets.push({ path: "start", script: definition.start, buildPhase: false });
  }
  if (definition.build?.dockerfileContents !== undefined) {
    targets.push({
      path: "build.dockerfileContents",
      script: definition.build.dockerfileContents,
      buildPhase: true,
    });
  }
  for (const terminal of terminalCommands(definition)) {
    targets.push({ path: terminal.path, script: terminal.command, buildPhase: false });
  }

  for (const target of targets) findings.push(...scanScript(target));

  // Advisory, not an error: the published schema types these fields as plain
  // strings and documents no shell mode. Only the two multi-command scripts are
  // judged -- a terminal command is one command, and asking it to set shell
  // options would be noise.
  for (const target of targets) {
    if (target.path !== "install" && target.path !== "start") continue;
    if (!summarizeScript(target.script).strictShellMode) {
      findings.push({
        code: "STRICT_SHELL_MODE_ABSENT",
        severity: "advisory",
        label:
          "no `set -euo pipefail`; a failing command may leave a partially prepared environment",
        path: target.path,
      });
    }
  }

  // The effective permission, not the written one: an omitted field still lets
  // an agent write the base on a snapshot or default base, which is exactly the
  // case a reader is least likely to have thought about.
  if (normalized.snapshot.agentCanUpdateSnapshot) {
    // A warning only when something a script does would be worth baking in.
    const hasCredentialFinding = findings.some((finding) =>
      finding.code.startsWith("CREDENTIAL_"),
    );
    const authority =
      normalized.snapshot.agentCanUpdateSnapshotConfigured === null
        ? `agentCanUpdateSnapshot is unset and defaults to true on a ${normalized.snapshot.base} base, which`
        : "agentCanUpdateSnapshot";
    findings.push({
      code: "SNAPSHOT_UPDATE_AUTHORITY",
      severity: hasCredentialFinding ? "warning" : "advisory",
      label: hasCredentialFinding
        ? `${authority} lets an agent persist the base disk, including anything a script wrote there`
        : `${authority} lets an agent update the base snapshot`,
      path: "agentCanUpdateSnapshot",
    });
  }

  if (
    definition.mcpServerAllowlist !== undefined &&
    definition.mcpServerAllowlist.length === 0 &&
    definition.disableAllMcpServers !== true
  ) {
    findings.push({
      code: "MCP_ALLOWLIST_EMPTY_INHERITS",
      severity: "advisory",
      label:
        "an empty mcpServerAllowlist inherits upstream MCP policy; only disableAllMcpServers blocks servers",
      path: "mcpServerAllowlist",
    });
  }

  for (const [field, resolved] of [
    ["build.dockerfile", normalized.container.dockerfile],
    ["build.context", normalized.container.context],
  ] as const) {
    if (resolved === null) continue;
    if (resolved.escapesRepositoryRoot) {
      findings.push({
        code: "PATH_ESCAPES_REPOSITORY_ROOT",
        severity: "warning",
        label: "the path resolves above the repository root",
        path: field,
      });
    }
    if (resolved.absolute) {
      findings.push({
        code: "PATH_ABSOLUTE",
        severity: "advisory",
        label: "an absolute path is not repository-relative and may not exist in the container",
        path: field,
      });
    }
  }

  if (findings.length > MAX_SAFETY_FINDINGS) {
    return { findings: findings.slice(0, MAX_SAFETY_FINDINGS), truncated: true };
  }
  return { findings, truncated: false };
}

/** Terminal commands with their document paths, both `terminals` forms. */
function terminalCommands(
  definition: EnvironmentDefinition,
): Array<{ path: string; command: string }> {
  const out: Array<{ path: string; command: string }> = [];
  (definition.terminals ?? []).forEach((entry, index) => {
    if (Array.isArray(entry)) {
      entry.forEach((terminal, inner) => {
        out.push({
          path: `terminals[${index}][${inner}].command`,
          command: terminal.command,
        });
      });
      return;
    }
    out.push({ path: `terminals[${index}].command`, command: entry.command });
  });
  return out;
}

/* --------------------------------------------------------------- validation */

/**
 * Where a definition came from.
 *
 * `delegated-saved` is the saved document as reported from inside an
 * environment-scoped run. It is agent-authored untrusted evidence, not
 * host-authoritative configuration, and on personal or override environments it
 * may be owner-restricted and unreadable altogether.
 */
export type DefinitionSource = "local-file" | "proposed" | "delegated-saved";

export type DefinitionTrust =
  | "repository-untrusted"
  | "caller-untrusted"
  | "delegated-untrusted";

export interface CapabilityLimitation {
  code: string;
  message: string;
}

export type ValidationStatus = "valid" | "invalid" | "absent";

export interface ValidationResult {
  status: ValidationStatus;
  source: DefinitionSource;
  trust: DefinitionTrust;
  /** Where the bytes came from, for the untrusted-data label. */
  origin: string;
  errors: DefinitionIssue[];
  errorsTruncated: boolean;
  safety: SafetyFinding[];
  safetyTruncated: boolean;
  limitations: CapabilityLimitation[];
  /** Present only when `status` is `valid`. */
  definition?: EnvironmentDefinition;
}

export function trustOf(source: DefinitionSource): DefinitionTrust {
  if (source === "delegated-saved") return "delegated-untrusted";
  return source === "local-file" ? "repository-untrusted" : "caller-untrusted";
}

function limitationsFor(source: DefinitionSource): CapabilityLimitation[] {
  const limitations: CapabilityLimitation[] = [
    {
      code: "NO_HOST_PERSISTENCE",
      message:
        "This is a local check. Persisting a definition is an owner Save (database-managed) " +
        "or a commit of the file to the default branch (repository-file managed); no published " +
        "API-key, SDK, or delegated operation saves Install/Start configuration.",
    },
  ];
  if (source === "delegated-saved") {
    limitations.push({
      code: "DELEGATED_EVIDENCE",
      message:
        "The document was reported from inside an environment-scoped run. Treat it as " +
        "delegated untrusted evidence, not host-authoritative configuration.",
    });
  }
  return limitations;
}

/**
 * Validate one definition document.
 *
 * Schema errors, safety findings, and capability limitations are returned side
 * by side and never merged: an illegal document and a legal-but-risky one are
 * different answers.
 */
export function validateDefinition(args: {
  text: string;
  source: DefinitionSource;
  origin: string;
  definitionDir?: string;
}): ValidationResult {
  const source = args.source;
  const base = {
    source,
    trust: trustOf(source),
    origin: args.origin,
    limitations: limitationsFor(source),
  };

  const bytes = Buffer.from(args.text, "utf8").byteLength;
  if (bytes > MAX_DEFINITION_BYTES) {
    return {
      ...base,
      status: "invalid",
      errors: [
        {
          code: "DEFINITION_TOO_LARGE",
          path: "(root)",
          message: `the definition is ${bytes} bytes; the limit is ${MAX_DEFINITION_BYTES}`,
        },
      ],
      errorsTruncated: false,
      safety: [],
      safetyTruncated: false,
    };
  }

  const parsed = parseJsonc(args.text);
  if (!parsed.ok) {
    return {
      ...base,
      status: "invalid",
      errors: [parsed.issue],
      errorsTruncated: false,
      safety: [],
      safetyTruncated: false,
    };
  }

  const checked = EnvironmentDefinitionSchema.safeParse(parsed.value);
  if (!checked.success) {
    const errors = checked.error.issues.map((issue) => ({
      code: issue.code,
      path: issue.path.length === 0 ? "(root)" : issue.path.join("."),
      message: issue.message,
    }));
    return {
      ...base,
      status: "invalid",
      errors: errors.slice(0, MAX_DEFINITION_ERRORS),
      errorsTruncated: errors.length > MAX_DEFINITION_ERRORS,
      safety: [],
      safetyTruncated: false,
    };
  }

  const safety = analyzeSafety(checked.data, args.definitionDir);
  return {
    ...base,
    status: "valid",
    errors: [],
    errorsTruncated: false,
    safety: safety.findings,
    safetyTruncated: safety.truncated,
    definition: checked.data,
  };
}

/** Report a file rejected by the bounded reader without allocating its body. */
export function oversizedDefinition(args: {
  source: DefinitionSource;
  origin: string;
  sizeBytes: number;
}): ValidationResult {
  return {
    status: "invalid",
    source: args.source,
    trust: trustOf(args.source),
    origin: args.origin,
    errors: [
      {
        code: "DEFINITION_TOO_LARGE",
        path: "(root)",
        message: `the definition is ${args.sizeBytes} bytes; the limit is ${MAX_DEFINITION_BYTES}`,
      },
    ],
    errorsTruncated: false,
    safety: [],
    safetyTruncated: false,
    limitations: limitationsFor(args.source),
  };
}

/** A missing local file is a state, not a schema error: say which. */
export function absentDefinition(args: {
  source: DefinitionSource;
  origin: string;
}): ValidationResult {
  return {
    status: "absent",
    source: args.source,
    trust: trustOf(args.source),
    origin: args.origin,
    errors: [],
    errorsTruncated: false,
    safety: [],
    safetyTruncated: false,
    limitations: [
      ...limitationsFor(args.source),
      {
        code: "LOCAL_DEFINITION_ABSENT",
        message:
          `No definition at ${DEFINITION_PATH}. That is not missing saved configuration: a ` +
          "database-managed environment keeps its Install/Start in Cursor, and a run may be " +
          "refused permission to read it.",
      },
    ],
  };
}

export type LocalDefinition =
  | { present: true; path: string; text: string; sizeBytes: number }
  | { present: true; path: string; tooLarge: true; sizeBytes: number }
  | { present: false; path: string };

/** Written as an escape so this file stays pure ASCII, like `untrusted.ts`. */
const NUL = String.fromCharCode(0);

/**
 * Read a repository's own definition.
 *
 * Only `<repoRoot>/.cursor/environment.json` is read -- the path is fixed, not
 * caller-chosen -- and this never creates the file. Introducing one would change
 * how the environment resolves configuration for every user of that repository,
 * because a repository definition wins over a saved environment.
 */
export async function readLocalDefinition(repoRoot: string): Promise<LocalDefinition> {
  if (repoRoot.includes(NUL)) {
    throw new Error("repoRoot contains a NUL byte");
  }
  const root = resolve(repoRoot);
  const path = join(root, DEFINITION_PATH);
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([
      realpath(root),
      realpath(path),
    ]);
    const fromRoot = relative(resolvedRoot, resolvedFile);
    if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
      throw new Error(`${DEFINITION_PATH} resolves outside the repository root`);
    }

    const handle = await open(resolvedFile, "r");
    try {
      const stat = await handle.stat();
      if (stat.size > MAX_DEFINITION_BYTES) {
        return {
          present: true,
          path,
          tooLarge: true,
          sizeBytes: stat.size,
        };
      }
      // Read at most one byte past the limit. A file that grows after `stat`
      // cannot make this operation allocate or return an unbounded payload.
      const buffer = Buffer.alloc(MAX_DEFINITION_BYTES + 1);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const chunk = await handle.read(
          buffer,
          bytesRead,
          buffer.length - bytesRead,
          bytesRead,
        );
        if (chunk.bytesRead === 0) break;
        bytesRead += chunk.bytesRead;
      }
      if (bytesRead > MAX_DEFINITION_BYTES) {
        return {
          present: true,
          path,
          tooLarge: true,
          sizeBytes: bytesRead,
        };
      }
      return {
        present: true,
        path,
        text: buffer.subarray(0, bytesRead).toString("utf8"),
        sizeBytes: bytesRead,
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // ENOTDIR and ENOENT are both "no definition here". Anything else -- a
    // permission failure, for instance -- is reported rather than read as absent.
    if (code === "ENOENT" || code === "ENOTDIR") return { present: false, path };
    throw error;
  }
}

/* --------------------------------------------------------------------- diff */

/**
 * Fields whose values may be shown verbatim in a diff.
 *
 * Everything else is reported as a digest. This is an allowlist rather than a
 * denylist so a field added later is redacted by default: `install`, `start`,
 * terminal commands, and MCP URL or command patterns are exactly the places an
 * inline credential turns up.
 *
 * Paths are index-free: `ports[0].port` is compared as `ports[].port`.
 */
const VISIBLE_PATHS = new Set([
  "agentCanUpdateSnapshot",
  "disableAllMcpServers",
  "ports[].port",
]);

export interface DefinitionChange {
  path: string;
  change: "added" | "removed" | "changed";
  /** Absent when the field is redacted-by-default and had no prior value. */
  before?: string;
  after?: string;
  /** True when the rendered values are digests rather than the field's text. */
  redacted: boolean;
}

export interface DefinitionDiff {
  identical: boolean;
  changes: DefinitionChange[];
  truncated: boolean;
}

const INDEX = /\[\d+\]/g;

function shape(path: string): string {
  return path.replace(INDEX, "[]");
}

function render(path: string, value: unknown): { text: string; redacted: boolean } {
  // Never emit an arbitrary string from a definition. Even fields normally
  // used for labels or paths can contain an inline credential. Only the
  // schema's numeric/boolean fields are safe to show verbatim.
  if (typeof value !== "string" && VISIBLE_PATHS.has(shape(path))) {
    // A validated definition holds only JSON values, and `record` never renders
    // an absent one, so this always serializes.
    const text = JSON.stringify(value);
    return {
      text:
        text.length > MAX_DIFF_VALUE_CHARS
          ? `${text.slice(0, MAX_DIFF_VALUE_CHARS)}...`
          : text,
      redacted: false,
    };
  }
  const text = typeof value === "string" ? value : JSON.stringify(value);
  const bytes = Buffer.from(text, "utf8").byteLength;
  return { text: `${digest(text)} (${bytes} bytes)`, redacted: true };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

interface DiffState {
  changes: DefinitionChange[];
  truncated: boolean;
}

function record(
  state: DiffState,
  path: string,
  before: unknown,
  after: unknown,
): void {
  if (state.changes.length >= MAX_DIFF_CHANGES) {
    state.truncated = true;
    return;
  }
  const change: DefinitionChange =
    before === undefined
      ? { path, change: "added", redacted: false }
      : after === undefined
        ? { path, change: "removed", redacted: false }
        : { path, change: "changed", redacted: false };
  if (before !== undefined) {
    const rendered = render(path, before);
    change.before = rendered.text;
    change.redacted = rendered.redacted;
  }
  if (after !== undefined) {
    const rendered = render(path, after);
    change.after = rendered.text;
    change.redacted = change.redacted || rendered.redacted;
  }
  state.changes.push(change);
}

/**
 * The walk itself is not capped -- `record` is. A definition is bounded by
 * `MAX_DEFINITION_BYTES`, so walking all of it is cheap, and every change that
 * does not fit the cap is counted as truncation rather than silently skipped.
 */
function walk(state: DiffState, path: string, before: unknown, after: unknown): void {
  if (isRecord(before) || isRecord(after)) {
    // One side missing still descends, so a whole added `build` object reports
    // `build.dockerfile` rather than one opaque blob.
    const keys = new Set([
      ...(isRecord(before) ? Object.keys(before) : []),
      ...(isRecord(after) ? Object.keys(after) : []),
    ]);
    if (!isRecord(before) && before !== undefined) {
      record(state, path, before, after);
      return;
    }
    if (!isRecord(after) && after !== undefined) {
      record(state, path, before, after);
      return;
    }
    for (const key of [...keys].sort()) {
      walk(
        state,
        path === "" ? key : `${path}.${key}`,
        isRecord(before) ? before[key] : undefined,
        isRecord(after) ? after[key] : undefined,
      );
    }
    return;
  }
  if (Array.isArray(before) || Array.isArray(after)) {
    if (!Array.isArray(before) && before !== undefined) {
      record(state, path, before, after);
      return;
    }
    if (!Array.isArray(after) && after !== undefined) {
      record(state, path, before, after);
      return;
    }
    const left = Array.isArray(before) ? before : [];
    const right = Array.isArray(after) ? after : [];
    // Compared by index: reordering a list reads as element changes. That keeps
    // the walk bounded and the paths honest about where a value sits.
    const length = Math.max(left.length, right.length);
    for (let index = 0; index < length; index += 1) {
      walk(state, `${path}[${index}]`, left[index], right[index]);
    }
    return;
  }
  if (before === undefined && after === undefined) return;
  if (before === after) return;
  record(state, path, before, after);
}

/**
 * Semantic diff of two validated definitions.
 *
 * Bounded by `MAX_DIFF_CHANGES`, and script and pattern values are digests, so
 * the result cannot carry a secret out of either document.
 */
export function diffDefinitions(
  before: EnvironmentDefinition,
  after: EnvironmentDefinition,
): DefinitionDiff {
  const state: DiffState = { changes: [], truncated: false };
  walk(state, "", before, after);
  return {
    identical: state.changes.length === 0 && !state.truncated,
    changes: state.changes,
    truncated: state.truncated,
  };
}

/* ----------------------------------------------------- synchronization */

/**
 * A validated request handed to Environment Operations.
 *
 * It is not a Save and not a receipt. It carries digests, never Install/Start
 * text, and never a `buildId`: a Build id is not a Save receipt, and attaching a
 * stale one invites a Save that adopts a stale snapshot.
 *
 * `ready: false` means the managed type is unknown, which is a stop -- persisting
 * without knowing whether the file or the database is the configuration of
 * record could change what every user of the repository resolves.
 */
export interface SynchronizationRequest {
  environmentPublicId: string;
  managedAs: EnvironmentManagedAs;
  /** null for database-managed; a path for repository-file managed. */
  environmentJsonPath?: string | null;
  authority?: CapabilityAuthority;
  ownerAction?: "SAVE_ENVIRONMENT";
  ready: boolean;
  persisted: false;
  requiresOwnerSave: boolean;
  requiresRepositoryCommit: boolean;
  definitionDigest: string;
  installDigest: string | null;
  startDigest: string | null;
  safetyWarningCount: number;
  requiredReadback: string;
  nextSteps: string[];
}

/**
 * Build the synchronization request for a definition that already validated.
 *
 * Taking `EnvironmentDefinition` rather than raw text is the validation
 * guarantee: an unparsed or illegal document cannot reach this function.
 */
export function buildSynchronizationRequest(args: {
  environmentPublicId: string;
  definition: EnvironmentDefinition;
  /** Exactly as read from `environment-info`; `undefined` means unknown. */
  environmentJsonPath?: string | null;
  safety?: SafetyFinding[];
  definitionDir?: string;
}): SynchronizationRequest {
  const normalized = normalizeDefinition(args.definition, args.definitionDir);
  const managedAs = managedAsFromPath(args.environmentJsonPath);
  const warnings = (args.safety ?? []).filter(
    (finding) => finding.severity === "warning",
  ).length;

  const request: SynchronizationRequest = {
    environmentPublicId: args.environmentPublicId,
    managedAs,
    ready: managedAs !== "unknown",
    persisted: false,
    requiresOwnerSave: managedAs === "database",
    requiresRepositoryCommit: managedAs === "repository-file",
    definitionDigest: normalized.digest,
    installDigest: normalized.install?.digest ?? null,
    startDigest: normalized.start?.digest ?? null,
    safetyWarningCount: warnings,
    requiredReadback: "",
    nextSteps: [],
  };

  if (args.environmentJsonPath !== undefined) {
    request.environmentJsonPath = args.environmentJsonPath;
  }

  if (managedAs === "database") {
    request.authority = "browser-session";
    request.ownerAction = "SAVE_ENVIRONMENT";
    request.requiredReadback =
      "a new environmentVersionPublicId on a freshly booted run, plus a " +
      "list-environment-builds row with triggerType=CONFIG_CHANGE and an " +
      "environmentVersionId absent from the recorded baseline set";
    request.nextSteps = [
      "Open the pre-declared environment, verified out of band, and discard any stale pending proposal.",
      "Press Save exactly once, with no secret edits in the same window.",
      "Read back from a second, freshly booted run; a same-run readback is indeterminate.",
    ];
    return request;
  }

  if (managedAs === "repository-file") {
    request.authority = "repo-commit";
    request.requiredReadback =
      `the default-branch commit SHA of ${args.environmentJsonPath ?? DEFINITION_PATH}, plus a ` +
      "fresh run whose environment-info matches it with the path still present";
    request.nextSteps = [
      `Commit ${args.environmentJsonPath ?? DEFINITION_PATH} to the default branch yourself; this server does not write your repository.`,
      "A dashboard Save does not apply here: the committed file wins over a saved environment.",
    ];
    return request;
  }

  request.requiredReadback =
    "environmentJsonPath from environment-info, which decides whether the file or the database is the configuration of record";
  request.nextSteps = [
    "Read environmentJsonPath before synchronizing. Never probe the managed type by submitting environmentJson to a Build trigger.",
  ];
  return request;
}
