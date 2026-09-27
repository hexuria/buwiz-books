// ============================================================================
// May Jev approve this paper? (Inbox v2 spec §8, §2, §5)
//
// Pure. The loader (./proposal.ts) reads the facts inside the organization's
// context; this decides. Jev approves only when EVERY condition holds:
//
//   lane    the paper's lane is at `auto`, with its party, cap and threshold
//   org     the organization's Jev-approval switch is on; the AI kill switch
//           is off; maker-checker (requireDifferentApprover) is off, or an
//           admin explicitly opted Jev in
//   wall    no proposal kind the lane applies is structurally manual
//           (src/lib/ai/autonomy.ts laneWalledKinds)
//   paper   the item is open and its candidate current; the confidence is at
//           or above the lane's calibrated threshold; no open blocking
//           finding, and no open warning either (a warning is addressed to a
//           person, and there would be none); no duplicate case; a known party
//           and no party being created; no payee bank-detail change, ever,
//           even one a person resolved (spec §5: always a human); an open
//           period; every line on an account and balanced to the cent; the
//           functional total at or under the lane's cap, compared exactly
//   sample  not held back as a spot check
//
// Anything false holds the paper in Needs you, and the holds say why.
//
// WOULD APPROVE. `wouldApprove` is the paper conditions alone, judged with
// the lane's own threshold and cap, or — for a lane that has not been promoted
// yet — PROVISIONAL_WOULD_APPROVE_THRESHOLD and no cap. It is what "watch"
// and "suggest" lanes log, and what the scorecard's per-lane agreement
// ("Jev approvals a human would undo") is measured on.
// ============================================================================

import type { AutonomyLaneLevel } from "@/db/schema/ai";
import { compareMoney, sumMoney } from "../money";

/**
 * The payee bank-detail rule (../payment-details-check.ts), named here so this
 * module stays free of database imports; a unit test pins the two together.
 */
export const PAYMENT_DETAILS_RULE_KEY = "party_payment_details_changed";

/** The threshold "would approve" uses before a lane has one of its own. */
export const PROVISIONAL_WOULD_APPROVE_THRESHOLD = 0.9;

/** Item states an approval can start from (stage 2 leaves papers in needs_information). */
export const JEV_APPROVABLE_STATES: readonly string[] = ["needs_information", "ready_for_review"];

export type JevHoldScope = "lane" | "org" | "wall" | "paper" | "sample";

export type JevHoldReason =
  | "lane_not_auto"
  | "lane_limits_missing"
  | "autoapprove_off"
  | "ai_kill_switch"
  | "maker_checker"
  | "walled_kind"
  | "not_approvable"
  | "no_confidence"
  | "below_threshold"
  | "blocking_finding"
  | "open_warning"
  | "duplicate_case"
  | "unknown_party"
  | "new_party"
  | "payment_details_changed"
  | "period_locked"
  | "incomplete_entry"
  | "unbalanced"
  | "no_amount"
  | "over_cap"
  | "spot_check";

export interface JevHold {
  reason: JevHoldReason;
  scope: JevHoldScope;
  detail?: string;
}

export interface JevLaneView {
  level: AutonomyLaneLevel;
  amountCap: string | null;
  confidenceThreshold: string | null;
  partyId: string | null;
}

export interface JevApprovalInput {
  /** The paper's lane; null when it has none (no lane is ever at auto then). */
  lane: JevLaneView | null;
  org: {
    autoApproveEnabled: boolean;
    aiKillSwitch: boolean;
    requireDifferentApprover: boolean;
    makerCheckerOptIn: boolean;
  };
  /** laneWalledKinds(lane key): kinds the lane applies that are still manual. */
  walledKinds: readonly string[];
  paper: {
    itemState: string;
    candidateStatus: string;
    /** The proposal's confidence, 0..1: its weakest answer. */
    confidence: number | null;
    partyId: string | null;
    /** A create_party proposal is still pending for this paper. */
    newPartyPending: boolean;
    openFindings: ReadonlyArray<{ ruleKey: string; impact: string }>;
    /** Any payee bank-detail finding on this paper, open or resolved. */
    paymentDetailsFlagged: boolean;
    duplicateCaseOpen: boolean;
    periodLocked: boolean;
    /** Functional-currency total (the debits). */
    functionalTotal: string | null;
    /** Functional amounts. */
    lines: ReadonlyArray<{ accountId: string | null; debit: string | null; credit: string | null }>;
  };
  /** Deterministic spot-check draw for this paper (./spot-check.ts). */
  sampled: boolean;
}

