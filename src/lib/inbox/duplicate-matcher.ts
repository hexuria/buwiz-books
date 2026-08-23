import { createHash } from "node:crypto";

export const DUPLICATE_MATCHER_VERSION = 1;
export const DEFAULT_DUPLICATE_MATCH_WINDOW_DAYS = 3;
export const DEFAULT_DUPLICATE_BLOCKING_SCORE = 70;
export const DEFAULT_DUPLICATE_SHADOW_SCORE = 50;
export const DEFAULT_RELATED_AMOUNT_TOLERANCE_BPS = 200;

export const ECONOMIC_EVENT_CLASSES = [
  "purchase",
  "sale",
  "bill_accrual",
  "bill_payment",
  "invoice_accrual",
  "invoice_payment",
  "transfer",
  "payroll",
  "other",
] as const;

export type EconomicEventClass = (typeof ECONOMIC_EVENT_CLASSES)[number];
export type TransactionDirection = "inflow" | "outflow" | "neutral" | "unknown";
export type SourceRecordMatchState = "active" | "rejected" | "superseded";
export type DuplicateMatchClass = "duplicate" | "related" | "none";
export type DuplicateDisposition = "blocking" | "shadow" | "none";

export interface DuplicateMatcherInput {
  sourceRecordId?: string | null;
  economicEventClass?: EconomicEventClass | null;
  direction?: TransactionDirection | null;
  originalAmount?: string | null;
  originalCurrency?: string | null;
  effectiveDate?: string | null;
  party?: string | null;
  normalizedParty?: string | null;
  reference?: string | null;
  normalizedReference?: string | null;
  description?: string | null;
  provider?: string | null;
  sourceAccountRef?: string | null;
  documentHashes?: readonly string[] | null;
  documentContentHashes?: readonly string[] | null;
  recordState?: SourceRecordMatchState | null;
}

export interface NormalizedDuplicateMatcherInput {
  sourceRecordId: string | null;
  economicEventClass: EconomicEventClass;
  direction: TransactionDirection;
  originalAmount: string | null;
  originalCurrency: string | null;
  minorAmount: string | null;
  effectiveDate: string | null;
  normalizedParty: string | null;
  normalizedReference: string | null;
  normalizedDescription: string | null;
  normalizedProvider: string | null;
  normalizedSourceAccountRef: string | null;
  documentHashes: string[];
  recordState: SourceRecordMatchState;
  inputHash: string;
}

export interface DuplicateMatcherConfig {
  matchWindowDays?: number;
  blockingScore?: number;
  shadowScore?: number;
  relatedAmountToleranceBps?: number;
  algorithmVersion?: number;
}

export interface DuplicateSignalBreakdown {
  identicalDocument: boolean;
  exactReference: boolean;
  distinctStrongReferences: boolean;
  exactParty: boolean;
  exactSourceAccount: boolean;
  dateDifferenceDays: number | null;
  dateScore: number;
  descriptionSimilarity: number;
  descriptionScore: number;
  amountsEqual: boolean;
  currenciesEqual: boolean;
  amountDifferenceIsSlight: boolean;
}

export interface DuplicateMatchResult {
  eligible: boolean;
  matchClass: DuplicateMatchClass;
  disposition: DuplicateDisposition;
  score: number;
  reason:
    | "exact_document"
    | "candidate_duplicate"
    | "related_activity"
    | "same_source_record"
    | "inactive_source"
    | "opposite_direction"
    | "direction_missing"
    | "incompatible_event_class"
    | "transfer_excluded"
    | "distinct_reference"
    | "date_missing"
    | "outside_date_window"
    | "amount_missing"
    | "amount_mismatch"
    | "currency_mismatch"
    | "missing_currency"
    | "insufficient_identity";
  signals: DuplicateSignalBreakdown;
  algorithmVersion: number;
  leftInputHash: string;
  rightInputHash: string;
}

