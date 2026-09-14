/**
 * Workspace/account capability catalog, entitlement, redaction, and residuals.
 *
 * These pin the fail-closed rules: secret values never leave the projection,
 * unsupported writes never look like success, and plan-gated reads stay distinct
 * from unverified and unsupported.
 */

import { describe, expect, it } from "vitest";
import { READ_ONLY_POLICY } from "../src/config.js";
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
  supportedIdentityResult,
  workspaceAction,
  workspaceControlSurface,
} from "../src/workspace-controls.js";

describe("capability filtering", () => {
  it("lists identity, models, and repositories as the only supported reads", () => {
    const supported = listWorkspaceControls({ status: "supported", kind: "read" });
    expect(supported.map((surface) => surface.id)).toEqual([
      "identity",
      "models",
      "repositories",
    ]);
    for (const surface of supported) {
      expect(surface.read.status).toBe("supported");
      expect(surface.read.authority).toBe("api-key");
      expect(surface.write).toBeUndefined();
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
      "secrets",
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
