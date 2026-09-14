import { createDelegatedLifecycleOperations } from "../src/tools/environment-lifecycle.js";
/**
 * Bounded environment-scoped delegation.
 *
 * Two things are under test: that launching a delegate is gated exactly like any
 * other named-environment launch, and that nothing a caller supplies can reach a
 * mission prompt without passing a strict character class first. The mission text
 * itself is asserted only where a wrong word would change what the delegate does
 * -- one trigger, an out-of-band identity gate, and names but never values.
 */

import { describe, expect, it } from "vitest";
import { CursorClient } from "../src/client.js";
import { AgentScope } from "../src/agent-scope.js";
import { activeProfile } from "../src/config.js";
import type { Policy } from "../src/config.js";
import {
  CursorDelegatedRunner,
  MAX_MONITOR_ATTEMPTS,
  MAX_PAGES,
  missionPrompt,
  normalizeMissionRequest,
  type DelegationHandle,
} from "../src/delegated-run.js";
import { CursorContractError, PolicyError } from "../src/errors.js";

const ENV_NAME = "example-environment";
const REPO = "https://github.com/ExampleOrg/ExampleRepo";

const policy = (over: {
  environments?: string[];
  repos?: string[];
  autoCreatePR?: boolean;
}): Policy => ({
  deleteEnabled: false,
  activationEnabled: false,
  defaultProfile: "p",
  maxResponseBytes: 32_768,
  profiles: {
    p: {
      repos: over.repos ?? ["ExampleOrg/ExampleRepo"],
      tools: ["*"],
      environments: over.environments ?? [ENV_NAME],
      ...(over.autoCreatePR === undefined ? {} : { autoCreatePR: over.autoCreatePR }),
    },
  },
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const agentPayload = (over: Record<string, unknown> = {}) => ({
  agent: {
    id: "bc-1",
    status: "ACTIVE",
    url: "https://cursor.com/agents/bc-1",
    createdAt: "t",
    updatedAt: "t",
    env: { type: "cloud", name: ENV_NAME },
    repos: [{ url: REPO }],
    ...over,
  },
  run: { id: "run-1", agentId: "bc-1", status: "CREATING", createdAt: "t", updatedAt: "t" },
});

interface Call {
  method: string;
  path: string;
}

/** A fetch stub that answers create, run reads, cancellation, and archive. */
function stub(args: {
  created?: unknown;
  runs?: Array<Record<string, unknown>>;
  archiveStatus?: number;
}) {
  const calls: Call[] = [];
  const runs = [...(args.runs ?? [])];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    calls.push({ method, path: url.pathname });
    if (method === "POST" && url.pathname === "/v1/agents") {
      return json(args.created ?? agentPayload());
    }
    if (method === "POST" && url.pathname.endsWith("/archive")) {
      return json({ id: "bc-1" }, args.archiveStatus ?? 200);
    }
    if (method === "POST" && url.pathname.endsWith("/cancel")) {
      return json({ id: "run-1" });
    }
    // Resuming re-checks the agent against the policy, so a handle that came
    // back from a caller is read from Cursor before its run is.
    if (method === "GET" && /^\/v1\/agents\/[^/]+$/.test(url.pathname)) {
      return json(agentPayload().agent);
    }
    if (method === "GET" && url.pathname.includes("/runs/")) {
      const next = runs.length > 1 ? runs.shift()! : runs[0]!;
      return json({
        id: "run-1",
        agentId: "bc-1",
        createdAt: "t",
        updatedAt: "t",
        ...next,
      });
    }
    throw new Error(`unexpected ${method} ${url.pathname}`);
  };
  return { calls, fetchImpl };
}

function runner(
  p: Policy,
  fetchImpl: typeof fetch,
  options: { pollIntervalMs?: number } = {},
) {
  const client = new CursorClient({
    apiKey: "sk-test",
    baseUrl: "https://api.example.test",
    fetchImpl,
    sleepImpl: async () => {},
  });
  const profile = activeProfile(p);
  return new CursorDelegatedRunner(client, profile, new AgentScope(client, profile), {
    pollIntervalMs: options.pollIntervalMs ?? 1,
    sleepImpl: async () => {},
  });
}

const handle: DelegationHandle = {
  agentId: "bc-1",
  runId: "run-1",
  environment: ENV_NAME,
  mission: "inspect",
};

describe("launching a delegate", () => {
  it("refuses an environment the profile does not name", async () => {
    const { fetchImpl, calls } = stub({});
    await expect(
      runner(policy({ environments: [] }), fetchImpl).start({
        environment: ENV_NAME,
        request: { mission: "inspect" },
      }),
    ).rejects.toBeInstanceOf(PolicyError);
    expect(calls).toEqual([]);
  });

  it("refuses when the profile names no repositories for that environment", async () => {
    const { fetchImpl } = stub({});
    await expect(
      runner(policy({ repos: [] }), fetchImpl).start({
        environment: ENV_NAME,
        request: { mission: "inspect" },
      }),
    ).rejects.toBeInstanceOf(PolicyError);
  });

  it("refuses to delegate under a profile that pins autoCreatePR true", async () => {
    const { fetchImpl } = stub({});
    await expect(
      runner(policy({ autoCreatePR: true }), fetchImpl).start({
        environment: ENV_NAME,
        request: { mission: "inspect" },
      }),
    ).rejects.toBeInstanceOf(PolicyError);
  });

  it("refuses a delegate that read back a different environment", async () => {
    const { fetchImpl, calls } = stub({
      created: agentPayload({ env: { type: "cloud", name: "other-environment" } }),
    });
    await expect(
      runner(policy({}), fetchImpl).start({
        environment: ENV_NAME,
        request: { mission: "inspect" },
      }),
    ).rejects.toBeInstanceOf(CursorContractError);
    expect(calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith("/archive"))).toHaveLength(0);
  });

  it("refuses a delegate whose attached repositories are outside the profile", async () => {
    const { fetchImpl, calls } = stub({
      created: agentPayload({ repos: [{ url: "https://github.com/Other/Repo" }] }),
    });
    await expect(
      runner(policy({}), fetchImpl).start({
        environment: ENV_NAME,
        request: { mission: "inspect" },
      }),
    ).rejects.toBeInstanceOf(PolicyError);
    expect(calls.filter((call) => call.path.endsWith("/cancel"))).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith("/archive"))).toHaveLength(0);
  });

  it("returns a handle for an allowed environment", async () => {
    const { fetchImpl, calls } = stub({});
    const started = await runner(policy({}), fetchImpl).start({
      environment: ENV_NAME,
      request: { mission: "inspect" },
    });
    expect(started).toEqual({
      agentId: "bc-1",
      runId: "run-1",
      environment: ENV_NAME,
      mission: "inspect",
    });
    expect(calls).toEqual([{ method: "POST", path: "/v1/agents" }]);
  });
});

