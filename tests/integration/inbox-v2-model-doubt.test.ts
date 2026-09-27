// ============================================================================
// Inbox v2 reasons read stage 2's doubts. Stage 2 keeps an answer it could not
// use — a category or counterparty below the threshold, or no usable answer —
// in the line's prediction evidence and on its classification event, and
// parks the draft on the safe fallback. The list must see that doubt: as
// "Jev unsure" when it is all that blocks the entry, and named in the strip
// when something else still needs a fix. The model is always a stub.
// ============================================================================
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // Nothing here may reach a live model, whatever path asks.
  vi.stubEnv("AI_MODE", "mock");
});

import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import { dimensions } from "@/db/schema/dimensions";
import { documents } from "@/db/schema/documents";
import {
  inboxItems,
  organizationAccountingSettings,
  transactionCandidateLines,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { createAiComplete, type AiCompletionRuntime } from "@/lib/ai/facade-core";
import { AiDisabledError } from "@/lib/ai/facade";
import { executeCoaPlan } from "@/lib/coa/execute-plan";
import { planCoaPreset } from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import { hashDocumentContent } from "@/lib/documents/ensure-document";
import { correctInboxCandidate } from "@/lib/inbox/candidate-correction";
import { classifyInboxCandidate } from "@/lib/inbox/candidate-classification";
import { intakeStandaloneDocument } from "@/lib/inbox/document-intake";
import { createTransactionCandidate } from "@/lib/inbox/service";
import { listInboxV2Items } from "@/lib/inbox/v2/list";
import type { AiCompleteFn } from "@/lib/party-match/model-pick";

afterAll(() => {
  vi.unstubAllEnvs();
});

async function setupOrganization(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Model Doubt Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "Model Doubt Org", slug: `${prefix}-${suffix}` });
  await db
    .insert(member)
    .values({ id: `${prefix}-member-${suffix}`, userId, organizationId: orgId, role: "owner" });
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: false,
  });
  await withOrgContext(orgId, userId, "owner", async (tx) => {
    const snapshot = await loadCoaSnapshot(tx, orgId);
    const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business, {
      onConflict: "renumber",
    });
    await executeCoaPlan(tx, orgId, plan, userId);
  });
  const [department, location] = await db
    .insert(dimensions)
    .values([
      { organizationId: orgId, dimensionType: "department", name: "Operations" },
      { organizationId: orgId, dimensionType: "location", name: "Main Office" },
    ])
    .returning();
  const accountByNumber = async (accountNumber: string) => {
    const [row] = await db
      .select()
      .from(accounts)
      .where(and(eq(accounts.organizationId, orgId), eq(accounts.accountNumber, accountNumber)));
    if (!row) throw new Error(`No account ${accountNumber}`);
    return row;
  };
  return {
    orgId,
    userId,
    suffix,
    department,
    location,
    officeSupplies: await accountByNumber("67200"),
    uncategorized: await accountByNumber("69999"),
    bank: await accountByNumber("11000"),
  };
}

type Fixture = Awaited<ReturnType<typeof setupOrganization>>;

async function addParty(orgId: string, name: string) {
  const [row] = await db
    .insert(parties)
    .values({ organizationId: orgId, partyType: "vendor", name })
    .returning();
  return row;
}

/** A cached-extraction upload: intake creates the draft and queues stage 2. */
async function uploadReceipt(fixture: Fixture, party: string) {
  const [document] = await db
    .insert(documents)
    .values({
      organizationId: fixture.orgId,
      originalFilename: `receipt-${randomUUID()}.pdf`,
      storagePath: `r2://test/${fixture.suffix}/receipt.pdf`,
      documentType: "receipt",
      fileType: "pdf",
      mimeType: "application/pdf",
      contentHash: hashDocumentContent(Buffer.from(`receipt-${randomUUID()}`)),
      metadata: {
        inboxExtraction: {
          version: 1,
          cachedAt: "2026-07-24T00:00:00.000Z",
          result: {
            economicEventClass: "purchase",
            direction: "outflow",
            amount: "84.25",
            currency: "USD",
            date: "2026-07-23",
            party,
            reference: `R-${randomUUID().slice(0, 6)}`,
            description: "Printer paper and toner",
          },
        },
      } as never,
      uploadedById: fixture.userId,
    })
    .returning();
  const intake = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    intakeStandaloneDocument(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId },
      {
        documentId: document.id,
        filename: document.originalFilename,
        contentType: "application/pdf",
        documentType: "receipt",
        fallbackDate: "2026-07-24",
      },
    ),
  );
  const [candidate] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, intake.candidate!.id));
  return { candidate, inboxItemId: intake.inboxItem!.id };
}

type CannedAnswers = {
  categorize?: (prompt: string) => unknown;
  matchParty?: (prompt: string) => unknown;
};