export interface DuplicateCandidateMatch<T extends DuplicateMatcherInput = DuplicateMatcherInput> {
  candidate: T;
  result: DuplicateMatchResult;
}

const ZERO_DECIMAL_CURRENCIES = new Set([
  "BIF",
  "CLP",
  "DJF",
  "GNF",
  "ISK",
  "JPY",
  "KMF",
  "KRW",
  "PYG",
  "RWF",
  "UGX",
  "VND",
  "VUV",
  "XAF",
  "XOF",
  "XPF",
]);

const THREE_DECIMAL_CURRENCIES = new Set(["BHD", "IQD", "JOD", "KWD", "LYD", "OMR", "TND"]);

const GENERIC_REFERENCES = new Set([
  "bill",
  "invoice",
  "none",
  "null",
  "payment",
  "purchase",
  "receipt",
  "unknown",
]);

const DESCRIPTION_STOP_WORDS = new Set([
  "and",
  "bill",
  "for",
  "from",
  "invoice",
  "payment",
  "purchase",
  "receipt",
  "the",
  "transaction",
  "with",
]);

const EMPTY_SIGNALS: DuplicateSignalBreakdown = {
  identicalDocument: false,
  exactReference: false,
  distinctStrongReferences: false,
  exactParty: false,
  exactSourceAccount: false,
  dateDifferenceDays: null,
  dateScore: 0,
  descriptionSimilarity: 0,
  descriptionScore: 0,
  amountsEqual: false,
  currenciesEqual: false,
  amountDifferenceIsSlight: false,
};

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function roundScore(value: number): number {
  return Math.round(clamp(value, 0, 100) * 100) / 100;
}

function normalizedConfig(config: DuplicateMatcherConfig) {
  const blockingScore = clamp(config.blockingScore ?? DEFAULT_DUPLICATE_BLOCKING_SCORE, 0, 100);
  const shadowScore = clamp(config.shadowScore ?? DEFAULT_DUPLICATE_SHADOW_SCORE, 0, blockingScore);
  return {
    matchWindowDays: Math.trunc(
      clamp(config.matchWindowDays ?? DEFAULT_DUPLICATE_MATCH_WINDOW_DAYS, 0, 31),
    ),
    blockingScore,
    shadowScore,
    relatedAmountToleranceBps: Math.trunc(
      clamp(config.relatedAmountToleranceBps ?? DEFAULT_RELATED_AMOUNT_TOLERANCE_BPS, 0, 10_000),
    ),
    algorithmVersion: Math.max(1, Math.trunc(config.algorithmVersion ?? DUPLICATE_MATCHER_VERSION)),
  };
}

function normalizeText(value: string | null | undefined): string | null {
  const normalized = value
    ?.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
  return normalized || null;
}

export function normalizeParty(value: string | null | undefined): string | null {
  const normalized = normalizeText(value);
  if (!normalized) return null;
  const withoutSuffix = normalized
    .replace(/\s+(?:co|company|corp|corporation|gmbh|inc|incorporated|limited|llc|ltd|plc)$/u, "")
    .trim();
  return withoutSuffix || normalized;
}

export function normalizeReference(value: string | null | undefined): string | null {
  const normalized = normalizeText(value)?.replace(/\s+/g, "") ?? null;
  return normalized || null;
}

export function normalizeDescription(value: string | null | undefined): string | null {
  return normalizeText(value);
}

export function normalizeCurrency(value: string | null | undefined): string | null {
  const normalized = value?.trim().toUpperCase() ?? "";
  return /^[A-Z]{3}$/.test(normalized) ? normalized : null;
}

export function currencyDecimalPlaces(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}

export function normalizeAmountForCurrency(
  amount: string | null | undefined,
  currency: string | null | undefined,
): string | null {
  const normalizedCurrency = normalizeCurrency(currency);
  const minorUnits = amountToMinorUnits(amount, normalizedCurrency);
  if (!normalizedCurrency || minorUnits === null) return null;
  return minorUnitsToAmount(minorUnits, normalizedCurrency);
}