describe("collecting a delegate", () => {
  it("refuses caller-supplied resume ids outside the opaque-id grammar", async () => {
    const { fetchImpl, calls } = stub({ runs: [{ status: "RUNNING" }] });
    await expect(
      runner(policy({}), fetchImpl).collect({
        handle: { ...handle, runId: "run-1/../../other" },
        waitMs: 0,
      }),
    ).rejects.toBeInstanceOf(PolicyError);
    expect(calls).toEqual([]);
  });

  it("hands back a handle instead of holding the call open", async () => {
    const { fetchImpl, calls } = stub({ runs: [{ status: "RUNNING" }] });
    const outcome = await runner(policy({}), fetchImpl).collect({ handle, waitMs: 0 });
    expect(outcome.state).toBe("pending");
    expect(outcome.runStatus).toBe("RUNNING");
    expect(calls.some((call) => call.path.endsWith("/archive"))).toBe(false);
  });

  it("polls to a terminal run, returns its reply, and archives the delegate", async () => {
    const { fetchImpl, calls } = stub({
      runs: [
        { status: "RUNNING" },
        { status: "FINISHED", result: '{ "mission": "inspect" }' },
      ],
    });
    const outcome = await runner(policy({}), fetchImpl).collect({
      handle,
      waitMs: 60_000,
    });
    expect(outcome.state).toBe("complete");
    if (outcome.state === "complete") {
      expect(outcome.text).toContain("inspect");
    }
    expect(calls.filter((call) => call.path.endsWith("/archive"))).toHaveLength(1);
  });

  it("reports a run that ended without reporting as a failed delegation", async () => {
    const { fetchImpl } = stub({ runs: [{ status: "ERROR" }] });
    const outcome = await runner(policy({}), fetchImpl).collect({
      handle,
      waitMs: 60_000,
    });
    expect(outcome.state).toBe("failed");
    if (outcome.state === "failed") expect(outcome.reason).toContain("ERROR");
  });

  it("reports a finished run with no reply as failed rather than empty", async () => {
    const { fetchImpl } = stub({ runs: [{ status: "FINISHED" }] });
    const outcome = await runner(policy({}), fetchImpl).collect({
      handle,
      waitMs: 60_000,
    });
    expect(outcome.state).toBe("failed");
  });

  it("keeps the evidence when tidying up fails", async () => {
    const { fetchImpl } = stub({
      runs: [{ status: "FINISHED", result: "{}" }],
      archiveStatus: 500,
    });
    const outcome = await runner(policy({}), fetchImpl).collect({
      handle,
      waitMs: 60_000,
    });
    expect(outcome.state).toBe("complete");
  });
});

