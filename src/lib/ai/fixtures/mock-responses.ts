// ============================================================================
// Canned JSON for AI_MODE=mock.
//
// Every AiTaskName has a payload that passes that task's Zod schema. Bodies
// that match an eval corpus shape are copied from
// tests/evals/fixtures/recorded.ts; tasks with no recorded case get a minimal
// valid object. Keep this file in src/ — the mock runtime is a serving path,
// not a test helper, and must not import from tests/.
//
// Jev answers the tasks it serves (JEV_TASKS) from its own bodies, copied
// from the Jev cases in the recorded corpus, so a mock run shows which hop
// answered. Every other provider label gets the shared bodies.
//
// categorize_lines and match_party are answered against a CLOSED list built
// per request, so a canned body can only be valid for every request if it
// picks the one value always in the enum: "none" and "new". Mock mode
// therefore never categorizes a line or links a party — the item lands in
// "Needs you", which is the deterministic outcome E2E runs want.
// ============================================================================

import type { AiProvider } from "../errors";
import type { AiTaskName } from "../types";

const TRANSACTION_PARSE_BODY = {
  transactionType: "pay_out",
  date: "2026-01-14",
  memo: "Office supplies from Staples",
  partyId: "party-1",
  partyName: "Staples",
  referenceNumber: "",
  categoryId: "acct-1",
  categoryName: "Office Supplies",
  amount: "42.50",
  lines: [
    {
      description: "Office supplies",
      categoryId: "acct-1",
      categoryName: "Office Supplies",
      amount: "42.50",
      debit: "",
      credit: "",
    },
  ],
  confidence: 0.93,
  interpretation: "Pay Out $42.50 at Staples",
} as const;

const MOCK_RESPONSE_BODIES = {
  date_parse: {
    type: "single",
    start_date: "2026-01-14",
    interpretation: "yesterday",
    confidence: 0.98,
  },
  transaction_parse: TRANSACTION_PARSE_BODY,
  // txn_prefill reuses the transaction-parse output schema.
  txn_prefill: TRANSACTION_PARSE_BODY,
  receipt_ocr: {
    ...TRANSACTION_PARSE_BODY,
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
  },
  bill_ocr: {
    vendor: { name: "ACME GmbH" },
    invoice: { invoiceNumber: "DE-9912", invoiceDate: "2026-02-01", amount: 1234.56 },
    lineItems: [{ description: "Consulting", amount: 1234.56 }],
    classification: { confidence: 0.9, isUncategorized: true, uncategorizedType: "expense" },
    recurring: { isRecurring: false },
    confidence: 0.91,
  },
  statement_ocr: {
    classification: { isStatement: true, documentType: "bank_statement", confidence: 97 },
    metadata: {
      institutionName: "Mercury",
      accountHolderName: "Acme LLC",
      accountType: "checking",
      accountNumberLast4: "4521",
      statementPeriodStart: "2026-01-01",
      statementPeriodEnd: "2026-01-31",
      beginningBalance: 10250,
      endingBalance: 11549.75,
      currency: "USD",
    },
    transactions: [
      { date: "2026-01-05", description: "ACH DEPOSIT", amount: 2500 },
      { date: "2026-01-07", description: "CHECK 1042", amount: -1200.25, checkNumber: "1042" },
    ],
    totalPages: 2,
  },
  bbox_scan: [
    {
      fieldId: "vendor_name",
      label: "Vendor",
      text: "AWS",
      bbox: [10, 20, 60, 400],
      page: 0,
    },
    {
      fieldId: "total_amount",
      label: "Total",
      text: "$340.12",
      bbox: [800, 600, 840, 900],
      page: 0,
    },
  ],
  form_2307_ocr: {
    payorTin: "123-456-789-000",
    payorRegisteredName: "ACME CORPORATION",
    payorAddress: "12 Ayala Ave, Makati",
    payeeTin: "999-888-777-000",
    payeeRegisteredName: "BUWIZ SOLUTIONS INC",
    certificateNumber: "2307-0001",
    periodFrom: "2026-04-01",
    periodTo: "2026-06-30",
    lines: [
      {
        atc: "WC010",
        incomePaymentDescription: "Professional fees",
        monthlyAmounts: ["30000.00", "35000.00", "35000.00"],
        totalIncomePayment: "100000.00",
        taxWithheld: "10000.00",
      },
    ],
    totalTaxWithheld: "10000.00",
    confidence: 0.94,
    legibilityNotes: "",
  },
  classify_document: {
    documentType: "invoice",
    confidence: 0.94,
    reasoning: "INVOICE header and amount due",
  },
  email_extraction: {
    economicEventClass: "purchase",
    direction: "outflow",
    amount: "42.50",
    currency: "USD",
    date: "2026-01-14",
    party: "Staples",
    reference: "R-1001",
    description: "Office supplies",
    partyEmail: "",
    partyTaxId: "",
    payeeBankAccountNumber: "",
    payeeBankRoutingNumber: "",
  },
  ingest_triage: {
    docKind: "statement",
    confidence: 0.97,
    reasoning: "CSV bank-export layout with Date, Description, Amount columns",
  },
  match_assist: {
    decisions: [
      {
        statementLineId: "line-1",
        decision: "none",
        journalLineIds: [],
        confidence: 0.2,
        reason: "amounts differ",
      },
    ],
  },
  reflection: {
    lessons: [
      {
        text: "Invoices from ACME GmbH are billed in EUR.",
        sourceFeedbackIds: ["fb-1"],
      },
    ],
  },
  coa_draft: {
    accounts: [
      {
        key: "D1",
        name: "Green Coffee Purchases",
        accountType: "cost_of_revenue",
        subtype: "cost_of_goods",
        parentKey: "",
        parentDraftKey: "D0",
        description: "Unroasted beans bought by the sack",
      },
      {
        key: "D0",
        name: "Roastery Costs",
        accountType: "cost_of_revenue",
        subtype: "cost_of_goods",
        parentKey: "E0",
        parentDraftKey: "",
        description: "Direct costs of roasting",
      },
      {
        key: "D2",
        name: "Wholesale Revenue",
        accountType: "revenue",
        subtype: "sales_revenue",
        parentKey: "E2",
        parentDraftKey: "",
        description: "Sales to cafes",
      },
      {
        key: "D3",
        name: "Web Shop Revenue",
        accountType: "revenue",
        subtype: "sales_revenue",
        parentKey: "E2",
        parentDraftKey: "",
        description: "Direct-to-consumer sales",
      },
    ],
    summary: "Split roasting costs from operating expenses and separated the two revenue lines.",
  },
  category_mapping_suggest: {
    assignments: [
      {
        mappingType: "bill",
        sourceKey: "default_expense",
        targetKey: "E5",
        reason: "Uncategorized Expenses is the catch-all operating expense account",
      },
      {
        mappingType: "invoice",
        sourceKey: "default_revenue",
        targetKey: "E3",
        reason: "Sales Revenue is the only revenue account",
      },
    ],
    summary: "Pointed both defaults at the existing catch-all accounts.",
  },
  categorize_lines: {
    lines: [
      {
        lineIndex: 0,
        accountCode: "none",
        confidence: 0,
        reason: "Mock mode never picks an account.",
        suggestedNewCategory: "",
      },
    ],
  },
  match_party: {
    choice: "new",
    confidence: 0,
    reason: "Mock mode never links a party.",
  },
} as const satisfies Record<AiTaskName, unknown>;

