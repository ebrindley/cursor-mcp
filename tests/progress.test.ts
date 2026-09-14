/**
 * Progress notifications, at the reporter and over a real MCP connection.
 *
 * The behaviours that matter are negative ones: nothing is sent without the
 * client's token, no total is invented, Cursor's text never travels, and a
 * client that rejects a notification still gets its read.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ProgressNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { AgentScope } from "../src/agent-scope.js";
import { CursorClient } from "../src/client.js";
import { activeProfile, type Policy } from "../src/config.js";
import { ProgressReporter } from "../src/progress.js";
import { registerAgentTools } from "../src/tools/agents.js";
import { registerRunActivityTool } from "../src/tools/run-activity.js";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const stream = (body: ReadableStream<Uint8Array> | string) =>
  new Response(body, { headers: { "content-type": "text/event-stream" } });
const frame = (id: string, type = "assistant", data = "working") =>
  `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;
const agent = {
  id: "bc-1",
  status: "IDLE",
  url: "https://cursor.com/agents/bc-1",
  createdAt: "t",
  updatedAt: "t",
  repos: [{ url: "https://github.com/O/R" }],
};
const run = (status: string) => ({
  id: "run-1",
  agentId: "bc-1",
  status,
  createdAt: "t",
  updatedAt: "t",
});
const policy: Policy = {
  deleteEnabled: false,
  activationEnabled: false,
  maxResponseBytes: 8192,
  defaultProfile: "p",
  profiles: { p: { repos: ["O/R"], tools: ["read:*"] } },
};

interface Sent {
  progressToken: string | number;
  progress: number;
  total?: number;
  message?: string;
}

/**
 * Connect with the SDK's own progress routing replaced, so a test can assert on
 * the token as sent -- including `0`, which the SDK's own numbering reaches only
 * on the first request of a session.
 */
async function connect(
  register: (server: McpServer, cursor: CursorClient) => void,
  fetchImpl: typeof fetch,
  options: { rejectNotifications?: boolean } = {},
) {
  const server = new McpServer({ name: "test", version: "1" });
  const cursor = new CursorClient({
    apiKey: "dummy",
    baseUrl: "https://api.example.test",
    fetchImpl,
    sleepImpl: async () => {},
  });
  register(server, cursor);
  const client = new Client({ name: "test", version: "1" });
  const notifications: Sent[] = [];
  client.setNotificationHandler(ProgressNotificationSchema, (notification) => {
    notifications.push(notification.params as unknown as Sent);
  });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  if (options.rejectNotifications === true) {
    const send = serverSide.send.bind(serverSide);
    serverSide.send = async (message, sendOptions) => {
      if ((message as { method?: string }).method === "notifications/progress") {
        throw new Error("client is gone");
      }
      return send(message, sendOptions);
    };
  }
  await Promise.all([client.connect(clientSide), server.connect(serverSide)]);
  return { client, server, notifications };
}

const waitTools =
  (sleeps: number[], clock: { value: number }) => (server: McpServer, cursor: CursorClient) =>
    registerAgentTools(server, cursor, policy, new AgentScope(cursor, undefined), {
      sleep: async (ms: number) => {
        sleeps.push(ms);
        clock.value += ms;
      },
      now: () => clock.value,
    });

const tailTools = (server: McpServer, cursor: CursorClient) =>
  registerRunActivityTool(server, cursor, policy, new AgentScope(cursor, activeProfile(policy)));

describe("progress reporter", () => {
  it("counts monotonically from one, carries the token and never invents a total", () => {
    const sent: Sent[] = [];
    const subject = new ProgressReporter(async (params) => void sent.push(params), 0);
    subject.report("first");
    subject.report("second");
    expect(sent).toEqual([
      { progressToken: 0, progress: 1, message: "first" },
      { progressToken: 0, progress: 2, message: "second" },
    ]);
    expect(sent.every((s) => !("total" in s))).toBe(true);
  });

  it("drops a report inside the caller's gap and sends the newest counters after it", () => {
    const sent: Sent[] = [];
    let clock = 0;
    const subject = new ProgressReporter(async (params) => void sent.push(params), "t", {
      now: () => clock,
    });
    subject.report("1 event", 1_000);
    clock = 400;
    subject.report("2 events", 1_000);
    clock = 1_400;
    subject.report("3 events", 1_000);
    expect(sent.map((s) => s.message)).toEqual(["1 event", "3 events"]);
  });

  it("sanitizes and truncates a message, and stops at its own ceiling", () => {
    const sent: Sent[] = [];
    const subject = new ProgressReporter(async (params) => void sent.push(params), "t");
    subject.report(`read ${"x".repeat(400)} events`);
    expect(sent[0]!.message!.length).toBeLessThanOrEqual(200);
    expect(sent[0]!.message).not.toContain("");
    for (let index = 0; index < 100; index += 1) subject.report("more");
    expect(sent.length).toBe(60);
  });

  it("stops after a rejected send and after the request is done, without throwing", async () => {
    const rejecting = new ProgressReporter(async () => {
      throw new Error("client is gone");
    }, "t");
    expect(() => rejecting.report("first")).not.toThrow();
    await Promise.resolve();
    rejecting.report("second");
    expect(rejecting.sent).toBe(1);

    const sent: Sent[] = [];
    const finished = new ProgressReporter(async (params) => void sent.push(params), "t");
    finished.done();
    finished.report("late");
    expect(sent).toEqual([]);
  });
});

