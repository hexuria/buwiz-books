import { createHash } from "node:crypto";
import { z } from "zod";

export const LEGACY_MATCH_VALIDATOR_VERSION = "legacy-match-v1";

const uuidSchema = z.string().uuid();
const decimalSchema = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,10})?$/, "Expected a fixed-point decimal string.");
const moneySchema = z
  .string()
  .regex(/^-?\d+(?:\.\d{1,8})?$/, "Expected a decimal with at most 8 fractional digits.");
const currencySchema = z.string().regex(/^[A-Z]{3}$/, "Expected an uppercase ISO currency code.");
const dateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((value) => {
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
  }, "Expected a valid calendar date.");

export const legacyDeletedHeaderSnapshotSchema = z.object({
  id: uuidSchema,
  organizationId: z.string().min(1),
  transactionNumber: z.string().max(50).nullable(),
  referenceNumber: z.string().max(100).nullable(),
  idempotencyKey: z.string().max(255).nullable(),
  transactionDate: dateSchema,
  transactionType: z.enum(["pay_in", "pay_out", "journal", "transfer"]),
  source: z.enum([
    "manual",
    "import",
    "document",
    "email",
    "integration",
    "invoice",
    "bill",
    "payment",
    "reconciliation",
    "system",
  ]),
  memo: z.string().nullable(),
  partyId: uuidSchema.nullable(),
  totalAmount: moneySchema.nullable(),
  functionalCurrency: currencySchema,
  transactionCurrency: currencySchema.nullable(),
  exchangeRateId: uuidSchema.nullable(),
  status: z.enum(["draft", "posted", "voided"]),
  sourceDocumentId: uuidSchema.nullable(),
  sourceDocumentType: z.string().max(50).nullable(),
  createdBy: z.string().nullable(),
  createdAt: z.coerce.date(),
  updatedAt: z.coerce.date(),
  postedAt: z.coerce.date().nullable(),
  voidedAt: z.coerce.date().nullable(),
  // This field did not exist in the destructive implementation. Accept an
  // explicitly-null value from later snapshots, but never accept an existing
  // duplicate relationship.
  duplicateOfHeaderId: uuidSchema.nullable().optional(),
  matchedFromIds: z.array(uuidSchema),
  isMatched: z.boolean(),
});

export const legacyDeletedLineSnapshotSchema = z.object({
  id: uuidSchema,
  journalHeaderId: uuidSchema,
  accountId: uuidSchema,
  debit: moneySchema.nullable(),
  credit: moneySchema.nullable(),
  originalDebit: moneySchema.nullable(),
  originalCredit: moneySchema.nullable(),
  originalCurrency: currencySchema.nullable(),
  exchangeRate: decimalSchema.nullable(),
  exchangeRateId: uuidSchema.nullable(),
  lineDescription: z.string().nullable(),
  partyId: uuidSchema.nullable(),
  departmentId: uuidSchema.nullable(),
  locationId: uuidSchema.nullable(),
  sortOrder: z.number().int(),
  createdAt: z.coerce.date(),
});

export type LegacyDeletedHeaderSnapshot = z.infer<typeof legacyDeletedHeaderSnapshotSchema>;
export type LegacyDeletedLineSnapshot = z.infer<typeof legacyDeletedLineSnapshotSchema>;

export interface LegacySnapshotInput {
  historyId: string;
  organizationId: string;
  survivingHeaderId: string;
  deletedHeaderSnapshot: unknown;
  deletedLinesSnapshot: unknown;
}

export interface LegacyValidationIssue {
  [key: string]: string;
  code: string;
  message: string;
}

export interface ValidatedLegacySnapshot {
  header: LegacyDeletedHeaderSnapshot;
  lines: LegacyDeletedLineSnapshot[];
  debitTotal: string;
  creditTotal: string;
  effectiveCurrency: string;
  snapshotDigest: string;
}

export type LegacySnapshotValidation =
  | { valid: true; value: ValidatedLegacySnapshot; issues: [] }
  | { valid: false; value: null; issues: LegacyValidationIssue[]; snapshotDigest: string };

