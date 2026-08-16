export const EMAIL_ATTACHMENT_EXTRACTION_VERSION = 1;

export interface ReusableEmailExtractionDocument {
  metadata?: {
    inboxExtraction?: ({ version?: unknown } & Record<string, unknown>) | null;
    billOcr?: { result?: unknown } | null;
    extractedAmount?: unknown;
    extractedDate?: unknown;
    extractedVendor?: unknown;
    extractedInvoiceNumber?: unknown;
  } | null;
  aiTransactionCache?: { result?: unknown } | null;
}

/** Decide whether stored extraction facts are complete enough for matching. */
export function hasReusableEmailAttachmentExtraction(
  document: ReusableEmailExtractionDocument,
): boolean {
  if (document.metadata?.inboxExtraction?.version === EMAIL_ATTACHMENT_EXTRACTION_VERSION) {
    return true;
  }
  if (document.metadata?.billOcr?.result || document.aiTransactionCache?.result) return true;
  return Boolean(
    document.metadata?.extractedAmount &&
    document.metadata.extractedDate &&
    (document.metadata.extractedVendor || document.metadata.extractedInvoiceNumber),
  );
}
