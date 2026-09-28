import { describe, expect, it, vi } from "vitest";
import {
  requireUserActor,
  reviewDecisionActor,
  SystemActorNotSupportedError,
  type PostingActor,
} from "@/lib/posting/actor";
import {
  assertPostableLines,
  BILL_ACCRUAL_SHAPE_MESSAGE,
  BILL_SUB_CENT_MESSAGE,
  BillAccrualShapeError,
  billLinesFromAccrual,
  SubCentBillAmountError,
  toBillAmount,
  type PostingLineDraft,
} from "@/lib/posting/posting-lines";
import { isVendorBillCandidate } from "@/lib/inbox/vendor-bill";
import { createBillCore } from "@/lib/posting/bill-core";
import { submitBillForReviewCore } from "@/lib/posting/bill-submission";
import { createInvoiceCore } from "@/lib/posting/invoice-core";
import { postTransactionCore } from "@/lib/posting/transaction-core";

// The cores import the database module. No test here opens a connection: a
// system actor must be refused before any executor call.
vi.mock("@/db", () => ({ db: {}, dbAdmin: {} }));

const JEV: PostingActor = { type: "system", key: "jev" };
const USER: PostingActor = { type: "user", userId: "user-1" };

/** An executor that fails the test the moment anything touches it. */
const untouchable = new Proxy(
  {},
  {
    get(_target, property) {
      throw new Error(`The executor was used (${String(property)}) before the actor check.`);
    },
  },
) as never;

const EXPENSE = "11111111-1111-4111-8111-111111111111";
const SUPPLIES = "22222222-2222-4222-8222-222222222222";
const AP = "33333333-3333-4333-8333-333333333333";
const BANK = "44444444-4444-4444-8444-444444444444";

function line(
  accountId: string,
  side: { debit?: string; credit?: string },
  extra: Partial<PostingLineDraft> = {},
): PostingLineDraft {
  return {
    accountId,
    debit: side.debit ?? null,
    credit: side.credit ?? null,
    sortOrder: 0,
    ...extra,
  };
}

describe("posting actor", () => {
  it("hands a user's id to user-typed audit columns", () => {
    expect(requireUserActor(USER, "postTransactionCore")).toBe("user-1");
  });

  it("refuses a system actor until an autonomy lane can authorize one", () => {
    expect(() => requireUserActor(JEV, "createBillCore")).toThrow(SystemActorNotSupportedError);
    expect(() => requireUserActor(JEV, "createBillCore")).toThrow(/createBillCore.*"jev"/);
  });

  it("maps each actor onto the review_decisions columns", () => {
    expect(reviewDecisionActor(USER)).toEqual({
      actorType: "user",
      actorId: "user-1",
      actorKey: null,
    });
    expect(reviewDecisionActor(JEV)).toEqual({
      actorType: "system",
      actorId: null,
      actorKey: "jev",
    });
  });

  it("every posting core refuses the system actor before touching the database", async () => {
    await expect(
      postTransactionCore(untouchable, "org-1", JEV, {
        idempotencyKey: "k",
        transactionDate: "2026-07-20",
        transactionType: "journal",
        source: "manual",
        functionalCurrency: "USD",
        lines: [],
      }),
    ).rejects.toThrow(SystemActorNotSupportedError);
    await expect(
      createBillCore(untouchable, "org-1", JEV, {
        vendorId: "v",
        billDate: "2026-07-20",
        dueDate: "2026-07-20",
        accrual: { kind: "review", billId: "b", status: "in_review", lineItems: [] },
      }),
    ).rejects.toThrow(SystemActorNotSupportedError);
    await expect(
      submitBillForReviewCore(untouchable, "org-1", JEV, {
        idempotencyKey: "k",
        vendorId: "v",
        billDate: "2026-07-20",
        dueDate: "2026-07-20",
        lineItems: [],
      }),
    ).rejects.toThrow(SystemActorNotSupportedError);
    await expect(
      createInvoiceCore(untouchable, "org-1", JEV, {
        customerId: "c",
        issueDate: "2026-07-20",
        dueDate: "2026-07-20",
        discountAmount: "0",
        taxAmount: "0",
        lineItems: [],
      }),
    ).rejects.toThrow(SystemActorNotSupportedError);
  });
});

describe("assertPostableLines", () => {
  it("returns the exact debit total of a balanced entry", () => {
    expect(
      assertPostableLines([
        line(EXPENSE, { debit: "10.12345678" }),
        line(SUPPLIES, { debit: "0.00000002" }),
        line(BANK, { credit: "10.1234568" }),
      ]),
    ).toEqual({ totalAmount: "10.1234568" });
  });

  it("refuses fewer than two lines and lines without an account", () => {
    expect(() => assertPostableLines([line(EXPENSE, { debit: "1" })])).toThrow(
      "At least two posting lines are required.",
    );
    expect(() =>
      assertPostableLines([line(EXPENSE, { debit: "1" }), line("", { credit: "1" })]),
    ).toThrow("Every posting line must have an account.");
  });

  it("refuses an imbalance of a single unit at the 8th decimal — nothing is rounded first", () => {
    expect(() =>
      assertPostableLines([
        line(EXPENSE, { debit: "10.00000001" }),
        line(BANK, { credit: "10.00000000" }),
      ]),
    ).toThrow(/Unbalanced entry/);
  });
});