describe("cursor_wait_run progress", () => {
  const statuses = (values: string[]) => {
    const remaining = [...values];
    return vi.fn<typeof fetch>().mockImplementation(async () => json(run(remaining.shift() ?? "FINISHED")));
  };

  it("sends one server-authored notification per non-terminal poll under the caller's token", async () => {
    const sleeps: number[] = [];
    const clock = { value: 0 };
    const { client, server, notifications } = await connect(
      waitTools(sleeps, clock),
      statuses(["RUNNING", "RUNNING", "FINISHED"]),
    );
    try {
      const result = await client.callTool({
        name: "cursor_wait_run",
        arguments: { agentId: "bc-1", runId: "run-1", pollIntervalMs: 1000 },
        _meta: { progressToken: 0 },
      });
      expect(result.structuredContent).toMatchObject({ status: "FINISHED", polls: 3 });
      // Two non-terminal polls; the terminal one returns the result instead.
      expect(notifications.map((n) => n.progress)).toEqual([1, 2]);
      expect(notifications.every((n) => n.progressToken === 0)).toBe(true);
      expect(notifications[0]!.message).toContain("1 poll");
      expect(notifications[1]!.message).toContain("2 polls");
      expect(notifications.some((n) => (n.message ?? "").includes("RUNNING"))).toBe(false);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends nothing when the caller supplied no progress token", async () => {
    const sleeps: number[] = [];
    const clock = { value: 0 };
    const { client, server, notifications } = await connect(
      waitTools(sleeps, clock),
      statuses(["RUNNING", "FINISHED"]),
    );
    try {
      const result = await client.callTool({
        name: "cursor_wait_run",
        arguments: { agentId: "bc-1", runId: "run-1", pollIntervalMs: 1000 },
      });
      expect(result.structuredContent).toMatchObject({ status: "FINISHED", polls: 2 });
      expect(notifications).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("returns the run even when every notification is rejected", async () => {
    const sleeps: number[] = [];
    const clock = { value: 0 };
    const { client, server, notifications } = await connect(
      waitTools(sleeps, clock),
      statuses(["RUNNING", "FINISHED"]),
      { rejectNotifications: true },
    );
    try {
      const result = await client.callTool({
        name: "cursor_wait_run",
        arguments: { agentId: "bc-1", runId: "run-1", pollIntervalMs: 1000 },
        _meta: { progressToken: 7 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ status: "FINISHED", timedOut: false });
      expect(notifications).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("cursor_tail_run progress", () => {
  const chunked = (chunks: string[]) =>
    vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(agent))
      .mockResolvedValueOnce(
        stream(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
              controller.close();
            },
          }),
        ),
      )
      .mockResolvedValueOnce(json(run("FINISHED")));

  it("reports counts at most once a second and never the activity text", async () => {
    const fetchImpl = chunked([frame("1"), frame("2"), frame("3"), frame("4", "done", "{}")]);
    const { client, server, notifications } = await connect(tailTools, fetchImpl);
    try {
      const result = await client.callTool({
        name: "cursor_tail_run",
        arguments: { agentId: "bc-1", runId: "run-1" },
        _meta: { progressToken: "tok" },
      });
      expect(result.structuredContent).toMatchObject({ done: true, eventsRead: 4 });
      // Four chunks arrive inside one second, so the gap coalesces them to one.
      expect(notifications).toHaveLength(1);
      expect(notifications[0]).toMatchObject({ progressToken: "tok", progress: 1 });
      expect(notifications[0]!.message).toContain("event");
      expect(notifications[0]!.message).not.toContain("working");
      expect(notifications[0]).not.toHaveProperty("total");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("sends nothing without a token and leaves the stream contract unchanged", async () => {
    const fetchImpl = chunked([frame("1"), frame("2", "done", "{}")]);
    const { client, server, notifications } = await connect(tailTools, fetchImpl);
    try {
      const result = await client.callTool({
        name: "cursor_tail_run",
        arguments: { agentId: "bc-1", runId: "run-1" },
      });
      expect(result.structuredContent).toMatchObject({
        done: true,
        eventsRead: 2,
        lastEventId: "2",
        statusVerified: true,
      });
      expect(notifications).toEqual([]);
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("stops local reads on abort without cancelling the cloud run or notifying after", async () => {
    let opened!: () => void;
    const ready = new Promise<void>((resolve) => {
      opened = resolve;
    });
    const cancelled = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(agent))
      .mockImplementationOnce(async () => {
        opened();
        return stream(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode(frame("1")));
            },
            cancel: cancelled,
          }),
        );
      });
    const { client, server, notifications } = await connect(tailTools, fetchImpl);
    const pending = client
      .callTool({
        name: "cursor_tail_run",
        arguments: { agentId: "bc-1", runId: "run-1", durationMs: 30_000 },
        _meta: { progressToken: "tok" },
      })
      .catch(() => undefined);
    await ready;
    await client.close();
    await server.close();
    await pending;
    const after = notifications.length;
    expect(cancelled).toHaveBeenCalledOnce();
    // No POST: aborting monitoring is not cursor_cancel_run.
    expect(fetchImpl.mock.calls.every((call) => call[1]?.method === "GET")).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(notifications.length).toBe(after);
  });
});
