import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BASE_VERSION, VERSION, formatVersion, readReleaseSha } from "../src/version.js";

const FULL_SHA = "0123456789abcdef0123456789abcdef01234567";

describe("version identity", () => {
  it("takes the base version from package.json", () => {
    const { version } = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
    expect(BASE_VERSION).toBe(version);
  });

  it("stamps a known revision as build metadata and marks an unknown one", () => {
    expect(formatVersion("0.2.0", FULL_SHA)).toBe("0.2.0+g0123456789ab");
    expect(formatVersion("0.2.0", undefined)).toBe("0.2.0+unknown");
  });

  it("a source run has no stamp beside it and says so", () => {
    expect(VERSION).toBe(`${BASE_VERSION}+unknown`);
  });

  it("reads a stamp only when it is a well-formed SHA", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-mcp-version-"));
    const path = join(dir, "build-info.json");

    expect(readReleaseSha(path)).toBeUndefined();

    writeFileSync(path, JSON.stringify({ releaseSha: FULL_SHA }));
    expect(readReleaseSha(path)).toBe(FULL_SHA);

    const tooShort = JSON.stringify({ releaseSha: FULL_SHA.slice(0, 11) });
    for (const bad of ["not json", "{}", '{"releaseSha":"HEAD"}', '{"releaseSha":"../x"}', tooShort]) {
      writeFileSync(path, bad);
      expect(readReleaseSha(path), bad).toBeUndefined();
    }
  });
});

describe("write-build-info", () => {
  function run(env: Record<string, string>, outDir: string) {
    return spawnSync(process.execPath, ["scripts/write-build-info.mjs", outDir], {
      env: { PATH: process.env.PATH ?? "", ...env },
      encoding: "utf8",
    });
  }

  it("writes the stamp the installer passes", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-mcp-stamp-"));
    const result = run({ CURSOR_MCP_RELEASE_SHA: FULL_SHA }, dir);
    expect(result.status).toBe(0);
    expect(readReleaseSha(join(dir, "build-info.json"))).toBe(FULL_SHA);
  });

  it("removes a stale stamp when the build is unstamped", () => {
    const dir = mkdtempSync(join(tmpdir(), "cursor-mcp-stamp-"));
    writeFileSync(join(dir, "build-info.json"), JSON.stringify({ releaseSha: FULL_SHA }));
    expect(run({}, dir).status).toBe(0);
    expect(existsSync(join(dir, "build-info.json"))).toBe(false);
  });

  it("fails the build on a value that is not a Git object name of stamp length", () => {
    for (const bad of ["main", FULL_SHA.slice(0, 7)]) {
      const dir = mkdtempSync(join(tmpdir(), "cursor-mcp-stamp-"));
      const result = run({ CURSOR_MCP_RELEASE_SHA: bad }, dir);
      expect(result.status, bad).toBe(1);
      expect(result.stderr).toContain("at least 12 hex characters");
      expect(existsSync(join(dir, "build-info.json"))).toBe(false);
    }
  });
});
