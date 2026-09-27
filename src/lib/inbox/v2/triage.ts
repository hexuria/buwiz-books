/**
 * Inbox v2 triage: why an item needs a human, what kind of paper it is, and who proposed it.
 *
 * Pure functions, shared by the server list (which derives one reason per row) and the reading
 * pane (which picks the editor from the kind). Nothing here reads the database.
 *
 * The Inbox shows only what needs a human (spec §10), so every listed item gets exactly one
 * reason. Precedence, first match wins:
 *
 *   failed      the item failed, or its source could not be processed
 *   needs_fix   an open blocking finding, or the entry is still missing details
 *   jev_unsure  a real model-unsure signal: a low-confidence category, or a step-7 signal
 *   spot_check  a held-back sample of what Jev would have approved (step 11; never yet)
 *   ready       nothing above: a clean entry (typed by hand, or a confident paper) waiting for
 *               approval. Items still being read land here too, with their own sentence.
 */
import { isVendorBillCandidate } from "../vendor-bill";

/** In filter-chip order. */
export const INBOX_V2_REASONS = [
  "needs_fix",
  "jev_unsure",
  "spot_check",
  "failed",
  "ready",
] as const;
export type InboxV2Reason = (typeof INBOX_V2_REASONS)[number];

export const INBOX_V2_REASON_LABELS: Record<InboxV2Reason, string> = {
  needs_fix: "Needs a fix",
  jev_unsure: "Jev unsure",
  spot_check: "Spot check",
  failed: "Failed",
  ready: "Ready to approve",
};

/** Why the reason was chosen — drives the strip's sentence. */
export type InboxV2ReasonDetail =
  | "processing_failed"
  | "blocking_finding"
  | "needs_information"
  | "low_confidence"
  | "model_unsure"
  | "spot_check"
  | "still_processing"
  | "ready";

export interface InboxV2OpenFinding {
  ruleKey: string;
  /** Effective impact now, after the duplicate engine's current mode is applied. */
  blocking: boolean;
  message?: string | null;
}

/**
 * STEP 7 HOOK. The category and entity checks (spec §4-5) will report when the model is not sure
 * of an answer. Nothing produces these yet; callers pass an empty list.
 */
export interface ModelUnsureSignal {
  subject: "category" | "party" | "document_kind";
  /** Calibrated confidence 0..1, when the model gave one. */
  confidence: number | null;
}

export interface InboxV2ReasonInput {
  state: string;
  openFindings: readonly InboxV2OpenFinding[];
  modelUnsureSignals?: readonly ModelUnsureSignal[];
  /** STEP 11 HOOK: a held-back autonomy sample. Always false until lanes exist. */
  spotCheck?: boolean;
}

export interface InboxV2ReasonResult {
  reason: InboxV2Reason;
  detail: InboxV2ReasonDetail;
  /** The finding that decided the reason, when one did. */
  ruleKey: string | null;
  /** That finding's own message, when it has one. */
  message: string | null;
  /** The step-7 signal that decided the reason, when one did. */
  signal: ModelUnsureSignal | null;
}

export const SOURCE_PROCESSING_FAILED_RULE = "source_processing_failed";
export const LOW_CONFIDENCE_CATEGORY_RULE = "low_confidence_category";

const IN_FLIGHT_STATES = new Set(["received", "processing"]);

function result(
  reason: InboxV2Reason,
  detail: InboxV2ReasonDetail,
  finding?: InboxV2OpenFinding,
  signal?: ModelUnsureSignal,
): InboxV2ReasonResult {
  return {
    reason,
    detail,
    ruleKey: finding?.ruleKey ?? null,
    message: finding?.message?.trim() || null,
    signal: signal ?? null,
  };
}

export function deriveInboxV2Reason(input: InboxV2ReasonInput): InboxV2ReasonResult {
  const findings = input.openFindings;

  const processingFailure = findings.find(
    (finding) => finding.ruleKey === SOURCE_PROCESSING_FAILED_RULE,
  );
  if (input.state === "failed" || processingFailure) {
    return result("failed", "processing_failed", processingFailure);
  }

  // A blocking low-confidence finding blocks approval like any other, but it says the model
  // was unsure, not that the entry is wrong — so it is Jev unsure, below.
  const blocking = findings.find(
    (finding) => finding.blocking && finding.ruleKey !== LOW_CONFIDENCE_CATEGORY_RULE,
  );
  if (blocking) return result("needs_fix", "blocking_finding", blocking);
  if (input.state === "needs_information") return result("needs_fix", "needs_information");

  const lowConfidence = findings.find(
    (finding) => finding.ruleKey === LOW_CONFIDENCE_CATEGORY_RULE,
  );
  if (lowConfidence) return result("jev_unsure", "low_confidence", lowConfidence);
  const signal = input.modelUnsureSignals?.[0];
  if (signal) return result("jev_unsure", "model_unsure", undefined, signal);

  if (input.spotCheck) return result("spot_check", "spot_check");

  return result("ready", IN_FLIGHT_STATES.has(input.state) ? "still_processing" : "ready");
}

