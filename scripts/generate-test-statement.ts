/**
 * Test Bank Statement PDF Generator
 *
 * Generates a Mercury-style bank statement PDF from real ledger transactions,
 * plus X extra random transactions that won't match any ledger entries.
 *
 * Usage:
 *   bun scripts/generate-test-statement.ts                     # defaults: 5 extra txns
 *   bun scripts/generate-test-statement.ts --extra 10           # 10 extra unmatched txns
 *   bun scripts/generate-test-statement.ts --account "Mercury"  # filter by account name
 *   bun scripts/generate-test-statement.ts --month 2026-01      # target month (YYYY-MM)
 *   bun scripts/generate-test-statement.ts --out test.pdf       # custom output filename
 *
 * The generated PDF is written to the project root (or --out path).
 * Upload it via the Reconciliation page to test OCR + matching.
 */
import fs from "fs";
import path from "path";

// Manually load .env if not present
if (!process.env.DATABASE_URL) {
  try {
    const envPath = path.resolve(process.cwd(), ".env");
    if (fs.existsSync(envPath)) {
      const envConfig = fs.readFileSync(envPath, "utf8");
      envConfig.split("\n").forEach((line) => {
        const [key, ...values] = line.split("=");
        if (key && values.length > 0 && !key.startsWith("#")) {
          const val = values
            .join("=")
            .trim()
            .replace(/^['"](.*)['"]\$/, "$1");
          if (val) process.env[key.trim()] = val;
        }
      });
      console.log("✅ Loaded .env");
    }
  } catch (e) {
    console.warn("⚠️  Failed to load .env:", e);
  }
}

// ============================================================================
// CLI argument parsing
// ============================================================================

function getArg(flag: string, fallback: string): string {
  const idx = process.argv.indexOf(flag);
  if (idx !== -1 && process.argv[idx + 1]) return process.argv[idx + 1];
  return fallback;
}

const EXTRA_COUNT = Number.parseInt(getArg("--extra", "5"), 10);
const ACCOUNT_FILTER = getArg("--account", "Mercury");
const TARGET_MONTH = getArg("--month", "2026-01"); // YYYY-MM
const OUTPUT_FILE = getArg("--out", `test-statement-${TARGET_MONTH}.pdf`);

// ============================================================================
// Fake transactions that will NOT match any ledger entries
// ============================================================================

const FAKE_VENDORS = [
  { name: "CloudSync Pro", detail: "Monthly SaaS subscription" },
  { name: "NeonByte Solutions", detail: "API gateway charges" },
  { name: "DataVault Storage", detail: "Backup storage — quarterly" },
  { name: "Pixel & Frame Studio", detail: "Brand design retainer" },
  { name: "GreenLeaf Catering", detail: "Team lunch — all hands" },
  { name: "Quantum Analytics", detail: "Data pipeline license" },
  { name: "Atlas Global Freight", detail: "Inbound shipping — hardware" },
  { name: "ClearView Security", detail: "SOC 2 compliance audit" },
  { name: "Summit Talent Partners", detail: "Recruiting fee — eng hire" },
  { name: "BlueRibbon IT Services", detail: "Firewall maintenance" },
  { name: "Zenith Office Supplies", detail: "Q1 office supplies order" },
  { name: "Beacon Legal Group", detail: "Legal review — vendor contract" },
  { name: "TrueNorth Consulting", detail: "Strategy consulting retainer" },
  { name: "Evergreen Utilities", detail: "Electric bill — HQ" },
  { name: "Meridian Insurance Co.", detail: "Liability insurance premium" },
];

function generateFakeTransactions(
  count: number,
  periodStart: string,
  periodEnd: string,
): Array<{ date: string; description: string; detail: string; amount: number }> {
  const start = new Date(`${periodStart}T00:00:00`);
  const end = new Date(`${periodEnd}T00:00:00`);
  const range = end.getTime() - start.getTime();
  const results: Array<{ date: string; description: string; detail: string; amount: number }> = [];

  for (let i = 0; i < count; i++) {
    const vendor = FAKE_VENDORS[i % FAKE_VENDORS.length];
    // Random date within the period
    const d = new Date(start.getTime() + Math.random() * range);
    const dateStr = d.toISOString().slice(0, 10);

    // Random amount: mix of deposits and withdrawals
    // 70% withdrawals, 30% deposits to mimic realistic patterns
    const isDeposit = Math.random() < 0.3;
    const base = isDeposit
      ? 1000 + Math.random() * 20000 // deposits: $1k–$21k
      : -(100 + Math.random() * 5000); // withdrawals: $100–$5,100

    const amount = Math.round(base * 100) / 100;

    results.push({
      date: dateStr,
      description: vendor.name,
      detail: vendor.detail,
      amount,
    });
  }

  // Sort by date
  results.sort((a, b) => a.date.localeCompare(b.date));
  return results;
}

// ============================================================================
// Main
// ============================================================================

async function main() {
  const { db } = await import("../src/db");
  const { effectiveJournalPredicate, journalHeaders, journalLines } =
    await import("../src/db/schema/journals");
  const { accounts } = await import("../src/db/schema/accounts");
  const { parties } = await import("../src/db/schema/parties");
  const { eq, and, gte, lte, sql, ilike } = await import("drizzle-orm");

  // 1. Find the bank account
  console.log(`🔍 Looking for account matching "${ACCOUNT_FILTER}"...`);

  const bankAccounts = await db
    .select({ id: accounts.id, name: accounts.name, accountNumber: accounts.accountNumber })
    .from(accounts)
    .where(ilike(accounts.name, `%${ACCOUNT_FILTER}%`))
    .limit(5);

  if (bankAccounts.length === 0) {
    console.error(`❌ No accounts found matching "${ACCOUNT_FILTER}"`);
    process.exit(1);
  }

  const bankAccount = bankAccounts[0];
  console.log(`📌 Using account: ${bankAccount.name} (${bankAccount.id})`);

  // 2. Query ledger transactions for this account in the target month
  const [year, month] = TARGET_MONTH.split("-").map(Number);
  const periodStart = `${TARGET_MONTH}-01`;
  const lastDay = new Date(year, month, 0).getDate();
  const periodEnd = `${TARGET_MONTH}-${String(lastDay).padStart(2, "0")}`;

  // Also include a few days before/after for statement overlap
  const queryStart = periodStart;
  const queryEnd = periodEnd;

  console.log(`📅 Period: ${periodStart} → ${periodEnd}`);

  const ledgerTxns = await db
    .select({
      id: journalLines.id,
      date: journalHeaders.transactionDate,
      description: sql<string>`COALESCE(${journalLines.lineDescription}, ${journalHeaders.memo}, 'Transaction')`,
      debit: journalLines.debit,
      credit: journalLines.credit,
      partyName: parties.name,
      memo: journalHeaders.memo,
      transactionType: journalHeaders.transactionType,
    })
    .from(journalLines)
    .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
    .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
    .where(
      and(
        eq(journalLines.accountId, bankAccount.id),
        gte(journalHeaders.transactionDate, queryStart),
        lte(journalHeaders.transactionDate, queryEnd),
        eq(journalHeaders.status, "posted"),
        effectiveJournalPredicate(),
      ),
    )
    .orderBy(journalHeaders.transactionDate);

  console.log(`📊 Found ${ledgerTxns.length} ledger transactions`);

  if (ledgerTxns.length === 0) {
    console.warn("⚠️  No transactions found. The PDF will only contain fake entries.");
  }

  // 3. Convert ledger rows to statement format
  // For a bank account: debit = money IN (deposit), credit = money OUT (withdrawal)
  const realTransactions = ledgerTxns.map((txn) => {
    const debit = Number.parseFloat(txn.debit || "0");
    const credit = Number.parseFloat(txn.credit || "0");
    // Bank account perspective: debit increases balance, credit decreases
    const amount = debit > 0 ? debit : -credit;

    const desc = txn.partyName || txn.description || txn.memo || "Transaction";
    const detail =
      txn.partyName && txn.description && txn.description !== txn.partyName
        ? txn.description
        : txn.memo || undefined;

    return {
      date: txn.date,
      description: desc,
      detail: detail || `${txn.transactionType} — ${desc}`,
      amount,
    };
  });

  // 4. Generate fake unmatched transactions
  console.log(`🎲 Adding ${EXTRA_COUNT} extra unmatched transactions`);
  const fakeTransactions = generateFakeTransactions(EXTRA_COUNT, periodStart, periodEnd);

  // 5. Merge and sort all transactions
  const allTransactions = [...realTransactions, ...fakeTransactions].sort((a, b) =>
    a.date.localeCompare(b.date),
  );

  // 6. Compute running balances
  let runningBalance = 0; // Opening balance
  const statementTransactions = allTransactions.map((txn) => {
    runningBalance += txn.amount;
    return {
      date: txn.date,
      description: txn.description,
      detail: txn.detail,
      amount: txn.amount,
      runningBalance,
    };
  });

  const closingBalance = runningBalance;

  // 7. Generate the PDF using the existing library
  const { generateBankStatementPDF } = await import("../src/lib/generate-bank-statement-pdf");

  const result = generateBankStatementPDF({
    bankName: "Mercury",
    accountName: bankAccount.name,
    accountNumber: bankAccount.accountNumber || "1231",
    accountType: "Checking",
    entityName: "Miley Quinn Book LLC",
    periodStart,
    periodEnd,
    openingBalance: 0,
    closingBalance,
    transactions: statementTransactions,
  });

  // 8. Write PDF to disk
  const outputPath = path.resolve(process.cwd(), OUTPUT_FILE);
  const arrayBuffer = await result.blob.arrayBuffer();
  fs.writeFileSync(outputPath, Buffer.from(arrayBuffer));

  console.log(`\n✅ PDF generated: ${outputPath}`);
  console.log(`   📄 ${allTransactions.length} total transactions`);
  console.log(`   ✅ ${realTransactions.length} real (from ledger)`);
  console.log(`   ❌ ${fakeTransactions.length} fake (won't match)`);
  console.log(`   💰 Closing balance: $${closingBalance.toFixed(2)}`);
  console.log(`\n🎯 Upload this file on the Reconciliation page to test!`);

  // Print the fake transactions so you know which ones to expect as unmatched
  if (fakeTransactions.length > 0) {
    console.log("\n📋 Fake transactions (will NOT match):");
    console.table(
      fakeTransactions.map((t) => ({
        Date: t.date,
        Vendor: t.description,
        Amount: `$${t.amount.toFixed(2)}`,
      })),
    );
  }

  process.exit(0);
}

main().catch((err) => {
  console.error("❌ Error:", err);
  process.exit(1);
});
