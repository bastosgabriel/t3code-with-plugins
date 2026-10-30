import { describe, expect, it } from "vite-plus/test";
import { compilePluginSchema, PLUGIN_PAYLOAD_MAX_BYTES } from "./pluginSchema.ts";

describe("plugin schema boundary", () => {
  it("rejects unknown schema capabilities and validates closed nested payloads without stripping", () => {
    expect(compilePluginSchema({})({ custom: [1, true] })).toEqual({ custom: [1, true] });
    const decode = compilePluginSchema({
      type: "object",
      properties: {
        items: {
          type: "array",
          items: { type: "string", enum: ["one", "two"] },
          maxItems: 2,
        },
        revision: { type: "number", minimum: 0, maximum: 5 },
      },
      required: ["items"],
      additionalProperties: false,
    });
    expect(decode({ items: ["one"], revision: 1 })).toEqual({ items: ["one"], revision: 1 });
    for (const input of [
      { items: ["one"], extra: true },
      { items: ["three"] },
      { items: ["one", "two", "one"] },
      { items: [], revision: -1 },
      { items: [], revision: Number.NaN },
      { revision: 1 },
    ])
      expect(() => decode(input)).toThrow();
    for (const schema of [
      { type: "string", pattern: ".*" },
      { $ref: "https://example.com/schema" },
      { type: "object", properties: {}, required: ["missing"], additionalProperties: false },
      { type: "object", properties: {}, required: [], additionalProperties: true },
      { type: "string", enum: [] },
      { type: "number", minimum: 5, maximum: 1 },
    ])
      expect(() => compilePluginSchema(schema)).toThrow();
  });

  it("rejects oversized payloads, cycles and excessively nested schemas", () => {
    const decode = compilePluginSchema({ type: "string" });
    expect(() => decode("x".repeat(PLUGIN_PAYLOAD_MAX_BYTES))).toThrow();
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    expect(() => compilePluginSchema(cycle)).toThrow();
    let nested: unknown = { type: "boolean" };
    for (let i = 0; i < 20; i++) nested = { type: "array", items: nested };
    expect(() => compilePluginSchema(nested)).toThrow();
    expect(compilePluginSchema({ type: "string", maxLength: 1 })("🙂")).toBe("🙂");
    expect(() => compilePluginSchema({ type: "string", maxLength: 1 })("🙂🙂")).toThrow();
  });
});