/** The real façade (closed-list schemas, parsing) over a canned runtime. */
function stubbedComplete(answers: CannedAnswers) {
  const runtime: AiCompletionRuntime = {
    async prepare() {
      return { kind: "ready", hops: [{ provider: "jev", model: "jev-1" }] };
    },
    async invokeHop(input) {
      const prompt = String(input.prompt);
      const answer =
        input.task === "categorize_lines"
          ? answers.categorize?.(prompt)
          : input.task === "match_party"
            ? answers.matchParty?.(prompt)
            : undefined;
      if (answer === undefined) throw new Error(`Unexpected model call: ${input.task}`);
      return { text: JSON.stringify(answer), invocationId: null, model: "jev-1" };
    },
    async recordValidationOutcome() {},
  };
  return createAiComplete(runtime) as AiCompleteFn;
}

const categorizeAs = (accountCode: string, confidence: number) => () => ({
  lines: [{ lineIndex: 0, accountCode, confidence, reason: "stub", suggestedNewCategory: "" }],
});

/** Pick the candidate ref whose name matches, from the prompt the model saw. */
const matchByName = (name: string, confidence: number) => (prompt: string) => {
  const candidates = JSON.parse(prompt.split("## Candidate parties\n")[1]) as Array<{
    ref: string;
    name: string;
  }>;
  return { choice: candidates.find((c) => c.name === name)?.ref ?? "new", confidence, reason: "" };
};

async function classify(
  fixture: Fixture,
  candidate: { id: string; revision: number },
  complete: AiCompleteFn,
) {
  const result = await classifyInboxCandidate(
    { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
    { complete },
  );
  expect(result.status).toBe("classified");
  return result;
}

async function listed(fixture: Fixture, inboxItemId: string) {
  const { items } = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    listInboxV2Items(tx, fixture.orgId),
  );
  const item = items.find((row) => row.id === inboxItemId);
  if (!item) throw new Error("The item is not listed.");
  return item;
}

const LOOKALIKES = ["Acme Supply Co", "Acme Supplies Ltd", "Acmex Logistics"];

describe("Inbox v2 reasons from stage 2's real output", () => {
  it("names a below-threshold category behind the fix the payment side still needs, until a person settles it", async () => {
    const fixture = await setupOrganization("doubt-category");
    const staples = await addParty(fixture.orgId, "Staples");
    const { candidate, inboxItemId } = await uploadReceipt(fixture, "Staples");

    await classify(
      fixture,
      candidate,
      stubbedComplete({ categorize: categorizeAs("67200", 0.41) }),
    );

    const [categoryLine] = await db
      .select()
      .from(transactionCandidateLines)
      .where(eq(transactionCandidateLines.candidateId, candidate.id))
      .orderBy(transactionCandidateLines.sortOrder);
    expect(categoryLine).toMatchObject({
      accountId: fixture.uncategorized.id,
      predictionEvidence: { source: "inbox_classification", outcome: "low_confidence" },
    });
    // Stage 2 never picks the payment side, so the entry still needs a fix; the strip also says
    // what the model was unsure of. No pick was applied, so there is no Jev badge.
    const unsettled = await listed(fixture, inboxItemId);
    expect(unsettled).toMatchObject({ reason: "needs_fix", sourceBadge: null });
    expect(unsettled.reasonText).toMatch(/ Jev isn't sure about the category \(41% sure\)\.$/);

    // The reviewer's correction is the answer: the doubt goes with the system's lines.
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId));
    await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      correctInboxCandidate(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
        {
          inboxItemId,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
          transactionDate: "2026-07-23",
          transactionType: "pay_out",
          memo: "Printer paper and toner",
          referenceNumber: candidate.referenceNumber,
          partyId: staples.id,
          originalCurrency: "USD",
          exchangeRate: "1",
          lines: [
            {
              accountId: fixture.officeSupplies.id,
              debit: "84.25",
              departmentId: fixture.department.id,
              locationId: fixture.location.id,
            },
            { accountId: fixture.bank.id, credit: "84.25" },
          ],
        },
      ),
    );
    const settled = await listed(fixture, inboxItemId);
    expect(settled).toMatchObject({ reason: "ready" });
    expect(settled.reasonText).not.toMatch(/Jev/);
  });

  it("names an unresolved counterparty from the classification event", async () => {
    const fixture = await setupOrganization("doubt-party");
    for (const name of LOOKALIKES) await addParty(fixture.orgId, name);
    const { candidate, inboxItemId } = await uploadReceipt(fixture, "ACME SUPPLY CO.");

    const result = await classify(
      fixture,
      candidate,
      stubbedComplete({
        categorize: categorizeAs("67200", 0.93),
        matchParty: matchByName("Acme Supply Co", 0.5),
      }),
    );
    expect(result).toMatchObject({ party: { outcome: "unresolved", linkedPartyId: null } });

    const row = await listed(fixture, inboxItemId);
    // The confident category pick is Jev's; the counterparty was not.
    expect(row).toMatchObject({
      reason: "needs_fix",
      sourceBadge: { kind: "jev", confidence: 0.93 },
    });
    expect(row.reasonText).toMatch(/ Jev isn't sure about the vendor or customer \(50% sure\)\.$/);
    expect(row.reasonText).not.toMatch(/category/);
  });

  it("names both failures when the model gave no usable answer at all", async () => {
    const fixture = await setupOrganization("doubt-failed");
    for (const name of LOOKALIKES) await addParty(fixture.orgId, name);
    const { candidate, inboxItemId } = await uploadReceipt(fixture, "ACME SUPPLY CO.");
    const unavailable = (async () => {
      throw new AiDisabledError(fixture.orgId);
    }) as unknown as AiCompleteFn;

    await classify(fixture, candidate, unavailable);

    const row = await listed(fixture, inboxItemId);
    expect(row.reason).toBe("needs_fix");
    expect(row.reasonText).toMatch(
      / Jev couldn't choose a category\. Jev couldn't match the vendor or customer\.$/,
    );
  });
});

