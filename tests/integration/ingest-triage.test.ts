// ============================================================================
// Upload-time ingest triage: one cheap classification, cached on
// documents.metadata.triage, emitting a confirm-first document_type proposal.
// Replaces the old filename-only classify pass (ai_findings #6).
// ============================================================================
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { eq, and } from "drizzle-orm";
import postgres from "postgres";
import { documents } from "../../src/db/schema/documents";
import { aiActionProposals } from "../../src/db/schema/ai";

const { aiCompleteMock } = vi.hoisted(() => ({ aiCompleteMock: vi.fn() }));
vi.mock("../../src/lib/ai/facade", () => ({ aiComplete: aiCompleteMock }));

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("ingest triage", () => {
  let db: any;
  let sql: postgres.Sql;
  let runIngestTriage: typeof import("../../src/lib/ai/ingest-triage").runIngestTriage;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    ({ runIngestTriage } = await import("../../src/lib/ai/ingest-triage"));
  });

  afterAll(async () => {
    await sql.end();
  });

  async function seedDocument(orgId: string, overrides: Record<string, unknown> = {}) {
    const [doc] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "mystery.pdf",
        storagePath: `test/${crypto.randomUUID()}.pdf`,
        ...overrides,
      })
      .returning();
    return doc;
  }

  function mockTriage(docKind: string, confidence: number) {
    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: null,
      model: "gemini-test",
      data: { docKind, confidence, reasoning: "test" },
    });
  }

  it("caches the triage result and creates a confirm-first proposal", async () => {
    const orgId = crypto.randomUUID();
    const doc = await seedDocument(orgId, { originalFilename: "acme-invoice.pdf" });
    mockTriage("bill", 0.92);

    await runIngestTriage({
      orgId,
      documentId: doc.id,
      filename: "acme-invoice.pdf",
      mimeType: "application/pdf",
    });

    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after.metadata?.triage?.docKind).toBe("bill");
    expect(after.metadata?.triage?.confidence).toBeCloseTo(0.92);
    // Confirm-first: the type itself is NOT written.
    expect(after.documentType).toBe("other");

    const proposals = await db
      .select()
      .from(aiActionProposals)
      .where(
        and(
          eq(aiActionProposals.organizationId, orgId),
          eq(aiActionProposals.kind, "document_type"),
        ),
      );
    expect(proposals).toHaveLength(1);
    expect(proposals[0].proposal).toMatchObject({ documentId: doc.id, documentType: "bill" });
    expect(proposals[0].status).toBe("pending");
  });

  it("creates no proposal below the confidence threshold", async () => {
    const orgId = crypto.randomUUID();
    const doc = await seedDocument(orgId);
    mockTriage("receipt", 0.4);

    await runIngestTriage({
      orgId,
      documentId: doc.id,
      filename: "blurry.pdf",
      mimeType: "application/pdf",
    });

    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    // Still cached (so we don't re-pay for the call) but no proposal.
    expect(after.metadata?.triage?.docKind).toBe("receipt");
    const proposals = await db
      .select()
      .from(aiActionProposals)
      .where(eq(aiActionProposals.organizationId, orgId));
    expect(proposals).toHaveLength(0);
  });

  it("skips documents a human already typed", async () => {
    const orgId = crypto.randomUUID();
    const doc = await seedDocument(orgId, { documentType: "invoice" });
    aiCompleteMock.mockClear();
    mockTriage("bill", 0.99);

    await runIngestTriage({
      orgId,
      documentId: doc.id,
      filename: "already-typed.pdf",
      mimeType: "application/pdf",
    });

    expect(aiCompleteMock).not.toHaveBeenCalled();
    const [after] = await db.select().from(documents).where(eq(documents.id, doc.id));
    expect(after.documentType).toBe("invoice");
  });

  it("is idempotent — a second run neither re-calls the model nor duplicates the proposal", async () => {
    const orgId = crypto.randomUUID();
    const doc = await seedDocument(orgId);
    mockTriage("statement", 0.95);

    await runIngestTriage({
      orgId,
      documentId: doc.id,
      filename: "stmt.pdf",
      mimeType: "application/pdf",
    });
    aiCompleteMock.mockClear();
    await runIngestTriage({
      orgId,
      documentId: doc.id,
      filename: "stmt.pdf",
      mimeType: "application/pdf",
    });

    expect(aiCompleteMock).not.toHaveBeenCalled();
    const proposals = await db
      .select()
      .from(aiActionProposals)
      .where(eq(aiActionProposals.organizationId, orgId));
    expect(proposals).toHaveLength(1);
  });

  it("never throws when the model output fails validation", async () => {
    const orgId = crypto.randomUUID();
    const doc = await seedDocument(orgId);
    aiCompleteMock.mockResolvedValue({
      ok: false,
      needsReview: true,
      invocationId: null,
      issues: ["docKind: Invalid enum value"],
    });

    await expect(
      runIngestTriage({
        orgId,
        documentId: doc.id,
        filename: "weird.pdf",
        mimeType: "application/pdf",
      }),
    ).resolves.toBeUndefined();

    const proposals = await db
      .select()
      .from(aiActionProposals)
      .where(eq(aiActionProposals.organizationId, orgId));
    expect(proposals).toHaveLength(0);
  });

  it("passes a text preview for text-extractable uploads only", async () => {
    const orgId = crypto.randomUUID();
    const csvDoc = await seedDocument(orgId, { originalFilename: "export.csv" });
    mockTriage("statement", 0.9);
    const csvBody = Buffer.from("Date,Description,Amount\n2026-01-05,ACME,-10.00").toString(
      "base64",
    );

    await runIngestTriage({
      orgId,
      documentId: csvDoc.id,
      filename: "export.csv",
      mimeType: "text/csv",
      fileBase64: csvBody,
    });
    expect(aiCompleteMock.mock.calls.at(-1)?.[0].input.textPreview).toContain("Date,Description");

    const pdfDoc = await seedDocument(orgId);
    mockTriage("bill", 0.9);
    await runIngestTriage({
      orgId,
      documentId: pdfDoc.id,
      filename: "scan.pdf",
      mimeType: "application/pdf",
      fileBase64: csvBody,
    });
    expect(aiCompleteMock.mock.calls.at(-1)?.[0].input.textPreview).toBeUndefined();
  });
});