describe("bill cent policy", () => {
  it("renders whole-cent amounts at the bills table's scale", () => {
    expect(toBillAmount("84.25000000")).toBe("84.25");
    expect(toBillAmount("84.2")).toBe("84.20");
    expect(toBillAmount("7")).toBe("7.00");
    expect(toBillAmount("1234567.89")).toBe("1234567.89");
  });

  it("refuses anything below a cent instead of rounding it", () => {
    expect(() => toBillAmount("10.005")).toThrow(SubCentBillAmountError);
    expect(() => toBillAmount("10.00500000")).toThrow(`${BILL_SUB_CENT_MESSAGE} (found 10.005).`);
    expect(() => toBillAmount("0.00000001")).toThrow(BILL_SUB_CENT_MESSAGE);
    expect(() => toBillAmount("108.375")).toThrow(BILL_SUB_CENT_MESSAGE);
  });
});

describe("billLinesFromAccrual", () => {
  it("turns each debit into a bill line and the single A/P credit into the total", () => {
    const result = billLinesFromAccrual(
      [
        line(
          EXPENSE,
          { debit: "60.25000000" },
          {
            lineDescription: "Paper",
            departmentId: "dept",
            locationId: "loc",
          },
        ),
        line(SUPPLIES, { debit: "24.00000000" }),
        line(AP, { credit: "84.25000000" }, { lineDescription: "Owed" }),
      ],
      AP,
    );
    expect(result).toEqual({
      total: "84.25",
      lineItems: [
        {
          description: "Paper",
          amount: "60.25",
          accountId: EXPENSE,
          departmentId: "dept",
          locationId: "loc",
        },
        {
          description: null,
          amount: "24.00",
          accountId: SUPPLIES,
          departmentId: null,
          locationId: null,
        },
      ],
    });
  });

  it("refuses entries that are not a bill accrual", () => {
    const shapes: PostingLineDraft[][] = [
      // Credited to the bank: paid on the spot, not payable.
      [line(EXPENSE, { debit: "10" }), line(BANK, { credit: "10" })],
      // Two credits: part of it is not owed to the vendor.
      [line(EXPENSE, { debit: "10" }), line(AP, { credit: "9" }), line(BANK, { credit: "1" })],
      // A/P debited: a vendor credit, not a bill.
      [line(AP, { debit: "10" }), line(EXPENSE, { credit: "10" })],
      // No debit line at all.
      [line(AP, { credit: "10" }), line(EXPENSE, {})],
      // One line carrying both sides.
      [line(EXPENSE, { debit: "10", credit: "10" }), line(AP, { credit: "10" })],
    ];
    for (const lines of shapes) {
      expect(() => billLinesFromAccrual(lines, AP)).toThrow(BillAccrualShapeError);
    }
    expect(() =>
      billLinesFromAccrual([line(EXPENSE, { debit: "10" }), line(BANK, { credit: "10" })], AP),
    ).toThrow(BILL_ACCRUAL_SHAPE_MESSAGE);
  });

  it("refuses zero lines and totals that do not match the credit", () => {
    expect(() =>
      billLinesFromAccrual(
        [line(EXPENSE, { debit: "0" }), line(SUPPLIES, { debit: "5" }), line(AP, { credit: "5" })],
        AP,
      ),
    ).toThrow("Bill line amounts must be greater than zero.");
    expect(() =>
      billLinesFromAccrual([line(EXPENSE, { debit: "5" }), line(AP, { credit: "6" })], AP),
    ).toThrow(/do not add up/);
  });

  it("applies the cent policy to every amount the bill would store", () => {
    expect(() =>
      billLinesFromAccrual(
        [line(EXPENSE, { debit: "10.005" }), line(AP, { credit: "10.005" })],
        AP,
      ),
    ).toThrow(SubCentBillAmountError);
  });

  it("keeps a long description inside the bill line's 500 characters", () => {
    const [item] = billLinesFromAccrual(
      [
        line(EXPENSE, { debit: "1" }, { lineDescription: "x".repeat(600) }),
        line(AP, { credit: "1" }),
      ],
      AP,
    ).lineItems;
    expect(item.description).toHaveLength(500);
  });
});

describe("isVendorBillCandidate", () => {
  it("treats Bills-editor candidates as bills whatever their source says", () => {
    expect(isVendorBillCandidate("bill", null)).toBe(true);
    expect(isVendorBillCandidate("bill", "purchase")).toBe(true);
  });

  it("treats emailed and uploaded papers as bills only when classified bill_accrual", () => {
    for (const candidateType of ["email_transaction", "document_transaction"]) {
      expect(isVendorBillCandidate(candidateType, "bill_accrual")).toBe(true);
      expect(isVendorBillCandidate(candidateType, "purchase")).toBe(false);
      expect(isVendorBillCandidate(candidateType, "bill_payment")).toBe(false);
      expect(isVendorBillCandidate(candidateType, null)).toBe(false);
    }
  });

  it("never treats plain transactions or invoices as vendor bills", () => {
    expect(isVendorBillCandidate("transaction", "bill_accrual")).toBe(false);
    expect(isVendorBillCandidate("invoice", "bill_accrual")).toBe(false);
  });
});
