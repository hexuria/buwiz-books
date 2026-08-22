/**
 * Year-end annualization postings — the refund and true-up entries.
 *
 * Annualization compares the tax actually withheld across the year against the
 * tax genuinely due on the annualized income, and the difference has to reach
 * the ledger. There are three outcomes and they are NOT symmetric — which is
 * the whole reason this is its own module rather than a sign flip.
 *
 * EXACT — nothing to post. Common by construction under the cumulative average
 * method, which is designed to converge on the annual figure.
 *
 * EXCESS (over-withheld) — the employer owes the employee a refund. The
 * liability to the BIR falls and a new liability to the EMPLOYEE appears:
 *
 *     DR  Withholding tax payable          the over-withheld amount
 *         CR  Employee tax refund payable
 *
 * Note what this is not: the employer does not get the money back from the BIR
 * and pass it on. §2.79(A) requires the employer to refund the employee on or
 * before 25 January and to deduct it from the remittance — so the debit is to
 * the payable, not to a receivable from the BIR.
 *
 * DEFICIENCY (under-withheld) — the employer must collect the shortfall from
 * the employee and remit it. The BIR liability rises, and the offsetting debit
 * depends on whether the money can actually be collected:
 *
 *     DR  Employee receivable — tax advanced    collectible from final pay
 *         CR  Withholding tax payable
 *
 * or, when the employee has left and the shortfall cannot be recovered:
 *
 *     DR  Unrecovered employee tax (expense)    the employer absorbs it
 *         CR  Withholding tax payable
 *
 * THE ASYMMETRY THAT MATTERS. A deficiency the employer cannot collect is an
 * expense the employer bears — the obligation to remit does not disappear
 * because the employee did. Booking it as a receivable instead would carry a
 * balance no one will ever pay, and it would quietly overstate assets year
 * after year. `uncollectibleDeficiency` is therefore an explicit input, never
 * inferred.
 */
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { allocateJournalTransactionNumber } from "@/lib/sequence";
import { isDateInLockedPeriod } from "@/lib/period-close";
import { resolveFunctionalCurrency } from "@/lib/functional-currency";
import { requirePhAccounts } from "@/lib/tax/ph-account-resolver";
import { addAll, fromScaled, toScaled, ZERO } from "@/lib/tax/money";
import {
  summarizeAnnualizationPosting,
  type AnnualizationEntry,
  type AnnualizationPostingSummary,
} from "@/lib/tax/annualization-posting-summary";

export {
  summarizeAnnualizationPosting,
  type AnnualizationEntry,
  type AnnualizationOutcome,
  type AnnualizationPostingSummary,
} from "@/lib/tax/annualization-posting-summary";

export interface PostAnnualizationResult {
  journalHeaderId: string | null;
  summary: AnnualizationPostingSummary;
}

/**
 * Post the year-end true-up.
 *
 * Returns a null header when every employee came out exact — posting an empty
 * journal to record that nothing happened would be noise in the ledger, and
 * the balance constraint would reject a header with no lines anyway.
 *
 * The caller must supply a transaction-scoped executor.
 */
export async function postAnnualization(
  db: DbExecutor,
  input: {
    organizationId: string;
    userId: string;
    taxableYear: number;
    entries: AnnualizationEntry[];
    /**
     * Date the true-up is recorded. Defaults to 25 January of the following
     * year — the §2.79(A) deadline for refunding the employee.
     */
    effectiveDate?: string;
  },
): Promise<PostAnnualizationResult> {
  const summary = summarizeAnnualizationPosting(input.entries);
  if (summary.outcome === "exact" && summary.totalRefund === "0") {
    return { journalHeaderId: null, summary };
  }

  const transactionDate = input.effectiveDate ?? `${input.taxableYear + 1}-01-25`;
  const { locked, closedThrough } = await isDateInLockedPeriod(
    input.organizationId,
    transactionDate,
    db,
  );
  if (locked) {
    throw new Error(
      `Cannot post the ${input.taxableYear} annualization: ${transactionDate} falls in a period ` +
        `locked through ${closedThrough}.`,
    );
  }

  const account = await requirePhAccounts(db, input.organizationId, [
    "ph_wtc_payable",
    "ph_employee_tax_refund_payable",
    "ph_employee_tax_advanced",
    "ph_unrecovered_employee_tax",
  ]);

  const transactionNumber = await allocateJournalTransactionNumber(input.organizationId, db);
  const functionalCurrency = await resolveFunctionalCurrency(db, input.organizationId);

  const refund = toScaled(summary.totalRefund);
  const collectible = toScaled(summary.totalCollectibleDeficiency);
  const uncollectible = toScaled(summary.totalUncollectibleDeficiency);

  // Refunds and deficiencies are posted GROSS on the payable rather than
  // netted: the control account's movement has to be explicable line by line
  // against the per-employee detail, and a single net figure cannot be.
  const candidates: Array<{ accountId: string; debit?: string; credit?: string; label: string }> = [
    {
      accountId: account.ph_wtc_payable,
      debit: fromScaled(refund),
      label: "Over-withheld tax refunded to employees",
    },
    {
      accountId: account.ph_employee_tax_refund_payable,
      credit: fromScaled(refund),
      label: "Refund payable to employees",
    },
    {
      accountId: account.ph_employee_tax_advanced,
      debit: fromScaled(collectible),
      label: "Tax deficiency collectible from employees",
    },
    {
      accountId: account.ph_unrecovered_employee_tax,
      debit: fromScaled(uncollectible),
      label: "Tax deficiency the employer cannot recover",
    },
    {
      accountId: account.ph_wtc_payable,
      credit: fromScaled(addAll(collectible, uncollectible)),
      label: "Under-withheld tax still remittable",
    },
  ];

  const values = candidates
    .filter((c) => toScaled(c.debit ?? c.credit ?? "0") !== ZERO)
    .map((c, index) => ({
      journalHeaderId: "",
      accountId: c.accountId,
      debit: c.debit ?? null,
      credit: c.credit ?? null,
      lineDescription: c.label,
      sortOrder: index,
    }));

  const totalDebits = fromScaled(addAll(refund, collectible, uncollectible));

  const [header] = await db
    .insert(journalHeaders)
    .values({
      organizationId: input.organizationId,
      transactionNumber,
      transactionDate,
      transactionType: "journal",
      source: "manual",
      functionalCurrency,
      memo: `Year-end annualization true-up ${input.taxableYear}`,
      totalAmount: totalDebits,
      status: "posted",
      sourceDocumentType: "annualization",
      createdBy: input.userId,
      idempotencyKey: `annualization:${input.organizationId}:${input.taxableYear}`,
    })
    .returning();
  if (!header) throw new Error("Annualization journal could not be posted.");

  await db.insert(journalLines).values(values.map((v) => ({ ...v, journalHeaderId: header.id })));

  await db.insert(activityLogs).values({
    organizationId: input.organizationId,
    entityType: "transaction",
    entityId: header.id,
    action: "created",
    actorId: input.userId,
    changes: { source: "annualization", taxableYear: input.taxableYear, ...summary },
  });

  return { journalHeaderId: header.id, summary };
}
