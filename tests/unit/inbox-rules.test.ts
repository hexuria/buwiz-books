import { describe, expect, it } from "vitest";
import { evaluateBookRules, type BookRuleAccount } from "@/lib/inbox/rules";
import {
  compareMoney,
  multiplyMoney,
  normalizeCurrency,
  parseRateToScaled,
  sumMoney,
} from "@/lib/inbox/money";

const settings = {
  lowConfidenceThreshold: "0.8",
  missingReceiptThreshold: "75",
  missingReceiptCurrency: "USD",
  functionalCurrency: "USD",
};

function account(
  id: string,
  accountType: string,
  subtype: string | null,
  childCount = 0,
): BookRuleAccount {
  return { id, accountType, subtype, childCount };
}

describe("Inbox fixed-point money", () => {
  it("sums and compares eight-decimal values without floating-point drift", () => {
    expect(sumMoney(["0.1", "0.2"])).toBe("0.3");
    expect(compareMoney(sumMoney(["0.1", "0.2"]), "0.3")).toBe(0);
  });

  it("converts source amounts using a deterministic rounded rate", () => {
    expect(multiplyMoney("100", "1.23456789")).toBe("123.456789");
    expect(multiplyMoney("100", "1.2345678901")).toBe("123.45678901");
    expect(parseRateToScaled("1.2345678901")).toBe(12_345_678_901n);
    expect(normalizeCurrency(" php ")).toBe("PHP");
  });
});

describe("Inbox Book and Review findings", () => {
  it("blocks uncategorized expenses missing vendor, receipt, and dimensions", () => {
    const findings = evaluateBookRules({
      candidate: {
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        exchangeRate: "1",
        lines: [],
      },
      lines: [
        { accountId: "bank", credit: "100" },
        { accountId: "expense", debit: "100", categoryConfidence: "0.4" },
      ],
      accounts: new Map([
        ["bank", account("bank", "asset", "checking")],
        ["expense", account("expense", "expense", "uncategorized_expenses")],
      ]),
      party: null,
      documents: [],
      settings,
    });

    expect(new Set(findings.map((finding) => finding.ruleKey))).toEqual(
      new Set([
        "uncategorized",
        "low_confidence_category",
        "missing_vendor",
        "missing_department",
        "missing_location",
        "missing_receipt",
      ]),
    );
    expect(findings.every((finding) => finding.impact === "blocking")).toBe(true);
  });

  it("treats posting to a parent category as a Review warning", () => {
    const findings = evaluateBookRules({
      candidate: {
        transactionDate: "2026-07-24",
        transactionType: "transfer",
        exchangeRate: "1",
        lines: [],
      },
      lines: [
        {
          accountId: "parent",
          debit: "50",
          departmentId: "department",
          locationId: "location",
        },
        {
          accountId: "bank",
          credit: "50",
          departmentId: "department",
          locationId: "location",
        },
      ],
      accounts: new Map([
        ["parent", account("parent", "asset", "cash", 2)],
        ["bank", account("bank", "asset", "checking")],
      ]),
      party: null,
      documents: [],
      settings,
    });

    expect(findings).toEqual([
      expect.objectContaining({
        ruleKey: "transaction_in_parent_category",
        impact: "warning",
      }),
    ]);
  });

  it("accepts a supported expense when all Book requirements are present", () => {
    const findings = evaluateBookRules({
      candidate: {
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        exchangeRate: "1",
        lines: [],
      },
      lines: [
        {
          accountId: "expense",
          debit: "100",
          departmentId: "department",
          locationId: "location",
          categoryConfidence: "0.99",
        },
        {
          accountId: "bank",
          credit: "100",
          departmentId: "department",
          locationId: "location",
        },
      ],
      accounts: new Map([
        ["expense", account("expense", "expense", "advertising")],
        ["bank", account("bank", "asset", "checking")],
      ]),
      party: { id: "vendor", partyType: "vendor" },
      documents: [{ id: "receipt", documentType: "receipt" }],
      settings,
    });

    expect(findings).toEqual([]);
  });
});
