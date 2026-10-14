/**
 * Workspace/account capability catalog, entitlement, redaction, and residuals.
 *
 * These pin the fail-closed rules: secret values never leave the projection,
 * unsupported writes never look like success, and plan-gated reads stay distinct
 * from unverified and unsupported.
 */

import { describe, expect, it } from "vitest";
import { CursorClient } from "../src/client.js";
import { READ_ONLY_POLICY } from "../src/config.js";
import { MIN_PAGE_BUDGET_MS, SecretInventoryTooLargeError, bytesFit, readSecretInventory } from "../src/secret-inventory.js";
import { fail } from "../src/tools/result.js";
import {
  WORKSPACE_CONTROLS,
  WORKSPACE_GET_TOOL,
  WORKSPACE_LIST_TOOL,
  WorkspaceCapabilityError,
  capabilityResult,
  isPlanGatedCode,
  listWorkspaceControls,
  planGatedResult,
  projectEntitlement,
  redactSecretFields,
  secretInventoryRefusal,
  supportedIdentityResult,
  workspaceAction,
  workspaceControlSurface,
} from "../src/workspace-controls.js";

describe("capability filtering", () => {
  it("lists identity, models, repositories, and secret names as the only supported reads", () => {
    const supported = listWorkspaceControls({ status: "supported", kind: "read" });
    expect(supported.map((surface) => surface.id)).toEqual([
      "identity",
      "models",
      "repositories",
      "secrets",
    ]);
    for (const surface of supported) {
      expect(surface.read.status).toBe("supported");
      expect(surface.read.authority).toBe("api-key");
      // Secrets keeps a write row, and it stays unsupported.
      if (surface.id === "secrets") expect(surface.write?.status).toBe("unsupported");
      else expect(surface.write).toBeUndefined();
    }
  });

  it("lists unverified reads separately from unsupported writes", () => {
    const unverified = listWorkspaceControls({ status: "unverified", kind: "read" });
    expect(unverified.map((surface) => surface.id)).toEqual([
      "default-model",
      "default-repository",
      "base-branch",
      "pr-behavior",
      "network-policy",
      "mcp-policy",
      "team-follow-up",
    ]);
    const unsupported = listWorkspaceControls({
      status: "unsupported",
      kind: "write",
    });
    expect(unsupported.every((surface) => surface.write?.status === "unsupported")).toBe(
      true,
    );
    expect(unsupported.map((surface) => surface.id)).not.toContain("team-follow-up");
    expect(unsupported.map((surface) => surface.id)).not.toContain("identity");
  });

  it("does not catalog Slack, Origin, billing, or self-hosted fleet controls", () => {
    const ids = WORKSPACE_CONTROLS.map((surface) => surface.id).join(" ");
    expect(ids).not.toMatch(/slack|origin|billing|self-hosted|fleet|notification/i);
  });

  it("keeps generic get/set tool names stable across unsupported controls", () => {
    const network = workspaceControlSurface("network-policy");
    expect(network.read.tool).toBe(WORKSPACE_GET_TOOL);
    // No verb performs the write; the catalog row is where it stays addressable.
    expect(network.write?.tool).toBe(WORKSPACE_LIST_TOOL);
    expect(workspaceAction("read", "network-policy")).toBe("GET_NETWORK_POLICY");
    expect(workspaceAction("write", "secrets")).toBe("SET_SECRETS");
  });

  it("does not mark any catalog entry unavailable-on-plan without a live code", () => {
    expect(listWorkspaceControls({ status: "unavailable-on-plan" })).toEqual([]);
  });
});

describe("entitlement", () => {
  it("treats a key with owner fields as a user key", () => {
    expect(
      projectEntitlement({
        apiKeyName: "laptop",
        createdAt: "2026-08-01T00:00:00Z",
        userEmail: "ed@example.com",
        userId: 42,
      }),
    ).toEqual({
      kind: "user",
      apiKeyName: "laptop",
      createdAt: "2026-08-01T00:00:00Z",
      userEmail: "ed@example.com",
      userId: 42,
    });
  });

  it("treats omitted owner fields as a service-account key, not as missing identity", () => {
    expect(
      projectEntitlement({
        apiKeyName: "ci",
        createdAt: "2026-08-01T00:00:00Z",
      }),
    ).toEqual({
      kind: "service-account",
      apiKeyName: "ci",
      createdAt: "2026-08-01T00:00:00Z",
    });
  });

  it("projects a supported identity readback from GET /v1/me", () => {
    const result = supportedIdentityResult({
      apiKeyName: "laptop",
      createdAt: "2026-08-01T00:00:00Z",
      userEmail: "ed@example.com",
    });
    expect(result.status).toBe("supported");
    expect(result.control).toBe("identity");
    expect(result.entitlement?.kind).toBe("user");
    expect(result.entitlement?.userEmail).toBe("ed@example.com");
  });
});

