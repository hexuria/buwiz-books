import { describe, expect, it } from "vitest";
import {
  deriveInboxV2Kind,
  deriveInboxV2Reason,
  deriveInboxV2SourceBadge,
  describeInboxV2Reason,
  formatSourceBadge,
  INBOX_V2_REASONS,
  type InboxV2OpenFinding,
} from "../../../src/lib/inbox/v2/triage";
import { isInboxV2Enabled } from "../../../src/lib/inbox/v2/flag";

/**
 * Inbox v2 shows only what needs a human, with exactly one reason per item (spec §10). These pin
 * the precedence — a failure outranks a fix, a fix outranks the model's doubt — and the fallback:
 * until autonomy lanes exist nothing approves on its own, so a clean item is "Jev unsure".
 */

const blocking = (ruleKey: string, message = `${ruleKey} message`): InboxV2OpenFinding => ({
  ruleKey,
  blocking: true,
  message,
});
const warning = (ruleKey: string): InboxV2OpenFinding => ({ ruleKey, blocking: false });

describe("deriveInboxV2Reason", () => {
  it("offers exactly the four reason chips of the spec", () => {
    expect([...INBOX_V2_REASONS].sort()).toEqual(
      ["failed", "jev_unsure", "needs_fix", "spot_check"].sort(),
    );
  });

  it("reports a failed item as failed, whatever else is open", () => {
    const reason = deriveInboxV2Reason({
      state: "failed",
      openFindings: [blocking("missing_vendor")],
    });
    expect(reason).toMatchObject({ reason: "failed", detail: "processing_failed" });
  });

  it("treats an open source_processing_failed finding as failed and carries its message", () => {
    const reason = deriveInboxV2Reason({
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
    const reason = deriveInboxV2Reason({
      state: "ready_for_review",
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

  it("needs a fix while the entry still lacks details, even with no finding open", () => {
    expect(deriveInboxV2Reason({ state: "needs_information", openFindings: [] })).toMatchObject({
      reason: "needs_fix",
      detail: "needs_information",
    });
  });

  it("does not count a non-blocking duplicate or warning as a fix", () => {
    const reason = deriveInboxV2Reason({
      state: "ready_for_review",
      openFindings: [warning("possible_duplicate"), warning("missing_receipt")],
    });
    expect(reason).toMatchObject({ reason: "jev_unsure", detail: "awaiting_approval" });
  });

  it("is Jev unsure on a low-confidence category, blocking or not", () => {
    for (const finding of [
      blocking("low_confidence_category"),
      warning("low_confidence_category"),
    ]) {
      const reason = deriveInboxV2Reason({ state: "ready_for_review", openFindings: [finding] });
      expect(reason).toMatchObject({ reason: "jev_unsure", detail: "low_confidence" });
      expect(describeInboxV2Reason(reason)).toMatch(/isn't sure about the category/);
    }
  });

  it("is Jev unsure on a step-7 model signal", () => {
    const reason = deriveInboxV2Reason({
      state: "ready_for_review",
      openFindings: [],
      modelUnsureSignals: [{ subject: "party", confidence: 0.41 }],
    });
    expect(reason).toMatchObject({ reason: "jev_unsure", detail: "model_unsure" });
    expect(describeInboxV2Reason(reason)).toBe("Jev isn't sure about the vendor or customer.");
  });

  it("marks a held-back sample as a spot check, but never over a real problem", () => {
    expect(
      deriveInboxV2Reason({ state: "ready_for_review", openFindings: [], spotCheck: true }),
    ).toMatchObject({ reason: "spot_check" });
    expect(
      deriveInboxV2Reason({
        state: "ready_for_review",
        openFindings: [blocking("missing_vendor")],
        spotCheck: true,
      }),
    ).toMatchObject({ reason: "needs_fix" });
  });

  it("falls back to Jev unsure: nothing approves on its own yet", () => {
    const clean = deriveInboxV2Reason({ state: "ready_for_review", openFindings: [] });
    expect(clean).toMatchObject({ reason: "jev_unsure", detail: "awaiting_approval" });
    expect(describeInboxV2Reason(clean)).toMatch(/does not approve entries on its own yet/);

    const inFlight = deriveInboxV2Reason({ state: "processing", openFindings: [] });
    expect(inFlight).toMatchObject({ reason: "jev_unsure", detail: "still_processing" });
    expect(describeInboxV2Reason(inFlight)).toBe("Jev is still reading this paper.");
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
