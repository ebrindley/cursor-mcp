/**
 * Projections of the Cursor CLI's environment reads, plus the binding,
 * confirmation, and readback judgements writes share.
 *
 * Two reads, two shapes:
 *
 *   - `env list` -> a catalog of environments the logged-in account can see;
 *   - `env get`  -> the configuration *candidates* for one environment.
 *
 * Three rules hold for both.
 *
 * **Internal identifiers stay provider-private.** A numeric id is Cursor's own
 * row key, not an address a caller may hold: the read model already records that
 * `builds[].environmentVersionId` must never be confused with a public opaque id
 * (`docs/cloud-mcp-environment-read-model.md`). Only string public ids are
 * emitted, and a row whose only identifier is numeric is dropped and counted.
 *
 * **Configuration is a digest, never a script.** `install`, `start`, terminal
 * commands, and MCP patterns are exactly where an inline credential appears, so
 * `env get` reports a normalized digest and a byte count -- the same discipline
 * `environment-definition.ts` applies to a local file.
 *
 * **Absence is classified, not guessed.** A candidate this authority cannot read
 * is `unreadable`; it is never reported as an empty configuration, and two
 * readable candidates that disagree are `different` rather than silently
 * resolved. Cursor's documented precedence -- repository definition, then saved
 * environment -- is reported as a number, not applied as a merge.
 */

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { cliDigest, type CliWriteOperation } from "./cursor-cli.js";
import { canonicalRepo, repoKey } from "./policy.js";

/** Rows emitted from one `env list` payload. Beyond this the list is truncated. */
export const MAX_CATALOG_ENTRIES = 200;

/** Configuration candidates emitted from one `env get` payload. */
export const MAX_CONFIG_CANDIDATES = 8;

/* ------------------------------------------------------------------ helpers */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function trimmedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

const ALL_DIGITS = /^\d+$/;
const PUBLIC_ID = /^[A-Za-z0-9_.:-]+$/;

/**
 * A public opaque identifier.
 *
 * A number is refused outright, and so is an all-digits string: both are the
 * provider's internal row key wearing a different type.
 */
export function publicIdOf(row: Record<string, unknown>): string | undefined {
  for (const key of ["environmentPublicId", "publicId", "environmentId", "id"]) {
    const value = trimmedString(row[key]);
    if (
      value !== undefined &&
      !ALL_DIGITS.test(value) &&
      !value.startsWith("-") &&
      PUBLIC_ID.test(value)
    ) {
      return value;
    }
  }
  return undefined;
}

/** Epoch milliseconds or an already-formatted date, as one ISO 8601 string. */
export function normalizeTimestamp(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
  }
  const text = trimmedString(value);
  if (text === undefined) return undefined;
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function firstTimestamp(
  row: Record<string, unknown>,
  keys: readonly string[],
): string | undefined {
  for (const key of keys) {
    const value = normalizeTimestamp(row[key]);
    if (value !== undefined) return value;
  }
  return undefined;
}

/* ------------------------------------------------------------------ catalog */

/**
 * Ownership as the CLI reports it.
 *
 * `unknown` is a real answer, not a default to be tidied away: a personal and a
 * team environment are different secret grants, and `config.ts` already requires
 * the operator to state the scope rather than have it inferred.
 */
export type CliEnvironmentScope = "personal" | "team" | "unknown";

export interface CliEnvironmentEntry {
  environmentPublicId: string;
  name?: string;
  scope: CliEnvironmentScope;
  repos: string[];
  createdAt?: string;
  updatedAt?: string;
}

export interface CliEnvironmentCatalog {
  entries: CliEnvironmentEntry[];
  /** Rows that carried no usable public id, so could not be addressed. */
  dropped: number;
  truncated: boolean;
}

