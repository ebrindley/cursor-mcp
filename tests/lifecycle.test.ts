/**
 * Agent Lifecycle record operations: archive, unarchive, delete.
 *
 * The focus is the `deleteEnabled` gate: it is a second gate behind the tool
 * allowlist, and `tools: ["*"]` must not be enough to reach permanent deletion.
 * The three endpoints share one code path, so the happy path is covered once.
 *
 * Environment activate/rollback are not executable tools. `activationEnabled`
 * is reserved; see `docs/lifecycle-architecture.md`.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CursorClient } from "../src/client.js";
import { AgentScope } from "../src/agent-scope.js";
import { activeProfile } from "../src/config.js";
import type { Policy } from "../src/config.js";
import { registerLifecycleTools } from "../src/tools/lifecycle.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const policy = (tools: string[], deleteEnabled = false): Policy => ({
  deleteEnabled,
  activationEnabled: false,
  defaultProfile: "p",
  maxResponseBytes: 32_768,
  profiles: {
    p: {
      repos: ["ExampleOrg/ExampleRepo"],
      tools,
    },
  },
});

async function connect(fetchImpl: typeof fetch, p: Policy, enforceScope = false) {
  const server = new McpServer({ name: "cursor-mcp", version: "test" });
  const cursor = new CursorClient({
    apiKey: "sk-test",
    baseUrl: "https://api.example.test",
    fetchImpl,
    sleepImpl: async () => {},
  });
  registerLifecycleTools(
    server,
    cursor,
    p,
    new AgentScope(cursor, enforceScope ? activeProfile(p) : undefined),
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

const names = async (p: Policy, fetchImpl: typeof fetch) =>
  (await (await connect(fetchImpl, p)).listTools()).tools.map((t) => t.name).sort();

let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchImpl = vi.fn<typeof fetch>();
});

describe("the delete gate", () => {
  it("withholds delete under tools:* while deleteEnabled is off", async () => {
    // The whole point: an operator writing ["*"] is saying "I trust this server",
    // not "irreversibly delete my agents". Deletion needs its own switch.
    expect(await names(policy(["*"]), fetchImpl)).toEqual([
      "cursor_archive_agent",
      "cursor_unarchive_agent",
    ]);
  });

  it("registers delete once deleteEnabled is on", async () => {
    expect(await names(policy(["*"], true), fetchImpl)).toEqual([
      "cursor_archive_agent",
      "cursor_delete_agent",
      "cursor_unarchive_agent",
    ]);
  });

  it("still withholds delete when deleteEnabled is on but the tool is not listed", async () => {
    expect(await names(policy(["cursor_archive_agent"], true), fetchImpl)).toEqual([
      "cursor_archive_agent",
    ]);
  });

  it("withholds all three from a read-only profile", () => {
    // Asserted on the return value, not over the wire: with nothing registered
    // the SDK never installs a tools/list handler and the call would fail with
    // "Method not found" instead of an empty list. `server.ts` covers that case
    // for the process as a whole by refusing to start.
    const server = new McpServer({ name: "cursor-mcp", version: "test" });
    const client = new CursorClient({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test",
      fetchImpl,
    });
    expect(registerLifecycleTools(server, client, policy(["read:*"], true))).toEqual(
      [],
    );
  });

  it("annotates delete destructive and archive not", async () => {
    const client = await connect(fetchImpl, policy(["*"], true));
    const { tools } = await client.listTools();
    const of = (name: string) => tools.find((t) => t.name === name)?.annotations;
    expect(of("cursor_delete_agent")?.destructiveHint).toBe(true);
    // Archive is reversible, and documented idempotent, so a client may repeat it
    // on its own initiative without asking.
    expect(of("cursor_archive_agent")?.destructiveHint).toBe(false);
    expect(of("cursor_archive_agent")?.idempotentHint).toBe(true);
  });
});

describe("archive and unarchive", () => {
  // Both routes are asserted, not just one. They share a code path, so the only
  // thing that can differ between them is the route string itself, and a typo
  // there is exactly what a shared-path test would otherwise miss.
  it.each([
    ["cursor_archive_agent", "archive"],
    ["cursor_unarchive_agent", "unarchive"],
  ])("%s posts to /%s and reports the id", async (name, route) => {
    fetchImpl.mockResolvedValue(json({ id: "bc-1" }));
    const client = await connect(fetchImpl, policy(["*"]));
    const result = await client.callTool({ name, arguments: { agentId: "bc-1" } });

    expect(result.structuredContent).toEqual({ agentId: "bc-1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.example.test/v1/agents/bc-1/${route}`);
    expect((init as RequestInit).method).toBe("POST");
  });

  it("encodes an agent id rather than letting it change the route", async () => {
    fetchImpl.mockResolvedValue(
      json({ error: { code: "agent_not_found" } }, 404),
    );
    const client = await connect(fetchImpl, policy(["*"]));
    const result = await client.callTool({
      name: "cursor_archive_agent",
      arguments: { agentId: "../../v0/agents/bc-1" },
    });

    // The traversal stays inside one path segment as `%2F`, so it addresses an
    // agent id that does not exist rather than reaching /v0. A 404 is the right
    // answer here; a 200 from another API version would not be.
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://api.example.test/v1/agents/..%2F..%2Fv0%2Fagents%2Fbc-1/archive",
    );
    expect(result.isError).toBe(true);
  });
});

describe("delete", () => {
  it("refuses deletion without confirm: true, before any request", async () => {
    const client = await connect(fetchImpl, policy(["*"], true), true);
    const result = await client.callTool({
      name: "cursor_delete_agent",
      arguments: { agentId: "bc-1" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("confirm: true");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("refuses deletion for an agent outside the active profile", async () => {
    fetchImpl.mockResolvedValue(
      json({
        id: "bc-1",
        status: "ACTIVE",
        url: "https://cursor.com/agents/bc-1",
        createdAt: "t",
        updatedAt: "t",
        repos: [{ url: "https://github.com/someone/else" }],
      }),
    );
    const client = await connect(fetchImpl, policy(["*"], true), true);
    const result = await client.callTool({
      name: "cursor_delete_agent",
      arguments: { agentId: "bc-1", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends DELETE to the agent route", async () => {
    fetchImpl.mockResolvedValue(json({ id: "bc-1" }));
    const client = await connect(fetchImpl, policy(["*"], true));
    const result = await client.callTool({
      name: "cursor_delete_agent",
      arguments: { agentId: "bc-1", confirm: true },
    });

    expect(result.structuredContent).toEqual({ agentId: "bc-1" });
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.test/v1/agents/bc-1");
    expect((init as RequestInit).method).toBe("DELETE");
  });

  it("is not retried, since the server may already have acted", async () => {
    fetchImpl.mockResolvedValue(json({ error: { code: "oops" } }, 500));
    const client = await connect(fetchImpl, policy(["*"], true));
    const result = await client.callTool({
      name: "cursor_delete_agent",
      arguments: { agentId: "bc-1", confirm: true },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