export const MOCK_RESPONSES: Record<AiTaskName, string> = {
  date_parse: JSON.stringify(MOCK_RESPONSE_BODIES.date_parse),
  transaction_parse: JSON.stringify(MOCK_RESPONSE_BODIES.transaction_parse),
  receipt_ocr: JSON.stringify(MOCK_RESPONSE_BODIES.receipt_ocr),
  bill_ocr: JSON.stringify(MOCK_RESPONSE_BODIES.bill_ocr),
  statement_ocr: JSON.stringify(MOCK_RESPONSE_BODIES.statement_ocr),
  bbox_scan: JSON.stringify(MOCK_RESPONSE_BODIES.bbox_scan),
  form_2307_ocr: JSON.stringify(MOCK_RESPONSE_BODIES.form_2307_ocr),
  classify_document: JSON.stringify(MOCK_RESPONSE_BODIES.classify_document),
  email_extraction: JSON.stringify(MOCK_RESPONSE_BODIES.email_extraction),
  ingest_triage: JSON.stringify(MOCK_RESPONSE_BODIES.ingest_triage),
  match_assist: JSON.stringify(MOCK_RESPONSE_BODIES.match_assist),
  txn_prefill: JSON.stringify(MOCK_RESPONSE_BODIES.txn_prefill),
  reflection: JSON.stringify(MOCK_RESPONSE_BODIES.reflection),
  coa_draft: JSON.stringify(MOCK_RESPONSE_BODIES.coa_draft),
  category_mapping_suggest: JSON.stringify(MOCK_RESPONSE_BODIES.category_mapping_suggest),
  categorize_lines: JSON.stringify(MOCK_RESPONSE_BODIES.categorize_lines),
  match_party: JSON.stringify(MOCK_RESPONSE_BODIES.match_party),
};

/** Confidence stays on the pinned 0..1 scale, as every Jev schema requires. */
const JEV_MOCK_RESPONSE_BODIES = {
  ingest_triage: {
    docKind: "bill",
    confidence: 0.93,
    reasoning: "Filename carries a vendor bill number",
  },
  classify_document: {
    documentType: "invoice",
    confidence: 0.95,
    reasoning: "INVOICE header with invoice number and amount due",
  },
  categorize_lines: {
    lines: [
      {
        lineIndex: 0,
        accountCode: "none",
        confidence: 0.9,
        reason: "No listed account covers green coffee beans",
        suggestedNewCategory: "Green Coffee Purchases",
      },
    ],
  },
  match_party: {
    choice: "new",
    confidence: 0.88,
    reason: "Blue Bottle Roasters is a different business from Blue Ridge Supply",
  },
} as const;

export const JEV_MOCK_RESPONSES: Partial<Record<AiTaskName, string>> = {
  ingest_triage: JSON.stringify(JEV_MOCK_RESPONSE_BODIES.ingest_triage),
  classify_document: JSON.stringify(JEV_MOCK_RESPONSE_BODIES.classify_document),
  categorize_lines: JSON.stringify(JEV_MOCK_RESPONSE_BODIES.categorize_lines),
  match_party: JSON.stringify(JEV_MOCK_RESPONSE_BODIES.match_party),
};

export function getMockResponseText(task: AiTaskName, provider?: AiProvider): string {
  const text = (provider === "jev" ? JEV_MOCK_RESPONSES[task] : undefined) ?? MOCK_RESPONSES[task];
  if (!text) {
    throw new Error(`No mock fixture for AI task "${task}"`);
  }
  return text;
}