export function normalizeScope(row: Record<string, unknown>): CliEnvironmentScope {
  const declared = trimmedString(row.scope)?.toLowerCase();
  if (declared === "personal" || declared === "user") return "personal";
  if (declared === "team" || declared === "organization" || declared === "org") {
    return "team";
  }
  if (row.owningTeam !== undefined && row.owningTeam !== null) return "team";
  if (row.owningUser !== undefined && row.owningUser !== null) return "personal";
  return "unknown";
}

/** Repository entries as URLs or `owner/name`, from either shape the CLI uses. */
export function normalizeRepos(row: Record<string, unknown>): string[] {
  const out: string[] = [];
  for (const key of ["repos", "repositories", "repositoryDependencies"]) {
    const value = row[key];
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const direct = trimmedString(entry);
      if (direct !== undefined) {
        try {
          out.push(canonicalRepo(direct).url);
        } catch {
          // Credential-bearing, non-GitHub, and malformed repositories are not
          // safe catalog output and cannot match the policy's repository model.
        }
        continue;
      }
      if (!isRecord(entry)) continue;
      const named =
        trimmedString(entry.url) ??
        trimmedString(entry.repository) ??
        trimmedString(entry.name);
      if (named !== undefined) {
        try {
          out.push(canonicalRepo(named).url);
        } catch {
          // Same fail-closed normalization as the direct string form above.
        }
      }
    }
  }
  // Deduplicated, order preserved: two shapes may name the same repository.
  return [...new Set(out)];
}

/** The rows of an `env list` payload, whichever envelope key it used. */
function catalogRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["environments", "items", "results", "data"]) {
    const entry = value[key];
    if (Array.isArray(entry)) return entry;
  }
  return undefined;
}

export type CatalogResult =
  | { ok: true; catalog: CliEnvironmentCatalog }
  | { ok: false; code: "CLI_LIST_SHAPE_UNKNOWN"; message: string };

/**
 * Project an `env list` payload.
 *
 * Unknown fields are dropped rather than passed through: this is a projection of
 * an unpublished contract, and forwarding whatever the CLI happened to print
 * would make every future field an accidental part of this server's output.
 */
export function normalizeEnvironmentCatalog(value: unknown): CatalogResult {
  const rows = catalogRows(value);
  if (rows === undefined) {
    return {
      ok: false,
      code: "CLI_LIST_SHAPE_UNKNOWN",
      message:
        "the CLI's environment list was neither an array nor an object carrying environments, " +
        "items, results, or data",
    };
  }

  const entries: CliEnvironmentEntry[] = [];
  let dropped = 0;
  let truncated = false;
  for (const row of rows) {
    if (entries.length >= MAX_CATALOG_ENTRIES) {
      truncated = true;
      break;
    }
    if (!isRecord(row)) {
      dropped += 1;
      continue;
    }
    const environmentPublicId = publicIdOf(row);
    if (environmentPublicId === undefined) {
      dropped += 1;
      continue;
    }
    const entry: CliEnvironmentEntry = {
      environmentPublicId,
      scope: normalizeScope(row),
      repos: normalizeRepos(row),
    };
    const name = trimmedString(row.name) ?? trimmedString(row.displayName);
    if (name !== undefined) entry.name = name;
    const createdAt = firstTimestamp(row, ["createdAt", "createdAtMs", "created"]);
    if (createdAt !== undefined) entry.createdAt = createdAt;
    const updatedAt = firstTimestamp(row, [
      "updatedAt",
      "updatedAtMs",
      "modifiedAt",
      "lastModifiedAt",
    ]);
    if (updatedAt !== undefined) entry.updatedAt = updatedAt;
    entries.push(entry);
  }

  return { ok: true, catalog: { entries, dropped, truncated } };
}

export function catalogLine(entry: CliEnvironmentEntry): string {
  return (
    `${entry.environmentPublicId}  name=${entry.name ?? "(unnamed)"}` +
    `  scope=${entry.scope}  repos=${entry.repos.length}` +
    `  updated=${entry.updatedAt ?? "(unknown)"}`
  );
}

