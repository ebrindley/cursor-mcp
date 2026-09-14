import { existsSync, statSync } from "node:fs";
import {
  chmod,
  readFile,
  mkdir,
  mkdtemp,
  readdir,
  symlink,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentScope } from "../src/agent-scope.js";
import { CursorClient } from "../src/client.js";
import { activeProfile, resolveExportRoot, type Policy } from "../src/config.js";
import {
  exportPaths,
  openPartial,
  publish,
  writeFully,
  writeSidecar,
  type ExportPaths,
} from "../src/export-store.js";
import { captureRunStream, MAX_TERMINAL_BYTES, terminalSidecar } from "../src/run-export.js";
import {
  ExportGate,
  registerRunExportTool,
  worstCaseReport,
  type ExportHooks,
} from "../src/tools/run-export.js";

const FIXTURES = new URL("./fixtures/export/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", FIXTURES), "utf8")) as {
  fixtures: Record<
    string,
    {
      bytes: number;
      events: number;
      toolCallEvents: number;
      unparsedToolCalls: number;
      calls: number;
      completed: number;
      running: number;
      runningCalls: string[];
      byName: Record<string, number>;
      terminalCommands: number;
      seededFakeSecret?: string;
    }
  >;
};

const fixture = async (name: string) => readFile(new URL(name, FIXTURES));

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers });
const agent = {
  id: "bc-1",
  status: "FINISHED",
  url: "https://cursor.com/agents/bc-1",
  createdAt: "t",
  updatedAt: "t",
  repos: [{ url: "https://github.com/O/R" }],
};
const run = { id: "run-1", agentId: "bc-1", status: "FINISHED", createdAt: "t", updatedAt: "t" };

/** A body delivered in fixed-size chunks, so event and character boundaries split. */
const chunked = (body: Uint8Array | string, size = 4096) => {
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  let offset = 0;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        controller.enqueue(bytes.subarray(offset, offset + size));
        offset += size;
      },
    }),
    { headers: { "content-type": "text/event-stream" } },
  );
};

async function root(): Promise<string> {
  return mkdtemp(join(tmpdir(), "cursor-export-"));
}

function policyFor(exportRoot: string, tools = ["cursor_export_run"]): Policy {
  return {
    deleteEnabled: false,
    activationEnabled: false,
    maxResponseBytes: 1024,
    exportRoot,
    defaultProfile: "p",
    profiles: { p: { repos: ["O/R"], tools } },
  };
}

async function connect(
  fetchImpl: typeof fetch,
  p: Policy,
  sleep = vi.fn(async (_ms: number) => {}),
  gate?: ExportGate,
  extra: Partial<ExportHooks> = {},
) {
  const server = new McpServer({ name: "test", version: "1" });
  const cursor = new CursorClient({ apiKey: "dummy", fetchImpl, sleepImpl: async () => {} });
  const names = registerRunExportTool(server, cursor, p, new AgentScope(cursor, activeProfile(p)), {
    now: Date.now,
    sleep,
    ...(gate === undefined ? {} : { gate }),
    ...extra,
  });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, server, names, sleep };
}

/** One export call against a scripted transport. */
async function exportRun(
  p: Policy,
  responses: Response[],
  args: Record<string, unknown> = { agentId: "bc-1", runId: "run-1" },
  extra: Partial<ExportHooks> = {},
) {
  const fetchImpl = vi.fn<typeof fetch>();
  for (const response of [json(agent), json(run), ...responses]) {
    fetchImpl.mockResolvedValueOnce(response);
  }
  const { client, server, sleep } = await connect(fetchImpl, p, undefined, undefined, extra);
  try {
    const result = await client.callTool({ name: "cursor_export_run", arguments: args });
    return { result, fetchImpl, sleep };
  } finally {
    await client.close();
    await server.close();
  }
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("cursor_export_run authorization", () => {
  it("registers only when a tool grant and a configured root are both present", async () => {
    const dir = await root();
    expect((await connect(vi.fn<typeof fetch>(), policyFor(dir))).names).toEqual(["cursor_export_run"]);
    // A read-only profile cannot reach a tool that writes files.
    expect((await connect(vi.fn<typeof fetch>(), policyFor(dir, ["read:*"]))).names).toEqual([]);
    const rootless: Policy = { ...policyFor(dir) };
    delete rootless.exportRoot;
    expect((await connect(vi.fn<typeof fetch>(), rootless)).names).toEqual([]);
  });

  it("takes a root from the environment only when it is absolute", () => {
    const rootless: Policy = { ...policyFor("/unused") };
    delete rootless.exportRoot;
    expect(resolveExportRoot(rootless, { CURSOR_MCP_EXPORT_ROOT: "/srv/exports" })).toBe("/srv/exports");
    expect(resolveExportRoot(rootless, { CURSOR_MCP_EXPORT_ROOT: "exports" })).toBeUndefined();
    expect(resolveExportRoot(rootless, { CURSOR_MCP_EXPORT_ROOT: "  " })).toBeUndefined();
    // The policy file wins, so a configured deployment cannot be redirected by env.
    expect(resolveExportRoot(policyFor("/srv/a"), { CURSOR_MCP_EXPORT_ROOT: "/srv/b" })).toBe("/srv/a");
  });
});

describe("cursor_export_run against synthetic fixtures", () => {
  it.each(Object.keys(manifest.fixtures))(
    "writes %s byte-identically and reports the manifest's counts",
    async (name) => {
      const expected = manifest.fixtures[name]!;
      const bytes = await fixture(name);
      expect(bytes.byteLength).toBe(expected.bytes);
      const dir = await root();
      // 137 bytes: events and multi-byte characters split across chunk boundaries.
      const { result } = await exportRun(policyFor(dir), [chunked(bytes, 137)]);
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        complete: true,
        rawComplete: true,
        stopReason: "done",
        status: "FINISHED",
        terminal: true,
        bytes: expected.bytes,
        events: expected.events,
        trailingEvents: 0,
        trailingBytes: 0,
        toolCallEvents: expected.toolCallEvents,
        unparsedToolCalls: expected.unparsedToolCalls,
        toolCalls: expected.calls,
        completedCalls: expected.completed,
        runningCalls: expected.running,
        terminalCommands: expected.terminalCommands,
        attempts: 1,
        rawPublished: true,
        toolsPublished: true,
        terminalPublished: true,
        partialKept: false,
        rawFile: "run-1.sse",
      });
      const written = await readFile(join(dir, "bc-1", "run-1.sse"));
      expect(written.equals(bytes)).toBe(true);
      const tools = JSON.parse(await readFile(join(dir, "bc-1", "run-1.tools.json"), "utf8")) as {
        counts: { calls: number; running: number };
        byName: Record<string, number>;
        runningCalls: string[];
      };
      expect(tools.byName).toEqual(expected.byName);
      expect(tools.runningCalls).toEqual(expected.runningCalls);
      const terminal = await readFile(join(dir, "bc-1", "run-1.terminal.md"), "utf8");
      expect(terminal.match(new RegExp("^## ", "gm"))?.length ?? 0).toBe(expected.terminalCommands);
      // Nothing is left behind that a later reader could mistake for a capture.
      expect((await readdir(join(dir, "bc-1"))).sort()).toEqual([
        "run-1.sse",
        "run-1.terminal.md",
        "run-1.tools.json",
      ]);
    },
  );

  it("keeps the seeded credential out of the response while preserving it on disk", async () => {
    const name = "synthetic-incomplete.sse";
    const secret = manifest.fixtures[name]!.seededFakeSecret!;
    const dir = await root();
    const { result } = await exportRun(policyFor(dir), [chunked(await fixture(name))]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(await readFile(join(dir, "bc-1", name.replace(name, "run-1.sse")), "utf8")).toContain(secret);
    // The terminal log is a local artifact and does hold it: that is what it is for.
    expect(await readFile(join(dir, "bc-1", "run-1.terminal.md"), "utf8")).toContain(secret);
  });

  it("fits the 1,024-byte response minimum", async () => {
    const dir = await root();
    const { result } = await exportRun(policyFor(dir), [chunked(await fixture("synthetic-complete.sse"))]);
    expect(result.isError).not.toBe(true);
    expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThanOrEqual(1024);
  });
});

