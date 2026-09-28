// ============================================================================
// Pure normalizers for entity matching (inbox v2 step 7).
//
// Exact tiers only compare what these functions produce, so a formatting
// difference ("123-456-789-000" vs "123456789000") never splits one party in
// two, and a value too short to identify anything never matches at all.
// ============================================================================

/** Extracted entity roles the matcher understands (mirrors ExtractedEntityInput). */
export type MatchableEntityType =
  | "vendor"
  | "customer"
  | "employee"
  | "bank"
  | "government"
  | "shareholder"
  | "lender";

/**
 * `parties.party_type` values a role may match. A vendor is never matched to a
 * customer-only party: a bookkeeper who forwards a receipt from their own
 * mailbox must not have the bill booked against themselves as an employee.
 */
export const PARTY_TYPES_FOR_ENTITY: Record<MatchableEntityType, readonly string[]> = {
  vendor: ["vendor", "both"],
  customer: ["customer", "both"],
  employee: ["employee"],
  bank: ["bank"],
  government: ["government"],
  shareholder: ["shareholder"],
  lender: ["lender"],
};

const MIN_TAX_ID_CHARS = 8;
const MIN_TAX_ID_DIGITS = 6;

/**
 * Upper-cased letters and digits, or null when the value is too short to
 * identify a taxpayer. Separators and branch-code dashes are formatting.
 */
export function normalizeTaxId(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const normalized = raw.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  const digits = normalized.replace(/\D/g, "").length;
  return normalized.length >= MIN_TAX_ID_CHARS && digits >= MIN_TAX_ID_DIGITS ? normalized : null;
}

/**
 * Whether two normalized tax ids name the same taxpayer.
 *
 * Equal ids match. A Philippine TIN is nine digits, printed with a three- to
 * five-digit branch code after it, while party_tax_profiles stores the nine
 * alone — so a nine-digit id also matches a 12-14 digit id it prefixes.
 */
export function taxIdsMatch(left: string | null, right: string | null): boolean {
  if (!left || !right) return false;
  if (left === right) return true;
  const [short, long] = left.length <= right.length ? [left, right] : [right, left];
  return /^\d{9}$/.test(short) && /^\d{12,14}$/.test(long) && long.startsWith(short);
}

/** The nine-digit base of a branch-coded Philippine TIN, for the SQL prefilter. */
export function taxIdBase(normalized: string): string | null {
  return /^\d{12,14}$/.test(normalized) ? normalized.slice(0, 9) : null;
}

/** Pull the address out of `"Acme" <billing@acme.com>` or a bare address; lower-cased. */
export function extractEmailAddress(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const bracketed = raw.match(/<\s*([^<>\s]+@[^<>\s]+)\s*>/u)?.[1];
  const candidate = (bracketed ?? raw).trim().toLowerCase();
  return /^[^\s@<>"]+@[^\s@<>"]+\.[^\s@<>"]+$/u.test(candidate) ? candidate : null;
}

// ── Payment details ──────────────────────────────────────────────────────────
//
// A document asking to be paid somewhere new is the classic invoice-fraud
// path, so the comparison is deliberately conservative in ONE direction: when
// both sides can be compared and they differ, it reports a change. When either
// side is missing, nothing is comparable and nothing is reported — a party
// with no stored bank details has nothing a document could "change".

export interface PaymentDetailsChange {
  fields: Array<"bank_account_number" | "bank_routing_number">;
  /** Last four characters only: a finding is shown in the UI and logs. */
  stored: { accountLast4: string | null; routingLast4: string | null };
  document: { accountLast4: string | null; routingLast4: string | null };
}

/** A masked account prints bullets or asterisks, or three or more X's, before the tail. */
const MASK_PATTERN = /[*•]|[xX]{3,}/u;

interface ParsedBankIdentifier {
  /** Letters and digits, upper-cased; null when the printed value is masked. */
  full: string | null;
  /** Trailing digits of a masked value (at least three), else null. */
  tail: string | null;
}

function parseBankIdentifier(raw: string | null | undefined): ParsedBankIdentifier | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (MASK_PATTERN.test(trimmed)) {
    const tail = trimmed.match(/(\d{3,})\D*$/u)?.[1] ?? null;
    return tail ? { full: null, tail } : null;
  }
  const full = trimmed.replace(/[^0-9A-Za-z]/g, "").toUpperCase();
  return full.length >= 4 ? { full, tail: null } : null;
}

function last4(value: string | null | undefined): string | null {
  const cleaned = value?.replace(/[^0-9A-Za-z]/g, "") ?? "";
  return cleaned.length > 0 ? cleaned.slice(-4) : null;
}

/**
 * null when the two values cannot be compared; otherwise whether they name
 * the same account. An IBAN ends with the domestic account number it wraps,
 * so a suffix of at least six characters counts as the same account.
 */
function sameAccountNumber(stored: string | null, printed: string | null): boolean | null {
  const left = parseBankIdentifier(stored);
  const right = parseBankIdentifier(printed);
  if (!left?.full || !right) return null;
  if (right.tail) return left.full.endsWith(right.tail);
  const a = left.full;
  const b = right.full!;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length >= 6 && long.endsWith(short);
}

/** BIC8 and BIC11 with the "XXX" primary-office branch are the same institution. */
function sameRoutingNumber(stored: string | null, printed: string | null): boolean | null {
  const a = stored?.replace(/[^0-9A-Za-z]/g, "").toUpperCase() ?? "";
  const b = printed?.replace(/[^0-9A-Za-z]/g, "").toUpperCase() ?? "";
  if (a.length < 4 || b.length < 4) return null;
  const bic8 = (value: string) =>
    /^[A-Z]{6}[A-Z0-9]{2}(XXX)?$/.test(value) ? value.slice(0, 8) : value;
  return a === b || bic8(a) === bic8(b);
}

/**
 * Compare a party's stored payment destination with the one printed on a
 * document. Returns the change, or null when nothing comparable differs.
 */
export function detectPaymentDetailsChange(
  stored: { bankAccountNumber: string | null; bankRoutingNumber: string | null },
  printed: { accountNumber: string | null; routingNumber: string | null },
): PaymentDetailsChange | null {
  const fields: PaymentDetailsChange["fields"] = [];
  if (sameAccountNumber(stored.bankAccountNumber, printed.accountNumber) === false) {
    fields.push("bank_account_number");
  }
  if (sameRoutingNumber(stored.bankRoutingNumber, printed.routingNumber) === false) {
    fields.push("bank_routing_number");
  }
  if (fields.length === 0) return null;
  return {
    fields,
    stored: {
      accountLast4: last4(stored.bankAccountNumber),
      routingLast4: last4(stored.bankRoutingNumber),
    },
    document: {
      accountLast4: last4(printed.accountNumber),
      routingLast4: last4(printed.routingNumber),
    },
  };
}