const SIGNAL_SUBJECTS: Record<ModelUnsureSignal["subject"], string> = {
  category: "category",
  party: "vendor or customer",
  document_kind: "kind of paper",
};

/** The strip's one sentence for a reason. */
export function describeInboxV2Reason(reason: InboxV2ReasonResult): string {
  switch (reason.detail) {
    case "processing_failed":
      return (
        reason.message ??
        "This paper could not be processed. It is stored safely; retry it or reject it."
      );
    case "blocking_finding":
      return reason.message ?? "A check must pass before this can be approved.";
    case "needs_information":
      return "Add the accounting details before this can be approved.";
    case "low_confidence":
      return "Jev isn't sure about the category. Confirm it or pick another.";
    case "model_unsure":
      return `Jev isn't sure about the ${SIGNAL_SUBJECTS[reason.signal?.subject ?? "category"]}.`;
    case "spot_check":
      return "Spot check: Jev would have approved this. Your answer keeps its approvals honest.";
    case "still_processing":
      return "Still being read. It can be approved once processing finishes.";
    case "ready":
      return "No check blocks it. Review the entry and approve it.";
  }
}

// ── Kind ─────────────────────────────────────────────────────────────────────

export const INBOX_V2_KINDS = [
  "vendor_bill",
  "sales_invoice",
  "expense",
  "money_in",
  "transfer",
  "journal",
] as const;
export type InboxV2Kind = (typeof INBOX_V2_KINDS)[number];

export const INBOX_V2_KIND_LABELS: Record<InboxV2Kind, string> = {
  vendor_bill: "Vendor bill",
  sales_invoice: "Sales invoice",
  expense: "Paid expense",
  money_in: "Money in",
  transfer: "Transfer",
  journal: "Journal entry",
};

/**
 * What the paper is, which decides the editor (spec §10 table). Vendor bills use the same rule
 * approval uses to decide whether a bill row is written.
 */
export function deriveInboxV2Kind(input: {
  candidateType: string;
  originEconomicEventClass: string | null;
  transactionType: string;
}): InboxV2Kind {
  if (isVendorBillCandidate(input.candidateType, input.originEconomicEventClass)) {
    return "vendor_bill";
  }
  if (input.candidateType === "invoice" || input.originEconomicEventClass === "invoice_accrual") {
    return "sales_invoice";
  }
  switch (input.transactionType) {
    case "pay_out":
      return "expense";
    case "pay_in":
      return "money_in";
    case "transfer":
      return "transfer";
    default:
      return "journal";
  }
}

// ── Source badge ─────────────────────────────────────────────────────────────

/**
 * STEP 10 HOOK. A classification-memory hit must stamp its lines'
 * `prediction_evidence.source` with this value; that is what makes the strip say "Remembered".
 */
export const REMEMBERED_EVIDENCE_SOURCE = "memory";

export type InboxV2SourceBadge =
  | { kind: "remembered" }
  | { kind: "jev"; confidence: number }
  | null;

/**
 * Who proposed the entry. A remembered answer wins; otherwise the weakest category confidence on
 * the lines is Jev's confidence in the whole entry. Lines a person typed carry no confidence, so a
 * hand-entered item has no badge.
 */
export function deriveInboxV2SourceBadge(input: {
  remembered: boolean;
  minCategoryConfidence: string | null;
}): InboxV2SourceBadge {
  if (input.remembered) return { kind: "remembered" };
  if (input.minCategoryConfidence == null || input.minCategoryConfidence === "") return null;
  const confidence = Number(input.minCategoryConfidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  return { kind: "jev", confidence };
}

export function formatSourceBadge(badge: Exclude<InboxV2SourceBadge, null>): string {
  return badge.kind === "remembered" ? "Remembered" : `Jev ${Math.round(badge.confidence * 100)}%`;
}
