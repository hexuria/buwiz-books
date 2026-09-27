// ============================================================================
// Confidence trap (inbox v2 review finding 9): normalizeConfidence reads a
// bare 1 as 1% unless the scale is pinned. Every schema Jev answers must pin
// 0..1, and every reader of those results must say so with the unit hint.
// ============================================================================
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { JEV_TASKS } from "../../../src/lib/ai/chains";
import { normalizeConfidence } from "../../../src/lib/ai/confidence";
import { getTaskEntry } from "../../../src/lib/ai/prompts";
import { toStrictJsonSchema } from "../../../src/lib/ai/schema-strict";

type JsonSchema = { properties: Record<string, { type?: string; description?: string }> };

describe("Jev task schemas pin confidence to the unit scale", () => {
  it("every Jev task schema describes confidence as 0.0 to 1.0, on the wire too", () => {
    for (const task of JEV_TASKS) {
      const schema = getTaskEntry(task).schema;
      const plain = z.toJSONSchema(schema) as unknown as JsonSchema;
      expect(plain.properties.confidence.type, task).toBe("number");
      expect(plain.properties.confidence.description, task).toMatch(/0\.0 to 1\.0/);

      // The strict schema is what the Jev adapter actually sends.
      const strict = toStrictJsonSchema(schema) as unknown as JsonSchema;
      expect(strict.properties.confidence.description, task).toMatch(/0\.0 to 1\.0/);
    }
  });

  it("with the scale pinned, a bare 1 reads as certain rather than 1%", () => {
    expect(normalizeConfidence(1, { scaleHint: "unit" })).toBe(1);
    expect(normalizeConfidence(1)).toBe(0.01);
  });

  it("every reader of a Jev task result passes the unit scale hint", () => {
    const read = (rel: string) => readFileSync(join(__dirname, "../../..", rel), "utf-8");
    expect(read("src/lib/ai/ingest-triage.ts")).toContain(
      'normalizeConfidence(result.data.confidence, { scaleHint: "unit" })',
    );
    expect(read("src/routes/api/-ai-classify-document.ts")).toContain(
      'normalizeConfidence(result.confidence, { scaleHint: "unit" })',
    );
  });
});
