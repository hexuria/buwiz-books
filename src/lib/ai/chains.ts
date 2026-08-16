// ============================================================================
// Per-task model chains.
//
// A chain is an ORDERED list of hops. The router walks it, advancing on
// provider exhaustion, bad credentials, or schema rejection; the first hop
// that produces schema-valid output wins.
//
// Two decisions are baked in here:
//
//  1. GEMINI FIRST everywhere — day-one behavior is byte-identical to today,
//     and Gemini is ~4–10× cheaper per page for document work.
//
//  2. OCR TASKS ARE GEMINI-ONLY (adopted decision). Redaction cannot touch
//     inline document bytes, so widening OCR egress would send whole
//     financial documents to a new vendor. Text tasks — which ARE redactable
//     — may escalate to Anthropic/OpenAI. `ocrOnlyGemini` is asserted by a
//     test, not just documented.
// ============================================================================

import type { AiTaskName } from "./types";
import type { AiProvider } from "./errors";

export interface ChainEntry {
  provider: AiProvider;
  model: string;
  params?: { temperature?: number; maxOutputTokens?: number; thinkingBudget?: number };
}

/** Tasks that send document bytes to the model. */
export const DOCUMENT_TASKS: ReadonlySet<AiTaskName> = new Set<AiTaskName>([
  "receipt_ocr",
  "bill_ocr",
  "statement_ocr",
  "bbox_scan",
  "email_extraction",
]);

const GEMINI_OCR = "gemini-3.1-flash-image-preview";
const GEMINI_OCR_PRO = "gemini-3-pro-image-preview";
const GEMINI_TEXT = "gemini-3-flash-preview";
const CLAUDE_TEXT = "claude-haiku-4-5";
const CLAUDE_REASONING = "claude-sonnet-5";

/**
 * Default chain per task. Orgs may override via organization_ai_settings,
 * but a document task can never be pointed off Gemini (see enforceOcrPolicy).
 */
export const DEFAULT_CHAINS: Record<AiTaskName, ChainEntry[]> = {
  // ── Document tasks: Gemini only, escalating within Gemini ──────────────
  receipt_ocr: [
    { provider: "gemini", model: GEMINI_OCR },
    { provider: "gemini", model: GEMINI_OCR_PRO },
  ],
  bill_ocr: [
    { provider: "gemini", model: GEMINI_OCR },
    { provider: "gemini", model: GEMINI_OCR_PRO },
  ],
  statement_ocr: [
    { provider: "gemini", model: GEMINI_OCR },
    { provider: "gemini", model: GEMINI_OCR_PRO },
  ],
  bbox_scan: [{ provider: "gemini", model: GEMINI_OCR }],
  email_extraction: [{ provider: "gemini", model: GEMINI_OCR }],

  // ── Text tasks: Gemini first, may escalate to redactable providers ─────
  date_parse: [{ provider: "gemini", model: GEMINI_TEXT }],
  classify_document: [{ provider: "gemini", model: GEMINI_TEXT }],
  ingest_triage: [{ provider: "gemini", model: GEMINI_TEXT }],
  transaction_parse: [
    { provider: "gemini", model: GEMINI_TEXT },
    { provider: "anthropic", model: CLAUDE_TEXT },
  ],
  txn_prefill: [
    { provider: "gemini", model: GEMINI_TEXT },
    { provider: "anthropic", model: CLAUDE_TEXT },
  ],
  // Offline, low-stakes: cheapest text model only.
  reflection: [{ provider: "gemini", model: GEMINI_TEXT }],
  // Matching is the highest-stakes reasoning task — escalate to the stronger
  // model rather than accepting a weak arbitration.
  match_assist: [
    { provider: "gemini", model: GEMINI_TEXT },
    { provider: "anthropic", model: CLAUDE_REASONING },
  ],
  // Designing a chart is a one-shot structural judgement a human then reviews
  // account by account — worth the stronger model on escalation.
  coa_draft: [
    { provider: "gemini", model: GEMINI_TEXT },
    { provider: "anthropic", model: CLAUDE_REASONING },
  ],
  // Picking a posting default from a supplied list, with the legal target type
  // handed over per row: a small model with a deterministic gate behind it.
  category_mapping_suggest: [
    { provider: "gemini", model: GEMINI_TEXT },
    { provider: "anthropic", model: CLAUDE_TEXT },
  ],
};

export class OcrEgressPolicyError extends Error {
  constructor(task: AiTaskName, provider: AiProvider) {
    super(
      `Task "${task}" sends document bytes and may only run on Gemini (attempted: ${provider}). ` +
        `Pre-egress redaction cannot mask document images; widening this requires a document-DLP pass.`,
    );
    this.name = "OcrEgressPolicyError";
  }
}

/**
 * Drop (and report) any non-Gemini hop from a document task's chain.
 * Applied to org overrides so a settings change can never widen OCR egress.
 */
export function enforceOcrPolicy(task: AiTaskName, chain: ChainEntry[]): ChainEntry[] {
  if (!DOCUMENT_TASKS.has(task)) return chain;
  return chain.filter((hop) => hop.provider === "gemini");
}

/** Assert a chain respects the policy — used by the router and by tests. */
export function assertOcrPolicy(task: AiTaskName, chain: ChainEntry[]): void {
  if (!DOCUMENT_TASKS.has(task)) return;
  const offender = chain.find((hop) => hop.provider !== "gemini");
  if (offender) throw new OcrEgressPolicyError(task, offender.provider);
}
