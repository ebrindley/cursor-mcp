import { mkdtemp, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { doctor, runSetupCommand, setup } from "../src/setup.js";
import { resolveAutoCreatePR, resolveCreateAgentLaunch, assertAgentAccess, assertEnvironmentIdentity, resolveEnvironmentBinding } from "../src/policy.js";
import { loadPolicy } from "../src/config.js";

const key = "dummy-private-marker-not-real";
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
async function destination() { return join(await mkdtemp(join(tmpdir(), "cursor-setup-")), "policy.json"); }

describe("human setup", () => {
  it("creates the shipped everyday policy with one normalized repo and private permissions", async () => {
    const path = await destination();
    await setup("ExampleOrg/ExampleRepo", path);
    const policy = await loadPolicy(path, true);
    expect(policy.profiles[policy.defaultProfile!]!.repos).toEqual(["https://github.com/ExampleOrg/ExampleRepo"]);
    expect(policy.profiles[policy.defaultProfile!]!.tools).toHaveLength(14);
    expect(policy.profiles[policy.defaultProfile!]!.tools).not.toContain("read:*");
    expect(policy.profiles[policy.defaultProfile!]!.allowNoRepository).toBe(false);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await readFile(path, "utf8")).not.toContain(key);
  });

  it("preserves existing files and refuses dangling symlinks", async () => {
    const path = await destination();
    await writeFile(path, "existing");
    await expect(setup("O/R", path)).rejects.toMatchObject({ code: "EEXIST" });
    expect(await readFile(path, "utf8")).toBe("existing");
    const link = await destination();
    await symlink(`${link}-missing`, link);
    await expect(setup("O/R", link)).rejects.toMatchObject({ code: "EEXIST" });
  });

  it("rejects unsupported arguments without reflecting their values", async () => {
    const lines: string[] = [];
    const stdout = vi.fn();
    expect(await runSetupCommand(["setup", "--key", key], stdout, (s) => lines.push(s))).toBe(1);
    expect(stdout).not.toHaveBeenCalled();
    expect(lines.join("\n")).not.toContain(key);
  });
});

