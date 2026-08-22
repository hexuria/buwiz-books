/**
 * One resolver for a journal header's functional currency.
 *
 * WHY THIS EXISTS. `journal_headers.functional_currency` defaults to 'USD' at
 * the column level, and six of the nine posting sites never set it — they take
 * that default silently. `organization_accounting_settings.base_currency`
 * ALSO defaults to 'USD'. The result is that a Philippine organization's
 * ledger records its own books in dollars unless someone remembered to set the
 * field, and nothing anywhere fails when they didn't.
 *
 * That is not a display bug. `functional_currency` is what the FX-revaluation
 * and multi-currency match paths read (see legacy-match-conversion.ts, which
 * decides a header "is foreign" by comparing transaction currency against it).
 * A header stamped USD in a PHP book is treated as domestic when it is not,
 * and vice versa.
 *
 * The fix is a single resolver every posting site calls, so a new posting site
 * that forgets it fails to compile rather than defaulting to dollars.
 */
import { eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { organizationAccountingSettings } from "@/db/schema/inbox";
import { normalizeCurrency } from "@/lib/inbox/money";

/**
 * Thrown when an organization's configured base currency is not a currency we
 * recognise. Loud on purpose: silently substituting a default is how the
 * original defect worked.
 */
export class InvalidBaseCurrencyError extends Error {
  constructor(
    readonly organizationId: string,
    readonly configured: string,
  ) {
    super(
      `Organization ${organizationId} has an invalid base currency ${JSON.stringify(configured)}. ` +
        `Set a valid ISO 4217 code in accounting settings before posting.`,
    );
    this.name = "InvalidBaseCurrencyError";
  }
}

/**
 * The currency an organization keeps its books in.
 *
 * Falls back to USD ONLY when the organization has no accounting-settings row
 * at all, which is the pre-onboarding state. An explicitly configured value is
 * never overridden, and an explicitly invalid one throws rather than degrading
 * to a default.
 */
export async function resolveFunctionalCurrency(
  db: DbExecutor,
  organizationId: string,
): Promise<string> {
  const [settings] = await db
    .select({ baseCurrency: organizationAccountingSettings.baseCurrency })
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, organizationId))
    .limit(1);

  // No settings row: the organization has not been onboarded. The column
  // default applies, and there is nothing to validate.
  if (!settings?.baseCurrency) return "USD";

  // normalizeCurrency THROWS on a bad code rather than returning null, so this
  // has to be a catch — a `?? throw` here would be dead code.
  try {
    return normalizeCurrency(settings.baseCurrency);
  } catch {
    throw new InvalidBaseCurrencyError(organizationId, settings.baseCurrency);
  }
}
