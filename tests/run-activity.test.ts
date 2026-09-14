import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { describe, expect, it, vi } from "vitest";
import { AgentScope } from "../src/agent-scope.js";
import { CursorClient } from "../src/client.js";
import { activeProfile, type Policy } from "../src/config.js";
import { consumeRunStream, MAX_STREAM_BYTES } from "../src/run-stream.js";
import { registerRunActivityTool } from "../src/tools/run-activity.js";

const stream = (text: string) => new Response(text, { headers: { "content-type": "text/event-stream" } });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const agent = { id: "bc-1", status: "IDLE", url: "https://cursor.com/agents/bc-1", createdAt: "t", updatedAt: "t", repos: [{ url: "https://github.com/O/R" }] };
const run = { id: "run-1", agentId: "bc-1", status: "CANCELLED", createdAt: "t", updatedAt: "t" };
const policy: Policy = { deleteEnabled: false, activationEnabled: false, maxResponseBytes: 1024,
  defaultProfile: "p", profiles: { p: { repos: ["O/R"], tools: ["cursor_tail_run"] } } };
const frame = (id: string, type = "assistant", data = "working") => `id: ${id}\nevent: ${type}\ndata: ${data}\n\n`;

describe("bounded stream consumer", () => {
  it("preserves the request cursor when a resumed stream starts with id-less status", async () => {
    const result = await consumeRunStream(stream("event: status\ndata: ACTIVE\n\n"), new AbortController().signal, 4096, "5");
    expect(result).toMatchObject({ lastEventId: "5", eventsRead: 1, truncated: true });
  });

  it("preserves complete events, reports partial EOF and resumes before the final ID group", async () => {
    const response = stream(frame("1") + frame("2") + "id: 3\ndata: unfinished");
    const result = await consumeRunStream(response, new AbortController().signal, 4096);
    expect(result).toMatchObject({ eventsRead: 2, done: false, truncated: true, lastEventId: "1", stopReason: "eof" });
    expect(result.text).not.toContain("unfinished");
  });

  it("does not skip unread events sharing the last ID when the event budget stops a chunk", async () => {
    const data = frame("1") + Array.from({ length: 205 }, () => frame("2")).join("");
    const result = await consumeRunStream(stream(data), new AbortController().signal, 100_000);
    expect(result).toMatchObject({ eventsRead: 200, lastEventId: "1", truncated: true, stopReason: "event-limit" });
  });

  it("caps a huge partial line and a huge output event", async () => {
    const partial = await consumeRunStream(stream("data: " + "x".repeat(MAX_STREAM_BYTES + 10)), new AbortController().signal, 256);
    expect(partial).toMatchObject({ bytesRead: MAX_STREAM_BYTES, truncated: true, stopReason: "byte-limit" });
    const large = await consumeRunStream(stream(frame("2", "assistant", "x".repeat(4096))), new AbortController().signal, 256, "1");
    expect(Buffer.byteLength(large.text)).toBeLessThanOrEqual(256);
    expect(large).toMatchObject({ truncated: true, lastEventId: "1" });
  });

  it("recognizes done only as stream completion and does not emit unsafe resume headers", async () => {
    const result = await consumeRunStream(stream(frame("bad\tid", "done", "{}")), new AbortController().signal, 4096);
    expect(result).toMatchObject({ done: true, truncated: false, stopReason: "done" });
    expect(result.lastEventId).toBeUndefined();
  });

  it("cancels a stalled body when its bound expires", async () => {
    const cancelled = vi.fn();
    const response = new Response(new ReadableStream({ cancel: cancelled }));
    const controller = new AbortController();
    const result = consumeRunStream(response, controller.signal, 4096);
    controller.abort();
    expect(await result).toMatchObject({ truncated: true, stopReason: "time-limit" });
    expect(cancelled).toHaveBeenCalledOnce();
  });
});

