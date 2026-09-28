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
import {
  inboxItems,
  organizationAccountingSettings,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidates,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { createAiComplete, type AiCompletionRuntime } from "@/lib/ai/facade-core";
import { executeCoaPlan } from "@/lib/coa/execute-plan";
import { hashDocumentContent } from "@/lib/documents/ensure-document";
import { intakeStandaloneDocument } from "@/lib/inbox/document-intake";
import type { AiCompleteFn } from "@/lib/party-match/model-pick";
import { planCoaPreset } from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import { classifyInboxCandidate } from "@/lib/inbox/candidate-classification";
import { correctInboxCandidate } from "@/lib/inbox/candidate-correction";
import { recordJevProposalAfterClassification } from "@/lib/inbox/jev-approval/after-classification";
import { recordJevProposal } from "@/lib/inbox/jev-approval/proposal";
import { rememberCorrection } from "@/lib/inbox/memory/service";
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
  counts: { accepted: number; other?: number; confidence?: number; source?: "jev" | "memory" },
  startAt = Date.now() - 10_000_000,
) {
  const rows = [
    ...Array.from({ length: counts.accepted }, () => "accepted" as const),
    ...Array.from({ length: counts.other ?? 0 }, () => "corrected" as const),
  ].map((verdict, index) => ({
    organizationId: orgId,
    laneId,
    verdict,
    laneEvidence: {
      source: counts.source ?? "jev",
      confidence: counts.source === "memory" ? 1 : (counts.confidence ?? 0.99),
      wouldApprove: true,
    },
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

/** An invoice document, so an A/P credit is not missing its invoice. */
async function invoiceDocument(fixture: JevFixture) {
  const [document] = await db
    .insert(documents)
    .values({
      organizationId: fixture.orgId,
      originalFilename: `invoice-${randomUUID()}.pdf`,
      storagePath: `r2://test/${fixture.suffix}/invoice.pdf`,
      documentType: "invoice",
      fileType: "pdf",
      mimeType: "application/pdf",
      contentHash: hashDocumentContent(Buffer.from(`invoice-${randomUUID()}`)),
      uploadedById: fixture.userId,
    })
    .returning();
  return document;
}

/**
 * An emailed vendor bill as the pipeline would propose it: the expense line Jev
 * picked, the A/P credit remembered (build step 10), the invoice attached, and
 * the source classified as an unpaid vendor bill (bill_accrual) the way
 * extraction classifies one. The proposal is recorded like stage 2's job does.
 */
export async function submitJevBill(
  fixture: JevFixture,
  input: { amount: string; day: number; confidence?: number },
) {
  const dims = { departmentId: fixture.department.id, locationId: fixture.location.id };
  const confidence = input.confidence ?? 0.97;
  const document = await invoiceDocument(fixture);
  const created = await asOrg(fixture, (tx) =>
    createTransactionCandidate(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        transactionDate: `2026-08-${String(input.day).padStart(2, "0")}`,
        transactionType: "journal",
        memo: `Supplies invoice ${input.day}`,
        referenceNumber: `INV-${input.day}-${randomUUID().slice(0, 8)}`,
        partyId: fixture.vendor.id,
        sourceChannel: "email",
        sourceProvider: "jev-fixture",
        candidateType: "email_transaction",
        documentIds: [document.id],
        lines: [
          {
            accountId: fixture.officeSupplies.id,
            debit: input.amount,
            categoryConfidence: confidence.toFixed(4),
            predictionEvidence: {
              source: "inbox_classification",
              selection: "model",
              outcome: "picked",
              confidence,
            },
            ...dims,
          },
          {
            accountId: fixture.payables.id,
            credit: input.amount,
            partyId: fixture.vendor.id,
            predictionEvidence: { source: "memory" },
            ...dims,
          },
        ],
      },
    ),
  );
  await db
    .update(sourceRecords)
    .set({ economicEventClass: "bill_accrual", direction: "outflow" })
    .where(eq(sourceRecords.id, created.candidate.sourceRecordId!));
  const proposal = await asOrg(fixture, (tx) =>
    recordJevProposal(tx, { orgId: fixture.orgId, candidateId: created.candidate.id }),
  );
  return { item: created.inboxItem, candidate: created.candidate, proposal, document };
}

/** Turn a book rule off for the organization, as Settings → Review Rules does. */
export async function disableRule(orgId: string, key: string) {
  const [definition] = await db
    .select()
    .from(reviewRuleDefinitions)
    .where(eq(reviewRuleDefinitions.key, key));
  if (!definition) throw new Error(`Review rule ${key} is not seeded.`);
  await db
    .insert(reviewRuleConfigs)
    .values({
      organizationId: orgId,
      definitionId: definition.id,
      enabled: false,
      impact: "blocking",
      config: {},
    })
    .onConflictDoUpdate({
      target: [reviewRuleConfigs.organizationId, reviewRuleConfigs.definitionId],
      set: { enabled: false },
    });
}

/**
 * Stands in for build step 10: a remembered answer fills the payment side
 * stage 2 leaves unpicked, on a new candidate revision, and the `uncategorized`
 * check that blank line tripped is re-evaluated away with it.
 */
export async function rememberPaymentSide(
  fixture: JevFixture,
  input: { candidateId: string; inboxItemId: string; accountId: string },
) {
  await asOrg(fixture, async (tx) => {
    const [candidate] = await tx
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, input.candidateId))
      .for("update");
    const lines = await tx
      .select()
      .from(transactionCandidateLines)
      .where(eq(transactionCandidateLines.candidateId, input.candidateId));
    const blank = lines.find((line) => line.accountId === null);
    if (!blank) throw new Error("No blank line to remember.");
    await tx
      .update(transactionCandidateLines)
      .set({ accountId: input.accountId, predictionEvidence: { source: "memory" } })
      .where(eq(transactionCandidateLines.id, blank.id));
    const next = candidate.revision + 1;
    await tx
      .update(transactionCandidates)
      .set({ revision: next })
      .where(eq(transactionCandidates.id, input.candidateId));
    const [item] = await tx.select().from(inboxItems).where(eq(inboxItems.id, input.inboxItemId));
    await tx
      .update(inboxItems)
      .set({ candidateRevision: next, lockVersion: item.lockVersion + 1 })
      .where(eq(inboxItems.id, input.inboxItemId));
    await tx
      .update(reviewFindings)
      .set({ state: "resolved", resolvedAt: new Date(), resolutionNote: "Remembered answer." })
      .where(
        and(
          eq(reviewFindings.inboxItemId, input.inboxItemId),
          eq(reviewFindings.ruleKey, "uncategorized"),
          eq(reviewFindings.state, "open"),
        ),
      );
  });
}

/**
 * Stage 2 on one uploaded paper, the way its job runs it: the model is the stub
 * given (a remembered answer never calls it), and the classification's own
 * transaction records Jev's proposal for its lane.
 */
export async function classifyPaper(
  fixture: JevFixture,
  candidate: { id: string; revision: number },
  complete: AiCompleteFn = stubbedJevClassifier("67200", 0.96),
) {
  return classifyInboxCandidate(
    { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
    {
      complete,
      beforeCommit: async (tx) => {
        await recordJevProposalAfterClassification(tx, {
          orgId: fixture.orgId,
          candidateId: candidate.id,
        });
        return true;
      },
    },
  );
}

/**
 * Build step 10, for real: stage 2 reads a receipt from the fixture vendor, a
 * reviewer settles its payment side on the bank and saves the entry, and asks
 * Jev to remember it for that vendor. Every later receipt from the vendor is
 * then answered by the memory — category, payment side and vendor — with no
 * model. The organization tracks no departments or locations, so a remembered
 * answer can settle the whole entry.
 */
export async function rememberVendorReceipts(fixture: JevFixture) {
  await disableRule(fixture.orgId, "missing_department");
  await disableRule(fixture.orgId, "missing_location");
  const first = await uploadPaper(fixture, { amount: "48.60", date: "2026-08-20" });
  await classifyPaper(fixture, first.candidate);
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, first.inboxItemId));
  await asOrg(
    fixture,
    (tx) =>
      correctInboxCandidate(
        { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
        {
          inboxItemId: first.inboxItemId,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
          transactionDate: "2026-08-20",
          transactionType: "pay_out",
          memo: "Printer paper",
          partyId: fixture.vendor.id,
          originalCurrency: "USD",
          lines: [
            { accountId: fixture.officeSupplies.id, debit: "48.60" },
            { accountId: fixture.bank.id, credit: "48.60" },
          ],
        },
      ),
    fixture.reviewerId,
  );
  const memory = await asOrg(
    fixture,
    (tx) =>
      rememberCorrection(
        { db: tx, orgId: fixture.orgId, userId: fixture.reviewerId, role: "admin" },
        { candidateId: first.candidate.id, scope: "party" },
      ),
    fixture.reviewerId,
  );
  return { first, memory };
}

/** Another receipt from the fixture vendor, read by stage 2: the memory answers it. */
export async function nextRememberedReceipt(
  fixture: JevFixture,
  input: { amount: string; date: string },
) {
  const paper = await uploadPaper(fixture, { amount: input.amount, date: input.date });
  const classified = await classifyPaper(fixture, paper.candidate);
  return { ...paper, classified };
}
