import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { CursorClient, seg } from "../src/client.js";
import {
  CursorApiError,
  CursorContractError,
  CursorTransportError,
} from "../src/errors.js";

const OK = z.looseObject({ id: z.string() });
const KEY = "sk-test-not-a-real-key-0123456789";

function client(fetchImpl: typeof fetch, extra: Record<string, unknown> = {}) {
  return new CursorClient({
    apiKey: KEY,
    baseUrl: "https://api.example.test",
    fetchImpl,
    sleepImpl: async () => {},
    ...extra,
  });
}

const json = (body: unknown, init: ResponseInit = {}) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
    ...init,
  });

describe("caller cancellation", () => {
  const abortingFetch: typeof fetch = (_u, init) =>
    new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        return;
      }
      init?.signal?.addEventListener("abort", () => {
        reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
      });
    });

  it("is not retried and is not reported as a timeout", async () => {
    const spy = vi.fn(abortingFetch);
    const controller = new AbortController();
    const pending = client(spy).get("/v1/me", OK, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled by the caller/);
    await expect(pending).rejects.not.toThrow(/timed out/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("wakes a backoff sleep when the caller cancels", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: { code: "x" } }, { status: 503 }));
    const controller = new AbortController();
    // A sleep that never resolves on its own: only the abort can end it.
    const never = () => new Promise<void>(() => {});
    const pending = client(spy, { sleepImpl: never }).get("/v1/me", OK, {
      signal: controller.signal,
    });
    await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
    controller.abort();
    await expect(pending).rejects.toThrow(/cancelled by the caller/);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("error body hygiene", () => {
  it("drops a code that is not a machine token and caps the message", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        { error: { code: "Bearer sk-reflected token", message: "m".repeat(5_000) } },
        { status: 400 },
      ),
    );
    const error = (await client(spy)
      .get("/v1/me", OK)
      .catch((e: unknown) => e)) as CursorApiError;
    expect(error).toBeInstanceOf(CursorApiError);
    expect(error.code).toBeUndefined();
    expect(error.message).not.toContain("sk-reflected");
    expect(error.message.length).toBeLessThan(400);
  });

  it("keeps a documented code", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(
      json({ error: { code: "agent_busy", message: "busy" } }, { status: 409 }),
    );
    const error = (await client(spy)
      .get("/v1/me", OK)
      .catch((e: unknown) => e)) as CursorApiError;
    expect(error.code).toBe("agent_busy");
    expect(error.message).toContain("(agent_busy)");
  });

  it("releases the body of a response that declares an oversized length", async () => {
    const cancel = vi.fn(async () => {});
    const body = { cancel, getReader: () => ({ read: async () => ({ done: true }) }) };
    const response = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "5000000" }),
      body,
    } as unknown as Response;
    const spy = vi.fn<typeof fetch>().mockResolvedValue(response);
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(CursorContractError);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});

