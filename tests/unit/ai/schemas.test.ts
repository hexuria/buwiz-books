// ============================================================================
// Golden tests for the AI task output schemas.
//
// Each fixture mirrors a realistic model response for the task's Gemini
// responseSchema. The mutation cases pin the documented failure behavior:
// strict on core finance fields (amounts, dates, required structure),
// tolerant-with-defaults on secondary fields.
// ============================================================================
import { describe, expect, it } from "vitest";
import { dateParseOutputSchema } from "../../../src/lib/ai/schemas/date-parse";
import { classifyDocumentOutputSchema } from "../../../src/lib/ai/schemas/classify-document";
import { transactionParseOutputSchema } from "../../../src/lib/ai/schemas/transaction-parse";
import { receiptOcrOutputSchema } from "../../../src/lib/ai/schemas/receipt-ocr";
import { statementOcrOutputSchema } from "../../../src/lib/ai/schemas/statement-ocr";
import {
  billOcrOutputSchema,
  boundingBoxesOutputSchema,
} from "../../../src/lib/ai/schemas/bill-ocr";

describe("dateParseOutputSchema", () => {
  const golden = {
    type: "range",
    start_date: "2026-01-01",
    end_date: "2026-01-31",
    interpretation: "January 2026",
    confidence: 0.95,
  };

  it("accepts a golden response", () => {
    expect(dateParseOutputSchema.safeParse(golden).success).toBe(true);
  });

  it("accepts a multiple-dates response", () => {
    const result = dateParseOutputSchema.safeParse({
      type: "multiple",
      start_date: "2026-01-07",
      dates: ["2026-01-07", "2026-01-14", "2026-01-21", "2026-01-28"],
      interpretation: "All Wednesdays in January",
      confidence: 0.9,
    });
    expect(result.success).toBe(true);
  });

  it("rejects a malformed date", () => {
    expect(dateParseOutputSchema.safeParse({ ...golden, start_date: "01/15/2026" }).success).toBe(
      false,
    );
  });

  it("rejects an unknown type", () => {
    expect(dateParseOutputSchema.safeParse({ ...golden, type: "fuzzy" }).success).toBe(false);
  });
});