describe("cursor_export_run completeness", () => {
  const head = "id: 1\nevent: assistant\ndata: working\n\n";

  it("refuses to publish when anything follows done, keeping the bytes as a partial", async () => {
    const dir = await root();
    const body = `${head}event: done\ndata: {}\n\nid: 2\nevent: assistant\ndata: after\n\n`;
    const { result } = await exportRun(policyFor(dir), [chunked(body)]);
    expect(result.structuredContent).toMatchObject({
      complete: false,
      rawComplete: false,
      stopReason: "trailing-content",
      trailingEvents: 1,
      rawPublished: false,
      partialKept: true,
      rawFile: "run-1.sse.partial",
    });
    // Every received byte is in the partial, including the trailing frame.
    expect(await readFile(join(dir, "bc-1", "run-1.sse.partial"), "utf8")).toBe(body);
    expect(await readdir(join(dir, "bc-1"))).toEqual(["run-1.sse.partial"]);
  });

  it("keeps a chunk's bytes that arrive with done, and calls that clean", async () => {
    const dir = await root();
    // One chunk holding the last frame, `done`, and a trailing newline.
    const body = `${head}event: done\ndata: {}\n\n\n`;
    const { result } = await exportRun(policyFor(dir), [chunked(body, body.length)]);
    expect(result.structuredContent).toMatchObject({ complete: true, stopReason: "done", trailingEvents: 0 });
    expect(await readFile(join(dir, "bc-1", "run-1.sse"), "utf8")).toBe(body);
  });

  it("reports a stream cut mid-event as incomplete and keeps the partial", async () => {
    const dir = await root();
    const body = `${head}id: 2\nevent: assistant\ndata: unfinis`;
    const { result } = await exportRun(policyFor(dir), [chunked(body)]);
    expect(result.structuredContent).toMatchObject({
      complete: false,
      stopReason: "eof-before-done",
      events: 1,
      trailingBytes: "data: unfinis".length,
      rawPublished: false,
      partialKept: true,
    });
    expect(await readFile(join(dir, "bc-1", "run-1.sse.partial"), "utf8")).toBe(body);
  });
});

