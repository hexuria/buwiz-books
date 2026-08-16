import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseModelJson, stripJsonFences } from "../../../src/lib/ai/parse-model-json";

const schema = z.object({ name: z.string(), amount: z.number() });

describe("stripJsonFences", () => {
  it("returns unfenced text unchanged", () => {
    expect(stripJsonFences('{"a":1}')).toBe('{"a":1}');
  });

  it("strips ```json fences", () => {
    expect(stripJsonFences('```json\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips bare ``` fences", () => {
    expect(stripJsonFences('```\n{"a":1}\n```')).toBe('{"a":1}');
  });

  it("strips a fence with a language tag and surrounding whitespace", () => {
    expect(stripJsonFences('  ```JSON\n{"a":1}\n```  ')).toBe('{"a":1}');
  });

  it("handles a missing closing fence", () => {
    expect(stripJsonFences('```json\n{"a":1}')).toBe('{"a":1}');
  });
});

describe("parseModelJson", () => {
  it("parses valid fenced output", () => {
    const result = parseModelJson(schema, '```json\n{"name":"Coffee","amount":4.5}\n```');
    expect(result).toEqual({ ok: true, data: { name: "Coffee", amount: 4.5 } });
  });

  it("parses valid unfenced output", () => {
    const result = parseModelJson(schema, '{"name":"Coffee","amount":4.5}');
    expect(result.ok).toBe(true);
  });

  it("never throws on invalid JSON — returns needsReview with the raw text", () => {
    const result = parseModelJson(schema, "I'm sorry, I cannot parse this document.");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.needsReview).toBe(true);
      expect(result.issues[0]).toContain("invalid JSON");
      expect(result.rawText).toContain("cannot parse");
    }
  });

  it("reports schema violations with field paths", () => {
    const result = parseModelJson(schema, '{"name":"Coffee","amount":"4.50"}');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues.some((i) => i.startsWith("amount:"))).toBe(true);
    }
  });

  it("reports missing required fields", () => {
    const result = parseModelJson(schema, '{"name":"Coffee"}');
    expect(result.ok).toBe(false);
  });

  it("rejects a JSON array when an object is expected", () => {
    const result = parseModelJson(schema, "[1,2,3]");
    expect(result.ok).toBe(false);
  });
});
