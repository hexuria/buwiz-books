/**
 * Read-only survey of the bill-void double-removal exposure.
 *
 * THE DEFECT (fixed in code, but historical data still carries it). Voiding a
 * bill used to flip every linked posted journal to `voided` AND post a full
 * mirrored reversal of each. Reports aggregate `status = 'posted'` only, so
 * the void alone already removed the bill's effect; the reversal removed it a
 * SECOND time. Every voided bill therefore understated its period by the
 * bill's value.
 *
 * This script only READS. It reports which organizations and which periods are
 * affected and by how much, so the exposure is known before any period is used
 * for a filing. It deliberately performs no repair: changing historical
 * financial figures is the owner's decision, not a script's default.
 *
 *   bun run scripts/survey-bill-void-exposure.ts
 *
 * The repair, once authorised, is to set those reversal headers to `voided` —
 * NOT to delete them. Reports then exclude them and the bill's effect is
 * removed exactly once, while the rows stay readable for audit. (Deleting a
 * posted journal's lines is refused by the ledger anyway, per migration 0042.)
 */
import postgres from "postgres";

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL is not set.");
  process.exit(1);
}

const sql = postgres(DATABASE_URL, { max: 1, onnotice: () => {} });

type ReversalRow = {
  id: string;
  organization_id: string;
  transaction_date: string;
  total_amount: string | null;
  idempotency_key: string | null;
  original_id: string | null;
  original_status: string | null;
};

async function main() {
  // The old void path stamped `bill-void:<opKey>:<originalHeaderId>`. That
  // trailing segment names the header each reversal reversed, so every row can
  // be paired with its original rather than matched by amount and date.
  const reversals = (await sql`
    SELECT
      r.id,
      r.organization_id,
      r.transaction_date,
      r.total_amount,
      r.idempotency_key,
      o.id     AS original_id,
      o.status AS original_status
    FROM journal_headers r
    LEFT JOIN journal_headers o
      ON o.id = NULLIF(split_part(r.idempotency_key, ':', 3), '')::uuid
    WHERE r.idempotency_key LIKE 'bill-void:%'
      AND r.status = 'posted'
    ORDER BY r.organization_id, r.transaction_date, r.id
  `) as unknown as ReversalRow[];

  if (reversals.length === 0) {
    console.log("✅ No posted bill-void reversals found — no historical exposure.");
    console.log("   An organization that never voided a bill was never affected.");
    await sql.end();
    return;
  }

  // Only a reversal whose ORIGINAL is also voided is a double removal. One
  // whose original is still posted is doing legitimate work and is a different
  // history — reported separately rather than folded into the total.
  const doubleRemovals = reversals.filter((r) => r.original_status === "voided");
  const originalStillPosted = reversals.filter((r) => r.original_status === "posted");
  const unresolved = reversals.filter((r) => r.original_id === null);

  console.log(`Found ${reversals.length} posted bill-void reversal(s).\n`);

  const byOrg = new Map<string, { count: number; total: number; periods: Set<string> }>();
  for (const r of doubleRemovals) {
    const entry = byOrg.get(r.organization_id) ?? { count: 0, total: 0, periods: new Set() };
    entry.count += 1;
    entry.total += Number(r.total_amount ?? 0);
    entry.periods.add(r.transaction_date.slice(0, 7));
    byOrg.set(r.organization_id, entry);
  }

  console.log(`── Double removals (periods understated): ${doubleRemovals.length} ──`);
  if (byOrg.size === 0) {
    console.log("  none");
  }
  for (const [org, e] of byOrg) {
    const periods = [...e.periods].sort();
    console.log(
      `  ${org}\n` +
        `    ${e.count} reversal(s), understated by ${e.total.toFixed(2)}\n` +
        `    affected periods: ${periods.join(", ")}`,
    );
  }

  if (originalStillPosted.length > 0) {
    console.log(`\n⚠️  ${originalStillPosted.length} reversal(s) whose ORIGINAL is still posted.`);
    console.log("   NOT double removals. Review individually before touching anything:");
    for (const r of originalStillPosted.slice(0, 20)) {
      console.log(`     reversal ${r.id}  original ${r.original_id}`);
    }
  }

  if (unresolved.length > 0) {
    console.log(`\n⚠️  ${unresolved.length} reversal(s) whose original could not be resolved.`);
    for (const r of unresolved.slice(0, 20)) {
      console.log(`     reversal ${r.id}  key ${r.idempotency_key}`);
    }
  }

  console.log(
    "\nThis script made no changes. Any repair is an explicit, separate,\n" +
      "owner-authorised step, and every affected period should be re-reported\n" +
      "afterwards.",
  );
  await sql.end();
}

main().catch(async (error) => {
  console.error("Survey failed:", error);
  await sql.end();
  process.exit(1);
});
