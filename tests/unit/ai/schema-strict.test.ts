// ============================================================================
// OpenAI strict-mode JSON Schema conversion. These tests double as the
// three-provider intersection audit (§5): whatever strict mode strips must
// be enforced by the Zod schema app-side, which it is — the same schema
// re-validates every response.
// ============================================================================
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { toStrictJsonSchema } from "../../../src/lib/ai/schema-strict";
import { transactionParseOutputSchema } from "../../../src/lib/ai/schemas/transaction-parse";
import { statementOcrOutputSchema } from "../../../src/lib/ai/schemas/statement-ocr";
import { matchAssistOutputSchema } from "../../../src/lib/ai/schemas/match-assist";

describe("toStrictJsonSchema", () => {
  it("marks every property required and forbids extra keys", () => {
    const schema = z.object({ a: z.string(), b: z.number().optional() });
    const out = toStrictJsonSchema(schema) as any;
    expect(out.additionalProperties).toBe(false);
    expect(out.required.sort()).toEqual(["a", "b"]);
  });

  it("strips keywords strict mode rejects", () => {
    const schema = z.object({
      amount: z.number().min(0).max(100),
      code: z
        .string()
        .regex(/^[A-Z]+$/)
        .min(2),
    });
    const out = JSON.stringify(toStrictJsonSchema(schema));
    for (const keyword of ["minimum", "maximum", "pattern", "minLength"]) {
      expect(out).not.toContain(keyword);
    }
  });

  it("recurses into arrays and nested objects", () => {
    const schema = z.object({
      lines: z.array(z.object({ id: z.string(), qty: z.number().min(1) })),
    });
    const out = toStrictJsonSchema(schema) as any;
    expect(out.properties.lines.items.additionalProperties).toBe(false);
    expect(out.properties.lines.items.required).toEqual(["id", "qty"]);
    expect(JSON.stringify(out)).not.toContain("minimum");
  });

  it("inlines $refs so strict mode sees no cross-references", () => {
    const inner = z.object({ v: z.string() });
    const schema = z.object({ a: inner, b: inner });
    const out = JSON.stringify(toStrictJsonSchema(schema));
    expect(out).not.toContain("$ref");
    expect(out).not.toContain("$defs");
  });

  it("throws on recursive schemas rather than emitting something invalid", () => {
    const node: z.ZodType = z.lazy(() => z.object({ child: node.optional() }));
    expect(() => toStrictJsonSchema(z.object({ root: node }))).toThrow();
  });
});

describe("real task schemas convert cleanly", () => {
  it.each([
    ["transaction_parse", transactionParseOutputSchema],
    ["statement_ocr", statementOcrOutputSchema],
    ["match_assist", matchAssistOutputSchema],
  ])("%s", (_name, schema) => {
    const out = toStrictJsonSchema(schema as z.ZodType);
    const serialized = JSON.stringify(out);
    // No stripped keyword survives...
    for (const keyword of ["minimum", "maximum", "minLength", "maxLength", "multipleOf"]) {
      expect(serialized).not.toContain(`"${keyword}"`);
    }
    // ...and no unresolved reference does either.
    expect(serialized).not.toContain("$ref");
    expect((out as any).additionalProperties).toBe(false);
  });
});
