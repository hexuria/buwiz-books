import { describe, expect, it } from "vitest";
import {
  deriveInboxV2Kind,
  deriveInboxV2Reason,
  deriveInboxV2SourceBadge,
  describeInboxV2Reason,
  formatSourceBadge,
  INBOX_V2_REASON_LABELS,
  INBOX_V2_REASONS,
  type InboxV2EntryShape,
  type InboxV2OpenFinding,
  type InboxV2ReasonInput,
  type ModelUnsureSignal,
} from "../../../src/lib/inbox/v2/triage";
import { isInboxV2Enabled } from "../../../src/lib/inbox/v2/flag";

/**
 * Inbox v2 shows only what needs a human, with exactly one reason per item (spec §10). These pin
 * the precedence — failed > needs_fix > jev_unsure > spot_check > ready — that "Jev unsure"
 * needs a real model-unsure signal (a clean or hand-entered item is "Ready to approve"), and that
 * a blocking finding which is nothing but stage 2's doubt does not bury that signal as a fix.
 */

const blocking = (
  ruleKey: string,
  message = `${ruleKey} message`,
  lineIndexes: number[] | null = null,
): InboxV2OpenFinding => ({ ruleKey, blocking: true, message, lineIndexes });
const warning = (ruleKey: string): InboxV2OpenFinding => ({ ruleKey, blocking: false });

/** A two-line entry with an account on every line. */
const COMPLETE: InboxV2EntryShape = { lineCount: 2, linesWithoutAccount: [] };

function reasonFor(input: Partial<InboxV2ReasonInput>) {
  return deriveInboxV2Reason({
    state: "ready_for_review",
    openFindings: [],
    entry: COMPLETE,
    ...input,
  });
}

/** Stage 2 parked line 0 on Uncategorized: its pick was below the threshold. */
const unsureCategory: ModelUnsureSignal = {
  subject: "category",
  cause: "low_confidence",
  confidence: 0.41,
  lineIndex: 0,
};
/** Stage 2 left the counterparty empty: the model gave no usable answer. */
const failedParty: ModelUnsureSignal = {
  subject: "party",
  cause: "failed",
  confidence: null,
  lineIndex: null,
};
const UNCATEGORIZED_MESSAGE = "Choose a leaf category for every posting line.";

