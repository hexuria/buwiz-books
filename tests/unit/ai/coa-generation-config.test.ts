import { describe, it, expect } from "vitest";
import { getTaskEntry } from "@/lib/ai/prompts/index";

/**
 * Regression guard for a failure only a live call surfaced.
 *
 * `maxOutputTokens` is a COMBINED budget on Gemini: reasoning tokens are billed
 * against it. Measured on gemini-3-flash-preview for the same coa_draft
 * request, `thoughtsTokenCount` ranged from ~1,200 to ~7,861 — and when it
 * spiked, only ~330 tokens were left for the JSON, so the response truncated
 * mid-string. Roughly one call in three failed to parse, which then escalates
 * the facade to the expensive next hop for nothing.
 *
 * Raising maxOutputTokens does NOT fix it: with 32,768 the model simply thought
 * for 31,456 tokens. Capping the thinking budget does — 0 truncations across
 * five consecutive live responses, all with thoughts=0.
 */
describe("COA task generation config", () => {
  it.each(["coa_draft", "category_mapping_suggest"] as const)(
    "%s caps the thinking budget below its output budget",
    (task) => {
      const { generation } = getTaskEntry(task);
      expect(generation).toBeDefined();
      expect(generation!.maxOutputTokens).toBeGreaterThan(0);

      // The cap is the whole point — without it the JSON truncates.
      expect(generation!.thinkingBudget).toBeGreaterThan(0);
      // And it must leave real room for the response itself.
      expect(generation!.thinkingBudget!).toBeLessThan(generation!.maxOutputTokens!);
      expect(generation!.maxOutputTokens! - generation!.thinkingBudget!).toBeGreaterThanOrEqual(
        4096,
      );
    },
  );

  it("keeps these tasks deterministic enough to be gradeable", () => {
    for (const task of ["coa_draft", "category_mapping_suggest"] as const) {
      expect(getTaskEntry(task).generation!.temperature).toBeLessThanOrEqual(0.3);
    }
  });
});
