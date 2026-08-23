/**
 * Bill Upload Background Store — Module-level singleton
 *
 * Survives route navigation because it lives outside React's component tree.
 * Components subscribe via useSyncExternalStore.
 *
 * Pipeline (confirm-first):
 *  1. Ensure the file exists once in the document vault
 *  2. Reuse cached OCR or send the document to Gemini
 *  3. Stop at "awaiting_review" — show the parsed preview on the job card
 *  4. confirmBillUpload: create vendor (if new), create bill, link document,
 *     approve the prefill proposal (feedback), invalidate queries
 *     dismissBillUpload: reject the prefill proposal, drop the job — no writes
 */

import { useSyncExternalStore } from "react";
import { keys } from "./query-keys";
import { createLogger } from "./logger";

const logger = createLogger("bill-upload");
import type { ParsedBillData, CategoryContext } from "../routes/api/-ai-bill-ocr";
import { parseBillDocument, startFieldScan } from "../routes/api/-ai-bill-ocr";
import { getDocumentViewerData } from "../routes/api/-documents";
import { pollFieldScan } from "./reconciliation-ocr-store";

/** Server functions are invoked with an `{ data }` envelope. */
type ServerFnCaller = (opts: { data: unknown }) => Promise<unknown>;
import {
  uploadDocumentForBill,
  createBill,
  linkDocumentToBill,
  uploadBillDocument,
  rescanBoundingBoxes,
} from "../routes/api/-bills";
import { createParty } from "../routes/api/-parties";
import { generatePdfPreview } from "../routes/api/-pdf-preview";
import { getMappedAccounts } from "../routes/api/-category-mappings";

// ============================================================================
// Types
// ============================================================================

export type JobStatus =
  | "uploading"
  | "processing"
  | "awaiting_review"
  | "creating"
  | "done"
  | "error";

export interface BillUploadJob {
  id: string;
  fileName: string;
  status: JobStatus;
  error?: string;
  billId?: string;
  vendorName?: string;
  amount?: string;
  /** Full AI extraction shown on the review card while "awaiting_review". */
  parsed?: ParsedBillData;
  /** Prefill proposal recorded server-side on fresh parses (feedback loop). */
  prefillProposalId?: string;
  /** Everything the deferred creation step needs to resume after confirm. */
  base64?: string;
  mimeType?: string;
  documentId?: string;
  fileType?: "pdf" | "image";
  idempotencyKey?: string;
  boundingBoxes?: any[];
  accounts?: any[];
  vendors?: any[];
}

// ============================================================================
// Store (singleton)
// ============================================================================

let jobs: BillUploadJob[] = [];
const listeners = new Set<() => void>();

function emitChange() {
  // Create a new array reference so useSyncExternalStore detects the change
  jobs = [...jobs];
  for (const l of listeners) l();
}

