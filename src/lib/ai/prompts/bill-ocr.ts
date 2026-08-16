// ============================================================================
// Prompts: bill_ocr + bbox_scan — bill extraction and field bounding boxes.
// Moved VERBATIM from src/routes/api/-ai-bill-ocr.ts (version 1.0.0 is
// byte-identical to the pre-registry prompts). Documents arrive as inline
// media parts.
// ============================================================================

export interface BillOcrPromptInput {
  currentDate?: string;
  categories?: {
    accountNumber: string;
    name: string;
    type: string;
    subtype?: string;
    parentName?: string;
  }[];
}

export const billOcrPrompt = {
  id: "bill-ocr",
  version: "1.0.0",
  build(input: BillOcrPromptInput): string {
    const dateStr = input.currentDate || new Date().toISOString().split("T")[0];
    let categoryBlock = "";
    if (input.categories && input.categories.length > 0) {
      const lines = input.categories.map((c) => {
        const parent = c.parentName ? ` (under ${c.parentName})` : "";
        return `  ${c.accountNumber} — ${c.name} [${c.type}]${parent}`;
      });
      categoryBlock = `
## Chart of Accounts (for category classification)
The following accounts are available. Match each line item to the most specific account:
${lines.join("\n")}

If no account matches well, set classification.isUncategorized = true and uncategorizedType to "expense" (most bills), "liability", or "asset".`;
    } else {
      categoryBlock = `
## Category Classification
No chart of accounts was provided. Set classification.isUncategorized = true and uncategorizedType = "expense".`;
    }

    return `You are an expert document parser specializing in invoices, bills, and receipts.

## Current Date
Today's date is: ${dateStr}. Use this to resolve relative payment terms (e.g. "Net 30" means due date = invoice date + 30 days, "Due upon receipt" means due date = today).

## Extraction Rules
- Extract the vendor/seller (the "From" party) and recipient/buyer (the "To" party) information
- Look for invoice/transaction/bill number references
- Parse all dates into YYYY-MM-DD format
- Extract every line item with description, quantity, unit price, and total amount
- Capture the total invoice amount
- Extract any notes, memos, or descriptions from the document body
- Look for contact information: email addresses, phone numbers, websites, mailing addresses
- The vendor's mailing address is important for check payments
- **Country detection**: Always extract the vendor's country. If the country is not explicitly stated on the document, infer it from contextual clues such as:
  - Currency symbol or ISO code (e.g. $ with US-style formatting → US, £ → GB, € → EU member, ¥ → JP or CN based on language)
  - Phone number format or country code (e.g. +1 → US/CA, +44 → GB, +61 → AU, +63 → PH)
  - Address format, state abbreviations, postal code patterns (e.g. 5-digit zip → US, alphanumeric like "A1A 1A1" → CA, "SW1A 1AA" → GB)
  - Language of the document (e.g. Japanese → JP, Korean → KR)
  - Tax ID formats (EIN → US, ABN → AU, GST → IN/AU/NZ, VAT → EU)
  Use ISO 3166-1 alpha-2 codes (US, GB, CA, AU, PH, JP, etc.) for the country field. Default to "US" only if all signals are ambiguous.
- Extract tax IDs, EIN/TIN numbers if visible on the document
- Look for payment instructions: bank routing/account numbers, payment terms
- Set confidence based on document clarity and how much data you could extract
${categoryBlock}

## Classification Hints
When classifying expenses, pay attention to these common patterns:
- Cloud hosting services (AWS, GCP, Azure, DigitalOcean, Vercel, Netlify, Heroku) → Hosting Fees (Cost of Revenue), NOT Business Applications & Software
- Payment processing (Stripe, PayPal, Square, Adyen) → Payment Processing Fees (Cost of Revenue)
- SaaS tools used by the team (Slack, Asana, Notion, Figma) → Business Applications & Software (Operating Expense)
- Domain names, SSL certificates, CDN → Hosting Fees (Cost of Revenue)
- Legal, accounting, consulting → Professional Fees (Operating Expense)
- Office rent, coworking → Facilities (Operating Expense)
- Internet, phone, electricity → General Operations (Operating Expense)

## Recurring Bill Detection
Look for patterns that suggest this is a recurring bill:
- Words like "monthly", "annual", "subscription", "recurring", "billing period"
- Consistent service periods (e.g. "Jan 1 - Jan 31")
- Utility bills, rent, SaaS subscriptions, insurance premiums
- If detected, set recurring.isRecurring = true and estimate the frequency
- Provide a brief reasoning for your determination`;
  },
};

