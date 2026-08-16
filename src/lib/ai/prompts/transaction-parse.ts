// ============================================================================
// Prompt: transaction_parse — natural language → structured transaction.
// Moved VERBATIM from src/routes/api/-ai-transaction-parse.ts (version 1.0.0
// is byte-identical to the pre-registry prompt; bump the version on ANY text
// change so evals and ai_invocations can attribute behavior shifts).
// ============================================================================

export interface TransactionParsePromptInput {
  prompt: string;
  currentDate: string;
  accounts: { id: string; name: string; accountNumber?: string | null; accountType: string }[];
  parties: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export const transactionParsePrompt = {
  id: "transaction-parse",
  version: "1.0.0",
  build(input: TransactionParsePromptInput): string {
    const dayOfWeek = new Date(input.currentDate + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "long",
    });

    const accountsBlock =
      input.accounts.length > 0
        ? `## Available Accounts (Chart of Accounts)
Match line items to the most specific account. Return the account's "id" field for categoryId.
${input.accounts
  .map((a) => `  id="${a.id}" | ${a.accountNumber || "—"} | ${a.name} [${a.accountType}]`)
  .join("\n")}`
        : "No accounts provided.";

    const partiesBlock =
      input.parties.length > 0
        ? `## Available Parties (Entities)
Match any mentioned party name to the closest match. Return the party's "id" field for partyId.
${input.parties.map((p) => `  id="${p.id}" | ${p.name}`).join("\n")}`
        : "No parties provided.";

    const deptBlock =
      input.departments.length > 0
        ? `## Available Departments
${input.departments.map((d) => `  id="${d.id}" | ${d.name}`).join("\n")}`
        : "";

    const locBlock =
      input.locations.length > 0
        ? `## Available Locations
${input.locations.map((l) => `  id="${l.id}" | ${l.name}`).join("\n")}`
        : "";

    return `You are an AI accounting assistant that parses natural language descriptions into structured transaction data for a double-entry bookkeeping system.

## Current Date Context
Today is: ${dayOfWeek}, ${input.currentDate}
Use this to resolve any relative date references (e.g. "yesterday" = one day before today, "last Friday" = the most recent Friday before today, "January 5" = 2026-01-05).

## Transaction Type Rules
- **pay_out**: Money leaving the business. Keywords: paid, bought, purchased, expense, bill, cost, spent, payment to, pay for
- **pay_in**: Money entering the business. Keywords: received, earned, income, collected, got paid, payment from, revenue, sold
- **transfer**: Moving money between accounts. Keywords: transfer, move, shift, from...to...
- **journal**: Manual accounting adjustments. Keywords: adjust, depreciation, accrual, write-off, reclassify, record entry, debit...credit...

If the type is ambiguous, default to pay_out (most common for expense-like prompts).

## Amount Parsing
- Parse currency amounts: "$500", "500 dollars", "$1,200.50", "five hundred"
- Amounts should be returned as decimal strings: "500.00", "1200.50"

## Line Item Rules
- For **pay_out**: Create line items for each expense category. Each line has description, categoryId, amount.
- For **pay_in**: Create line items for each revenue source. Each line has description, categoryId, amount.
- For **journal**: Create balanced debit/credit lines. Each line has categoryId, debit OR credit.
- For **transfer**: Lines are usually empty — use the header-level amount and transferFrom/transferTo fields.

## Matching Rules
- Match parties, accounts, departments, and locations by fuzzy name matching against the provided lists.
- If a match is found, return the exact "id" from the list. If no match, return empty string for the ID field but still populate the name field.
- For category matching, prefer the most specific account (e.g. "Office Supplies" over "Operating Expenses").

${accountsBlock}

${partiesBlock}

${deptBlock}

${locBlock}

## User Prompt
"${input.prompt}"

Parse this into the required JSON format. Be thorough — extract every piece of information available.`;
  },
};
