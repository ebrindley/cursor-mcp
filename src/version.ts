/**
 * The version this server reports: the package version, plus the source
 * revision it was built from as SemVer build metadata (`0.2.0+g0123456789ab`).
 *
 * `package.json` is the single source of the base version. It is resolved
 * relative to this module, so the same code answers from `src/` under tsx and
 * from `dist/` in a built release, and follows whichever release a symlink
 * launch actually loaded rather than the path in `argv[1]`.
 *
 * The revision is a build-time stamp: `scripts/write-build-info.mjs` writes
 * `build-info.json` beside the compiled module when the build is given a
 * commit. A tree built without one -- a working-tree build, a source run, or an
 * installer that predates the stamp -- reports `+unknown`, so an unstamped
 * build is never mistaken for a specific commit. Build metadata is ignored for
 * SemVer precedence, so the stamp identifies a build; it does not order builds.
 */

import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Characters of the revision carried in the version string. */
const STAMP_CHARS = 12;

/**
 * A lowercase Git object name long enough to fill the stamp. A shorter
 * abbreviation is refused rather than padded or passed through: the reported
 * format promises twelve characters, and an installer always has the full SHA.
 */
export const RELEASE_SHA_PATTERN = /^[0-9a-f]{12,64}$/;

const BUILD_INFO_FILE = "build-info.json";

const require = createRequire(import.meta.url);

/** The `version` field of this package's `package.json`. */
export const BASE_VERSION: string = (require("../package.json") as { version: string }).version;

/**
 * The revision recorded in `build-info.json`, or `undefined` when the file is
 * absent, unreadable, or does not carry a well-formed SHA. A malformed stamp is
 * treated as no stamp: reporting it would attach an unverifiable identity.
 */
export function readReleaseSha(buildInfoPath: string): string | undefined {
  let text: string;
  try {
    text = readFileSync(buildInfoPath, "utf8");
  } catch {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const sha = (parsed as { releaseSha?: unknown }).releaseSha;
  return typeof sha === "string" && RELEASE_SHA_PATTERN.test(sha) ? sha : undefined;
}

/** `<base>+g<sha12>` when a revision is known, otherwise `<base>+unknown`. */
export function formatVersion(base: string, releaseSha: string | undefined): string {
  if (releaseSha === undefined) return `${base}+unknown`;
  return `${base}+g${releaseSha.slice(0, STAMP_CHARS)}`;
}

/** The full commit this module was built from, when the build was stamped. */
export const RELEASE_SHA: string | undefined = readReleaseSha(
  join(dirname(fileURLToPath(import.meta.url)), BUILD_INFO_FILE),
);

/** The version string reported in the MCP handshake and by `--version`. */
export const VERSION: string = formatVersion(BASE_VERSION, RELEASE_SHA);
