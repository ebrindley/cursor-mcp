/**
 * stdout is the JSON-RPC channel under the stdio transport. A single stray byte
 * there corrupts the protocol stream for every client. This was previously
 * verified only by hand.
 */

import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

async function sourceFiles(dir = "src"): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sourceFiles(path)));
    else if (entry.name.endsWith(".ts")) out.push(path);
  }
  return out;
}

/**
 * Human commands answer on stdout without connecting the MCP transport.
 * Allow their two exact entrypoint writes; other writes remain offenders.
 */
const ALLOWED_WRITES: ReadonlyArray<[path: string, line: RegExp]> = [
  ["src/bin.ts", /^\s*process\.stdout\.write\(`\$\{VERSION\}\\n`\);\s*$/],
  ["src/bin.ts", /^  process\.exitCode = await runSetupCommand\(process\.argv\.slice\(2\), \(line\) => process\.stdout\.write\(`\$\{line\}\\n`\), \(line\) => process\.stderr\.write\(`\$\{line\}\\n`\)\);$/],
];

describe("stdout purity", () => {
  it("has no console or stdout write anywhere in src", async () => {
    const offenders: string[] = [];
    for (const path of await sourceFiles()) {
      const text = await readFile(path, "utf8");
      for (const [i, line] of text.split("\n").entries()) {
        if (line.trimStart().startsWith("*") || line.trimStart().startsWith("//")) {
          continue; // A comment may legitimately name console.log.
        }
        if (ALLOWED_WRITES.some(([file, allowed]) => file === path && allowed.test(line))) {
          continue;
        }
        if (/\bconsole\s*\.|process\s*\.\s*stdout\s*\.\s*write/.test(line)) {
          offenders.push(`${path}:${i + 1}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  async function startServer(env: Record<string, string>) {
    const child = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
      { env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.on("data", (c: Buffer) => (stderr += c.toString()));
    const code = await new Promise<number | null>((resolve) => {
      child.on("close", resolve);
      child.stdin.end();
    });
    return { stdout, stderr, code };
  }

  it("writes nothing to stdout when startup fails", async () => {
    // The worst case for protocol corruption: a diagnostic printed before the
    // transport is connected.
    const { stdout, stderr, code } = await startServer({
      CURSOR_API_KEY: "",
      CURSOR_MCP_POLICY: "/nonexistent/policy.json",
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("CURSOR_API_KEY");
    expect(code).toBe(1);
  }, 30_000);

  it("exits cleanly when the client closes stdin", async () => {
    // The SDK's stdio transport registers no `end`/`close` listener, so nothing
    // calls server.close(). Today the process still exits, because at idle
    // nothing holds the event loop open. That is the invariant this pins: when a
    // long-lived stream is added, this test fails and the shutdown handler that
    // failure demands becomes necessary rather than speculative.
    const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-exit-"));
    const path = join(dir, "policy.json");
    await writeFile(
      path,
      JSON.stringify({ defaultProfile: "p", profiles: { p: { tools: ["read:*"] } } }),
      "utf8",
    );

    const child = spawn(
      process.execPath,
      ["node_modules/tsx/dist/cli.mjs", "src/server.ts"],
      {
        env: { ...process.env, CURSOR_API_KEY: "dummy-not-real", CURSOR_MCP_POLICY: path },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    child.stdout.on("data", (c: Buffer) => (stdout += c.toString()));
    child.stderr.resume();

    child.stdin.write(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "t", version: "0" },
        },
      })}\n`,
    );
    // Wait for the handshake reply, so we close stdin on a live server.
    await new Promise<void>((resolve) => {
      const check = () => (stdout.includes('"result"') ? resolve() : setTimeout(check, 20));
      check();
    });

    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
    expect(code).toBe(0);
  }, 30_000);

  it("refuses to start when the active profile permits no tools", async () => {
    // Serving zero tools is not a locked-down server: the SDK answers tools/list
    // with "Method not found", which a client reads as broken.
    const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-empty-"));
    const path = join(dir, "policy.json");
    await writeFile(
      path,
      JSON.stringify({ defaultProfile: "p", profiles: { p: { tools: [] } } }),
      "utf8",
    );

    const { stdout, stderr, code } = await startServer({
      CURSOR_API_KEY: "dummy-not-real",
      CURSOR_MCP_POLICY: path,
    });
    expect(stdout).toBe("");
    expect(stderr).toContain("permits no tools");
    expect(code).toBe(1);
  }, 30_000);
});