describe("classifyDocumentOutputSchema", () => {
  it("accepts a golden response", () => {
    const result = classifyDocumentOutputSchema.safeParse({
      documentType: "receipt",
      confidence: 92,
      reasoning: "POS receipt layout with itemized totals",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a documentType outside the enum", () => {
    expect(
      classifyDocumentOutputSchema.safeParse({ documentType: "memo", confidence: 80 }).success,
    ).toBe(false);
  });
});

const goldenTransactionLine = {
  description: "Office supplies",
  categoryId: "acct-1",
  categoryName: "Office Supplies",
  amount: "42.50",
  debit: "",
  credit: "",
};

const goldenTransaction = {
  transactionType: "pay_out",
  date: "2026-03-15",
  memo: "Office supplies from Staples",
  partyId: "party-1",
  partyName: "Staples",
  referenceNumber: "R-1001",
  categoryId: "acct-cash",
  categoryName: "Business Checking",
  amount: "42.50",
  lines: [goldenTransactionLine],
  confidence: 0.9,
  interpretation: "Pay Out $42.50 at Staples",
};

describe("transactionParseOutputSchema", () => {
  it("accepts a golden response and fills omitted dimension fields with empty strings", () => {
    const result = transactionParseOutputSchema.safeParse(goldenTransaction);
    expect(result.success).toBe(true);
    if (result.success) {
      // Fields outside the Gemini schema's `required` list keep the
      // ParsedTransactionResult shape via defaults.
      expect(result.data.departmentId).toBe("");
      expect(result.data.transferFromCategoryId).toBe("");
      expect(result.data.lines[0].locationName).toBe("");
    }
  });

  it("accepts an empty date (model could not determine one)", () => {
    expect(transactionParseOutputSchema.safeParse({ ...goldenTransaction, date: "" }).success).toBe(
      true,
    );
  });

  it("rejects a non-ISO date", () => {
    expect(
      transactionParseOutputSchema.safeParse({ ...goldenTransaction, date: "March 15" }).success,
    ).toBe(false);
  });

  it("rejects a numeric amount (amounts are decimal strings)", () => {
    expect(
      transactionParseOutputSchema.safeParse({ ...goldenTransaction, amount: 42.5 }).success,
    ).toBe(false);
  });

  it("rejects a missing lines array", () => {
    const { lines: _lines, ...withoutLines } = goldenTransaction;
    expect(transactionParseOutputSchema.safeParse(withoutLines).success).toBe(false);
  });
});

describe("receiptOcrOutputSchema", () => {
  const goldenReceipt = {
    ...goldenTransaction,
    extractedEntities: [
      {
        entityType: "vendor",
        name: "Staples",
        identifier: "",
        accountType: "other",
        matchedPartyId: "party-1",
      },
    ],
    documentSubtype: "receipt",
  };

  it("accepts a golden response", () => {
    expect(receiptOcrOutputSchema.safeParse(goldenReceipt).success).toBe(true);
  });

  it("defaults a missing entity list instead of failing (human Apply gate is the backstop)", () => {
    const { extractedEntities: _e, documentSubtype: _d, ...core } = goldenReceipt;
    const result = receiptOcrOutputSchema.safeParse(core);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extractedEntities).toEqual([]);
      expect(result.data.documentSubtype).toBe("other");
    }
  });

  it("degrades an invalid accountType to 'other' instead of failing the parse", () => {
    const result = receiptOcrOutputSchema.safeParse({
      ...goldenReceipt,
      extractedEntities: [{ ...goldenReceipt.extractedEntities[0], accountType: "cheque account" }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.extractedEntities[0].accountType).toBe("other");
    }
  });
});

describe("statementOcrOutputSchema", () => {
  const goldenStatement = {
    classification: {
      isStatement: true,
      documentType: "bank_statement",
      confidence: 98,
    },
    metadata: {
      institutionName: "Mercury",
      accountHolderName: "Acme LLC",
      accountType: "checking",
      accountNumberLast4: "4521",
      statementPeriodStart: "2026-01-01",
      statementPeriodEnd: "2026-01-31",
      beginningBalance: 10250.0,
      endingBalance: 9800.5,
      totalDeposits: 5000,
      totalWithdrawals: 5449.5,
      currency: "USD",
    },
    transactions: [
      {
        date: "2026-01-05",
        description: "ACH DEPOSIT CUSTOMER PAYMENT",
        amount: 2500,
        runningBalance: 12750,
      },
      { date: "2026-01-07", description: "CHECK 1042", amount: -1200.25, checkNumber: "1042" },
    ],
    totalPages: 3,
  };

  it("accepts a golden response", () => {
    expect(statementOcrOutputSchema.safeParse(goldenStatement).success).toBe(true);
  });

  it("rejects a transaction row with a malformed date (rows become ledger data)", () => {
    const bad = {
      ...goldenStatement,
      transactions: [{ date: "01/05", description: "X", amount: 5 }],
    };
    expect(statementOcrOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a non-finite amount (JSON.parse('1e999') → Infinity)", () => {
    const bad = {
      ...goldenStatement,
      transactions: [{ date: "2026-01-05", description: "X", amount: Number.POSITIVE_INFINITY }],
    };
    expect(statementOcrOutputSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects missing period dates", () => {
    const { statementPeriodStart: _s, ...metadata } = goldenStatement.metadata;
    expect(statementOcrOutputSchema.safeParse({ ...goldenStatement, metadata }).success).toBe(
      false,
    );
  });
});

describe("billOcrOutputSchema", () => {
  const goldenBill = {
    vendor: { name: "AWS", email: "billing@aws.com" },
    invoice: {
      invoiceNumber: "INV-1047",
      invoiceDate: "2026-02-01",
      dueDate: "2026-03-03",
      amount: 340.12,
      notes: "Cloud hosting for January",
    },
    lineItems: [
      { description: "EC2 usage", amount: 290.12, suggestedCategoryNumber: "50200" },
      { description: "S3 storage", amount: 50.0 },
    ],
    classification: {
      overallCategoryNumber: "50200",
      overallCategoryName: "Hosting Fees",
      confidence: 0.93,
      isUncategorized: false,
    },
    recurring: { isRecurring: true, frequency: "monthly", reasoning: "Monthly billing period" },
    confidence: 0.94,
  };

  it("accepts a golden response", () => {
    expect(billOcrOutputSchema.safeParse(goldenBill).success).toBe(true);
  });

  it("degrades junk enum-ish fields instead of failing the parse", () => {
    const result = billOcrOutputSchema.safeParse({
      ...goldenBill,
      classification: { ...goldenBill.classification, uncategorizedType: "expense account" },
      recurring: { isRecurring: true, frequency: "bi-monthly" },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.classification.uncategorizedType).toBeUndefined();
      expect(result.data.recurring.frequency).toBeUndefined();
    }
  });

  it("rejects a missing invoice amount", () => {
    const { amount: _a, ...invoice } = goldenBill.invoice;
    expect(billOcrOutputSchema.safeParse({ ...goldenBill, invoice }).success).toBe(false);
  });

  it("rejects a missing vendor name", () => {
    expect(billOcrOutputSchema.safeParse({ ...goldenBill, vendor: {} }).success).toBe(false);
  });
});

describe("boundingBoxesOutputSchema", () => {
  it("accepts a golden array and defaults a missing page to 0", () => {
    const result = boundingBoxesOutputSchema.safeParse([
      {
        fieldId: "vendor_name",
        label: "Vendor",
        text: "AWS",
        bbox: [10, 20, 60, 400],
        page: 0,
      },
      { fieldId: "total_amount", label: "Total", text: "$340.12", bbox: [800, 600, 840, 900] },
    ]);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data[1].page).toBe(0);
    }
  });

  it("rejects a bbox that is not exactly 4 numbers", () => {
    expect(
      boundingBoxesOutputSchema.safeParse([{ fieldId: "x", label: "X", bbox: [1, 2, 3], page: 0 }])
        .success,
    ).toBe(false);
  });
});
