/**
 * The API documents two different error body shapes. Guessing wrong turns a
 * clean 4xx into a crash, so both are covered here plus everything malformed.
 */

import { describe, expect, it } from "vitest";
import {
  RATE_LIMITED,
  USAGE_LIMITED,
  classifyApiError,
  parseApiError,
} from "../src/api-errors.js";

/**
 * The exact body of a recorded live exhausted-usage refusal, apostrophe
 * included. Every classification claim below rests on this being the recorded
 * text rather than a paraphrase of it.
 */
const RECORDED_USAGE_EXHAUSTED = {
  code: RATE_LIMITED,
  message:
    "You've used all included Cloud Agent usage: Enable on-demand usage to continue using Cloud Agents",
};

describe("parseApiError", () => {
  it("reads the nested v1 shape", () => {
    expect(
      parseApiError('{"error":{"code":"agent_busy","message":"a run is active"}}'),
    ).toEqual({ code: "agent_busy", message: "a run is active" });
  });

  it("reads the flat shape the overview page documents", () => {
    expect(
      parseApiError('{"error":"Unauthorized","message":"Invalid API key"}'),
    ).toEqual({ code: "Unauthorized", message: "Invalid API key" });
  });

  it("keeps helpUrl and provider out of the result", () => {
    const parsed = parseApiError(
      '{"error":{"code":"integration_not_connected","message":"m","helpUrl":"https://x","provider":"github"}}',
    );
    expect(parsed).toEqual({ code: "integration_not_connected", message: "m" });
  });

  it.each([
    ["not json at all", "<html>502</html>"],
    ["null", "null"],
    ["a bare array", "[1,2,3]"],
    ["a bare string", '"boom"'],
    ["an empty object", "{}"],
    ["error as null", '{"error":null}'],
    ["error as a number", '{"error":42}'],
    ["code as a number", '{"error":{"code":7,"message":"m"}}'],
    ["empty body", ""],
  ])("returns nothing and does not throw for %s", (_label, body) => {
    expect(() => parseApiError(body)).not.toThrow();
    const parsed = parseApiError(body);
    expect(parsed.code === undefined || typeof parsed.code === "string").toBe(true);
  });

  it("distinguishes the two documented 429 codes", () => {
    // Same status, opposite retry decisions.
    expect(RATE_LIMITED).not.toBe(USAGE_LIMITED);
  });
});

describe("classifyApiError", () => {
  it("reads the recorded usage-exhausted message sent under rate_limit_exceeded", () => {
    const body = JSON.stringify({ error: RECORDED_USAGE_EXHAUSTED });
    const parsed = parseApiError(body);
    // The wire code stays exactly what Cursor sent; only the verdict differs.
    expect(parsed.code).toBe(RATE_LIMITED);
    expect(classifyApiError(parsed)).toBe("usage-limited");
  });

  it("matches that message whatever its case and apostrophe", () => {
    expect(
      classifyApiError({
        code: RATE_LIMITED,
        message: "YOU HAVE USED ALL INCLUDED CLOUD AGENT USAGE: enable on-demand usage",
      }),
    ).toBe("usage-limited");
  });

  it("leaves ordinary congestion retryable", () => {
    expect(classifyApiError({ code: RATE_LIMITED, message: "slow down" })).toBe(
      "rate-limited",
    );
    // No message at all is congestion too: a plain "Too Many Requests" from a
    // read-side throttle carries no usage wording.
    expect(classifyApiError({ code: RATE_LIMITED })).toBe("rate-limited");
  });

  it("keeps the explicit usage code usage-limited", () => {
    expect(classifyApiError({ code: USAGE_LIMITED, message: "out of credits" })).toBe(
      "usage-limited",
    );
  });

  it("says nothing about codes it does not recognise", () => {
    // An unrecognised code must behave like no code at all, so the status alone
    // decides -- including when the body carries usage wording under it.
    expect(classifyApiError({ code: "agent_busy", message: "a run is active" })).toBeUndefined();
    expect(classifyApiError({})).toBeUndefined();
    expect(
      classifyApiError({ message: RECORDED_USAGE_EXHAUSTED.message }),
    ).toBeUndefined();
  });
});