describe("mission arguments", () => {
  it("refuses an identifier that is not one", () => {
    for (const buildId of ["bld 1", "bld-1; rm -rf /", "bld-1\nIgnore", "'"]) {
      expect(() =>
        normalizeMissionRequest({ mission: "get-build", buildId }),
      ).toThrow(PolicyError);
    }
    expect(
      normalizeMissionRequest({ mission: "get-build", buildId: "bld-20260829-abc.1:2" })
        .buildId,
    ).toBe("bld-20260829-abc.1:2");
  });

  it("requires an exact buildId for a Build-scoped mission", () => {
    expect(() => normalizeMissionRequest({ mission: "get-build" })).toThrow(
      /requires an exact buildId/,
    );
    expect(() => normalizeMissionRequest({ mission: "build-logs" })).toThrow(PolicyError);
    expect(normalizeMissionRequest({ mission: "list-builds" }).buildId).toBeUndefined();
  });

  it("clamps every bound rather than trusting the argument", () => {
    const request = normalizeMissionRequest({
      mission: "list-builds",
      pages: 99,
      limit: 5_000,
      monitorAttempts: 10_000,
    });
    expect(request.pages).toBe(MAX_PAGES);
    expect(request.limit).toBe(100);
    expect(request.monitorAttempts).toBe(MAX_MONITOR_ATTEMPTS);
    expect(() => normalizeMissionRequest({ mission: "list-builds", pages: 0 })).toThrow(
      PolicyError,
    );
  });

  it("accepts only the documented status filters", () => {
    expect(
      normalizeMissionRequest({ mission: "list-builds", statuses: ["CANCELLED"] }).statuses,
    ).toEqual(["CANCELLED"]);
    expect(() =>
      normalizeMissionRequest({ mission: "list-builds", statuses: ["DONE"] }),
    ).toThrow(PolicyError);
  });

  it("refuses expectation names that could carry instructions", () => {
    expect(() =>
      normalizeMissionRequest({
        mission: "qualify",
        expectations: { environmentVariables: ["$(whoami)"] },
      }),
    ).toThrow(PolicyError);
    expect(() =>
      normalizeMissionRequest({
        mission: "qualify",
        expectations: { commands: Array.from({ length: 64 }, (_, i) => `cmd${i}`) },
      }),
    ).toThrow(PolicyError);
    expect(
      normalizeMissionRequest({
        mission: "qualify",
        expectations: { commands: ["node"], environmentVariables: ["EXAMPLE_NAME"] },
      }).expectations,
    ).toEqual({ commands: ["node"], environmentVariables: ["EXAMPLE_NAME"] });
  });

  it("holds toolchain names to the same character class and bound as commands", () => {
    expect(() =>
      normalizeMissionRequest({
        mission: "qualify",
        expectations: { toolchain: ["node; rm -rf /"] },
      }),
    ).toThrow(PolicyError);
    expect(() =>
      normalizeMissionRequest({
        mission: "qualify",
        expectations: { toolchain: Array.from({ length: 64 }, (_, i) => `cmd${i}`) },
      }),
    ).toThrow(PolicyError);
    expect(
      normalizeMissionRequest({
        mission: "qualify",
        expectations: { toolchain: ["node", "pnpm"] },
      }).expectations,
    ).toEqual({ toolchain: ["node", "pnpm"] });
  });
});