describe("credential-safe doctor", () => {
  it("checks local configuration offline without sending HTTP", async () => {
    const path = await destination(); await setup("O/R", path);
    const fetchImpl = vi.fn<typeof fetch>();
    const rows = await doctor(path, true, { CURSOR_API_KEY: key }, fetchImpl);
    expect(rows.some((r) => r.status === "error")).toBe(false);
    expect(rows.find((r) => r.check === "account")?.message).toContain("not checked");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("reports local errors without reading account data or exposing config contents", async () => {
    const path = await destination(); await writeFile(path, JSON.stringify({ defaultProfile: key }));
    const fetchImpl = vi.fn<typeof fetch>();
    const rows = await doctor(path, false, {}, fetchImpl);
    expect(rows.filter((r) => r.status === "error").map((r) => r.check)).toEqual(["policy", "credential"]);
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it.each([{ repos: ["not-a-repo"], tools: ["read:*"] }, { repos: ["O/R"], tools: [] }])("refuses invalid local configuration before HTTP: %j", async (profile) => {
    const path = await destination();
    await writeFile(path, JSON.stringify({ defaultProfile: "p", profiles: { p: profile } }));
    const fetchImpl = vi.fn<typeof fetch>();
    const rows = await doctor(path, false, { CURSOR_API_KEY: key }, fetchImpl);
    expect(rows.find((r) => r.check === "policy")?.status).toBe("error");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("checks repository visibility without displaying identity or repository responses", async () => {
    const path = await destination(); await setup("ExampleOrg/ExampleRepo", path);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ apiKeyName: key, userEmail: key, createdAt: "2026-01-01" }))
      .mockResolvedValueOnce(json({ items: [{ url: "https://github.com/exampleorg/examplerepo" }] }));
    const rows = await doctor(path, false, { CURSOR_API_KEY: key }, fetchImpl);
    expect(rows.find((r) => r.check === "repositories")?.status).toBe("ok");
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not claim an unlisted repository is usable", async () => {
    const path = await destination(); await setup("O/R", path);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValueOnce(json({ apiKeyName: key, createdAt: "2026-01-01" })).mockResolvedValueOnce(json({ items: [] }));
    const rows = await doctor(path, false, { CURSOR_API_KEY: key }, fetchImpl);
    expect(rows.find((r) => r.check === "repositories")?.status).toBe("error");
  });

  it("does not print reflected API error bodies", async () => {
    const path = await destination(); await setup("O/R", path);
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ error: { message: key } }, 403));
    const rows = await doctor(path, false, { CURSOR_API_KEY: key }, fetchImpl);
    expect(rows.find((r) => r.check === "account")?.status).toBe("error");
    expect(JSON.stringify(rows)).not.toContain(key);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});


describe("capability onboarding", () => {
  const catalog = { items: [{ id: "example-model", parameters: [{ id: "fast", values: [{ value: "false" }, { value: "true" }] }] }] };
  it("previews and configures terminal and a verified model without deletion tools", async () => {
    const path = await destination();
    const fetchImpl = vi.fn<typeof fetch>().mockImplementation(async () => json(catalog));
    const opts = { terminal: true, model: "example-model", fast: "false" };
    expect(await setup("O/R", path, { ...opts, preview: true }, { CURSOR_API_KEY: key }, fetchImpl)).toContain("nothing written");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
    await setup("O/R", path, opts, { CURSOR_API_KEY: key }, fetchImpl);
    const p = await loadPolicy(path, true);
    expect(p.terminal).toMatchObject({ targets: "profile", executeEnabled: true });
    expect(p.deleteEnabled).toBe(true);
    const profile = p.profiles[p.defaultProfile!]!;
    expect(profile.tools.filter(n => n.startsWith("cursor_terminal_"))).toHaveLength(13);
    expect(profile.tools).not.toContain("cursor_delete_agent");
    expect(profile.tools).not.toContain("cursor_delete_environment");
    expect(profile.model).toEqual({ id: "example-model", params: [{ id: "fast", value: "false" }] });
    expect(fetchImpl.mock.calls.every(c => String(c[0]).endsWith("/v1/models"))).toBe(true);
  });
  it("preserves unrelated raw policy data and requires explicit existing-file confirmation", async () => {
    const path = await destination(); await setup("O/R", path);
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.profiles[raw.defaultProfile].allowedEnvVars = [];
    raw.profiles.other = { repos: ["Else/Repo"], tools: ["read:*"] };
    await writeFile(path, JSON.stringify(raw));
    await expect(setup("O/R", path, { terminal: true })).rejects.toMatchObject({ code: "EEXIST" });
    await setup("O/R", path, { terminal: true, yes: true });
    const result = JSON.parse(await readFile(path, "utf8"));
    expect(result.profiles.other).toEqual(raw.profiles.other);
    expect(result.profiles[result.defaultProfile].allowedEnvVars).toEqual([]);
    expect(result).not.toHaveProperty("activationEnabled");
    expect(result).not.toHaveProperty("maxResponseBytes");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });
  it.each(["wildcard", "deletion", "scope", "pinned"])("preserves conflicting policies: %s", async conflict => {
    const path = await destination(); await setup("O/R", path);
    const raw = JSON.parse(await readFile(path, "utf8"));
    if (conflict === "wildcard") raw.profiles.other = { repos: ["O/R"], tools: ["*"] };
    if (conflict === "deletion") raw.profiles[raw.defaultProfile].tools.push("cursor_delete_agent");
    if (conflict === "scope") raw.profiles[raw.defaultProfile].repos = ["Other/Repo"];
    if (conflict === "pinned") raw.terminal = { agentId: "bc-test" };
    const before = JSON.stringify(raw); await writeFile(path, before);
    await expect(setup("O/R", path, { terminal: true, yes: true })).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe(before);
  });
  it("refuses unverified model changes without altering existing policy", async () => {
    const path = await destination(); await setup("O/R", path); const before = await readFile(path, "utf8");
    for (const env of [{}, { CURSOR_API_KEY: key }]) {
      await expect(setup("O/R", path, { yes: true, model: "example-model", fast: "false" }, env, vi.fn<typeof fetch>().mockResolvedValue(json({ items: [] })))).rejects.toThrow();
      expect(await readFile(path, "utf8")).toBe(before);
    }
  });
  it("offline diagnostics distinguish missing credentials and disabled terminal without network", async () => {
    const path = await destination(); await setup("O/R", path);
    const fetchImpl = vi.fn<typeof fetch>(); const rows = await doctor(path, true, {}, fetchImpl);
    expect(rows.some(r => r.status === "error")).toBe(false);
    expect(rows.find(r => r.check === "credential")?.status).toBe("info");
    expect(rows.find(r => r.check === "terminal")?.message).toContain("Not configured");
    expect(rows.find(r => r.check === "cursor-cli")?.message).toContain("not required");
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});


it("appends explicit environment grants, preserves structured bindings, and diagnoses absent grants", async () => {
  const path = await destination(); await setup("O/R", path);
  expect((await doctor(path, true, {})).find(r => r.check === "environments")?.message).toContain("No environment grants");
  const raw = JSON.parse(await readFile(path, "utf8"));
  raw.profiles[raw.defaultProfile].environments = [{ name: "existing", publicId: "env-1", scope: "personal", repos: ["O/R"] }];
  await writeFile(path, JSON.stringify(raw));
  const preview = await setup("O/R", path, { environment: "selected", preview: true });
  expect(preview).toContain('"selected"');
  await setup("O/R", path, { environment: "selected", yes: true });
  await setup("O/R", path, { environment: "existing", yes: true });
  await setup("O/R", path, { environment: " selected ", yes: true });
  const result = JSON.parse(await readFile(path, "utf8"));
  expect(result.profiles[result.defaultProfile].environments).toEqual([...raw.profiles[raw.defaultProfile].environments, "selected"]);
  expect((await doctor(path, true, {})).find(r => r.check === "environments")?.message).toContain("grants configured");
});


it("sets up account access without a model and explicitly migrates while preserving preferences", async () => {
  const path = await destination();
  await setup(undefined, path, {}, {});
  let raw = JSON.parse(await readFile(path, "utf8"));
  let profile = raw.profiles[raw.defaultProfile];
  expect(profile.repos).toEqual(["*"]);
  expect(profile.environmentAccess).toBe("account");
  expect(profile.model).toBeUndefined();
  expect(profile.tools).toContain("cursor_list_environments");
  expect(resolveCreateAgentLaunch(profile, { noRepository: true })).toEqual({ kind: "no-repository" });
  expect(resolveAutoCreatePR(profile, false)).toBe(false);
  expect(resolveAutoCreatePR(profile, true)).toBe(true);
  expect(profile.tools.filter((n: string) => n.startsWith("cursor_terminal_"))).toHaveLength(13);
  expect(profile.tools).not.toContain("cursor_delete_agent");
  expect(profile.tools).not.toContain("cursor_delete_environment");
  for (const name of ["first", "new-environment"]) {
    expect(resolveEnvironmentBinding(profile, name).repos).toEqual(["*"]);
    for (const url of ["Owner/First", "Other/NewRepo"]) {
      expect(() => assertAgentAccess(profile, { repos: [{ url }], env: { name } })).not.toThrow();
    }
  }
  profile.environments = [{ name: "pinned", publicId: "env-fixed", scope: "personal", repos: ["O/R"] }];
  expect(() => assertEnvironmentIdentity(profile, "pinned", "env-other")).toThrow();
  profile.repos = ["O/R"];
  delete profile.environmentAccess;
  profile.model = { id: "personal-model", params: [{ id: "fast", value: "false" }] };
  await writeFile(path, JSON.stringify(raw));
  await expect(setup(undefined, path, { yes: true })).rejects.toThrow("--account");
  await setup(undefined, path, { account: true, yes: true });
  raw = JSON.parse(await readFile(path, "utf8"));
  profile = raw.profiles[raw.defaultProfile];
  expect(profile.repos).toEqual(["*"]);
  expect(profile.model.id).toBe("personal-model");
  expect(profile.environments[0]).not.toHaveProperty("repos");
  expect(resolveEnvironmentBinding(profile, "pinned")).toMatchObject({ publicId: "env-fixed", repos: ["*"] });
  profile.environments[0].repos = ["O/R"];
  expect(resolveEnvironmentBinding(profile, "pinned").repos).toEqual(["O/R"]);
  await expect(setup("O/R", path, { yes: true })).rejects.toThrow("scope differs");
  expect((await doctor(path, true, {})).find(r => r.check === "environments")?.message).toContain("Account-wide");
});
