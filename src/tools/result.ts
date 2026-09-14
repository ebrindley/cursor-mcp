/**
 * The one place a tool result is built.
 *
 * Every tool returns through `ok` or `fail`. That is the whole point of this
 * module: an earlier version let two paths bypass the untrusted-data envelope --
 * thrown errors, whose messages the MCP SDK surfaces verbatim, and
 * `structuredContent`, which was assembled by hand from raw API strings. Both
 * carried Cursor-originated text to the model unfenced and uncapped.
 *
 * Tools must not construct a result literal directly.
 */

import { CursorApiError, CursorUsageExhaustedError, PolicyError } from "../errors.js";
import { CapabilityError } from "../lifecycle-model.js";
import { WorkspaceCapabilityError } from "../workspace-controls.js";
import type { Policy } from "../config.js";
import { log } from "../log.js";
import { capBytes, sanitize, wrap } from "../untrusted.js";
import type { z } from "zod";

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  /** The SDK's CallToolResult carries `_meta` and other open fields. */
  [key: string]: unknown;
}

/** Longest field name we will echo. Keys are API-supplied under loose schemas. */
const MAX_KEY_BYTES = 256;

/**
 * Serialization overhead charged per array element and per object entry.
 *
 * Content bytes alone do not bound the payload: a thousand empty strings cost
 * nothing to sanitize but still serialize to roughly three kilobytes of quotes
 * and commas. Charging per entry bounds the element count as well as the
 * content, whatever the entries hold.
 */
const PER_ENTRY_BYTES = 2;

/**
 * What `sanitizeDeep` will charge for a payload, before it is built.
 *
 * `ok` reports truncation honestly but cannot undo it: a tool that assembles a
 * list of items has to decide how many fit *before* it commits to them, or its
 * caller reads a silently shortened list and a note it may not connect to any
 * particular missing entry. This mirrors `walk`'s charges exactly -- content
 * bytes, `PER_ENTRY_BYTES` per array element and object entry, key bytes, and
 * `String(value).length` for primitives -- so a payload whose cost fits inside
 * `maxResponseBytes` is a payload `sanitizeDeep` does not truncate.
 *
 * It is an upper bound, never an underestimate: sanitizing can only shrink a
 * string, so a cost computed from raw text charges at least what the sanitized
 * text spends.
 */
export function structuredCost(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (Array.isArray(value)) {
    let total = 0;
    for (const item of value) total += PER_ENTRY_BYTES + structuredCost(item);
    return total;
  }
  if (value !== null && typeof value === "object") {
    let total = 0;
    for (const [key, item] of Object.entries(value)) {
      total += PER_ENTRY_BYTES + Buffer.byteLength(key, "utf8") + structuredCost(item);
    }
    return total;
  }
  return String(value).length;
}

export interface Sanitized {
  value: unknown;
  /** True when the byte budget ran out and entries were dropped. */
  truncated: boolean;
}

/**
 * Sanitize every string reachable in a structured payload, within one shared
 * byte budget.
 *
 * `structuredContent` reaches the model just as surely as `content` does, so it
 * gets the same treatment. Keys are sanitized too: a field name is API-supplied
 * once loose schemas start passing unknown fields through.
 *
 * The budget is for the whole structure, not per string. Capping each string
 * independently bounds nothing: an array of ten thousand near-limit strings
 * still lands ten thousand times the cap in the client's context.
 *
 * The bound is `maxBytes` plus one unsliceable primitive plus structural
 * punctuation -- not a hard ceiling, because a number cannot be cut in half
 * without becoming a different number. Any overrun sets `truncated`, so it is
 * always reported. Fuzzed over 2,000 generated structures at caps from 1 to
 * 1024 bytes: no unreported truncation and no fabricated field names.
 */
export function sanitizeDeep(value: unknown, maxBytes: number): Sanitized {
  const budget = { left: maxBytes, truncated: false, dropped: 0 };
  return { value: walk(value, budget), truncated: budget.truncated };
}

interface Budget {
  left: number;
  truncated: boolean;
  /** Structural entries dropped because they could not be emitted completely. */
  dropped: number;
}

function spend(text: string, budget: Budget, limit: number): string {
  const capped = capBytes(sanitize(text), Math.max(Math.min(limit, budget.left), 0));
  if (capped.truncated) budget.truncated = true;
  budget.left -= Buffer.from(capped.text, "utf8").byteLength;
  return capped.text;
}

