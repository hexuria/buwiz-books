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
 *   needs_fix   an open blocking finding, or an entry still missing lines or accounts
 *   jev_unsure  a real model-unsure signal: a low-confidence category, or an answer stage 2
 *               could not use (a category or counterparty below the threshold, or none at all)
 *   spot_check  a held-back sample of what Jev would have approved (step 11; never yet)
 *   ready       nothing above: a clean entry (typed by hand, a confident paper, or one a
 *               classification memory answered) waiting for approval
 *
 * Memories (step 10): a remembered answer carries no model doubt, so a memory-answered entry
 * that no check blocks is Ready to approve, said as such. Two memories that disagree raise the
 * blocking `memory_conflict` finding; when it is open it is the fix the strip names, ahead of the
 * `uncategorized` line it leaves behind.
 *
 * A blocking finding that exists only because the model was unsure is Jev unsure, not a fix:
 * stage 2 parks an unsure category on Uncategorized and leaves an unsure counterparty empty, so
 * its doubt always surfaces as an `uncategorized` or missing-party finding. Counting those as
 * fixes would leave Jev unsure unreachable. Anything the doubt does not account for (the payment
 * side stage 2 never picks, a missing dimension, a duplicate) still needs a fix, and the strip
 * names the doubt after it.
 *
 * Papers still being read (received / processing) need nobody yet: the list counts them instead
 * of giving them a reason.
 */
import { BOOK_RULE_KEYS } from "../rules";
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
  | "ready"
  | "remembered";

export interface InboxV2OpenFinding {
  ruleKey: string;
  /** Effective impact now, after the duplicate engine's current mode is applied. */
  blocking: boolean;
  message?: string | null;
  /** The lines a line-level book rule flagged (`evidence.lineIndexes`), in line order. */
  lineIndexes?: readonly number[] | null;
}

/**
 * An answer stage 2 (src/lib/inbox/candidate-classification.ts) could not use: the model was
 * below the organization's low-confidence threshold, or gave no usable answer. The draft took
 * the safe fallback — Uncategorized for a category, no counterparty for a party — so a person
 * must settle what the model could not. Read from the line's prediction evidence and the
 * classification event (src/lib/inbox/v2/model-doubt.ts).
 */
export interface ModelUnsureSignal {
  subject: "category" | "party";
  /** `low_confidence`: answered below the threshold. `failed`: no usable answer at all. */
  cause: "low_confidence" | "failed";
  /** The model's confidence 0..1, when it gave one. */
  confidence: number | null;
  /** For a category: the line's index in line order, as line-level findings count lines. */
  lineIndex: number | null;
}

/** The draft as it stands: how many lines it has, and which have no account yet. */
export interface InboxV2EntryShape {
  lineCount: number;
  linesWithoutAccount: readonly number[];
}

export interface InboxV2ReasonInput {
  state: string;
  openFindings: readonly InboxV2OpenFinding[];
  entry: InboxV2EntryShape;
  modelUnsureSignals?: readonly ModelUnsureSignal[];
  /** STEP 11 HOOK: a held-back autonomy sample. Always false until lanes exist. */
  spotCheck?: boolean;
  /** A classification memory answered the entry (a line's evidence source is "memory"). */
  remembered?: boolean;
}

export interface InboxV2ReasonResult {
  reason: InboxV2Reason;
  detail: InboxV2ReasonDetail;
  /** The finding that decided the reason, when one did. */
  ruleKey: string | null;
  /** That finding's own message, when it has one. */
  message: string | null;
  /** Everything the model was unsure of, whichever reason won; the strip names it. */
  signals: ModelUnsureSignal[];
}

export const SOURCE_PROCESSING_FAILED_RULE = "source_processing_failed";
export const LOW_CONFIDENCE_CATEGORY_RULE = "low_confidence_category";
/** Raised by stage 2 when two remembered answers of one specificity disagree. */
export const MEMORY_CONFLICT_RULE = "memory_conflict";
const UNCATEGORIZED_RULE = "uncategorized";
const MISSING_PARTY_RULES = new Set(["missing_vendor", "missing_customer"]);

/**
 * Which blocking check names the fix when several are open. One evaluation writes all of an
 * item's findings in a single transaction, so they share `first_seen_at`, and ordering by time
 * left the choice to random ids: two identical papers could name different fixes. The order is
 * fixed instead — what makes booking the paper unsafe first (payee bank details that changed, a
 * possible duplicate), then the book rules in the order they are evaluated. Anything else comes
 * after, in the order the list reads it (first seen, then rule key).
 */
const FIX_PRECEDENCE: readonly string[] = [
  "party_payment_details_changed",
  "possible_duplicate",
  ...BOOK_RULE_KEYS,
];

function fixRank(ruleKey: string): number {
  const rank = FIX_PRECEDENCE.indexOf(ruleKey);
  return rank === -1 ? FIX_PRECEDENCE.length : rank;
}

/** The finding that names the fix: lowest FIX_PRECEDENCE rank, earliest in the given order. */
function firstFix(findings: readonly InboxV2OpenFinding[]): InboxV2OpenFinding | undefined {
  let chosen: InboxV2OpenFinding | undefined;
  for (const finding of findings) {
    if (!chosen || fixRank(finding.ruleKey) < fixRank(chosen.ruleKey)) chosen = finding;
  }
  return chosen;
}

