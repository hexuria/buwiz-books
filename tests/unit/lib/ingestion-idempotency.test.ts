import { describe, expect, it } from "vitest";
import { billOcrContextHash } from "@/lib/bill-ocr-cache";
import { bankCsvSourceId, hashCsvFileContent, journalCsvSourceId } from "@/lib/csv-idempotency";
import {
  contentAddressedDocumentKey,
  documentFileType,
  hashDocumentContent,
} from "@/lib/documents/ensure-document";
import {
  assertIdempotencyPayloadMatches,
  idempotencyPayloadHash,
  scopedIdempotencyUuid,
} from "@/lib/idempotency";
import {
  EMAIL_ATTACHMENT_EXTRACTION_VERSION,
  hasReusableEmailAttachmentExtraction,
} from "@/lib/inbox/email-attachment-extraction-policy";
import {
  deriveDocumentSourceFacts,
  deriveEmailAttachmentSourceFacts,
  emailAttachmentExternalId,
  standaloneDocumentExternalId,
} from "@/lib/inbox/email-attachment-source";
import { isStandaloneTransactionBearing } from "@/lib/inbox/document-intake-policy";

describe("ingestion idempotency identities", () => {
  it("uses file identity plus row ordinal so identical CSV rows remain distinct", () => {
    const fileHash = "a".repeat(64);
    expect(bankCsvSourceId(fileHash, 1)).not.toBe(bankCsvSourceId(fileHash, 2));
    expect(bankCsvSourceId(fileHash, 1)).toBe(bankCsvSourceId(fileHash, 1));
  });

  it("hashes the original file bytes rather than economic row fields", () => {
    const source = "Date,Amount,Description\n2026-07-24,100,Software\n";
    expect(hashCsvFileContent(source)).toHaveLength(64);
    expect(hashCsvFileContent(source)).toBe(hashCsvFileContent(source));
    expect(hashCsvFileContent(`${source}\n`)).not.toBe(hashCsvFileContent(source));
  });

  it("uses stable group ordinals for journal imports", () => {
    const fileHash = "b".repeat(64);
    expect(journalCsvSourceId(fileHash, 3)).toBe(`${"csv-journal:"}${fileHash}:group:3`);
    expect(journalCsvSourceId(fileHash, 3)).not.toBe(journalCsvSourceId(fileHash, 4));
  });

  it("derives stable organization-scoped UUIDs for request retries", () => {
    const key = "550e8400-e29b-41d4-a716-446655440000";
    const first = scopedIdempotencyUuid("bill:org-a", key);
    expect(first).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(scopedIdempotencyUuid("bill:org-a", key)).toBe(first);
    expect(scopedIdempotencyUuid("bill:org-b", key)).not.toBe(first);
  });

  it("binds an idempotency key to canonical request content", () => {
    const first = idempotencyPayloadHash("transaction", {
      memo: "Office supplies",
      lines: [{ debit: "25.00", accountId: "expense" }],
    });
    const reordered = idempotencyPayloadHash("transaction", {
      lines: [{ accountId: "expense", debit: "25.00" }],
      memo: "Office supplies",
    });
    const changed = idempotencyPayloadHash("transaction", {
      memo: "Different purchase",
      lines: [{ debit: "25.00", accountId: "expense" }],
    });

    expect(reordered).toBe(first);
    expect(changed).not.toBe(first);
    expect(() => assertIdempotencyPayloadMatches(first, reordered, "transaction")).not.toThrow();
    expect(() => assertIdempotencyPayloadMatches(first, changed, "transaction")).toThrow(
      "different transaction submission",
    );
  });

  it("derives a stable provider identity for each email attachment", () => {
    const first = emailAttachmentExternalId("email-123", "attachment-456");
    expect(first).toMatch(/^resend-attachment:[0-9a-f]{64}$/);
    expect(emailAttachmentExternalId("email-123", "attachment-456")).toBe(first);
    expect(emailAttachmentExternalId("email-123", "attachment-789")).not.toBe(first);
  });

  it("uses the canonical document hash as the stable standalone-upload identity", () => {
    const document = {
      id: "550e8400-e29b-41d4-a716-446655440000",
      contentHash: "e".repeat(64),
    };
    expect(standaloneDocumentExternalId(document)).toBe(`document-upload:${"e".repeat(64)}`);
    expect(standaloneDocumentExternalId(document)).toBe(standaloneDocumentExternalId(document));
    expect(
      standaloneDocumentExternalId({
        ...document,
        contentHash: "f".repeat(64),
      }),
    ).not.toBe(standaloneDocumentExternalId(document));
  });

  it("normalizes cached email extraction into matcher-ready source facts", () => {
    const contentHash = "c".repeat(64);
    const facts = deriveEmailAttachmentSourceFacts({
      emailId: "email-123",
      attachmentId: "attachment-456",
      filename: "Acme invoice.pdf",
      contentType: "application/pdf",
      attachmentDocumentType: "invoice",
      fallbackDate: "2026-07-24",
      originalCurrency: "USD",
      functionalCurrency: "USD",
      document: {
        documentType: "invoice",
        contentHash,
        metadata: {
          inboxExtraction: {
            version: 1,
            result: {
              economicEventClass: "bill_accrual",
              direction: "outflow",
              amount: "$1,234.50",
              currency: "usd",
              date: "2026-07-22",
              party: "Acme, Inc.",
              reference: " INV-0042 ",
              description: "Product subscription",
            },
          },
        },
      },
    });

    expect(facts).toMatchObject({
      externalVersion: `sha256:${contentHash}`,
      transactionDate: "2026-07-22",
      amount: "1234.50",
      currency: "USD",
      economicEventClass: "bill_accrual",
      direction: "outflow",
      originalAmount: "1234.50",
      originalCurrency: "USD",
      functionalAmount: "1234.50",
      functionalCurrency: "USD",
      effectiveDate: "2026-07-22",
      normalizedParty: "acme",
      normalizedReference: "inv0042",
      matcherVersion: 1,
      extractedFrom: ["inbox_extraction_cache"],
    });
    expect(facts.matcherInputHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses existing bill OCR facts without requiring a new extraction", () => {
    const facts = deriveEmailAttachmentSourceFacts({
      emailId: "email-123",
      attachmentId: "attachment-456",
      filename: "bill.pdf",
      contentType: "application/pdf",
      attachmentDocumentType: "bill",
      fallbackDate: "2026-07-24",
      originalCurrency: "USD",
      functionalCurrency: "USD",
      document: {
        documentType: "bill",
        contentHash: "d".repeat(64),
        metadata: {
          billOcr: {
            result: {
              vendor: { name: "Cloud Host LLC" },
              invoice: {
                invoiceNumber: "BILL-77",
                invoiceDate: "2026-07-20",
                amount: 75,
                notes: "Monthly hosting",
              },
            },
          },
        },
      },
    });

    expect(facts).toMatchObject({
      transactionDate: "2026-07-20",
      amount: "75.00",
      economicEventClass: "bill_accrual",
      direction: "outflow",
      normalizedParty: "cloud host",
      normalizedReference: "bill77",
      extractedFrom: ["bill_ocr_cache"],
    });
  });

  it("derives matcher-ready facts for a standalone upload from the shared extraction cache", () => {
    const contentHash = "9".repeat(64);
    const externalId = standaloneDocumentExternalId({
      id: "550e8400-e29b-41d4-a716-446655440000",
      contentHash,
    });
    const facts = deriveDocumentSourceFacts({
      externalId,
      provider: "document_upload",
      filename: "receipt.pdf",
      documentType: "receipt",
      fallbackDate: "2026-07-24",
      originalCurrency: "USD",
      functionalCurrency: "USD",
      document: {
        documentType: "receipt",
        contentHash,
        metadata: {
          inboxExtraction: {
            version: 1,
            result: {
              economicEventClass: "purchase",
              direction: "outflow",
              amount: "84.25",
              currency: "USD",
              date: "2026-07-23",
              party: "Workflow Vendor",
              reference: "RCPT-4242",
              description: "Team offsite supplies",
            },
          },
        },
      },
    });

    expect(facts).toMatchObject({
      externalId,
      externalVersion: `sha256:${contentHash}`,
      transactionDate: "2026-07-23",
      economicEventClass: "purchase",
      direction: "outflow",
      originalAmount: "84.25",
      originalCurrency: "USD",
      normalizedParty: "workflow vendor",
      normalizedReference: "rcpt4242",
      extractedFrom: ["inbox_extraction_cache"],
    });
  });

  it("creates standalone transaction intake only for transaction-bearing documents", () => {
    const purchaseFacts = {
      economicEventClass: "purchase" as const,
      direction: "outflow" as const,
      originalAmount: "84.25",
      effectiveDate: "2026-07-23",
    };
    expect(isStandaloneTransactionBearing("receipt", purchaseFacts)).toBe(true);
    expect(isStandaloneTransactionBearing("bill", purchaseFacts)).toBe(true);
    expect(isStandaloneTransactionBearing("invoice", purchaseFacts)).toBe(true);
    expect(isStandaloneTransactionBearing("other", purchaseFacts)).toBe(true);

    for (const documentType of ["statement", "contract", "payslip", "tax_form"]) {
      expect(isStandaloneTransactionBearing(documentType, purchaseFacts)).toBe(false);
    }
    expect(
      isStandaloneTransactionBearing("other", {
        ...purchaseFacts,
        economicEventClass: "transfer",
        direction: "neutral",
      }),
    ).toBe(false);
    expect(
      isStandaloneTransactionBearing("other", {
        ...purchaseFacts,
        originalAmount: null,
      }),
    ).toBe(false);
  });

  it("does not call attachment OCR again when the canonical document has reusable facts", () => {
    expect(
      hasReusableEmailAttachmentExtraction({
        metadata: {
          inboxExtraction: {
            version: EMAIL_ATTACHMENT_EXTRACTION_VERSION,
            cachedAt: "2026-07-24T00:00:00.000Z",
            result: {
              economicEventClass: "purchase",
              direction: "outflow",
              amount: "49.99",
              currency: "USD",
              date: "2026-07-24",
              party: "Acme",
              reference: "R-1",
              description: "Office supplies",
            },
          },
        },
        aiTransactionCache: null,
      }),
    ).toBe(true);
    expect(
      hasReusableEmailAttachmentExtraction({
        metadata: {
          extractedAmount: "49.99",
          extractedDate: "2026-07-24",
          extractedVendor: "Acme",
        },
        aiTransactionCache: null,
      }),
    ).toBe(true);
    expect(
      hasReusableEmailAttachmentExtraction({
        metadata: { extractedVendor: "Acme" },
        aiTransactionCache: null,
      }),
    ).toBe(false);
  });
});

describe("content-addressed documents", () => {
  it("keeps hash identity while assigning every physical upload a unique generation key", () => {
    const bytes = Buffer.from("same receipt bytes");
    const hash = hashDocumentContent(bytes);
    expect(hash).toHaveLength(64);
    expect(contentAddressedDocumentKey("org-1", hash, "generation-one")).toBe(
      `org-1/documents/sha256/${hash.slice(0, 2)}/${hash}/generation-one`,
    );
    expect(contentAddressedDocumentKey("org-1", hash)).not.toBe(
      contentAddressedDocumentKey("org-1", hash),
    );
    expect(hashDocumentContent(Buffer.from("same receipt bytes"))).toBe(hash);
  });

  it("normalizes supported file extensions", () => {
    expect(documentFileType("invoice.PDF")).toBe("pdf");
    expect(documentFileType("receipt.jpeg")).toBe("jpeg");
    expect(documentFileType("no-extension")).toBe("other");
  });
});

describe("bill OCR cache", () => {
  it("keys cached extraction by normalized category context", () => {
    const expense = { accountNumber: "6000", name: "Office", type: "expense" };
    const cash = { accountNumber: "1000", name: "Cash", type: "asset" };
    expect(billOcrContextHash([expense, cash])).toBe(billOcrContextHash([cash, expense]));
    expect(billOcrContextHash([expense])).not.toBe(billOcrContextHash([cash]));
  });
});
