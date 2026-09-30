import { describe, expect, it } from "vitest";
import {
  describeJevHolds,
  evaluateJevApproval,
  PAYMENT_DETAILS_RULE_KEY,
  PROVISIONAL_WOULD_APPROVE_THRESHOLD,
  type JevApprovalInput,
  type JevHoldReason,
} from "@/lib/inbox/jev-approval/predicate";

const EXPENSE = "11111111-1111-4111-8111-111111111111";
const BANK = "44444444-4444-4444-8444-444444444444";
const VENDOR = "55555555-5555-4555-8555-555555555555";

/** Every condition true: Jev approves. Each test flips exactly one thing. */
function passing(): JevApprovalInput {
  return {
    lane: {
      level: "auto",
      amountCap: "500.00000000",
      confidenceThreshold: "0.9500",
      partyId: VENDOR,
    },
    org: {
      autoApproveEnabled: true,
      aiKillSwitch: false,
      requireDifferentApprover: false,
      makerCheckerOptIn: false,
    },
    walledKinds: [],
    paper: {
      itemState: "needs_information",
      candidateStatus: "current",
      confidence: 0.97,
      partyId: VENDOR,
      newPartyPending: false,
      openFindings: [],
      paymentDetailsFlagged: false,
      sender: null,
      duplicateCaseOpen: false,
      periodLocked: false,
      functionalTotal: "84.25",
      lines: [
        { accountId: EXPENSE, debit: "84.25", credit: null },
        { accountId: BANK, debit: null, credit: "84.25" },
      ],
    },
    sampled: false,
  };
}

function reasonsOf(input: JevApprovalInput): JevHoldReason[] {
  return evaluateJevApproval(input).holds.map((hold) => hold.reason);
}

type Mutation = (input: JevApprovalInput) => void;

/** Conditions of the paper itself: they also make "would approve" false. */
const PAPER_CASES: Array<[string, Mutation, JevHoldReason]> = [
  ["item already decided", (i) => void (i.paper.itemState = "approved"), "not_approvable"],
  ["item still processing", (i) => void (i.paper.itemState = "processing"), "not_approvable"],
  ["candidate superseded", (i) => void (i.paper.candidateStatus = "superseded"), "not_approvable"],
  ["no confidence", (i) => void (i.paper.confidence = null), "no_confidence"],
  ["confidence below threshold", (i) => void (i.paper.confidence = 0.9499), "below_threshold"],
  [
    "open blocking finding",
    (i) => void (i.paper.openFindings = [{ ruleKey: "uncategorized", impact: "blocking" }]),
    "blocking_finding",
  ],
  [
    "open warning",
    (i) => void (i.paper.openFindings = [{ ruleKey: "missing_receipt", impact: "warning" }]),
    "open_warning",
  ],
  ["open duplicate case", (i) => void (i.paper.duplicateCaseOpen = true), "duplicate_case"],
  [
    "possible duplicate finding",
    (i) => void (i.paper.openFindings = [{ ruleKey: "possible_duplicate", impact: "warning" }]),
    "duplicate_case",
  ],
  ["unknown party", (i) => void (i.paper.partyId = null), "unknown_party"],
  ["a party would be created", (i) => void (i.paper.newPartyPending = true), "new_party"],
  [
    "payee bank details changed",
    (i) => void (i.paper.paymentDetailsFlagged = true),
    "payment_details_changed",
  ],
  [
    "an emailed paper whose sender could not be verified",
    (i) =>
      void (i.paper.sender = { verified: false, detail: "it carries no authentication results" }),
    "sender_unverified",
  ],
  ["period closed", (i) => void (i.paper.periodLocked = true), "period_locked"],
  [
    "a line without an account",
    (i) =>
      void (i.paper.lines = [{ ...i.paper.lines[0] }, { ...i.paper.lines[1], accountId: null }]),
    "incomplete_entry",
  ],
  ["a single line", (i) => void (i.paper.lines = [i.paper.lines[0]]), "incomplete_entry"],
  [
    "unbalanced by one unit at the 8th decimal",
    (i) =>
      void (i.paper.lines = [
        { accountId: EXPENSE, debit: "84.25000001", credit: null },
        { accountId: BANK, debit: null, credit: "84.25" },
      ]),
    "unbalanced",
  ],
  ["unknown total", (i) => void (i.paper.functionalTotal = null), "no_amount"],
  ["over the cap by a cent", (i) => void (i.paper.functionalTotal = "500.01"), "over_cap"],
  [
    "over the cap by one unit at the 8th decimal",
    (i) => void (i.paper.functionalTotal = "500.00000001"),
    "over_cap",
  ],
];

/** Lane, org, wall and sample conditions: Jev still "would approve" the paper. */
const GATE_CASES: Array<[string, Mutation, JevHoldReason]> = [
  ["lane at watch", (i) => void (i.lane = { ...i.lane!, level: "watch" }), "lane_not_auto"],
  ["lane at suggest", (i) => void (i.lane = { ...i.lane!, level: "suggest" }), "lane_not_auto"],
  ["no lane at all", (i) => void (i.lane = null), "lane_not_auto"],
  [
    "auto lane without a party",
    (i) => void (i.lane = { ...i.lane!, partyId: null }),
    "lane_limits_missing",
  ],
  ["org switch off", (i) => void (i.org.autoApproveEnabled = false), "autoapprove_off"],
  ["AI kill switch on", (i) => void (i.org.aiKillSwitch = true), "ai_kill_switch"],
  [
    "maker-checker without opt-in",
    (i) => void (i.org.requireDifferentApprover = true),
    "maker_checker",
  ],
  ["categorize walled", (i) => void (i.walledKinds = ["categorize"]), "walled_kind"],
  ["sampled for a spot check", (i) => void (i.sampled = true), "spot_check"],
];