describe("Jev unsure when the model's doubt is all that blocks the entry", () => {
  /**
   * A complete paid expense (dimensions set, under the receipt threshold). With stage 2's
   * evidence, its category line is exactly what stage 2 leaves when it is unsure.
   */
  async function submitExpense(
    fixture: Fixture,
    input: {
      amount: string;
      day: number;
      categoryAccountId: string;
      withVendor: boolean;
      stageTwoEvidence: boolean;
    },
  ) {
    const vendor = await addParty(fixture.orgId, `Paper Street Supply ${input.day}`);
    const dimensionsOn = {
      departmentId: fixture.department.id,
      locationId: fixture.location.id,
    };
    const created = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      createTransactionCandidate(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
        {
          transactionDate: `2026-08-${String(input.day).padStart(2, "0")}`,
          transactionType: "pay_out",
          memo: `Stationery ${input.day}`,
          referenceNumber: `DOUBT-${input.day}-${randomUUID().slice(0, 8)}`,
          partyId: input.withVendor ? vendor.id : null,
          lines: [
            {
              accountId: input.categoryAccountId,
              debit: input.amount,
              ...dimensionsOn,
              predictionEvidence: input.stageTwoEvidence
                ? {
                    source: "inbox_classification",
                    task: "categorize_lines",
                    selection: "no_fit_mapped_uncategorized",
                    outcome: "low_confidence",
                    code: "67200",
                    suggestedAccountId: fixture.officeSupplies.id,
                    confidence: 0.41,
                    threshold: 0.8,
                  }
                : null,
            },
            { accountId: fixture.bank.id, credit: input.amount, ...dimensionsOn },
          ],
        },
      ),
    );
    return created.inboxItem;
  }

  it("is Jev unsure for a category stage 2 parked on Uncategorized, and a fix when a person put it there", async () => {
    const fixture = await setupOrganization("doubt-category-only");
    const unsure = await submitExpense(fixture, {
      amount: "23.40",
      day: 7,
      categoryAccountId: fixture.uncategorized.id,
      withVendor: true,
      stageTwoEvidence: true,
    });
    const typed = await submitExpense(fixture, {
      amount: "27.15",
      day: 9,
      categoryAccountId: fixture.uncategorized.id,
      withVendor: true,
      stageTwoEvidence: false,
    });

    expect(await listed(fixture, unsure.id)).toMatchObject({
      reason: "jev_unsure",
      reasonDetail: "model_unsure",
      reasonText: "Jev isn't sure about the category (41% sure).",
    });
    expect(await listed(fixture, typed.id)).toMatchObject({
      reason: "needs_fix",
      reasonDetail: "blocking_finding",
      reasonText: "Choose a leaf category for every posting line.",
    });
  });

  it("is Jev unsure for a missing vendor only while the event that left it unresolved is current", async () => {
    const fixture = await setupOrganization("doubt-party-only");
    const item = await submitExpense(fixture, {
      amount: "31.60",
      day: 11,
      categoryAccountId: fixture.officeSupplies.id,
      withVendor: false,
      stageTwoEvidence: false,
    });
    const [candidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, item.candidateId!));
    /** Stage 2's event, for the revision it produced. */
    const classifiedEvent = (candidateRevision: number) => ({
      organizationId: fixture.orgId,
      inboxItemId: item.id,
      entityType: "transaction_candidate",
      entityId: candidate.id,
      action: "candidate_classified",
      actorType: "system",
      data: {
        candidateRevision,
        party: { outcome: "unresolved", reason: "model_failed", confidence: null },
      },
    });

    const vendorMissing = {
      reason: "needs_fix",
      reasonText: "Assign a vendor to this expense transaction.",
    };
    expect(await listed(fixture, item.id)).toMatchObject(vendorMissing);
    // An event for a revision a person has since moved past no longer describes the draft.
    await db.insert(workflowEvents).values(classifiedEvent(candidate.revision - 1));
    expect(await listed(fixture, item.id)).toMatchObject(vendorMissing);

    await db.insert(workflowEvents).values(classifiedEvent(candidate.revision));
    expect(await listed(fixture, item.id)).toMatchObject({
      reason: "jev_unsure",
      reasonDetail: "model_unsure",
      reasonText: "Jev couldn't match the vendor or customer.",
    });
  });
});
