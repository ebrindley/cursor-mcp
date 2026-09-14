/**
 * Environment Definition tools: validate, inspect, diff.
 *
 * Local and generic. These three tools read a repository's own
 * `.cursor/environment.json`, or definition text the caller passes in, and
 * report against Cursor's published environment schema. None of them calls
 * Cursor, and none of them writes anything -- persisting a definition is an
 * owner Save or a repository commit, which is Environment Operations' domain
 * (see `docs/lifecycle-architecture.md`).
 *
 * Only `.cursor/environment.json` in the server's current workspace is ever
 * read. Other repositories are inspected from caller-supplied text, so a model
 * cannot turn this read-only tool into a local filesystem browser.
 *
 * Definition text is repository content, so it is untrusted like any Cursor
 * string and leaves through `ok()`. The document itself is never echoed:
 * structured output carries digests, counts, and paths. A definition may hold an
 * inline credential even though the schema has no secret field.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Policy } from "../config.js";
import { activeProfile } from "../config.js";
import {
  DEFINITION_PATH,
  absentDefinition,
  buildSynchronizationRequest,
  diffDefinitions,
  normalizeDefinition,
  oversizedDefinition,
  readLocalDefinition,
  validateDefinition,
  type DefinitionSource,
  type ValidationResult,
} from "../environment-definition.js";
import { PolicyError } from "../errors.js";
import { LOCAL_READ } from "./annotations.js";
import type { GateableConfig, ToolSpec } from "./register.js";
import { defineTool } from "./register.js";
import { ok } from "./result.js";

/* ------------------------------------------------------------------- input */

const TextSourceArg = z
  .enum(["proposed", "delegated-saved"])
  .describe(
    "Where the document came from. `delegated-saved` is labeled delegated untrusted evidence. " +
      "Defaults to `proposed`. A local-file source is assigned only when this tool reads it.",
  );

const DefinitionInput = z
  .strictObject({
    repoRoot: z
      .literal(".")
      .optional()
      .describe(
        `Use "." to read ${DEFINITION_PATH} from the server's current workspace. Other roots must supply text.`,
      ),
    text: z
      .string()
      .optional()
      .describe("Definition document as JSONC text. Comments are allowed."),
    source: TextSourceArg.optional(),
  })
  .describe("One definition: either a repository root or the document text.");

type DefinitionInputArgs = z.infer<typeof DefinitionInput>;

/**
 * Resolve one input to a validation result.
 *
 * `text` and `repoRoot` are mutually exclusive: with both, it would be unclear
 * which document the answer described.
 */
async function loadDefinition(
  input: DefinitionInputArgs,
  label: string,
  workspaceRoot: string,
): Promise<ValidationResult> {
  if (input.text !== undefined && input.repoRoot !== undefined) {
    throw new PolicyError(
      `${label}: pass repoRoot or text, not both; the document would be ambiguous`,
    );
  }
  if (input.text === undefined && input.repoRoot === undefined) {
    throw new PolicyError(`${label}: pass repoRoot or text`);
  }

  if (input.repoRoot !== undefined) {
    if (input.source !== undefined) {
      throw new PolicyError(
        `${label}: source is derived for a workspace file; omit the source argument`,
      );
    }
    const local = await readLocalDefinition(workspaceRoot);
    const source: DefinitionSource = "local-file";
    if (!local.present) {
      return absentDefinition({ source, origin: `local file ${DEFINITION_PATH} (absent)` });
    }
    if ("tooLarge" in local) {
      return oversizedDefinition({
        source,
        origin: `local file ${DEFINITION_PATH}`,
        sizeBytes: local.sizeBytes,
      });
    }
    return validateDefinition({
      text: local.text,
      source,
      origin: `local file ${DEFINITION_PATH}`,
    });
  }

  const source: DefinitionSource = input.source ?? "proposed";
  return validateDefinition({
    text: input.text ?? "",
    source,
    origin:
      source === "delegated-saved"
        ? "delegated run (untrusted evidence)"
        : "caller-supplied definition text",
  });
}

/* ------------------------------------------------------------------ output */

const IssueOut = z.object({
  code: z.string(),
  path: z.string(),
  message: z.string(),
});

const FindingOut = z.object({
  code: z.string(),
  severity: z.string(),
  label: z.string(),
  path: z.string(),
  line: z.number().optional(),
});

const LimitationOut = z.object({ code: z.string(), message: z.string() });