describe("evaluateJevApproval", () => {
  it("approves when every condition holds", () => {
    const decision = evaluateJevApproval(passing());
    expect(decision).toMatchObject({
      approve: true,
      wouldApprove: true,
      heldForSpotCheck: false,
      holds: [],
      threshold: 0.95,
      amountCap: "500.00000000",
    });
  });

  it.each(PAPER_CASES)("holds the paper: %s", (_label, mutate, reason) => {
    const input = passing();
    mutate(input);
    const decision = evaluateJevApproval(input);
    expect(decision.approve).toBe(false);
    expect(decision.wouldApprove).toBe(false);
    expect(decision.heldForSpotCheck).toBe(false);
    expect(decision.holds.map((hold) => hold.reason)).toContain(reason);
    expect(decision.holds.find((hold) => hold.reason === reason)?.scope).toBe("paper");
  });

  it.each(GATE_CASES)("holds without faulting the paper: %s", (_label, mutate, reason) => {
    const input = passing();
    mutate(input);
    const decision = evaluateJevApproval(input);
    expect(decision.approve).toBe(false);
    expect(decision.wouldApprove).toBe(true);
    expect(reasonsOf(input)).toEqual([reason]);
  });

  it("approves at exactly the threshold and exactly the cap", () => {
    const input = passing();
    input.paper.confidence = 0.95;
    input.paper.functionalTotal = "500.00000000";
    expect(evaluateJevApproval(input).approve).toBe(true);
  });

  it("lets maker-checker orgs approve only after an explicit opt-in", () => {
    const input = passing();
    input.org.requireDifferentApprover = true;
    input.org.makerCheckerOptIn = true;
    expect(evaluateJevApproval(input).approve).toBe(true);
  });

  it("never lets a resolved or open payee bank-detail finding through", () => {
    const input = passing();
    input.paper.openFindings = [{ ruleKey: PAYMENT_DETAILS_RULE_KEY, impact: "blocking" }];
    // The open finding itself is reported once, as the bank-detail hold, and
    // only when the loader flags it (open or resolved).
    expect(reasonsOf(input)).toEqual([]);
    input.paper.paymentDetailsFlagged = true;
    expect(reasonsOf(input)).toEqual(["payment_details_changed"]);
  });

  it("approves an emailed paper only with a verified sender, and says why not", () => {
    const input = passing();
    input.paper.sender = { verified: true, detail: null };
    expect(evaluateJevApproval(input)).toMatchObject({ approve: true, holds: [] });

    input.paper.sender = { verified: false, detail: "paperstreet-billing.example is new" };
    input.sampled = true;
    const decision = evaluateJevApproval(input);
    // Held for the sender, not sampled: an unverified sender is never a spot check.
    expect(decision).toMatchObject({
      approve: false,
      wouldApprove: false,
      heldForSpotCheck: false,
      holds: [
        {
          reason: "sender_unverified",
          scope: "paper",
          detail: "paperstreet-billing.example is new",
        },
      ],
    });
    expect(describeJevHolds(decision.holds)).toEqual([
      "Sender could not be verified — Jev won't approve this on its own. (paperstreet-billing.example is new)",
    ]);
    input.paper.sender = { verified: false, detail: null };
    expect(describeJevHolds(evaluateJevApproval(input).holds)).toEqual([
      "Sender could not be verified — Jev won't approve this on its own.",
    ]);
  });

  it("marks a spot check only when the sample is the ONLY hold", () => {
    const sampled = passing();
    sampled.sampled = true;
    expect(evaluateJevApproval(sampled)).toMatchObject({
      approve: false,
      wouldApprove: true,
      heldForSpotCheck: true,
      holds: [{ reason: "spot_check", scope: "sample" }],
    });
    // A paper held for anything else is not a spot check, sampled or not.
    sampled.paper.periodLocked = true;
    expect(evaluateJevApproval(sampled)).toMatchObject({
      heldForSpotCheck: false,
      holds: [{ reason: "period_locked", scope: "paper" }],
    });
  });

  it("judges an unpromoted lane's papers with the provisional threshold and no cap", () => {
    const watch = passing();
    watch.lane = { level: "watch", amountCap: null, confidenceThreshold: null, partyId: VENDOR };
    watch.paper.functionalTotal = "999999.99";
    watch.paper.confidence = PROVISIONAL_WOULD_APPROVE_THRESHOLD;
    const decision = evaluateJevApproval(watch);
    expect(decision).toMatchObject({
      wouldApprove: true,
      threshold: PROVISIONAL_WOULD_APPROVE_THRESHOLD,
      amountCap: null,
    });
    watch.paper.confidence = PROVISIONAL_WOULD_APPROVE_THRESHOLD - 0.0001;
    expect(evaluateJevApproval(watch).wouldApprove).toBe(false);
  });

  it("reports every hold at once, in a stable order", () => {
    const input = passing();
    input.lane = { ...input.lane!, level: "suggest" };
    input.org.autoApproveEnabled = false;
    input.walledKinds = ["categorize"];
    input.paper.partyId = null;
    input.paper.periodLocked = true;
    input.sampled = true;
    expect(reasonsOf(input)).toEqual([
      "lane_not_auto",
      "autoapprove_off",
      "walled_kind",
      "unknown_party",
      "period_locked",
    ]);
    expect(describeJevHolds(evaluateJevApproval(input).holds)).toEqual([
      "Jev's lane for this paper is not at auto. (suggest)",
      "Jev approval is off for this organization.",
      "Jev may not apply categories on its own yet. (categorize)",
      "No vendor or customer is linked.",
      "Its period is closed.",
    ]);
  });
});