/* ------------------------------------------------------------ configuration */

/**
 * Where a configuration candidate lives.
 *
 * `repository-file` is a committed `.cursor/environment.json`; `database` is a
 * saved personal or team environment. Precedence follows Cursor's documented
 * resolution order and is reported, never applied.
 */
export type ConfigurationSource = "repository-file" | "database" | "unknown";

export const CONFIGURATION_PRECEDENCE: Record<ConfigurationSource, number> = {
  "repository-file": 1,
  database: 2,
  unknown: 3,
};

export interface CliConfigurationCandidate {
  source: ConfigurationSource;
  /** 1 is highest. Cursor resolves a repository definition before a saved one. */
  precedence: number;
  /** Only for a repository-file candidate, exactly as the CLI reported it. */
  path?: string;
  readable: boolean;
  /** Digest over the canonicalized document. Never any part of a script. */
  digest?: string;
  bytes?: number;
  /** Why an unreadable candidate could not be read, in our words. */
  reason?: string;
}

/**
 * `matched` -- every readable candidate agrees.
 * `different` -- two readable candidates disagree; the caller must decide.
 * `unreadable` -- no candidate could be read at all.
 */
export type ConfigurationClassification = "matched" | "different" | "unreadable";

export interface CliConfigurationRead {
  environmentPublicId: string;
  candidates: CliConfigurationCandidate[];
  classification: ConfigurationClassification;
  /** The digest the readable candidates agree on, when they do. */
  digest?: string;
  truncated: boolean;
}

/**
 * Canonical JSON: object keys sorted, arrays in order.
 *
 * Two payloads that differ only in key order describe the same configuration, so
 * they must digest the same. Depth is bounded because the digest is over an
 * untrusted document.
 */
