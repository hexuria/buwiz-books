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

describe("Missing Receipt across currencies", () => {
  /** A vendor-paid expense of `amount` in `currency`, converted to USD at `rate`. */
  function receiptFindings(
    amount: string,
    currency: string,
    rate: string,
    receiptSettings: Partial<typeof settings> = {},
  ) {
    const lines = [
      {
        accountId: "expense",
        debit: amount,
        departmentId: "department",
        locationId: "location",
      },
      { accountId: "bank", credit: amount, departmentId: "department", locationId: "location" },
    ];
    return evaluateBookRules({
      candidate: {
        transactionDate: "2026-09-14",
        transactionType: "pay_out",
        originalCurrency: currency,
        functionalCurrency: "USD",
        exchangeRate: rate,
        lines,
      },
      lines,
      accounts: new Map([
        ["expense", account("expense", "expense", "travel")],
        ["bank", account("bank", "asset", "checking")],
      ]),
      party: { id: "vendor", partyType: "vendor" },
      documents: [],
      settings: { ...settings, ...receiptSettings },
    }).filter((finding) => finding.ruleKey === "missing_receipt");
  }

  it("converts a foreign-currency total before comparing it with the threshold", () => {
    // EUR 70 at 1.10 is USD 77: over USD 75, though 70 alone is not.
    expect(receiptFindings("70", "EUR", "1.1000000000")).toEqual([
      {
        ruleKey: "missing_receipt",
        impact: "blocking",
        message: "Attach a receipt for expenses over USD 75.",
        evidence: {
          expenseTotal: "77",
          threshold: "75",
          thresholdCurrency: "USD",
          originalExpenseTotal: "70",
          originalCurrency: "EUR",
          exchangeRate: "1.1000000000",
        },
      },
    ]);
    // JPY 10,000 at 0.0067 is USD 67: under USD 75, though 10,000 alone is not.
    expect(receiptFindings("10000", "JPY", "0.0067")).toEqual([]);
    expect(receiptFindings("60", "EUR", "1.1")).toEqual([]);
  });

  it("converts a threshold set in the paper's own currency into the functional currency", () => {
    const eurThreshold = { missingReceiptCurrency: "EUR", missingReceiptThreshold: "75" };
    // EUR 75 at 1.10 is a USD 82.50 threshold: EUR 80 (USD 88) is over, EUR 74 (USD 81.40) is not.
    expect(receiptFindings("80", "EUR", "1.1", eurThreshold)).toMatchObject([
      { evidence: { expenseTotal: "88", thresholdCurrency: "EUR" } },
    ]);
    expect(receiptFindings("74", "EUR", "1.1", eurThreshold)).toEqual([]);
  });

  it("compares exact decimals at the boundary, in both directions", () => {
    expect(receiptFindings("75", "USD", "1")).toEqual([]);
    expect(receiptFindings("75.00000001", "USD", "1")).toMatchObject([
      { evidence: { expenseTotal: "75.00000001" } },
    ]);
    // 68.18181818 × 1.1 = 74.999999998, which rounds to exactly 75 at eight
    // decimals: at, not over, the threshold. One unit more is over.
    expect(receiptFindings("68.18181818", "EUR", "1.1")).toEqual([]);
    expect(receiptFindings("68.18181819", "EUR", "1.1")).toMatchObject([
      { evidence: { expenseTotal: "75.00000001" } },
    ]);
    // Tiny totals never become exponent strings the decimal parser rejects.
    expect(receiptFindings("0.00000001", "USD", "1")).toEqual([]);
  });
});
