import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { Profile } from "../src/config.js";
import {
  READ_ONLY_POLICY,
  isToolAllowed,
  loadPolicy,
  readApiKey,
} from "../src/config.js";
import { ConfigError } from "../src/errors.js";

async function policyFile(contents: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-test-"));
  const path = join(dir, "policy.json");
  await writeFile(path, contents, "utf8");
  return path;
}

describe("loadPolicy", () => {
  it("degrades to read-only when no policy file exists", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-test-"));
    await expect(loadPolicy(join(dir, "absent.json"))).resolves.toEqual(
      READ_ONLY_POLICY,
    );
  });

  it("keeps delete disabled by default", async () => {
    const path = await policyFile(
      '{"defaultProfile":"p","profiles":{"p":{"tools":["read:*"]}}}',
    );
    const policy = await loadPolicy(path);
    expect(policy.deleteEnabled).toBe(false);
    expect(policy.activationEnabled).toBe(false);
  });

  it("accepts and trims an environment allowlist on a profile", async () => {
    const path = await policyFile(
      '{"defaultProfile":"p","profiles":{"p":{"tools":["read:*"],"environments":[" prod "]}}}',
    );
    const policy = await loadPolicy(path);
    expect(policy.profiles.p?.environments).toEqual(["prod"]);
  });

  it("accepts a structured environment binding alongside a legacy name", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: {
          p: {
            repos: ["ExampleOrg/ExampleRepo", "ExampleOrg/Other"],
            tools: ["read:*"],
            environments: [
              "legacy",
              {
                name: "prod",
                publicId: "env-prod",
                scope: "team",
                repos: ["ExampleOrg/ExampleRepo"],
              },
            ],
          },
        },
      }),
    );
    const policy = await loadPolicy(path);
    expect(policy.profiles.p?.environments).toEqual([
      "legacy",
      {
        name: "prod",
        publicId: "env-prod",
        scope: "team",
        repos: ["ExampleOrg/ExampleRepo"],
      },
    ]);
  });

  it("rejects a binding whose repositories are not a subset of the profile's", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: {
          p: {
            repos: ["ExampleOrg/ExampleRepo"],
            tools: ["read:*"],
            environments: [
              {
                name: "prod",
                publicId: "env-prod",
                scope: "team",
                repos: ["someone/else"],
              },
            ],
          },
        },
      }),
    );
    await expect(loadPolicy(path)).rejects.toThrow(/can never widen it/);
  });

  it("accepts a narrowing binding under the repository wildcard", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: {
          p: {
            repos: ["*"],
            tools: ["read:*"],
            environments: [
              "legacy",
              { name: "prod", publicId: "env-prod", scope: "team", repos: ["someone/else"] },
            ],
          },
        },
      }),
    );
    const policy = await loadPolicy(path);
    expect(policy.profiles.p?.repos).toEqual(["*"]);
  });

  it("rejects the wildcard inside a binding's own repos", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: {
          p: {
            repos: ["*"],
            tools: ["read:*"],
            environments: [{ name: "prod", publicId: "env-prod", scope: "team", repos: ["*"] }],
          },
        },
      }),
    );
    await expect(loadPolicy(path)).rejects.toThrow(/wildcard belongs on the profile/);
  });

  it("still rejects a malformed binding repository under the wildcard", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: {
          p: {
            repos: ["*"],
            tools: ["read:*"],
            environments: [
              { name: "prod", publicId: "env-prod", scope: "team", repos: ["not a repo"] },
            ],
          },
        },
      }),
    );
    await expect(loadPolicy(path)).rejects.toThrow(/not a GitHub owner\/name or URL/);
  });

  it("rejects a binding with an unknown scope or a whitespace-bearing publicId", async () => {
    const bad = (binding: unknown) =>
      JSON.stringify({
        defaultProfile: "p",
        profiles: { p: { repos: [], tools: ["read:*"], environments: [binding] } },
      });
    await expect(
      loadPolicy(
        await policyFile(bad({ name: "prod", publicId: "env-prod", scope: "org" })),
      ),
    ).rejects.toThrow(ConfigError);
    await expect(
      loadPolicy(
        await policyFile(bad({ name: "prod", publicId: "env prod", scope: "team" })),
      ),
    ).rejects.toThrow(ConfigError);
  });

  it("rejects two bindings that claim one environmentPublicId", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: {
          p: {
            repos: [],
            tools: ["read:*"],
            environments: [
              { name: "prod", publicId: "env-1", scope: "team" },
              { name: "staging", publicId: "env-1", scope: "team" },
            ],
          },
        },
      }),
    );
    await expect(loadPolicy(path)).rejects.toThrow(/both claim publicId/);
  });

  it("refuses to start on malformed JSON rather than widening authority", async () => {
    const path = await policyFile("{ not json");
    await expect(loadPolicy(path)).rejects.toThrow(ConfigError);
  });

  it("rejects unknown keys, so a typo cannot silently do nothing", async () => {
    const path = await policyFile('{"deleteEnable": true}');
    await expect(loadPolicy(path)).rejects.toThrow(ConfigError);
  });

  it("rejects a defaultProfile that is not defined", async () => {
    const path = await policyFile('{"defaultProfile":"ghost","profiles":{}}');
    await expect(loadPolicy(path)).rejects.toThrow(/not defined in profiles/);
  });

  it("rejects a present policy that omits defaultProfile", async () => {
    const path = await policyFile('{"profiles":{"p":{"tools":["read:*"]}}}');
    await expect(loadPolicy(path)).rejects.toThrow(/defaultProfile is required/);
  });

  it("rejects a missing explicitly configured policy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "cursor-mcp-test-"));
    await expect(loadPolicy(join(dir, "absent.json"), true)).rejects.toThrow(
      /configured policy file .* does not exist/,
    );
  });

  it("requires `tools`, so a profile cannot inherit a permission set", async () => {
    const path = await policyFile('{"profiles":{"p":{"repos":["a/b"]}}}');
    await expect(loadPolicy(path)).rejects.toThrow(ConfigError);
  });

  it("accepts and removes empty legacy launch-control arrays", async () => {
    const path = await policyFile(
      '{"defaultProfile":"p","profiles":{"p":{"tools":["read:*"],"allowedEnvVars":[],"allowedMcpServers":[]}}}',
    );
    const policy = await loadPolicy(path);
    expect(policy.profiles.p).toEqual({ repos: [], tools: ["read:*"] });
  });

  it("rejects non-empty legacy launch-control arrays", async () => {
    const path = await policyFile(
      '{"profiles":{"p":{"tools":[],"allowedEnvVars":["SECRET"]}}}',
    );
    await expect(loadPolicy(path)).rejects.toThrow(ConfigError);
  });

  it("defaults repositories to empty, which permits no launch target", async () => {
    const path = await policyFile(
      '{"defaultProfile":"wave","profiles":{"wave":{"repos":["ExampleOrg/ExampleRepo"],"tools":["read:*"]}}}',
    );
    const policy = await loadPolicy(path);
    const profile = policy.profiles.wave!;
    expect(profile.repos).toEqual(["ExampleOrg/ExampleRepo"]);
    // maxAgents was removed: it could not be enforced across processes.
    expect(profile).not.toHaveProperty("maxAgents");
  });

  it("rejects maxAgents as an unknown key rather than ignoring it", async () => {
    const path = await policyFile('{"profiles":{"p":{"tools":[],"maxAgents":3}}}');
    await expect(loadPolicy(path)).rejects.toThrow(ConfigError);
  });

  it("accepts the shipped example policy", async () => {
    await expect(loadPolicy("policy.example.json")).resolves.toBeDefined();
  });

  it("rejects a response budget too small to preserve tool contracts", async () => {
    const path = await policyFile('{"maxResponseBytes":1023}');
    await expect(loadPolicy(path)).rejects.toThrow(/>=1024/);
  });

  it("omits the Cursor CLI block by default, so the server runs without one", async () => {
    const path = await policyFile(
      '{"defaultProfile":"p","profiles":{"p":{"tools":["read:*"]}}}',
    );
    const policy = await loadPolicy(path);
    expect(policy.cursorCli).toBeUndefined();
  });

  it("keeps CLI reads and writes off until the operator turns each on", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: { p: { tools: ["read:*"] } },
        cursorCli: { path: "/opt/cursor/bin/cursor", compatibleVersions: ["1.2.3"] },
      }),
    );
    const policy = await loadPolicy(path);
    expect(policy.cursorCli?.environmentReads).toBe(false);
    expect(policy.cursorCli?.environmentWrites).toBe(false);
  });

  it("does not let enabling CLI reads enable CLI writes", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: { p: { tools: ["read:*"] } },
        cursorCli: {
          path: "/opt/cursor/bin/cursor",
          compatibleVersions: ["1.2.3"],
          environmentReads: true,
        },
      }),
    );
    const policy = await loadPolicy(path);
    expect(policy.cursorCli?.environmentReads).toBe(true);
    expect(policy.cursorCli?.environmentWrites).toBe(false);
  });

  it("rejects a relative CLI path, which PATH would resolve for us", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: { p: { tools: ["read:*"] } },
        cursorCli: { path: "cursor", compatibleVersions: ["1.2.3"] },
      }),
    );
    await expect(loadPolicy(path)).rejects.toThrow(ConfigError);
  });

  it("requires at least one compatible version, so none is never every", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: { p: { tools: ["read:*"] } },
        cursorCli: { path: "/opt/cursor/bin/cursor", compatibleVersions: [] },
      }),
    );
    await expect(loadPolicy(path)).rejects.toThrow(ConfigError);
  });

  it("rejects an unknown key inside the CLI block", async () => {
    const path = await policyFile(
      JSON.stringify({
        defaultProfile: "p",
        profiles: { p: { tools: ["read:*"] } },
        cursorCli: {
          path: "/opt/cursor/bin/cursor",
          compatibleVersions: ["1.2.3"],
          apiKey: "leak-me",
        },
      }),
    );
    await expect(loadPolicy(path)).rejects.toThrow(ConfigError);
  });
});

