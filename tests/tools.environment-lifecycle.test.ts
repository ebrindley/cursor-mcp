/**
 * MCP boundary for the bounded environment lifecycle.
 *
 * Registration and the dry-run / confirm gate are the subject. Sequencing is
 * tested against the operations port; this file checks that the composition
 * tool does not replace the atomic tools.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it } from "vitest";
import { AgentScope } from "../src/agent-scope.js";
import { CursorClient } from "../src/client.js";
import type { Policy } from "../src/config.js";
import {
  atomicJudgements,
  type LifecycleOperations,
} from "../src/environment-lifecycle.js";
import { registerEnvironmentLifecycleTools } from "../src/tools/environment-lifecycle.js";
import { registerEnvironmentOperationTools } from "../src/tools/environment-operations.js";

const ENV_NAME = "example-environment";
const ENV_ID = "env-public";

const policy = (tools: string[]): Policy => ({
  deleteEnabled: false,
  activationEnabled: false,
  defaultProfile: "p",
  maxResponseBytes: 32_768,
  profiles: {
    p: {
      repos: ["ExampleOrg/ExampleRepo"],
      tools,
      environments: [ENV_NAME],
    },
  },
});

const idleOps = (): LifecycleOperations => ({
  now: () => 1,
  inspect: async () => {
    throw new Error("inspect should not run");
  },
  validate: atomicJudgements.validate,
  synchronize: atomicJudgements.synchronize,
  trigger: async () => {
    throw new Error("trigger should not run");
  },
  monitor: async () => {
    throw new Error("monitor should not run");
  },
  qualify: async () => {
    throw new Error("qualify should not run");
  },
  activate: atomicJudgements.activate,
  cancel: atomicJudgements.cancel,
  rollback: atomicJudgements.rollback,
  launch: async () => {
    throw new Error("launch should not run");
  },
});

async function connect(p: Policy, ops: LifecycleOperations = idleOps()) {
  const server = new McpServer({ name: "cursor-mcp", version: "test" });
  const cursor = new CursorClient({
    apiKey: "sk-test",
    baseUrl: "https://api.example.test",
    fetchImpl: async () => {
      throw new Error("no direct API call is expected from the lifecycle tool in these tests");
    },
  });
  const scope = new AgentScope(cursor, undefined);
  registerEnvironmentLifecycleTools(server, cursor, p, scope, {
    async start() {
      throw new Error("delegated runner should not start");
    },
    async collect() {
      throw new Error("delegated runner should not collect");
    },
  }, ops);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

async function connectConcrete(p: Policy, starts: string[]) {
  const server = new McpServer({ name: "cursor-mcp", version: "test" });
  const cursor = new CursorClient({
    apiKey: "sk-test",
    baseUrl: "https://api.example.test",
    fetchImpl: async () => {
      throw new Error("concrete lifecycle preflight must not call Cursor");
    },
  });
  registerEnvironmentLifecycleTools(
    server,
    cursor,
    p,
    new AgentScope(cursor, undefined),
    {
      async start() {
        starts.push("start");
        throw new Error("concrete lifecycle preflight must not launch a delegate");
      },
      async collect() {
        throw new Error("concrete lifecycle preflight must not collect");
      },
    },
  );
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "test" });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  return client;
}

describe("registration", () => {
  it("registers the composition tool without withholding the atomic operations", async () => {
    const server = new McpServer({ name: "cursor-mcp", version: "test" });
    const cursor = new CursorClient({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test",
      fetchImpl: async () => new Response("{}", { status: 200 }),
    });
    const scope = new AgentScope(cursor, undefined);
    const lifecycle = registerEnvironmentLifecycleTools(
      server,
      cursor,
      policy(["*"]),
      scope,
      {
        async start() {
          throw new Error("unused");
        },
        async collect() {
          throw new Error("unused");
        },
      },
      idleOps(),
    );
    const operations = registerEnvironmentOperationTools(
      server,
      cursor,
      policy(["*"]),
      scope,
      {
        async start() {
          throw new Error("unused");
        },
        async collect() {
          throw new Error("unused");
        },
      },
    );
    expect(lifecycle).toEqual(["cursor_run_environment_lifecycle"]);
    expect(operations).toContain("cursor_inspect_environment");
    expect(operations).toContain("cursor_trigger_build");
    expect(operations).toContain("cursor_qualify_environment");
    expect(operations).toContain("cursor_list_owner_actions");
  });

  it("withholds the composition under the read-only wildcard", () => {
    const server = new McpServer({ name: "cursor-mcp", version: "test" });
    const cursor = new CursorClient({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test",
    });
    expect(
      registerEnvironmentLifecycleTools(
        server,
        cursor,
        policy(["read:*"]),
        new AgentScope(cursor, undefined),
        {
          async start() {
            throw new Error("unused");
          },
          async collect() {
            throw new Error("unused");
          },
        },
        idleOps(),
      ),
    ).toEqual([]);
  });

  it("does not require activationEnabled, because the composition never performs a promotion", () => {
    const server = new McpServer({ name: "cursor-mcp", version: "test" });
    const cursor = new CursorClient({
      apiKey: "sk-test",
      baseUrl: "https://api.example.test",
    });
    expect(
      registerEnvironmentLifecycleTools(
        server,
        cursor,
        policy(["*"]),
        new AgentScope(cursor, undefined),
        {
          async start() {
            throw new Error("unused");
          },
          async collect() {
            throw new Error("unused");
          },
        },
        idleOps(),
      ),
    ).toEqual(["cursor_run_environment_lifecycle"]);
  });
});

describe("cursor_run_environment_lifecycle", () => {
  it("classifies the concrete composition planning-only rather than overlaying a confirmed execution", async () => {
    const starts: string[] = [];
    const client = await connectConcrete(policy(["*"]), starts);
    const result = await client.callTool({
      name: "cursor_run_environment_lifecycle",
      arguments: {
        environment: ENV_NAME,
        environmentPublicId: ENV_ID,
        alreadySynchronized: true,
        confirm: true,
      },
    });
    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    expect(result.isError).toBeFalsy();
    expect(structured.status).toBe("PLANNING_ONLY");
    // Confirmation was received; execution did not happen, and the result says so
    // rather than reporting a manufactured STOPPED run.
    expect(structured.confirmed).toBe(true);
    expect(structured.executed).toBe(false);
    expect(structured.stoppedAt).toBeUndefined();
    expect(structured.planningOnlyReason).toContain(
      "cannot boot a run from the newly triggered Build",
    );
    expect(JSON.stringify(structured)).toContain("No lifecycle step executed");
    expect(starts).toEqual([]);
  });

  it("returns a dry-run plan without touching operations that launch", async () => {
    const client = await connect(policy(["*"]));
    const result = await client.callTool({
      name: "cursor_run_environment_lifecycle",
      arguments: {
        environment: ENV_NAME,
        environmentPublicId: ENV_ID,
        dryRun: true,
        alreadySynchronized: true,
      },
    });
    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    expect(result.isError).toBeFalsy();
    expect(structured.status).toBe("PLANNED");
    expect(structured.dryRun).toBe(true);
    const preview = structured.mutationPreview as Array<{ dispatched: boolean }>;
    expect(preview.every((item) => item.dispatched === false)).toBe(true);
    expect(structured.activeBuild).toEqual(
      expect.objectContaining({ readable: false }),
    );
  });

  it("refuses an environmentPublicId that contradicts the pinned binding", async () => {
    const pinned: Policy = {
      ...policy(["*"]),
      profiles: {
        p: {
          repos: ["ExampleOrg/ExampleRepo"],
          tools: ["*"],
          environments: [
            {
              name: ENV_NAME,
              publicId: ENV_ID,
              scope: "team",
              repos: ["ExampleOrg/ExampleRepo"],
            },
          ],
        },
      },
    };
    const client = await connect(pinned);
    const result = await client.callTool({
      name: "cursor_run_environment_lifecycle",
      arguments: {
        environment: ENV_NAME,
        environmentPublicId: "env-somewhere-else",
        dryRun: true,
        alreadySynchronized: true,
      },
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("is pinned to environmentPublicId");
  });

  it("returns CONFIRMATION_REQUIRED instead of inspecting when confirm is omitted", async () => {
    const starts: string[] = [];
    const client = await connectConcrete(policy(["*"]), starts);
    const result = await client.callTool({
      name: "cursor_run_environment_lifecycle",
      arguments: {
        environment: ENV_NAME,
        environmentPublicId: ENV_ID,
        alreadySynchronized: true,
      },
    });
    const structured = (result.structuredContent ?? {}) as Record<string, unknown>;
    expect(structured.status).toBe("CONFIRMATION_REQUIRED");
    expect(structured.executed).toBe(false);
    expect(starts).toEqual([]);
  });
});
