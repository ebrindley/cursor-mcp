/** Budget accounting for structured output, at the unit level. */

import { describe, expect, it } from "vitest";
import { z } from "zod";
import { sanitizeDeep, structuredCost } from "../src/tools/result.js";

describe("structuredCost", () => {
  const payloads: unknown[] = [
    { items: [], complete: true },
    { items: [{ index: 0, agentId: "bc-1", runId: "run-1", outcome: "read" }] },
    {
      items: Array.from({ length: 40 }, (_v, i) => ({
        index: i,
        agentId: `bc-${i}`,
        runId: `run-${i}`,
        outcome: "read",
        prUrls: ["https://github.com/ExampleOrg/ExampleRepo/pull/12"],
      })),
      remaining: { fromIndex: 40, count: 24, indices: "40-63" },
      nested: [[{ deep: ["x".repeat(70), 12.5, null, true] }]],
    },
  ];

  it("bounds what sanitizeDeep charges, so a payload budgeted by it is not truncated", () => {
    for (const payload of payloads) {
      const cost = structuredCost(payload);
      // Exactly the budget it says it needs is enough. One byte less is the
      // interesting case for the callers that reserve space up front.
      expect(sanitizeDeep(payload, cost).truncated).toBe(false);
    }
  });

  it("charges every part of a payload, so nothing is free to repeat", () => {
    const base = { items: [{ id: "a" }] };
    const wider = { items: [{ id: "a" }, { id: "b" }] };
    const longer = { items: [{ id: "aaaa" }] };
    expect(structuredCost(wider)).toBeGreaterThan(structuredCost(base));
    expect(structuredCost(longer)).toBeGreaterThan(structuredCost(base));
    expect(structuredCost({ n: 12_345 })).toBeGreaterThan(structuredCost({ n: 1 }));
  });
});

describe("sanitizeDeep budget", () => {
  it("bounds a wide array of scalars, not just of strings", () => {
    const { value, truncated } = sanitizeDeep(
      { counts: Array.from({ length: 100_000 }, () => 12_345) },
      128,
    );
    const kept = (value as { counts: number[] }).counts;
    expect(truncated).toBe(true);
    expect(kept.length).toBeLessThan(100_000);
    expect(JSON.stringify(value).length).toBeLessThan(1_024);
  });

  it("bounds deep nesting", () => {
    let nested: unknown = "leaf";
    for (let i = 0; i < 2_000; i += 1) nested = { a: nested, b: "x".repeat(50) };
    const { value, truncated } = sanitizeDeep({ root: nested }, 256);
    expect(truncated).toBe(true);
    expect(JSON.stringify(value).length).toBeLessThan(4_096);
  });

  it("bounds long keys as well as values", () => {
    const wide: Record<string, string> = {};
    for (let i = 0; i < 500; i += 1) wide[`${"k".repeat(300)}${i}`] = "v";
    const { value, truncated } = sanitizeDeep(wide, 512);
    expect(truncated).toBe(true);
    expect(Object.keys(value as object).length).toBeLessThan(500);
    for (const key of Object.keys(value as object)) {
      expect(Buffer.byteLength(key, "utf8")).toBeLessThanOrEqual(300);
    }
  });

  it("leaves a small payload untouched and unflagged", () => {
    const input = { models: ["a", "b"], count: 2, ok: true, missing: null };
    const { value, truncated } = sanitizeDeep(input, 32_768);
    expect(truncated).toBe(false);
    expect(value).toEqual(input);
  });

  it("never emits a partial code point when the budget runs out mid-character", () => {
    // Budget 5: two bytes of per-entry overhead, one for the key "s", leaving two
    // bytes for a value whose first character needs three. The snowman must be
    // dropped whole rather than sliced into a replacement character.
    const { value, truncated } = sanitizeDeep({ s: "☃☃" }, 5);
    const s = (value as { s: string }).s;
    expect(typeof s).toBe("string");
    expect(s).not.toContain("�");
    expect(truncated).toBe(true);
  });

  it("drops an entry entirely when the budget cannot even cover its overhead", () => {
    const { value, truncated } = sanitizeDeep({ s: "hello" }, 1);
    expect(value).toEqual({});
    expect(truncated).toBe(true);
  });

  it("drops a partially emitted array object instead of violating its schema", () => {
    const schema = z.object({
      items: z.array(
        z.object({
          id: z.string(),
          terminal: z.boolean(),
        }),
      ),
    });
    const input = {
      items: [
        { id: "abc", terminal: true },
        { id: "def", terminal: false },
      ],
    };

    // The first object exactly fits, but the second runs out of budget after
    // `id`. Emitting `{ id: "def" }` would violate the required output shape.
    const { value, truncated } = sanitizeDeep(input, 40);

    expect(truncated).toBe(true);
    expect(schema.safeParse(value).success).toBe(true);
    expect((value as typeof input).items).toEqual([input.items[0]]);
  });
});

describe("sanitizeDeep never fabricates a field name", () => {
  it("drops a key rather than collapsing it to the empty string", () => {
    // Two long keys under a tiny budget both cap to "", and the second would
    // overwrite the first if either were admitted.
    const { value, truncated } = sanitizeDeep(
      { [`${"a".repeat(100)}1`]: "x", [`${"a".repeat(100)}2`]: "y" },
      3,
    );
    expect(Object.keys(value as object)).not.toContain("");
    expect(truncated).toBe(true);
  });
});

describe("sanitizeDeep reports every overrun it cannot slice", () => {
  it("flags a primitive wider than the whole budget", () => {
    // A number cannot be truncated -- slicing it would yield a different number
    // -- so it is emitted whole and the overrun is reported.
    const { value, truncated } = sanitizeDeep({ v: [Number.MAX_VALUE] }, 5);
    expect(truncated).toBe(true);
    expect((value as { v: number[] }).v[0]).toBe(Number.MAX_VALUE);
  });

  it("keeps the first of two keys that sanitize to the same name", () => {
    // A control character makes these distinct on the wire and identical after
    // sanitizing; the second must not silently replace the first.
    const NUL = "\u0000";
    const { value, truncated } = sanitizeDeep(
      { [`${NUL}a`]: "first", a: "second" },
      32_768,
    );
    expect(value).toEqual({ a: "first" });
    expect(truncated).toBe(true);
  });
});

describe("sanitizeDeep handles keys that collide with Object.prototype", () => {
  const NUL = "\u0000";

  it("keeps __proto__ as a real own property instead of losing it", () => {
    // Plain assignment invokes the inherited setter: the field vanishes, the
    // collision check never fires, and nothing is reported.
    const { value, truncated } = sanitizeDeep(
      { [`${NUL}__proto__`]: "first", ["__proto__"]: "second" },
      32_768,
    );
    expect(Object.hasOwn(value as object, "__proto__")).toBe(true);
    // Compared as text: an object literal written `{ __proto__: "first" }` sets a
    // prototype rather than a property, so it is useless as an expectation here.
    expect(JSON.stringify(value)).toBe('{"__proto__":"first"}');
    expect(truncated).toBe(true);
  });

  it("pollutes neither Object.prototype nor the result's prototype", () => {
    const hostile: unknown = JSON.parse('{"__proto__":{"polluted":true},"x":1}');
    const { value } = sanitizeDeep(hostile, 32_768);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(value as object)).toBe(Object.prototype);
  });

  it("passes other inherited names through unchanged", () => {
    const input = JSON.parse('{"constructor":"c","toString":"t"}') as unknown;
    const { value, truncated } = sanitizeDeep(input, 32_768);
    expect(value).toEqual({ constructor: "c", toString: "t" });
    expect(truncated).toBe(false);
  });
});
