import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { documents, documentAttachments } from "../../src/db/schema/documents";
import { journalHeaders } from "../../src/db/schema/journals";
import { journalDuplicateMerges } from "../../src/db/schema/match-history";
import { invoices } from "../../src/db/schema/invoices";
import { parties } from "../../src/db/schema/parties";
import { listEntityDocumentAttachments } from "../../src/lib/documents/list-attachments";
import { eq, and } from "drizzle-orm";
import postgres from "postgres";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("Document Attachments Flow", () => {
  let ORG_A: string;
  let DOC_1: string;
  let DOC_2: string;
  let TXN_1: string;

  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(async () => {
    ORG_A = crypto.randomUUID();
    DOC_1 = crypto.randomUUID();
    DOC_2 = crypto.randomUUID();
    TXN_1 = crypto.randomUUID();

    // Setup a transaction (journal header)
    await db.insert(journalHeaders).values({
      id: TXN_1,
      organizationId: ORG_A,
      transactionNumber: `JNL-${crypto.randomUUID().slice(0, 8)}`,
      transactionDate: "2026-01-01",
      transactionType: "journal",
      status: "draft",
    });

    // Setup two documents
    await db.insert(documents).values([
      {
        id: DOC_1,
        organizationId: ORG_A,
        originalFilename: "receipt.pdf",
        storagePath: "docs/receipt.pdf",
        fileType: "pdf",
        mimeType: "application/pdf",
      },
      {
        id: DOC_2,
        organizationId: ORG_A,
        originalFilename: "invoice-scan.png",
        storagePath: "docs/invoice-scan.png",
        fileType: "png",
        mimeType: "image/png",
      },
    ]);
  });

  it("should attach a document to a transaction, query it, and detach it", async () => {
    // 1. Attach
    const [attachment] = await db
      .insert(documentAttachments)
      .values({
        organizationId: ORG_A,
        documentId: DOC_1,
        linkableType: "transaction",
        linkableId: TXN_1,
      })
      .returning();

    expect(attachment).toBeDefined();
    expect(attachment.documentId).toBe(DOC_1);
    expect(attachment.linkableType).toBe("transaction");
    expect(attachment.linkableId).toBe(TXN_1);

    // 2. Query attachments for the transaction
    const txnDocs = await db
      .select()
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.linkableType, "transaction"),
          eq(documentAttachments.linkableId, TXN_1),
          eq(documentAttachments.organizationId, ORG_A),
        ),
      );

    expect(txnDocs).toHaveLength(1);
    expect(txnDocs[0].documentId).toBe(DOC_1);

    // 3. Detach
    const [deleted] = await db
      .delete(documentAttachments)
      .where(
        and(
          eq(documentAttachments.linkableType, "transaction"),
          eq(documentAttachments.linkableId, TXN_1),
          eq(documentAttachments.documentId, DOC_1),
        ),
      )
      .returning();

    expect(deleted).toBeDefined();
    expect(deleted.documentId).toBe(DOC_1);

    // 4. Verify detachment
    const afterDelete = await db
      .select()
      .from(documentAttachments)
      .where(eq(documentAttachments.linkableId, TXN_1));

    expect(afterDelete).toHaveLength(0);
  });

  it("should cascade-delete attachments when the parent document is deleted", async () => {
    // Attach DOC_1 to the transaction
    await db.insert(documentAttachments).values({
      organizationId: ORG_A,
      documentId: DOC_1,
      linkableType: "transaction",
      linkableId: TXN_1,
    });

    // Verify attachment exists
    const before = await db
      .select()
      .from(documentAttachments)
      .where(eq(documentAttachments.documentId, DOC_1));
    expect(before).toHaveLength(1);

    // Delete the parent document
    await db.delete(documents).where(eq(documents.id, DOC_1));

    // Verify cascade: attachment should be gone
    const after = await db
      .select()
      .from(documentAttachments)
      .where(eq(documentAttachments.documentId, DOC_1));
    expect(after).toHaveLength(0);
  });

  it("should support attaching to a party (linkableType = 'party')", async () => {
    // Create a party
    const partyId = crypto.randomUUID();
    await db.insert(parties).values({
      id: partyId,
      organizationId: ORG_A,
      name: "Test Vendor",
      partyType: "vendor",
      status: "active",
    });

    // Attach DOC_1 to the party
    const [attachment] = await db
      .insert(documentAttachments)
      .values({
        organizationId: ORG_A,
        documentId: DOC_1,
        linkableType: "party",
        linkableId: partyId,
      })
      .returning();

    expect(attachment.linkableType).toBe("party");
    expect(attachment.linkableId).toBe(partyId);

    // Query back
    const partyDocs = await db
      .select()
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.linkableType, "party"),
          eq(documentAttachments.linkableId, partyId),
        ),
      );
    expect(partyDocs).toHaveLength(1);
  });

  it("should support attaching to an invoice (linkableType = 'invoice')", async () => {
    // Create a customer for the invoice FK
    const customerId = crypto.randomUUID();
    await db.insert(parties).values({
      id: customerId,
      organizationId: ORG_A,
      name: "Test Customer",
      partyType: "customer",
      status: "active",
    });

    // Create an invoice
    const invoiceId = crypto.randomUUID();
    await db.insert(invoices).values({
      id: invoiceId,
      organizationId: ORG_A,
      invoiceNumber: `INV-${crypto.randomUUID().slice(0, 8)}`,
      customerId,
      status: "draft",
      issueDate: "2026-01-01",
      dueDate: "2026-01-31",
      subtotal: "100.00",
      total: "100.00",
      balanceDue: "100.00",
    });

    // Attach DOC_2 to the invoice
    const [attachment] = await db
      .insert(documentAttachments)
      .values({
        organizationId: ORG_A,
        documentId: DOC_2,
        linkableType: "invoice",
        linkableId: invoiceId,
      })
      .returning();

    expect(attachment.linkableType).toBe("invoice");
    expect(attachment.linkableId).toBe(invoiceId);
  });

  it("should allow attaching the same document to multiple entities", async () => {
    // Create a party
    const partyId = crypto.randomUUID();
    await db.insert(parties).values({
      id: partyId,
      organizationId: ORG_A,
      name: "Multi-attach Vendor",
      partyType: "vendor",
      status: "active",
    });

    // Attach DOC_1 to both the transaction AND the party
    await db.insert(documentAttachments).values([
      {
        organizationId: ORG_A,
        documentId: DOC_1,
        linkableType: "transaction",
        linkableId: TXN_1,
      },
      {
        organizationId: ORG_A,
        documentId: DOC_1,
        linkableType: "party",
        linkableId: partyId,
      },
    ]);

    // Verify both attachments exist
    const allLinks = await db
      .select()
      .from(documentAttachments)
      .where(eq(documentAttachments.documentId, DOC_1));
    expect(allLinks).toHaveLength(2);

    const types = allLinks.map((a: any) => a.linkableType).sort();
    expect(types).toEqual(["party", "transaction"]);
  });

  it("aggregates de-duplicated evidence for the canonical journal while duplicate audit access stays exact", async () => {
    const duplicateTransactionId = crypto.randomUUID();
    const canonicalOnlyDocumentId = crypto.randomUUID();
    await db.insert(journalHeaders).values({
      id: duplicateTransactionId,
      organizationId: ORG_A,
      transactionNumber: `JNL-${crypto.randomUUID().slice(0, 8)}`,
      transactionDate: "2026-01-01",
      transactionType: "journal",
      status: "draft",
      duplicateOfHeaderId: TXN_1,
    });
    await db.insert(documents).values({
      id: canonicalOnlyDocumentId,
      organizationId: ORG_A,
      originalFilename: "canonical-note.pdf",
      storagePath: "docs/canonical-note.pdf",
      fileType: "pdf",
      mimeType: "application/pdf",
    });
    await db.insert(journalDuplicateMerges).values({
      organizationId: ORG_A,
      canonicalHeaderId: TXN_1,
      duplicateHeaderId: duplicateTransactionId,
      pairKey: [TXN_1, duplicateTransactionId].sort().join(":"),
      state: "active",
      reason: "Same economic event",
      idempotencyKey: crypto.randomUUID(),
      matchedBy: crypto.randomUUID(),
    });
    await db.insert(documentAttachments).values([
      {
        organizationId: ORG_A,
        documentId: DOC_1,
        linkableType: "journal_header",
        linkableId: TXN_1,
      },
      {
        organizationId: ORG_A,
        documentId: canonicalOnlyDocumentId,
        linkableType: "journal_header",
        linkableId: TXN_1,
      },
      {
        organizationId: ORG_A,
        documentId: DOC_1,
        linkableType: "journal_header",
        linkableId: duplicateTransactionId,
      },
      {
        organizationId: ORG_A,
        documentId: DOC_2,
        linkableType: "journal_header",
        linkableId: duplicateTransactionId,
      },
    ]);

    const canonicalEvidence = await listEntityDocumentAttachments(db, ORG_A, {
      linkableType: "journal_header",
      linkableId: TXN_1,
    });
    expect(canonicalEvidence).toHaveLength(3);
    expect(canonicalEvidence.map((attachment) => attachment.documentId).sort()).toEqual(
      [DOC_1, DOC_2, canonicalOnlyDocumentId].sort(),
    );
    expect(canonicalEvidence.find((attachment) => attachment.documentId === DOC_1)).toMatchObject({
      linkableId: TXN_1,
      inheritedFromMergedJournal: false,
    });
    expect(canonicalEvidence.find((attachment) => attachment.documentId === DOC_2)).toMatchObject({
      linkableId: duplicateTransactionId,
      inheritedFromMergedJournal: true,
    });

    const duplicateAuditEvidence = await listEntityDocumentAttachments(db, ORG_A, {
      linkableType: "journal_header",
      linkableId: duplicateTransactionId,
    });
    expect(duplicateAuditEvidence).toHaveLength(2);
    expect(duplicateAuditEvidence.map((attachment) => attachment.documentId).sort()).toEqual(
      [DOC_1, DOC_2].sort(),
    );
    expect(
      duplicateAuditEvidence.some(
        (attachment) => attachment.documentId === canonicalOnlyDocumentId,
      ),
    ).toBe(false);
  });
});
