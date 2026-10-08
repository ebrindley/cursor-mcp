import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { CursorClient } from "../src/client.js";
import type { Policy } from "../src/config.js";
import { registerEnvironmentCatalogTools } from "../src/tools/environment-catalog.js";

const environment = { id: "env-alpha", name: "alpha", owner: "personal", repos: [{ url: "https://github.com/acme/app" }], createdAt: "2026-10-01", updatedAt: "2026-10-08" };
const policy: Policy = { deleteEnabled: false, activationEnabled: false, defaultProfile: "p", maxResponseBytes: 32768,
  profiles: { p: { tools: ["read:*"], repos: ["acme/app"], environments: [{ name: "alpha", publicId: "env-alpha", scope: "personal" }] } } };

async function invoke(name: string, args: Record<string, unknown>, responses: Record<string, unknown>, configured = policy, status = 200) {
  const calls: string[] = [];
  const client = new CursorClient({ apiKey: "test", baseUrl: "https://api.example.test", fetchImpl: async (input, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    return new Response(JSON.stringify(responses[url.pathname]), { status, headers: { "content-type": "application/json" } });
  } });
  const server = new McpServer({ name: "test", version: "test" });
  registerEnvironmentCatalogTools(server, client, configured);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(b), mcp.connect(a)]);
  try { return { result: await mcp.callTool({ name, arguments: args }), calls }; }
  finally { await mcp.close(); await server.close(); }
}

describe("public environment reads", () => {
  it("registers only permitted reads", () => {
    const server = new McpServer({ name: "test", version: "test" });
    const client = new CursorClient({ apiKey: "test" });
    expect(registerEnvironmentCatalogTools(server, client, { ...policy, profiles: { p: { repos: [], tools: [] } } })).toEqual([]);
    expect(registerEnvironmentCatalogTools(server, client, policy)).toEqual(["cursor_list_environments", "cursor_get_environment_configuration", "cursor_list_environment_history"]);
  });
  it("pages and filters saved environments without inferring completeness", async () => {
    const { result, calls } = await invoke("cursor_list_environments", { cursor: "page2", limit: 2, scope: "personal" },
      { "/v1/environments": { items: [environment, { ...environment, id: "team-env", owner: "team" }], nextCursor: "page3" } });
    expect(calls).toEqual(["/v1/environments?limit=2&cursor=page2"]);
    expect(result.structuredContent).toMatchObject({ authority: "api-key", nextCursor: "page3",
      environments: [{ environmentPublicId: "env-alpha", inProfile: true }], catalog: { complete: false, reported: 2, returned: 1 } });
  });
  it("returns empty pages with their continuation", async () => {
    const { result } = await invoke("cursor_list_environments", {}, { "/v1/environments": { items: [], nextCursor: "more" } });
    expect(result.structuredContent).toMatchObject({ environments: [], nextCursor: "more", catalog: { complete: false } });
  });
  it("marks out-of-profile records without exposing configuration", async () => {
    const { result } = await invoke("cursor_list_environments", {}, { "/v1/environments": { items: [{ ...environment, id: "other", environmentJson: "private-script" }] } });
    expect(result.structuredContent).toMatchObject({ environments: [{ inProfile: false }] });
    expect(JSON.stringify(result)).not.toContain("private-script");
  });
  it("returns configuration digests and version without script contents", async () => {
    const { result } = await invoke("cursor_get_environment_configuration", { environmentPublicId: "env-alpha" },
      { "/v1/environments/env-alpha": { ...environment, versionId: "v1", environmentJson: '{"install":"private-script"}' } });
    expect(result.structuredContent).toMatchObject({ status: "READ", versionId: "v1", configuration: { classification: "matched", candidates: [{ source: "database", readable: true }] } });
    expect(JSON.stringify(result)).not.toContain("private-script");
  });
  it("preserves missing and invalid configuration as unreadable", async () => {
    for (const data of [environment, { ...environment, environmentJson: "invalid" }]) {
      const { result } = await invoke("cursor_get_environment_configuration", { environmentPublicId: "env-alpha" }, { "/v1/environments/env-alpha": data });
      expect(result.structuredContent).toMatchObject({ configuration: { classification: "unreadable" } });
    }
  });
  it("uses repository-file provenance when supplied", async () => {
    const { result } = await invoke("cursor_get_environment_configuration", { environmentPublicId: "env-alpha" },
      { "/v1/environments/env-alpha": { ...environment, repoFile: { url: environment.repos[0]!.url, path: ".cursor/environment.json" }, environmentJson: "{}" } });
    expect(result.structuredContent).toMatchObject({ configuration: { candidates: [{ source: "repository-file", path: ".cursor/environment.json" }] } });
  });
  it.each([
    { ...environment, id: "different" }, { ...environment, name: "different" },
    { ...environment, owner: "team" }, { ...environment, repos: [{ url: "https://github.com/other/private" }] },
  ])("refuses identity or scope mismatch before history reads", async data => {
    const { result, calls } = await invoke("cursor_list_environment_history", { environmentPublicId: "env-alpha" }, { "/v1/environments/env-alpha": data });
    expect(result.isError).toBe(true);
    expect(calls).toEqual(["/v1/environments/env-alpha"]);
  });
  it("supports unnamed environments through an existing pinned grant", async () => {
    const { name: _, ...unnamed } = environment;
    const { result } = await invoke("cursor_get_environment_configuration", { environmentPublicId: "env-alpha" }, { "/v1/environments/env-alpha": unnamed });
    expect(result.isError).not.toBe(true);
  });
  it("pages history and replaces embedded configurations with digests", async () => {
    const { result, calls } = await invoke("cursor_list_environment_history", { environmentPublicId: "env-alpha", cursor: "next" }, {
      "/v1/environments/env-alpha": environment,
      "/v1/environments/env-alpha/history": { items: [{ id: "event1", createdAt: "now", kind: "updated", title: "Updated", description: "Configuration changed", current: true, environmentJson: '{"install":"private-script"}' }], nextCursor: "last" },
    });
    expect(calls).toHaveLength(2);
    expect(result.structuredContent).toMatchObject({ nextCursor: "last", events: [{ configuration: { classification: "matched" } }] });
    expect(JSON.stringify(result)).not.toContain("private-script");
  });
  it("reports account gating without a fallback run", async () => {
    const { result, calls } = await invoke("cursor_list_environments", {}, { "/v1/environments": { error: { code: "feature_unavailable", message: "Unavailable" } } }, policy, 403);
    expect(result.isError).toBe(true); expect(calls).toHaveLength(1);
  });
});
