import { createWaitScope, within, sleep } from "../dist/wait.js";
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const operationScope = createWaitScope({ timeoutMs: 20_000 });
const io = start => within(operationScope, start);
const dir = await io(() => mkdtemp(join(tmpdir(), "cursor-mcp-bin-")));
const policyPath = join(dir, "policy.json");
const binPath = join(dir, "cursor-mcp");

await io(() => writeFile(
  policyPath,
  JSON.stringify({
    defaultProfile: "read",
    profiles: { read: { tools: ["read:*"] } },
  }),
  "utf8",
));
await io(() => symlink(resolve("dist/bin.js"), binPath));
operationScope.throwIfStopped();

const child = spawn(process.execPath, [binPath], {
  env: {
    ...process.env,
    CURSOR_API_KEY: "dummy-not-real",
    CURSOR_MCP_POLICY: policyPath,
  },
  stdio: ["pipe", "pipe", "pipe"],
});
const stopChild = processChild => {
  processChild.kill("SIGKILL");
  processChild.stdin?.destroy();
  processChild.stdout?.destroy();
  processChild.stderr?.destroy();
  processChild.unref();
};
const closed = new Promise((resolveExit) => child.once("close", resolveExit));

let stdout = "";
let stderr = "";
child.stdin.on("error", () => {});
child.stdout.on("error", () => {});
child.stderr.on("error", () => {});
child.stdout.on("data", (chunk) => {
  stdout += chunk.toString();
});
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

child.stdin.write(
  `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bin-check", version: "0" },
    },
  })}\n`,
);

/**
 * The read-only surface `main()` composes from every registrar. Unit tests
 * exercise each registrar alone, so a registrar dropped from `src/server.ts`
 * would leave them green; this is the one check that sees the shipped list.
 */
const EXPECTED_READ_ONLY_TOOLS = [
  "cursor_assess_environment_health",
  "cursor_diff_environment_definition",
  "cursor_get_active_build",
  "cursor_get_agent",
  "cursor_get_artifact_url",
  "cursor_get_build",
  "cursor_get_bulk_job",
  "cursor_get_environment_configuration",
  "cursor_get_run",
  "cursor_get_usage",
  "cursor_get_workspace_control",
  "cursor_inspect_environment_definition",
  "cursor_inspect_runs",
  "cursor_inspect_workspace",
  "cursor_list_agents",
  "cursor_list_artifacts",
  "cursor_list_builds",
  "cursor_list_environments",
  "cursor_list_environment_history",
  "cursor_list_models",
  "cursor_list_owner_actions",
  "cursor_list_repos",
  "cursor_list_runs",
  "cursor_list_workspace_controls",
  "cursor_tail_run",
  "cursor_validate_environment_definition",
  "cursor_wait_run",
  "cursor_whoami",
];

const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
const waitFor = async (predicate, what) => {
  const scope = createWaitScope({ timeoutMs: 5_000, parent: operationScope });
  try {
    await within(scope, async () => {
      while (!predicate() && child.exitCode === null) await sleep(scope, 20);
    });
  } catch {
    stopChild(child);
    throw new Error(`installed-bin ${what} timed out; stderr=${stderr}`);
  } finally { scope.dispose(); }
};

await waitFor(() => stdout.includes('"result"'), "handshake");
send({ jsonrpc: "2.0", method: "notifications/initialized" });
send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
await waitFor(() => stdout.includes('"tools"'), "tools/list");

child.stdin.end();
const closeScope = createWaitScope({ timeoutMs: 5_000, parent: operationScope });
let exitCode;
try { exitCode = await within(closeScope, () => closed); }
catch (error) { stopChild(child); throw error; }
finally { closeScope.dispose(); }
if (exitCode !== 0 || !stdout.includes('"name":"cursor-mcp"')) {
  throw new Error(
    `installed-bin handshake failed (exit ${exitCode}); stdout=${stdout}; stderr=${stderr}`,
  );
}

const messages = stdout
  .split("\n")
  .filter((line) => line.startsWith("{"))
  .map((line) => JSON.parse(line));
const listed = messages.find((message) => message.id === 2);

// The handshake reports the package version plus a build stamp, and
// `--version` must answer the same string with no key and no policy file, so an
// installer or a person can read which build a release is without starting it.
const { version: packageVersion } = JSON.parse(readFileSync("package.json", "utf8"));
const reported = messages.find((message) => message.id === 1)?.result?.serverInfo?.version;
const stampPattern = /^\+(?:unknown|g[0-9a-f]{12})$/;
if (
  typeof reported !== "string" ||
  !reported.startsWith(`${packageVersion}+`) ||
  !stampPattern.test(reported.slice(packageVersion.length))
) {
  throw new Error(
    `installed-bin handshake reported version ${JSON.stringify(reported)}; expected ${packageVersion}+unknown or ${packageVersion}+g<sha12>`,
  );
}
const versionScope = createWaitScope({ timeoutMs: 5_000, parent: operationScope });
let versionChild;
let versionRun;
try {
  versionRun = await within(versionScope, () => new Promise((resolveVersion, rejectVersion) => {
    versionChild = spawn(process.execPath, [binPath, "--version"], {
      env: { PATH: process.env.PATH }, stdio: ["ignore", "pipe", "pipe"],
    });
    let versionStdout = "";
    let versionStderr = "";
    versionChild.stdout.on("error", () => {});
    versionChild.stderr.on("error", () => {});
    versionChild.stdout.on("data", chunk => { versionStdout += chunk.toString(); });
    versionChild.stderr.on("data", chunk => { versionStderr += chunk.toString(); });
    versionChild.once("error", rejectVersion);
    versionChild.once("close", status => resolveVersion({ status, stdout: versionStdout, stderr: versionStderr }));
  }));
} catch (error) {
  if (versionChild) stopChild(versionChild);
  throw error;
} finally { versionScope.dispose(); }
if (versionRun.status !== 0 || versionRun.stdout !== `${reported}\n`) {
  throw new Error(
    `installed-bin --version disagreed with the handshake (exit ${versionRun.status}); stdout=${versionRun.stdout}; stderr=${versionRun.stderr}`,
  );
}
const names = (listed?.result?.tools ?? []).map((tool) => tool.name).sort();
const missing = EXPECTED_READ_ONLY_TOOLS.filter((name) => !names.includes(name));
const extra = names.filter((name) => !EXPECTED_READ_ONLY_TOOLS.includes(name));
if (missing.length > 0 || extra.length > 0) {
  throw new Error(
    `installed-bin tools/list drifted; missing=[${missing.join(", ")}] extra=[${extra.join(", ")}]`,
  );
}
console.log(`check:bin OK -- ${reported}; ${names.length} read-only tools through the symlink`);

operationScope.dispose();
