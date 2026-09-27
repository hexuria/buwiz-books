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
//
// Jev (TypeSafe AI) is NOT in DEFAULT_CHAINS. It is an opt-in data processor
// that applyJevPolicy places first for the two classification tasks only, so
// an org that has not opted in resolves exactly these chains.
// ============================================================================

import type { AiTaskName } from "./types";
import type { AiProvider } from "./errors";

export interface ChainEntry {
  provider: AiProvider;
  model: string;
  params?: { temperature?: number; maxOutputTokens?: number; thinkingBudget?: number };
}

/**
 * Tasks that send document bytes to the model. OCR-category tasks belong
 * here — `enforceOcrPolicy` uses the set as the Gemini-only clamp, so a
 * missing entry (historically `form_2307_ocr`) is an egress hole.
 */
export const DOCUMENT_TASKS: ReadonlySet<AiTaskName> = new Set<AiTaskName>([
  "receipt_ocr",
  "bill_ocr",
  "statement_ocr",
  "form_2307_ocr",
  "bbox_scan",
  "email_extraction",
]);

const GEMINI_OCR = "gemini-3.1-flash-image-preview";
const GEMINI_OCR_PRO = "gemini-3-pro-image-preview";
const GEMINI_TEXT = "gemini-3-flash-preview";
/** Already listed in `AI_MODEL_OPTIONS.textAnalysis` — cheapest Gemini text hop. */
const GEMINI_TEXT_LITE = "gemini-3.1-flash-lite-preview";
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
  // Escalates to the Pro model on failure like the other document tasks. A
  // 2307 is often a faint dot-matrix print or a fold-creased photocopy, and
  // the figures on it become a tax credit — worth the second attempt.
  form_2307_ocr: [
    { provider: "gemini", model: GEMINI_OCR },
    { provider: "gemini", model: GEMINI_OCR_PRO },
  ],
  bbox_scan: [{ provider: "gemini", model: GEMINI_OCR }],
  email_extraction: [{ provider: "gemini", model: GEMINI_OCR }],

  // ── Text tasks: Gemini first, may escalate to redactable providers ─────
  date_parse: [{ provider: "gemini", model: GEMINI_TEXT }],
  // Cheap classification: Flash Lite first, Gemini Flash on schema/provider
  // failure. Stays on Gemini — no new egress, gateway still deferred.
  classify_document: [
    { provider: "gemini", model: GEMINI_TEXT_LITE },
    { provider: "gemini", model: GEMINI_TEXT },
  ],
  ingest_triage: [
    { provider: "gemini", model: GEMINI_TEXT_LITE },
    { provider: "gemini", model: GEMINI_TEXT },
  ],
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

// ── Jev (TypeSafe AI) ────────────────────────────────────────────────────────
//
// Jev is a cheap "system one" classifier and a NEW data processor. An org
// opts in by putting "jev" on organization_ai_settings.provider_allowlist
// (absent ⇒ Gemini only, so the default is off). Jev reads redacted text and
// never document bytes: no DOCUMENT_TASK is in JEV_TASKS, and the OCR policy
// runs after Jev placement in both the router and the settings view.

/** The only tasks Jev may serve: redacted-text document classification. */
export const JEV_TASKS: ReadonlySet<AiTaskName> = new Set<AiTaskName>([
  "ingest_triage",
  "classify_document",
]);

/** ASSUMPTION A7 in adapters/jev.ts: model id unverified with TypeSafe AI. */
export const JEV_MODEL = "jev-1";

/**
 * Drop every Jev hop from a task Jev does not serve. Jev is never a fallback
 * for other text tasks, whatever an org chain override says. Returns the
 * input array untouched when there is nothing to drop.
 */
export function enforceJevTaskScope(task: AiTaskName, chain: ChainEntry[]): ChainEntry[] {
  if (JEV_TASKS.has(task) || !chain.some((hop) => hop.provider === "jev")) return chain;
  return chain.filter((hop) => hop.provider !== "jev");
}

/**
 * Place Jev in a resolved chain.
 *
 *  • Outside JEV_TASKS every jev hop is dropped (enforceJevTaskScope).
 *  • Opted in, on a JEV_TASK: Jev becomes the FIRST hop and the configured
 *    chain (Gemini by default) is the fallback, unless the chain already
 *    names a jev hop, in which case an explicit override keeps its placement.
 *  • Not opted in: the chain is returned as is. The allowlist filter then
 *    drops any jev hop an override named, so no Jev egress happens without
 *    the opt-in, and a chain without Jev hops is returned unchanged.
 *
 * Hop objects pass through by reference so callers can report what dropped.
 */
export function applyJevPolicy(
  task: AiTaskName,
  chain: ChainEntry[],
  jevOptedIn: boolean,
): ChainEntry[] {
  const scoped = enforceJevTaskScope(task, chain);
  if (!jevOptedIn || !JEV_TASKS.has(task)) return scoped;
  if (scoped.some((hop) => hop.provider === "jev")) return scoped;
  return [{ provider: "jev", model: JEV_MODEL }, ...scoped];
}