describe("deriveInboxV2Reason", () => {
  it("offers the spec's four reason chips plus Ready to approve, in chip order", () => {
    expect([...INBOX_V2_REASONS]).toEqual([
      "needs_fix",
      "jev_unsure",
      "spot_check",
      "failed",
      "ready",
    ]);
    expect(INBOX_V2_REASON_LABELS.ready).toBe("Ready to approve");
  });

  it("reports a failed item as failed, whatever else is open or unsure", () => {
    const reason = reasonFor({
      state: "failed",
      openFindings: [blocking("missing_vendor")],
      modelUnsureSignals: [unsureCategory],
    });
    expect(reason).toMatchObject({ reason: "failed", detail: "processing_failed", signals: [] });
  });

  it("treats an open source_processing_failed finding as failed and carries its message", () => {
    const reason = reasonFor({
      state: "needs_information",
      openFindings: [
        blocking("uncategorized"),
        blocking("source_processing_failed", "Inbound email processing failed after 8 attempt(s)."),
      ],
    });
    expect(reason).toMatchObject({
      reason: "failed",
      ruleKey: "source_processing_failed",
      message: "Inbound email processing failed after 8 attempt(s).",
    });
    expect(describeInboxV2Reason(reason)).toBe(
      "Inbound email processing failed after 8 attempt(s).",
    );
  });

  it("needs a fix when any blocking finding other than low confidence is open", () => {
    const reason = reasonFor({
      openFindings: [
        warning("transaction_in_parent_category"),
        blocking("low_confidence_category"),
        blocking("missing_vendor", "Assign a vendor to this expense transaction."),
      ],
    });
    expect(reason).toMatchObject({
      reason: "needs_fix",
      detail: "blocking_finding",
      ruleKey: "missing_vendor",
    });
    expect(describeInboxV2Reason(reason)).toBe("Assign a vendor to this expense transaction.");
  });

  it("names the same fix whatever order the open checks arrive in", () => {
    // One evaluation writes all of an item's findings at once, so their first_seen_at ties and
    // the list's order among them is not a meaningful signal. The named fix must not depend on it.
    const unsafe = [blocking("party_payment_details_changed"), blocking("possible_duplicate")];
    const bookChecks = [
      blocking("missing_location"),
      blocking("missing_invoice"),
      blocking("uncategorized", UNCATEGORIZED_MESSAGE, [1]),
      blocking("missing_department"),
      blocking("a_future_rule"),
    ];
    const named = (findings: InboxV2OpenFinding[]) =>
      [findings, [...findings].reverse()].map(
        (openFindings) => reasonFor({ openFindings }).ruleKey,
      );

    // Unsafe to book first: changed payee bank details, then a possible duplicate.
    expect(named([...bookChecks, ...unsafe])).toEqual([
      "party_payment_details_changed",
      "party_payment_details_changed",
    ]);
    expect(named([...bookChecks, unsafe[1]])).toEqual(["possible_duplicate", "possible_duplicate"]);
    // Then the book rules in evaluation order, and only then a rule this code does not know.
    expect(named(bookChecks)).toEqual(["uncategorized", "uncategorized"]);
    expect(named(bookChecks.slice(3))).toEqual(["missing_department", "missing_department"]);
    // Among rules it does not know, the list's order (first seen, then rule key) decides.
    expect(reasonFor({ openFindings: [blocking("b_rule"), blocking("a_rule")] }).ruleKey).toBe(
      "b_rule",
    );
  });

  it("needs a fix while the entry lacks lines or an account, even with no finding open", () => {
    for (const entry of [
      { lineCount: 0, linesWithoutAccount: [] },
      { lineCount: 2, linesWithoutAccount: [1] },
    ]) {
      const reason = reasonFor({ state: "needs_information", entry });
      expect(reason).toMatchObject({ reason: "needs_fix", detail: "needs_information" });
      expect(describeInboxV2Reason(reason)).toBe(
        "Add the accounting details before this can be approved.",
      );
    }
  });

  it("judges the entry, not the lifecycle state: a complete draft in needs_information is ready", () => {
    expect(reasonFor({ state: "needs_information" })).toMatchObject({ reason: "ready" });
  });

  it("does not count a non-blocking duplicate or warning as a fix", () => {
    const reason = reasonFor({
      openFindings: [warning("possible_duplicate"), warning("missing_receipt")],
    });
    expect(reason).toMatchObject({ reason: "ready", detail: "ready" });
  });

  it("is Jev unsure on a low-confidence category, blocking or not", () => {
    for (const finding of [
      blocking("low_confidence_category"),
      warning("low_confidence_category"),
    ]) {
      const reason = reasonFor({ openFindings: [finding] });
      expect(reason).toMatchObject({ reason: "jev_unsure", detail: "low_confidence" });
      expect(describeInboxV2Reason(reason)).toMatch(/isn't sure about the category/);
    }
  });

  it("is Jev unsure when the only blocker is the category stage 2 parked on Uncategorized", () => {
    const reason = reasonFor({
      openFindings: [blocking("uncategorized", UNCATEGORIZED_MESSAGE, [0])],
      modelUnsureSignals: [unsureCategory],
    });
    expect(reason).toMatchObject({ reason: "jev_unsure", detail: "model_unsure" });
    expect(describeInboxV2Reason(reason)).toBe("Jev isn't sure about the category (41% sure).");
  });

  it("is Jev unsure on an unsure category left empty where no Uncategorized account is mapped", () => {
    const reason = reasonFor({
      entry: { lineCount: 2, linesWithoutAccount: [0] },
      openFindings: [blocking("uncategorized", UNCATEGORIZED_MESSAGE, [0])],
      modelUnsureSignals: [{ ...unsureCategory, cause: "failed", confidence: null }],
    });
    expect(reason).toMatchObject({ reason: "jev_unsure", detail: "model_unsure" });
    expect(describeInboxV2Reason(reason)).toBe("Jev couldn't choose a category.");
  });

  it("is Jev unsure when a missing vendor or customer is the unresolved counterparty match", () => {
    for (const ruleKey of ["missing_vendor", "missing_customer"]) {
      const reason = reasonFor({
        openFindings: [blocking(ruleKey)],
        modelUnsureSignals: [failedParty],
      });
      expect(reason).toMatchObject({ reason: "jev_unsure", detail: "model_unsure" });
      expect(describeInboxV2Reason(reason)).toBe("Jev couldn't match the vendor or customer.");
    }
  });

  it("still needs a fix for what the doubt does not explain, and names the doubt after it", () => {
    // Stage 2 never picks the payment side: its empty line is in the same finding.
    const paymentSideOpen = reasonFor({
      state: "needs_information",
      entry: { lineCount: 2, linesWithoutAccount: [1] },
      openFindings: [blocking("uncategorized", UNCATEGORIZED_MESSAGE, [0, 1])],
      modelUnsureSignals: [unsureCategory],
    });
    expect(paymentSideOpen).toMatchObject({
      reason: "needs_fix",
      detail: "blocking_finding",
      ruleKey: "uncategorized",
    });
    expect(describeInboxV2Reason(paymentSideOpen)).toBe(
      `${UNCATEGORIZED_MESSAGE} Jev isn't sure about the category (41% sure).`,
    );

    // A counterparty doubt does not explain a missing dimension.
    expect(
      reasonFor({
        openFindings: [blocking("missing_vendor"), blocking("missing_department")],
        modelUnsureSignals: [failedParty],
      }),
    ).toMatchObject({ reason: "needs_fix", ruleKey: "missing_department" });

    // Nor a category doubt a missing counterparty, or an ingest-time finding with no lines named.
    for (const finding of [blocking("missing_vendor"), blocking("uncategorized")]) {
      expect(
        reasonFor({ openFindings: [finding], modelUnsureSignals: [unsureCategory] }).reason,
      ).toBe("needs_fix");
    }
    // An empty line the model was never asked about is a missing detail.
    expect(
      reasonFor({
        entry: { lineCount: 2, linesWithoutAccount: [1] },
        modelUnsureSignals: [unsureCategory],
      }),
    ).toMatchObject({ reason: "needs_fix", detail: "needs_information" });
  });

  it("names every subject the model was unsure of", () => {
    const reason = reasonFor({
      openFindings: [
        blocking("uncategorized", UNCATEGORIZED_MESSAGE, [0]),
        blocking("missing_vendor"),
      ],
      modelUnsureSignals: [
        unsureCategory,
        { ...failedParty, cause: "low_confidence", confidence: 0.55 },
      ],
    });
    expect(reason.reason).toBe("jev_unsure");
    expect(describeInboxV2Reason(reason)).toBe(
      "Jev isn't sure about the category (41% sure). Jev isn't sure about the vendor or customer (55% sure).",
    );
  });

  it("marks a held-back sample as a spot check, but never over a real problem or doubt", () => {
    expect(reasonFor({ spotCheck: true })).toMatchObject({ reason: "spot_check" });
    expect(
      reasonFor({ openFindings: [blocking("missing_vendor")], spotCheck: true }),
    ).toMatchObject({ reason: "needs_fix" });
    expect(reasonFor({ modelUnsureSignals: [unsureCategory], spotCheck: true })).toMatchObject({
      reason: "jev_unsure",
    });
  });

  it("falls back to Ready to approve, never to Jev unsure", () => {
    const clean = reasonFor({});
    expect(clean).toMatchObject({ reason: "ready", detail: "ready" });
    expect(describeInboxV2Reason(clean)).toBe(
      "No check blocks it. Review the entry and approve it.",
    );
    // No signal at all, however it was entered: not Jev unsure.
    expect(reasonFor({ modelUnsureSignals: [] }).reason).toBe("ready");
  });
});

describe("deriveInboxV2Kind", () => {
  const kind = (
    candidateType: string,
    originEconomicEventClass: string | null,
    transactionType = "pay_out",
  ) => deriveInboxV2Kind({ candidateType, originEconomicEventClass, transactionType });

  it("uses the approval rule for vendor bills", () => {
    expect(kind("bill", null, "journal")).toBe("vendor_bill");
    expect(kind("email_transaction", "bill_accrual")).toBe("vendor_bill");
    expect(kind("document_transaction", "bill_accrual")).toBe("vendor_bill");
    // A manual entry is never a bill because of its class alone.
    expect(kind("transaction", "bill_accrual")).toBe("expense");
  });

  it("recognises sales invoices", () => {
    expect(kind("invoice", null, "journal")).toBe("sales_invoice");
    expect(kind("email_transaction", "invoice_accrual", "pay_in")).toBe("sales_invoice");
  });

  it("falls back to the transaction type", () => {
    expect(kind("email_transaction", "purchase", "pay_out")).toBe("expense");
    expect(kind("transaction", "sale", "pay_in")).toBe("money_in");
    expect(kind("transaction", "transfer", "transfer")).toBe("transfer");
    expect(kind("transaction", "other", "journal")).toBe("journal");
  });
});

describe("deriveInboxV2SourceBadge", () => {
  it("says Remembered when a memory answered, whatever the confidence", () => {
    const badge = deriveInboxV2SourceBadge({ remembered: true, minCategoryConfidence: "0.4000" });
    expect(badge).toEqual({ kind: "remembered" });
    expect(formatSourceBadge(badge!)).toBe("Remembered");
  });

  it("shows Jev's weakest category confidence as a percentage", () => {
    const badge = deriveInboxV2SourceBadge({ remembered: false, minCategoryConfidence: "0.6250" });
    expect(badge).toEqual({ kind: "jev", confidence: 0.625 });
    expect(formatSourceBadge(badge!)).toBe("Jev 63%");
  });

  it("has no badge for hand-entered lines or an out-of-range value", () => {
    expect(deriveInboxV2SourceBadge({ remembered: false, minCategoryConfidence: null })).toBeNull();
    expect(deriveInboxV2SourceBadge({ remembered: false, minCategoryConfidence: "" })).toBeNull();
    expect(
      deriveInboxV2SourceBadge({ remembered: false, minCategoryConfidence: "1.5" }),
    ).toBeNull();
  });
});

describe("isInboxV2Enabled", () => {
  it("is off unless the organization turned it on", () => {
    expect(isInboxV2Enabled({})).toBe(false);
    expect(isInboxV2Enabled({ inboxV2: false })).toBe(false);
    expect(isInboxV2Enabled({ inboxV2: true })).toBe(true);
  });
});

describe("memory answers (Inbox v2 step 10)", () => {
  it("reads a remembered entry no check blocks as Ready to approve, in its own words", () => {
    const reason = reasonFor({ state: "needs_information", remembered: true });
    expect(reason).toMatchObject({ reason: "ready", detail: "remembered", signals: [] });
    expect(describeInboxV2Reason(reason)).toBe(
      "Answered from a correction you asked Jev to remember. No check blocks it. Review the entry and approve it.",
    );
  });

  it("never lets a remembered answer hide a check that blocks", () => {
    expect(
      reasonFor({
        remembered: true,
        openFindings: [blocking("party_payment_details_changed", "Bank details changed.")],
      }),
    ).toMatchObject({
      reason: "needs_fix",
      detail: "blocking_finding",
      ruleKey: "party_payment_details_changed",
    });
  });

  it("names disagreeing memories as the fix, ahead of the Uncategorized line they leave", () => {
    const reason = reasonFor({
      state: "needs_information",
      openFindings: [
        blocking("uncategorized", UNCATEGORIZED_MESSAGE, [0, 1]),
        blocking(
          "memory_conflict",
          "2 remembered answers for this file disagree about this paper.",
        ),
      ],
    });
    expect(reason).toMatchObject({
      reason: "needs_fix",
      detail: "blocking_finding",
      ruleKey: "memory_conflict",
      message: "2 remembered answers for this file disagree about this paper.",
    });
    expect(describeInboxV2Reason(reason)).toBe(
      "2 remembered answers for this file disagree about this paper.",
    );
  });
});