export interface JevApprovalDecision {
  /** Every condition holds: Jev approves. */
  approve: boolean;
  /** The paper conditions hold (see the header). */
  wouldApprove: boolean;
  /** Everything else holds and the paper was sampled: it stays as a spot check. */
  heldForSpotCheck: boolean;
  holds: JevHold[];
  /** The threshold and cap the paper conditions were judged with. */
  threshold: number;
  amountCap: string | null;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

function thresholdOf(lane: JevLaneView | null): number {
  const stored = lane?.confidenceThreshold == null ? NaN : Number(lane.confidenceThreshold);
  return Number.isFinite(stored) && stored > 0 && stored <= 1
    ? stored
    : PROVISIONAL_WOULD_APPROVE_THRESHOLD;
}

function paperHolds(
  paper: JevApprovalInput["paper"],
  threshold: number,
  amountCap: string | null,
): JevHold[] {
  const holds: JevHold[] = [];
  const hold = (reason: JevHoldReason, detail?: string) =>
    holds.push(detail ? { reason, scope: "paper", detail } : { reason, scope: "paper" });

  if (!JEV_APPROVABLE_STATES.includes(paper.itemState) || paper.candidateStatus !== "current") {
    hold("not_approvable", `item ${paper.itemState}, candidate ${paper.candidateStatus}`);
  }
  if (paper.confidence === null || !Number.isFinite(paper.confidence)) {
    hold("no_confidence");
  } else if (paper.confidence < threshold) {
    hold("below_threshold", `${percent(paper.confidence)} < ${percent(threshold)}`);
  }

  const blocking = new Set<string>();
  const warnings = new Set<string>();
  let duplicateFinding = false;
  for (const finding of paper.openFindings) {
    if (finding.ruleKey === PAYMENT_DETAILS_RULE_KEY) continue;
    if (finding.ruleKey === "possible_duplicate") {
      duplicateFinding = true;
      continue;
    }
    (finding.impact === "blocking" ? blocking : warnings).add(finding.ruleKey);
  }
  if (blocking.size > 0) hold("blocking_finding", [...blocking].sort().join(", "));
  if (warnings.size > 0) hold("open_warning", [...warnings].sort().join(", "));
  if (paper.duplicateCaseOpen || duplicateFinding) hold("duplicate_case");

  if (paper.partyId === null) hold("unknown_party");
  if (paper.newPartyPending) hold("new_party");
  if (paper.paymentDetailsFlagged) hold("payment_details_changed");
  if (paper.periodLocked) hold("period_locked");

  if (paper.lines.length < 2 || paper.lines.some((line) => !line.accountId)) {
    hold("incomplete_entry");
  } else {
    const debits = sumMoney(paper.lines.map((line) => line.debit));
    const credits = sumMoney(paper.lines.map((line) => line.credit));
    if (compareMoney(debits, credits) !== 0) hold("unbalanced", `${debits} ≠ ${credits}`);
  }

  if (paper.functionalTotal === null || paper.functionalTotal.trim() === "") {
    hold("no_amount");
  } else if (amountCap !== null && compareMoney(paper.functionalTotal, amountCap) > 0) {
    hold("over_cap", `${paper.functionalTotal} > ${amountCap}`);
  }
  return holds;
}

/** Decide one paper. Pure; the holds come out in a stable order. */
export function evaluateJevApproval(input: JevApprovalInput): JevApprovalDecision {
  const { lane, org } = input;
  const threshold = thresholdOf(lane);
  const amountCap = lane?.amountCap ?? null;
  const holds: JevHold[] = [];

  if (!lane || lane.level !== "auto") {
    holds.push({ reason: "lane_not_auto", scope: "lane", detail: lane?.level ?? "none" });
  } else if (!lane.partyId || lane.amountCap === null || lane.confidenceThreshold === null) {
    holds.push({ reason: "lane_limits_missing", scope: "lane" });
  }

  if (!org.autoApproveEnabled) holds.push({ reason: "autoapprove_off", scope: "org" });
  if (org.aiKillSwitch) holds.push({ reason: "ai_kill_switch", scope: "org" });
  if (org.requireDifferentApprover && !org.makerCheckerOptIn) {
    holds.push({ reason: "maker_checker", scope: "org" });
  }

  if (input.walledKinds.length > 0) {
    holds.push({ reason: "walled_kind", scope: "wall", detail: [...input.walledKinds].join(", ") });
  }

  const paper = paperHolds(input.paper, threshold, amountCap);
  holds.push(...paper);

  if (holds.length === 0 && input.sampled) holds.push({ reason: "spot_check", scope: "sample" });

  return {
    approve: holds.length === 0,
    wouldApprove: paper.length === 0,
    heldForSpotCheck: holds.length === 1 && holds[0].reason === "spot_check",
    holds,
    threshold,
    amountCap,
  };
}

const HOLD_TEXT: Record<JevHoldReason, string> = {
  lane_not_auto: "Jev's lane for this paper is not at auto.",
  lane_limits_missing: "The lane has no amount cap or confidence threshold.",
  autoapprove_off: "Jev approval is off for this organization.",
  ai_kill_switch: "The AI kill switch is on.",
  maker_checker: "A different approver is required, and Jev has not been opted in.",
  walled_kind: "Jev may not apply categories on its own yet.",
  not_approvable: "The item is not open for approval.",
  no_confidence: "Jev gave no confidence for this answer.",
  below_threshold: "Jev's confidence is below the lane's threshold.",
  blocking_finding: "A blocking check is open.",
  open_warning: "A warning is open, and a person should read it.",
  duplicate_case: "It may be a duplicate.",
  unknown_party: "No vendor or customer is linked.",
  new_party: "A new vendor or customer would be created.",
  payment_details_changed: "The paper asks for payment to different bank details.",
  period_locked: "Its period is closed.",
  incomplete_entry: "A line has no account.",
  unbalanced: "The entry does not balance.",
  no_amount: "Its total is unknown.",
  over_cap: "It is over the lane's amount cap.",
  spot_check: "Jev would approve this — spot check.",
};

/** One sentence per hold, in order. */
export function describeJevHolds(holds: readonly JevHold[]): string[] {
  return holds.map((hold) =>
    hold.detail ? `${HOLD_TEXT[hold.reason]} (${hold.detail})` : HOLD_TEXT[hold.reason],
  );
}