describe("stream transport", () => {
  it("retains partial activity on the total deadline but rejects actual caller cancellation", async () => {
    for (const callerCancelled of [false, true]) {
      const controller = new AbortController();
      const response = new Response(new ReadableStream<Uint8Array>({
        start(streamController) { streamController.enqueue(new TextEncoder().encode(frame("1") + frame("2"))); },
      }), { headers: { "content-type": "text/event-stream" } });
      const client = new CursorClient({ apiKey: "dummy", fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(response) });
      const result = client.tailRun("/path", { durationMs: 1000, maxBytes: 1024,
        ...(callerCancelled ? { signal: controller.signal } : { deadlineSignal: controller.signal }) });
      const timer = setTimeout(() => controller.abort(), 5);
      try {
        if (callerCancelled) await expect(result).rejects.toThrow("cancelled");
        else expect(await result).toMatchObject({ eventsRead: 2, lastEventId: "1", truncated: true, stopReason: "time-limit" });
      } finally { clearTimeout(timer); }
    }
  });

  it("sends the resume header to the fixed origin and refuses redirects and unsafe paths", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(stream(frame("2", "done", "{}")));
    const client = new CursorClient({ apiKey: "dummy", fetchImpl });
    await client.tailRun("/v1/agents/bc-1/runs/run-1/stream", { durationMs: 100, maxBytes: 1024, lastEventId: "1" });
    expect(String(fetchImpl.mock.calls[0]![0])).toBe("https://api.cursor.com/v1/agents/bc-1/runs/run-1/stream");
    expect(fetchImpl.mock.calls[0]![1]).toMatchObject({ redirect: "error", headers: { "Last-Event-ID": "1", Accept: "text/event-stream" } });
    await expect(client.tailRun("//other.test/path", { durationMs: 100, maxBytes: 1024 })).rejects.toThrow("origin-relative");
    await expect(client.tailRun("/path", { durationMs: 100, maxBytes: 1024, lastEventId: "x\nHeader: injected" })).rejects.toThrow("resume id");
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("rejects non-SSE content without retrying and releases the response", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream({ cancel }), { headers: { "content-type": "text/html" } }));
    const client = new CursorClient({ apiKey: "dummy", fetchImpl });
    await expect(client.tailRun("/path", { durationMs: 100, maxBytes: 1024 })).rejects.toThrow("text/event-stream");
    expect(fetchImpl).toHaveBeenCalledOnce(); expect(cancel).toHaveBeenCalledOnce();
  });

  it("bounds a stalled header request", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async (_url, init) => new Promise((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
    }));
    const client = new CursorClient({ apiKey: "dummy", fetchImpl });
    expect(await client.tailRun("/path", { durationMs: 5, maxBytes: 1024 })).toMatchObject({ stopReason: "time-limit", truncated: true });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });
});

async function connect(fetchImpl: typeof fetch, p = policy) {
  const server = new McpServer({ name: "test", version: "1" });
  const cursor = new CursorClient({ apiKey: "dummy", fetchImpl, sleepImpl: async () => {} });
  registerRunActivityTool(server, cursor, p, new AgentScope(cursor, activeProfile(p)));
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, server };
}

describe("cursor_tail_run", () => {
  it("uses REST status, fences activity and obeys the small output budget", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(agent))
      .mockResolvedValueOnce(stream(frame("1", "status", "FINISHED") + frame("2", "done", "{}")))
      .mockResolvedValueOnce(json(run));
    const { client, server } = await connect(fetchImpl);
    try {
      const result = await client.callTool({ name: "cursor_tail_run", arguments: { agentId: "bc-1", runId: "run-1" } });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({ done: true, status: "CANCELLED", terminal: true, statusVerified: true });
      expect(result.structuredContent).not.toHaveProperty("text");
      expect(JSON.stringify(result.content)).toContain("CURSOR_UNTRUSTED");
    } finally { await client.close(); await server.close(); }
  });

  it("refuses scope before opening a stream", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ ...agent, repos: [{ url: "https://github.com/Other/R" }] }));
    const { client, server } = await connect(fetchImpl);
    try {
      const result = await client.callTool({ name: "cursor_tail_run", arguments: { agentId: "bc-1", runId: "run-1" } });
      expect(result.isError).toBe(true); expect(fetchImpl).toHaveBeenCalledOnce();
    } finally { await client.close(); await server.close(); }
  });

  it.each([410, 400])("falls back to REST for stream HTTP %s without reconnecting", async (status) => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(agent)).mockResolvedValueOnce(json({}, status)).mockResolvedValueOnce(json(run));
    const { client, server } = await connect(fetchImpl);
    try {
      const result = await client.callTool({ name: "cursor_tail_run", arguments: { agentId: "bc-1", runId: "run-1", lastEventId: "1" } });
      expect(result.structuredContent).toMatchObject({ stopReason: status === 410 ? "expired" : "resume-rejected", replayRequired: true, status: "CANCELLED", truncated: true });
      expect(fetchImpl).toHaveBeenCalledTimes(3);
    } finally { await client.close(); await server.close(); }
  });

  it("reports unverified status on failed readback instead of trusting stream FINISHED", async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(agent)).mockResolvedValueOnce(stream(frame("1", "status", "FINISHED") + frame("2", "done", "{}"))).mockResolvedValueOnce(json({}, 403));
    const { client, server } = await connect(fetchImpl);
    try {
      const result = await client.callTool({ name: "cursor_tail_run", arguments: { agentId: "bc-1", runId: "run-1" } });
      expect(result.structuredContent).toMatchObject({ statusVerified: false });
      expect(result.structuredContent).not.toHaveProperty("terminal");
    } finally { await client.close(); await server.close(); }
  });

  it("stops pending activity when the client disconnects without cancelling the cloud run", async () => {
    let opened!: () => void;
    const ready = new Promise<void>((r) => { opened = r; });
    const cancelled = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(agent)).mockImplementationOnce(async () => {
      opened(); return new Response(new ReadableStream({ cancel: cancelled }), { headers: { "content-type": "text/event-stream" } });
    });
    const { client, server } = await connect(fetchImpl);
    const pending = client.callTool({ name: "cursor_tail_run", arguments: { agentId: "bc-1", runId: "run-1", durationMs: 30_000 } }).catch(() => undefined);
    await ready; await client.close(); await server.close(); await pending;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.every((c) => c[1]?.method === "GET")).toBe(true);
  });
});
