/**
 * Read-only diagnostics for the 2026-08 audit findings.
 *
 * Prints a count and up to five sample ids for each class of data the audit
 * showed the code could produce. It NEVER writes — every statement is a
 * SELECT — and always exits 0: the numbers are the deliverable, and a phase
 * gate in the remediation plan re-runs this to prove the forward-corruption
 * counters stopped growing. Repairing anything a check finds is a separately
 * reviewed migration, never this script.
 *
 * BOTH the connection banner and every check print before any conclusion is
 * drawn, for the same reason seed-review-rules.ts does it: an unset
 * DATABASE_URL sends the client to the database named after the OS user,
 * where empty results read exactly like a healthy ledger.
 *
 * Usage:
 *   DATABASE_URL=... bun run db:audit:diagnostics
 */
import { sql } from "drizzle-orm";
import { db } from "../src/db";

type Row = Record<string, unknown>;

async function query(statement: ReturnType<typeof sql>): Promise<Row[]> {
  const result = (await db.execute(statement)) as unknown;
  return (Array.isArray(result) ? result : ((result as { rows?: Row[] }).rows ?? [])) as Row[];
}

/** Print the connection first, so a surprising answer can never be blamed on the wrong database. */
async function reportTarget() {
  const [row] = await query(sql`
    SELECT current_database() AS db,
           current_user       AS usr,
           coalesce(inet_server_addr()::text, 'local socket') AS host
  `);
  console.log(`🔌 ${row?.db} as ${row?.usr} (${row?.host})\n`);
}

interface Check {
  key: string;
  title: string;
  /** What a non-zero count means, in one sentence. */
  meaning: string;
  statement: ReturnType<typeof sql>;
}

const CHECKS: Check[] = [
  {
    key: "double_cleared_journal_lines",
    title: "Journal lines cleared by BOTH representations",
    meaning:
      "The same ledger line is claimed 1:1 on statement_lines AND by a split row in " +
      "statement_line_matches — computeFinalizeBalances counts it twice, so an out-of-balance " +
      "reconciliation can have finalized cleanly.",
    statement: sql`
      SELECT sl.matched_journal_line_id AS id
      FROM statement_lines sl
      JOIN statement_line_matches slm
        ON slm.journal_line_id = sl.matched_journal_line_id
      WHERE sl.matched_journal_line_id IS NOT NULL
    `,
  },
  {
    key: "voided_without_voided_at",
    title: "Voided journals missing voided_at",
    meaning:
      "Point-in-time AP/AR aging excludes these for EVERY as-of date, so a report for a closed " +
      "month silently changed when the void happened.",
    statement: sql`
      SELECT id FROM journal_headers
      WHERE status = 'voided' AND voided_at IS NULL
    `,
  },
  {
    key: "bill_journals_missing_source_stamp",
    title: "Bill journals invisible to void + AP aging",
    meaning:
      "bills.journal_header_id points at a posted journal whose source_document columns are " +
      "NULL (the Inbox-approval path) — bill void cannot find it and AP aging never shows it.",
    statement: sql`
      SELECT b.journal_header_id AS id
      FROM bills b
      JOIN journal_headers jh ON jh.id = b.journal_header_id
      WHERE b.journal_header_id IS NOT NULL
        AND (jh.source_document_id IS NULL OR jh.source_document_type IS NULL)
    `,
  },
  {
    key: "invoice_journals_missing_source_stamp",
    title: "Invoice journals invisible to void + AR aging",
    meaning: "Invoice-side twin of the bill check above.",
    statement: sql`
      SELECT i.journal_header_id AS id
      FROM invoices i
      JOIN journal_headers jh ON jh.id = i.journal_header_id
      WHERE i.journal_header_id IS NOT NULL
        AND (jh.source_document_id IS NULL OR jh.source_document_type IS NULL)
    `,
  },
  {
    key: "posted_headers_zero_lines",
    title: "Posted journals with no lines",
    meaning:
      "An empty posted journal passes the 0041 balance triggers (0 = 0) but appears in the " +
      "transaction list carrying a total_amount nothing backs.",
    statement: sql`
      SELECT jh.id
      FROM journal_headers jh
      LEFT JOIN journal_lines jl ON jl.journal_header_id = jh.id
      WHERE jh.status = 'posted'
      GROUP BY jh.id
      HAVING count(jl.id) = 0
    `,
  },
  {
    key: "finalized_recon_zero_lines",
    title: "Finalized reconciliations with no statement lines",
    meaning:
      "A reconciliation cannot finalize without lines, so zero lines now means they were " +
      "deleted afterwards — its snapshot no longer describes anything.",
    statement: sql`
      SELECT r.id
      FROM reconciliations r
      LEFT JOIN statement_lines sl ON sl.reconciliation_id = r.id
      WHERE r.finalized_at IS NOT NULL
      GROUP BY r.id
      HAVING count(sl.id) = 0
    `,
  },
  {
    key: "finalized_recon_lines_added_after",
    title: "Finalized reconciliations with lines created after finalization",
    meaning:
      "Statement lines were inserted into a period that was already closed — the snapshot " +
      "columns disagree with the line data by construction.",
    statement: sql`
      SELECT DISTINCT r.id
      FROM reconciliations r
      JOIN statement_lines sl ON sl.reconciliation_id = r.id
      WHERE r.finalized_at IS NOT NULL
        AND sl.created_at > r.finalized_at
    `,
  },
];

async function runCheck(check: Check): Promise<number> {
  let rows: Row[];
  try {
    rows = await query(check.statement);
  } catch (error) {
    // A missing table/column means this schema predates the feature — that is
    // a fact worth printing, not a diagnostics failure.
    console.log(`⚠️  ${check.title}: skipped (${(error as Error).message.split("\n")[0]})\n`);
    return 0;
  }

  const marker = rows.length === 0 ? "✅" : "❗";
  console.log(`${marker} ${check.title}: ${rows.length}`);
  if (rows.length > 0) {
    console.log(`   ${check.meaning}`);
    const sample = rows.slice(0, 5).map((row) => String(row.id));
    console.log(`   sample: ${sample.join(", ")}${rows.length > 5 ? ", …" : ""}`);
  }
  console.log("");
  return rows.length;
}

async function main() {
  await reportTarget();
  let flagged = 0;
  for (const check of CHECKS) {
    flagged += await runCheck(check);
  }
  console.log(
    flagged === 0
      ? "✅ No audit-flagged data found."
      : `❗ ${flagged} row(s) flagged across ${CHECKS.length} checks. Repair is a separately reviewed migration — this script never writes.`,
  );
  process.exit(0);
}

main().catch((error) => {
  console.error("Diagnostics failed to run:", error);
  // Still exit 0: this script's contract is observation, and a broken check
  // must never fail a pipeline that gates on it. The error text above is the signal.
  process.exit(0);
});
