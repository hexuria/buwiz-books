/**
 * Integration tests for the `bbox_scan` job handler.
 *
 * The façade, object storage and the PDF rasterizer are mocked; everything
 * else — the document row, the lease, the fenced completion — is real.
 *
 * The regression that motivated this handler's rewrite is the third case
 * below: the previous version wrote `ocr_bounding_boxes` unconditionally, so a
 * scan in which EVERY page failed wiped a perfectly good set of boxes and
 * replaced them with `[]`. The fix reads two signals — "we found boxes" and
 * "at least one page came back at all" — so that an all-failed scan writes
 * nothing while a genuinely field-less document still records `[]`.
 */
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { aiCompleteMock, downloadFromR2Mock, renderAndStorePdfPreviewsMock } = vi.hoisted(() => ({
  aiCompleteMock: vi.fn(),
  downloadFromR2Mock: vi.fn(),
  renderAndStorePdfPreviewsMock: vi.fn(),
}));

vi.mock("@/lib/ai/facade", () => ({ aiComplete: aiCompleteMock }));
vi.mock("@/lib/storage", () => ({
  isR2Configured: () => true,
  downloadFromR2: downloadFromR2Mock,
  uploadToR2: async () => undefined,
  deleteFromR2: async () => undefined,
}));
vi.mock("@/lib/pdf-preview", () => ({
  renderAndStorePdfPreviews: renderAndStorePdfPreviewsMock,
}));

import { db } from "@/db";
import { organization } from "@/db/schema/auth";
import { documents } from "@/db/schema/documents";
import { processingJobs } from "@/db/schema/inbox";
import { processBboxScanJob } from "@/lib/jobs/handlers/bbox-scan";
import type { ProcessingJob } from "@/lib/jobs/registry";
import { retryPolicyFor } from "@/lib/jobs/retry-policy";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const LEGACY_PAGE_PREFIX = /^p\d+_/;

interface StoredBox {
  fieldId: string;
  label: string;
  text?: string;
  bbox: [number, number, number, number];
  page: number;
}

interface Fixture {
  orgId: string;
  documentId: string;
  job: ProcessingJob;
  workerId: string;
  pageKeys: string[];
}

interface FixtureOptions {
  /** Preview PNG keys already on the document. Empty means "not rendered yet". */
  pageKeys?: string[];
  boundingBoxes?: StoredBox[];
  aiTransactionCache?: { result: Record<string, unknown>; cachedAt: string; contextHash: string };
}

/** Model output for one page: bare semantic field ids, no page encoded in them. */
function modelBox(fieldId: string, label: string): Omit<StoredBox, "page"> {
  return { fieldId, label, text: `${label} value`, bbox: [0.1, 0.2, 0.3, 0.05] };
}

async function createFixture(label: string, options: FixtureOptions = {}): Promise<Fixture> {
  const suffix = randomUUID();
  const orgId = `${label}-${suffix}`;
  const pageKeys = options.pageKeys ?? [`previews/${suffix}/p0.png`, `previews/${suffix}/p1.png`];

  await db.insert(organization).values({
    id: orgId,
    name: "Bbox Scan Co",
    slug: `${label}-${suffix}`,
  });
  const [document] = await db
    .insert(documents)
    .values({
      organizationId: orgId,
      originalFilename: "bill.pdf",
      mimeType: "application/pdf",
      fileType: "pdf",
      documentType: "bill",
      storagePath: `documents/${suffix}.pdf`,
      r2Key: `documents/${suffix}.pdf`,
      previewPageR2Keys: pageKeys.length > 0 ? pageKeys : null,
      ocrBoundingBoxes: options.boundingBoxes ?? null,
      aiTransactionCache: options.aiTransactionCache ?? null,
      metadata: {},
    })
    .returning();

  const workerId = `test-worker-${suffix}`;
  const [job] = await db
    .insert(processingJobs)
    .values({
      organizationId: orgId,
      jobType: "bbox_scan",
      dedupeKey: `bbox_scan:${document.id}`,
      status: "running",
      attempts: 1,
      maxAttempts: retryPolicyFor("bbox_scan").maxAttempts,
      lockedBy: workerId,
      lockedUntil: new Date(Date.now() + 300_000),
      payload: { documentId: document.id },
    })
    .returning();

  return { orgId, documentId: document.id, job: job as ProcessingJob, workerId, pageKeys };
}