describe("cursor_export_run refusals", () => {
  it("refuses a non-terminal run and a mismatched identity before writing anything", async () => {
    for (const rest of [
      { ...run, status: "RUNNING" },
      { ...run, id: "run-2" },
      { ...run, agentId: "bc-2" },
    ]) {
      const dir = await root();
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json(agent)).mockResolvedValueOnce(json(rest));
      const { client, server } = await connect(fetchImpl, policyFor(dir));
      try {
        const result = await client.callTool({
          name: "cursor_export_run",
          arguments: { agentId: "bc-1", runId: "run-1" },
        });
        expect(result.isError).toBe(true);
        // Two REST reads and no stream: nothing was opened and no directory made.
        expect(fetchImpl).toHaveBeenCalledTimes(2);
        expect(await readdir(dir)).toEqual([]);
      } finally {
        await client.close();
        await server.close();
      }
    }
  });

  it("refuses ids that are not safe file names", async () => {
    const dir = await root();
    for (const args of [
      { agentId: "../escape", runId: "run-1" },
      { agentId: "bc-1", runId: ".." },
      { agentId: "bc-1", runId: "a/b" },
    ]) {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ ...agent, id: args.agentId }));
      const { client, server } = await connect(fetchImpl, policyFor(dir));
      try {
        const result = await client.callTool({ name: "cursor_export_run", arguments: args });
        expect(result.isError).toBe(true);
      } finally {
        await client.close();
        await server.close();
      }
    }
    expect(await readdir(dir)).toEqual([]);
  });

  it.each(["run-1.sse", "run-1.sse.partial"])(
    "refuses when %s already exists, and leaves it untouched",
    async (existing) => {
      const dir = await root();
      await mkdir(join(dir, "bc-1"), { recursive: true });
      await writeFile(join(dir, "bc-1", existing), "earlier evidence");
      const { result, fetchImpl } = await exportRun(policyFor(dir), [chunked("event: done\ndata: {}\n\n")]);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(existing);
      // The stream was never opened, and the earlier file is byte-for-byte intact.
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(await readFile(join(dir, "bc-1", existing), "utf8")).toBe("earlier evidence");
      expect(await readdir(join(dir, "bc-1"))).toEqual([existing]);
    },
  );

  it("removes only a partial it created and never wrote to", async () => {
    const dir = await root();
    // A stream that ends at once: a connection accepted and then closed.
    const { result } = await exportRun(policyFor(dir), [chunked("")]);
    expect(result.structuredContent).toMatchObject({ bytes: 0, partialKept: false, rawPublished: false });
    // An empty partial left behind would refuse every later retry of this run.
    expect(await readdir(join(dir, "bc-1"))).toEqual([]);
  });

  it("publishes the raw export and reports a sidecar that could not be written", async () => {
    const dir = await root();
    await mkdir(join(dir, "bc-1"), { recursive: true });
    await writeFile(join(dir, "bc-1", "run-1.tools.json"), "not ours");
    const body = "id: 1\nevent: assistant\ndata: working\n\nevent: done\ndata: {}\n\n";
    const { result } = await exportRun(policyFor(dir), [chunked(body)]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      complete: false,
      rawComplete: true,
      rawPublished: true,
      toolsPublished: false,
      terminalPublished: true,
      partialKept: false,
    });
    expect(result.structuredContent).toHaveProperty("sidecarError");
    expect(await readFile(join(dir, "bc-1", "run-1.sse"), "utf8")).toBe(body);
    expect(await readFile(join(dir, "bc-1", "run-1.tools.json"), "utf8")).toBe("not ours");
  });
});

