// ============================================================================
// Chain policy. The OCR-egress rule is a product decision with a security
// rationale, so it is asserted here rather than left to code review.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAINS,
  DOCUMENT_TASKS,
  assertOcrPolicy,
  enforceOcrPolicy,
  OcrEgressPolicyError,
} from "../../../src/lib/ai/chains";
import type { AiTaskName } from "../../../src/lib/ai/types";

describe("default chains", () => {
  it("every task has at least one hop", () => {
    for (const [task, chain] of Object.entries(DEFAULT_CHAINS)) {
      expect(chain.length, `${task} has no hops`).toBeGreaterThan(0);
    }
  });

  it("every chain starts on Gemini (zero day-one behavior change)", () => {
    for (const [task, chain] of Object.entries(DEFAULT_CHAINS)) {
      expect(chain[0].provider, `${task} does not start on Gemini`).toBe("gemini");
    }
  });

  it("NO document task ever routes off Gemini", () => {
    for (const task of DOCUMENT_TASKS) {
      for (const hop of DEFAULT_CHAINS[task]) {
        expect(hop.provider, `${task} would send document bytes to ${hop.provider}`).toBe("gemini");
      }
    }
  });

  it("text tasks are allowed to escalate to a redactable provider", () => {
    expect(DEFAULT_CHAINS.match_assist.some((h) => h.provider === "anthropic")).toBe(true);
    expect(DEFAULT_CHAINS.transaction_parse.some((h) => h.provider === "anthropic")).toBe(true);
  });
});

describe("enforceOcrPolicy", () => {
  it("silently drops non-Gemini hops an org override tried to add to OCR", () => {
    const tampered = [
      { provider: "gemini" as const, model: "g" },
      { provider: "openai" as const, model: "gpt" },
    ];
    expect(enforceOcrPolicy("statement_ocr", tampered)).toEqual([
      { provider: "gemini", model: "g" },
    ]);
  });

  it("leaves text-task chains untouched", () => {
    const chain = [
      { provider: "gemini" as const, model: "g" },
      { provider: "anthropic" as const, model: "c" },
    ];
    expect(enforceOcrPolicy("transaction_parse", chain)).toEqual(chain);
  });
});

describe("assertOcrPolicy", () => {
  it("throws when a document task is pointed at another provider", () => {
    expect(() => assertOcrPolicy("bill_ocr", [{ provider: "anthropic", model: "claude" }])).toThrow(
      OcrEgressPolicyError,
    );
  });

  it("passes for a compliant document chain and for any text chain", () => {
    expect(() => assertOcrPolicy("bill_ocr", [{ provider: "gemini", model: "g" }])).not.toThrow();
    expect(() =>
      assertOcrPolicy("date_parse", [{ provider: "openai", model: "gpt" }]),
    ).not.toThrow();
  });

  it("guards every registered task name", () => {
    const tasks = Object.keys(DEFAULT_CHAINS) as AiTaskName[];
    for (const task of tasks) {
      expect(() => assertOcrPolicy(task, DEFAULT_CHAINS[task])).not.toThrow();
    }
  });
});
