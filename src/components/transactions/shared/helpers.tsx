/**
 * Shared helpers for transaction forms (New + Detail pages)
 */
import { ICON_PATHS } from "../../accounts/icons";
import type { ComboboxOption } from "../../ui/Combobox";
import type { AccountOption, JournalLine, PayForLine } from "./types";

// ============================================================================
// Date / Currency formatting
// ============================================================================

export function todayISO(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export { formatCurrency } from "@/utils/format";

export function formatDate(dateStr: string, timezone?: string): string {
  // Parse as UTC midnight so the calendar date is preserved regardless of viewer's local timezone
  const date = new Date(dateStr + "T00:00:00Z");
  return date.toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: timezone ?? "UTC",
  });
}

export function formatTimestamp(ts: string, timezone?: string): string {
  const opts: Intl.DateTimeFormatOptions = {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  };
  if (timezone) opts.timeZone = timezone;
  return new Date(ts).toLocaleString("en-US", opts);
}

export function formatRelativeTime(ts: string | Date | null | undefined): string {
  if (!ts) return "—";
  const now = Date.now();
  const then = ts instanceof Date ? ts.getTime() : new Date(ts).getTime();
  if (Number.isNaN(then)) return "—";
  const diffMs = now - then;
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);

  if (diffSec < 60) return "just now";
  if (diffMin < 60) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  if (diffHr < 24) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  if (diffDay < 30) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  return formatTimestamp(ts instanceof Date ? ts.toISOString() : ts);
}

// ============================================================================
// Account → ComboboxOption builder
// ============================================================================

const CategoryIcon = (
  <svg
    width="100%"
    height="100%"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.5"
  >
    <rect x="3" y="3" width="7" height="7" rx="1" />
    <rect x="14" y="3" width="7" height="7" rx="1" />
    <rect x="3" y="14" width="7" height="7" rx="1" />
    <rect x="14" y="14" width="7" height="7" rx="1" />
  </svg>
);

export function buildAccountOptions(accounts: AccountOption[]): ComboboxOption[] {
  return accounts.map((a) => {
    const iconSvg = a.icon ? ICON_PATHS[a.icon] : undefined;
    return {
      value: a.id,
      label: a.accountNumber ? `${a.accountNumber} · ${a.name}` : a.name,
      icon: iconSvg ? (
        <svg
          width="100%"
          height="100%"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.5"
          dangerouslySetInnerHTML={{ __html: iconSvg }}
        />
      ) : (
        CategoryIcon
      ),
    };
  });
}

/**
 * Filter accounts for the Payment/Header selector (Asset/Liability).
 * Used for "Pay From" (Pay Out) or "Deposit To" (Pay In).
 */
export function filterPaymentAccounts(accounts: AccountOption[]): AccountOption[] {
  // Matching src/db/schema/account-constants.ts
  const allowedTypes = new Set(["asset", "liability", "equity"]);
  return accounts.filter((a) => allowedTypes.has(a.accountType));
}

/**
 * Filter accounts for the Line Item selector based on transaction context.
 * - Pay In lines (Credit): Revenue, Other Income, Equity, Liabilities
 * - Pay Out lines (Debit): Expenses, Other Expenses, Assets, Cost of Revenue, Liabilities
 * - Transfer (Assets-only + Liability/Equity for generality): Assets, Liabilities, Equity
 */
export function filterCategoryOptions(
  accounts: AccountOption[],
  type: "pay_in" | "pay_out" | "transfer" | "journal",
): AccountOption[] {
  if (type === "journal") return accounts;

  const allowedTypes = new Set<string>();

  switch (type) {
    case "pay_in":
      allowedTypes.add("revenue");
      allowedTypes.add("other_income");
      allowedTypes.add("equity");
      allowedTypes.add("liability");
      break;
    case "pay_out":
      allowedTypes.add("expense");
      allowedTypes.add("other_expense");
      allowedTypes.add("asset");
      allowedTypes.add("cost_of_revenue");
      allowedTypes.add("liability"); // Paying off a liability (Credit normal, Debit to decrease)
      allowedTypes.add("equity"); // Dividends / Owner's Draw (Credit normal, Debit to decrease)
      break;
    case "transfer":
      allowedTypes.add("asset");
      allowedTypes.add("liability"); // Transfer to/from Credit Card
      allowedTypes.add("equity");
      break;
  }

  return accounts.filter((a) => allowedTypes.has(a.accountType));
}

// ============================================================================
// Line factory creators
// ============================================================================

let lineCounter = 0;

export function createKey(): string {
  lineCounter += 1;
  return `line-${Date.now()}-${lineCounter}`;
}

export function emptyJournalLine(): JournalLine {
  return {
    key: createKey(),
    description: "",
    categoryId: "",
    partyId: "",
    departmentId: "",
    locationId: "",
    debit: "",
    credit: "",
  };
}

export function emptyPayForLine(): PayForLine {
  return {
    key: createKey(),
    description: "",
    categoryId: "",
    departmentId: "",
    locationId: "",
    amount: "",
  };
}