describe("cursor_export_run pacing", () => {
  it("honours Retry-After once and then exports", async () => {
    const dir = await root();
    const body = "event: done\ndata: {}\n\n";
    const { result, sleep, fetchImpl } = await exportRun(policyFor(dir), [
      json({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429, { "retry-after": "2" }),
      chunked(body),
    ]);
    expect(sleep).toHaveBeenCalledWith(2000);
    expect(result.structuredContent).toMatchObject({ complete: true, attempts: 2 });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it("falls back to a bounded wait when a refusal carries no Retry-After, then gives up", async () => {
    const dir = await root();
    const { result, sleep, fetchImpl } = await exportRun(policyFor(dir), [
      json({ error: { message: "congested" } }, 503),
      json({ error: { message: "congested" } }, 503),
      json({ error: { message: "congested" } }, 503),
    ]);
    expect(result.isError).toBe(true);
    expect(sleep.mock.calls.map(([ms]) => ms)).toEqual([1000, 3000]);
    // Three attempts, never a fourth.
    expect(fetchImpl).toHaveBeenCalledTimes(5);
    expect(await readdir(join(dir, "bc-1"))).toEqual([]);
  });

  it("never retries exhausted usage", async () => {
    const dir = await root();
    // The recorded shape: HTTP 429 under `rate_limit_exceeded`, with the meaning
    // in the message. A wait cannot clear it, whatever Retry-After says.
    const { result, sleep, fetchImpl } = await exportRun(policyFor(dir), [
      json(
        {
          error: {
            code: "rate_limit_exceeded",
            message:
              "You've used all included Cloud Agent usage: Enable on-demand usage to continue using Cloud Agents",
          },
        },
        429,
        { "retry-after": "2" },
      ),
    ]);
    expect(result.isError).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(JSON.stringify(result.content)).toContain("usage is exhausted");
  });

  it("reports rather than waits when Retry-After does not fit the call's ceiling", async () => {
    const dir = await root();
    const { result, sleep, fetchImpl } = await exportRun(policyFor(dir), [
      json({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429, { "retry-after": "120" }),
    ]);
    expect(result.isError).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(await readdir(join(dir, "bc-1"))).toEqual([]);
  });

  it("does not retry a contract failure", async () => {
    const dir = await root();
    const { result, sleep, fetchImpl } = await exportRun(policyFor(dir), [
      new Response("<html>", { headers: { "content-type": "text/html" } }),
    ]);
    expect(result.isError).toBe(true);
    expect(sleep).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });
});

describe("cursor_export_run cancellation", () => {
  it("stops on client disconnect without publishing or cancelling the cloud run", async () => {
    const dir = await root();
    let opened!: () => void;
    const ready = new Promise<void>((r) => {
      opened = r;
    });
    const cancelled = vi.fn();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(agent))
      .mockResolvedValueOnce(json(run))
      .mockImplementationOnce(async () => {
        opened();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("id: 1\nevent: assistant\ndata: working\n\n"));
            },
            cancel: cancelled,
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
    const { client, server } = await connect(fetchImpl, policyFor(dir));
    const pending = client
      .callTool({ name: "cursor_export_run", arguments: { agentId: "bc-1", runId: "run-1" } })
      .catch(() => undefined);
    await ready;
    await client.close();
    await server.close();
    await pending;
    expect(cancelled).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls.every((call) => (call[1]?.method ?? "GET") === "GET")).toBe(true);
    expect(await readdir(join(dir, "bc-1"))).not.toContain("run-1.sse");
  });
});

describe("run export writes", () => {
  /** A handle that persists at most `per` bytes per write, like a real short write. */
  const shortWriter = (per: number) => {
    const calls: number[] = [];
    const handle = {
      async write(data: Uint8Array, offset: number, length: number) {
        const bytesWritten = Math.min(per, length);
        calls.push(bytesWritten);
        return { bytesWritten, buffer: data };
      },
    };
    return { handle: handle as unknown as FileHandle, calls };
  };

  /**
   * A real partial that stops taking bytes after `limit`, the way a full disk
   * does: part of the chunk is on disk and the rest of the write fails.
   */
  const cappedOpen =
    (limit: number, mode: "throw" | "zero" | "close") =>
    async (paths: ExportPaths): Promise<FileHandle> => {
      const real = await openPartial(paths);
      let written = 0;
      const handle = {
        async write(data: Uint8Array, offset: number, length: number) {
          const room = Math.max(0, limit - written);
          if (room === 0) {
            if (mode === "zero") return { bytesWritten: 0, buffer: data };
            throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
          }
          const result = await real.write(data, offset, Math.min(room, length));
          written += result.bytesWritten;
          return result;
        },
        async close() {
          await real.close();
          if (mode === "close") {
            throw Object.assign(new Error("input/output error"), { code: "EIO" });
          }
        },
      };
      return handle as unknown as FileHandle;
    };

  it("writes every byte across short writes, and refuses a handle making no progress", async () => {
    const data = Buffer.from("0123456789", "utf8");
    const short = shortWriter(3);
    const progress: number[] = [];
    expect(await writeFully(short.handle, data, (bytes) => progress.push(bytes))).toBe(10);
    expect(short.calls).toEqual([3, 3, 3, 1]);
    // Progress is reported per write, so a caller's count survives a later failure.
    expect(progress).toEqual([3, 3, 3, 1]);
    const stalling = shortWriter(0);
    const stalled: number[] = [];
    // A write that persists nothing is a failure, not a loop.
    await expect(writeFully(stalling.handle, data, (b) => stalled.push(b))).rejects.toThrow(
      /made no progress/,
    );
    expect(stalled).toEqual([]);
  });

  it.each(["throw", "zero"] as const)(
    "keeps and reports the non-empty partial when a write fails partway (%s)",
    async (mode) => {
      const dir = await root();
      const body = `id: 1\nevent: assistant\ndata: ${"n".repeat(300)}\n\nevent: done\ndata: {}\n\n`;
      const { result } = await exportRun(policyFor(dir), [chunked(body, 137)], undefined, {
        openRaw: cappedOpen(100, mode),
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        complete: false,
        rawComplete: false,
        stopReason: "write-failed",
        // The chunk never counted as received, and 100 of its bytes are on disk.
        bytes: 0,
        persistedBytes: 100,
        rawPublished: false,
        partialKept: true,
        rawFile: "run-1.sse.partial",
      });
      expect(JSON.stringify(result.content)).toContain("Bytes on disk: 100");
      // The evidence that arrived is still there, and no final name exists.
      expect(await readdir(join(dir, "bc-1"))).toEqual(["run-1.sse.partial"]);
      expect((await readFile(join(dir, "bc-1", "run-1.sse.partial"))).byteLength).toBe(100);
    },
  );

  it("keeps a partial whose size cannot be read, and says the size is unknown", async () => {
    const dir = await root();
    const agentDir = join(dir, "bc-1");
    const body = `id: 1\nevent: assistant\ndata: ${"n".repeat(300)}\n\nevent: done\ndata: {}\n\n`;
    // A write that stores bytes and then rejects without reporting them, over a
    // directory that stops being searchable once the handle is closed: the file
    // is there, it holds bytes, and neither the counter nor a `stat` can say how
    // many. "Nothing was written" would be the one wrong answer.
    const openRaw = async (paths: ExportPaths): Promise<FileHandle> => {
      const real = await openPartial(paths);
      const handle = {
        async write(data: Uint8Array, offset: number, length: number) {
          await real.write(data, offset, Math.min(100, length));
          throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
        },
        async close() {
          await real.close();
          await chmod(agentDir, 0o000);
        },
      };
      return handle as unknown as FileHandle;
    };
    try {
      const { result } = await exportRun(policyFor(dir), [chunked(body, 137)], undefined, { openRaw });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        complete: false,
        rawComplete: false,
        stopReason: "write-failed",
        bytes: 0,
        // A floor, marked as one, rather than an exact zero.
        persistedBytes: 0,
        persistedBytesUnknown: true,
        rawPublished: false,
        partialKept: true,
        rawFile: "run-1.sse.partial",
      });
      expect(JSON.stringify(result.content)).toContain("at least 0, exact size unreadable");
      expect(JSON.stringify(result.content)).toContain("run-1.sse.partial kept");
    } finally {
      await chmod(agentDir, 0o700);
    }
    // The evidence the report promised is on disk, and no final name exists.
    expect(await readdir(agentDir)).toEqual(["run-1.sse.partial"]);
    expect((await readFile(join(agentDir, "run-1.sse.partial"))).byteLength).toBe(100);
  });

  it("publishes nothing when the raw partial cannot be closed", async () => {
    const dir = await root();
    const body = "id: 1\nevent: assistant\ndata: working\n\nevent: done\ndata: {}\n\n";
    const { result } = await exportRun(policyFor(dir), [chunked(body)], undefined, {
      openRaw: cappedOpen(Number.MAX_SAFE_INTEGER, "close"),
    });
    // A close that failed cannot promise the bytes reached the file, so nothing
    // is linked under a name that says they did.
    expect(result.isError).toBe(true);
    expect(await readdir(join(dir, "bc-1"))).toEqual(["run-1.sse.partial"]);
    expect(await readFile(join(dir, "bc-1", "run-1.sse.partial"), "utf8")).toBe(body);
  });

  it("leaves a sidecar's final name absent when its partial cannot be created", async () => {
    const dir = await root();
    await chmod(dir, 0o500);
    try {
      await expect(writeSidecar(join(dir, "run-1.tools.json"), "{}")).rejects.toThrow();
      expect(await readdir(dir)).toEqual([]);
    } finally {
      await chmod(dir, 0o700);
    }
  });

  it("keeps a published final file when the partial cannot be removed", async () => {
    const dir = await root();
    const source = join(dir, "source");
    const target = join(dir, "target");
    await mkdir(source);
    await mkdir(target);
    const partial = join(source, "run-1.sse.partial");
    await writeFile(partial, "captured");
    // No write permission on the directory holding the partial: `link` still
    // succeeds, `unlink` cannot.
    await chmod(source, 0o500);
    try {
      const published = await publish(partial, join(target, "run-1.sse"));
      expect(published).toMatchObject({ linked: true, partialRemoved: false });
      expect(published.detail).toContain("could not be removed");
      // Both names exist, and the published one holds the bytes.
      expect(await readFile(join(target, "run-1.sse"), "utf8")).toBe("captured");
      expect(await readdir(source)).toEqual(["run-1.sse.partial"]);
    } finally {
      await chmod(source, 0o700);
    }
  });

  it("refuses a sidecar whose partial already exists, leaving the final name absent", async () => {
    const dir = await root();
    const final = join(dir, "run-1.terminal.md");
    await writeFile(`${final}.partial`, "half-written earlier");
    await expect(writeSidecar(final, "# log")).rejects.toThrow(/already exists/);
    expect(await readdir(dir)).toEqual(["run-1.terminal.md.partial"]);
    // The happy path leaves no partial behind at all.
    const other = join(dir, "run-2.terminal.md");
    expect(await writeSidecar(other, "# log")).toMatchObject({ linked: true, partialRemoved: true });
    expect((await readdir(dir)).sort()).toEqual(["run-1.terminal.md.partial", "run-2.terminal.md"]);
  });

  it("refuses an agent directory that is a symlink out of the root", async () => {
    const dir = await root();
    const outside = await root();
    await symlink(outside, join(dir, "bc-1"));
    const { result, fetchImpl } = await exportRun(policyFor(dir), [chunked("event: done\ndata: {}\n\n")]);
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.content)).toContain("symlinked agent");
    // The stream was never opened and nothing landed where the link pointed.
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(await readdir(outside)).toEqual([]);
  });
});

