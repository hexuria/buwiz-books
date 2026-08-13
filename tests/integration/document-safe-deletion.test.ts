import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organization } from "@/db/schema/auth";
import { documentAttachments, documents } from "@/db/schema/documents";
import { financialAccounts } from "@/db/schema/financial-accounts";
import { sourceRecordDocuments, sourceRecords } from "@/db/schema/inbox";
import { reconciliations } from "@/db/schema/reconciliations";
import { deleteUnlinkedDocumentRecord } from "@/routes/api/-documents";
import {
  createReconciliationOwnedStatementDocument,
  removeReconciliationStatementRecord,
} from "@/routes/api/reconciliations/-_statement-upload";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("transaction-safe document deletion", () => {
  let db: any;
  let sqlClient: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  async function createOrganization(prefix: string) {
    const suffix = randomUUID();
    const orgId = `${prefix}-${suffix}`;
    await db.insert(organization).values({
      id: orgId,
      name: "Safe document deletion",
      slug: `${prefix}-${suffix}`,
    });
    return orgId;
  }

  async function createDocument(orgId: string, label: string) {
    const [document] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: `${label}.pdf`,
        storagePath: `r2://test/${orgId}/${label}.pdf`,
        documentType: "receipt",
        fileType: "pdf",
        contentHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
        r2Key: `${orgId}/${label}.pdf`,
        thumbnailR2Key: `${orgId}/${label}-thumbnail.png`,
        previewImageR2Key: `${orgId}/${label}-preview.png`,
        previewPageR2Keys: [`${orgId}/${label}-page-1.png`, `${orgId}/${label}-page-2.png`],
      })
      .returning();
    return document;
  }

  async function createReconciliation(orgId: string, documentId: string | null) {
    const [bankAccount] = await db
      .insert(financialAccounts)
      .values({
        organizationId: orgId,
        accountName: `Checking ${randomUUID()}`,
        accountType: "checking",
      })
      .returning();
    const [reconciliation] = await db
      .insert(reconciliations)
      .values({
        organizationId: orgId,
        bankAccountId: bankAccount.id,
        periodStart: "2026-06-01",
        periodEnd: "2026-06-30",
        statementDocumentId: documentId,
        status: "in_progress",
      })
      .returning();
    return reconciliation;
  }

  it("preserves source evidence and rejects logical deletion", async () => {
    const orgId = await createOrganization("source-evidence-delete");
    const document = await createDocument(orgId, "source-evidence");
    const [source] = await db
      .insert(sourceRecords)
      .values({
        organizationId: orgId,
        recordType: "document_upload",
        externalId: `source-${randomUUID()}`,
      })
      .returning();
    await db.insert(sourceRecordDocuments).values({
      organizationId: orgId,
      sourceRecordId: source.id,
      documentId: document.id,
      relationship: "primary_document",
    });

    await expect(
      db.transaction((tx: any) =>
        deleteUnlinkedDocumentRecord(tx, {
          organizationId: orgId,
          documentId: document.id,
          userId: "owner",
          role: "owner",
        }),
      ),
    ).rejects.toThrow("retained as transaction source evidence and cannot be deleted");

    expect(
      await db.select({ id: documents.id }).from(documents).where(eq(documents.id, document.id)),
    ).toEqual([{ id: document.id }]);
    expect(
      await db
        .select({ documentId: sourceRecordDocuments.documentId })
        .from(sourceRecordDocuments)
        .where(eq(sourceRecordDocuments.sourceRecordId, source.id)),
    ).toEqual([{ documentId: document.id }]);
  });

  it("preserves polymorphic entity attachments and rejects logical deletion", async () => {
    const orgId = await createOrganization("entity-attachment-delete");
    const document = await createDocument(orgId, "entity-attachment");
    const linkableId = randomUUID();
    await db.insert(documentAttachments).values({
      organizationId: orgId,
      documentId: document.id,
      linkableType: "journal_header",
      linkableId,
    });

    await expect(
      db.transaction((tx: any) =>
        deleteUnlinkedDocumentRecord(tx, {
          organizationId: orgId,
          documentId: document.id,
          userId: "owner",
          role: "owner",
        }),
      ),
    ).rejects.toThrow("linked to another record");

    expect(
      await db
        .select({ id: documentAttachments.id })
        .from(documentAttachments)
        .where(
          and(
            eq(documentAttachments.documentId, document.id),
            eq(documentAttachments.linkableId, linkableId),
          ),
        ),
    ).toHaveLength(1);
  });

  it("deletes truly unlinked metadata and returns every object key for post-commit cleanup", async () => {
    const orgId = await createOrganization("unlinked-document-delete");
    const document = await createDocument(orgId, "unlinked");

    const deleted = await db.transaction((tx: any) =>
      deleteUnlinkedDocumentRecord(tx, {
        organizationId: orgId,
        documentId: document.id,
        userId: "owner",
        role: "owner",
      }),
    );
    expect(deleted).toEqual({
      id: document.id,
      objectKeys: [
        document.r2Key,
        document.thumbnailR2Key,
        document.previewImageR2Key,
        ...(document.previewPageR2Keys ?? []),
      ],
    });
    expect(
      await db.select({ id: documents.id }).from(documents).where(eq(documents.id, document.id)),
    ).toEqual([]);
  });

  it("prevents a concurrent attachment insert from being cascade-erased", async () => {
    const orgId = await createOrganization("concurrent-document-delete");
    const document = await createDocument(orgId, "concurrent");
    let releaseDeletion!: () => void;
    let deletionReachedLock!: () => void;
    const deletionCanCommit = new Promise<void>((resolve) => {
      releaseDeletion = resolve;
    });
    const documentDeletedInsideTransaction = new Promise<void>((resolve) => {
      deletionReachedLock = resolve;
    });

    const deletion = db.transaction(async (tx: any) => {
      const result = await deleteUnlinkedDocumentRecord(tx, {
        organizationId: orgId,
        documentId: document.id,
        userId: "owner",
        role: "owner",
      });
      deletionReachedLock();
      await deletionCanCommit;
      return result;
    });
    await documentDeletedInsideTransaction;

    const concurrentInsert = Promise.resolve(
      db
        .insert(documentAttachments)
        .values({
          organizationId: orgId,
          documentId: document.id,
          linkableType: "journal_header",
          linkableId: randomUUID(),
        })
        .returning(),
    );
    releaseDeletion();
    await deletion;
    await expect(concurrentInsert).rejects.toThrow();

    expect(
      await db.select({ id: documents.id }).from(documents).where(eq(documents.id, document.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ id: documentAttachments.id })
        .from(documentAttachments)
        .where(eq(documentAttachments.documentId, document.id)),
    ).toEqual([]);
  });

  it("unlinks a reconciliation without deleting shared source evidence or other attachments", async () => {
    const orgId = await createOrganization("shared-reconciliation-evidence");
    const document = await createDocument(orgId, "shared-statement");
    const reconciliation = await createReconciliation(orgId, document.id);
    const [source] = await db
      .insert(sourceRecords)
      .values({
        organizationId: orgId,
        recordType: "email_attachment",
        externalId: `source-${randomUUID()}`,
      })
      .returning();
    const otherLinkableId = randomUUID();
    await db.insert(sourceRecordDocuments).values({
      organizationId: orgId,
      sourceRecordId: source.id,
      documentId: document.id,
      relationship: "primary_document",
    });
    await db.insert(documentAttachments).values([
      {
        organizationId: orgId,
        documentId: document.id,
        linkableType: "reconciliation",
        linkableId: reconciliation.id,
      },
      {
        organizationId: orgId,
        documentId: document.id,
        linkableType: "party",
        linkableId: otherLinkableId,
      },
    ]);

    const removal = await db.transaction((tx: any) =>
      removeReconciliationStatementRecord(tx, {
        organizationId: orgId,
        reconciliationId: reconciliation.id,
        deleteDocument: true,
      }),
    );

    expect(removal).toEqual({
      documentId: document.id,
      deletedDocumentId: null,
      objectKeys: [],
    });
    expect(
      await db.select({ id: documents.id }).from(documents).where(eq(documents.id, document.id)),
    ).toEqual([{ id: document.id }]);
    expect(
      await db
        .select({ documentId: sourceRecordDocuments.documentId })
        .from(sourceRecordDocuments)
        .where(eq(sourceRecordDocuments.sourceRecordId, source.id)),
    ).toEqual([{ documentId: document.id }]);
    expect(
      await db
        .select({ linkableType: documentAttachments.linkableType })
        .from(documentAttachments)
        .where(eq(documentAttachments.documentId, document.id)),
    ).toEqual([{ linkableType: "party" }]);
    expect(
      await db
        .select({ statementDocumentId: reconciliations.statementDocumentId })
        .from(reconciliations)
        .where(eq(reconciliations.id, reconciliation.id)),
    ).toEqual([{ statementDocumentId: null }]);
  });

  it("deletes only an exclusively reconciliation-owned document and returns cleanup keys", async () => {
    const orgId = await createOrganization("exclusive-reconciliation-document");
    const document = await createDocument(orgId, "exclusive-statement");
    const reconciliation = await createReconciliation(orgId, document.id);
    await db.insert(documentAttachments).values({
      organizationId: orgId,
      documentId: document.id,
      linkableType: "reconciliation",
      linkableId: reconciliation.id,
    });

    const removal = await db.transaction((tx: any) =>
      removeReconciliationStatementRecord(tx, {
        organizationId: orgId,
        reconciliationId: reconciliation.id,
        deleteDocument: true,
      }),
    );

    expect(removal).toEqual({
      documentId: document.id,
      deletedDocumentId: document.id,
      objectKeys: [
        document.r2Key,
        document.thumbnailR2Key,
        document.previewImageR2Key,
        ...(document.previewPageR2Keys ?? []),
      ],
    });
    expect(
      await db.select({ id: documents.id }).from(documents).where(eq(documents.id, document.id)),
    ).toEqual([]);
    expect(
      await db
        .select({ statementDocumentId: reconciliations.statementDocumentId })
        .from(reconciliations)
        .where(eq(reconciliations.id, reconciliation.id)),
    ).toEqual([{ statementDocumentId: null }]);
  });

  it("creates a new generated statement without relabeling a shared Vault document", async () => {
    const orgId = await createOrganization("generated-statement-isolation");
    const sharedDocument = await createDocument(orgId, "original-receipt");
    await db
      .update(documents)
      .set({ displayTitle: "Original receipt", documentType: "receipt" })
      .where(eq(documents.id, sharedDocument.id));
    const reconciliation = await createReconciliation(orgId, sharedDocument.id);
    const [source] = await db
      .insert(sourceRecords)
      .values({
        organizationId: orgId,
        recordType: "document_upload",
        externalId: `source-${randomUUID()}`,
      })
      .returning();
    await db.insert(sourceRecordDocuments).values({
      organizationId: orgId,
      sourceRecordId: source.id,
      documentId: sharedDocument.id,
      relationship: "primary_document",
    });
    await db.insert(documentAttachments).values({
      organizationId: orgId,
      documentId: sharedDocument.id,
      linkableType: "reconciliation",
      linkableId: reconciliation.id,
    });

    const generated = await db.transaction((tx: any) =>
      createReconciliationOwnedStatementDocument(tx, {
        organizationId: orgId,
        reconciliationId: reconciliation.id,
        document: {
          originalFilename: "generated-statement.pdf",
          displayTitle: "Generated statement",
          storagePath: `${orgId}/generated-statement.pdf`,
          r2Key: `${orgId}/generated-statement.pdf`,
          r2Bucket: "test",
          fileType: "pdf",
          mimeType: "application/pdf",
          fileSizeBytes: 123,
        },
      }),
    );

    expect(generated.id).not.toBe(sharedDocument.id);
    const [preserved] = await db
      .select({
        originalFilename: documents.originalFilename,
        displayTitle: documents.displayTitle,
        documentType: documents.documentType,
        r2Key: documents.r2Key,
      })
      .from(documents)
      .where(eq(documents.id, sharedDocument.id));
    expect(preserved).toEqual({
      originalFilename: sharedDocument.originalFilename,
      displayTitle: "Original receipt",
      documentType: "receipt",
      r2Key: sharedDocument.r2Key,
    });
    expect(
      await db
        .select({ documentId: sourceRecordDocuments.documentId })
        .from(sourceRecordDocuments)
        .where(eq(sourceRecordDocuments.sourceRecordId, source.id)),
    ).toEqual([{ documentId: sharedDocument.id }]);
    expect(
      await db
        .select({ statementDocumentId: reconciliations.statementDocumentId })
        .from(reconciliations)
        .where(eq(reconciliations.id, reconciliation.id)),
    ).toEqual([{ statementDocumentId: generated.id }]);
    expect(
      await db
        .select({ documentId: documentAttachments.documentId })
        .from(documentAttachments)
        .where(
          and(
            eq(documentAttachments.organizationId, orgId),
            eq(documentAttachments.linkableType, "reconciliation"),
            eq(documentAttachments.linkableId, reconciliation.id),
          ),
        ),
    ).toEqual([{ documentId: generated.id }]);
  });
});