/**
 * Converts a decimal amount to absolute ISO-currency minor units without using
 * floating-point arithmetic. Additional decimals are rounded half away from zero.
 */
export function amountToMinorUnits(
  amount: string | null | undefined,
  currency: string | null | undefined,
): bigint | null {
  const normalizedCurrency = normalizeCurrency(currency);
  if (!amount || !normalizedCurrency) return null;
  const normalizedAmount = amount.trim().replace(/,/g, "");
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(normalizedAmount);
  if (!match) return null;

  const decimalPlaces = currencyDecimalPlaces(normalizedCurrency);
  const whole = BigInt(match[2]);
  const fraction = match[3] ?? "";
  const retained = fraction.slice(0, decimalPlaces).padEnd(decimalPlaces, "0");
  const firstDiscarded = fraction.at(decimalPlaces) ?? "0";
  const multiplier = 10n ** BigInt(decimalPlaces);
  let minorUnits = whole * multiplier + BigInt(retained || "0");
  if (firstDiscarded >= "5") minorUnits += 1n;
  return minorUnits < 0n ? -minorUnits : minorUnits;
}

function minorUnitsToAmount(minorUnits: bigint, currency: string): string {
  const decimalPlaces = currencyDecimalPlaces(currency);
  if (decimalPlaces === 0) return minorUnits.toString();
  const digits = minorUnits.toString().padStart(decimalPlaces + 1, "0");
  const separatorIndex = digits.length - decimalPlaces;
  return `${digits.slice(0, separatorIndex)}.${digits.slice(separatorIndex)}`;
}

function normalizeDocumentHashes(input: DuplicateMatcherInput): string[] {
  return [
    ...new Set(
      [...(input.documentHashes ?? []), ...(input.documentContentHashes ?? [])]
        .map((hash) => hash.trim().toLowerCase())
        .filter(Boolean),
    ),
  ].sort();
}

function stableInputHash(input: Omit<NormalizedDuplicateMatcherInput, "inputHash">): string {
  const { sourceRecordId: _sourceRecordId, ...matchRelevantInput } = input;
  return createHash("sha256").update(JSON.stringify(matchRelevantInput)).digest("hex");
}

export function normalizeDuplicateMatchInput(
  input: DuplicateMatcherInput,
): NormalizedDuplicateMatcherInput {
  const originalCurrency = normalizeCurrency(input.originalCurrency);
  const originalAmount = normalizeAmountForCurrency(input.originalAmount, originalCurrency);
  const minorAmount = amountToMinorUnits(originalAmount, originalCurrency);
  const withoutHash: Omit<NormalizedDuplicateMatcherInput, "inputHash"> = {
    sourceRecordId: input.sourceRecordId?.trim() || null,
    economicEventClass: input.economicEventClass ?? "other",
    direction: input.direction ?? "unknown",
    originalAmount,
    originalCurrency,
    minorAmount: minorAmount?.toString() ?? null,
    effectiveDate: normalizeDate(input.effectiveDate),
    normalizedParty: normalizeParty(input.normalizedParty ?? input.party),
    normalizedReference: normalizeReference(input.normalizedReference ?? input.reference),
    normalizedDescription: normalizeDescription(input.description),
    normalizedProvider: normalizeText(input.provider),
    normalizedSourceAccountRef: normalizeText(input.sourceAccountRef),
    documentHashes: normalizeDocumentHashes(input),
    recordState: input.recordState ?? "active",
  };
  return { ...withoutHash, inputHash: stableInputHash(withoutHash) };
}

function normalizeDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function dateDifferenceDays(left: string, right: string): number {
  const leftTime = new Date(`${left}T00:00:00.000Z`).getTime();
  const rightTime = new Date(`${right}T00:00:00.000Z`).getTime();
  return Math.round(Math.abs(leftTime - rightTime) / 86_400_000);
}

