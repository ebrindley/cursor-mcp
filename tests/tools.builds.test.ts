import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { CursorClient } from "../src/client.js";
import type { Policy } from "../src/config.js";
import { registerBuildReadTools } from "../src/tools/builds.js";

const environment = { id: "env-alpha", name: "alpha", owner: "personal", repos: [{ url: "https://github.com/acme/app" }], createdAt: "2026-10-01", updatedAt: "2026-10-08" };
const policy: Policy = { deleteEnabled: false, activationEnabled: false, defaultProfile: "p", maxResponseBytes: 32768,
  profiles: { p: { tools: ["read:*"], repos: ["acme/app"], environments: [{ name: "alpha", publicId: "env-alpha", scope: "personal" }] } } };

async function invoke(name: string, args: Record<string, unknown>, responses: Record<string, unknown>, configured = policy, status = 200) {
  const calls: string[] = [];
  const client = new CursorClient({ apiKey: "test", baseUrl: "https://api.example.test", fetchImpl: async (input, init) => {
    expect(init?.method ?? "GET").toBe("GET");
    const url = new URL(String(input)); calls.push(url.pathname + url.search);
    const response = responses[url.pathname];
    const body = typeof response === "function" ? await response(init) : response;
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  } });
  const server = new McpServer({ name: "test", version: "test" });
  registerBuildReadTools(server, client, configured);
  const [a, b] = InMemoryTransport.createLinkedPair();
  const mcp = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(b), mcp.connect(a)]);
  try { return { result: await mcp.callTool({ name, arguments: args }), calls }; }
  finally { await mcp.close(); await server.close(); }
}


const build = { id: "bld-1", environmentId: "env-alpha", status: "SUCCEEDED", trigger: "MANUAL", draft: true, createdAt: "yesterday", updatedAt: "now" };
const base = { "/v1/environments/env-alpha": environment };
describe("public Build reads", () => {
  it("preserves millisecond timestamps and failure fields used by health and lifecycle consumers", async () => {
    const before = Date.now();
    const { result } = await invoke("cursor_get_build", { environmentPublicId: "env-alpha", buildId: "bld-1" }, {
      ...base, "/v1/environments/env-alpha/builds/bld-1": { ...build, status: "FAILED",
        createdAt: "2026-10-08T10:00:00Z", completedAt: "2026-10-08T10:01:00Z", failure: { type: "INSTALL_FAILED", code: "install_exit" } },
    });
    const row = (result.structuredContent as { build: Record<string, unknown> }).build;
    expect(row).toMatchObject({ environmentPublicIdSource: "row", createdAtMs: Date.parse("2026-10-08T10:00:00Z"),
      completedAtMs: Date.parse("2026-10-08T10:01:00Z"), durationMs: 60_000, failureType: "INSTALL_FAILED" });
    expect(row.observedAtMs).toBeGreaterThanOrEqual(before);
    expect(row.observedAtMs).toBeLessThanOrEqual(Date.now());
  });
  it("returns the last Build when monitoring reaches its deadline during a request", async () => {
    let reads = 0;
    vi.useFakeTimers();
    try {
      const pending = invoke("cursor_get_build", { environmentPublicId: "env-alpha", buildId: "bld-1", monitorAttempts: 10 }, {
        ...base, "/v1/environments/env-alpha/builds/bld-1": (init: RequestInit) => {
          if (++reads === 1) return { ...build, status: "IN_PROGRESS" };
          return new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
        },
      });
      await vi.waitFor(() => expect(reads).toBe(1));
      await vi.advanceTimersByTimeAsync(45_000);
      const { result } = await pending;
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "PENDING", build: { status: "IN_PROGRESS" }, monitor: { attempts: 1, deadlineExceeded: true } });
    } finally { vi.useRealTimers(); }
  });
  it("reads filtered Build pages and preserves continuation", async () => {
    const { result, calls } = await invoke("cursor_list_builds", { environment: "alpha", statuses: ["FAILED"], cursor: "page2" }, {
      ...base, "/v1/environments/env-alpha/builds": { items: [build], nextCursor: "page3" },
    });
    expect(calls).toEqual(["/v1/environments/env-alpha", "/v1/environments/env-alpha/builds?cursor=page2"]);
    expect(result.structuredContent).toMatchObject({ builds: [], nextCursor: "page3", page: { hasMore: true } });
  });
  it("returns an exact Build with its outcome without inferring activation", async () => {
    const { result, calls } = await invoke("cursor_get_build", { environmentPublicId: "env-alpha", buildId: "bld-1" }, {
      ...base, "/v1/environments/env-alpha/builds/bld-1": build,
    });
    expect(calls).toHaveLength(2);
    expect(result.structuredContent).toMatchObject({ status: "TERMINAL", authority: "api-key",
      build: { buildId: "bld-1", isDraft: true, outcome: "succeeded", terminal: true }, monitor: { attempts: 1 } });
    expect(JSON.stringify(result.structuredContent)).not.toContain('"active":true');
  });
  it("reports a terminal-status regression as stale", async () => {
    const { result } = await invoke("cursor_get_build", { environment: "alpha", buildId: "bld-1", previousStatus: "SUCCEEDED" }, {
      ...base, "/v1/environments/env-alpha/builds/bld-1": { ...build, status: "IN_PROGRESS" },
    });
    expect(result.structuredContent).toMatchObject({ status: "READBACK_STALE" });
  });
  it.each([{ type: "build", buildId: "bld-1" }, { type: "universal_image" }])("reports active Build selection %j", async active => {
    const { result } = await invoke("cursor_get_active_build", { environmentPublicId: "env-alpha" },
      { ...base, "/v1/environments/env-alpha/builds/active": active });
    expect(result.structuredContent).toMatchObject({ activeBuild: { readable: true, ...active } });
  });
  it.each([{ ...build, id: "bld-other" }, { ...build, environmentId: "env-other" }])("rejects mismatched Build identity", async row => {
    const { result } = await invoke("cursor_get_build", { environmentPublicId: "env-alpha", buildId: "bld-1" },
      { ...base, "/v1/environments/env-alpha/builds/bld-1": row });
    expect(result.isError).toBe(true);
  });
  it("rejects a Build page containing another environment", async () => {
    const { result } = await invoke("cursor_list_builds", { environmentPublicId: "env-alpha" },
      { ...base, "/v1/environments/env-alpha/builds": { items: [{ ...build, environmentId: "env-other" }] } });
    expect(result.isError).toBe(true);
  });
  it("enforces repository scope before reading Builds", async () => {
    const { result, calls } = await invoke("cursor_list_builds", { environmentPublicId: "env-alpha" },
      { "/v1/environments/env-alpha": { ...environment, repos: [{ url: "https://github.com/other/repo" }] } });
    expect(result.isError).toBe(true); expect(calls).toHaveLength(1);
  });
  it("resolves unpinned names and refuses ambiguity", async () => {
    const unpinned = { ...policy, profiles: { p: { ...policy.profiles.p!, environments: ["alpha"] } } };
    const good = await invoke("cursor_get_active_build", { environment: "alpha" }, {
      ...base, "/v1/environments": { items: [environment] }, "/v1/environments/env-alpha/builds/active": { type: "universal_image" },
    }, unpinned);
    expect(good.result.isError).not.toBe(true);
    const ambiguous = await invoke("cursor_get_active_build", { environment: "alpha" },
      { "/v1/environments": { items: [environment, { ...environment, id: "second" }] } }, unpinned);
    expect(ambiguous.result.isError).toBe(true); expect(ambiguous.calls).toHaveLength(1);
  });
});
