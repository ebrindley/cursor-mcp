/**
 * Artifact listing and download URLs.
 *
 * The thing worth asserting is that the artifact path travels as a query
 * parameter, opaquely: it contains slashes, so putting it in the URL path would
 * let a listed path address a different route.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { CursorClient } from "../src/client.js";
import { AgentScope } from "../src/agent-scope.js";
import { activeProfile } from "../src/config.js";
import type { Policy } from "../src/config.js";
import { registerArtifactTools } from "../src/tools/artifacts.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const policy = (tools: string[]): Policy => ({
  deleteEnabled: false,
  activationEnabled: false,
  defaultProfile: "p",
  maxResponseBytes: 32_768,
  profiles: {
    p: { repos: [], tools },
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
  registerArtifactTools(
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

const text = (result: unknown) => {
  if (typeof result !== "object" || result === null || !("content" in result)) {
    throw new Error("tool result has no content");
  }
  return (result.content as Array<{ text: string }>)[0]!.text;
};

let fetchImpl: ReturnType<typeof vi.fn<typeof fetch>>;
beforeEach(() => {
  fetchImpl = vi.fn<typeof fetch>();
});

describe("cursor_list_artifacts", () => {
  it("reports each artifact, and stays quiet about a workspace with none", async () => {
    fetchImpl.mockResolvedValue(
      json({
        items: [
          { path: "artifacts/diff.patch", sizeBytes: 1024, updatedAt: "t" },
          { path: "artifacts/notes.md" },
        ],
      }),
    );
    const client = await connect(fetchImpl, policy(["read:*"]));
    const result = await client.callTool({
      name: "cursor_list_artifacts",
      arguments: { agentId: "bc-1" },
    });

    expect(result.structuredContent).toEqual({
      artifacts: [
        { path: "artifacts/diff.patch", sizeBytes: 1024, updatedAt: "t" },
        { path: "artifacts/notes.md" },
      ],
    });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://api.example.test/v1/agents/bc-1/artifacts",
    );

    fetchImpl.mockResolvedValue(json({ items: [] }));
    const empty = await client.callTool({
      name: "cursor_list_artifacts",
      arguments: { agentId: "bc-1" },
    });
    expect(text(empty)).toContain("(no artifacts)");
  });
});

describe("cursor_get_artifact_url", () => {
  it("refuses artifacts for an agent outside the active profile", async () => {
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
    const client = await connect(fetchImpl, {
      ...policy(["read:*"]),
      profiles: { p: { repos: ["ExampleOrg/ExampleRepo"], tools: ["read:*"] } },
    }, true);
    const result = await client.callTool({
      name: "cursor_get_artifact_url",
      arguments: { agentId: "bc-1", path: "artifacts/shot.png" },
    });
    expect(result.isError).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends the path as a query parameter, not as part of the route", async () => {
    fetchImpl.mockResolvedValue(
      json({ url: "https://s3.example/obj?sig=abc", expiresAt: "t" }),
    );
    const client = await connect(fetchImpl, policy(["read:*"]));
    const result = await client.callTool({
      name: "cursor_get_artifact_url",
      arguments: { agentId: "bc-1", path: "artifacts/shot.png" },
    });

    expect(result.structuredContent).toEqual({
      url: "https://s3.example/obj?sig=abc",
      expiresAt: "t",
    });
    // The slash in the artifact path is encoded into the query, so the route is
    // still `/artifacts/download` and nothing else.
    expect(String(fetchImpl.mock.calls[0]![0])).toBe(
      "https://api.example.test/v1/agents/bc-1/artifacts/download" +
        "?path=artifacts%2Fshot.png",
    );
  });

  it("says when the expiry is missing rather than implying the URL is durable", async () => {
    fetchImpl.mockResolvedValue(json({ url: "https://s3.example/obj" }));
    const client = await connect(fetchImpl, policy(["read:*"]));
    const result = await client.callTool({
      name: "cursor_get_artifact_url",
      arguments: { agentId: "bc-1", path: "artifacts/shot.png" },
    });
    expect(result.structuredContent).toEqual({ url: "https://s3.example/obj" });
    expect(text(result)).toContain("15 minutes");
  });

  it("surfaces the API's own rejection of a path outside artifacts/", async () => {
    // Whether a path escapes `artifacts/` is the API's rule, and it enforces it.
    // Duplicating the check here would only add a second, drifting definition.
    fetchImpl.mockResolvedValue(
      json({ error: { code: "invalid_path", message: "must be under artifacts/" } }, 400),
    );
    const client = await connect(fetchImpl, policy(["read:*"]));
    const result = await client.callTool({
      name: "cursor_get_artifact_url",
      arguments: { agentId: "bc-1", path: "../../etc/passwd" },
    });
    expect(result.isError).toBe(true);
    expect(text(result)).toContain("invalid_path");
    // It went out as a query value, so the route was never rewritten.
    expect(String(fetchImpl.mock.calls[0]![0])).toContain(
      "/v1/agents/bc-1/artifacts/download?path=..%2F..%2Fetc%2Fpasswd",
    );
  });
});