/** The three result classes, kept apart in the payload as well as in prose. */
const REPORT_OUT = {
  status: z.string(),
  source: z.string(),
  trust: z.string(),
  origin: z.string(),
  errorsTruncated: z.boolean(),
  errors: z.array(IssueOut).optional(),
  safety: z.array(FindingOut).optional(),
  safetyTruncated: z.boolean().optional(),
  limitations: z.array(LimitationOut).optional(),
};

// A diff contains two reports under one shared response budget. Either nested
// report may therefore be reduced to any prefix without invalidating the
// top-level result.
const BOUNDED_REPORT_OUT = {
  status: z.string().optional(),
  source: z.string().optional(),
  trust: z.string().optional(),
  origin: z.string().optional(),
  errorsTruncated: z.boolean().optional(),
  errors: z.array(IssueOut).optional(),
  safety: z.array(FindingOut).optional(),
  safetyTruncated: z.boolean().optional(),
  limitations: z.array(LimitationOut).optional(),
};

/** The report fields of a validation result, without the document itself. */
function report(result: ValidationResult): Record<string, unknown> {
  return {
    status: result.status,
    source: result.source,
    trust: result.trust,
    origin: result.origin,
    errorsTruncated: result.errorsTruncated,
    errors: result.errors,
    safety: result.safety,
    safetyTruncated: result.safetyTruncated,
    limitations: result.limitations,
  };
}

function counts(result: ValidationResult): string {
  const warnings = result.safety.filter((f) => f.severity === "warning").length;
  const advisories = result.safety.length - warnings;
  return (
    `${result.status}  errors=${result.errors.length}  warnings=${warnings}  ` +
    `advisories=${advisories}  limitations=${result.limitations.length}  trust=${result.trust}`
  );
}

/* --------------------------------------------------------------- registration */

