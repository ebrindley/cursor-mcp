import { spawn } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("closes the real stdio server during a pending stream when stdin ends", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cursor-stream-disconnect-"));
  const policy = join(dir, "policy.json");
  await writeFile(policy, JSON.stringify({ defaultProfile: "p", profiles: { p: { repos: ["O/R"], tools: ["cursor_tail_run"] } } }));
  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "tests/fixtures/streaming-server.mjs"], {
    env: { ...process.env, CURSOR_API_KEY: "dummy-not-real", CURSOR_MCP_POLICY: policy },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let error = "";
  child.stdout.on("data", (b: Buffer) => { output += b.toString(); });
  child.stderr.on("data", (b: Buffer) => { error += b.toString(); });
  const closed = new Promise<number | null>((resolve) => child.once("close", resolve));
  const wait = async (predicate: () => boolean) => {
    const until = Date.now() + 5000;
    while (!predicate()) {
      if (Date.now() > until || child.exitCode !== null) throw new Error(`Fixture did not reach expected state: ${error}`);
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  const send = (message: unknown) => child.stdin.write(`${JSON.stringify(message)}\n`);
  try {
    send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } } });
    await wait(() => output.includes('"result"'));
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "cursor_tail_run", arguments: { agentId: "bc-1", runId: "run-1", durationMs: 30_000 } } });
    await wait(() => error.includes("fixture-stream-open"));
    child.stdin.end();
    await wait(() => child.exitCode !== null);
    expect(await closed).toBe(0);
    for (const line of output.trim().split("\n")) expect(() => JSON.parse(line)).not.toThrow();
  } finally {
    if (child.exitCode === null) { child.kill(); await closed; }
  }
}, 15_000);
