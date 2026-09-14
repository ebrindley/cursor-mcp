// An offline walkthrough: real MCP handlers, simulated Cursor HTTP responses.
// No environment credentials, server config, or network transport are used.
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { AgentScope } from "../dist/agent-scope.js";
import { CursorClient } from "../dist/client.js";
import { activeProfile, loadPolicy } from "../dist/config.js";
import { registerAgentTools } from "../dist/tools/agents.js";

const policy = await loadPolicy(
  fileURLToPath(new URL("../policy.quickstart.json", import.meta.url)), true,
);
const repo = "ExampleOrg/ExampleRepo";
const agentId = "bc-00000000-0000-4000-8000-000000000001";
const firstRun = "run-1";
const followUpRun = "run-2";
const agent = {
  id: agentId, status: "IDLE", createdAt: "2026-01-01T00:00:00Z",
  updatedAt: "2026-01-01T00:00:00Z",
  url: `https://cursor.com/agents/${agentId}`,
  repos: [{ url: `https://github.com/${repo}`, startingRef: "main" }],
  autoCreatePR: true,
};
const run = (id, status) => ({
  id, agentId, status, createdAt: agent.createdAt, updatedAt: agent.updatedAt,
});
let requests = 0;
const cursor = new CursorClient({
  apiKey: "offline-demo-not-a-credential",
  baseUrl: "https://cursor-demo.invalid",
  fetchImpl: async (input, init) => {
    requests += 1;
    const path = new URL(String(input)).pathname;
    const route = `${init?.method ?? "GET"} ${path}`;
    let body;
    if (route === "POST /v1/agents") {
      const sent = JSON.parse(init.body);
      assert.equal(sent.agentId, agentId);
      assert.equal(sent.repos[0].url, agent.repos[0].url);
      assert.equal(sent.autoCreatePR, true);
      body = { agent, run: run(firstRun, "CREATING") };
    } else if (route === `GET /v1/agents/${agentId}`) {
      body = agent;
    } else if (route === `GET /v1/agents/${agentId}/runs/${firstRun}`) {
      body = {
        ...run(firstRun, "FINISHED"),
        result: "Fixed empty search handling and added a regression test. Review the PR before merging.",
        git: { branches: [{
          repoUrl: agent.repos[0].url, branch: "cursor/fix-empty-search",
          prUrl: `https://github.com/${repo}/pull/123`,
        }] },
      };
    } else if (route === `POST /v1/agents/${agentId}/runs`) {
      assert.equal(JSON.parse(init.body).prompt.text, "Also cover whitespace-only input.");
      body = { run: run(followUpRun, "CREATING") };
    } else {
      throw new Error(`No offline fixture for ${route}; no network request was made`);
    }
    return new Response(JSON.stringify(body), {
      headers: { "content-type": "application/json" },
    });
  },
});
const server = new McpServer({ name: "cursor-mcp-offline-demo", version: "1" });
const scope = new AgentScope(cursor, activeProfile(policy));
registerAgentTools(server, cursor, policy, scope);
const client = new Client({ name: "offline-demo", version: "1" });
const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  assert.ok(!result.isError, `${name}: ${JSON.stringify(result.content)}`);
  return result;
}

try {
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  console.log("OFFLINE DEMO: real MCP tools; simulated Cursor responses and PR link. No API key or network.");
  const listed = await client.listTools();
  assert.ok(!listed.tools.some((tool) => tool.name === "cursor_delete_agent"));
  console.log("Policy: one repository; launch/follow-up/cancel enabled; deletion unavailable.");

  const launched = await call("cursor_create_agent", {
    repo, agentId, startingRef: "main", prompt: "Fix the empty-search bug.",
  });
  assert.equal(launched.structuredContent.targetVerified, true);
  assert.equal(launched.structuredContent.sourcePinned, true);
  console.log(`Launch: target verified; agent=${launched.structuredContent.agentId}; run=${launched.structuredContent.runId}`);

  const completed = await call("cursor_get_run", { agentId, runId: firstRun });
  assert.equal(completed.structuredContent.status, "FINISHED");
  assert.equal(completed.structuredContent.branches[0].prUrl, `https://github.com/${repo}/pull/123`);
  console.log("Result (including the real output envelope):");
  console.log(completed.content[0].text);

  const continued = await call("cursor_create_run", {
    agentId, prompt: "Also cover whitespace-only input.",
  });
  assert.equal(continued.structuredContent.runId, followUpRun);
  console.log(`Follow-up: same agent; new run=${continued.structuredContent.runId}`);

  const beforeRefusal = requests;
  const refused = await client.callTool({
    name: "cursor_create_agent",
    arguments: { repo: "OtherOrg/OtherRepo", prompt: "Change this repository too." },
  });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /Refused by policy/);
  assert.equal(requests, beforeRefusal);
  console.log("Scope: OtherOrg/OtherRepo refused before any simulated HTTP request.");

  console.log("Demo complete. No cloud agent or PR was created; use the quickstart for real work.");
} finally {
  await client.close();
  await server.close();
}