describe("isToolAllowed", () => {
  const profile = (tools: string[]): Profile => ({
    repos: [],
    tools,
  });

  it("allows only read-only tools when there is no profile", () => {
    expect(isToolAllowed(undefined, "cursor_whoami", true)).toBe(true);
    expect(isToolAllowed(undefined, "cursor_create_agent", false)).toBe(false);
  });

  it("treats an empty list as permitting nothing, including reads", () => {
    expect(isToolAllowed(profile([]), "cursor_whoami", true)).toBe(false);
    expect(isToolAllowed(profile([]), "cursor_create_agent", false)).toBe(false);
  });

  it("grants every read tool under read:* but no mutation", () => {
    const p = profile(["read:*"]);
    expect(isToolAllowed(p, "cursor_whoami", true)).toBe(true);
    // A read tool that does not exist yet is covered; a mutation is not.
    expect(isToolAllowed(p, "cursor_list_artifacts", true)).toBe(true);
    expect(isToolAllowed(p, "cursor_delete_agent", false)).toBe(false);
  });

  it("grants everything under * and exact names otherwise", () => {
    expect(isToolAllowed(profile(["*"]), "cursor_delete_agent", false)).toBe(true);
    const p = profile(["cursor_create_agent"]);
    expect(isToolAllowed(p, "cursor_create_agent", false)).toBe(true);
    expect(isToolAllowed(p, "cursor_delete_agent", false)).toBe(false);
  });
});

