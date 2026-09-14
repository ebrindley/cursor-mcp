/**
 * The Cursor API's documented error codes, and what they mean for retrying.
 *
 * Source: the `Error` schema in the published OpenAPI document. The body shape
 * is `{ error: { code, message, helpUrl?, provider? } }`. The cross-API overview
 * page documents a flatter `{ error: string, message: string }` instead, so
 * `parseApiError` accepts both rather than betting on which one a gateway emits.
 *
 * The spec says "possible values include", so the list is open: an unrecognised
 * code must behave like no code at all, never like an error.
 */

/** A 429 that means "slow down". Retrying is the correct response. */
export const RATE_LIMITED = "rate_limit_exceeded";

/**
 * A 429 that means "you are out of quota". Retrying cannot succeed and only
 * burns the remaining attempts, so this one is not retried.
 */
export const USAGE_LIMITED = "usage_limit_exceeded";

/** Extracted from an error body, with everything optional -- it is untrusted. */
export interface ParsedApiError {
  code?: string;
  message?: string;
}

/**
 * What a 429 means for retrying, once the body has been read as a whole.
 *
 * The wire code alone is not enough. Cursor sends usage exhaustion under
 * `rate_limit_exceeded` as well as under `usage_limit_exceeded`, so the code is
 * kept as the documented contract it is and this normalized verdict is what the
 * retry scheduler consults.
 */
export type ErrorClassification = "rate-limited" | "usage-limited";

/** Retrying is the correct response: the limit clears on its own. */
export const RATE_LIMITED_CLASS: ErrorClassification = "rate-limited";

/** Retrying cannot succeed: the account is out of included usage. */
export const USAGE_LIMITED_CLASS: ErrorClassification = "usage-limited";

/**
 * Messages that mean "out of included usage" whatever code carries them.
 *
 * Recorded, not guessed: a live exhausted-usage refusal arrived as HTTP 429 with
 * code `rate_limit_exceeded` and the message "You've used all included Cloud
 * Agent usage: Enable on-demand usage to continue using Cloud Agents". The phrase
 * below is the part of that message that carries the meaning, matched
 * case-insensitively and free of apostrophes so a curly one cannot break the match.
 *
 * Keep this list to phrases an actual response or the documentation shows. Broad
 * keyword matching ("usage", "limit") would silently stop retrying ordinary
 * congestion, which is the one thing retrying does fix.
 */
const USAGE_EXHAUSTED_PHRASES = ["used all included cloud agent usage"] as const;

/** Whether an error body's message states that included usage is exhausted. */
export function isUsageExhaustedMessage(message: string | undefined): boolean {
  if (message === undefined) return false;
  const flat = message.toLowerCase();
  return USAGE_EXHAUSTED_PHRASES.some((phrase) => flat.includes(phrase));
}

/**
 * Normalize a parsed error body to its retry meaning, or undefined when the body
 * says nothing a retry decision can rest on.
 *
 * An unrecognised code stays unrecognised: absent classification means "decide
 * from the status alone", exactly as before.
 */
export function classifyApiError(parsed: ParsedApiError): ErrorClassification | undefined {
  if (parsed.code === USAGE_LIMITED) return USAGE_LIMITED_CLASS;
  if (parsed.code === RATE_LIMITED) {
    return isUsageExhaustedMessage(parsed.message)
      ? USAGE_LIMITED_CLASS
      : RATE_LIMITED_CLASS;
  }
  return undefined;
}

/**
 * Pull the code and message out of an error body, tolerating both documented
 * shapes and anything else without throwing.
 *
 * Never assume `error` is an object: reading `error.code` off a string is
 * `undefined`, but reading it off `null` throws, and a gateway can return
 * either.
 */
export function parseApiError(body: string): ParsedApiError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object") return {};

  const root = parsed as Record<string, unknown>;
  const error = root.error;

  // Nested: { error: { code, message } } -- the v1 schema.
  if (error !== null && typeof error === "object") {
    const nested = error as Record<string, unknown>;
    return {
      ...(typeof nested.code === "string" ? { code: nested.code } : {}),
      ...(typeof nested.message === "string" ? { message: nested.message } : {}),
    };
  }

  // Flat: { error: "Unauthorized", message: "..." } -- the overview page's shape.
  return {
    ...(typeof error === "string" ? { code: error } : {}),
    ...(typeof root.message === "string" ? { message: root.message } : {}),
  };
}