export interface LegacySurvivorFacts {
  id: string;
  organizationId: string;
  status: "draft" | "posted" | "voided";
  transactionType: "pay_in" | "pay_out" | "journal" | "transfer";
  source: LegacyDeletedHeaderSnapshot["source"];
  totalAmount: string | null;
  functionalCurrency: string;
  transactionCurrency: string | null;
  duplicateOfHeaderId: string | null;
  matchedFromIds: string[];
  isMatched: boolean;
  debitTotal: string;
  creditTotal: string;
}

const MONEY_SCALE = 8;
const MONEY_FACTOR = 10n ** BigInt(MONEY_SCALE);
const RATE_SCALE = 10;
const RATE_FACTOR = 10n ** BigInt(RATE_SCALE);

function canonicalJson(value: unknown): string {
  if (value === undefined) return '"[undefined]"';
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

export function legacySnapshotDigest(headerSnapshot: unknown, linesSnapshot: unknown): string {
  return createHash("sha256")
    .update(canonicalJson({ header: headerSnapshot, lines: linesSnapshot }))
    .digest("hex");
}

function moneyUnits(value: string | null): bigint | null {
  if (value === null) return null;
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > MONEY_SCALE) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  return sign * (BigInt(match[2]) * MONEY_FACTOR + BigInt(fraction.padEnd(MONEY_SCALE, "0")));
}

function isPositiveDecimal(value: string): boolean {
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match || match[1] === "-") return false;
  return /[1-9]/.test(`${match[2]}${match[3] ?? ""}`);
}

function rateUnits(value: string): bigint | null {
  const match = value.match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const fraction = match[3] ?? "";
  if (fraction.length > RATE_SCALE) return null;
  const sign = match[1] === "-" ? -1n : 1n;
  return sign * (BigInt(match[2]) * RATE_FACTOR + BigInt(fraction.padEnd(RATE_SCALE, "0")));
}

function formatMoneyUnits(value: bigint): string {
  const negative = value < 0n;
  const unsigned = negative ? -value : value;
  const whole = unsigned / MONEY_FACTOR;
  const fraction = (unsigned % MONEY_FACTOR).toString().padStart(MONEY_SCALE, "0");
  return `${negative ? "-" : ""}${whole}.${fraction}`;
}

function pushIssue(issues: LegacyValidationIssue[], code: string, message: string): void {
  if (!issues.some((issue) => issue.code === code && issue.message === message)) {
    issues.push({ code, message });
  }
}

function zodIssueMessage(label: string, error: z.ZodError): string {
  const first = error.issues[0];
  const path = first?.path.length ? ` at ${first.path.join(".")}` : "";
  return `${label}${path}: ${first?.message ?? "invalid snapshot"}`;
}