describe("request shape", () => {
  it("sends Bearer auth to the resolved URL with query params", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "a" }));
    await client(spy).get("/v1/agents", OK, { query: { limit: 20, skip: undefined } });

    const [url, init] = spy.mock.calls[0]!;
    expect(String(url)).toBe("https://api.example.test/v1/agents?limit=20");
    expect((init!.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${KEY}`,
    );
    expect(init!.method).toBe("GET");
    expect(init!.redirect).toBe("error");
    // No body means no Content-Type.
    expect((init!.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("serializes a POST body and sets Content-Type", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "a" }));
    await client(spy).post("/v1/agents", OK, { body: { prompt: { text: "hi" } } });

    const init = spy.mock.calls[0]![1]!;
    expect(init.body).toBe('{"prompt":{"text":"hi"}}');
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/json",
    );
  });

  it("reports a timeout as a transport error", async () => {
    const hang: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
      });
    await expect(
      client(hang, { timeoutMs: 5 }).get("/v1/me", OK),
    ).rejects.toThrow(CursorTransportError);
  });

  it("threads caller cancellation into fetch", async () => {
    const controller = new AbortController();
    const hang: typeof fetch = (_u, init) =>
      new Promise((_resolve, reject) => {
        if (init?.signal?.aborted) {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
          return;
        }
        init?.signal?.addEventListener("abort", () => {
          reject(Object.assign(new Error("aborted"), { name: "AbortError" }));
        });
        controller.abort();
      });
    await expect(
      client(hang).get("/v1/me", OK, { signal: controller.signal }),
    ).rejects.toThrow(CursorTransportError);
  });

  it("labels a write transport failure as outcome unknown", async () => {
    const fail = vi.fn<typeof fetch>().mockRejectedValue(new Error("reset"));
    await expect(client(fail).post("/v1/agents", OK)).rejects.toThrow(
      /outcome is unknown/,
    );
  });

  it("rejects an oversized body before reading it", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(
      new Response("{}", { headers: { "content-length": "4000001" } }),
    );
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(CursorContractError);
  });
});

describe("retry policy", () => {
  it("retries a GET on 500 and succeeds", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({ error: "boom" }, { status: 500 }))
      .mockResolvedValueOnce(json({ id: "a" }));
    await expect(client(spy).get("/v1/me", OK)).resolves.toEqual({ id: "a" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("never retries a POST on 500 -- the write may already have landed", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "boom" }, { status: 500 }));
    await expect(client(spy).post("/v1/agents", OK)).rejects.toThrow(
      CursorApiError,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never retries a DELETE on 500", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "boom" }, { status: 500 }));
    await expect(client(spy).delete("/v1/agents/x", OK)).rejects.toThrow(
      CursorApiError,
    );
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("never retries a POST on 429 without verified idempotency", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ error: "slow down" }, { status: 429, headers: { "retry-after": "0" } }),
      );
    await expect(client(spy).post("/v1/agents", OK)).rejects.toThrow(CursorApiError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("gives up after the retry ceiling", async () => {
    // A fresh Response per call: a body can only be read once, and reusing one
    // instance across retries would fail the second read.
    const spy = vi
      .fn<typeof fetch>()
      .mockImplementation(async () => json({ error: "boom" }, { status: 503 }));
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(CursorApiError);
    expect(spy).toHaveBeenCalledTimes(3); // initial + 2 retries
  });

  it("does not start a retry that would exceed the total deadline", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "boom" }, { status: 503 }));
    await expect(
      client(spy, { totalTimeoutMs: 5 }).get("/v1/me", OK),
    ).rejects.toThrow(/total deadline/);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("gives up when Retry-After exceeds the backoff ceiling", async () => {
    // Retrying sooner than the server asked would only spend the remaining
    // attempts on another 429.
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        json({ error: "slow down" }, { status: 429, headers: { "retry-after": "60" } }),
      );
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(CursorApiError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 429 that means the quota is gone", async () => {
    // usage_limit_exceeded shares its status with rate_limit_exceeded but no
    // amount of waiting clears it, so retrying only burns the attempts.
    const spy = vi.fn<typeof fetch>().mockImplementation(async () =>
      json(
        { error: { code: "usage_limit_exceeded", message: "out of credits" } },
        { status: 429, headers: { "retry-after": "1" } },
      ),
    );
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(CursorApiError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("does not retry the usage-exhausted message sent under rate_limit_exceeded", async () => {
    // Recorded live: an exhausted-usage refusal arrived under the congestion
    // code, so the code alone would have kept an eligible GET retrying.
    const spy = vi.fn<typeof fetch>().mockImplementation(async () =>
      json(
        {
          error: {
            code: "rate_limit_exceeded",
            message:
              "You've used all included Cloud Agent usage: Enable on-demand usage to continue using Cloud Agents",
          },
        },
        { status: 429, headers: { "retry-after": "1" } },
      ),
    );
    const error = (await client(spy)
      .get("/v1/me", OK)
      .catch((e: unknown) => e)) as CursorApiError;
    expect(spy).toHaveBeenCalledTimes(1);
    // The documented wire value is still there for a caller to read.
    expect(error.code).toBe("rate_limit_exceeded");
    expect(error.classification).toBe("usage-limited");
  });

  it.each([
    ["generic congestion", { error: "slow down" }],
    [
      "explicit usage exhaustion",
      { error: { code: "usage_limit_exceeded", message: "out of credits" } },
    ],
    [
      "message-based usage exhaustion",
      {
        error: {
          code: "rate_limit_exceeded",
          message: "You've used all included Cloud Agent usage: Enable on-demand usage",
        },
      },
    ],
  ])("makes one attempt for %s on a POST", async (_label, body) => {
    const spy = vi
      .fn<typeof fetch>()
      .mockImplementation(async () =>
        json(body, { status: 429, headers: { "retry-after": "0" } }),
      );
    await expect(client(spy).post("/v1/agents", OK)).rejects.toThrow(CursorApiError);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it("still retries a 429 that means slow down", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        json(
          { error: { code: "rate_limit_exceeded", message: "slow down" } },
          { status: 429, headers: { "retry-after": "0" } },
        ),
      )
      .mockImplementationOnce(async () => json({ id: "a" }));
    await expect(client(spy).get("/v1/me", OK)).resolves.toEqual({ id: "a" });
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("names the documented error code in the message", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(
      json(
        { error: { code: "agent_busy", message: "a run is already active" } },
        { status: 409 },
      ),
    );
    const error = (await client(spy)
      .post("/v1/agents/x/runs", OK)
      .catch((e: unknown) => e)) as CursorApiError;
    expect(error.code).toBe("agent_busy");
    expect(error.message).toContain("agent_busy");
    expect(error.message).toContain("a run is already active");
  });

  it("does not retry a 4xx that is not 429", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "nope" }, { status: 403 }));
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(CursorApiError);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe("request origin", () => {
  const never = vi.fn<typeof fetch>();

  it.each([
    ["//attacker.example/x", "protocol-relative"],
    ["https://attacker.example/x", "absolute"],
    ["v1/me", "relative"],
  ])("refuses a %s path without sending the key (%s)", async (path) => {
    await expect(client(never).get(path, OK)).rejects.toThrow(
      CursorTransportError,
    );
    expect(never).not.toHaveBeenCalled();
  });

  it.each([
    ["/v1/%2e%2e/%2e%2e/v0/x", "percent-encoded dot segments reach another API version"],
    ["/v1/a/../../v0/x", "plain dot segments"],
    ["/v1/a" + String.fromCharCode(92) + "..", "a backslash is a path separator to URL"],
    ["/v1/me?x=1", "a query belongs in `query`"],
    ["/v1/me#frag", "a fragment silently discards the rest of the path"],
    ["/" + String.fromCharCode(9) + "v1/me", "a tab is stripped during parsing"],
  ])("refuses %s (%s)", async (path) => {
    const never = vi.fn<typeof fetch>();
    await expect(client(never).get(path, OK)).rejects.toThrow(
      CursorTransportError,
    );
    expect(never).not.toHaveBeenCalled();
  });

  it("accepts an already-normalized path unchanged", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "a" }));
    await client(spy).get("/v1/agents/bc-123/runs", OK);
    expect(String(spy.mock.calls[0]![0])).toBe(
      "https://api.example.test/v1/agents/bc-123/runs",
    );
  });

  it("encodes a path segment so an id cannot change the endpoint", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "a" }));
    await client(spy).get(`/v1/agents/${seg("../../v0/agents/x")}`, OK);
    expect(String(spy.mock.calls[0]![0])).toBe(
      "https://api.example.test/v1/agents/..%2F..%2Fv0%2Fagents%2Fx",
    );
  });

  it("encodes a path segment so an id cannot inject a query parameter", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "a" }));
    await client(spy).get(`/v1/agents/${seg("x?limit=1")}`, OK);
    const url = new URL(String(spy.mock.calls[0]![0]));
    expect(url.searchParams.get("limit")).toBeNull();
  });
});

describe("diagnostics", () => {
  it("sends no Content-Type on a bodiless POST", async () => {
    // Cursor's archive endpoint returns 500 for an empty body sent with
    // Content-Type: application/json, so a bodiless POST must send neither.
    const spy = vi.fn<typeof fetch>().mockResolvedValue(json({ id: "a" }));
    await client(spy).post("/v1/agents/x/archive", OK);
    const init = spy.mock.calls[0]![1]!;
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
    expect(init.body).toBeUndefined();
  });
});

describe("Retry-After parsing (RFC 9110 delay-seconds / HTTP-date)", () => {
  /** Returns how long the client waited before its single retry. */
  async function waitFor(header: string): Promise<number | "no retry"> {
    let waited: number | "no retry" = "no retry";
    const spy = vi
      .fn<typeof fetch>()
      .mockImplementationOnce(async () =>
        json({ error: "slow" }, { status: 429, headers: { "retry-after": header } }),
      )
      .mockImplementationOnce(async () => json({ id: "a" }));
    await client(spy, { sleepImpl: async (ms: number) => { waited = ms; } })
      .get("/v1/me", OK)
      .catch(() => undefined);
    return waited;
  }

  it("accepts plain delay-seconds and honours them exactly", async () => {
    expect(await waitFor("5")).toBe(5_000);
    expect(await waitFor("0")).toBe(0);
    // 12s exceeds the 8s ceiling, so the client gives up rather than retry early.
    expect(await waitFor("12")).toBe("no retry");
  });

  it.each([
    ["a negative value", "-5"],
    ["a decimal", "1.5"],
    ["hexadecimal", "0x10"],
    ["scientific notation", "1e3"],
    ["a bare word", "soon"],
  ])("ignores %s rather than turning it into an instant retry", async (_l, header) => {
    // Number() accepts most of these, and anything it rejected used to fall
    // through to Date.parse, which read "-5" as a past date and yielded 0 ms --
    // an immediate retry against a server that just said it was overloaded.
    const waited = await waitFor(header);
    expect(waited).not.toBe(0);
    // Falls back to our own jittered backoff instead.
    expect(typeof waited).toBe("number");
    expect(waited as number).toBeGreaterThan(0);
  });

  it("accepts an HTTP-date in the future", async () => {
    const waited = await waitFor("Wed, 21 Oct 2115 07:28:00 GMT");
    // Far future exceeds the ceiling, so the client gives up rather than retry.
    expect(waited).toBe("no retry");
  });

  it("treats a past HTTP-date as retry now, which is what it means", async () => {
    expect(await waitFor("Sunday, 06-Nov-94 08:49:37 GMT")).toBe(0);
  });
});

describe("response body limits", () => {
  it("refuses to parse an absurdly large body", async () => {
    // Deep nesting is a stack-overflow hazard for any recursive consumer, and
    // JSON.parse itself has no depth limit to stop it.
    const huge = `{"id":"a","pad":"${"x".repeat(4_000_001)}"}`;
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(huge, { status: 200 }));
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(
      /response-byte limit/,
    );
  });

  it("reports an empty 200 as empty, not as a pile of missing fields", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("", { status: 200 }));
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(
      /200 with an empty body/,
    );
  });

  it("still accepts a bodiless 204", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response(null, { status: 204 }));
    await expect(
      client(spy).delete("/v1/agents/x", z.looseObject({})),
    ).resolves.toEqual({});
  });
});

describe("credential containment", () => {
  it("keeps the key out of API errors", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ error: "denied" }, { status: 401 }));
    const error = await client(spy)
      .get("/v1/me", OK)
      .catch((e: unknown) => e as Error);
    expect(`${error.message}${error.stack ?? ""}`).not.toContain(KEY);
  });

  it("keeps the key out of transport errors, including the fetch cause", async () => {
    const boom: typeof fetch = () => {
      // A real fetch failure can carry the whole request, key included.
      throw Object.assign(new Error(`connect failed Bearer ${KEY}`), {
        cause: `Bearer ${KEY}`,
      });
    };
    const error = await client(boom)
      .get("/v1/me", OK)
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(CursorTransportError);
    expect(`${error.message}${error.stack ?? ""}`).not.toContain(KEY);
  });
});

describe("response contract", () => {
  it("preserves unknown fields rather than dropping them", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ id: "a", brandNewField: 42 }));
    await expect(client(spy).get("/v1/me", OK)).resolves.toEqual({
      id: "a",
      brandNewField: 42,
    });
  });

  it("fails when a contract-required field is missing", async () => {
    const spy = vi.fn<typeof fetch>().mockResolvedValue(json({ notId: "a" }));
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(
      CursorContractError,
    );
  });

  it("fails on a non-JSON body", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("<html>gateway</html>", { status: 200 }));
    await expect(client(spy).get("/v1/me", OK)).rejects.toThrow(
      CursorContractError,
    );
  });

  it("times out a response whose body never arrives", async () => {
    // Headers, then a stream that neither delivers nor closes. The stream errors
    // on abort, mirroring how undici tears a real body down, so this asserts the
    // abort timer is still live during the body read. Before that fix the timer
    // was cleared once headers arrived and the call hung forever, taking the
    // caller's whole turn with it.
    const stall: typeof fetch = async (_url, init) =>
      new Response(
        new ReadableStream({
          start(controller) {
            init?.signal?.addEventListener("abort", () => {
              controller.error(
                Object.assign(new Error("aborted"), { name: "AbortError" }),
              );
            });
          },
        }),
        { status: 200 },
      );
    await expect(
      client(stall, { timeoutMs: 20 }).get("/v1/me", OK),
    ).rejects.toThrow(CursorTransportError);
  });

  it("does not report a failed body read as an empty success", async () => {
    // A reset mid-body used to become `{}`, which a permissive schema accepts --
    // so a failed read looked like a successful empty response.
    const reset: typeof fetch = async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.error(new Error("connection reset"));
          },
        }),
        { status: 200 },
      );
    const error = await client(reset)
      .get("/v1/me", z.looseObject({}))
      .catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(CursorTransportError);
    expect(error.message).toContain("the outcome is unknown");
  });

  it("still accepts a legitimately empty success body", async () => {
    const empty: typeof fetch = async () => new Response(null, { status: 204 });
    await expect(
      client(empty).delete("/v1/agents/x", z.looseObject({})),
    ).resolves.toEqual({});
  });

  it("truncates a long upstream error body", async () => {
    const spy = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("x".repeat(5000), { status: 400 }));
    const error = (await client(spy)
      .get("/v1/me", OK)
      .catch((e: unknown) => e)) as CursorApiError;
    expect(error.message.length).toBeLessThan(400);
  });
});