describe("plan entitlement", () => {
  it("classifies documented plan and role codes, and nothing else", () => {
    expect(isPlanGatedCode("plan_required")).toBe(true);
    expect(isPlanGatedCode("feature_unavailable")).toBe(true);
    expect(isPlanGatedCode("role_forbidden")).toBe(true);
    expect(isPlanGatedCode("unauthorized")).toBe(false);
    expect(isPlanGatedCode(undefined)).toBe(false);
  });

  it("reports unavailable-on-plan distinctly from unverified", () => {
    const residual = planGatedResult(
      workspaceControlSurface("models").read,
      "feature_unavailable",
    );
    expect(residual.status).toBe("unavailable-on-plan");
    expect(residual.status).not.toBe("unverified");
    expect(residual.status).not.toBe("unsupported");
    expect(residual.reason).toContain("feature_unavailable");
  });
});

describe("redaction", () => {
  it("drops secret-bearing keys rather than masking them", () => {
    const redacted = redactSecretFields({
      name: "NPM_TOKEN",
      class: "runtime",
      value: "npm_live_secret",
      token: "abc",
      headers: { Authorization: "Bearer abc" },
      nested: { client_secret: "s3cret", env: { TOKEN: "s3cret" }, serverUrl: "https://mcp.example" },
    }) as Record<string, unknown>;
    expect(redacted).toEqual({
      name: "NPM_TOKEN",
      class: "runtime",
      nested: { serverUrl: "https://mcp.example" },
    });
    expect(JSON.stringify(redacted)).not.toContain("npm_live_secret");
    expect(JSON.stringify(redacted)).not.toContain("s3cret");
    expect(JSON.stringify(redacted)).not.toContain("Bearer");
  });

});

describe("unsupported writes", () => {
  it("never reports a write as supported", () => {
    for (const surface of WORKSPACE_CONTROLS) {
      if (surface.write !== undefined) {
        expect(surface.write.status).toBe("unsupported");
        expect(surface.write.kind).toBe("write");
      }
    }
  });

  it("surfaces a write residual as a structured tool failure", () => {
    const write = workspaceControlSurface("secrets").write;
    expect(write).toBeDefined();
    if (write === undefined) return;
    const residual = capabilityResult(write);
    const result = fail(new WorkspaceCapabilityError(residual), READ_ONLY_POLICY);
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "unsupported",
      action: "SET_SECRETS",
      control: "secrets",
    });
    expect(result.structuredContent).not.toHaveProperty("value");
    expect(result.structuredContent).not.toHaveProperty("token");
    expect(result.structuredContent).not.toHaveProperty("password");
    const text = (result.content as Array<{ text: string }>)[0]!.text;
    expect(text).toContain("SET_SECRETS");
    expect(text).not.toContain("CURSOR_UNTRUSTED");
  });
});

describe("secrets row", () => {
  it("is a documented api-key read and an unsupported write that says why", () => {
    const secrets = workspaceControlSurface("secrets");
    expect(secrets.read).toMatchObject({ status: "supported", authority: "api-key", evidence: "documented" });
    expect(secrets.write).toMatchObject({ status: "unsupported", kind: "write" });
    expect(secrets.write?.reason).toContain("publishes secret writes");
    expect(secrets.write?.reason).toContain("never performs them");
    expect(secrets.write?.reason).toContain("never accepts a secret value");
  });

  it("keeps the inventory through redaction while dropping value-like fields", () => {
    const redacted = redactSecretFields({
      inventory: {
        items: [{ name: "NPM_TOKEN", type: "runtime_secret", repos: [], owner: { kind: "team" }, value: "x" }],
      },
      secrets: [{ name: "leak" }],
    });
    expect(redacted).toEqual({
      inventory: {
        items: [{ name: "NPM_TOKEN", type: "runtime_secret", repos: [], owner: { kind: "team" } }],
      },
    });
  });

  it("maps documented refusals to capability results and leaves unknown codes alone", () => {
    const read = workspaceControlSurface("secrets").read;
    expect(secretInventoryRefusal(read, "team", "feature_unavailable")?.status).toBe("unavailable-on-plan");
    expect(secretInventoryRefusal(read, "team", "key_not_supported")?.status).toBe("unsupported");
    expect(secretInventoryRefusal(read, "account", "user_required")?.reason).toContain("Personal secrets");
    expect(secretInventoryRefusal(read, "team", "something_else")).toBeUndefined();
    expect(secretInventoryRefusal(read, "team", undefined)).toBeUndefined();
  });
});