export function validateLegacyMatchSnapshot(input: LegacySnapshotInput): LegacySnapshotValidation {
  const snapshotDigest = legacySnapshotDigest(
    input.deletedHeaderSnapshot,
    input.deletedLinesSnapshot,
  );
  const issues: LegacyValidationIssue[] = [];
  const parsedHeader = legacyDeletedHeaderSnapshotSchema.safeParse(input.deletedHeaderSnapshot);
  const parsedLines = z
    .array(legacyDeletedLineSnapshotSchema)
    .safeParse(input.deletedLinesSnapshot);

  if (!parsedHeader.success) {
    pushIssue(
      issues,
      "invalid_header_snapshot",
      zodIssueMessage("Deleted header snapshot is incomplete or invalid", parsedHeader.error),
    );
  }
  if (!parsedLines.success) {
    pushIssue(
      issues,
      "invalid_line_snapshot",
      zodIssueMessage("Deleted line snapshot is incomplete or invalid", parsedLines.error),
    );
  }
  if (!parsedHeader.success || !parsedLines.success) {
    return { valid: false, value: null, issues, snapshotDigest };
  }

  const header = parsedHeader.data;
  const lines = parsedLines.data;

  if (header.organizationId !== input.organizationId) {
    pushIssue(
      issues,
      "organization_mismatch",
      "Deleted header snapshot belongs to a different organization.",
    );
  }
  if (header.id === input.survivingHeaderId) {
    pushIssue(issues, "self_match", "Legacy match points the deleted and surviving IDs together.");
  }
  if (header.status !== "posted") {
    pushIssue(
      issues,
      "deleted_not_posted",
      "Only a posted deleted journal can be converted to a posted duplicate merge.",
    );
  }
  if (header.postedAt === null || header.voidedAt !== null) {
    pushIssue(
      issues,
      "invalid_posting_state",
      "Posted snapshot must have postedAt and must not have voidedAt.",
    );
  }
  if (header.isMatched || header.matchedFromIds.length > 0 || header.duplicateOfHeaderId) {
    pushIssue(
      issues,
      "nested_legacy_match",
      "Deleted snapshot was already matched or suppressed; automatic chain reconstruction is unsafe.",
    );
  }
  if ((header.sourceDocumentId === null) !== (header.sourceDocumentType === null)) {
    pushIssue(
      issues,
      "incomplete_source_document",
      "Source document ID and type must either both be present or both be null.",
    );
  }
  if (header.totalAmount === null || (moneyUnits(header.totalAmount) ?? 0n) <= 0n) {
    pushIssue(
      issues,
      "invalid_total_amount",
      "Deleted journal must have a positive cached total amount.",
    );
  }
  if (lines.length < 2) {
    pushIssue(
      issues,
      "missing_posting_lines",
      "Deleted journal snapshot must contain at least two posting lines.",
    );
  }

  const lineIds = new Set<string>();
  let debitTotal = 0n;
  let creditTotal = 0n;
  let originalDebitTotal = 0n;
  let originalCreditTotal = 0n;
  let originalEvidenceLineCount = 0;
  const crossCurrency =
    header.transactionCurrency !== null && header.transactionCurrency !== header.functionalCurrency;

  if (crossCurrency && header.exchangeRateId === null) {
    pushIssue(
      issues,
      "incomplete_fx_evidence",
      "Cross-currency header is missing its exchange-rate ID.",
    );
  }

  for (const [index, line] of lines.entries()) {
    const number = index + 1;
    if (lineIds.has(line.id)) {
      pushIssue(issues, "duplicate_line_id", `Line ${number} repeats line ID ${line.id}.`);
    }
    lineIds.add(line.id);
    if (line.journalHeaderId !== header.id) {
      pushIssue(
        issues,
        "line_header_mismatch",
        `Line ${number} points to a different journal header.`,
      );
    }

    const debit = moneyUnits(line.debit);
    const credit = moneyUnits(line.credit);
    const debitValue = debit ?? 0n;
    const creditValue = credit ?? 0n;
    if (debitValue < 0n || creditValue < 0n || debitValue > 0n === creditValue > 0n) {
      pushIssue(
        issues,
        "invalid_line_amount",
        `Line ${number} must contain exactly one positive debit or credit.`,
      );
    }
    debitTotal += debitValue;
    creditTotal += creditValue;

    const originalDebit = moneyUnits(line.originalDebit);
    const originalCredit = moneyUnits(line.originalCredit);
    const originalDebitValue = originalDebit ?? 0n;
    const originalCreditValue = originalCredit ?? 0n;
    const hasOriginalEvidence =
      line.originalDebit !== null ||
      line.originalCredit !== null ||
      line.originalCurrency !== null ||
      line.exchangeRate !== null ||
      line.exchangeRateId !== null;
    if (hasOriginalEvidence) originalEvidenceLineCount += 1;

    if (crossCurrency) {
      if (
        line.originalCurrency !== header.transactionCurrency ||
        line.exchangeRate === null ||
        line.exchangeRateId !== header.exchangeRateId ||
        originalDebitValue < 0n ||
        originalCreditValue < 0n ||
        originalDebitValue > 0n === originalCreditValue > 0n ||
        debitValue > 0n !== originalDebitValue > 0n
      ) {
        pushIssue(
          issues,
          "incomplete_fx_evidence",
          `Line ${number} does not contain a complete, side-consistent original-currency trail.`,
        );
      }
      if (line.exchangeRate !== null && !isPositiveDecimal(line.exchangeRate)) {
        pushIssue(
          issues,
          "invalid_fx_rate",
          `Line ${number} contains a non-positive exchange rate.`,
        );
      }
    } else if (hasOriginalEvidence) {
      const effectiveTransactionCurrency = header.transactionCurrency ?? header.functionalCurrency;
      if (
        line.originalCurrency !== effectiveTransactionCurrency ||
        line.exchangeRate === null ||
        !isPositiveDecimal(line.exchangeRate) ||
        line.exchangeRateId !== header.exchangeRateId ||
        originalDebitValue > 0n === originalCreditValue > 0n ||
        debitValue > 0n !== originalDebitValue > 0n
      ) {
        pushIssue(
          issues,
          "inconsistent_original_amounts",
          `Line ${number} contains a partial or side-inconsistent original-amount trail.`,
        );
      }
    }
    if (hasOriginalEvidence && line.exchangeRate !== null) {
      const rate = rateUnits(line.exchangeRate);
      const originalSide = originalDebitValue > 0n ? originalDebitValue : originalCreditValue;
      const functionalSide = debitValue > 0n ? debitValue : creditValue;
      if (
        rate === null ||
        rate <= 0n ||
        (originalSide * rate + RATE_FACTOR / 2n) / RATE_FACTOR !== functionalSide
      ) {
        pushIssue(
          issues,
          "fx_conversion_mismatch",
          `Line ${number} functional amount is inconsistent with its original amount and rate.`,
        );
      }
    }
    originalDebitTotal += originalDebitValue;
    originalCreditTotal += originalCreditValue;
  }

  if (debitTotal <= 0n || debitTotal !== creditTotal) {
    pushIssue(
      issues,
      "unbalanced_deleted_journal",
      "Deleted journal snapshot must be non-zero and exactly balanced.",
    );
  }
  const totalAmount = moneyUnits(header.totalAmount);
  if (totalAmount === null || totalAmount !== debitTotal) {
    pushIssue(
      issues,
      "deleted_total_mismatch",
      "Deleted journal cached total does not equal its debit and credit totals.",
    );
  }
  if (crossCurrency && (originalDebitTotal <= 0n || originalDebitTotal !== originalCreditTotal)) {
    pushIssue(
      issues,
      "unbalanced_original_amounts",
      "Deleted journal original-currency amounts must be non-zero and exactly balanced.",
    );
  }
  if (!crossCurrency && originalEvidenceLineCount > 0) {
    if (originalEvidenceLineCount !== lines.length) {
      pushIssue(
        issues,
        "incomplete_original_amounts",
        "Original-amount evidence is present on only part of the deleted journal.",
      );
    }
    if (originalDebitTotal <= 0n || originalDebitTotal !== originalCreditTotal) {
      pushIssue(
        issues,
        "unbalanced_original_amounts",
        "Deleted journal original amounts must be non-zero and exactly balanced when present.",
      );
    }
  }
  if (
    !crossCurrency &&
    header.exchangeRateId !== null &&
    originalEvidenceLineCount !== lines.length
  ) {
    pushIssue(
      issues,
      "incomplete_fx_evidence",
      "Header exchange-rate ID is present without a complete line-level original-amount trail.",
    );
  }

  if (issues.length > 0) {
    return { valid: false, value: null, issues, snapshotDigest };
  }
  return {
    valid: true,
    value: {
      header,
      lines,
      debitTotal: formatMoneyUnits(debitTotal),
      creditTotal: formatMoneyUnits(creditTotal),
      effectiveCurrency: header.transactionCurrency ?? header.functionalCurrency,
      snapshotDigest,
    },
    issues: [],
  };
}

