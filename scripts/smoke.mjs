#!/usr/bin/env node
/**
 * Live end-to-end smoke check.
 *
 * Every unit test in this repo mocks fetch, which means they verify our
 * assumptions rather than Cursor's behaviour. Each assumption that has actually
 * broken -- no correlation header, a second cancel returning 409, the stream's
 * status disagreeing with REST -- was found by hand and cannot be caught by a
 * mock that encodes the same belief. This script is the repeatable version of
 * that hand-checking.
 *
 * It is end-to-end on purpose: it spawns the built server over stdio and drives
 * it with a real MCP client, so registration gating, schema validation, and the
 * result envelope are all in the path, not just the HTTP client.
 *
 * Two tiers. The default tier is read-only, costs no quota, and can run as often
 * as you like. The `--write` tier launches one real agent and spends real money,
 * so it is opt-in: run it before shipping, not on every change.
 *
 * Usage: npm run smoke          read-only checks
 *        npm run smoke:write    read-only checks, then one real launch
 *
 * Needs CURSOR_API_KEY and a built dist/.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/** Tools the dev profile should expose. cursor_delete_agent must NOT be here. */
const EXPECTED_TOOLS = [
  "cursor_whoami",
  "cursor_list_models",
  "cursor_list_repos",
  "cursor_list_agents",
  "cursor_get_agent",
  "cursor_list_runs",
  "cursor_get_run",
  "cursor_wait_run",
  "cursor_get_usage",
  "cursor_list_artifacts",
  "cursor_get_artifact_url",
  "cursor_create_agent",
  "cursor_create_run",
  "cursor_cancel_run",
  "cursor_archive_agent",
  "cursor_unarchive_agent",
];

/** The repo the write tier launches against. Must be in the policy file. */
const WRITE_REPO = "ebrindley/cursor-mcp";
/** How long to wait for a run to reach a terminal state. */
const RUN_TIMEOUT_MS = 240_000;
const POLL_MS = 5_000;

let passed = 0;
const failures = [];

