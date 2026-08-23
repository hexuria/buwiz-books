/**
 * Amend-by-reversal for posted journals.
 *
 * A posted journal is a statement about what the books said. Editing it in
 * place makes the previous statement unrecoverable, which is why every posting
 * path that touches tax has to be able to prove
 * `Δ control account == Σ tax detail == form total` for a period that has
 * already been filed. If the ledger can be rewritten after the return is filed,
 * that equality proves nothing.
 *
 * So a correction produces three rows, not one:
 *
 *   1. the ORIGINAL, untouched and still posted;
 *   2. a REVERSAL — the original's lines with debit and credit exchanged,
 *      pointing at it via `reversesHeaderId`;
 *   3. a REPLACEMENT carrying the corrected figures, pointing at the original
 *      via `replacesHeaderId`.
 *
 * Reports need no changes at all: they aggregate `status = 'posted'`, the
 * original and its reversal are both posted, and they sum to zero.
 *
 * DATING. Both new entries are dated in an OPEN period — by default the same
 * date as the original, but the caller must supply `amendmentDate` when the
 * original sits in a closed period. Back-dating a correction into a filed month
 * silently changes a figure that has already been reported; the correction
 * belongs in the period in which it was discovered.
 */
import { and, asc, eq, ne } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { activityLogs } from "@/db/schema/activity-logs";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { journalsClearedByFinalizedReconciliation } from "@/lib/reconciliation-claimed-lines";

export class NotPostedError extends Error {
  constructor(headerId: string, status: string) {
    super(
      `Journal ${headerId} is ${status}, not posted. Amend-by-reversal applies only to posted entries; edit a draft directly.`,
    );
    this.name = "NotPostedError";
  }
}

export class AlreadyAmendedError extends Error {
  constructor(headerId: string, reversalId: string) {
    super(
      `Journal ${headerId} has already been reversed by ${reversalId}. Amend the replacement instead of the original.`,
    );
    this.name = "AlreadyAmendedError";
  }
}

export type AmendmentLine = {
  accountId: string;
  debit?: string | null;
  credit?: string | null;
  lineDescription?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
};

export type AmendResult = {
  originalHeaderId: string;
  reversalHeaderId: string;
  replacementHeaderId: string | null;
};

/**
 * Reverse a posted journal, and optionally post a corrected replacement.
 *
 * Omit `lines` to reverse only — that is the correct operation when the entry
 * should not have existed at all and there is nothing to replace it with.
 *
 * The caller MUST provide a transaction-scoped executor: the reversal and its
 * replacement have to land together or not at all, and 0041's balance
 * constraint is deferred to COMMIT.
 */