export function validateLegacySurvivorPair(
  survivor: LegacySurvivorFacts,
  deleted: ValidatedLegacySnapshot,
): LegacyValidationIssue[] {
  const issues: LegacyValidationIssue[] = [];
  const survivorDebit = moneyUnits(survivor.debitTotal);
  const survivorCredit = moneyUnits(survivor.creditTotal);
  const survivorTotal = moneyUnits(survivor.totalAmount);
  const deletedTotal = moneyUnits(deleted.header.totalAmount);

  if (survivor.organizationId !== deleted.header.organizationId) {
    pushIssue(
      issues,
      "survivor_organization_mismatch",
      "Surviving and deleted journals belong to different organizations.",
    );
  }
  if (survivor.status !== "posted") {
    pushIssue(issues, "survivor_not_posted", "Surviving legacy journal is not posted.");
  }
  if (survivor.duplicateOfHeaderId !== null) {
    pushIssue(
      issues,
      "survivor_already_suppressed",
      "Surviving journal is already suppressed by another duplicate merge.",
    );
  }
  if (!survivor.isMatched) {
    pushIssue(
      issues,
      "survivor_not_legacy_matched",
      "Surviving journal no longer carries the legacy matched flag.",
    );
  }
  if (survivor.matchedFromIds.length !== 1 || survivor.matchedFromIds[0] !== deleted.header.id) {
    pushIssue(
      issues,
      "legacy_linkage_mismatch",
      "Surviving journal does not point exclusively to this deleted snapshot.",
    );
  }
  if (
    survivorDebit === null ||
    survivorCredit === null ||
    survivorDebit <= 0n ||
    survivorDebit !== survivorCredit
  ) {
    pushIssue(
      issues,
      "unbalanced_survivor",
      "Surviving journal must be non-zero and exactly balanced.",
    );
  }
  if (survivorTotal === null || survivorDebit === null || survivorTotal !== survivorDebit) {
    pushIssue(
      issues,
      "survivor_total_mismatch",
      "Surviving journal cached total does not equal its line totals.",
    );
  }
  if (survivorTotal === null || deletedTotal === null || survivorTotal !== deletedTotal) {
    pushIssue(
      issues,
      "legacy_amount_mismatch",
      "Surviving and deleted journals no longer have exactly matching amounts.",
    );
  }
  const survivorCurrency = survivor.transactionCurrency ?? survivor.functionalCurrency;
  if (survivorCurrency !== deleted.effectiveCurrency) {
    pushIssue(
      issues,
      "legacy_currency_mismatch",
      "Surviving and deleted journals do not have the same effective currency.",
    );
  }
  if (
    survivor.transactionType !== deleted.header.transactionType ||
    survivor.transactionType === "transfer"
  ) {
    pushIssue(
      issues,
      "legacy_direction_mismatch",
      "Journal types must match exactly and transfers cannot be converted automatically.",
    );
  }
  const fallbackEventClass = (
    source: LegacyDeletedHeaderSnapshot["source"],
    transactionType: LegacyDeletedHeaderSnapshot["transactionType"],
  ): string => {
    if (source === "bill") return "bill_accrual";
    if (source === "invoice") return "invoice_accrual";
    if (source === "payment") {
      return transactionType === "pay_in" ? "invoice_payment" : "bill_payment";
    }
    if (transactionType === "pay_in") return "sale";
    if (transactionType === "pay_out") return "purchase";
    if (transactionType === "transfer") return "transfer";
    return "other";
  };
  const leftClass = fallbackEventClass(survivor.source, survivor.transactionType);
  const rightClass = fallbackEventClass(deleted.header.source, deleted.header.transactionType);
  const classPair = new Set([leftClass, rightClass]);
  const compatibleEventClass =
    leftClass !== "transfer" &&
    rightClass !== "transfer" &&
    (leftClass === rightClass ||
      leftClass === "other" ||
      rightClass === "other" ||
      (classPair.has("purchase") && classPair.has("bill_accrual")) ||
      (classPair.has("sale") && classPair.has("invoice_accrual")));
  if (!compatibleEventClass) {
    pushIssue(
      issues,
      "legacy_event_class_mismatch",
      `Economic event classes ${leftClass} and ${rightClass} cannot be duplicate-merged safely.`,
    );
  }
  return issues;
}