async function check(name, fn) {
  try {
    const note = await fn();
    passed += 1;
    console.log(`  ok    ${name}${note ? ` -- ${note}` : ""}`);
  } catch (error) {
    failures.push(name);
    console.log(`  FAIL  ${name}`);
    console.log(`        ${error instanceof Error ? error.message : String(error)}`);
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

/** Call a tool and return its structured payload, failing loudly on a tool error. */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  assert(!result.isError, `${name} returned an error: ${text}`);
  // Every result goes through the shared envelope; if this ever stops being
  // true, Cursor-originated text is reaching the model unfenced.
  assert(text.includes("CURSOR_UNTRUSTED"), `${name} result was not fenced`);
  return result.structuredContent ?? {};
}

/** Call a tool expecting failure, and return the error text. */
async function callExpectingError(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
  assert(result.isError === true, `${name} succeeded when it should have failed`);
  return text;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Poll a run until it reports terminal, or give up. */
async function waitForTerminal(client, agentId, runId) {
  const deadline = Date.now() + RUN_TIMEOUT_MS;
  for (;;) {
    const run = await call(client, "cursor_get_run", { agentId, runId });
    if (run.terminal === true) return run;
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} still ${run.status} after ${RUN_TIMEOUT_MS}ms`);
    }
    await sleep(POLL_MS);
  }
}

/**
 * Write-path checks.
 *
 * One agent, two runs. The first is left to finish so we see a real result come
 * back. The second receives a cancellation request. A successful response does
 * not establish that the run has stopped, so the check waits for a terminal
 * state before verifying that another cancellation is rejected.
 *
 * The agent is archived at the end so repeated runs do not pile up in the list.
 */
async function writeTier(client) {
  console.log("\nwrite paths (spending real quota)");

  let agentId;
  let firstRunId;

  await check("cursor_create_agent launches a run", async () => {
    const created = await call(client, "cursor_create_agent", {
      repo: WRITE_REPO,
      name: "cursor-mcp smoke (write tier)",
      prompt:
        "Write a file named smoke.txt into the workspace artifacts directory " +
        "at /opt/cursor/artifacts. Its entire contents must be the single " +
        "line: artifact smoke test\n\n" +
        "Do not write it inside the git repository, do not modify any " +
        "repository files, and do not open a pull request. Reply with the " +
        "absolute path you wrote.",
    });
    assert(typeof created.agentId === "string", "no agentId returned");
    assert(typeof created.runId === "string", "no runId returned");
    agentId = created.agentId;
    firstRunId = created.runId;
    return `${agentId} run=${firstRunId} status=${created.status}`;
  });

  await check("the run finishes and returns a result", async () => {
    const run = await waitForTerminal(client, agentId, firstRunId);
    assert(run.status === "FINISHED", `ended ${run.status}, not FINISHED`);
    // The reply itself travels only in the fenced text block; the structured
    // result carries its size.
    assert(
      typeof run.resultBytes === "number" && run.resultBytes > 0,
      "finished with no result text",
    );
    return `${run.status} in ${run.durationMs}ms`;
  });

  await check("the artifact the run wrote is listed", async () => {
    const listed = await call(client, "cursor_list_artifacts", { agentId });
    const items = listed.artifacts ?? [];
    // Paths are relative to the workspace artifacts directory and keep the
    // `artifacts/` prefix. A file written to a directory called `artifacts` in
    // the repository does not appear here at all; that was tried and returned
    // an empty list.
    const smoke = items.find((a) => a.path === "artifacts/smoke.txt");
    assert(smoke !== undefined, `not listed; got ${JSON.stringify(items)}`);
    return `${smoke.path} ${smoke.sizeBytes} bytes`;
  });

  await check("the presigned URL downloads the exact bytes", async () => {
    const minted = await call(client, "cursor_get_artifact_url", {
      agentId,
      path: "artifacts/smoke.txt",
    });
    assert(typeof minted.url === "string", "no url returned");
    // The server deliberately does not fetch this itself: its HTTP client
    // refuses any off-origin request so the Authorization header cannot follow
    // an API-supplied URL elsewhere. Downloading is the caller's job, which is
    // what this check stands in for.
    const res = await fetch(minted.url);
    assert(res.status === 200, `download returned ${res.status}`);
    const body = await res.text();
    assert(
      body === "artifact smoke test\n",
      `unexpected contents: ${JSON.stringify(body)}`,
    );
    return `200, ${Buffer.byteLength(body)} bytes, expires ${minted.expiresAt ?? "(unstated)"}`;
  });

  let secondRunId;

  await check("cursor_create_run adds a follow-up run", async () => {
    const created = await call(client, "cursor_create_run", {
      agentId,
      prompt:
        "Read every file under src/ and src/tools/ and summarise each one in a " +
        "paragraph. Do not modify anything.",
    });
    assert(typeof created.runId === "string", "no runId returned");
    secondRunId = created.runId;
    return `run=${secondRunId} status=${created.status}`;
  });

  await check("cursor_cancel_run returns before the run has stopped", async () => {
    await call(client, "cursor_cancel_run", { agentId, runId: secondRunId });
    // Cancel is asynchronous. Reading straight back usually still shows a
    // non-terminal state, which is why nothing should treat a 200 here as
    // "stopped". Reported rather than asserted, since it is a race we do not
    // control and losing it is not a failure.
    const run = await call(client, "cursor_get_run", { agentId, runId: secondRunId });
    return run.terminal === true
      ? `already terminal (${run.status}), race lost`
      : `still ${run.status} after a 200, as expected`;
  });

  await check("the cancelled run reaches a terminal state", async () => {
    const run = await waitForTerminal(client, agentId, secondRunId);
    // Not asserted as CANCELLED. A cancel that returns 200 does not guarantee
    // the run stops: one observed run took the 200 and reached FINISHED
    // anyway. Reaching terminal is the invariant; which terminal state it is
    // depends on a race we do not control.
    assert(run.terminal === true, "never reached a terminal state");
    return run.status === "CANCELLED"
      ? "CANCELLED"
      : `${run.status} -- the cancel did not take, which is allowed`;
  });

  await check("a second cancel fails instead of being a no-op", async () => {
    const text = await callExpectingError(client, "cursor_cancel_run", {
      agentId,
      runId: secondRunId,
    });
    // The exact reason matters. Any error would pass a weaker check, including
    // an outage, and this is the specific behaviour the annotation depends on.
    assert(
      text.includes("run_not_cancellable") || text.includes("409"),
      `unexpected failure: ${text}`,
    );
    return "409 run_not_cancellable";
  });

  await check("archive then unarchive round-trips", async () => {
    await call(client, "cursor_archive_agent", { agentId });
    const archived = await call(client, "cursor_get_agent", { agentId });
    assert(archived.status === "ARCHIVED", `archive left it ${archived.status}`);

    await call(client, "cursor_unarchive_agent", { agentId });
    const active = await call(client, "cursor_get_agent", { agentId });
    assert(active.status !== "ARCHIVED", `unarchive left it ${active.status}`);
    assert(active.followUp === "accepted", `unarchive follow-up is ${active.followUp}`);
    return `IDLE/ACTIVE -> ARCHIVED -> ${active.status}`;
  });

  await check("cleans up after itself", async () => {
    await call(client, "cursor_archive_agent", { agentId });
    const final = await call(client, "cursor_get_agent", { agentId });
    assert(final.status === "ARCHIVED", `cleanup left it ${final.status}`);
    return `${agentId} archived`;
  });

  await check("reports what the run cost", async () => {
    const usage = await call(client, "cursor_get_usage", { agentId });
    assert(typeof usage.totalTokens === "number", "no totalTokens");
    return `${usage.totalTokens} tokens, charged=${usage.chargedCents ?? "absent"}`;
  });
}

async function main() {
  if (!process.env.CURSOR_API_KEY) {
    console.error("CURSOR_API_KEY is not set.");
    process.exit(2);
  }

  const transport = new StdioClientTransport({
    command: process.execPath,
    // The entrypoint hosts actually launch, not the module behind it.
    args: ["dist/bin.js"],
    // Inherit the real environment: this is meant to exercise the same policy
    // file and key the editor uses, not a synthetic setup.
    env: process.env,
    stderr: "inherit",
  });
  const client = new Client({ name: "cursor-mcp-smoke", version: "0" });
  await client.connect(transport);

  console.log("\nregistration");

  let names = [];
  await check("exposes exactly the expected tools", async () => {
    const { tools } = await client.listTools();
    names = tools.map((t) => t.name).sort();
    const missing = EXPECTED_TOOLS.filter((t) => !names.includes(t));
    const extra = names.filter((t) => !EXPECTED_TOOLS.includes(t));
    assert(missing.length === 0, `missing: ${missing.join(", ")}`);
    assert(extra.length === 0, `unexpected: ${extra.join(", ")}`);
    return `${names.length} tools`;
  });

  await check("keeps cursor_delete_agent gated behind deleteEnabled", () => {
    assert(
      !names.includes("cursor_delete_agent"),
      "cursor_delete_agent is visible; deleteEnabled is on, or the gate broke",
    );
  });

  await check("gives every tool a one-line description", async () => {
    const { tools } = await client.listTools();
    const sprawling = tools.filter((t) => (t.description ?? "").includes("\n"));
    assert(sprawling.length === 0, `multi-line: ${sprawling.map((t) => t.name).join(", ")}`);
  });

  console.log("\naccount");

  await check("cursor_whoami", async () => {
    const me = await call(client, "cursor_whoami");
    assert(typeof me.userEmail === "string" && me.userEmail.length > 0, "no userEmail");
    return me.userEmail;
  });

  await check("cursor_list_models", async () => {
    const models = await call(client, "cursor_list_models");
    const count = Array.isArray(models.models) ? models.models.length : 0;
    assert(count > 0, "no models returned");
    return `${count} models`;
  });

  await check("cursor_list_repos", async () => {
    const payload = await call(client, "cursor_list_repos");
    assert(Array.isArray(payload.repos), "repos is not an array");
    return `${payload.repos.length} repos`;
  });

  console.log("\nagents and runs");

  let agent;
  await check("cursor_list_agents", async () => {
    // The active profile filters by repository after Cursor pages the global
    // account list. Use a full page so unrelated agents at the front do not
    // make an allowed repository look empty.
    const list = await call(client, "cursor_list_agents", {
      limit: 100,
      includeArchived: false,
    });
    const agents = list.agents ?? [];
    assert(agents.length > 0, "no agents returned");
    agent = agents[0];
    // The tool deliberately trims each item to these fields for the response
    // budget, so this checks the tool's contract. Whether the *API* still
    // returns full objects -- the reason there is no N+1 -- cannot be seen from
    // out here, because the tool would hide the difference either way.
    assert(typeof agent.id === "string", "list item has no id");
    assert(typeof agent.status === "string", "list item has no status");
    return `${agents.length} agents, first=${agent.id}`;
  });

  await check("includeArchived:false excludes archived agents", async () => {
    // Comparing list lengths proves nothing when both sides just hit the
    // limit. Checking the statuses is the actual invariant.
    const active = await call(client, "cursor_list_agents", {
      limit: 100,
      includeArchived: false,
    });
    const agents = active.agents ?? [];
    assert(agents.length > 0, "no un-archived agents returned");
    const archived = agents.filter((a) => a.status === "ARCHIVED");
    assert(archived.length === 0, `${archived.length} archived agents leaked through`);
    return `${agents.length} agents, none archived`;
  });

  await check("cursor_get_agent agrees with the listing", async () => {
    const one = await call(client, "cursor_get_agent", { agentId: agent.id });
    assert(one.id === agent.id, `asked for ${agent.id}, got ${one.id}`);
    // Agent status is an open string (observed ACTIVE, IDLE, ARCHIVED) and
    // never reflects run execution. Agreement with the fresh list is the
    // invariant; pinning the observed enum would make this live check stale.
    assert(one.status === agent.status, `list said ${agent.status}, get said ${one.status}`);
    return one.status;
  });

  let run;
  await check("cursor_list_runs", async () => {
    const runs = await call(client, "cursor_list_runs", { agentId: agent.id, limit: 5 });
    const items = runs.runs ?? [];
    assert(items.length > 0, "agent has no runs");
    run = items[0];
    return `${items.length} runs, first=${run.id}`;
  });

  await check("cursor_get_run carries the execution state", async () => {
    const one = await call(client, "cursor_get_run", {
      agentId: agent.id,
      runId: run.id,
    });
    assert(typeof one.status === "string", "run has no status");
    assert(typeof one.terminal === "boolean", "run has no terminal flag");
    return `${one.status}${one.terminal ? " (terminal)" : ""}`;
  });

  await check("cursor_get_usage never defaults cost to zero", async () => {
    const usage = await call(client, "cursor_get_usage", { agentId: agent.id });
    assert(typeof usage.totalTokens === "number", "no totalTokens");
    // chargedCents is undocumented, so absent is fine and zero is not, unless
    // it genuinely came back as zero.
    const cents = usage.chargedCents;
    assert(
      cents === undefined || typeof cents === "number",
      `chargedCents is ${typeof cents}`,
    );
    return `${usage.totalTokens} tokens, charged=${cents ?? "absent"}`;
  });

  await check("cursor_list_artifacts", async () => {
    const artifacts = await call(client, "cursor_list_artifacts", {
      agentId: agent.id,
    });
    const items = artifacts.artifacts ?? [];
    return items.length === 0 ? "none (expected)" : `${items.length} artifacts`;
  });

  console.log("\nrefusals");

  await check("refuses a repo outside the policy", async () => {
    const result = await client.callTool({
      name: "cursor_create_agent",
      arguments: { repo: "someone-else/private-thing", prompt: "should never run" },
    });
    assert(result.isError === true, "an unapproved repo was not refused");
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    assert(text.includes("Refused by policy"), `unexpected refusal text: ${text}`);
  });

  await check("surfaces a 404 as a fenced error, not a crash", async () => {
    const result = await client.callTool({
      name: "cursor_get_agent",
      arguments: { agentId: "bc-00000000-0000-0000-0000-000000000000" },
    });
    assert(result.isError === true, "a missing agent did not error");
    const text = (result.content ?? []).map((c) => c.text ?? "").join("\n");
    assert(text.includes("CURSOR_UNTRUSTED"), "error text was not fenced");
  });

  if (process.argv.includes("--write")) await writeTier(client);

  await client.close();

  const total = passed + failures.length;
  console.log(`\n${passed}/${total} checks passed`);
  if (failures.length > 0) {
    console.log(`failed: ${failures.join(", ")}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(`\nsmoke run did not finish: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});
