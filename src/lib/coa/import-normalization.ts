/**
 * Normalization for the CSV chart-of-accounts import (audit PR-14).
 *
 * Imported accounts used to land with NO subtype, and report-calculations
 * silently drops balance-sheet accounts whose subtype is not in its
 * operating/investing/financing sets — so an imported chart produced a cash
 * flow statement that skipped those accounts without a word. Status was also
 * misaligned: a CSV "Inactive" row got status=inactive but isActive=true.
 */
import {
  fallbackSubtypeFor,
  isSubtypeLegalForType,
  type AccountStatus,
  type AccountSubtype,
  type AccountType,
} from "@/db/schema/account-constants";

/**
 * The CSV "Type" column carries more information than the root type alone:
 * Bank and Credit Card name their subtype outright. Everything else gets the
 * type's canonical uncategorized/other bucket — a subtype every report set
 * actually covers — unless the row supplies a legal explicit subtype.
 */
export function inferImportSubtype(
  csvType: string,
  accountType: AccountType,
  explicitSubtype?: string | null,
): AccountSubtype {
  if (explicitSubtype && isSubtypeLegalForType(accountType, explicitSubtype)) {
    return explicitSubtype;
  }
  if (csvType === "Bank") return "bank_accounts";
  if (csvType === "Credit Card") return "credit_cards";
  return fallbackSubtypeFor(accountType);
}

/** isActive is DERIVED from status — exactly one status means active. */
export function importedAccountActivity(status: AccountStatus): boolean {
  return status === "active";
}
