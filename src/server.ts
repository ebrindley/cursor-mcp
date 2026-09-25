#!/usr/bin/env node
/**
 * cursor-mcp -- stdio MCP server for the Cursor Cloud Agents v1 API.
 *
 * stdio only. There is no HTTP transport, so there is no port to bind, no CORS
 * surface, and no unauthenticated endpoint.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CursorClient } from "./client.js";
import { AgentScope } from "./agent-scope.js";
import { activeProfile, loadPolicy, readApiKey } from "./config.js";
import { ConfigError } from "./errors.js";
import { log } from "./log.js";
import { registerAccountTools } from "./tools/account.js";
import { registerAgentTools } from "./tools/agents.js";
import { registerArtifactTools } from "./tools/artifacts.js";
import { registerBulkTools } from "./tools/bulk.js";
import { registerEnvironmentCatalogTools } from "./tools/environment-catalog.js";
import { registerEnvironmentDefinitionTools } from "./tools/environment-definition.js";
import { registerEnvironmentHealthTools } from "./tools/environment-health.js";
import { registerEnvironmentLifecycleTools } from "./tools/environment-lifecycle.js";
import { registerEnvironmentOperationTools } from "./tools/environment-operations.js";
import { registerLifecycleTools } from "./tools/lifecycle.js";
import { registerRunActivityTool } from "./tools/run-activity.js";
import { registerRunExportTool } from "./tools/run-export.js";
import { registerTerminalTools } from "./tools/terminal.js";
import { VERSION } from "./version.js";

export async function main(): Promise<void> {
  const apiKey = readApiKey();
  const policy = await loadPolicy();
  const client = new CursorClient({ apiKey });
  const scope = new AgentScope(client, activeProfile(policy));

  const server = new McpServer({ name: "cursor-mcp", version: VERSION });

  const tools = [
    ...registerTerminalTools(server, policy, apiKey, undefined, scope),
    // Workspace Controls: identity, models, repositories, and the settings
    // catalog. Unproven controls stay addressable as capability results.
    ...registerAccountTools(server, client, policy),
    ...registerAgentTools(server, client, policy, scope),
    ...registerRunActivityTool(server, client, policy, scope),
    // Disk-bound replay export. Registered only when an operator has both granted
    // the tool and configured a storage root, because it is the one tool that
    // creates files on this machine.
    ...registerRunExportTool(server, client, policy, scope),
    ...registerArtifactTools(server, client, policy, scope),
    ...registerLifecycleTools(server, client, policy, scope),
    // Bulk archive/unarchive: a paced background job, because one call cannot
    // cover hundreds of agents inside the host's request timeout.
    ...registerBulkTools(server, client, policy, scope),
    // Local and generic: no client, because Environment Definition talks to a
    // repository file and the caller's own text, never to Cursor.
    ...registerEnvironmentDefinitionTools(server, policy),
    // Global environment discovery and configuration reads. Their authority is an
    // optional local Cursor CLI; without one they report why, and they never
    // substitute a delegated run for the answer.
    ...registerEnvironmentCatalogTools(server, client, policy),
    // Environment Operations reaches Cursor's Build control plane through a
    // bounded delegated run, which is launched with the same client and the same
    // Agent Lifecycle policy as any other named-environment launch.
    ...registerEnvironmentOperationTools(server, client, policy, scope),
    // Local lifecycle planning and owner-action judgments. Full lifecycle
    // execution is unavailable; the atomic tools above remain independent.
    ...registerEnvironmentLifecycleTools(server, client, policy, scope),
    // Freshness judgement over readback the caller holds, plus the one confirmed
    // draft Build a toolchain drift warrants. The cheap check is read-only and
    // launches nothing, so an external scheduler can run it on a timer.
    ...registerEnvironmentHealthTools(server, client, policy, scope),
  ];

  // Name the effective surface, not the configured one: a profile that permits
  // nothing produces an empty tool list, and that should be visible rather than
  // looking like a broken server.
  log.info(
    `ready: profile=${policy.defaultProfile ?? "(none, read-only)"} ` +
      `delete=${policy.deleteEnabled ? "enabled" : "disabled"} ` +
      `activation=reserved(configured:${policy.activationEnabled}) ` +
      `cli=${
        policy.cursorCli === undefined
          ? "absent"
          : policy.cursorCli.environmentReads
            ? "reads-enabled"
            : "configured, reads-disabled"
      } ` +
      `tools=${tools.length === 0 ? "(none permitted)" : tools.join(",")}`,
  );
  // A server with no tools is a misconfiguration, not a locked-down server: the
  // SDK only answers tools/list once something is registered, so the client would
  // see "Method not found" and read it as broken. Fail closed and say why.
  if (tools.length === 0) {
    throw new ConfigError(
      `the active profile (${policy.defaultProfile ?? "none"}) permits no tools; ` +
        'set `tools` in the policy file (["read:*"] for every read-only tool)',
    );
  }

  await server.connect(new StdioServerTransport());
  // A client disconnect must abort in-flight stream reads through the SDK's
  // request signals, not keep this stdio process alive until their deadline.
  process.stdin.once("end", () => { void server.close(); });
}

// Whether this file is the process entry point, decided on resolved real paths
// rather than on the raw argv string.
//
// Node resolves an ESM module's `import.meta.url` through realpath(3), so a
// launch through a symlink -- how a release-symlink deployment points hosts at
// whichever build is current -- gives a URL naming the link's target while
// `argv[1]` still names the link. A direct URL comparison therefore fails, and
// the server starts, registers nothing, and exits 0, which every host reads as
// a broken MCP server rather than as a bad launch path. Both sides are resolved
// so the check also survives `--preserve-symlinks-main`, which moves the
// symlink to the other side of the comparison.
function isProcessEntryPoint(): boolean {
  const argv1 = process.argv[1];
  if (argv1 === undefined) return false;
  try {
    return realpathSync(argv1) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    // argv[1] can name a path that no longer exists, or one outside this
    // process's reach. pathToFileURL, not string concatenation: an install path
    // containing `#` or `%` produces a URL that never matches import.meta.url.
    return import.meta.url === pathToFileURL(argv1).href;
  }
}

const invokedDirectly = isProcessEntryPoint();

if (invokedDirectly) {
  main().catch((error: unknown) => {
    log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
