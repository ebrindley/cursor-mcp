/**
 * The Environment Definition tool surface.
 *
 * These tools are local: the server is connected without a Cursor client, which
 * is itself the assertion that validate, inspect, and diff need no API call.
 * The focus is what crosses the MCP boundary -- the three result classes stay
 * separate, and no script text leaves through a result.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { Policy } from "../src/config.js";
import { registerEnvironmentDefinitionTools } from "../src/tools/environment-definition.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "environment");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");

const policy = (tools: string[], maxResponseBytes = 32_768): Policy => ({
  deleteEnabled: false,
  activationEnabled: false,
  defaultProfile: "p",
  maxResponseBytes,
  profiles: { p: { repos: [], tools } },
});

async function connect(p: Policy, workspaceRoot: string = process.cwd()) {
  const server = new McpServer({ name: "cursor-mcp", version: "test" });
  registerEnvironmentDefinitionTools(server, p, workspaceRoot);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function invoke(
  p: Policy,
  name: string,
  args: Record<string, unknown>,
  workspaceRoot?: string,
) {
  const client = await connect(p, workspaceRoot);
  const result = await client.callTool({ name, arguments: args });
  return {
    isError: result.isError === true,
    structured: (result.structuredContent ?? {}) as Record<string, unknown>,
    text: (result.content as Array<{ text: string }>)
      .map((entry) => entry.text)
      .join("\n"),
  };
}

const READ = policy(["read:*"]);

async function withDefinition(contents?: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "cursor-mcp-env-tool-"));
  if (contents !== undefined) {
    await mkdir(join(root, ".cursor"));
    await writeFile(join(root, ".cursor", "environment.json"), contents, "utf8");
  }
  return root;
}

describe("registration", () => {
  it("registers all three under the read-only wildcard", async () => {
    const names = (await (await connect(READ)).listTools()).tools
      .map((tool) => tool.name)
      .sort();
    expect(names).toEqual([
      "cursor_diff_environment_definition",
      "cursor_inspect_environment_definition",
      "cursor_validate_environment_definition",
    ]);
  });

  it("registers nothing the profile does not name", () => {
    const registered = registerEnvironmentDefinitionTools(
      new McpServer({ name: "cursor-mcp", version: "test" }),
      policy(["cursor_validate_environment_definition"]),
    );
    expect(registered).toEqual(["cursor_validate_environment_definition"]);
  });
});

describe("cursor_validate_environment_definition", () => {
  it("keeps an invalid result schema-valid when the response budget truncates details", async () => {
    const result = await invoke(
      policy(["read:*"], 1_024),
      "cursor_validate_environment_definition",
      {
        definition: {
          text: JSON.stringify({
            repositoryDependencies: Array.from({ length: 100 }, () => 1),
          }),
        },
      },
    );
    expect(result.isError, result.text).toBe(false);
    expect(result.structured.status).toBe("invalid");
    expect(result.structured.errorsTruncated).toBe(true);
    expect(result.text).toContain("structured output exceeded");
  });

  it("keeps a two-sided invalid diff schema-valid under the minimum response budget", async () => {
    const invalid = {
      install: 123,
      start: 456,
      ...Object.fromEntries(
        Array.from({ length: 13 }, (_, index) => [
          `unknown${index}`,
          { nested: "x".repeat(128) },
        ]),
      ),
    };
    const result = await invoke(
      policy(["read:*"], 1_024),
      "cursor_diff_environment_definition",
      {
        base: { text: JSON.stringify(invalid) },
        proposed: { text: JSON.stringify(invalid) },
      },
    );
    expect(result.isError, result.text).toBe(false);
    expect(result.structured.status).toBe("invalid");
    expect(result.text).toContain("structured output exceeded");
  });

  it("accepts a commented document and keeps the three classes apart", async () => {
    const result = await invoke(READ, "cursor_validate_environment_definition", {
      definition: { text: fixture("valid-commented.jsonc") },
    });
    expect(result.isError).toBe(false);
    expect(result.structured.status).toBe("valid");
    expect(result.structured.errors).toEqual([]);
    expect(result.structured.trust).toBe("caller-untrusted");
    expect(Array.isArray(result.structured.limitations)).toBe(true);
    // Untrusted-labeled: definition text is repository content like any other.
    expect(result.text).toContain("CURSOR_UNTRUSTED");
  });

  it("reports a schema error without inventing a safety warning", async () => {
    const result = await invoke(READ, "cursor_validate_environment_definition", {
      definition: { text: fixture("invalid-unknown-property.json") },
    });
    expect(result.structured.status).toBe("invalid");
    expect(result.structured.safety).toEqual([]);
    expect((result.structured.errors as unknown[]).length).toBeGreaterThan(0);
  });

  it("warns about a script without echoing it", async () => {
    const result = await invoke(READ, "cursor_validate_environment_definition", {
      definition: { text: fixture("unsafe-scripts.json") },
    });
    expect(result.structured.status).toBe("valid");
    const serialized = JSON.stringify(result.structured);
    expect(serialized).toContain("CREDENTIAL_PERSISTENCE");
    expect(serialized).not.toContain("EXAMPLE_TOKEN");
    expect(result.text).not.toContain("EXAMPLE_TOKEN");
  });

  it("labels a delegated saved document as untrusted delegated evidence", async () => {
    const result = await invoke(READ, "cursor_validate_environment_definition", {
      definition: {
        text: fixture("observed-sanitized.json"),
        source: "delegated-saved",
      },
    });
    expect(result.structured.trust).toBe("delegated-untrusted");
    expect(JSON.stringify(result.structured.limitations)).toContain("DELEGATED_EVIDENCE");
  });

  it("prepares a synchronization request that is not a Save", async () => {
    const result = await invoke(READ, "cursor_validate_environment_definition", {
      definition: { text: fixture("observed-sanitized.json") },
      syncTarget: { environmentPublicId: "env-public", environmentJsonPath: null },
    });
    const request = result.structured.syncRequest as Record<string, unknown>;
    expect(request.persisted).toBe(false);
    expect(request.requiresOwnerSave).toBe(true);
    expect(request.ownerAction).toBe("SAVE_ENVIRONMENT");
    expect(request).not.toHaveProperty("buildId");
  });

  it("prepares no synchronization request for a document that did not validate", async () => {
    const result = await invoke(READ, "cursor_validate_environment_definition", {
      definition: { text: fixture("invalid-unknown-property.json") },
      syncTarget: { environmentPublicId: "env-public", environmentJsonPath: null },
    });
    expect(result.structured).not.toHaveProperty("syncRequest");
    expect(result.text).toContain("did not validate");
  });

  it("refuses both a repository root and text, and refuses neither", async () => {
    const both = await invoke(READ, "cursor_validate_environment_definition", {
      definition: { repoRoot: ".", text: "{}" },
    });
    expect(both.isError).toBe(true);
    expect(both.text).toContain("Refused by policy");

    const neither = await invoke(READ, "cursor_validate_environment_definition", {
      definition: {},
    });
    expect(neither.isError).toBe(true);
  });
});

describe("cursor_inspect_environment_definition", () => {
  it("reads a repository's own definition and normalizes it", async () => {
    const root = await withDefinition(fixture("observed-sanitized.json"));
    const result = await invoke(
      READ,
      "cursor_inspect_environment_definition",
      { definition: { repoRoot: "." } },
      root,
    );
    expect(result.structured.status).toBe("valid");
    const normalized = result.structured.normalized as Record<string, unknown>;
    expect(normalized.terminals).toHaveLength(1);
    expect(JSON.stringify(normalized)).not.toContain("npm ci");
    expect(result.text).toContain("mcp=inherit");
    expect(result.text).not.toContain(root);
    expect(result.structured.origin).toBe("local file .cursor/environment.json");
  });

  it("calls a missing definition absent, not invalid", async () => {
    const root = await withDefinition();
    const result = await invoke(
      READ,
      "cursor_inspect_environment_definition",
      { definition: { repoRoot: "." } },
      root,
    );
    expect(result.structured.status).toBe("absent");
    expect(result.structured.errors).toEqual([]);
    expect(JSON.stringify(result.structured.limitations)).toContain(
      "LOCAL_DEFINITION_ABSENT",
    );
  });

  it("does not accept an arbitrary model-selected local root", async () => {
    const root = await withDefinition("{}");
    const result = await invoke(READ, "cursor_inspect_environment_definition", {
      definition: { repoRoot: root },
    });
    expect(result.isError).toBe(true);
    expect(result.text).not.toContain(root);
  });

  it("derives local-file authority instead of accepting a caller label", async () => {
    const result = await invoke(READ, "cursor_inspect_environment_definition", {
      definition: { repoRoot: ".", source: "delegated-saved" },
    });
    expect(result.isError).toBe(true);
  });
});

describe("cursor_diff_environment_definition", () => {
  it("diffs two documents, redacting script values", async () => {
    const result = await invoke(READ, "cursor_diff_environment_definition", {
      base: { text: fixture("observed-sanitized.json") },
      proposed: {
        text: '{"name": "observed-environment", "install": "npm ci --omit=dev"}',
      },
    });
    expect(result.structured.status).toBe("valid");
    const changes = result.structured.changes as Array<Record<string, unknown>>;
    expect(changes.some((change) => change.path === "install")).toBe(true);
    expect(JSON.stringify(result.structured)).not.toContain("omit=dev");
    expect(result.text).not.toContain("omit=dev");
  });

  it("refuses to diff when a side did not validate", async () => {
    const result = await invoke(READ, "cursor_diff_environment_definition", {
      base: { text: fixture("observed-sanitized.json") },
      proposed: { text: fixture("invalid-trailing-comma.jsonc") },
    });
    expect(result.structured.status).toBe("invalid");
    expect(result.structured).not.toHaveProperty("changes");
    expect(result.text).toContain("must validate");
  });
});