export function registerEnvironmentDefinitionTools(
  server: McpServer,
  policy: Policy,
  workspaceRoot: string = process.cwd(),
): string[] {
  const profile = activeProfile(policy);
  const registered: string[] = [];

  const define = <C extends GateableConfig, A extends unknown[]>(
    spec: ToolSpec<C, A>,
  ) => {
    if (defineTool(server, policy, profile, spec)) registered.push(spec.name);
  };

  define({
    name: "cursor_validate_environment_definition",
    config: {
      title: "Cursor: validate environment definition",
      description:
        "Check a Cursor environment definition against the published schema. Schema errors, " +
        "safety warnings, and capability limitations are reported separately.",
      inputSchema: {
        definition: DefinitionInput,
        syncTarget: z
          .strictObject({
            environmentPublicId: z.string().min(1),
            environmentJsonPath: z
              .string()
              .nullable()
              .optional()
              .describe(
                "Exactly as read from environment-info: null means database-managed, a path " +
                  "means repository-file managed, omitted means unknown and stops synchronization.",
              ),
          })
          .optional()
          .describe(
            "Ask for a synchronization request for Environment Operations. Never a Save.",
          ),
      },
      outputSchema: {
        ...REPORT_OUT,
        syncRequest: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: LOCAL_READ,
    },
    handler: async (call: {
      definition: DefinitionInputArgs;
      syncTarget?: {
        environmentPublicId: string;
        environmentJsonPath?: string | null;
      };
    }) => {
      const result = await loadDefinition(call.definition, "definition", workspaceRoot);
      const structured = report(result);
      const lines = [counts(result)];

      // A synchronization request exists only for a document that validated:
      // that is what makes it a *validated* request.
      if (call.syncTarget !== undefined && result.definition !== undefined) {
        const request = buildSynchronizationRequest({
          environmentPublicId: call.syncTarget.environmentPublicId,
          definition: result.definition,
          ...(call.syncTarget.environmentJsonPath === undefined
            ? {}
            : { environmentJsonPath: call.syncTarget.environmentJsonPath }),
          safety: result.safety,
        });
        structured.syncRequest = request;
        lines.push(
          `sync: managedAs=${request.managedAs} ready=${request.ready} persisted=false`,
        );
      } else if (call.syncTarget !== undefined) {
        lines.push("sync: not prepared; the definition did not validate");
      }

      for (const issue of result.errors) lines.push(`error ${issue.path}: ${issue.message}`);
      for (const finding of result.safety) {
        lines.push(`${finding.severity} ${finding.code} ${finding.path}: ${finding.label}`);
      }
      for (const limitation of result.limitations) {
        lines.push(`limitation ${limitation.code}: ${limitation.message}`);
      }

      return ok({
        source: result.origin,
        text: lines.join("\n"),
        structured,
        policy,
      });
    },
  });

  define({
    name: "cursor_inspect_environment_definition",
    config: {
      title: "Cursor: inspect environment definition",
      description:
        "Normalized view of a Cursor environment definition: install and start, terminals, " +
        "ports, MCP policy, container build paths, and snapshot input. Scripts are digests.",
      inputSchema: { definition: DefinitionInput },
      outputSchema: {
        ...REPORT_OUT,
        normalized: z.record(z.string(), z.unknown()).optional(),
      },
      annotations: LOCAL_READ,
    },
    handler: async (call: { definition: DefinitionInputArgs }) => {
      const result = await loadDefinition(call.definition, "definition", workspaceRoot);
      const structured = report(result);
      const lines = [counts(result)];

      if (result.definition !== undefined) {
        const normalized = normalizeDefinition(result.definition);
        structured.normalized = normalized;
        lines.push(
          `install=${normalized.install === null ? "none" : normalized.install.digest}  ` +
            `start=${normalized.start === null ? "none" : normalized.start.digest}  ` +
            `terminals=${normalized.terminals.length}  ports=${normalized.ports.length}  ` +
            `mcp=${normalized.mcp.policy}  ` +
            `base=${normalized.snapshot.base}  ` +
            `snapshot=${normalized.snapshot.baseSnapshotId ?? "none"}  ` +
            `agentCanUpdateSnapshot=${normalized.snapshot.agentCanUpdateSnapshot} ` +
            `(effective; configured=${
              normalized.snapshot.agentCanUpdateSnapshotConfigured ?? "unset"
            })`,
        );
      }
      for (const issue of result.errors) lines.push(`error ${issue.path}: ${issue.message}`);
      for (const limitation of result.limitations) {
        lines.push(`limitation ${limitation.code}: ${limitation.message}`);
      }

      return ok({
        source: result.origin,
        text: lines.join("\n"),
        structured,
        policy,
      });
    },
  });

  define({
    name: "cursor_diff_environment_definition",
    config: {
      title: "Cursor: diff environment definitions",
      description:
        "Bounded semantic diff between two Cursor environment definitions. Scripts and MCP " +
        "patterns are compared by digest, so no field value can leave through the diff.",
      inputSchema: { base: DefinitionInput, proposed: DefinitionInput },
      outputSchema: {
        status: z.string(),
        base: z.object(BOUNDED_REPORT_OUT).optional(),
        proposed: z.object(BOUNDED_REPORT_OUT).optional(),
        identical: z.boolean().optional(),
        truncated: z.boolean().optional(),
        changes: z
          .array(
            z.object({
              path: z.string(),
              change: z.string(),
              before: z.string().optional(),
              after: z.string().optional(),
              redacted: z.boolean(),
            }),
          )
          .optional(),
      },
      annotations: LOCAL_READ,
    },
    handler: async (call: {
      base: DefinitionInputArgs;
      proposed: DefinitionInputArgs;
    }) => {
      const base = await loadDefinition(call.base, "base", workspaceRoot);
      const proposed = await loadDefinition(call.proposed, "proposed", workspaceRoot);
      const structured: Record<string, unknown> = {
        status: "invalid",
        base: report(base),
        proposed: report(proposed),
      };
      const lines: string[] = [`base: ${counts(base)}`, `proposed: ${counts(proposed)}`];

      // Both sides must validate first: a diff against a document that is not a
      // legal definition would describe a shape Cursor would never accept.
      if (base.definition === undefined || proposed.definition === undefined) {
        lines.push(
          "no diff: both documents must validate before they can be compared semantically",
        );
        return ok({
          source: `${base.origin} vs ${proposed.origin}`,
          text: lines.join("\n"),
          structured,
          policy,
        });
      }

      const diff = diffDefinitions(base.definition, proposed.definition);
      structured.status = "valid";
      structured.identical = diff.identical;
      structured.truncated = diff.truncated;
      structured.changes = diff.changes;
      lines.push(
        `changes=${diff.changes.length}${diff.truncated ? ` (capped)` : ""} identical=${diff.identical}`,
      );
      for (const change of diff.changes) {
        lines.push(
          `${change.change} ${change.path}${change.redacted ? " [digest]" : ""}: ` +
            `${change.before ?? "-"} -> ${change.after ?? "-"}`,
        );
      }

      return ok({
        source: `${base.origin} vs ${proposed.origin}`,
        text: lines.join("\n"),
        structured,
        policy,
      });
    },
  });

  return registered;
}
