/**
 * Error types. Every message here is safe to surface to a model: none of them
 * ever carry the API key, the Authorization header, or raw request bodies.
 */

import type { ErrorClassification } from "./api-errors.js";

/** A non-2xx response from the Cursor API. */
export class CursorApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
    /** The documented machine-readable code from the body, when present. */
    readonly code?: string,
    /** Parsed from a Retry-After header, when the response carried one. */
    readonly retryAfterMs?: number,
    /**
     * What the body means for retrying, normalized across codes and messages.
     *
     * Separate from `code` on purpose: `code` is the documented wire value and
     * callers read it, so it is never overwritten by a verdict we derived.
     */
    readonly classification?: ErrorClassification,
  ) {
    super(message);
    this.name = "CursorApiError";
  }
}

/**
 * A run could not be created because the account's included Cloud Agent usage is
 * exhausted.
 *
 * Carries the upstream error unchanged plus one line of our own recovery
 * guidance, which `fail` renders outside the untrusted fence. Retrying is never
 * the answer, so the classification is fixed.
 */
export class CursorUsageExhaustedError extends CursorApiError {
  constructor(upstream: CursorApiError, readonly guidance: string) {
    super(
      upstream.status,
      upstream.message,
      upstream.code,
      upstream.retryAfterMs,
      "usage-limited",
    );
    this.name = "CursorUsageExhaustedError";
  }
}

/** The request did not complete: timeout, abort, or transport failure. */
export class CursorTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorTransportError";
  }
}

/** The response did not match the contract this operation depends on. */
export class CursorContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CursorContractError";
  }
}

/** The operator's policy refused this call. Message names what to change. */
export class PolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyError";
  }
}

/** Configuration is missing or malformed. Never contains secret values. */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}