describe("readSecretInventory", () => {
  const entry = (name: string) => ({
    name,
    type: "runtime_secret",
    repos: [],
    id: "secv_x",
    createdAt: "2026-10-01T00:00:00Z",
    owner: { type: "team" },
  });
  const clientFor = (pages: Array<unknown | Error>) => {
    let call = 0;
    const requested: string[] = [];
    const client = new CursorClient({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test",
      sleepImpl: async () => {},
      fetchImpl: async (input) => {
        requested.push(String(input));
        const page = pages[Math.min(call++, pages.length - 1)];
        if (page instanceof Error) throw page;
        return new Response(JSON.stringify(page), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    return { client, requested };
  };
  const account = { scope: "account" } as const;

  it("stops at a page boundary when the wait budget is nearly spent", async () => {
    const { client, requested } = clientFor([
      { items: [entry("A")], nextCursor: "c1" },
      { items: [entry("B")], nextCursor: null },
    ]);
    const result = await readSecretInventory(client, account, {
      fits: bytesFit(1_000_000),
      remainingMs: () => MIN_PAGE_BUDGET_MS - 1,
    });
    expect(requested).toHaveLength(1);
    expect(result).toMatchObject({ complete: false, stoppedBecause: "time_budget", nextCursor: "c1", pages: 1 });
  });

  it("leaves a page out whole when it would cross the size budget, including the last page", async () => {
    const { client } = clientFor([
      { items: [entry("A"), entry("B")], nextCursor: "c1" },
      { items: [entry("C"), entry("D")], nextCursor: null },
    ]);
    const probe = await readSecretInventory(clientFor([{ items: [entry("A"), entry("B")], nextCursor: null }]).client, account, {
      fits: bytesFit(1_000_000),
    });
    const onePage = JSON.stringify(probe.items).length + 150;
    const result = await readSecretInventory(client, account, { fits: bytesFit(onePage) });
    expect(result).toMatchObject({ complete: false, stoppedBecause: "size_budget", nextCursor: "c1", returned: 2, pages: 1 });
    expect(result.omitted).toBeUndefined();
  });

  it("returns a prefix and counts omissions when the first page alone is over budget", async () => {
    const { client } = clientFor([{ items: [entry("A"), entry("B"), entry("C")], nextCursor: "c1" }]);
    const result = await readSecretInventory(client, account, { fits: bytesFit(250) });
    expect(result.stoppedBecause).toBe("size_budget");
    expect(result.complete).toBe(false);
    expect(result.returned + (result.omitted ?? 0)).toBe(3);
    expect(result.omitted).toBeGreaterThan(0);
    expect(result.nextCursor).toBe("c1");
  });

  it("sizes an oversized first page with a logarithmic number of judgments", async () => {
    const big = Array.from({ length: 2000 }, (_, i) => entry(`NAME_${i}`));
    const budget = 60_000;
    const judge = bytesFit(budget);
    let calls = 0;
    const { client } = clientFor([{ items: big, nextCursor: null }]);
    const result = await readSecretInventory(client, account, {
      fits: (candidate) => {
        calls += 1;
        return judge(candidate);
      },
    });
    expect(calls).toBeLessThanOrEqual(40);
    // The kept prefix is the largest one that fits, and the next one does not.
    expect(result.returned).toBeGreaterThan(0);
    expect(result.returned + (result.omitted ?? 0)).toBe(2000);
    expect(result).toMatchObject({ complete: false, stoppedBecause: "size_budget" });
    expect(judge(result)).toBe(true);
    const { omitted: _omitted, ...rest } = result;
    const oneMore = {
      ...rest,
      items: [...result.items, result.items[result.items.length - 1]!],
      returned: result.returned + 1,
      omitted: (result.omitted ?? 1) - 1,
    };
    expect(judge(oneMore)).toBe(false);
  });

  it("throws when not even an empty inventory fits", async () => {
    const { client } = clientFor([{ items: [entry("A")], nextCursor: null }]);
    await expect(readSecretInventory(client, account, { fits: bytesFit(10) })).rejects.toThrow(
      SecretInventoryTooLargeError,
    );
  });

  it("fails on a missing or empty nextCursor instead of reporting a complete list", async () => {
    for (const body of [{ items: [entry("A")] }, { items: [entry("A")], nextCursor: "" }]) {
      const { client } = clientFor([body]);
      await expect(readSecretInventory(client, account, { fits: bytesFit(1_000_000) })).rejects.toThrow();
    }
  });

  it("stops on a repeated cursor instead of looping", async () => {
    const { client } = clientFor([{ items: [], nextCursor: "same" }]);
    const result = await readSecretInventory(client, account, { fits: bytesFit(1_000_000) });
    expect(result).toMatchObject({ complete: false, stoppedBecause: "cursor_repeat", nextCursor: "same", pages: 2 });
  });

  it("keeps earlier pages when a later page cannot be read, and fails when the first cannot", async () => {
    const down = new TypeError("network down");
    const later = clientFor([{ items: [entry("A")], nextCursor: "c1" }, down]);
    const partial = await readSecretInventory(later.client, account, { fits: bytesFit(1_000_000) });
    expect(partial).toMatchObject({ complete: false, stoppedBecause: "interrupted", nextCursor: "c1", returned: 1 });
    const first = clientFor([down]);
    await expect(readSecretInventory(first.client, account, { fits: bytesFit(1_000_000) })).rejects.toThrow();
  });

  it("requires an environment id for environment scope", async () => {
    const { client } = clientFor([{ items: [], nextCursor: null }]);
    await expect(
      readSecretInventory(client, { scope: "environment" }, { fits: bytesFit(1_000_000) }),
    ).rejects.toThrow(RangeError);
  });
});
