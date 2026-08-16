// ============================================================================
// Prompt: receipt_ocr — receipt/invoice/payslip extraction.
// Moved VERBATIM from src/routes/api/-ai-receipt-ocr.ts (version 1.0.0 is
// byte-identical to the pre-registry prompt). The document arrives as inline
// media parts.
// ============================================================================

export interface ReceiptOcrPromptInput {
  currentDate: string;
  accounts: { id: string; name: string; accountNumber?: string | null; accountType: string }[];
  parties: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  locations: { id: string; name: string }[];
  preExtractedFields?: { fieldId: string; label: string; text: string }[];
}

export const receiptOcrPrompt = {
  id: "receipt-ocr",
  version: "1.0.0",
  build(input: ReceiptOcrPromptInput): string {
    const dateStr = input.currentDate || new Date().toISOString().split("T")[0];

    const accountsBlock =
      input.accounts.length > 0
        ? `## Available Accounts (Chart of Accounts)
Match line items to the most specific account. Return the account's "id" field for categoryId.
${input.accounts
  .map((a) => `  id="${a.id}" | ${a.accountNumber || "—"} | ${a.name} [${a.accountType}]`)
  .join("\n")}`
        : "No accounts provided. Leave categoryId as empty string.";

    const partiesBlock =
      input.parties.length > 0
        ? `## Known Parties (Vendors / Customers)
Match the vendor/merchant name to one of these. Return the party's "id" for partyId.
${input.parties.map((p) => `  id="${p.id}" | ${p.name}`).join("\n")}`
        : "No parties provided. Leave partyId as empty string.";

    const departmentsBlock =
      input.departments.length > 0
        ? `## Departments
${input.departments.map((d) => `  id="${d.id}" | ${d.name}`).join("\n")}`
        : "";

    const locationsBlock =
      input.locations.length > 0
        ? `## Locations
${input.locations.map((l) => `  id="${l.id}" | ${l.name}`).join("\n")}`
        : "";

    const preExtractedBlock =
      input.preExtractedFields && input.preExtractedFields.length > 0
        ? `## Pre-Extracted OCR Fields (already detected from this document)
Use these as hints to improve your extraction accuracy. Do NOT blindly copy — verify against the document image.
The "invoice_date" field should be used as the transaction date.
The "payment_terms" field often contains the payment method — extract it as a bank entity.
${input.preExtractedFields.map((f) => `- ${f.fieldId}: "${f.text}"`).join("\n")}`
        : "";

    return `You are an expert receipt and document parser for an accounting system.

## Current Date
Today's date is: ${dateStr}

## Your Task
Analyze the attached document (receipt, invoice, bill, payslip, or similar) and extract:
1. Structured transaction data
2. Entities mentioned in the document (banks, employees, vendors, customers, etc.)
3. Document subtype classification

## Transaction Type Classification
- **pay_out**: Most common. Any purchase, expense, bill payment, payroll, or outgoing payment.
- **pay_in**: Income received, refunds, customer payments.
- **journal**: Adjusting entries, depreciation, accruals (rare for receipts).
- **transfer**: Moving money between accounts (rare for receipts).

Most receipts represent a **pay_out** (expense/purchase).
Payslips are **pay_out** (payroll expense).

## Document Subtype
Classify the document:
- **receipt**: Purchase receipts, POS receipts
- **invoice**: Sales invoices, receivables
- **payslip**: Employee pay stubs, salary slips
- **bill**: Bills to pay, payables
- **statement**: Bank or account statements
- **other**: Anything else

## Entity Extraction
Identify all entities mentioned in the document:
- **Banks / Payment Methods**: ALWAYS extract the payment method as a bank entity when visible on the document.
  - Credit cards: "Visa ending 7744", "Mastercard ****1234", "Amex ending 9876" → entityType: "bank", accountType: "credit_card", identifier: the last 4 digits (e.g. "7744"), name: the card network (e.g. "Visa")
  - Debit cards: "Debit card ending 1234" → entityType: "bank", accountType: "checking", identifier: last 4 digits
  - Bank accounts: "Chase Checking ****4521", "Wells Fargo Savings" → entityType: "bank", accountType: "checking" or "savings"
  - Direct deposits: "Direct Deposit to Chase Bank ****4521" → entityType: "bank", accountType: "checking"
- **Employees**: On payslips, extract employee name and ID.
- **Vendors**: The seller/merchant on receipts and invoices.
- **Customers**: The buyer on invoices sent to them.
- **Government**: Tax agencies (IRS, state tax authorities).
Match entities against the known parties list below. If no match, leave matchedPartyId empty.

## Extraction Rules
- Extract the date from the document. Parse into YYYY-MM-DD format.
- Extract the total amount. Use the grand total / total due / amount paid.
  - For payslips: use the NET PAY amount.
- Identify the vendor/merchant/seller name.
- Look for receipt/invoice/transaction numbers.
- Extract line items with descriptions and amounts.
- Create a helpful memo summarizing the transaction (e.g. "Office supplies from Staples").
  - For payslips: "Salary payment to [Employee Name] for [Pay Period]"
- For each line item, match to the **most specific** (deepest child) account category available. NEVER fall back to a generic parent category like "Operating Expenses" — always pick the most granular account that fits.
- If multiple line items exist, create one line per distinct item/category.
- If only a total is visible with no breakdown, create a single line.
- Set confidence based on document clarity.

## Classification Hints
- Fast food, restaurants, cafes, coffee shops → Meals & Entertainment
- Gas stations, fuel, diesel, petrol → Automobile Expense or Vehicle Expense or Transportation (match the most specific available account)
- Uber, Lyft, taxis, ride-sharing → Ground Transportation
- Car wash, parking, tolls → Automobile Expense or Transportation
- Office supplies, tech accessories, stationery → Office Supplies or Business Supplies
- Cloud hosting (AWS, GCP, Azure) → Hosting Fees (Cost of Revenue)
- SaaS subscriptions, software licenses → Business Applications & Software
- Professional services, legal, consulting → Professional Fees
- Insurance premiums → Insurance Expense
- Utilities (electric, water, gas, internet) → Utilities Expense
- Payroll / salary → Salaries & Wages
- Payroll taxes → Payroll Tax Expense

${accountsBlock}

${partiesBlock}

${departmentsBlock}

${locationsBlock}

${preExtractedBlock}`;
  },
};
