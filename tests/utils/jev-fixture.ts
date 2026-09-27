/**
 * Shared fixtures for the Jev approval lane integration suites: an
 * organization with the general small business chart, a vendor, and the two
 * dimensions the book rules require, plus a paper Jev proposed.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, withOrgContext, type DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { aiAutonomyLanes, aiRunFeedback, organizationAiSettings } from "@/db/schema/ai";
import { member, organization, user } from "@/db/schema/auth";
import { dimensions } from "@/db/schema/dimensions";
import { documents } from "@/db/schema/documents";
import { organizationAccountingSettings, transactionCandidates } from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { createAiComplete, type AiCompletionRuntime } from "@/lib/ai/facade-core";
import { executeCoaPlan } from "@/lib/coa/execute-plan";
import { hashDocumentContent } from "@/lib/documents/ensure-document";
import { intakeStandaloneDocument } from "@/lib/inbox/document-intake";
import type { AiCompleteFn } from "@/lib/party-match/model-pick";
import { planCoaPreset } from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import { recordJevProposal } from "@/lib/inbox/jev-approval/proposal";
import { createTransactionCandidate } from "@/lib/inbox/service";

export async function setupJevOrganization(
  prefix: string,
  options: { requireDifferentApprover?: boolean } = {},
) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  const reviewerId = `${prefix}-reviewer-${suffix}`;
  await db.insert(user).values([
    { id: userId, name: "Jev Lane Owner", email: `${userId}@test.local`, emailVerified: true },
    {
      id: reviewerId,
      name: "Jev Lane Reviewer",
      email: `${reviewerId}@test.local`,
      emailVerified: true,
    },
  ]);
  await db.insert(organization).values({
    id: orgId,
    name: "Jev Lane Org",
    slug: `${prefix}-${suffix}`,
    metadata: JSON.stringify({ currency: "USD" }),
  });
  await db.insert(member).values([
    { id: `${prefix}-member-${suffix}`, userId, organizationId: orgId, role: "owner" },
    {
      id: `${prefix}-member-r-${suffix}`,
      userId: reviewerId,
      organizationId: orgId,
      role: "admin",
    },
  ]);
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: options.requireDifferentApprover ?? false,
  });
  await withOrgContext(orgId, userId, "owner", async (tx) => {
    const snapshot = await loadCoaSnapshot(tx, orgId);
    const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business, {
      onConflict: "renumber",
    });
    await executeCoaPlan(tx, orgId, plan, userId);
  });
  const byNumber = async (accountNumber: string) => {
    const [row] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.organizationId, orgId), eq(accounts.accountNumber, accountNumber)));
    if (!row) throw new Error(`No account ${accountNumber}`);
    return row;
  };
  const [department, location] = await db
    .insert(dimensions)
    .values([
      { organizationId: orgId, dimensionType: "department", name: "Operations" },
      { organizationId: orgId, dimensionType: "location", name: "Main Office" },
    ])
    .returning();
  const [vendor] = await db
    .insert(parties)
    .values({ organizationId: orgId, name: "Paper Street Supply", partyType: "vendor" })
    .returning();
  return {
    orgId,
    userId,
    reviewerId,
    suffix,
    vendor,
    department,
    location,
    bank: await byNumber("11000"),
    payables: await byNumber("21000"),
    officeSupplies: await byNumber("67200"),
    hardware: await byNumber("67100"),
  };
}

export type JevFixture = Awaited<ReturnType<typeof setupJevOrganization>>;

export function asOrg<T>(
  fixture: Pick<JevFixture, "orgId" | "userId">,
  fn: (tx: DbExecutor) => Promise<T>,
  userId = fixture.userId,
): Promise<T> {
  return withOrgContext(fixture.orgId, userId, "owner", fn);
}

/**
 * A paid expense whose category line Jev picked, as stage 2 leaves it, with the
 * payment side already on the bank (a remembered answer, or a person's) unless
 * `blankPaymentSide`. Amounts, dates and references differ per call so the
 * duplicate engine never pairs two papers. The proposal is recorded like
 * stage 2's job does.
 */