export interface BboxScanPromptInput {
  /** 0-indexed page for multi-page scans; omit for single-document scans. */
  page?: number;
}

export const bboxScanPrompt = {
  id: "bbox-scan",
  version: "1.0.0",
  build(input: BboxScanPromptInput): string {
    const pageContext =
      input.page != null
        ? `\n\n**IMPORTANT:** You are analyzing page ${input.page + 1} of a multi-page document. All bounding boxes you return MUST have "page": ${input.page}.\n`
        : "";

    return `You are analyzing a financial document image (bill, invoice, bank statement, or similar). Extract **granular** bounding boxes for every identifiable field.${pageContext}

## Output Format
Return a JSON array of objects. Each object has:
- "fieldId" (string) — unique identifier (see field list below)
- "label" (string) — short human-readable label for the field
- "text" (string) — the **actual text content** visible in that region of the document (this is critical — it will be copied to clipboard)
- "bbox" (array of 4 numbers) — [ymin, xmin, ymax, xmax] normalized 0–1000 relative to page dimensions
- "page" (number) — 0-indexed page number

## Fields to Detect

### Header / Document Info (use these exact fieldIds):
- "vendor_name" — The vendor/seller/bank name. text = the company or institution name.
- "invoice_number" — Invoice/bill/reference number. text = the number.
- "invoice_date" — Invoice/statement date or issue date. text = the date string.
- "due_date" — Payment due date (bills/invoices). text = the date string.
- "total_amount" — Total amount due or ending balance. text = the amount with currency symbol.

### Vendor / Institution Details (split into separate boxes):
- "vendor_email" — Vendor email address. text = the email.
- "vendor_address" — Vendor street address. text = full address on one line.
- "vendor_country" — Vendor country. text = the country name or code.

### Recipient / Bill-To / Account Holder (split into separate boxes):
- "recipient_name" — Recipient/account holder name. text = the name.
- "recipient_email" — Recipient email. text = the email.
- "recipient_address" — Recipient address. text = full address on one line.

### Bank Statement Fields (only if this is a bank statement):
- "account_number" — Bank account number. text = the full or masked account number.
- "account_holder" — Account holder name. text = the name.
- "statement_period" — Statement period dates. text = e.g. "01/01/2026 - 03/31/2026".
- "beginning_balance" — Opening/beginning balance. text = the amount with currency symbol.
- "ending_balance" — Closing/ending balance. text = the amount with currency symbol.
- "total_deposits" — Total deposits/credits. text = the amount.
- "total_withdrawals" — Total withdrawals/debits. text = the amount.
- "reference_number" — Reference or confirmation number. text = the number.

### Line Items (one box PER ROW, not one big box):
- "line_item_0" — First line item / transaction row. text = "Description, Qty X, Price $Y, Total $Z" or "Date Description Amount Balance" (combine row cells).
- "line_item_1" — Second row. Same format.
- "line_item_2", "line_item_3", etc. for additional rows.
- The bounding box should wrap the entire row from left to right edge of the table.

### Bookkeeping:
- "memo" — Notes/memo section. text = the full memo text. Box should span the full width of the text.
- "payment_terms" — Payment terms. text = the terms text.

## Rules
1. Only include fields you can **actually locate** on the document.
2. Each bounding box must tightly wrap its content — no excessive padding.
3. For line items, create a SEPARATE entry for EACH row. Do NOT create one big box around the table.
4. The "text" field must contain the ACTUAL text visible in that area, not a generic description.
5. Ensure bounding boxes span the full width of the text they contain (especially memo, addresses).
6. Coordinates are normalized 0–1000 where (0,0) is top-left and (1000,1000) is bottom-right.
7. For bank statements, detect ALL summary fields (beginning/ending balance, total deposits/withdrawals) AND every transaction row as a line_item.

Return ONLY a JSON array, no markdown fences.`;
  },
};
