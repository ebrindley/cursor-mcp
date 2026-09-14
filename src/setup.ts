/** Human-facing setup commands. Never invoked by an MCP tool. */
import { readFile, mkdir, writeFile, access, lstat, rename, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { dirname } from "node:path";
import { CursorClient } from "./client.js";
import { activeProfile, loadPolicy, policyPath, readApiKey, PolicySchema } from "./config.js";
import { CursorApiError } from "./errors.js";
import { canonicalRepo, environmentBindingProblems } from "./policy.js";
import { MeSchema, RepositoriesSchema } from "./schemas.js";

export const HELP = `Usage: cursor-mcp [--version | --help | setup [--repo OWNER/REPO | --account] [--terminal] [--environment NAME] [--model ID --fast false|true] [--preview | --yes] [--policy PATH] | doctor [--policy PATH] [--offline]]
No arguments starts the stdio MCP server.
setup defaults to account-wide agent management and terminal access, without a model pin.
--repo selects restricted setup. --account explicitly migrates an existing policy.
Existing policies require --yes; use --preview to review changes first.
Model selections require CURSOR_API_KEY and catalog verification. Keys are never stored.
doctor --offline checks configuration, not live access or client connections.`;

export interface SetupOptions {
  terminal?: boolean;
  account?: boolean;
  environment?: string;
  model?: string;
  fast?: string;
  preview?: boolean;
  yes?: boolean;
}
const terminalTools = ["status", "wake", "execute", "read", "cancel", "reset", "session_list", "session_create", "session_input", "session_resize", "session_read", "session_attach", "session_close"].map(n => `cursor_terminal_${n}`);
const deletionTools = ["cursor_delete_agent", "cursor_delete_environment"];
const setupCatalog = z.object({ items: z.array(z.object({
  id: z.string(), parameters: z.array(z.object({ id: z.string(), values: z.array(z.object({ value: z.string() })) })).optional(),
})) });

export async function setup(repo: string | undefined, path: string, options: SetupOptions = {},
  env: NodeJS.ProcessEnv = process.env, fetchImpl: typeof fetch = globalThis.fetch): Promise<string> {
  if (repo && options.account) throw new Error("Choose repository scope or account scope, not both.");
  const target = repo ? canonicalRepo(repo) : undefined;
  let original: string | undefined;
  try {
    const info = await lstat(path);
    if (!info.isFile()) throw Object.assign(new Error("Policy must be a regular file; symlinks are not edited."), { code: "EEXIST" });
    original = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (original !== undefined && !options.yes && !options.preview) {
    throw Object.assign(new Error("Existing policy requires --preview or --yes."), { code: "EEXIST" });
  }
  // Keep the raw JSON: schema parsing injects defaults and removes legacy keys.
  const raw = JSON.parse(original ?? await readFile(new URL("../policy.quickstart.json", import.meta.url), "utf8"));
  const parsed = PolicySchema.parse(raw);
  const name = raw.defaultProfile;
  if (!name || !activeProfile(parsed)) throw new Error("A valid default profile is required.");
  const profile = raw.profiles[name];
  const account = options.account || (original === undefined && !target);
  if (original !== undefined && !target && !options.account) throw new Error("Use --account explicitly to migrate an existing policy.");
  if (original !== undefined && target && ((profile.repos ?? []).length !== 1 || profile.repos[0] === "*" || canonicalRepo(profile.repos[0]).key !== target.key)) {
    throw new Error("Existing repository scope differs; edit the scope separately before setup.");
  }
  if (account) {
    profile.repos = ["*"];
    profile.environmentAccess = "account";
    delete profile.allowNoRepository;
    delete profile.autoCreatePR;
    profile.tools = [...new Set([...profile.tools, "cursor_list_environments"])];
    for (const binding of profile.environments ?? []) {
      if (typeof binding !== "string") delete binding.repos;
    }
  }
  else if (original === undefined && target) profile.repos = [target.url];
  const quickstart = JSON.parse(await readFile(new URL("../policy.quickstart.json", import.meta.url), "utf8"));
  const management: string[] = quickstart.profiles[quickstart.defaultProfile].tools;
  profile.tools = [...new Set([...profile.tools, ...management])];
  if (options.environment !== undefined) {
    const environment = options.environment.trim();
    if (!environment) throw new Error("Environment name must not be empty.");
    profile.environments ??= [];
    if (!profile.environments.some((e: string | { name: string }) => (typeof e === "string" ? e : e.name).trim() === environment)) profile.environments.push(environment);
  }
  if (options.terminal || account) {
    if (Object.values(parsed.profiles).some(p => p.tools.includes("*"))) throw new Error("Replace wildcard tool grants in every profile before enabling terminal execution.");
    if (deletionTools.some(n => profile.tools.includes(n))) throw new Error("Remove deletion tools from the default profile before enabling terminal execution.");
    if (raw.terminal && raw.terminal.targets !== "profile") throw new Error("Existing pinned terminal configuration conflicts; edit it separately.");
    raw.terminal = { ...raw.terminal, targets: "profile", executeEnabled: true, maxTargets: raw.terminal?.maxTargets ?? 16 };
    raw.deleteEnabled = true;
    profile.tools = [...new Set([...profile.tools, ...terminalTools])];
  }
  if (options.fast !== undefined && (!options.model || !["false", "true"].includes(options.fast))) throw new Error("--fast requires --model and false or true.");
  if (options.model) {
    const client = new CursorClient({ apiKey: readApiKey(env), fetchImpl, totalTimeoutMs: 10_000, timeoutMs: 10_000 });
    const catalog = await client.get("/v1/models", setupCatalog);
    const entry = catalog.items.find(m => m.id === options.model);
    if (!entry || (options.fast !== undefined && !entry.parameters?.some(p => p.id === "fast" && p.values.some(v => v.value === options.fast)))) {
      throw new Error("Requested model or parameters are unavailable.");
    }
    profile.model = { id: entry.id, ...(options.fast !== undefined ? { params: [{ id: "fast", value: options.fast }] } : {}) };
  }
  const validated = PolicySchema.parse(raw);
  if (Object.values(validated.profiles).some(p => environmentBindingProblems(p).length > 0)) throw new Error("Existing environment bindings conflict; edit them separately.");
  const changes = JSON.stringify({ repos: profile.repos, environments: profile.environments, environmentAccess: profile.environmentAccess, allowNoRepository: profile.allowNoRepository ?? "launch permission", autoCreatePR: profile.autoCreatePR ?? "per call", tools: profile.tools, model: profile.model, terminal: raw.terminal, deleteEnabled: raw.deleteEnabled }, null, 2);
  const advisory = Object.entries(parsed.profiles).some(([n,p]) => n !== name && deletionTools.some(t => p.tools.includes(t)))
    ? "\nOther profiles contain explicit deletion grants; changing the default profile can activate them." : "";
  if (options.preview) return `Preview; nothing written:\n${changes}${advisory}\nUse the same options with --yes to apply.`;
  await mkdir(dirname(path), { recursive: true });
  const content = `${JSON.stringify(raw, null, 2)}\n`;
  if (original === undefined) await writeFile(path, content, { flag: "wx", mode: 0o600 });
  else {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, content, { flag: "wx", mode: 0o600 });
      if (!(await lstat(path)).isFile() || await readFile(path, "utf8") !== original) throw new Error("Policy changed during setup; retry after reviewing it.");
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
  }
  return `OK: policy configured. Run doctor and restart your MCP clients.${advisory}\nIf you chose a custom path, pass it as CURSOR_MCP_POLICY to the MCP server.`;
}

export interface Diagnostic { check: string; status: "ok" | "error" | "info"; message: string }

export async function doctor(
  path: string,
  offline: boolean,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<Diagnostic[]> {
  const rows: Diagnostic[] = [];
  const add = (check: string, status: Diagnostic["status"], message: string) => rows.push({ check, status, message });
  // The CLI is already running on Node. Source builds recommend Node 24; the
  // packaged runtime also supports the older versions in package.json.
  add("runtime", "ok", `Node ${process.versions.node}`);
  let policy;
  try {
    await access(path);
    const loaded = await loadPolicy(path, true);
    const profile = activeProfile(loaded);
    if (!profile || profile.tools.length === 0) throw new Error("no tools");
    for (const repo of profile.repos) if (repo !== "*") canonicalRepo(repo);
    policy = loaded;
    const allowed = (n: string) => profile.tools.includes("*") || profile.tools.includes(n);
    add("environments", "info", profile.environmentAccess === "account" ? "Account-wide environment access; no per-name grants required." : profile.environments?.length
      ? "Environment grants configured; repository restrictions still apply."
      : "No environment grants. Agents reporting a named environment are refused; use setup --account --yes, or setup --repo OWNER/REPO --environment NAME --yes.");
    add("terminal", "info", !loaded.terminal ? "Not configured. Use setup --account --yes, or setup --repo OWNER/REPO --terminal --yes."
      : !loaded.terminal.executeEnabled || !loaded.deleteEnabled || !["cursor_terminal_execute", "cursor_terminal_session_create", "cursor_terminal_session_input"].every(allowed)
        ? "Configured with restricted execution permissions; live access not checked."
        : `Execution configured (${loaded.terminal.targets} targets); live access not checked.`);
    add("cursor-cli", "info", loaded.cursorCli ? "Optional CLI configured; readiness not checked." : "Optional CLI not configured; not required for terminal access.");
    if (loaded.deleteEnabled && Object.values(loaded.profiles).some(p => p.tools.includes("*"))) {
      add("permissions", "info", "Warning: wildcard grants combined with deleteEnabled permit destructive tools. Use explicit tool lists.");
    }
    add("policy", "ok", "Active profile loaded. Permissions still apply to each tool call.");
    add("launch", "info", profile.tools.includes("*") || profile.tools.includes("cursor_create_agent")
      ? "Agent launches are enabled by the tool list; repository and environment restrictions still apply."
      : "Agent launches are disabled. Enable them deliberately if needed.");
  } catch {
    // Do not reflect schema errors, profile names, or file contents to a terminal.
    add("policy", "error", "Policy is missing, unreadable, invalid, or permits no tools. Check JSON, the active profile, and repository entries (GitHub OWNER/REPO or URL). Run setup to configure a new policy; use --preview before editing an existing one.");
  }
  let apiKey = "";
  try {
    apiKey = readApiKey(env);
    add("credential", "ok", "CURSOR_API_KEY is present in this process with valid header syntax; client environments may differ.");
  } catch {
    add("credential", offline ? "info" : "error", "CURSOR_API_KEY is missing or invalid in this process. Set it in the environment that launches your client.");
    if (!offline) return rows;
  }
  if (offline) {
    add("account", "info", "Offline: account and repository access were not checked.");
    return rows;
  }
  if (!policy) return rows;
  const client = new CursorClient({ apiKey, fetchImpl, totalTimeoutMs: 10_000, timeoutMs: 10_000 });
  try {
    await client.get("/v1/me", MeSchema);
    add("account", "ok", "Cursor accepted the key. Identity details are not displayed.");
  } catch (error) {
    add("account", "error", diagnosticError(error));
    return rows;
  }
  const repos = activeProfile(policy)?.repos ?? [];
  if (repos.length === 0 || repos.includes("*")) {
    add("repositories", "info", "Account-wide or no explicit repository scope; individual repository visibility was not checked.");
    return rows;
  }
  try {
    const available = await client.get("/v1/repositories", RepositoriesSchema);
    let keys: Set<string>;
    try { keys = new Set(available.items.map((r) => canonicalRepo(r.url).key)); }
    catch {
      add("repositories", "error", "Cursor returned an unrecognized repository URL; repository access could not be verified.");
      return rows;
    }
    const missing = repos.filter((r) => !keys.has(canonicalRepo(r).key)).length;
    add("repositories", missing === 0 ? "ok" : "error", missing === 0
      ? "All explicitly configured repositories are listed by Cursor. This does not guarantee a launch will succeed."
      : "Some configured repositories are not listed. Check Cursor's GitHub installation and the policy repository names.");
  } catch (error) {
    add("repositories", "error", diagnosticError(error));
  }
  return rows;
}

function diagnosticError(error: unknown): string {
  if (error instanceof CursorApiError) {
    if (error.status === 401 || error.status === 403) return "Cursor refused access. Check the key and account permissions.";
    if (error.status === 429) return "Cursor rate limited the check. Wait before running doctor again.";
  }
  return "Cursor access could not be verified. Check connectivity and account access, then retry. No upstream body is displayed.";
}

export async function runSetupCommand(args: string[], write: (line: string) => void, writeError: (line: string) => void): Promise<number> {
  if (args.length === 1 && args[0] === "--help") { write(HELP); return 0; }
  const command = args[0];
  if (command !== "setup" && command !== "doctor") { writeError(HELP); return 1; }
  let repo: string | undefined;
  let path = policyPath();
  let offline = false;
  const options: SetupOptions = {};
  const seen = new Set<string>();
  for (let i = 1; i < args.length; i++) {
    const flag = args[i]!;
    if (seen.has(flag)) { writeError(HELP); return 1; }
    seen.add(flag);
    if (flag === "--offline" && command === "doctor") { offline = true; continue; }
    if (command === "setup" && ["--terminal", "--preview", "--yes", "--account"].includes(flag)) {
      if (flag === "--account") options.account = true;
      if (flag === "--terminal") options.terminal = true;
      if (flag === "--preview") options.preview = true;
      if (flag === "--yes") options.yes = true;
      continue;
    }
    if (command === "setup" && ["--model", "--fast", "--environment"].includes(flag)) {
      const value = args[++i];
      if (!value || value.startsWith("--")) { writeError(HELP); return 1; }
      if (flag === "--model") options.model = value; else if (flag === "--environment") options.environment = value; else options.fast = value;
      continue;
    }
    if (flag !== "--policy" && !(flag === "--repo" && command === "setup")) { writeError(HELP); return 1; }
    const value = args[++i];
    if (!value || value.startsWith("--")) { writeError(HELP); return 1; }
    if (flag === "--policy") path = value;
    else repo = value;
  }
  if (command === "setup") {
    if ((repo && options.account) || (options.preview && options.yes)) { writeError(HELP); return 1; }
    try { write(await setup(repo, path, options)); return 0; }
    catch (error) {
      writeError((error as NodeJS.ErrnoException).code === "EEXIST"
        ? "Error: policy already exists; nothing changed. Review with --preview, then apply with --yes."
        : "Error: setup did not complete. Check repository scope, policy conflicts or wildcard/deletion grants, model credentials and parameters, and file permissions. Existing policy was not replaced.");
      return 1;
    }
  }
  const rows = await doctor(path, offline);
  for (const row of rows) (row.status === "error" ? writeError : write)(`${row.status.toUpperCase()}: ${row.check}: ${row.message}`);
  return rows.some((row) => row.status === "error") ? 1 : 0;
}
