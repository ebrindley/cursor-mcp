/**
 * The entry-point guard decides whether `main()` runs at all. When it decides
 * wrongly the process still exits 0 and prints nothing, so a host sees a server
 * that connected and offered no tools -- indistinguishable from a broken build.
 *
 * That is not hypothetical: a release-symlink deployment launches this file
 * through a symlink, Node resolves `import.meta.url` through realpath(3) while
 * `argv[1]` keeps the link path, and a guard comparing the two silently
 * disabled every host.
 */

import { spawn } from "node:child_process";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function policyFile(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-entry-"));
  const path = join(dir, "policy.json");
  await writeFile(
    path,
    JSON.stringify({ defaultProfile: "p", profiles: { p: { tools: ["read:*"] } } }),
    "utf8",
  );
  return path;
}

/** Runs the server at `entry` to the point where it announces its tool surface. */
async function startedSurface(entry: string, policy: string): Promise<string> {
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", entry], {
    // CURSOR_MCP_LOG_LEVEL is pinned because the assertion below reads an info
    // line: inheriting `error` from the shell or a CI job would fail this test
    // while the guard under test was perfectly correct.
    env: {
      ...process.env,
      CURSOR_API_KEY: "dummy-not-real",
      CURSOR_MCP_POLICY: policy,
      CURSOR_MCP_LOG_LEVEL: "info",
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
  child.stdout.resume();
  await new Promise<number | null>((done) => {
    child.on("close", done);
    child.stdin.end();
  });
  return stderr;
}

describe("entry-point detection", () => {
  it("starts when launched by its own path", async () => {
    expect(await startedSurface("src/server.ts", await policyFile())).toContain("ready:");
  }, 30_000);

  it("starts when launched through a symlink", async () => {
    // Both the link and its target are absolute, which is what a deployment that
    // activates releases by renaming a symlink produces.
    const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-link-"));
    const link = join(dir, "server.ts");
    await symlink(resolve("src/server.ts"), link);

    expect(await startedSurface(link, await policyFile())).toContain("ready:");
  }, 30_000);
});
