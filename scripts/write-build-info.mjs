// Writes dist/build-info.json, the revision stamp `src/version.ts` reads.
//
// Runs as the last step of `npm run build`. The installer sets
// CURSOR_MCP_RELEASE_SHA to the commit it extracted; a build with it unset is
// deliberately unstamped, and any stamp a previous build left in dist/ is
// removed so a working-tree rebuild never carries a stale commit forward (tsc
// does not clean its output directory). A value that is not a Git object name
// fails the build: a stamp is an identity claim, and a wrong one is worse than
// none. At least twelve hex characters are required, matching the stamp
// `src/version.ts` reports; an installer always has the full SHA.
//
// Usage: node scripts/write-build-info.mjs [outDir]   (outDir defaults to dist)

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const RELEASE_SHA_PATTERN = /^[0-9a-f]{12,64}$/;

const outDir = process.argv[2] ?? "dist";
const target = join(outDir, "build-info.json");
const sha = process.env.CURSOR_MCP_RELEASE_SHA;

if (sha === undefined || sha === "") {
  rmSync(target, { force: true });
} else if (!RELEASE_SHA_PATTERN.test(sha)) {
  console.error(
    `write-build-info: CURSOR_MCP_RELEASE_SHA must be a Git object name of at least 12 hex characters (got ${JSON.stringify(sha)})`,
  );
  process.exit(1);
} else {
  mkdirSync(outDir, { recursive: true });
  writeFileSync(target, `${JSON.stringify({ releaseSha: sha })}\n`, "utf8");
}
