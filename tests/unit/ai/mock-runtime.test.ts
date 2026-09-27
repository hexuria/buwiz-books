import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { DOCUMENT_TASKS, JEV_TASKS } from "../../../src/lib/ai/chains";
import { normalizeConfidence } from "../../../src/lib/ai/confidence";
import { createAiComplete, type AiHopInvocation } from "../../../src/lib/ai/facade-core";
import { JEV_MOCK_RESPONSES, MOCK_RESPONSES } from "../../../src/lib/ai/fixtures/mock-responses";
import {
  createMockAiCompletionRuntime,
  mockAiCompletionRuntime,
} from "../../../src/lib/ai/mock-runtime";
import { parseModelJson } from "../../../src/lib/ai/parse-model-json";
import { getTaskEntry, TASK_REGISTRY } from "../../../src/lib/ai/prompts";
import { toRedactedPrompt } from "../../../src/lib/ai/redact";
import { AI_TASK_CATEGORY, type AiTaskName } from "../../../src/lib/ai/types";

const ALL_TASKS = Object.keys(AI_TASK_CATEGORY) as AiTaskName[];
const CTX = { orgId: "org-mock" };

/** Enough prompt input that `build()` does not throw. Output is canned. */
const MINIMAL_TASK_INPUTS: Record<AiTaskName, unknown> = {
  date_parse: { query: "today", currentDate: "2026-07-25" },
  transaction_parse: {
    prompt: "paid staples 42.50",
    currentDate: "2026-07-25",
    accounts: [],
    parties: [],
    departments: [],
    locations: [],
  },
  receipt_ocr: {
    currentDate: "2026-07-25",
    accounts: [],
    parties: [],
    departments: [],
    locations: [],
  },
  bill_ocr: { currentDate: "2026-07-25" },
  statement_ocr: {},
  bbox_scan: { page: 0 },
  form_2307_ocr: {},
  classify_document: { filename: "invoice.pdf" },
  email_extraction: { filename: "receipt.pdf", documentType: "receipt" },
  ingest_triage: { filename: "doc.pdf", mimeType: "application/pdf" },
  match_assist: { blocks: [] },
  txn_prefill: {
    line: { date: "2026-07-25", description: "TEST", amount: -10 },
    accounts: [],
    parties: [],
  },
  reflection: { task: "receipt_ocr", corrections: [] },
  coa_draft: {
    businessDescription: "A software company",
    industry: "software",
    existingAccounts: [],
    maxAccounts: 10,
  },
  category_mapping_suggest: { rows: [], accounts: [] },
};

function hopInvocation(task: AiTaskName): AiHopInvocation<unknown> {
  const entry = getTaskEntry(task);
  return {
    hop: { provider: "gemini", model: "mock" },
    position: 0,
    task,
    prompt: toRedactedPrompt("mock").prompt,
    schema: entry.schema,
    ctx: CTX,
    entry,
    redactionHits: 0,
  };
}

describe("mock AI fixtures", () => {
  it("covers every AiTaskName and every registry entry", () => {
    expect(Object.keys(MOCK_RESPONSES).sort()).toEqual([...ALL_TASKS].sort());
    expect(Object.keys(MOCK_RESPONSES).sort()).toEqual(Object.keys(TASK_REGISTRY).sort());
  });

  it("each fixture parses against that task's live Zod schema", () => {
    for (const task of ALL_TASKS) {
      const parsed = parseModelJson(getTaskEntry(task).schema, MOCK_RESPONSES[task]);
      expect(parsed.ok, `${task}: ${parsed.ok ? "" : parsed.issues.join("; ")}`).toBe(true);
    }
  });
});