describe("run export interruption", () => {
  it("does not link a sidecar the export stopped during, and removes its partial", async () => {
    const dir = await root();
    const final = join(dir, "run-1.terminal.md");
    const content = "x".repeat(64 * 1024);
    // "cancelled" only once every byte is on disk, which is the case the check
    // before the write could not see: neither the write nor the close is
    // interruptible, so what the probe has to stop is the link after them.
    const stop = () =>
      statSync(`${final}.partial`).size === content.length ? "cancelled" : undefined;
    const written = await writeSidecar(final, content, stop);
    expect(written).toMatchObject({ linked: false, partialRemoved: true });
    expect(written.detail).toContain("cancelled");
    // No final name, and no partial to be mistaken for one.
    expect(await readdir(dir)).toEqual([]);
  });

  it("does not link the final sidecar when the ceiling passes while it is written", async () => {
    const dir = await root();
    const terminalPartial = join(dir, "bc-1", "run-1.terminal.md.partial");
    const start = Date.now();
    // The clock passes this call's ceiling exactly when the terminal sidecar's
    // bytes reach the disk, so the stop is observed after that write and before
    // its publication. Time only moves forward, so the jump latches.
    let past = false;
    const now = () => {
      past ||= existsSync(terminalPartial);
      return past ? start + 120_000 : start;
    };
    const body = "id: 1\nevent: assistant\ndata: working\n\nevent: done\ndata: {}\n\n";
    const { result } = await exportRun(policyFor(dir), [chunked(body)], undefined, { now });
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      complete: false,
      // The raw export was published before the deadline and stays valid.
      rawComplete: true,
      rawPublished: true,
      toolsPublished: true,
      terminalPublished: false,
      partialKept: false,
      stoppedBefore: "time-limit",
    });
    expect(result.structuredContent).not.toHaveProperty("terminalFile");
    expect(result.structuredContent).toHaveProperty("sidecarError");
    expect((await readdir(join(dir, "bc-1"))).sort()).toEqual(["run-1.sse", "run-1.tools.json"]);
  });

  it("does not open another stream when the caller cancels during a Retry-After wait", async () => {
    const dir = await root();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(agent))
      .mockResolvedValueOnce(json(run))
      .mockResolvedValueOnce(
        json({ error: { code: "rate_limit_exceeded", message: "slow down" } }, 429, {
          "retry-after": "2",
        }),
      )
      .mockResolvedValueOnce(chunked("event: done\ndata: {}\n\n"));
    const controller = new AbortController();
    // The cancel lands inside the wait, and this sleep never resolves: the
    // caller's signal is then the only way the call can settle at all.
    const sleep = vi.fn(async (_ms: number) => {
      controller.abort();
      return new Promise<void>(() => {});
    });
    const { client, server } = await connect(fetchImpl, policyFor(dir), sleep);
    try {
      await expect(
        client.callTool(
          { name: "cursor_export_run", arguments: { agentId: "bc-1", runId: "run-1" } },
          undefined,
          { signal: controller.signal },
        ),
      ).rejects.toThrow();
      expect(sleep).toHaveBeenCalledWith(2000);
      // Agent, run, one refused stream: the fourth response is never requested.
      expect(fetchImpl).toHaveBeenCalledTimes(3);
      // The partial this call opened held nothing, so it does not block a retry.
      await vi.waitFor(async () => {
        expect(await readdir(join(dir, "bc-1"))).toEqual([]);
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

type FsPromises = typeof import("node:fs/promises");

/**
 * The export modules re-imported over a patched `node:fs/promises`.
 *
 * A real file cannot be made to fail its `write` or its `close` on demand, and
 * it cannot be made to hold a write pending while the clock moves past this
 * call's ceiling. Those are the cases the sidecar path has to survive, so the
 * patch replaces the filesystem for the duration of one test rather than adding
 * a production seam for it: nothing in `src` knows about this.
 */
async function withPatchedFs<T>(
  patch: (real: FsPromises) => Record<string, unknown>,
  body: (mods: {
    registerRunExportTool: typeof registerRunExportTool;
    writeSidecar: typeof writeSidecar;
  }) => Promise<T>,
): Promise<T> {
  vi.resetModules();
  vi.doMock("node:fs/promises", async () => {
    const real = await vi.importActual<FsPromises>("node:fs/promises");
    return { ...real, default: real, ...patch(real) };
  });
  try {
    const store = await import("../src/export-store.js");
    const tool = await import("../src/tools/run-export.js");
    return await body({
      registerRunExportTool: tool.registerRunExportTool,
      writeSidecar: store.writeSidecar,
    });
  } finally {
    vi.doUnmock("node:fs/promises");
    vi.resetModules();
  }
}

describe("run export sidecar failures", () => {
  /** A handle for one path whose `write` or `close` fails against a real file. */
  const failingOpen = (name: string, when: "write" | "close") => (real: FsPromises) => ({
    open: async (path: unknown, flags?: unknown) => {
      const handle = await real.open(path as string, flags as string);
      if (!String(path).endsWith(name)) return handle;
      const fail = () => Object.assign(new Error("input/output error"), { code: "EIO" });
      return {
        write: async (data: Uint8Array, offset: number, length: number) => {
          if (when === "write") throw fail();
          return handle.write(data, offset, length);
        },
        close: async () => {
          await handle.close();
          if (when === "close") throw fail();
        },
      } as unknown as FileHandle;
    },
  });

  it.each(["write", "close"] as const)(
    "leaves a sidecar's final name absent when its %s fails",
    async (when) => {
      const dir = await root();
      const final = join(dir, "run-1.tools.json");
      await withPatchedFs(failingOpen("run-1.tools.json.partial", when), async ({ writeSidecar: write }) => {
        await expect(write(final, '{"calls":[]}')).rejects.toThrow(/input\/output/);
      });
      // Absent, never half-written: neither the final name nor the partial that
      // failed is left for a reader to mistake for a derived file. A close that
      // failed is the sharper case -- bytes did reach the file, and linking them
      // would publish a sidecar nothing can vouch for.
      expect(await readdir(dir)).toEqual([]);
    },
  );

  it("starts no link for a sidecar whose write was still pending when the ceiling passed", async () => {
    const dir = await root();
    const order: string[] = [];
    const links: string[] = [];
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight!: () => void;
    const started = new Promise<void>((resolve) => {
      inFlight = resolve;
    });
    const start = Date.now();
    let past = false;
    const result = await withPatchedFs(
      (real) => {
        let intercepted = false;
        return {
          link: async (from: unknown, to: unknown) => {
            links.push(String(to));
            return real.link(from as string, to as string);
          },
          open: async (path: unknown, flags?: unknown) => {
            const handle = await real.open(path as string, flags as string);
            if (intercepted || !String(path).endsWith("run-1.terminal.md.partial")) return handle;
            intercepted = true;
            return {
              write: async (data: Uint8Array, offset: number, length: number) => {
                order.push("write started");
                inFlight();
                // The deadline lands here, with the write neither finished nor
                // interruptible -- the state this export cannot check during.
                await pending;
                order.push("write settled");
                return handle.write(data, offset, length);
              },
              close: () => handle.close(),
            } as unknown as FileHandle;
          },
        };
      },
      async ({ registerRunExportTool: register }) => {
        const fetchImpl = vi
          .fn<typeof fetch>()
          .mockResolvedValueOnce(json(agent))
          .mockResolvedValueOnce(json(run))
          .mockResolvedValueOnce(chunked("id: 1\nevent: assistant\ndata: working\n\nevent: done\ndata: {}\n\n"));
        const p = policyFor(dir);
        const server = new McpServer({ name: "test", version: "1" });
        const cursor = new CursorClient({ apiKey: "dummy", fetchImpl, sleepImpl: async () => {} });
        register(server, cursor, p, new AgentScope(cursor, activeProfile(p)), {
          now: () => (past ? start + 120_000 : start),
          sleep: async () => {},
        });
        const client = new Client({ name: "test", version: "1" });
        const [a, b] = InMemoryTransport.createLinkedPair();
        await Promise.all([client.connect(a), server.connect(b)]);
        try {
          const call = client.callTool({
            name: "cursor_export_run",
            arguments: { agentId: "bc-1", runId: "run-1" },
          });
          await started;
          past = true;
          order.push("ceiling passed");
          release();
          return await call;
        } finally {
          await client.close();
          await server.close();
        }
      },
    );
    // The ceiling really did pass mid-write rather than before or after it.
    expect(order).toEqual(["write started", "ceiling passed", "write settled"]);
    expect(result.structuredContent).toMatchObject({
      complete: false,
      rawComplete: true,
      // The raw export was published before the deadline and is still reported
      // as published, accurately: it is whole and on disk.
      rawPublished: true,
      toolsPublished: true,
      terminalPublished: false,
      partialKept: false,
      stoppedBefore: "time-limit",
    });
    // Nothing linked the sidecar after its write settled.
    expect(links.filter((to) => to.endsWith("run-1.terminal.md"))).toEqual([]);
    expect(links.map((to) => to.split("/").pop())).toEqual(["run-1.sse", "run-1.tools.json"]);
    expect((await readdir(join(dir, "bc-1"))).sort()).toEqual(["run-1.sse", "run-1.tools.json"]);
  });
});

describe("run export serialization", () => {
  const idle = () => new AbortController().signal;

  it("holds the slot until it is released, and a queued caller can leave", async () => {
    const gate = new ExportGate();
    const order: string[] = ["first"];
    const held = await gate.acquire(idle());
    const abandoning = new AbortController();
    const abandoned = gate.acquire(abandoning.signal);
    const second = gate.acquire(idle()).then((release) => {
      order.push("second");
      return release;
    });
    abandoning.abort();
    await expect(abandoned).rejects.toThrow(/cancelled while it was queued/);
    // Giving up a place does not hand the slot to the next waiter.
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(order).toEqual(["first"]);
    held();
    (await second)();
    expect(order).toEqual(["first", "second"]);
  });

  it("refuses a waiter beyond the queue's depth", async () => {
    const gate = new ExportGate();
    const held = await gate.acquire(idle());
    const waiting = [0, 1, 2, 3].map(() => gate.acquire(idle()));
    await expect(gate.acquire(idle())).rejects.toThrow(/read one at a time/);
    held();
    for (const pending of waiting) (await pending)();
  });

  it("does not open a second run's stream while one export is streaming", async () => {
    const dir = await root();
    const gate = new ExportGate();
    const opens: string[] = [];
    let finishFirst!: () => void;
    const held = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const enc = (text: string) => new TextEncoder().encode(text);
    const first = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(agent))
      .mockResolvedValueOnce(json(run))
      .mockImplementationOnce(async () => {
        opens.push("run-1");
        let sent = false;
        return new Response(
          new ReadableStream<Uint8Array>({
            async pull(controller) {
              if (!sent) {
                sent = true;
                controller.enqueue(enc("id: 1\nevent: assistant\ndata: working\n\n"));
                return;
              }
              await held;
              controller.enqueue(enc("event: done\ndata: {}\n\n"));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      });
    const second = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(agent))
      .mockResolvedValueOnce(json({ ...run, id: "run-2" }))
      .mockImplementationOnce(async () => {
        opens.push("run-2");
        return chunked("event: done\ndata: {}\n\n");
      });
    const a = await connect(first, policyFor(dir), undefined, gate);
    const b = await connect(second, policyFor(dir), undefined, gate);
    try {
      const call = (side: typeof a, runId: string) =>
        side.client.callTool({ name: "cursor_export_run", arguments: { agentId: "bc-1", runId } });
      const pendingA = call(a, "run-1");
      while (opens.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
      const pendingB = call(b, "run-2");
      await new Promise((resolve) => setTimeout(resolve, 20));
      // The second export has read REST and is waiting for the slot, not reading.
      expect(opens).toEqual(["run-1"]);
      expect(second).toHaveBeenCalledTimes(2);
      finishFirst();
      const [resultA, resultB] = await Promise.all([pendingA, pendingB]);
      expect(opens).toEqual(["run-1", "run-2"]);
      expect(resultA.structuredContent).toMatchObject({ complete: true, rawFile: "run-1.sse" });
      expect(resultB.structuredContent).toMatchObject({ complete: true, rawFile: "run-2.sse" });
    } finally {
      for (const side of [a, b]) {
        await side.client.close();
        await side.server.close();
      }
    }
  });
});

describe("run export byte ceilings", () => {
  const signal = () => new AbortController().signal;

  it("calls a clipped chunk a byte-limit even when done was inside the part that fit", async () => {
    const body = `event: done\ndata: {}\n\n${"x".repeat(64)}`;
    let persisted = 0;
    const capture = await captureRunStream(chunked(body, body.length), {
      signal: signal(),
      write: async (chunk) => {
        persisted += chunk.byteLength;
      },
      maxBytes: 30,
    });
    // `done` was parsed, and it still cannot make a short file complete.
    expect(capture).toMatchObject({ stopReason: "byte-limit", complete: false, bytes: 30 });
    expect(persisted).toBe(30);
  });

  it("bounds the terminal log when completions replace running entries", async () => {
    // Invented, and deliberately multi-byte: 30,000 characters is 60,000 bytes,
    // which `String.length` accounting would have charged as half that.
    const output = "é".repeat(30_000);
    const frame = (payload: unknown) => `event: tool_call\ndata: ${JSON.stringify(payload)}\n\n`;
    const parts: string[] = [];
    for (let i = 0; i < 100; i += 1) {
      parts.push(
        frame({
          callId: `call-${i}`,
          name: "run_terminal_cmd",
          status: "running",
          args: { command: `printf 'step ${i}'` },
        }),
      );
    }
    for (let i = 0; i < 100; i += 1) {
      parts.push(
        frame({
          callId: `call-${i}`,
          name: "run_terminal_cmd",
          status: "completed",
          args: { command: `printf 'step ${i}'` },
          result: { success: { stdout: output, executionTime: 12 } },
        }),
      );
    }
    parts.push("event: done\ndata: {}\n\n");
    const capture = await captureRunStream(chunked(parts.join("")), {
      signal: signal(),
      write: async () => {},
    });
    expect(capture.complete).toBe(true);
    expect(capture.terminal).toHaveLength(100);
    // Truncation is reported, and the ceiling holds despite every entry being
    // replaced by a much larger one.
    expect(capture.terminalTruncated).toBe(true);
    const log = terminalSidecar({
      agentId: "bc-1",
      runId: "run-1",
      exportedAt: "t",
      capture,
      status: "FINISHED",
    });
    expect(Buffer.byteLength(log, "utf8")).toBeLessThan(MAX_TERMINAL_BYTES + 4096);
    // Some completions fit, and no entry was left half-applied.
    expect(capture.terminal.some((entry) => entry.output !== undefined)).toBe(true);
    for (const entry of capture.terminal) {
      if (entry.output !== undefined) expect(entry.status).toBe("completed");
    }
  });
});

describe("run export reporting", () => {
  it("locates artifacts under the root and accounts the bytes it persisted", async () => {
    const dir = await root();
    const body = "id: 1\nevent: assistant\ndata: working\n\nevent: done\ndata: {}\n\n";
    const { result } = await exportRun(policyFor(dir), [chunked(body)]);
    expect(result.structuredContent).toMatchObject({
      dirUnderRoot: "bc-1",
      persistedBytes: Buffer.byteLength(body, "utf8"),
      partialCleanupFailed: false,
    });
    expect(result.structuredContent).not.toHaveProperty("stoppedBefore");
    // Every field a report can carry is one the preflight reserved budget for.
    const reserved = Object.keys(worstCaseReport(exportPaths(dir, "bc-1", "run-1"), "FINISHED"));
    const carried = Object.keys(result.structuredContent as Record<string, unknown>);
    expect(carried.filter((key) => !reserved.includes(key))).toEqual([]);
  });

  it("refuses before writing when a report of the longest ids would not fit", async () => {
    const agentId = `a${"1".repeat(127)}`;
    const runId = `r${"2".repeat(127)}`;
    const longIds = async (p: Policy) => {
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ ...agent, id: agentId }))
        .mockResolvedValueOnce(json({ ...run, id: runId, agentId }))
        .mockResolvedValueOnce(chunked("event: done\ndata: {}\n\n"));
      const { client, server } = await connect(fetchImpl, p);
      try {
        return {
          result: await client.callTool({ name: "cursor_export_run", arguments: { agentId, runId } }),
          fetchImpl,
        };
      } finally {
        await client.close();
        await server.close();
      }
    };
    const tight = await root();
    const refused = await longIds(policyFor(tight));
    expect(refused.result.isError).toBe(true);
    expect(JSON.stringify(refused.result.content)).toContain("maxResponseBytes");
    // Nothing was written, and the stream was never opened.
    expect(refused.fetchImpl).toHaveBeenCalledTimes(2);
    expect(await readdir(tight)).toEqual([]);
    const roomy = await root();
    const allowed = await longIds({ ...policyFor(roomy), maxResponseBytes: 4096 });
    expect(allowed.result.isError).not.toBe(true);
    // The same ids report every required field once the budget can hold them.
    expect(allowed.result.structuredContent).toMatchObject({
      complete: true,
      dirUnderRoot: agentId,
      rawFile: `${runId}.sse`,
    });
  });

  it("reports a locator that a long configured root cannot clip", async () => {
    const base = await root();
    const deep = join(base, "d".repeat(120), "e".repeat(120));
    await mkdir(deep, { recursive: true });
    const body = "event: done\ndata: {}\n\n";
    const { result } = await exportRun(policyFor(deep), [chunked(body)]);
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      complete: true,
      dirUnderRoot: "bc-1",
      rawFile: "run-1.sse",
      toolsFile: "run-1.tools.json",
      terminalFile: "run-1.terminal.md",
    });
    // The root's length never enters the report, so nothing is clipped to fit it
    // and the preflight has nothing to refuse.
    expect(Buffer.byteLength(JSON.stringify(result.structuredContent))).toBeLessThanOrEqual(1024);
    expect(await readFile(join(deep, "bc-1", "run-1.sse"), "utf8")).toBe(body);
  });

  it("exports a generated multi-megabyte replay of ten thousand events", async () => {
    // Generated with invented content; nothing this size is committed.
    const parts: string[] = [];
    let toolCalls = 0;
    for (let i = 0; i < 9_999; i += 1) {
      if (i % 25 === 0) {
        toolCalls += 1;
        parts.push(
          `event: tool_call\ndata: ${JSON.stringify({
            callId: `call-${i}`,
            name: i % 50 === 0 ? "run_terminal_cmd" : "read_file",
            status: "completed",
            args: { command: `printf 'line ${i}'` },
            result: { success: { stdout: `line ${i}\n`.repeat(8) } },
          })}\n\n`,
        );
        continue;
      }
      parts.push(`id: ${i}\nevent: assistant\ndata: ${"sample narration ".repeat(18)}${i}\n\n`);
    }
    parts.push("event: done\ndata: {}\n\n");
    const body = Buffer.from(parts.join(""), "utf8");
    expect(body.byteLength).toBeGreaterThan(3_000_000);
    const dir = await root();
    const { result } = await exportRun(policyFor(dir), [chunked(body, 8192)]);
    expect(result.structuredContent).toMatchObject({
      complete: true,
      stopReason: "done",
      bytes: body.byteLength,
      persistedBytes: body.byteLength,
      events: 10_000,
      toolCallEvents: toolCalls,
      unparsedToolCalls: 0,
      trailingEvents: 0,
      rawPublished: true,
      toolsPublished: true,
      terminalPublished: true,
    });
    const written = await readFile(join(dir, "bc-1", "run-1.sse"));
    expect(written.equals(body)).toBe(true);
    // The response stays small whatever the replay's size.
    expect(Buffer.byteLength(JSON.stringify(result.content))).toBeLessThanOrEqual(1024);
  });
});
