/**
 * Guards for the bill mutation surface (audit PR-13).
 *
 * The exploit these close: pay a bill partially, then raise its amount —
 * updateBill recomputed balanceDue from the client-sent amount with float
 * math and no posting check, so the ledger's A/P accrual no longer matched
 * the bill, and nothing refused the edit. Line-item replacement had the same
 * hole plus no ownership check on accountId, so a crafted request could park
 * bill expense lines on another organization's account row.
 */
import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { dimensions } from "@/db/schema/dimensions";
import { parties } from "@/db/schema/parties";
import { centsToMoney, moneyToCents } from "@/lib/money";

/**
 * The account types every bill-line picker in the product offers (manual
 * create, the edit panel, and the AI upload context all filter to these).
 * The server now enforces what the UI already promised.
 */
export const BILL_LINE_ACCOUNT_TYPES = ["expense", "cost_of_revenue", "other_expense"] as const;

/**
 * Every reference on an incoming bill payload must belong to the caller's
 * organization: the vendor, each line's account — which must also be
 * active and one of the bill-line account types — and each line's department
 * and location, which must be dimensions of that type. (A dimension is not
 * required to be active: a line keeps the one it was tagged with, as an
 * Inbox correction does.)
 */
export async function assertBillReferences(
  db: DbExecutor,
  orgId: string,
  vendorId: string | undefined,
  lineItems: Array<{
    accountId: string;
    departmentId?: string | null;
    locationId?: string | null;
  }>,
): Promise<void> {
  if (vendorId) {
    const [vendor] = await db
      .select({ id: parties.id })
      .from(parties)
      .where(and(eq(parties.id, vendorId), eq(parties.organizationId, orgId)))
      .limit(1);
    if (!vendor) throw new Error("Vendor is unavailable for this organization");
  }

  const accountIds = [...new Set(lineItems.map((line) => line.accountId))];
  if (accountIds.length === 0) return;

  const rows = await db
    .select({ id: accounts.id, accountType: accounts.accountType, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, orgId), inArray(accounts.id, accountIds)));

  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const accountId of accountIds) {
    const row = byId.get(accountId);
    if (!row || !row.isActive) {
      throw new Error("An expense account is unavailable for this organization");
    }
    if (!(BILL_LINE_ACCOUNT_TYPES as readonly string[]).includes(row.accountType)) {
      throw new Error("Bill lines must post to expense-type accounts");
    }
  }

  // bill_line_items' dimension foreign keys are not organization-scoped.
  const dimensionIds = [
    ...new Set(lineItems.flatMap((line) => [line.departmentId, line.locationId])),
  ].filter((id): id is string => Boolean(id));
  if (dimensionIds.length === 0) return;
  const dimensionRows = await db
    .select({ id: dimensions.id, dimensionType: dimensions.dimensionType })
    .from(dimensions)
    .where(and(eq(dimensions.organizationId, orgId), inArray(dimensions.id, dimensionIds)));
  const typeById = new Map(dimensionRows.map((row) => [row.id, row.dimensionType]));
  for (const line of lineItems) {
    if (line.departmentId && typeById.get(line.departmentId) !== "department") {
      throw new Error("A bill line's department is unavailable for this organization");
    }
    if (line.locationId && typeById.get(line.locationId) !== "location") {
      throw new Error("A bill line's location is unavailable for this organization");
    }
  }
}

/**
 * Financial edits (amount, line items) are only legal while the bill is
 * still a draft in the accounting sense: nothing posted, nothing paid, not
 * voided. Once the accrual journal exists the amendment flow is the
 * correction path — editing the bill in place would detach it from the
 * ledger entry it created.
 */
export function assertBillFinanciallyEditable(bill: {
  journalHeaderId: string | null;
  status: string;
  amountPaid: string | null;
}): void {
  if (bill.status === "voided") {
    throw new Error("A voided bill cannot be edited");
  }
  if (bill.journalHeaderId !== null) {
    throw new Error(
      "This bill's accrual journal is already posted. Amend the journal instead of editing the bill amount.",
    );
  }
  if (moneyToCents(bill.amountPaid ?? "0", "amountPaid") !== 0) {
    throw new Error("A bill with recorded payments cannot change amount. Void or amend instead.");
  }
}

/**
 * balanceDue is DERIVED, never client-set: amount minus what has been paid,
 * in integer cents, floored at zero so an over-payment can never manufacture
 * a negative receivable-like balance on the payable side.
 */
export function deriveBillBalanceDue(amount: string, amountPaid: string | null): string {
  const cents = moneyToCents(amount, "amount") - moneyToCents(amountPaid ?? "0", "amountPaid");
  return centsToMoney(Math.max(0, cents));
}