describe("readApiKey", () => {
  it("returns a trimmed key", () => {
    expect(readApiKey({ CURSOR_API_KEY: "  abc  " })).toBe("abc");
  });

  it("throws a message with no secret in it when unset", () => {
    expect(() => readApiKey({})).toThrow(ConfigError);
    expect(() => readApiKey({ CURSOR_API_KEY: "   " })).toThrow(ConfigError);
  });

  it.each([
    ["a newline inside", 10],
    ["a carriage return inside", 13],
    ["a tab inside", 9],
  ])("rejects a key with %s, without echoing it", (_label, code) => {
    // These reach the Authorization header verbatim otherwise: at best an opaque
    // transport failure on every call, at worst a smuggled second header.
    const key = `abc${String.fromCharCode(code)}def`;
    const error = (() => {
      try {
        readApiKey({ CURSOR_API_KEY: key });
        return undefined;
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(ConfigError);
    expect(error!.message).not.toContain("abc");
  });

  it("accepts a key surrounded by whitespace, which copy-paste adds", () => {
    const key = `${String.fromCharCode(10)}  key_abc123  ${String.fromCharCode(10)}`;
    expect(readApiKey({ CURSOR_API_KEY: key })).toBe("key_abc123");
  });
});


it("loads a parameterized pin and rejects duplicate parameter ids", async () => {
  const model = {id: "composer-2.5", params: [{id: "fast", value: "false"}]};
  const config = {defaultProfile: "p", profiles: {p: {tools: ["*"], model}}};
  const path = await policyFile(JSON.stringify(config));
  expect((await loadPolicy(path)).profiles.p!.model).toEqual(model);
  model.params.push({id: "fast", value: "true"});
  await expect(loadPolicy(await policyFile(JSON.stringify(config)))).rejects.toThrow();
});