function getSnapshot(): BillUploadJob[] {
  return jobs;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// ============================================================================
// React Hook
// ============================================================================

export function useBillUploadJobs(): BillUploadJob[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

// ============================================================================
// Actions
// ============================================================================

function updateJob(id: string, patch: Partial<BillUploadJob>) {
  jobs = jobs.map((j) => (j.id === id ? { ...j, ...patch } : j));
  emitChange();
}

export function removeJob(id: string) {
  jobs = jobs.filter((j) => j.id !== id);
  emitChange();
}

export function getActiveJobCount(): number {
  return jobs.filter((j) => j.status !== "done" && j.status !== "error").length;
}

// ============================================================================
// Pipeline
// ============================================================================

/**
 * Start a background bill upload + AI extraction pipeline.
 *
 * @param file - The raw File object from the user's file picker
 * @param accounts - Chart of accounts for AI category context
 * @param vendors - Existing vendors for vendor matching
 * @param _queryClient - Kept for call-site compatibility; invalidation now
 *   happens in confirmBillUpload after the user applies the extraction.
 */
export async function startBillUpload(
  file: File,
  accounts: any[],
  vendors: any[],
  _queryClient: any,
) {
  const jobId = `bill-upload-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const submissionIdempotencyKey = crypto.randomUUID();

  // Add job — skeleton appears in kanban immediately
  jobs = [
    ...jobs,
    {
      id: jobId,
      fileName: file.name,
      status: "uploading",
    },
  ];
  emitChange();

  try {
    // Read file as base64
    const base64 = await fileToBase64(file);
    const mimeType = file.type;
    const ext = file.name.split(".").pop()?.toLowerCase() || "other";
    const fileType = ext === "pdf" ? "pdf" : "image";

    // Build scoped category context — only expense-related accounts for bills
    const categories: CategoryContext[] = accounts
      .filter(
        (a: any) =>
          a.accountType === "expense" ||
          a.accountType === "cost_of_revenue" ||
          a.accountType === "other_expense",
      )
      .map((a: any) => {
        // Find parent name for hierarchy context
        const parent = a.parentId ? accounts.find((p: any) => p.id === a.parentId) : null;
        return {
          accountNumber: a.accountNumber || "",
          name: a.name,
          type: a.accountType,
          subtype: a.subtype || undefined,
          parentName: parent?.name || undefined,
        };
      });

    // Ensure storage first so OCR can use the document's content-addressed cache.
    updateJob(jobId, { status: "processing" });

    const uploadResult = await (uploadDocumentForBill as (opts: { data: unknown }) => Promise<any>)(
      {
        data: {
          filename: file.name,
          contentType: mimeType,
          fileBase64: base64,
        },
      },
    );
    const aiResult = await (
      parseBillDocument as (opts: {
        data: unknown;
      }) => Promise<ParsedBillData | { status: "needs_review"; issues: string[] }>
    )({
      data: {
        documentId: uploadResult.documentId,
        base64Content: base64,
        mimeType,
        currentDate: new Date().toISOString().split("T")[0],
        categories,
      },
    });

    if ("status" in aiResult) {
      // Schema validation rejected the extraction — no vendor/bill is created.
      // The existing error path surfaces the message on the upload job card.
      throw new Error(
        `AI could not reliably read this bill (${aiResult.issues.slice(0, 3).join("; ")}${aiResult.issues.length > 3 ? "; …" : ""}). Create the bill manually or try re-uploading a clearer copy.`,
      );
    }

    // Update job with AI-extracted info (still prefetching artifacts)
    updateJob(jobId, {
      vendorName: aiResult.vendor?.name,
      amount: aiResult.invoice?.amount?.toString(),
    });

    // Prefetch derived document artifacts; generate only what is still missing.
    let boundingBoxes: any[] = Array.isArray(uploadResult.document?.ocrBoundingBoxes)
      ? uploadResult.document.ocrBoundingBoxes
      : [];
    try {
      const needsPdfPreview =
        fileType === "pdf" &&
        !uploadResult.document?.previewImageR2Key &&
        !uploadResult.document?.previewPageR2Keys?.length;

      // Previews first, not in parallel with the scan: the scan reads these
      // exact PNGs and will render its own if they are missing, so racing
      // the two would rasterize the same PDF twice.
      if (needsPdfPreview) {
        await (generatePdfPreview as (opts: { data: unknown }) => Promise<any>)({
          data: { documentId: uploadResult.documentId, pdfBase64: base64, mimeType },
        }).catch((e: unknown) => logger.warn("PDF preview failed", { error: e }));
      }

      if (boundingBoxes.length === 0) {
        // Queued worker job rather than a synchronous scan: one download and
        // one rasterization in the worker, instead of holding a request open
        // across a model call per page.
        const queued = (await (startFieldScan as ServerFnCaller)({
          data: { documentId: uploadResult.documentId },
        })) as { jobId: string | null };
        if (queued.jobId) {
          const outcome = await pollFieldScan(queued.jobId, uploadResult.documentId);
          if (outcome.outcome === "deferred") {
            // Boxes are presentation metadata; the review card works without
            // them and the scan keeps running server-side.
            logger.warn("Field scan deferred", { reason: outcome.reason });
          } else if (outcome.status.status === "failed") {
            logger.warn("Field scan failed (non-critical)", { error: outcome.status.error });
          } else {
            const viewer = (await (getDocumentViewerData as ServerFnCaller)({
              data: { documentId: uploadResult.documentId },
            })) as { boundingBoxes?: any[] };
            if (Array.isArray(viewer?.boundingBoxes)) boundingBoxes = viewer.boundingBoxes;
          }
        }
      }
    } catch (e) {
      logger.warn("Bounding box extraction failed (non-critical)", { error: e });
    }

    // Confirm-first (ai_findings #19): STOP here. No vendor or bill is
    // created until the user reviews the extraction and clicks "Create bill"
    // on the job card (confirmBillUpload) — or dismisses it entirely.
    updateJob(jobId, {
      status: "awaiting_review",
      parsed: aiResult,
      prefillProposalId: (aiResult as ParsedBillData & { prefillProposalId?: string })
        .prefillProposalId,
      base64,
      mimeType,
      documentId: uploadResult.documentId,
      fileType,
      idempotencyKey: submissionIdempotencyKey,
      boundingBoxes,
      accounts,
      vendors,
    });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error("Pipeline error", { error: err });
    updateJob(jobId, {
      status: "error",
      error: errMessage || "Failed to process bill",
    });
  }
}

/**
 * User confirmed the reviewed extraction — resume the deferred creation:
 * vendor (if new) + bill + document link, then approve the prefill proposal
 * (fire-and-forget feedback) and invalidate caches.
 */
export async function confirmBillUpload(jobId: string, queryClient: any) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job || job.status !== "awaiting_review" || !job.parsed) return;

  updateJob(jobId, { status: "creating" });

  try {
    const billId = await createVendorAndBill(job, queryClient);
    updateJob(jobId, { status: "done", billId });

    // Feedback flywheel: approving the prefill proposal writes nothing (the
    // bill was just created through the permissioned route above) — it only
    // records the "accepted" label. Fire-and-forget; never block "done".
    const proposalId = job.prefillProposalId;
    if (proposalId) {
      void (async () => {
        try {
          const [{ approveAiProposal }, { callServerFn }] = await Promise.all([
            import("../routes/api/-ai-proposals"),
            import("./server-fn-client"),
          ]);
          await callServerFn(approveAiProposal, {
            data: { proposalId },
          });
        } catch (e) {
          logger.warn("Failed to approve prefill proposal (non-critical)", { error: e });
        }
      })();
    }
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error("Bill creation error", { error: err });
    updateJob(jobId, {
      status: "error",
      error: errMessage || "Failed to create bill",
    });
  }
}

/**
 * User dismissed the reviewed extraction — reject the prefill proposal
 * (fire-and-forget feedback) and drop the job. Nothing was ever written.
 */
export function dismissBillUpload(jobId: string) {
  const job = jobs.find((j) => j.id === jobId);
  if (!job) return;

  const proposalId = job.prefillProposalId;
  if (proposalId) {
    void (async () => {
      try {
        const [{ rejectAiProposal }, { callServerFn }] = await Promise.all([
          import("../routes/api/-ai-proposals"),
          import("./server-fn-client"),
        ]);
        await callServerFn(rejectAiProposal, {
          data: { proposalId },
        });
      } catch (e) {
        logger.warn("Failed to reject prefill proposal (non-critical)", { error: e });
      }
    })();
  }

  removeJob(jobId);
}

/**
 * The original instant-creation tail of the pipeline, extracted so it can run
 * only after user confirmation: vendor (if new) → bill → document link →
 * cache invalidation. Returns the created bill id.
 */
async function createVendorAndBill(job: BillUploadJob, queryClient: any): Promise<string> {
  const aiResult = job.parsed!;
  const accounts = job.accounts ?? [];
  const vendors = job.vendors ?? [];
  const boundingBoxes = job.boundingBoxes ?? [];

  // Create vendor if new
  let vendorId: string | undefined;
  const existingVendor = vendors.find(
    (v: any) => v.name.toLowerCase() === aiResult.vendor.name.toLowerCase(),
  );

  if (existingVendor) {
    vendorId = existingVendor.id;
  } else if (aiResult.vendor.name) {
    const newVendor = await (createParty as (opts: { data: unknown }) => Promise<any>)({
      data: {
        name: aiResult.vendor.name,
        partyType: "vendor",
        email: aiResult.vendor.email || undefined,
        phone: aiResult.vendor.phone || undefined,
        website: aiResult.vendor.website || undefined,
        address: aiResult.vendor.address || undefined,
        mailingAddress: aiResult.vendor.address || undefined,
      },
    });
    vendorId = newVendor.id;
  }

  if (!vendorId) {
    throw new Error("Could not determine vendor");
  }

  // Resolve the default expense account server-side so the org's configured
  // mapping is honored. Previously this called the client resolver without the
  // saved mappings and then fell back to the first of expense /
  // cost_of_revenue / other_expense — a non-deterministic wrong answer that
  // looked authoritative on an AI-extracted bill.
  const mapped = (await (
    getMappedAccounts as (opts: { data: unknown }) => Promise<Record<string, string | null>>
  )({
    data: { mappingType: "bill", sourceKeys: ["default_expense"] },
  })) as Record<string, string | null>;
  const defaultAccountId = mapped.default_expense ?? "";
  if (!defaultAccountId) {
    // Fail with something the user can act on. Previously this fell back to
    // whichever expense-ish account sorted first, silently attaching an
    // AI-extracted bill to an arbitrary category; letting it through empty
    // instead would surface as an opaque Zod error from createBill.
    throw new Error(
      "No default expense category is configured. Set it under Settings → Mappings, or apply a chart-of-accounts template, then try this upload again.",
    );
  }

  // The AI was only shown expense-type categories (the filter above), but
  // its suggestion used to be resolved against the FULL chart — a suggested
  // number like "1200" could land a bill line on Accounts Receivable. Match
  // only within what the model was offered.
  const expenseAccounts = accounts.filter(
    (a: any) =>
      a.accountType === "expense" ||
      a.accountType === "cost_of_revenue" ||
      a.accountType === "other_expense",
  );
  const lineItems = aiResult.lineItems.map((item) => {
    let accountId = defaultAccountId;
    if (item.suggestedCategoryNumber) {
      const match = expenseAccounts.find(
        (a: any) => a.accountNumber === item.suggestedCategoryNumber,
      );
      if (match) accountId = match.id;
    } else if (item.suggestedCategoryName) {
      const match = expenseAccounts.find(
        (a: any) => a.name.toLowerCase() === item.suggestedCategoryName?.toLowerCase(),
      );
      if (match) accountId = match.id;
    }
    return {
      description: item.description,
      amount: item.amount.toString(),
      accountId,
    };
  });

  // Determine classification status
  const classificationStatus = aiResult.classification?.isUncategorized
    ? "needs_review"
    : aiResult.classification?.confidence && aiResult.classification.confidence > 0.7
      ? "auto"
      : "manual";

  // Create the bill
  const bill = await (createBill as (opts: { data: unknown }) => Promise<any>)({
    data: {
      idempotencyKey: job.idempotencyKey,
      vendorId,
      billNumber: aiResult.invoice.invoiceNumber || undefined,
      billDate: aiResult.invoice.invoiceDate || new Date().toISOString().split("T")[0],
      dueDate: aiResult.invoice.dueDate || new Date().toISOString().split("T")[0],
      memo: aiResult.invoice.notes || undefined,
      documentType: job.fileType,
      status: "in_review" as const,
      isRecurring: aiResult.recurring?.isRecurring ?? false,
      recurringFrequency: aiResult.recurring?.frequency,
      categoryConfidence: aiResult.classification?.confidence?.toString(),
      classificationStatus: classificationStatus as "auto" | "needs_review" | "manual",
      ocrBoundingBoxes: boundingBoxes.length > 0 ? boundingBoxes : undefined,
      lineItems,
    },
  });

  // Link the pre-uploaded document to the bill
  if (job.documentId) {
    await (linkDocumentToBill as (opts: { data: unknown }) => Promise<any>)({
      data: {
        billId: bill.id,
        documentId: job.documentId,
      },
    });
  }

  // Invalidate caches
  queryClient.invalidateQueries({ queryKey: keys.bills.all() });
  queryClient.invalidateQueries({ queryKey: keys.parties.all() });
  queryClient.invalidateQueries({ queryKey: keys.documents.all() });

  return bill.id;
}

/**
 * Start a background document replacement job for an existing bill.
 *
 * @param billId - The ID of the bill to update
 * @param file - The new document file
 * @param queryClient - React Query client for cache invalidation
 */
export async function startDocumentReplacement(billId: string, file: File, queryClient: any) {
  const jobId = `doc-replace-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // Add job
  jobs = [
    ...jobs,
    {
      id: jobId,
      fileName: file.name,
      status: "uploading",
      billId, // Track which bill this is for
    },
  ];
  emitChange();

  try {
    // Read file as base64
    const base64 = await fileToBase64(file);
    const mimeType = file.type;

    // 1. Upload new document (clears old attachments automatically)
    updateJob(jobId, { status: "uploading" }); // ensure status

    await (uploadBillDocument as (opts: { data: unknown }) => Promise<any>)({
      data: {
        billId,
        filename: file.name,
        contentType: mimeType,
        fileBase64: base64,
      },
    });

    // 2. Rescan bounding boxes (AI processing)
    updateJob(jobId, { status: "processing" });

    // Parallelize rescan and pdf preview if possible, but rescan is critical
    await Promise.all([
      (rescanBoundingBoxes as (opts: { data: unknown }) => Promise<any>)({
        data: { billId },
      }),
      // Generate preview if PDF (optional, but good for consistency)
      // Note: we'd need documentId to generate preview, which uploadBillDocument returns?
      // Let's perform a lightweight query invalidation early so UI updates
      queryClient.invalidateQueries({ queryKey: keys.bills.detail(billId) }),
    ]);

    // DONE
    updateJob(jobId, { status: "done" });

    // Final invalidation
    queryClient.invalidateQueries({ queryKey: keys.bills.detail(billId) });
    queryClient.invalidateQueries({ queryKey: keys.documents.all() });
  } catch (err: unknown) {
    const errMessage = err instanceof Error ? err.message : String(err);
    logger.error("Document replacement error", { error: err });
    updateJob(jobId, {
      status: "error",
      error: errMessage || "Failed to replace document",
    });
  }
}

// ============================================================================
// Helpers
// ============================================================================

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result as string;
      resolve(result.split(",")[1]);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}