async function readDocument(documentId: string) {
  const [row] = await db.select().from(documents).where(eq(documents.id, documentId));
  return row;
}

async function readJob(jobId: string) {
  const [row] = await db.select().from(processingJobs).where(eq(processingJobs.id, jobId));
  return row;
}

describeDb("bbox_scan job handler", () => {
  let sqlClient: postgres.Sql;

  beforeAll(async () => {
    ({ sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  beforeEach(() => {
    aiCompleteMock.mockReset();
    downloadFromR2Mock.mockReset();
    renderAndStorePdfPreviewsMock.mockReset();
    downloadFromR2Mock.mockImplementation(async (key: string) => Buffer.from(`bytes:${key}`));
  });

  it("writes one box per page, each carrying its page and an unprefixed field id", async () => {
    const fixture = await createFixture("bbox-ok");
    aiCompleteMock.mockImplementation(async ({ input }: { input: { page: number } }) => ({
      ok: true,
      invocationId: null,
      model: "test-model",
      data: [
        modelBox("vendor_name", `Vendor p${input.page}`),
        modelBox("line_item_3", `Line p${input.page}`),
      ],
    }));

    const result = await processBboxScanJob(fixture.job, { workerId: fixture.workerId });

    expect(result).toMatchObject({
      processed: true,
      documentId: fixture.documentId,
      pagesScanned: 2,
      pagesTotal: 2,
      pagesSucceeded: 2,
      pagesFailed: 0,
      capped: false,
      wrote: true,
      boundingBoxes: 4,
    });

    const document = await readDocument(fixture.documentId);
    const boxes = document.ocrBoundingBoxes as StoredBox[];
    expect(boxes).toHaveLength(4);
    // Position lives in `page` — every box has one, and it indexes a preview
    // the viewer actually renders.
    expect(boxes.map((box) => box.page)).toEqual([0, 0, 1, 1]);
    // …and NOT in the field id, which is a pure semantic type tag.
    expect(boxes.every((box) => !LEGACY_PAGE_PREFIX.test(box.fieldId))).toBe(true);
    expect(boxes.map((box) => box.fieldId)).toEqual([
      "vendor_name",
      "line_item_3",
      "vendor_name",
      "line_item_3",
    ]);

    // The stored preview PNGs are what was scanned — not a separate rasterization.
    expect(renderAndStorePdfPreviewsMock).not.toHaveBeenCalled();
    expect(downloadFromR2Mock.mock.calls.map(([key]) => key)).toEqual(fixture.pageKeys);

    const job = await readJob(fixture.job.id);
    expect(job.status).toBe("completed");
    expect(job.lockedBy).toBeNull();
  });

  it("leaves prior boxes untouched when every page fails validation", async () => {
    const prior: StoredBox[] = [
      {
        fieldId: "vendor_name",
        label: "Vendor",
        text: "ACME",
        bbox: [0.1, 0.1, 0.2, 0.05],
        page: 0,
      },
      {
        fieldId: "total_amount",
        label: "Total",
        text: "99.00",
        bbox: [0.6, 0.8, 0.2, 0.05],
        page: 1,
      },
    ];
    const fixture = await createFixture("bbox-all-fail", { boundingBoxes: prior });
    aiCompleteMock.mockResolvedValue({
      ok: false,
      needsReview: true,
      invocationId: null,
      issues: ["0.bbox: expected 4 numbers"],
    });

    const result = await processBboxScanJob(fixture.job, { workerId: fixture.workerId });

    expect(result).toMatchObject({
      processed: true,
      pagesSucceeded: 0,
      pagesFailed: 2,
      wrote: false,
      boundingBoxes: 0,
    });

    // THE regression: a scan that learned nothing must not erase what was
    // already known. The old handler wrote `[]` here.
    const document = await readDocument(fixture.documentId);
    expect(document.ocrBoundingBoxes).toEqual(prior);

    // Bounding boxes are presentation metadata — a failed scan is not a job failure.
    const job = await readJob(fixture.job.id);
    expect(job.status).toBe("completed");
  });

  it("writes an empty array when pages succeed but the document has no fields", async () => {
    const fixture = await createFixture("bbox-empty", {
      boundingBoxes: [
        { fieldId: "vendor_name", label: "Vendor", bbox: [0.1, 0.1, 0.2, 0.05], page: 0 },
      ],
    });
    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: null,
      model: "test-model",
      data: [],
    });

    const result = await processBboxScanJob(fixture.job, { workerId: fixture.workerId });

    expect(result).toMatchObject({ pagesSucceeded: 2, pagesFailed: 0, wrote: true });
    // "The model looked and found no fields" is a real answer, and it is a
    // different answer from "the scan never ran".
    const document = await readDocument(fixture.documentId);
    expect(document.ocrBoundingBoxes).toEqual([]);
  });

  it("clears the cached transaction parse in the same write as the boxes", async () => {
    const fixture = await createFixture("bbox-cache", {
      aiTransactionCache: {
        result: { vendor: "ACME" },
        cachedAt: new Date().toISOString(),
        contextHash: "stale-hash",
      },
    });
    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: null,
      model: "test-model",
      data: [modelBox("total_amount", "Total")],
    });

    const before = await readDocument(fixture.documentId);
    expect(before.aiTransactionCache).not.toBeNull();

    await processBboxScanJob(fixture.job, { workerId: fixture.workerId });

    // The cache is derived from the boxes, but its own context hash is
    // computed from accounts, so nothing else would ever invalidate it.
    const after = await readDocument(fixture.documentId);
    expect(after.aiTransactionCache).toBeNull();
    expect((after.ocrBoundingBoxes as StoredBox[]).length).toBeGreaterThan(0);
  });

  it("survives a page that throws and keeps the other pages' boxes", async () => {
    const fixture = await createFixture("bbox-throw", {
      pageKeys: [`previews/a.png`, `previews/b.png`, `previews/c.png`],
    });
    aiCompleteMock.mockImplementation(async ({ input }: { input: { page: number } }) => {
      if (input.page === 1) throw new Error("transport reset mid-page");
      return {
        ok: true,
        invocationId: null,
        model: "test-model",
        data: [modelBox("invoice_number", `Invoice p${input.page}`)],
      };
    });

    const result = await processBboxScanJob(fixture.job, { workerId: fixture.workerId });

    // A thrown transport error used to kill the whole job, which then re-scanned
    // — and re-billed — every page that had already succeeded.
    expect(result).toMatchObject({
      processed: true,
      pagesScanned: 3,
      pagesSucceeded: 2,
      pagesFailed: 1,
      wrote: true,
      boundingBoxes: 2,
    });
    const document = await readDocument(fixture.documentId);
    expect((document.ocrBoundingBoxes as StoredBox[]).map((box) => box.page)).toEqual([0, 2]);

    const job = await readJob(fixture.job.id);
    expect(job.status).toBe("completed");
  });

  it("renders the previews when the document has none, then scans those keys", async () => {
    const fixture = await createFixture("bbox-render", { pageKeys: [] });
    const renderedKeys = [
      `rendered/${fixture.documentId}/p0.png`,
      `rendered/${fixture.documentId}/p1.png`,
    ];
    renderAndStorePdfPreviewsMock.mockResolvedValue({
      previewR2Keys: renderedKeys,
      pageCount: renderedKeys.length,
      skipped: false,
    });
    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: null,
      model: "test-model",
      data: [modelBox("vendor_name", "Vendor")],
    });

    const result = await processBboxScanJob(fixture.job, { workerId: fixture.workerId });

    expect(renderAndStorePdfPreviewsMock).toHaveBeenCalledTimes(1);
    expect(renderAndStorePdfPreviewsMock.mock.calls[0][1]).toMatchObject({
      orgId: fixture.orgId,
      documentId: fixture.documentId,
      mimeType: "application/pdf",
    });
    expect(result).toMatchObject({ pagesTotal: 2, pagesScanned: 2, pagesSucceeded: 2 });
    // The scan reads the freshly rendered keys — the same images the viewer shows.
    const scanned = downloadFromR2Mock.mock.calls.map(([key]) => key as string);
    expect(scanned).toEqual(expect.arrayContaining(renderedKeys));
  });

  it("reports a lost lease and does not complete a job it no longer owns", async () => {
    const fixture = await createFixture("bbox-lease");
    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: null,
      model: "test-model",
      data: [modelBox("vendor_name", "Vendor")],
    });

    const result = await processBboxScanJob(fixture.job, { workerId: "some-successor-worker" });

    expect(result).toMatchObject({ processed: false, reason: "lease_lost", jobId: fixture.job.id });
    const job = await readJob(fixture.job.id);
    expect(job.status).toBe("running");
    expect(job.lockedBy).toBe(fixture.workerId);
  });
});