export function canonicalJson(value: unknown, depth = 0): string {
  if (depth > 32) {
    throw new RangeError("configuration exceeds the supported nesting depth");
  }
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry, depth + 1)).join(",")}]`;
  }
  const entries = Object.entries(value)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry, depth + 1)}`)
    .join(",")}}`;
}

/** A digest and a byte count for a configuration document. Nothing else. */
export function summarizeConfiguration(document: unknown): {
  digest: string;
  bytes: number;
} {
  const canonical = canonicalJson(document);
  return { digest: cliDigest(canonical), bytes: Buffer.byteLength(canonical, "utf8") };
}

function sourceOf(row: Record<string, unknown>, path: string | undefined): ConfigurationSource {
  const declared = trimmedString(row.source)?.toLowerCase();
  if (declared === "repository" || declared === "repository-file" || declared === "repo") {
    return "repository-file";
  }
  if (declared === "database" || declared === "saved" || declared === "db") return "database";
  // `environmentJsonPath` is the field the read model already uses to decide the
  // managed type: a path means the file is the configuration of record.
  if (path !== undefined) return "repository-file";
  if (row.environmentJsonPath === null) return "database";
  return "unknown";
}

/** The candidate rows of an `env get` payload, including the single-object form. */
function candidateRows(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) return value;
  if (!isRecord(value)) return undefined;
  for (const key of ["candidates", "configurations", "sources"]) {
    const entry = value[key];
    if (Array.isArray(entry)) return entry;
  }
  // A payload that *is* one configuration is one candidate.
  return [value];
}

function candidateDocument(row: Record<string, unknown>): unknown {
  for (const key of ["environmentJson", "configuration", "config", "definition"]) {
    if (Object.hasOwn(row, key)) return row[key];
  }
  return undefined;
}

export type ConfigurationResult =
  | { ok: true; read: CliConfigurationRead }
  | { ok: false; code: "CLI_GET_SHAPE_UNKNOWN"; message: string };

/**
 * Project an `env get` payload into classified candidates.
 *
 * A candidate whose document is `null` is *withheld*, not empty: the read model
 * records that `environmentJson` can be null with an owner-restricted note, and
 * treating that as an empty configuration would report a definition nobody wrote.
 */
export function normalizeEnvironmentConfiguration(args: {
  environmentPublicId: string;
  payload: unknown;
}): ConfigurationResult {
  const rows = candidateRows(args.payload);
  if (rows === undefined) {
    return {
      ok: false,
      code: "CLI_GET_SHAPE_UNKNOWN",
      message: "the CLI's environment configuration output was not an object or an array",
    };
  }

  const candidates: CliConfigurationCandidate[] = [];
  let truncated = false;
  for (const row of rows) {
    if (candidates.length >= MAX_CONFIG_CANDIDATES) {
      truncated = true;
      break;
    }
    if (!isRecord(row)) continue;
    const path = trimmedString(row.environmentJsonPath) ?? trimmedString(row.path);
    const source = sourceOf(row, path);
    const candidate: CliConfigurationCandidate = {
      source,
      precedence: CONFIGURATION_PRECEDENCE[source],
      readable: false,
    };
    if (path !== undefined) candidate.path = path;

    const document = candidateDocument(row);
    const note =
      trimmedString(row.environmentJsonNote) ??
      trimmedString(row.note) ??
      trimmedString(row.reason);
    if (document === undefined || document === null) {
      candidate.reason =
        note ??
        "This authority reported no configuration document for the candidate. That is withheld " +
          "or absent, not an empty configuration.";
      candidates.push(candidate);
      continue;
    }
    try {
      const summary = summarizeConfiguration(document);
      candidate.readable = true;
      candidate.digest = summary.digest;
      candidate.bytes = summary.bytes;
    } catch {
      candidate.reason =
        "The configuration exceeds the supported nesting depth, so it is unreadable rather than assigned a potentially ambiguous digest.";
    }
    if (!candidate.readable && candidate.reason === undefined && note !== undefined) {
      candidate.reason = note;
    }
    candidates.push(candidate);
  }

  candidates.sort((left, right) => left.precedence - right.precedence);

  const digests = new Set(
    candidates
      .filter((candidate) => candidate.readable)
      .map((candidate) => candidate.digest ?? ""),
  );
  const classification: ConfigurationClassification =
    digests.size === 0 ? "unreadable" : digests.size === 1 ? "matched" : "different";

  const read: CliConfigurationRead = {
    environmentPublicId: args.environmentPublicId,
    candidates,
    classification,
    truncated,
  };
  if (classification === "matched") {
    const agreed = digests.values().next().value;
    if (agreed !== undefined && agreed !== "") read.digest = agreed;
  }
  return { ok: true, read };
}

export function configurationLine(candidate: CliConfigurationCandidate): string {
  return (
    `precedence=${candidate.precedence}  source=${candidate.source}` +
    `  path=${candidate.path ?? "(none)"}` +
    `  ${candidate.readable ? `digest=${candidate.digest ?? "(none)"}` : "unreadable"}`
  );
}

/* ----------------------------------------------------------------- writes */

/**
 * The provider-internal numeric row key, when a list row carried one.
 *
 * Catalog projection never emits this. Delete is the only consumer, and only as
 * a freshly resolved argv token that does not leave this process.
 */
export function internalNumericIdOf(row: Record<string, unknown>): number | undefined {
  for (const key of ["environmentId", "internalId", "id"]) {
    const value = row[key];
    if (typeof value === "number") {
      if (Number.isInteger(value) && value > 0 && Number.isSafeInteger(value)) return value;
      continue;
    }
    const text = trimmedString(value);
    if (text === undefined || !ALL_DIGITS.test(text)) continue;
    const parsed = Number(text);
    if (Number.isInteger(parsed) && parsed > 0 && Number.isSafeInteger(parsed)) return parsed;
  }
  return undefined;
}

export interface CliWriteTarget {
  environmentPublicId: string;
  scope: CliEnvironmentScope;
  repos: string[];
  name?: string;
  /** Resolved for delete dispatch. Never serialized onto a caller result. */
  internalId?: number;
}

export type WriteTargetResult =
  | { ok: true; target: CliWriteTarget }
  | {
      ok: false;
      status: "CLI_LIST_SHAPE_UNKNOWN" | "WRONG_ENVIRONMENT" | "AMBIGUOUS_ENVIRONMENT";
      reason: string;
    };

/**
 * Resolve one environment from a fresh `env list` payload.
 *
 * Membership is the CLI's row, not a caller-supplied catalog entry. Two rows
 * with the same public id are ambiguous rather than picked.
 */
export function resolveWriteTarget(
  payload: unknown,
  environmentPublicId: string,
): WriteTargetResult {
  const rows = catalogRows(payload);
  if (rows === undefined) {
    return {
      ok: false,
      status: "CLI_LIST_SHAPE_UNKNOWN",
      reason:
        "the CLI's environment list was neither an array nor an object carrying environments, " +
        "items, results, or data",
    };
  }

  const matches: CliWriteTarget[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const publicId = publicIdOf(row);
    if (publicId !== environmentPublicId) continue;
    const target: CliWriteTarget = {
      environmentPublicId: publicId,
      scope: normalizeScope(row),
      repos: normalizeRepos(row),
    };
    const name = trimmedString(row.name) ?? trimmedString(row.displayName);
    if (name !== undefined) target.name = name;
    const internalId = internalNumericIdOf(row);
    if (internalId !== undefined) target.internalId = internalId;
    matches.push(target);
  }

  if (matches.length === 0) {
    return {
      ok: false,
      status: "WRONG_ENVIRONMENT",
      reason: `environment ${environmentPublicId} is not in the CLI's current list.`,
    };
  }
  if (matches.length > 1) {
    return {
      ok: false,
      status: "AMBIGUOUS_ENVIRONMENT",
      reason: `environment ${environmentPublicId} matched more than one CLI list row.`,
    };
  }
  return { ok: true, target: matches[0]! };
}