export async function amendPostedJournal(
  db: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    headerId: string;
    reason: string;
    /** Corrected lines. Omit to reverse without replacing. */
    lines?: AmendmentLine[];
    /** Date for the reversal and replacement. Defaults to the original's date. */
    amendmentDate?: string;
  },
): Promise<AmendResult> {
  if (!input.reason.trim()) {
    throw new Error("An amendment reason is required — it is the audit trail for the correction.");
  }

  const [original] = await db
    .select()
    .from(journalHeaders)
    .where(
      and(
        eq(journalHeaders.id, input.headerId),
        eq(journalHeaders.organizationId, input.organizationId),
      ),
    )
    .limit(1)
    .for("update");

  if (!original) throw new Error("Journal not found");
  if (original.status !== "posted") throw new NotPostedError(input.headerId, original.status);

  // A journal parked as someone's duplicate must be resolved through the
  // duplicate flow, not amended around it (2026-08 audit, ledger core).
  if (original.duplicateOfHeaderId) {
    throw new Error(
      `Journal ${input.headerId} is marked as a duplicate of ${original.duplicateOfHeaderId}; ` +
        `resolve the duplicate case instead of amending.`,
    );
  }

  // A journal cleared by a FINALIZED reconciliation is part of a bank
  // statement that has been signed off — reversing it would silently
  // unbalance that reconciliation. Reopen the reconciliation first.
  const clearedByFinalized = await journalsClearedByFinalizedReconciliation(
    db,
    input.organizationId,
    [input.headerId],
  );
  if (clearedByFinalized) {
    throw new Error(
      `Journal ${input.headerId} is cleared by a finalized reconciliation; ` +
        `reopen that reconciliation before amending.`,
    );
  }

  // One reversal per original. The database enforces this too (a partial unique
  // index scoped to non-voided reversals), but failing here gives the caller
  // the existing reversal's id. EXCLUDE voided reversals to match the index:
  // counting them froze the original as unamendable the moment its first
  // reversal was itself voided.
  const [existingReversal] = await db
    .select({ id: journalHeaders.id })
    .from(journalHeaders)
    .where(
      and(
        eq(journalHeaders.reversesHeaderId, input.headerId),
        eq(journalHeaders.organizationId, input.organizationId),
        ne(journalHeaders.status, "voided"),
      ),
    )
    .limit(1);
  if (existingReversal) throw new AlreadyAmendedError(input.headerId, existingReversal.id);

  const amendmentDate = input.amendmentDate ?? original.transactionDate;
  const { locked, closedThrough } = await isDateInLockedPeriod(
    input.organizationId,
    amendmentDate,
    db,
  );
  if (locked) {
    throw new Error(
      `Cannot date this amendment ${amendmentDate}: that period is locked through ${closedThrough}. ` +
        `Supply an amendmentDate in an open period — a correction belongs in the period it was found, ` +
        `not the one that was already filed.`,
    );
  }

  const originalLines = await db
    .select()
    .from(journalLines)
    .where(eq(journalLines.journalHeaderId, input.headerId))
    .orderBy(asc(journalLines.sortOrder));

  if (originalLines.length === 0) {
    throw new Error(`Journal ${input.headerId} has no lines to reverse.`);
  }

  const reversalNumber = await allocateJournalTransactionNumber(input.organizationId, db);
  const [reversal] = await db
    .insert(journalHeaders)
    .values({
      organizationId: input.organizationId,
      transactionNumber: reversalNumber,
      transactionDate: amendmentDate,
      transactionType: original.transactionType,
      source: original.source,
      memo: `Reversal of ${original.transactionNumber ?? original.id}: ${input.reason}`,
      partyId: original.partyId,
      totalAmount: original.totalAmount,
      functionalCurrency: original.functionalCurrency,
      transactionCurrency: original.transactionCurrency,
      exchangeRateId: original.exchangeRateId,
      status: "posted",
      postedAt: new Date(),
      sourceDocumentId: original.sourceDocumentId,
      sourceDocumentType: original.sourceDocumentType,
      createdBy: input.userId,
      referenceNumber: original.referenceNumber,
      reversesHeaderId: original.id,
      amendmentReason: input.reason,
    })
    .returning();
  if (!reversal) throw new Error("Reversal journal could not be posted.");

  // Debit and credit exchanged, everything else carried across verbatim — a
  // reversal that re-derives its own amounts can disagree with what it reverses.
  await db.insert(journalLines).values(
    originalLines.map((line, index) => ({
      journalHeaderId: reversal.id,
      accountId: line.accountId,
      debit: line.credit,
      credit: line.debit,
      lineDescription: `Reversal: ${line.lineDescription ?? ""}`.trim(),
      partyId: line.partyId,
      departmentId: line.departmentId,
      locationId: line.locationId,
      sortOrder: index,
    })),
  );

  let replacementId: string | null = null;

  if (input.lines && input.lines.length > 0) {
    if (input.lines.length < 2) {
      throw new Error("A replacement entry needs at least two lines.");
    }

    // The database enforces balance at COMMIT (0041); this produces a message
    // naming the amendment rather than a raw constraint violation.
    const totals = input.lines.reduce(
      (acc, line) => ({
        debit: acc.debit + BigInt(scaleMoney(line.debit)),
        credit: acc.credit + BigInt(scaleMoney(line.credit)),
      }),
      { debit: 0n, credit: 0n },
    );
    if (totals.debit !== totals.credit) {
      throw new Error(
        `Replacement entry does not balance: debits ${formatScaled(totals.debit)} != credits ${formatScaled(totals.credit)}.`,
      );
    }

    const replacementNumber = await allocateJournalTransactionNumber(input.organizationId, db);
    const [replacement] = await db
      .insert(journalHeaders)
      .values({
        organizationId: input.organizationId,
        transactionNumber: replacementNumber,
        transactionDate: amendmentDate,
        transactionType: original.transactionType,
        source: original.source,
        memo: `Amends ${original.transactionNumber ?? original.id}: ${input.reason}`,
        partyId: original.partyId,
        totalAmount: formatScaled(totals.debit),
        functionalCurrency: original.functionalCurrency,
        transactionCurrency: original.transactionCurrency,
        exchangeRateId: original.exchangeRateId,
        status: "posted",
        postedAt: new Date(),
        sourceDocumentId: original.sourceDocumentId,
        sourceDocumentType: original.sourceDocumentType,
        createdBy: input.userId,
        referenceNumber: original.referenceNumber,
        replacesHeaderId: original.id,
        amendmentReason: input.reason,
      })
      .returning();
    if (!replacement) throw new Error("Replacement journal could not be posted.");

    await db.insert(journalLines).values(
      input.lines.map((line, index) => ({
        journalHeaderId: replacement.id,
        accountId: line.accountId,
        debit: line.debit ?? null,
        credit: line.credit ?? null,
        lineDescription: line.lineDescription ?? null,
        partyId: line.partyId ?? null,
        departmentId: line.departmentId ?? null,
        locationId: line.locationId ?? null,
        sortOrder: index,
      })),
    );
    replacementId = replacement.id;
  }

  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "transaction",
    entityId: original.id,
    action: "amended",
    actorId: input.userId,
    changes: {
      source: "amend_by_reversal",
      reason: input.reason,
      amendmentDate,
      reversalHeaderId: reversal.id,
      replacementHeaderId: replacementId,
    },
  });

  return {
    originalHeaderId: original.id,
    reversalHeaderId: reversal.id,
    replacementHeaderId: replacementId,
  };
}

/**
 * Money to an integer at scale 8, without floats. `"12.34"` -> 1234000000n.
 * Comparing rounded floats is what let a sub-centavo imbalance through the
 * application-level balance check.
 */
function scaleMoney(value: string | null | undefined): string {
  if (value === null || value === undefined || value === "") return "0";
  const trimmed = value.trim();
  if (!/^-?\d+(\.\d+)?$/.test(trimmed)) {
    throw new Error(`Invalid money amount: ${JSON.stringify(value)}`);
  }
  const negative = trimmed.startsWith("-");
  const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
  if (fraction.length > 8) {
    throw new Error(`Money amount ${JSON.stringify(value)} exceeds 8 decimal places.`);
  }
  return `${negative ? "-" : ""}${whole}${fraction.padEnd(8, "0")}`;
}

function formatScaled(scaled: bigint): string {
  const negative = scaled < 0n;
  const digits = (negative ? -scaled : scaled).toString().padStart(9, "0");
  const whole = digits.slice(0, -8);
  const fraction = digits.slice(-8).replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