function descriptionTokens(value: string | null): Set<string> {
  return new Set(
    (normalizeDescription(value) ?? "")
      .split(" ")
      .filter((token) => token.length > 2 && !DESCRIPTION_STOP_WORDS.has(token)),
  );
}

export function descriptionSimilarity(left: string | null, right: string | null): number {
  const leftTokens = descriptionTokens(left);
  const rightTokens = descriptionTokens(right);
  if (leftTokens.size === 0 || rightTokens.size === 0) return 0;
  const intersection = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  const union = new Set([...leftTokens, ...rightTokens]).size;
  return Math.round((intersection / union) * 10_000) / 10_000;
}

function isStrongReference(value: string | null): boolean {
  return Boolean(
    value && value.length >= 4 && /\d/.test(value) && !GENERIC_REFERENCES.has(value.toLowerCase()),
  );
}

function directionsConflict(left: TransactionDirection, right: TransactionDirection): boolean {
  return (left === "inflow" && right === "outflow") || (left === "outflow" && right === "inflow");
}

function eventCompatibility(
  left: EconomicEventClass,
  right: EconomicEventClass,
): { compatible: boolean; reason: "incompatible_event_class" | "transfer_excluded" | null } {
  if (left === "transfer" || right === "transfer") {
    return { compatible: false, reason: "transfer_excluded" };
  }
  const pair = new Set([left, right]);
  if (
    (pair.has("bill_accrual") && pair.has("bill_payment")) ||
    (pair.has("invoice_accrual") && pair.has("invoice_payment"))
  ) {
    return { compatible: false, reason: "incompatible_event_class" };
  }
  if (left === right || left === "other" || right === "other") {
    return { compatible: true, reason: null };
  }
  if (pair.has("purchase") && pair.has("bill_accrual")) {
    return { compatible: true, reason: null };
  }
  if (pair.has("sale") && pair.has("invoice_accrual")) {
    return { compatible: true, reason: null };
  }
  return { compatible: false, reason: "incompatible_event_class" };
}

function hasIdenticalDocument(
  left: NormalizedDuplicateMatcherInput,
  right: NormalizedDuplicateMatcherInput,
): boolean {
  if (left.documentHashes.length === 0 || right.documentHashes.length === 0) return false;
  const rightHashes = new Set(right.documentHashes);
  return left.documentHashes.some((hash) => rightHashes.has(hash));
}

function slightAmountDifference(left: bigint, right: bigint, toleranceBps: number): boolean {
  if (left === right) return true;
  const difference = left > right ? left - right : right - left;
  const maximum = left > right ? left : right;
  if (maximum === 0n) return false;
  return difference * 10_000n <= maximum * BigInt(toleranceBps);
}

function emptyResult(
  left: NormalizedDuplicateMatcherInput,
  right: NormalizedDuplicateMatcherInput,
  algorithmVersion: number,
  reason: DuplicateMatchResult["reason"],
  signals: DuplicateSignalBreakdown = EMPTY_SIGNALS,
): DuplicateMatchResult {
  return {
    eligible: false,
    matchClass: "none",
    disposition: "none",
    score: 0,
    reason,
    signals: { ...signals },
    algorithmVersion,
    leftInputHash: left.inputHash,
    rightInputHash: right.inputHash,
  };
}

