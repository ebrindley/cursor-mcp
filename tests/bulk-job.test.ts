/**
 * Bulk archive/unarchive jobs: pacing, scope, backoff, and honest outcomes.
 *
 * Runs against a fake Cursor API under fake timers, so a job that paces itself
 * over minutes finishes in milliseconds and every request carries the virtual
 * time it was sent at.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentScope } from "../src/agent-scope.js";
import { type BulkJob, BulkJobs } from "../src/bulk-job.js";
import { CursorClient } from "../src/client.js";
import { activeProfile, BulkSchema, type BulkSettings, type Policy } from "../src/config.js";
import { registerBulkTools } from "../src/tools/bulk.js";

const REPO = "https://github.com/ExampleOrg/ExampleRepo";

const policy = (tools: string[], bulk?: Partial<BulkSettings>): Policy => ({
  deleteEnabled: false,
  activationEnabled: false,
  defaultProfile: "p",
  maxResponseBytes: 32_768,
  profiles: { p: { repos: ["ExampleOrg/ExampleRepo"], tools } },
  ...(bulk === undefined ? {} : { bulk: BulkSchema.parse(bulk) }),
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });

const record = (id: string, repos: string[] | null = [REPO]) => ({
  id,
  status: "FINISHED",
  url: `https://cursor.com/agents/${id}`,
  createdAt: "t",
  updatedAt: "t",
  ...(repos === null ? {} : { repos: repos.map((url) => ({ url })) }),
});

const rateLimited = (retryAfterS?: number) =>
  json(
    { error: { code: "rate_limit_exceeded", message: "You have exceeded the rate limit" } },
    429,
    retryAfterS === undefined ? {} : { "retry-after": String(retryAfterS) },
  );

interface Call {
  method: string;
  id: string;
  at: number;
}

/** A fake Cursor API. `get`/`post` decide per agent and per attempt number. */
function fakeCursor(handlers: {
  get?: (id: string, n: number) => Response | Promise<Response>;
  post?: (id: string, n: number, signal?: AbortSignal) => Response | Promise<Response>;
} = {}) {
  const calls: Call[] = [];
  const counts = new Map<string, number>();
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    const [, , , id, action] = url.pathname.split("/");
    const key = `${method} ${id}`;
    const n = (counts.get(key) ?? 0) + 1;
    counts.set(key, n);
    calls.push({ method, id: id!, at: Date.now() });
    if (method === "GET") return (handlers.get ?? ((i) => json(record(i))))(id!, n);
    return (handlers.post ?? ((i) => json({ id: i })))(id!, n, init?.signal ?? undefined);
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, calls };
}

function setup(fake: ReturnType<typeof fakeCursor>, bulk: Partial<BulkSettings> = {}) {
  const p = policy(["*"], bulk);
  const client = new CursorClient({
    apiKey: "sk-test",
    baseUrl: "https://api.example.test",
    fetchImpl: fake.fetchImpl,
  });
  return new BulkJobs(client, new AgentScope(client, activeProfile(p)), BulkSchema.parse(bulk));
}

async function finish(job: BulkJob, stepMs = 250) {
  for (let i = 0; i < 100_000 && !job.finished; i += 1) {
    await vi.advanceTimersByTimeAsync(stepMs);
  }
  expect(job.finished).toBe(true);
}

/** Largest number of calls inside any 60-second window. */
function peakPerMinute(times: number[]): number {
  let peak = 0;
  for (let i = 0; i < times.length; i += 1) {
    const inWindow = times.filter((t) => t >= times[i]! && t < times[i]! + 60_000).length;
    peak = Math.max(peak, inWindow);
  }
  return peak;
}

