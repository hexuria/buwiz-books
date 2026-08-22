// ============================================================================
// AI task taxonomy.
//
// AiTaskName is the fine-grained task identity used by the prompt registry,
// telemetry (ai_invocations.task), and — from later phases — routing chains
// and eval datasets. Each task maps onto one of the coarse model-selection
// categories in src/lib/ai-models.ts (per-org model choice stays per-category).
// ============================================================================

import type { AITaskCategory } from "../ai-models";

export type AiTaskName =
  | "date_parse"
  | "transaction_parse"
  | "receipt_ocr"
  | "bill_ocr"
  | "statement_ocr"
  | "bbox_scan"
  | "form_2307_ocr"
  | "classify_document"
  | "email_extraction"
  | "ingest_triage"
  | "match_assist"
  | "txn_prefill"
  | "reflection"
  | "coa_draft"
  | "category_mapping_suggest";

/** Model-selection category for each task (drives resolveModelForTask). */
export const AI_TASK_CATEGORY: Record<AiTaskName, AITaskCategory> = {
  date_parse: "textAnalysis",
  transaction_parse: "textAnalysis",
  classify_document: "textAnalysis",
  ingest_triage: "textAnalysis",
  match_assist: "textAnalysis",
  txn_prefill: "textAnalysis",
  reflection: "textAnalysis",
  coa_draft: "textAnalysis",
  category_mapping_suggest: "textAnalysis",
  receipt_ocr: "ocr",
  bill_ocr: "ocr",
  statement_ocr: "ocr",
  bbox_scan: "ocr",
  form_2307_ocr: "ocr",
  email_extraction: "ocr",
};

/** Caller identity threaded through every façade call for telemetry. */
export interface AiCallContext {
  orgId: string;
  userId?: string;
  requestId?: string;
  agentRunStepId?: string;
}