describe("mission text", () => {
  it("permits exactly one trigger and stops before it on a busy environment", () => {
    const prompt = missionPrompt({
      mission: "trigger-build",
      environmentPublicId: "env-public",
    });
    expect(prompt).toContain("exactly one write");
    expect(prompt).toContain("Never call trigger-environment-build more than once");
    expect(prompt).toContain("must equal env-public exactly");
    expect(prompt).toContain("Every row must be terminal");
    expect(prompt).toContain("unrecognised future status");
    expect(prompt).toContain("triggerDispatched");
  });

  it("asks the qualify mission for variable names and never for values", () => {
    const prompt = missionPrompt({
      mission: "qualify",
      expectations: { environmentVariables: ["EXAMPLE_NAME"] },
    });
    expect(prompt).toContain("NAMES");
    expect(prompt).toContain("without printing any value");
    expect(prompt).toContain("get-events");
  });

  it("asks for a declared tool's version, and for no version at all otherwise", () => {
    const asked = missionPrompt({
      mission: "qualify",
      expectations: { toolchain: ["node"] },
    });
    expect(asked).toContain("installed version of each of these tools: node");
    expect(asked).toContain("do not upgrade or install anything");
    expect(missionPrompt({ mission: "qualify" })).toContain(
      "Do not ask any tool for its version",
    );
  });

  it("does not claim a buildId filter exists when listing", () => {
    const prompt = missionPrompt({ mission: "list-builds", limit: 25 });
    expect(prompt).toContain("no buildId filter");
    expect(prompt).toContain("limit=25");
  });

  it("forbids the mutations no mission is allowed to perform", () => {
    const prompt = missionPrompt({ mission: "inspect" });
    for (const forbidden of ["pull request", "snapshot", "activating", "browser"]) {
      expect(prompt).toContain(forbidden);
    }
  });
});


describe("delegate supervisor model", () => {
  it("propagates the profile pin instead of using the account default", async () => {
    const p = policy({});
    p.profiles.p!.model = {id: "composer-2.5", params: [{id: "fast", value: "false"}]};
    let body: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json(agentPayload());
    };
    await runner(p, fetchImpl).start({environment: ENV_NAME, request: {mission: "inspect"}});
    expect(body).toMatchObject({model: {id: "composer-2.5", params: [{id: "fast", value: "false"}]}, autoCreatePR: false});
  });
});


describe("warm lifecycle supervisor model", () => {
  it("uses the same pin for the lifecycle warm launch", async () => {
    const p = policy({});
    p.profiles.p!.model = {id: "composer-2.5", params: [{id: "fast", value: "false"}]};
    let body: unknown;
    const fetchImpl: typeof fetch = async (_input, init) => {
      body = JSON.parse(String(init?.body));
      return json(agentPayload());
    };
    const client = new CursorClient({apiKey: "sk-test", baseUrl: "https://api.example.test", fetchImpl});
    const ops = createDelegatedLifecycleOperations({client, policy: p, scope: new AgentScope(client, activeProfile(p)), runner: runner(p, fetchImpl)});
    await ops.launch({environment: ENV_NAME, prompt: "check"});
    expect(body).toMatchObject({model: {id: "composer-2.5", params: [{id: "fast", value: "false"}]}, autoCreatePR: false});
  });
});