function walk(value: unknown, budget: Budget): unknown {
  if (typeof value === "string") {
    return spend(value, budget, budget.left);
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    for (const item of value) {
      // Require the overhead up front. Admitting an entry the budget cannot
      // cover produces empty placeholders instead of an honest truncation.
      if (budget.left < PER_ENTRY_BYTES) {
        budget.dropped += 1;
        break;
      }
      budget.left -= PER_ENTRY_BYTES;
      const droppedBefore = budget.dropped;
      const walked = walk(item, budget);
      if (budget.dropped > droppedBefore) {
        budget.truncated = true;
        break;
      }
      out.push(walked);
    }
    if (out.length < value.length) budget.truncated = true;
    return out;
  }
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value);
    const out: Record<string, unknown> = {};
    let kept = 0;
    for (const [key, item] of entries) {
      if (budget.left < PER_ENTRY_BYTES) {
        budget.dropped += 1;
        break;
      }
      budget.left -= PER_ENTRY_BYTES;
      const safeKey = sanitize(key);
      const name = spend(key, budget, MAX_KEY_BYTES);
      // A partial key is a different field name. Drop the entry rather than
      // fabricate a schema-breaking key when the shared budget runs out.
      if (name !== safeKey || (name === "" && key !== "")) {
        budget.dropped += 1;
        break;
      }
      // Sanitizing can make two distinct keys equal -- "\u0000a" becomes "a".
      // Keep the first and report the drop rather than let the later one
      // silently replace a field the caller already read.
      if (Object.hasOwn(out, name)) {
        budget.truncated = true;
        continue;
      }
      // defineProperty, not assignment: `out["__proto__"] = v` invokes the
      // inherited setter, so the field silently vanishes and would not even
      // register as a collision. Every API-supplied key becomes a plain own
      // property here, whatever it is called.
      Object.defineProperty(out, name, {
        value: walk(item, budget),
        enumerable: true,
        writable: true,
        configurable: true,
      });
      kept += 1;
    }
    if (kept < entries.length) budget.truncated = true;
    return out;
  }
  // Numbers, booleans, null, and undefined cannot carry instructions, but they
  // still occupy the client's context. Charging them keeps element count bounded
  // too -- otherwise an array of a million zeroes spends nothing and passes.
  //
  // A single primitive can be wider than the whole budget: Number.MAX_VALUE
  // serializes to 23 characters. Slicing a number would produce a different
  // number, so it is emitted whole and the overrun is reported instead.
  const cost = String(value).length;
  if (cost > budget.left) budget.truncated = true;
  budget.left -= cost;
  return value;
}

/** A successful result: fenced summary text plus sanitized structured fields. */
export function ok(args: {
  source: string;
  text: string;
  structured: Record<string, unknown>;
  policy: Policy;
}): ToolResult {
  const { source, text, structured, policy } = args;
  const sanitized = sanitizeDeep(structured, policy.maxResponseBytes);
  const content: Array<{ type: "text"; text: string }> = [
    { type: "text", text: wrap(source, text, policy.maxResponseBytes) },
  ];
  if (sanitized.truncated) {
    // Outside the fence, because this sentence is ours and not Cursor's. A cap
    // that is not reported reads as a complete result.
    content.push({
      type: "text",
      text:
        `Note: structured output exceeded ${policy.maxResponseBytes} bytes and was ` +
        `truncated. Narrow the request to see the rest.`,
    });
  }
  return {
    content,
    structuredContent: sanitized.value as Record<string, unknown>,
  };
}

/**
 * A failed result.
 *
 * The message is fenced like any other Cursor-originated text, because an
 * upstream error body is written by the same parties that write repository and
 * pull-request content. `Refused by policy:` is ours and stays outside the
 * fence; what follows it does not. Capability residuals keep structured
 * next-steps for the caller.
 */
export function fail(error: unknown, policy: Policy): ToolResult {
  if (error instanceof PolicyError) {
    // The refusal is ours; the words inside it are not. "environment <name> is
    // not in the active profile" quotes a name Cursor supplied, and stripping
    // control characters does nothing to a name that reads as a sentence -- it
    // would arrive as prose in a line the model has every reason to trust.
    // So the reason travels in the same labelled envelope as any other
    // Cursor-originated text, under the same budget and the same truncation
    // notice, behind a fixed prefix that is ours alone.
    return {
      content: [
        {
          type: "text",
          text: `Refused by policy:\n${wrap(
            "policy refusal",
            error.message,
            policy.maxResponseBytes,
          )}`,
        },
      ],
      isError: true,
    };
  }

  if (error instanceof CursorUsageExhaustedError) {
    // The guidance is ours, so it stays outside the fence, like the policy
    // refusal above. The upstream message inside it is Cursor's and is fenced.
    return {
      content: [
        {
          type: "text",
          text: `${error.guidance}\n${wrap(
            `Cursor API error ${error.status}`,
            error.message,
            policy.maxResponseBytes,
          )}`,
        },
      ],
      isError: true,
    };
  }

  if (error instanceof CapabilityError) {
    const sanitized = sanitizeDeep(error.residual, policy.maxResponseBytes);
    return {
      content: [
        {
          type: "text",
          text: `${error.residual.action}: ${error.residual.reason}`,
        },
      ],
      structuredContent: sanitized.value as Record<string, unknown>,
      isError: true,
    };
  }

  if (error instanceof WorkspaceCapabilityError) {
    const sanitized = sanitizeDeep(error.residual, policy.maxResponseBytes);
    return {
      content: [
        {
          type: "text",
          text: `${error.residual.action}: ${error.residual.reason}`,
        },
      ],
      structuredContent: sanitized.value as Record<string, unknown>,
      isError: true,
    };
  }

  const message = error instanceof Error ? error.message : String(error);
  const source =
    error instanceof CursorApiError
      ? `Cursor API error ${error.status}`
      : "tool error";
  return {
    content: [{ type: "text", text: wrap(source, message, policy.maxResponseBytes) }],
    isError: true,
  };
}

/**
 * Wrap a handler so no throw can escape unfenced.
 *
 * Without this, the SDK catches the throw itself and returns `error.message`
 * as-is -- outside the envelope, with control characters and fence markers
 * intact.
 */
export function guard<A extends unknown[]>(
  policy: Policy,
  handler: (...args: A) => Promise<ToolResult>,
  outputSchema?: z.ZodType,
): (...args: A) => Promise<ToolResult> {
  return async (...args: A) => {
    try {
      const result = await handler(...args);
      if (!result.isError && outputSchema !== undefined) {
        const parsed = outputSchema.safeParse(result.structuredContent);
        if (!parsed.success) {
          const issues = parsed.error.issues
            .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
            .join("; ");
          throw new Error(
            `structured tool output did not match its declared schema -- ${issues}`,
          );
        }
      }
      return result;
    } catch (error) {
      log.debug(error instanceof Error ? error.message : String(error));
      return fail(error, policy);
    }
  };
}