export function scoreDuplicatePair(
  leftInput: DuplicateMatcherInput,
  rightInput: DuplicateMatcherInput,
  config: DuplicateMatcherConfig = {},
): DuplicateMatchResult {
  const settings = normalizedConfig(config);
  const left = normalizeDuplicateMatchInput(leftInput);
  const right = normalizeDuplicateMatchInput(rightInput);

  if (left.sourceRecordId && right.sourceRecordId && left.sourceRecordId === right.sourceRecordId) {
    return emptyResult(left, right, settings.algorithmVersion, "same_source_record");
  }
  if (left.recordState !== "active" || right.recordState !== "active") {
    return emptyResult(left, right, settings.algorithmVersion, "inactive_source");
  }
  if (directionsConflict(left.direction, right.direction)) {
    return emptyResult(left, right, settings.algorithmVersion, "opposite_direction");
  }
  const compatibility = eventCompatibility(left.economicEventClass, right.economicEventClass);
  if (!compatibility.compatible) {
    return emptyResult(
      left,
      right,
      settings.algorithmVersion,
      compatibility.reason ?? "incompatible_event_class",
    );
  }

  const identicalDocument = hasIdenticalDocument(left, right);
  if (identicalDocument) {
    return {
      eligible: true,
      matchClass: "duplicate",
      disposition: "blocking",
      score: 100,
      reason: "exact_document",
      signals: { ...EMPTY_SIGNALS, identicalDocument: true },
      algorithmVersion: settings.algorithmVersion,
      leftInputHash: left.inputHash,
      rightInputHash: right.inputHash,
    };
  }

  if (
    !["inflow", "outflow"].includes(left.direction) ||
    !["inflow", "outflow"].includes(right.direction)
  ) {
    return emptyResult(left, right, settings.algorithmVersion, "direction_missing");
  }

  const exactReference = Boolean(
    left.normalizedReference &&
    right.normalizedReference &&
    left.normalizedReference === right.normalizedReference,
  );
  const distinctStrongReferences = Boolean(
    left.normalizedReference &&
    right.normalizedReference &&
    left.normalizedReference !== right.normalizedReference &&
    isStrongReference(left.normalizedReference) &&
    isStrongReference(right.normalizedReference),
  );
  const exactParty = Boolean(
    left.normalizedParty && right.normalizedParty && left.normalizedParty === right.normalizedParty,
  );
  const exactSourceAccount = Boolean(
    left.normalizedProvider &&
    right.normalizedProvider &&
    left.normalizedProvider === right.normalizedProvider &&
    left.normalizedSourceAccountRef &&
    right.normalizedSourceAccountRef &&
    left.normalizedSourceAccountRef === right.normalizedSourceAccountRef,
  );
  const similarity = descriptionSimilarity(left.normalizedDescription, right.normalizedDescription);
  const descriptionScore = roundScore(similarity * 20);
  const signals: DuplicateSignalBreakdown = {
    ...EMPTY_SIGNALS,
    exactReference,
    distinctStrongReferences,
    exactParty,
    exactSourceAccount,
    descriptionSimilarity: similarity,
    descriptionScore,
  };

  if (distinctStrongReferences) {
    return emptyResult(left, right, settings.algorithmVersion, "distinct_reference", signals);
  }
  if (!left.effectiveDate || !right.effectiveDate) {
    return emptyResult(left, right, settings.algorithmVersion, "date_missing", signals);
  }
  const differenceDays = dateDifferenceDays(left.effectiveDate, right.effectiveDate);
  signals.dateDifferenceDays = differenceDays;
  if (differenceDays > settings.matchWindowDays) {
    return emptyResult(left, right, settings.algorithmVersion, "outside_date_window", signals);
  }
  signals.dateScore = Math.max(0, 15 - differenceDays * 5);

  if (!left.originalCurrency || !right.originalCurrency) {
    // ABSENT currency is not a MISMATCH — the old label sent operators
    // hunting a currency conflict that did not exist (audit P8).
    return emptyResult(left, right, settings.algorithmVersion, "missing_currency", signals);
  }
  const currenciesEqual = left.originalCurrency === right.originalCurrency;
  signals.currenciesEqual = currenciesEqual;
  if (!left.minorAmount || !right.minorAmount) {
    return emptyResult(left, right, settings.algorithmVersion, "amount_missing", signals);
  }
  const leftMinorAmount = BigInt(left.minorAmount);
  const rightMinorAmount = BigInt(right.minorAmount);
  const amountsEqual = currenciesEqual && leftMinorAmount === rightMinorAmount;
  signals.amountsEqual = amountsEqual;
  signals.amountDifferenceIsSlight =
    currenciesEqual &&
    slightAmountDifference(leftMinorAmount, rightMinorAmount, settings.relatedAmountToleranceBps);

  let score = 0;
  if (exactReference) score += 40;
  if (exactParty) score += 20;
  score += signals.dateScore;
  score += descriptionScore;
  if (exactSourceAccount) score += 10;
  score = roundScore(score);

  const hasIdentitySignal =
    exactReference || exactParty || exactSourceAccount || similarity >= 0.25;
  if (!hasIdentitySignal) {
    return {
      ...emptyResult(left, right, settings.algorithmVersion, "insufficient_identity", signals),
      eligible: true,
      score,
    };
  }

  if (amountsEqual) {
    // D4 (checkpoint C8, recorded product call): without a reference number
    // the reachable score (party 20 + date 15 + description ≤20 + source 10)
    // cannot hit the blocking threshold of 70 — the same receipt captured
    // twice through two channels never blocked. Exact amount + SAME DAY +
    // exact party with NO reference on either side is deterministic enough
    // to block; the threshold itself stays 70 for every scored path.
    const noReferenceStrongCombo =
      exactParty && differenceDays === 0 && !left.normalizedReference && !right.normalizedReference;
    const disposition: DuplicateDisposition = noReferenceStrongCombo
      ? "blocking"
      : score >= settings.blockingScore
        ? "blocking"
        : score >= settings.shadowScore
          ? "shadow"
          : "none";
    return {
      eligible: true,
      matchClass: disposition === "none" ? "none" : "duplicate",
      disposition,
      score,
      reason: disposition === "none" ? "insufficient_identity" : "candidate_duplicate",
      signals,
      algorithmVersion: settings.algorithmVersion,
      leftInputHash: left.inputHash,
      rightInputHash: right.inputHash,
    };
  }

  const strongRelatedIdentity =
    exactReference ||
    (exactParty && similarity >= 0.5) ||
    (exactSourceAccount && similarity >= 0.5);
  if (!strongRelatedIdentity || (currenciesEqual && !signals.amountDifferenceIsSlight)) {
    return emptyResult(
      left,
      right,
      settings.algorithmVersion,
      currenciesEqual ? "amount_mismatch" : "currency_mismatch",
      signals,
    );
  }

  const relatedScore = Math.min(69, score);
  return {
    eligible: true,
    matchClass: relatedScore >= settings.shadowScore ? "related" : "none",
    disposition: relatedScore >= settings.shadowScore ? "shadow" : "none",
    score: relatedScore,
    reason: relatedScore >= settings.shadowScore ? "related_activity" : "insufficient_identity",
    signals,
    algorithmVersion: settings.algorithmVersion,
    leftInputHash: left.inputHash,
    rightInputHash: right.inputHash,
  };
}

/**
 * Pure worker/service entry point for re-running one source after extraction,
 * correction, provider update, or attachment. Callers persist only returned
 * matches; this function never selects canonical records or mutates accounting.
 */
export function matchSourceAgainstCandidates<T extends DuplicateMatcherInput>(
  source: DuplicateMatcherInput,
  candidates: readonly T[],
  config: DuplicateMatcherConfig = {},
): DuplicateCandidateMatch<T>[] {
  return candidates.flatMap((candidate) => {
    const result = scoreDuplicatePair(source, candidate, config);
    return result.matchClass === "none" ? [] : [{ candidate, result }];
  });
}

export function canonicalizeSourcePair(
  leftSourceRecordId: string,
  rightSourceRecordId: string,
): { leftSourceRecordId: string; rightSourceRecordId: string } {
  if (leftSourceRecordId === rightSourceRecordId) {
    throw new Error("A duplicate case requires two distinct source records.");
  }
  return leftSourceRecordId < rightSourceRecordId
    ? { leftSourceRecordId, rightSourceRecordId }
    : {
        leftSourceRecordId: rightSourceRecordId,
        rightSourceRecordId: leftSourceRecordId,
      };
}
