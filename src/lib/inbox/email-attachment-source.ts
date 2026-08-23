import { createHash } from "node:crypto";
import {
  DUPLICATE_MATCHER_VERSION,
  normalizeCurrency,
  normalizeDuplicateMatchInput,
  type EconomicEventClass,
  type TransactionDirection,
} from "./duplicate-matcher";

interface CachedDocumentData {
  documentType?: string | null;
  contentHash?: string | null;
  metadata?: {
    extractedDate?: string;
    extractedAmount?: string;
    extractedVendor?: string;
    extractedInvoiceNumber?: string;
    billOcr?: {
      result: Record<string, unknown>;
    };
    inboxExtraction?: {
      result: Record<string, unknown>;
      version?: number;
    };
  } | null;
  aiTransactionCache?: {
    result: Record<string, unknown>;
  } | null;
}

export interface EmailAttachmentSourceInput {
  emailId: string;
  attachmentId: string;
  filename: string;
  contentType: string;
  attachmentDocumentType: string;
  document: CachedDocumentData;
  fallbackDate?: string | null;
  originalCurrency?: string | null;
  functionalCurrency?: string | null;
}

export interface DocumentSourceInput {
  externalId: string;
  provider: string;
  externalVersion?: string;
  filename: string;
  documentType: string;
  document: CachedDocumentData;
  fallbackDate?: string | null;
  originalCurrency?: string | null;
  functionalCurrency?: string | null;
}

export interface DocumentSourceFacts {
  externalId: string;
  externalVersion: string;
  transactionDate: string | null;
  description: string;
  amount: string | null;
  currency: string | null;
  economicEventClass: EconomicEventClass;
  direction: TransactionDirection;
  originalAmount: string | null;
  originalCurrency: string | null;
  functionalAmount: string | null;
  functionalCurrency: string | null;
  effectiveDate: string | null;
  normalizedParty: string | null;
  normalizedReference: string | null;
  sourceAccountRef: string | null;
  matcherInputHash: string;
  matcherVersion: number;
  extractedFrom: string[];
}

export type EmailAttachmentSourceFacts = DocumentSourceFacts;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return normalized || null;
}

