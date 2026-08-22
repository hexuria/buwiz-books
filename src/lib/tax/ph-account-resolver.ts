/**
 * Resolve a Philippine control account by its chart KEY.
 *
 * WHY NOT `category_mappings`. The obvious move is a new `"payroll"` or
 * `"tax"` mapping type. That was tried and reverted: `allMappingKeys()` is
 * global, so adding a mapping type makes every shipped preset fail its
 * completeness check (DECISIONS, Part A). The PH chart solves the same problem
 * differently — its account numbers are FROZEN in ph-chart.ts and its bands are
 * reserved against every other preset, both enforced by tests.
 *
 * So the key is the public contract and the number is this module's private
 * business. Callers say `ph_wtc_payable`; only the query below knows that means
 * 21610. That is exactly what "code references these accounts by key, never by
 * number" is for — the freeze is what makes the lookup safe.
 *
 * FAILURE IS LOUD AND SPECIFIC. An organization that has not had the
 * `philippines_smb` preset applied, or has had it applied only up to an earlier
 * stage, genuinely does not have these accounts. Posting to a silently-chosen
 * substitute would put payroll tax into an arbitrary account and reconcile
 * against nothing, so the error names the account and the stage that creates it.
 */
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { PH_CHART, type PhChartEntry } from "@/lib/tax/ph-chart";

/**
 * Base-preset accounts the payroll entry needs that are NOT PH-specific.
 *
 * Held here rather than in ph-chart.ts because ph-chart is frozen against a
 * lock test that holds an independent copy of its tuples — these are ordinary
 * base-preset accounts every organization already has, and adding them there
 * would misrepresent them as PH control accounts.
 */
export const BASE_ACCOUNT_NUMBERS: Record<string, { number: string; label: string }> = {
  salaries: { number: "61100", label: "Salaries" },
  employer_payroll_taxes: { number: "61600", label: "Employer Payroll Taxes" },
  payroll_liabilities: { number: "25100", label: "Payroll Liabilities" },
};

export class MissingPhAccountError extends Error {
  constructor(
    readonly accountKey: string,
    readonly accountNumber: string,
    readonly label: string,
    readonly stage: string | null,
  ) {
    super(
      `No account ${accountNumber} (${label}) exists for this organization. ` +
        (stage
          ? `It is introduced by the philippines_smb preset at stage ${stage}. ` +
            `Apply the preset through that stage before posting.`
          : `Apply a chart-of-accounts preset before posting.`) +
        ` Posting to a substitute account would reconcile against nothing.`,
    );
    this.name = "MissingPhAccountError";
  }
}

export class UnknownPhAccountKeyError extends Error {
  constructor(accountKey: string) {
    super(
      `${JSON.stringify(accountKey)} is not a Philippine chart key or a known base account. ` +
        `Keys are defined in ph-chart.ts and BASE_ACCOUNT_NUMBERS.`,
    );
    this.name = "UnknownPhAccountKeyError";
  }
}

function lookupKey(accountKey: string): {
  number: string;
  label: string;
  stage: string | null;
} {
  const phEntry: PhChartEntry | undefined = PH_CHART.find((e) => e.key === accountKey);
  if (phEntry) {
    return { number: phEntry.accountNumber, label: phEntry.name, stage: phEntry.stage };
  }
  const base = BASE_ACCOUNT_NUMBERS[accountKey];
  if (base) return { number: base.number, label: base.label, stage: null };
  throw new UnknownPhAccountKeyError(accountKey);
}

/**
 * The account id for a chart key, or a loud failure.
 *
 * Matches on the frozen account number and requires the account to be active:
 * an archived control account is not a valid posting target, and silently
 * posting to it would hide the amount from anyone looking at the live chart.
 */
export async function requirePhAccount(
  db: DbExecutor,
  organizationId: string,
  accountKey: string,
): Promise<string> {
  const { number, label, stage } = lookupKey(accountKey);

  const [row] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, organizationId),
        eq(accounts.accountNumber, number),
        eq(accounts.isActive, true),
      ),
    )
    .limit(1);

  if (!row) throw new MissingPhAccountError(accountKey, number, label, stage);
  return row.id;
}

/**
 * Resolve several keys at once, reporting EVERY missing account rather than
 * only the first.
 *
 * An organization missing the preset is missing all of them, and fixing them
 * one error at a time is a poor way to find that out.
 */
export async function requirePhAccounts(
  db: DbExecutor,
  organizationId: string,
  accountKeys: readonly string[],
): Promise<Record<string, string>> {
  const resolved: Record<string, string> = {};
  const missing: MissingPhAccountError[] = [];

  for (const key of accountKeys) {
    try {
      resolved[key] = await requirePhAccount(db, organizationId, key);
    } catch (error) {
      if (error instanceof MissingPhAccountError) {
        missing.push(error);
        continue;
      }
      throw error;
    }
  }

  if (missing.length > 0) {
    throw new MissingPhAccountError(
      missing.map((m) => m.accountKey).join(", "),
      missing.map((m) => m.accountNumber).join(", "),
      missing.map((m) => m.label).join("; "),
      missing.find((m) => m.stage)?.stage ?? null,
    );
  }
  return resolved;
}