/** Operator binding a write is gated against. Unpinned identity cannot authorize. */
export interface CliWriteBinding {
  name: string;
  publicId: string;
  scope: "personal" | "team";
  repos: string[];
  identityPinned: boolean;
}

export type BindingMatch =
  | { ok: true }
  | { ok: false; status: string; reason: string };

function repoKeys(repos: string[]): string[] | undefined {
  const keys: string[] = [];
  for (const repo of repos) {
    try {
      keys.push(repoKey(repo));
    } catch {
      return undefined;
    }
  }
  return [...new Set(keys)].sort();
}

/**
 * Exact binding: pinned public id, stated scope, and the same repository set.
 *
 * Caller-supplied membership is not consulted. An unpinned name, an unknown CLI
 * scope, or a repository set that is a subset rather than equal all fail closed.
 */
export function matchWriteBinding(
  target: CliWriteTarget,
  binding: CliWriteBinding,
  operation: CliWriteOperation,
): BindingMatch {
  if (!binding.identityPinned || binding.publicId.trim() === "") {
    return {
      ok: false,
      status: "IDENTITY_UNPINNED",
      reason:
        `environment ${binding.name} has no pinned environmentPublicId, so a write cannot be ` +
        "gated against an out-of-band identity.",
    };
  }
  if (binding.publicId !== target.environmentPublicId) {
    return {
      ok: false,
      status: "WRONG_ENVIRONMENT",
      reason:
        `environment ${binding.name} is pinned to ${binding.publicId}, not ` +
        `${target.environmentPublicId}.`,
    };
  }
  if (target.scope === "unknown") {
    return {
      ok: false,
      status: "WRONG_SCOPE",
      reason:
        "The CLI did not report a personal or team scope, so ownership cannot authorize a write.",
    };
  }
  if (target.scope !== binding.scope) {
    return {
      ok: false,
      status: "WRONG_SCOPE",
      reason: `The CLI reports scope ${target.scope}, not the binding's ${binding.scope}.`,
    };
  }

  const boundKeys = repoKeys(binding.repos);
  const targetKeys = repoKeys(target.repos);
  if (boundKeys === undefined || targetKeys === undefined) {
    return {
      ok: false,
      status: "WRONG_REPO",
      reason: "A bound or listed repository could not be canonicalized as an uncredentialed GitHub URL.",
    };
  }
  if (boundKeys.length === 0 || targetKeys.length === 0) {
    return {
      ok: false,
      status: "WRONG_REPO",
      reason: "A write requires an exact repository binding; an empty repository set proves nothing.",
    };
  }
  if (
    boundKeys.length !== targetKeys.length ||
    boundKeys.some((key, index) => key !== targetKeys[index])
  ) {
    return {
      ok: false,
      status: "WRONG_REPO",
      reason:
        "The CLI's repository set does not exactly match the environment binding. A subset or " +
        "superset is not agreement.",
    };
  }

  if (operation === "publish") {
    if (boundKeys.length !== 1 || targetKeys.length !== 1) {
      return {
        ok: false,
        status: "NOT_SINGLE_REPOSITORY",
        reason:
          "Publication is personal and single-repository first. An environment bound to more " +
          "than one repository is refused.",
      };
    }
    if (binding.scope !== "personal" || target.scope !== "personal") {
      return {
        ok: false,
        status: "WRONG_SCOPE",
        reason: "Publication is personal-first; a team environment is not published on this path.",
      };
    }
  }

  return { ok: true };
}