export async function submitJevExpense(
  fixture: JevFixture,
  input: {
    amount: string;
    day: number;
    confidence?: number;
    partyId?: string | null;
    blankPaymentSide?: boolean;
    /** A draft a person typed: no stage 2 evidence on any line. */
    typed?: boolean;
    record?: boolean;
  },
) {
  const dims = { departmentId: fixture.department.id, locationId: fixture.location.id };
  const confidence = input.confidence ?? 0.97;
  const created = await asOrg(fixture, (tx) =>
    createTransactionCandidate(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        transactionDate: `2026-08-${String(input.day).padStart(2, "0")}`,
        transactionType: "pay_out",
        memo: `Supplies ${input.day}`,
        referenceNumber: `JEV-${input.day}-${randomUUID().slice(0, 8)}`,
        partyId: input.partyId === undefined ? fixture.vendor.id : input.partyId,
        sourceChannel: "upload",
        sourceProvider: "jev-fixture",
        candidateType: "document_transaction",
        lines: [
          {
            accountId: fixture.officeSupplies.id,
            debit: input.amount,
            ...(input.typed
              ? {}
              : {
                  categoryConfidence: confidence.toFixed(4),
                  predictionEvidence: {
                    source: "inbox_classification",
                    selection: "model",
                    outcome: "picked",
                    confidence,
                    threshold: 0.8,
                  },
                }),
            ...dims,
          },
          {
            accountId: input.blankPaymentSide ? null : fixture.bank.id,
            credit: input.amount,
            ...dims,
          },
        ],
      },
    ),
  );
  const proposal =
    input.record === false
      ? null
      : await asOrg(fixture, (tx) =>
          recordJevProposal(tx, { orgId: fixture.orgId, candidateId: created.candidate.id }),
        );
  return { item: created.inboxItem, candidate: created.candidate, proposal };
}

/** Accepted (or other) labels already on a lane, oldest first, a second apart. */
export async function seedLaneLabels(
  orgId: string,
  laneId: string,
  counts: { accepted: number; other?: number; confidence?: number },
  startAt = Date.now() - 10_000_000,
) {
  const rows = [
    ...Array.from({ length: counts.accepted }, () => "accepted" as const),
    ...Array.from({ length: counts.other ?? 0 }, () => "corrected" as const),
  ].map((verdict, index) => ({
    organizationId: orgId,
    laneId,
    verdict,
    laneEvidence: { confidence: counts.confidence ?? 0.99, wouldApprove: true },
    createdAt: new Date(startAt + index * 1000),
  }));
  if (rows.length > 0) await db.insert(aiRunFeedback).values(rows);
}

/** Put a lane at auto directly, as a promotion would leave it. */
export async function setLaneAuto(
  laneId: string,
  limits: { amountCap?: string; confidenceThreshold?: string } = {},
) {
  await db
    .update(aiAutonomyLanes)
    .set({
      level: "auto",
      amountCap: limits.amountCap ?? "500",
      confidenceThreshold: limits.confidenceThreshold ?? "0.95",
    })
    .where(eq(aiAutonomyLanes.id, laneId));
}

/** The org's Jev-approval settings row. */
export async function setJevApprovalSettings(
  orgId: string,
  values: Partial<typeof organizationAiSettings.$inferInsert>,
) {
  await db
    .insert(organizationAiSettings)
    .values({ organizationId: orgId, ...values })
    .onConflictDoUpdate({ target: organizationAiSettings.organizationId, set: values });
}

/**
 * An uploaded paper with a cached extraction: intake creates the candidate and
 * enriches it into two unselected placeholder lines, which queues stage 2.
 */
export async function uploadPaper(fixture: JevFixture, extraction: Record<string, unknown>) {
  const [document] = await db
    .insert(documents)
    .values({
      organizationId: fixture.orgId,
      originalFilename: `paper-${randomUUID()}.pdf`,
      storagePath: `r2://test/${fixture.suffix}/paper.pdf`,
      documentType: "receipt",
      fileType: "pdf",
      mimeType: "application/pdf",
      contentHash: hashDocumentContent(Buffer.from(`paper-${randomUUID()}`)),
      metadata: {
        inboxExtraction: {
          version: 1,
          cachedAt: "2026-08-24T00:00:00.000Z",
          result: {
            economicEventClass: "purchase",
            direction: "outflow",
            amount: "48.60",
            currency: "USD",
            date: "2026-08-23",
            party: "Paper Street Supply",
            reference: `R-${randomUUID().slice(0, 6)}`,
            description: "Printer paper",
            ...extraction,
          },
        },
      } as never,
      uploadedById: fixture.userId,
    })
    .returning();
  const intake = await asOrg(fixture, (tx) =>
    intakeStandaloneDocument(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId },
      {
        documentId: document.id,
        filename: document.originalFilename,
        contentType: "application/pdf",
        documentType: "receipt",
        fallbackDate: "2026-08-24",
      },
    ),
  );
  const [candidate] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, intake.candidate!.id));
  return { document, candidate, inboxItemId: intake.inboxItem!.id };
}

/** The real AI façade over a canned runtime: Jev picks `accountCode` at `confidence`. */
export function stubbedJevClassifier(accountCode: string, confidence: number) {
  const runtime: AiCompletionRuntime = {
    async prepare() {
      return { kind: "ready", hops: [{ provider: "jev", model: "jev-1" }] };
    },
    async invokeHop(input) {
      if (input.task !== "categorize_lines") {
        throw new Error(`Unexpected model call: ${input.task}`);
      }
      return {
        text: JSON.stringify({
          lines: [
            { lineIndex: 0, accountCode, confidence, reason: "stub", suggestedNewCategory: "" },
          ],
        }),
        invocationId: null,
        model: "jev-1",
      };
    },
    async recordValidationOutcome() {},
  };
  return createAiComplete(runtime) as AiCompleteFn;
}