function validDate(value: unknown): string | null {
  const candidate = nonEmptyString(value);
  if (!candidate || !/^\d{4}-\d{2}-\d{2}$/.test(candidate)) return null;
  const parsed = new Date(`${candidate}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== candidate) {
    return null;
  }
  return candidate;
}

function decimalAmount(value: unknown): string | null {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return null;
    const rendered = Math.abs(value).toString();
    // toString() emits exponential notation outside ~1e-7..1e21, which the
    // downstream money parser rejects opaquely (audit P8). Amounts that
    // extreme are garbage extraction anyway — refuse rather than mangle.
    return rendered.includes("e") ? null : rendered;
  }
  const raw = nonEmptyString(value);
  if (!raw) return null;
  const negativeParentheses = /^\(.*\)$/.test(raw);
  let normalized = raw.replace(/[()\s]/g, "").replace(/^\+/, "");
  // European decimal comma: "1.234,56" (dot-grouped, comma-decimal) — the
  // old strip removed the comma and produced 1.23456 (audit P8). Detect the
  // shape before touching separators.
  if (/^-?\d{1,3}(?:\.\d{3})+,\d{1,2}$/.test(normalized)) {
    normalized = normalized.replace(/\./g, "").replace(",", ".");
  } else if (/^-?\d+,\d{1,2}$/.test(normalized)) {
    // Bare comma-decimal: "1234,56".
    normalized = normalized.replace(",", ".");
  }
  const stripped = normalized.replace(/,/g, "").replace(/[^\d.+-]/g, "");
  if (!/^-?\d+(?:\.\d+)?$/.test(stripped)) return null;
  const absolute = (negativeParentheses ? stripped.replace(/^-/, "") : stripped).replace(/^-/, "");
  return absolute || null;
}

function first<T>(values: readonly T[]): T | null {
  return values.find((value) => value !== null && value !== undefined) ?? null;
}

function classify(
  documentType: string,
  transactionType: string | null,
): { economicEventClass: EconomicEventClass; direction: TransactionDirection } {
  if (transactionType === "transfer") {
    return { economicEventClass: "transfer", direction: "neutral" };
  }
  if (transactionType === "pay_in") {
    return {
      economicEventClass: documentType === "invoice" ? "invoice_accrual" : "sale",
      direction: "inflow",
    };
  }
  if (transactionType === "pay_out") {
    return {
      economicEventClass:
        documentType === "bill" || documentType === "invoice" ? "bill_accrual" : "purchase",
      direction: "outflow",
    };
  }
  if (documentType === "bill" || documentType === "invoice") {
    return { economicEventClass: "bill_accrual", direction: "outflow" };
  }
  if (documentType === "receipt") {
    return { economicEventClass: "purchase", direction: "outflow" };
  }
  if (documentType === "payslip") {
    return { economicEventClass: "payroll", direction: "outflow" };
  }
  return { economicEventClass: "other", direction: "unknown" };
}

function directionForEventClass(
  economicEventClass: EconomicEventClass,
  fallback: TransactionDirection,
): TransactionDirection {
  if (["purchase", "bill_accrual", "bill_payment", "payroll"].includes(economicEventClass)) {
    return "outflow";
  }
  if (["sale", "invoice_accrual", "invoice_payment"].includes(economicEventClass)) {
    return "inflow";
  }
  if (economicEventClass === "transfer") return "neutral";
  return fallback;
}

/**
 * Resend attachment IDs are provider-scoped but can be long. Hashing the immutable
 * email/attachment identity gives us a compact logical external ID that is stable
 * across worker retries and independent of the attachment bytes.
 */
export function emailAttachmentExternalId(emailId: string, attachmentId: string): string {
  const digest = createHash("sha256").update(`${emailId}\0${attachmentId}`).digest("hex");
  return `resend-attachment:${digest}`;
}

/**
 * The document bytes are already content-addressed per organization, so their
 * hash is the stable logical identity for retry-safe standalone intake.
 */
export function standaloneDocumentExternalId(
  document: Pick<CachedDocumentData, "contentHash"> & { id: string },
): string {
  return `document-upload:${document.contentHash ?? document.id}`;
}

/**
 * Build matcher facts using only extraction already cached on the canonical
 * document. Any model call happens in the separate cache-population service.
 */
export function deriveDocumentSourceFacts(input: DocumentSourceInput): DocumentSourceFacts {
  const metadata = input.document.metadata ?? null;
  const inboxResult = record(metadata?.inboxExtraction?.result);
  const billResult = record(metadata?.billOcr?.result);
  const billVendor = record(billResult?.vendor);
  const billInvoice = record(billResult?.invoice);
  const transactionResult = record(input.document.aiTransactionCache?.result);

  const cachedSubtype = nonEmptyString(transactionResult?.documentSubtype);
  const storedType = nonEmptyString(input.document.documentType);
  const documentType =
    first([
      cachedSubtype,
      storedType && storedType !== "other" ? storedType : null,
      input.documentType,
    ]) ?? "other";
  const transactionType = nonEmptyString(transactionResult?.transactionType);
  const inferredClassification = classify(documentType, transactionType);
  const extractedEventClass = nonEmptyString(inboxResult?.economicEventClass);
  const extractedDirection = nonEmptyString(inboxResult?.direction);
  const economicEventClass =
    extractedEventClass &&
    [
      "purchase",
      "sale",
      "bill_accrual",
      "bill_payment",
      "invoice_accrual",
      "invoice_payment",
      "transfer",
      "payroll",
      "other",
    ].includes(extractedEventClass)
      ? (extractedEventClass as EconomicEventClass)
      : inferredClassification.economicEventClass;
  const extractedOrInferredDirection =
    extractedDirection && ["inflow", "outflow", "neutral", "unknown"].includes(extractedDirection)
      ? (extractedDirection as TransactionDirection)
      : inferredClassification.direction;
  const classification = {
    economicEventClass,
    direction: directionForEventClass(economicEventClass, extractedOrInferredDirection),
  };

  const transactionDate = first([
    validDate(inboxResult?.date),
    validDate(metadata?.extractedDate),
    validDate(billInvoice?.invoiceDate),
    validDate(transactionResult?.date),
    validDate(input.fallbackDate),
  ]);
  const amount = first([
    decimalAmount(inboxResult?.amount),
    decimalAmount(metadata?.extractedAmount),
    decimalAmount(billInvoice?.amount),
    decimalAmount(transactionResult?.amount),
  ]);
  const party = first([
    nonEmptyString(inboxResult?.party),
    nonEmptyString(metadata?.extractedVendor),
    nonEmptyString(billVendor?.name),
    nonEmptyString(transactionResult?.partyName),
  ]);
  const reference = first([
    nonEmptyString(inboxResult?.reference),
    nonEmptyString(metadata?.extractedInvoiceNumber),
    nonEmptyString(billInvoice?.invoiceNumber),
    nonEmptyString(transactionResult?.referenceNumber),
  ]);
  const description =
    first([
      nonEmptyString(inboxResult?.description),
      nonEmptyString(transactionResult?.memo),
      nonEmptyString(billInvoice?.notes),
      nonEmptyString(input.filename),
    ]) ?? "Inbound email attachment";
  const originalCurrency =
    normalizeCurrency(nonEmptyString(inboxResult?.currency)) ??
    normalizeCurrency(input.originalCurrency);
  const functionalCurrency = normalizeCurrency(input.functionalCurrency);
  const sourceAccountRef =
    transactionResult?.extractedEntities && Array.isArray(transactionResult.extractedEntities)
      ? first(
          transactionResult.extractedEntities.map((entity) =>
            nonEmptyString(record(entity)?.identifier),
          ),
        )
      : null;
  const normalized = normalizeDuplicateMatchInput({
    economicEventClass: classification.economicEventClass,
    direction: classification.direction,
    originalAmount: amount,
    originalCurrency,
    effectiveDate: transactionDate,
    party,
    reference,
    description,
    provider: input.provider,
    sourceAccountRef,
    documentHashes: input.document.contentHash ? [input.document.contentHash] : [],
  });
  const functionalAmount =
    normalized.originalAmount &&
    normalized.originalCurrency &&
    normalized.originalCurrency === functionalCurrency
      ? normalized.originalAmount
      : null;
  const extractedFrom = [
    ...(inboxResult ? ["inbox_extraction_cache"] : []),
    ...(metadata?.extractedDate ||
    metadata?.extractedAmount ||
    metadata?.extractedVendor ||
    metadata?.extractedInvoiceNumber
      ? ["document_metadata"]
      : []),
    ...(billResult ? ["bill_ocr_cache"] : []),
    ...(transactionResult ? ["transaction_parse_cache"] : []),
  ];

  return {
    externalId: input.externalId,
    externalVersion:
      input.externalVersion ??
      (input.document.contentHash ? `sha256:${input.document.contentHash}` : "1"),
    transactionDate,
    description,
    amount: normalized.originalAmount ?? amount,
    currency: originalCurrency,
    economicEventClass: classification.economicEventClass,
    direction: classification.direction,
    originalAmount: normalized.originalAmount,
    originalCurrency: normalized.originalCurrency,
    functionalAmount,
    functionalCurrency,
    effectiveDate: normalized.effectiveDate,
    normalizedParty: normalized.normalizedParty,
    normalizedReference: normalized.normalizedReference,
    sourceAccountRef,
    matcherInputHash: normalized.inputHash,
    matcherVersion: DUPLICATE_MATCHER_VERSION,
    extractedFrom,
  };
}

export function deriveEmailAttachmentSourceFacts(
  input: EmailAttachmentSourceInput,
): EmailAttachmentSourceFacts {
  return deriveDocumentSourceFacts({
    externalId: emailAttachmentExternalId(input.emailId, input.attachmentId),
    provider: "resend",
    filename: input.filename,
    documentType: input.attachmentDocumentType,
    document: input.document,
    fallbackDate: input.fallbackDate,
    originalCurrency: input.originalCurrency,
    functionalCurrency: input.functionalCurrency,
  });
}
