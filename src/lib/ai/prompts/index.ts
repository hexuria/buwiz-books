// ============================================================================
// Task registry — one entry per AI task: prompt module + output schema +
// generation defaults. The façade (facade.ts) resolves everything through
// this table; adding a task = adding an entry here.
//
// Gemini responseSchemas and schema hashes are precomputed at module load, so
// a Zod construct Gemini can't express fails typecheck/CI — never a request.
// ============================================================================

import { createHash } from "node:crypto";
import { z } from "zod";
import type { AiTaskName } from "../types";
import { zodToGeminiSchema, type GeminiSchema } from "../zod-to-gemini-schema";
import { transactionParseOutputSchema } from "../schemas/transaction-parse";
import { dateParseOutputSchema } from "../schemas/date-parse";
import { classifyDocumentOutputSchema } from "../schemas/classify-document";
import { receiptOcrOutputSchema } from "../schemas/receipt-ocr";
import { statementOcrOutputSchema } from "../schemas/statement-ocr";
import { billOcrOutputSchema, boundingBoxesOutputSchema } from "../schemas/bill-ocr";
import { emailExtractionOutputSchema } from "../schemas/email-extraction";
import { form2307OcrOutputSchema } from "../schemas/form-2307-ocr";
import { ingestTriageOutputSchema } from "../schemas/ingest-triage";
import { matchAssistOutputSchema } from "../schemas/match-assist";
import { reflectionOutputSchema } from "../schemas/reflection";
import { coaDraftOutputSchema } from "../schemas/coa-draft";
import { categoryMappingSuggestOutputSchema } from "../schemas/category-mapping-suggest";
import { transactionParsePrompt } from "./transaction-parse";
import { dateParsePrompt } from "./date-parse";
import { classifyDocumentPrompt } from "./classify-document";
import { receiptOcrPrompt } from "./receipt-ocr";
import { form2307OcrPrompt } from "./form-2307-ocr";
import { statementOcrPrompt } from "./statement-ocr";
import { billOcrPrompt, bboxScanPrompt } from "./bill-ocr";
import { emailExtractionPrompt } from "./email-extraction";
import { ingestTriagePrompt } from "./ingest-triage";
import { matchAssistPrompt } from "./match-assist";
import { txnPrefillPrompt } from "./txn-prefill";
import { reflectionPrompt } from "./reflection";
import { coaDraftPrompt } from "./coa-draft";
import { categoryMappingSuggestPrompt } from "./category-mapping-suggest";

export interface PromptModule<TInput = never> {
  id: string;
  /** Bump on ANY prompt-text change — versions attribute behavior shifts. */
  version: string;
  build(input: TInput): string;
}

export interface TaskRegistryEntry {
  prompt: PromptModule<never>;
  schema: z.ZodType;
  generation?: {
    temperature?: number;
    maxOutputTokens?: number;
    /**
     * Gemini-only cap on reasoning tokens.
     *
     * `maxOutputTokens` is a COMBINED budget: on gemini-3, thinking is billed
     * against it and measured at 1.2k-31k tokens for the same request. When
     * thinking spikes, the JSON is truncated mid-string, the parse fails, and
     * the facade escalates to the next (expensive) hop for nothing. Raising
     * maxOutputTokens does not help — thinking simply expands to fill it.
     * Ignored by the Anthropic/OpenAI adapters.
     */
    thinkingBudget?: number;
  };
}

interface ResolvedTaskEntry extends TaskRegistryEntry {
  geminiSchema: GeminiSchema;
  schemaHash: string;
}

function resolveEntry(entry: TaskRegistryEntry): ResolvedTaskEntry {
  const geminiSchema = zodToGeminiSchema(entry.schema);
  const schemaHash = createHash("sha256")
    .update(JSON.stringify(z.toJSONSchema(entry.schema, { target: "draft-2020-12", io: "input" })))
    .digest("hex")
    .slice(0, 16);
  return { ...entry, geminiSchema, schemaHash };
}

/* eslint-disable @typescript-eslint/no-explicit-any */
const RAW_REGISTRY: Partial<Record<AiTaskName, TaskRegistryEntry>> = {
  transaction_parse: {
    prompt: transactionParsePrompt as PromptModule<any>,
    schema: transactionParseOutputSchema,
  },
  date_parse: {
    prompt: dateParsePrompt as PromptModule<any>,
    schema: dateParseOutputSchema,
  },
  classify_document: {
    prompt: classifyDocumentPrompt as PromptModule<any>,
    schema: classifyDocumentOutputSchema,
    generation: { temperature: 0.1 },
  },
  receipt_ocr: {
    prompt: receiptOcrPrompt as PromptModule<any>,
    schema: receiptOcrOutputSchema,
  },
  statement_ocr: {
    prompt: statementOcrPrompt as PromptModule<any>,
    schema: statementOcrOutputSchema,
  },
  form_2307_ocr: {
    prompt: form2307OcrPrompt as PromptModule<any>,
    schema: form2307OcrOutputSchema,
  },
  bill_ocr: {
    prompt: billOcrPrompt as PromptModule<any>,
    schema: billOcrOutputSchema,
  },
  bbox_scan: {
    prompt: bboxScanPrompt as PromptModule<any>,
    schema: boundingBoxesOutputSchema,
  },
  email_extraction: {
    prompt: emailExtractionPrompt as PromptModule<any>,
    schema: emailExtractionOutputSchema,
    generation: { temperature: 0 },
  },
  ingest_triage: {
    prompt: ingestTriagePrompt as PromptModule<any>,
    schema: ingestTriageOutputSchema,
    generation: { temperature: 0.1 },
  },
  match_assist: {
    prompt: matchAssistPrompt as PromptModule<any>,
    schema: matchAssistOutputSchema,
    generation: { temperature: 0 },
  },
  reflection: {
    prompt: reflectionPrompt as PromptModule<any>,
    schema: reflectionOutputSchema,
    generation: { temperature: 0.2 },
  },
  txn_prefill: {
    prompt: txnPrefillPrompt as PromptModule<any>,
    // Reuses the transaction-parse output shape — the human-submitted form
    // is the write gate.
    schema: transactionParseOutputSchema,
  },
  coa_draft: {
    prompt: coaDraftPrompt as PromptModule<any>,
    schema: coaDraftOutputSchema,
    // Low but non-zero: a chart needs some judgement about what this business
    // actually does. The token ceiling covers ~60 accounts of JSON.
    generation: { temperature: 0.2, maxOutputTokens: 8192, thinkingBudget: 2048 },
  },
  category_mapping_suggest: {
    prompt: categoryMappingSuggestPrompt as PromptModule<any>,
    schema: categoryMappingSuggestOutputSchema,
    generation: { temperature: 0.2, maxOutputTokens: 8192, thinkingBudget: 2048 },
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

export const TASK_REGISTRY: Partial<Record<AiTaskName, ResolvedTaskEntry>> = Object.fromEntries(
  Object.entries(RAW_REGISTRY).map(([task, entry]) => [task, resolveEntry(entry)]),
);

export function getTaskEntry(task: AiTaskName): ResolvedTaskEntry {
  const entry = TASK_REGISTRY[task];
  if (!entry) {
    throw new Error(`No task registry entry for AI task "${task}"`);
  }
  return entry;
}