const ids = (n: number, prefix = "bc-") => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a bulk job", () => {
  it("archives every allowed agent from one start, under the configured rates", async () => {
    const fake = fakeCursor();
    const job = setup(fake, { writesPerMinute: 20, readsPerMinute: 30 }).start("archive", ids(50));
    await finish(job);

    expect(job.state).toBe("completed");
    expect(job.snapshot().counts.done).toBe(50);
    const posts = fake.calls.filter((c) => c.method === "POST").map((c) => c.at);
    const gets = fake.calls.filter((c) => c.method === "GET").map((c) => c.at);
    expect(posts).toHaveLength(50);
    expect(peakPerMinute(posts)).toBeLessThanOrEqual(20);
    expect(peakPerMinute(gets)).toBeLessThanOrEqual(30);
  });

  it("processes a repeated id once", async () => {
    const fake = fakeCursor();
    const job = setup(fake).start("unarchive", ["bc-1", "bc-1", "bc-2"]);
    await finish(job);
    expect(job.items.map((i) => i.agentId)).toEqual(["bc-1", "bc-2"]);
    expect(job.duplicatesIgnored).toBe(1);
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("posts nothing for denied, unresolved, or mismatched records", async () => {
    const fake = fakeCursor({
      get: (id) =>
        id === "bc-denied"
          ? json(record(id, ["https://github.com/someone/else"]))
          : id === "bc-thin"
            ? json(record(id, null))
            : json(record("bc-other")),
    });
    const job = setup(fake).start("archive", ["bc-denied", "bc-thin", "bc-swapped"]);
    await finish(job);
    expect(job.items.map((i) => [i.state, i.code])).toEqual([
      ["denied", "POLICY_DENIED"],
      ["unresolved", "SCOPE_UNRESOLVED"],
      ["failed", "IDENTITY_MISMATCH"],
    ]);
    expect(fake.calls.some((c) => c.method === "POST")).toBe(false);
  });

  it("waits out a Retry-After, re-reads scope, and retries the POST", async () => {
    const fake = fakeCursor({ post: (id, n) => (n === 1 ? rateLimited(30) : json({ id })) });
    const job = setup(fake).start("archive", ["bc-1"]);
    await finish(job);

    expect(job.items[0]).toMatchObject({ state: "done" });
    const [firstPost, secondPost] = fake.calls.filter((c) => c.method === "POST");
    expect(secondPost!.at - firstPost!.at).toBeGreaterThanOrEqual(30_000);
    expect(fake.calls.map((c) => c.method)).toEqual(["GET", "POST", "GET", "POST"]);
    expect(job.snapshot().attempts.rateLimited).toBe(1);
  });

  it("fails an agent that stays rate limited past the retry limit", async () => {
    const fake = fakeCursor({ post: () => rateLimited(1) });
    const job = setup(fake, { maxRateLimitRetries: 2 }).start("archive", ["bc-1"]);
    await finish(job);
    expect(job.items[0]).toMatchObject({ state: "failed", code: "RATE_LIMITED", httpStatus: 429 });
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(3);
  });

  it("retries a transient scope read itself, one request per attempt", async () => {
    const fake = fakeCursor({
      get: (id, n) => (n <= 2 ? json({ error: { code: "unavailable" } }, 503) : json(record(id))),
    });
    const job = setup(fake).start("archive", ["bc-1"]);
    await finish(job);
    expect(job.items[0]!.state).toBe("done");
    // Three GETs, not nine: the client's own retries are off for job requests.
    expect(fake.calls.filter((c) => c.method === "GET")).toHaveLength(3);
  });

  it("stops the job on usage exhaustion and submits nothing further", async () => {
    const fake = fakeCursor({
      post: (id) =>
        id === "bc-0"
          ? json({ error: { code: "usage_limit_exceeded", message: "usage exhausted" } }, 429)
          : json({ id }),
    });
    const job = setup(fake, { maxInFlight: 1 }).start("archive", ids(4));
    await finish(job);
    expect(job.state).toBe("stopped");
    expect(job.stopReason).toBe("usage-exhausted");
    expect(job.items[0]).toMatchObject({ state: "failed", code: "USAGE_EXHAUSTED" });
    expect(job.items.slice(1).map((i) => [i.state, i.code])).toEqual(
      Array(3).fill(["notSubmitted", "USAGE_EXHAUSTED"]),
    );
  });

  it("reports a POST with no usable answer as uncertain, not failed", async () => {
    const fake = fakeCursor({
      post: (id) => {
        if (id === "bc-lost") throw new TypeError("fetch failed");
        return json({ error: { code: "internal" } }, 500);
      },
    });
    const job = setup(fake).start("archive", ["bc-lost", "bc-500"]);
    await finish(job);
    expect(job.items.map((i) => [i.state, i.code, i.httpStatus])).toEqual([
      ["uncertain", "OUTCOME_UNKNOWN", undefined],
      ["uncertain", "SERVER_ERROR", 500],
    ]);
    // Never re-sent automatically.
    expect(fake.calls.filter((c) => c.method === "POST")).toHaveLength(2);
  });

  it("on cancel stops admitting agents and keeps completed ones", async () => {
    const fake = fakeCursor();
    const job = setup(fake, { writesPerMinute: 6, maxInFlight: 1 }).start("archive", ids(10));
    await vi.advanceTimersByTimeAsync(25_000);
    job.cancel();
    await finish(job);
    const { counts } = job.snapshot();
    expect(job.state).toBe("cancelled");
    expect(counts.done).toBeGreaterThan(0);
    expect(counts.done + counts.notSubmitted).toBe(10);
    expect(job.items.filter((i) => i.state === "notSubmitted").every((i) => i.code === "CANCELLED")).toBe(true);
  });

  it("marks a POST cut off by shutdown uncertain", async () => {
    const fake = fakeCursor({
      post: (_id, _n, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
        }),
    });
    const jobs = setup(fake);
    const job = jobs.start("archive", ["bc-1", "bc-2"]);
    await vi.advanceTimersByTimeAsync(100);
    jobs.close();
    await finish(job);
    expect(job.stopReason).toBe("shutdown");
    expect(job.items.every((i) => i.state === "uncertain" && i.code === "OUTCOME_UNKNOWN")).toBe(true);
  });

  it("allows one running job per server", async () => {
    const jobs = setup(fakeCursor(), { writesPerMinute: 1 });
    const first = jobs.start("archive", ids(3));
    expect(() => jobs.start("archive", ["bc-9"])).toThrow(/still running/);
    first.cancel();
    await finish(first);
    expect(() => jobs.start("archive", ["bc-9"])).not.toThrow();
  });
});

