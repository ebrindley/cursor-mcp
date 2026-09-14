/**
 * The one place a tool is registered.
 *
 * A tool the active profile does not permit is never registered, so it does not
 * appear in `tools/list` and cannot be called. Defining the permission rules
 * without applying them was the first version of this: `isToolAllowed` existed,
 * every tool was registered unconditionally, and a profile with `tools: []` still
 * served every read.
 *
 * Gating at registration rather than at call time also costs the client nothing
 * in context for tools it may not use.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { withRequestProgress, withRequestSignal } from "../client.js";
import type { Policy, Profile } from "../config.js";
import { isToolAllowed } from "../config.js";
import { log } from "../log.js";
import { ProgressReporter, type ProgressSend, type ProgressToken } from "../progress.js";
import { guard, type ToolResult } from "./result.js";

/** The part of the SDK's request extra this module reads. */
interface RequestExtra {
  signal?: unknown;
  _meta?: { progressToken?: unknown };
  sendNotification?: (notification: {
    method: "notifications/progress";
    params: { progressToken: ProgressToken; progress: number; message?: string };
  }) => Promise<void>;
}

/**
 * Give the handler a progress reporter only when the client supplied a token.
 *
 * A token of `0` is a token: comparing it truthily would silence exactly the
 * client that numbers its requests from zero.
 */
function withProgress(extra: RequestExtra | undefined, operation: () => Promise<ToolResult>) {
  const token = extra?._meta?.progressToken;
  const send = extra?.sendNotification;
  if (send === undefined || (typeof token !== "string" && typeof token !== "number")) {
    return operation();
  }
  const emit: ProgressSend = (params) =>
    send({ method: "notifications/progress", params });
  const reporter = new ProgressReporter(emit, token);
  // Nothing is sent after the result exists, including on the error path: the
  // request is over and a late notification would describe a read that ended.
  return withRequestProgress(reporter, operation).finally(() => reporter.done());
}

/** The part of a tool's config this module reads. The rest passes through. */
export interface GateableConfig {
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  outputSchema?: z.ZodRawShape;
  [key: string]: unknown;
}

/**
 * `A` is the handler's argument tuple. The SDK calls a handler with `(args,
 * extra)` when the config carries an `inputSchema` and with `(extra)` alone when
 * it does not, so the tuple is inferred from the handler rather than fixed here.
 */
export interface ToolSpec<C extends GateableConfig, A extends unknown[]> {
  name: string;
  /** Passed to `registerTool` unchanged. `annotations.readOnlyHint` gates it. */
  config: C;
  /**
   * A promotion -- Build activate, deactivate, or rollback -- which needs
   * `activationEnabled` on top of the allowlist.
   * Reserved: no current tool sets this field.
   *
   * A spec field rather than an annotation, because annotations go to the client
   * verbatim and there is no standard hint for promotion. It is deliberately not
   * `destructiveHint`: that hint gates `deleteEnabled`, and granting deletion
   * must not grant promotion.
   */
  activation?: boolean;
  handler: (...args: A) => Promise<ToolResult>;
}

/**
 * Register a tool if the profile permits it. Returns whether it was registered,
 * so a caller can report the effective surface.
 */
export function defineTool<C extends GateableConfig, A extends unknown[]>(
  server: McpServer,
  policy: Policy,
  profile: Profile | undefined,
  spec: ToolSpec<C, A>,
): boolean {
  const readOnly = spec.config.annotations?.readOnlyHint === true;
  if (!isToolAllowed(profile, spec.name, readOnly)) {
    log.debug(`${spec.name} not permitted by the active profile; not registered`);
    return false;
  }
  // A destructive tool needs `deleteEnabled` on top of the allowlist. Without
  // this, `tools: ["*"]` -- which is what an operator writes to mean "I trust
  // this server" -- would silently also grant irreversible deletion, and
  // `deleteEnabled: false` would be a setting nothing read.
  //
  // Keyed on the annotation rather than a name list, so a destructive tool added
  // later cannot arrive without the gate by forgetting to update this file.
  if (spec.config.annotations?.destructiveHint === true && !policy.deleteEnabled) {
    log.debug(`${spec.name} is destructive and deleteEnabled is off; not registered`);
    return false;
  }
  // Reserved for a future promotion tool; no current registration uses it.
  // Promotion is a second high-impact class with its own gate, for the same
  // reason: `tools: ["*"]` must not silently also grant making a Build the one
  // every future agent boots from. `deleteEnabled` does not grant it either.
  if (spec.activation === true && !policy.activationEnabled) {
    log.debug(`${spec.name} promotes a Build and activationEnabled is off; not registered`);
    return false;
  }
  // registerTool is an overload set whose callback type is derived from the
  // config's `inputSchema`, so it cannot be expressed against a generic config.
  // The two-step cast is the price of routing every tool through one function;
  // the shapes are checked at each call site, where the literals are written.
  const register = server.registerTool.bind(server) as unknown as (
    name: string,
    config: C,
    handler: (...args: A) => Promise<ToolResult>,
  ) => unknown;
  const outputSchema =
    spec.config.outputSchema === undefined
      ? undefined
      : z.object(spec.config.outputSchema);
  const guarded = guard(policy, spec.handler, outputSchema);
  const handler = (...args: A) => {
    const extra = args.at(-1) as RequestExtra | undefined;
    const run = () => withProgress(extra, () => guarded(...args));
    return extra?.signal instanceof AbortSignal
      ? withRequestSignal(extra.signal, run)
      : run();
  };
  register(spec.name, spec.config, handler);
  return true;
}