/** How long a digest-bound preview remains acceptable, in milliseconds. */
export const WRITE_PREVIEW_TTL_MS = 120_000;
const WRITE_PREVIEW_KEY = randomBytes(32);

export interface CliWritePreview {
  operation: CliWriteOperation;
  environmentPublicId: string;
  /** Configuration digest, or the delete identity digest. Never a script. */
  targetDigest: string;
  /** Database digest observed at preview time; save uses this to detect drift. */
  observedDigest?: string;
  previewToken: string;
  expiresAtMs: number;
}

function previewPayload(preview: Omit<CliWritePreview, "previewToken">): string {
  return canonicalJson({
    operation: preview.operation,
    environmentPublicId: preview.environmentPublicId,
    targetDigest: preview.targetDigest,
    ...(preview.observedDigest === undefined ? {} : { observedDigest: preview.observedDigest }),
    expiresAtMs: preview.expiresAtMs,
  });
}

function previewToken(payload: string): string {
  return `hmac-sha256:${createHmac("sha256", WRITE_PREVIEW_KEY).update(payload).digest("hex")}`;
}

function sameToken(left: string, right: string): boolean {
  const a = Buffer.from(left, "utf8");
  const b = Buffer.from(right, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function issueWritePreview(args: {
  operation: CliWriteOperation;
  environmentPublicId: string;
  targetDigest: string;
  observedDigest?: string;
  nowMs: number;
  ttlMs?: number;
}): CliWritePreview {
  const preview: Omit<CliWritePreview, "previewToken"> = {
    operation: args.operation,
    environmentPublicId: args.environmentPublicId,
    targetDigest: args.targetDigest,
    expiresAtMs: args.nowMs + (args.ttlMs ?? WRITE_PREVIEW_TTL_MS),
  };
  if (args.observedDigest !== undefined) preview.observedDigest = args.observedDigest;
  return { ...preview, previewToken: previewToken(previewPayload(preview)) };
}

export type ConfirmationCheck =
  | { ok: true }
  | {
      ok: false;
      status: "CONFIRMATION_REQUIRED" | "PREVIEW_EXPIRED" | "PREVIEW_MISMATCH";
      reason: string;
    };

export function verifyWriteConfirmation(args: {
  confirm?: boolean | undefined;
  preview?: CliWritePreview | undefined;
  previewToken?: string | undefined;
  operation: CliWriteOperation;
  environmentPublicId: string;
  nowMs: number;
}): ConfirmationCheck {
  if (args.confirm !== true) {
    return {
      ok: false,
      status: "CONFIRMATION_REQUIRED",
      reason: "This write requires confirm: true and a digest-bound preview token.",
    };
  }
  if (args.preview === undefined || args.previewToken === undefined) {
    return {
      ok: false,
      status: "CONFIRMATION_REQUIRED",
      reason:
        "This write requires the preview issued by the previous call. This server stores nothing " +
        "between calls.",
    };
  }
  if (
    args.preview.operation !== args.operation ||
    args.preview.environmentPublicId !== args.environmentPublicId
  ) {
    return {
      ok: false,
      status: "PREVIEW_MISMATCH",
      reason: "The confirmation preview is for a different operation or environment.",
    };
  }
  if (args.nowMs > args.preview.expiresAtMs) {
    return {
      ok: false,
      status: "PREVIEW_EXPIRED",
      reason: "The write preview has expired. Issue a new preview; do not retry a dispatched write.",
    };
  }
  const expected = previewToken(previewPayload(args.preview));
  if (
    !sameToken(args.preview.previewToken, expected) ||
    !sameToken(args.previewToken, args.preview.previewToken)
  ) {
    return {
      ok: false,
      status: "PREVIEW_MISMATCH",
      reason: "The confirmation token does not match the issued preview.",
    };
  }
  return { ok: true };
}

/** Highest-precedence readable digest, used as publish content proof. */
export function readableContentDigest(read: CliConfigurationRead): string | undefined {
  const readable = read.candidates.find((candidate) => candidate.readable);
  return readable?.digest;
}

/** Database-source digest when that candidate is readable. */
export function databaseDigest(read: CliConfigurationRead): string | undefined {
  const candidate = read.candidates.find(
    (entry) => entry.source === "database" && entry.readable,
  );
  return candidate?.digest;
}

export function readPullRequestUrl(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  for (const key of ["prUrl", "pullRequestUrl", "pr_url"]) {
    const text = trimmedString(value[key]);
    if (text !== undefined && isGithubPullRequestUrl(text)) return text;
  }
  const nested = value.pullRequest;
  if (isRecord(nested)) {
    const text = trimmedString(nested.url) ?? trimmedString(nested.htmlUrl);
    if (text !== undefined && isGithubPullRequestUrl(text)) return text;
  }
  const url = trimmedString(value.url);
  if (url !== undefined && isGithubPullRequestUrl(url)) return url;
  return undefined;
}

function isGithubPullRequestUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname.toLowerCase() === "github.com" &&
      /\/pull\/\d+\/?$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function environmentAbsentFromList(
  catalog: CliEnvironmentCatalog,
  environmentPublicId: string,
): { absent: boolean; conclusive: boolean } {
  const present = catalog.entries.some(
    (entry) => entry.environmentPublicId === environmentPublicId,
  );
  return {
    absent: !present,
    conclusive: !catalog.truncated && catalog.dropped === 0 && !present,
  };
}

export function deleteDryRunMatchesTarget(
  payload: unknown,
  target: CliWriteTarget,
): boolean {
  if (!isRecord(payload)) return false;
  const candidate = isRecord(payload.environment) ? payload.environment : payload;
  if (publicIdOf(candidate) !== target.environmentPublicId) return false;
  const internalId = internalNumericIdOf(candidate);
  return internalId === undefined || internalId === target.internalId;
}

export function deleteIdentityDigest(target: CliWriteTarget): string | undefined {
  if (target.internalId === undefined) return undefined;
  return cliDigest(
    canonicalJson({
      environmentPublicId: target.environmentPublicId,
      internalId: target.internalId,
      scope: target.scope,
      repos: target.repos,
    }),
  );
}