describe("the bulk tools", () => {
  async function connect(p: Policy, fetchImpl: typeof fetch) {
    const server = new McpServer({ name: "cursor-mcp", version: "test" });
    const cursor = new CursorClient({ apiKey: "sk-test", baseUrl: "https://api.example.test", fetchImpl });
    const registered = registerBulkTools(server, cursor, p, new AgentScope(cursor, activeProfile(p)));
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "test" });
    await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
    return { client, registered };
  }

  it("register start and cancel only when the profile lists them", async () => {
    const server = new McpServer({ name: "cursor-mcp", version: "test" });
    const cursor = new CursorClient({ apiKey: "sk-test", baseUrl: "https://api.example.test", fetchImpl: fakeCursor().fetchImpl });
    const p = policy(["read:*"]);
    expect(registerBulkTools(server, cursor, p, new AgentScope(cursor, activeProfile(p)))).toEqual([
      "cursor_get_bulk_job",
    ]);
  });

  it("start returns a job id at once and status reports per-agent results", async () => {
    const { client } = await connect(policy(["*"]), fakeCursor().fetchImpl);
    const started = await client.callTool({
      name: "cursor_start_bulk_job",
      arguments: { action: "archive", agentIds: ["bc-1", "bc-2"] },
    });
    expect(started.isError).toBeFalsy();
    const jobId = (started.structuredContent as { jobId: string }).jobId;
    expect(jobId).toMatch(/^bulk-/);

    await vi.advanceTimersByTimeAsync(10_000);
    const status = await client.callTool({ name: "cursor_get_bulk_job", arguments: { jobId } });
    const s = status.structuredContent as { state: string; counts: { done: number }; items: unknown[] };
    expect(s.state).toBe("completed");
    expect(s.counts.done).toBe(2);
    expect(s.items).toHaveLength(2);
  });

  it("status for an unknown job says jobs do not survive a restart", async () => {
    const { client } = await connect(policy(["*"]), fakeCursor().fetchImpl);
    const result = await client.callTool({
      name: "cursor_get_bulk_job",
      arguments: { jobId: "bulk-00000000-0000-0000-0000-000000000000" },
    });
    expect(result.isError).toBe(true);
    expect((result.content as Array<{ text: string }>)[0]!.text).toContain("restart");
  });
});