describe("mockAiCompletionRuntime", () => {
  it("prepare skips credentials and always returns a synthetic hop", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const preparation = await mockAiCompletionRuntime.prepare({
      task: "receipt_ocr",
      orgId: "org-mock",
    });
    expect(preparation).toEqual({
      kind: "ready",
      hops: [{ provider: "gemini", model: "mock" }],
    });
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("invokeHop returns parseable canned JSON for every task with zero HTTP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const task of ALL_TASKS) {
      const result = await mockAiCompletionRuntime.invokeHop(hopInvocation(task));
      expect(result.model).toBe("mock");
      expect(result.invocationId).toBe(`mock:${task}`);
      const parsed = parseModelJson(getTaskEntry(task).schema, result.text);
      expect(parsed.ok, `${task}: ${parsed.ok ? "" : parsed.issues.join("; ")}`).toBe(true);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("covers OCR/DOCUMENT_TASKS in-process (not via openai_compatible HTTP)", async () => {
    expect(DOCUMENT_TASKS.size).toBeGreaterThan(0);
    for (const task of DOCUMENT_TASKS) {
      const result = await mockAiCompletionRuntime.invokeHop(hopInvocation(task));
      expect(parseModelJson(getTaskEntry(task).schema, result.text).ok).toBe(true);
    }
  });

  it("does not import production provider adapters", () => {
    const source = readFileSync(new URL("../../../src/lib/ai/mock-runtime.ts", import.meta.url), {
      encoding: "utf8",
    });
    expect(source).not.toMatch(/adapters\/(gemini|anthropic|openai)/);
    expect(source).not.toMatch(/from ["'].*facade-runtime["']/);
  });
});

describe("createAiComplete(mockAiCompletionRuntime)", () => {
  const aiComplete = createAiComplete(mockAiCompletionRuntime);

  it("returns schema-valid data for every task, including OCR", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    for (const task of ALL_TASKS) {
      const result = await aiComplete({
        task,
        input: MINIMAL_TASK_INPUTS[task],
        ctx: CTX,
      });
      expect(result.ok, `${task} needsReview: ${result.ok ? "" : result.issues.join("; ")}`).toBe(
        true,
      );
      if (result.ok) {
        expect(result.model).toBe("mock");
        expect(result.invocationId).toBe(`mock:${task}`);
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });
});

describe("mock Jev responses (AI_MODE=mock)", () => {
  const optedIn = createMockAiCompletionRuntime({ isJevOptedIn: async () => true });

  it("exist exactly for the tasks Jev serves, parse, and pin confidence to 0..1", () => {
    expect(Object.keys(JEV_MOCK_RESPONSES).sort()).toEqual([...JEV_TASKS].sort());
    for (const task of JEV_TASKS) {
      const parsed = parseModelJson(getTaskEntry(task).schema, JEV_MOCK_RESPONSES[task]!);
      expect(parsed.ok, task).toBe(true);
      if (!parsed.ok) continue;
      const confidence = (parsed.data as { confidence: number }).confidence;
      expect(confidence).toBeGreaterThanOrEqual(0);
      expect(confidence).toBeLessThanOrEqual(1);
      expect(normalizeConfidence(confidence, { scaleHint: "unit" })).toBe(confidence);
    }
  });

  it("an opted-in org gets the Jev mock hop first on JEV_TASKS, the Gemini mock hop after", async () => {
    for (const task of JEV_TASKS) {
      await expect(optedIn.prepare({ task, orgId: "org-mock" })).resolves.toEqual({
        kind: "ready",
        hops: [
          { provider: "jev", model: "jev-mock" },
          { provider: "gemini", model: "mock" },
        ],
      });
    }
  });

  it("never puts Jev on any other task, OCR included, even when opted in", async () => {
    for (const task of ALL_TASKS.filter((t) => !JEV_TASKS.has(t))) {
      await expect(optedIn.prepare({ task, orgId: "org-mock" })).resolves.toEqual({
        kind: "ready",
        hops: [{ provider: "gemini", model: "mock" }],
      });
    }
    for (const task of DOCUMENT_TASKS) {
      const preparation = await optedIn.prepare({ task, orgId: "org-mock" });
      expect(
        preparation.kind === "ready" && preparation.hops.some((h) => h.provider === "jev"),
      ).toBe(false);
    }
  });

  it("a failing opt-in read falls back to the shared mock hop", async () => {
    const broken = createMockAiCompletionRuntime({
      isJevOptedIn: async () => {
        throw new Error("settings unavailable");
      },
    });
    await expect(broken.prepare({ task: "ingest_triage", orgId: "org-mock" })).resolves.toEqual({
      kind: "ready",
      hops: [{ provider: "gemini", model: "mock" }],
    });
  });

  it("answers an opted-in org from the Jev fixtures, with zero HTTP", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const aiComplete = createAiComplete(optedIn);
    for (const task of JEV_TASKS) {
      const result = await aiComplete({ task, input: MINIMAL_TASK_INPUTS[task], ctx: CTX });
      expect(result).toMatchObject({
        ok: true,
        model: "jev-mock",
        invocationId: `mock:jev:${task}`,
      });
      if (result.ok) {
        expect(result.data).toEqual(JSON.parse(JEV_MOCK_RESPONSES[task]!));
      }
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    fetchSpy.mockRestore();
  });

  it("the default runtime (never opted in) keeps answering JEV_TASKS from the shared fixtures", async () => {
    const aiComplete = createAiComplete(mockAiCompletionRuntime);
    for (const task of JEV_TASKS) {
      const result = await aiComplete({ task, input: MINIMAL_TASK_INPUTS[task], ctx: CTX });
      expect(result).toMatchObject({ ok: true, model: "mock" });
      if (result.ok) expect(result.data).toEqual(JSON.parse(MOCK_RESPONSES[task]));
    }
  });
});