function result(
  reason: InboxV2Reason,
  detail: InboxV2ReasonDetail,
  signals: readonly ModelUnsureSignal[],
  finding?: InboxV2OpenFinding,
): InboxV2ReasonResult {
  return {
    reason,
    detail,
    ruleKey: finding?.ruleKey ?? null,
    message: finding?.message?.trim() || null,
    signals: [...signals],
  };
}

/**
 * Whether a blocking finding says nothing beyond the model's own doubt, so settling that doubt
 * is the whole fix. A low-confidence finding always is. `uncategorized` is only when every line
 * it flags is a category the model was unsure of; a missing vendor or customer only when the
 * counterparty match was.
 */
function explainedByDoubt(
  finding: InboxV2OpenFinding,
  unsureLines: ReadonlySet<number>,
  unsureParty: boolean,
): boolean {
  if (finding.ruleKey === LOW_CONFIDENCE_CATEGORY_RULE) return true;
  if (finding.ruleKey === UNCATEGORIZED_RULE) {
    const flagged = finding.lineIndexes ?? [];
    return flagged.length > 0 && flagged.every((index) => unsureLines.has(index));
  }
  return MISSING_PARTY_RULES.has(finding.ruleKey) && unsureParty;
}

export function deriveInboxV2Reason(input: InboxV2ReasonInput): InboxV2ReasonResult {
  const findings = input.openFindings;
  const signals = input.modelUnsureSignals ?? [];

  const processingFailure = findings.find(
    (finding) => finding.ruleKey === SOURCE_PROCESSING_FAILED_RULE,
  );
  if (input.state === "failed" || processingFailure) {
    return result("failed", "processing_failed", [], processingFailure);
  }

  const unsureLines = new Set(
    signals.flatMap((signal) =>
      signal.subject === "category" && signal.lineIndex !== null ? [signal.lineIndex] : [],
    ),
  );
  const unsureParty = signals.some((signal) => signal.subject === "party");

  // Disagreeing memories are the fix to name: the Uncategorized line they leave is their symptom.
  const blocking =
    findings.find((finding) => finding.blocking && finding.ruleKey === MEMORY_CONFLICT_RULE) ??
    firstFix(
      findings.filter(
        (finding) => finding.blocking && !explainedByDoubt(finding, unsureLines, unsureParty),
      ),
    );
  if (blocking) return result("needs_fix", "blocking_finding", signals, blocking);
  // Judged on the entry, not the lifecycle state: stage 2 fills lines without moving an item
  // out of needs_information. A line with no account is missing a detail unless it is a
  // category the model was unsure of (no Uncategorized account was mapped to park it on).
  if (
    input.entry.lineCount === 0 ||
    input.entry.linesWithoutAccount.some((index) => !unsureLines.has(index))
  ) {
    return result("needs_fix", "needs_information", signals);
  }

  const lowConfidence = findings.find(
    (finding) => finding.ruleKey === LOW_CONFIDENCE_CATEGORY_RULE,
  );
  if (lowConfidence) return result("jev_unsure", "low_confidence", signals, lowConfidence);
  if (signals.length > 0) return result("jev_unsure", "model_unsure", signals);

  if (input.spotCheck) return result("spot_check", "spot_check", signals);

  return result("ready", input.remembered ? "remembered" : "ready", signals);
}

/**
 * One sentence per subject the model could not settle, first doubt per subject:
 * "Jev isn't sure about the category (41% sure)." / "Jev couldn't match the vendor or customer."
 */
export function describeModelDoubts(signals: readonly ModelUnsureSignal[]): string {
  const sentences = new Map<ModelUnsureSignal["subject"], string>();
  for (const signal of signals) {
    if (sentences.has(signal.subject)) continue;
    if (signal.cause === "failed") {
      sentences.set(
        signal.subject,
        signal.subject === "category"
          ? "Jev couldn't choose a category."
          : "Jev couldn't match the vendor or customer.",
      );
      continue;
    }
    const subject = signal.subject === "category" ? "the category" : "the vendor or customer";
    const sure =
      signal.confidence === null ? "" : ` (${Math.round(signal.confidence * 100)}% sure)`;
    sentences.set(signal.subject, `Jev isn't sure about ${subject}${sure}.`);
  }
  return [...sentences.values()].join(" ");
}

function withDoubts(sentence: string, signals: readonly ModelUnsureSignal[]): string {
  const doubts = describeModelDoubts(signals);
  return doubts ? `${sentence} ${doubts}` : sentence;
}

/** The strip's one sentence for a reason, followed by whatever the model was unsure of. */
export function describeInboxV2Reason(reason: InboxV2ReasonResult): string {
  switch (reason.detail) {
    case "processing_failed":
      return (
        reason.message ??
        "This paper could not be processed. It is stored safely; retry it or reject it."
      );
    case "blocking_finding":
      return withDoubts(
        reason.message ?? "A check must pass before this can be approved.",
        reason.signals,
      );
    case "needs_information":
      return withDoubts("Add the accounting details before this can be approved.", reason.signals);
    case "low_confidence":
      return withDoubts(
        "Jev isn't sure about the category. Confirm it or pick another.",
        reason.signals.filter((signal) => signal.subject !== "category"),
      );
    case "model_unsure":
      return describeModelDoubts(reason.signals);
    case "spot_check":
      return "Spot check: Jev would have approved this. Your answer keeps its approvals honest.";
    case "ready":
      return "No check blocks it. Review the entry and approve it.";
    case "remembered":
      return "Answered from a correction you asked Jev to remember. No check blocks it. Review the entry and approve it.";
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
