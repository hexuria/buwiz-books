// ============================================================================
// Chain policy. The OCR-egress rule is a product decision with a security
// rationale, so it is asserted here rather than left to code review.
// ============================================================================
import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHAINS,
  DOCUMENT_TASKS,
  JEV_MODEL,
  JEV_TASKS,
  applyJevPolicy,
  assertOcrPolicy,
  enforceJevTaskScope,
  enforceOcrPolicy,
  OcrEgressPolicyError,
  type ChainEntry,
} from "../../../src/lib/ai/chains";
import { AI_TASK_CATEGORY, type AiTaskName } from "../../../src/lib/ai/types";

const ALL_TASKS = Object.keys(DEFAULT_CHAINS) as AiTaskName[];

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

  it("DOCUMENT_TASKS is exactly the ocr-category tasks (no OCR policy holes)", () => {
    // form_2307_ocr lived in DEFAULT_CHAINS as Gemini-only but was missing
    // from this set, so enforceOcrPolicy left an org override pointing it
    // at OpenAI. Category === ocr means document bytes leave the tenant.
    const ocrTasks = (Object.entries(AI_TASK_CATEGORY) as [AiTaskName, string][])
      .filter(([, category]) => category === "ocr")
      .map(([task]) => task)
      .sort();
    expect([...DOCUMENT_TASKS].sort()).toEqual(ocrTasks);
  });

  it("text tasks are allowed to escalate to a redactable provider", () => {
    expect(DEFAULT_CHAINS.match_assist.some((h) => h.provider === "anthropic")).toBe(true);
    expect(DEFAULT_CHAINS.transaction_parse.some((h) => h.provider === "anthropic")).toBe(true);
  });

  it("ingest_triage and classify_document start on Flash Lite and escalate on Gemini", () => {
    const cheapThenFlash = [
      { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
      { provider: "gemini", model: "gemini-3-flash-preview" },
    ];
    expect(DEFAULT_CHAINS.ingest_triage).toEqual(cheapThenFlash);
    expect(DEFAULT_CHAINS.classify_document).toEqual(cheapThenFlash);
    expect(DEFAULT_CHAINS.ingest_triage.every((h) => h.provider === "gemini")).toBe(true);
    expect(DEFAULT_CHAINS.classify_document.every((h) => h.provider === "gemini")).toBe(true);
  });

  it("inbox stage 2 and entity matching are cheap Gemini-only picks from a closed list", () => {
    const cheapThenFlash = [
      { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
      { provider: "gemini", model: "gemini-3-flash-preview" },
    ];
    expect(DEFAULT_CHAINS.categorize_lines).toEqual(cheapThenFlash);
    expect(DEFAULT_CHAINS.match_party).toEqual(cheapThenFlash);
    expect(DOCUMENT_TASKS.has("categorize_lines")).toBe(false);
    expect(DOCUMENT_TASKS.has("match_party")).toBe(false);
  });

  it("other text tasks still start on gemini-3-flash-preview", () => {
    const otherTextTasks: AiTaskName[] = [
      "date_parse",
      "transaction_parse",
      "txn_prefill",
      "reflection",
      "match_assist",
      "coa_draft",
      "category_mapping_suggest",
    ];
    for (const task of otherTextTasks) {
      expect(DEFAULT_CHAINS[task][0], `${task} first hop`).toEqual({
        provider: "gemini",
        model: "gemini-3-flash-preview",
      });
    }
  });

  it("document/OCR default chains stay on the image models (untouched)", () => {
    const ocrThenPro = [
      { provider: "gemini", model: "gemini-3.1-flash-image-preview" },
      { provider: "gemini", model: "gemini-3-pro-image-preview" },
    ];
    expect(DEFAULT_CHAINS.receipt_ocr).toEqual(ocrThenPro);
    expect(DEFAULT_CHAINS.bill_ocr).toEqual(ocrThenPro);
    expect(DEFAULT_CHAINS.statement_ocr).toEqual(ocrThenPro);
    expect(DEFAULT_CHAINS.form_2307_ocr).toEqual(ocrThenPro);
    expect(DEFAULT_CHAINS.bbox_scan).toEqual([
      { provider: "gemini", model: "gemini-3.1-flash-image-preview" },
    ]);
    expect(DEFAULT_CHAINS.email_extraction).toEqual([
      { provider: "gemini", model: "gemini-3.1-flash-image-preview" },
    ]);
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

  it("strips a non-Gemini override on form_2307_ocr (document-bytes task)", () => {
    const tampered = [
      { provider: "gemini" as const, model: "g" },
      { provider: "openai" as const, model: "gpt" },
      { provider: "openai_compatible" as const, model: "local" },
    ];
    expect(enforceOcrPolicy("form_2307_ocr", tampered)).toEqual([
      { provider: "gemini", model: "g" },
    ]);
  });

  it("rejects a wholly non-Gemini form_2307_ocr chain as empty (save path falls back)", () => {
    expect(enforceOcrPolicy("form_2307_ocr", [{ provider: "anthropic", model: "claude" }])).toEqual(
      [],
    );
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

  it("throws when form_2307_ocr is pointed at another provider", () => {
    expect(() => assertOcrPolicy("form_2307_ocr", [{ provider: "openai", model: "gpt" }])).toThrow(
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

// ── Jev: opt-in first hop for classification, never anywhere else ──────────
describe("Jev chain policy", () => {
  const jevHop: ChainEntry = { provider: "jev", model: JEV_MODEL };

  it("Jev is in no default chain, so an org that has not opted in is unaffected", () => {
    for (const task of ALL_TASKS) {
      expect(
        DEFAULT_CHAINS[task].some((hop) => hop.provider === "jev"),
        task,
      ).toBe(false);
    }
  });

  it("Jev serves exactly the four redacted-text classification tasks, none of which sends document bytes", () => {
    expect([...JEV_TASKS].sort()).toEqual([
      "categorize_lines",
      "classify_document",
      "ingest_triage",
      "match_party",
    ]);
    for (const task of JEV_TASKS) {
      expect(DOCUMENT_TASKS.has(task), `${task} is a document task`).toBe(false);
      expect(AI_TASK_CATEGORY[task]).toBe("textAnalysis");
    }
  });

  it("opted in: Jev is the first hop and the Gemini default chain is the fallback", () => {
    for (const task of JEV_TASKS) {
      expect(applyJevPolicy(task, DEFAULT_CHAINS[task], true)).toEqual([
        jevHop,
        ...DEFAULT_CHAINS[task],
      ]);
    }
  });

  it("not opted in: every chain comes back as the very same array (byte-identical)", () => {
    for (const task of ALL_TASKS) {
      expect(applyJevPolicy(task, DEFAULT_CHAINS[task], false)).toBe(DEFAULT_CHAINS[task]);
    }
  });

  it("opted in: tasks outside JEV_TASKS are returned untouched", () => {
    for (const task of ALL_TASKS.filter((t) => !JEV_TASKS.has(t))) {
      expect(applyJevPolicy(task, DEFAULT_CHAINS[task], true)).toBe(DEFAULT_CHAINS[task]);
    }
  });

  it("an override that already names Jev keeps its own placement (no duplicate hop)", () => {
    const override: ChainEntry[] = [
      { provider: "gemini", model: "gemini-3.1-flash-lite-preview" },
      { provider: "jev", model: "jev-custom" },
    ];
    expect(applyJevPolicy("ingest_triage", override, true)).toBe(override);
  });

  it("strips Jev from every task it does not serve, keeping the other hops by reference", () => {
    const gemini: ChainEntry = { provider: "gemini", model: "g" };
    const anthropic: ChainEntry = { provider: "anthropic", model: "c" };
    const tampered = [jevHop, gemini, anthropic];
    for (const task of ALL_TASKS.filter((t) => !JEV_TASKS.has(t))) {
      const scoped = enforceJevTaskScope(task, tampered);
      expect(scoped).toEqual([gemini, anthropic]);
      expect(scoped[0]).toBe(gemini);
      expect(applyJevPolicy(task, tampered, true)).toEqual([gemini, anthropic]);
    }
  });

  it("Jev can never appear in an OCR task chain, even when opted in with a Jev override", () => {
    for (const task of DOCUMENT_TASKS) {
      const override: ChainEntry[] = [jevHop, ...DEFAULT_CHAINS[task]];
      for (const chain of [DEFAULT_CHAINS[task], override]) {
        const resolved = enforceOcrPolicy(task, applyJevPolicy(task, chain, true));
        expect(
          resolved.some((hop) => hop.provider === "jev"),
          task,
        ).toBe(false);
        expect(() => assertOcrPolicy(task, resolved)).not.toThrow();
      }
      // And the OCR clamp alone would stop Jev even if a future edit put an
      // OCR task into JEV_TASKS by mistake.
      expect(() => assertOcrPolicy(task, [jevHop])).toThrow(OcrEgressPolicyError);
    }
  });
});
