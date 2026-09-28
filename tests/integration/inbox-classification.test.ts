// ============================================================================
// Inbox stage 2 against a real database: category from a closed list of the
// org's own accounts, the counterparty through the entity pipeline, and the
// payment-details check. The model is always a stub — either a stubbed
// runtime behind the real façade, or AI_MODE=mock for the job handler — so
// nothing here touches a network.
// ============================================================================
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
  // The job handler uses the production façade; mock mode answers every
  // closed-list task with "none" / "new" and never opens a connection.
  vi.stubEnv("AI_MODE", "mock");
});

import { db, withOrgContext } from "@/db";
import { aiActionProposals } from "@/db/schema/ai";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import { documents } from "@/db/schema/documents";
import {
  inboxItems,
  organizationAccountingSettings,
  processingJobs,
  reviewFindings,
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
import {
  CLASSIFY_INBOX_CANDIDATE_JOB_TYPE,
  candidateClassificationDedupeKey,
} from "@/lib/inbox/candidate-classification-job";
import { classifyInboxCandidate } from "@/lib/inbox/candidate-classification";
import { intakeStandaloneDocument } from "@/lib/inbox/document-intake";
import { processClassifyInboxCandidateJob } from "@/lib/jobs/handlers/classify-inbox-candidate";
import type { AiCompleteFn } from "@/lib/party-match/model-pick";
import { findLookalikeParties } from "@/lib/party-match/queries";

const integrationDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

afterAll(() => {
  vi.unstubAllEnvs();
});

interface Fixture {
  orgId: string;
  userId: string;
  suffix: string;
}

async function createOrganizationWithChart(prefix: string): Promise<Fixture> {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Classification Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "Classification Org", slug: `${prefix}-${suffix}` });
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
  return { orgId, userId, suffix };
}

async function accountByNumber(orgId: string, accountNumber: string) {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.organizationId, orgId), eq(accounts.accountNumber, accountNumber)));
  if (!row) throw new Error(`No account ${accountNumber}`);
  return row;
}

async function addParty(
  orgId: string,
  values: Partial<typeof parties.$inferInsert> & { name: string },
) {
  const [row] = await db
    .insert(parties)
    .values({ organizationId: orgId, partyType: "vendor", ...values })
    .returning();
  return row;
}

/** A cached-extraction upload: intake creates the candidate and enriches it. */
async function uploadReceipt(fixture: Fixture, extraction: Record<string, unknown>) {
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
            party: "Staples",
            reference: `R-${randomUUID().slice(0, 6)}`,
            description: "Printer paper and toner",
            ...extraction,
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
  const candidate = intake.candidate!;
  const [current] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, candidate.id));
  return { document, candidate: current, inboxItemId: intake.inboxItem!.id };
}

type CannedAnswers = {
  categorize?: (prompt: string) => unknown;
  matchParty?: (prompt: string) => unknown;
};

/** The real façade (enum schemas, grounding, parsing) over a canned runtime. */
function stubbedComplete(answers: CannedAnswers) {
  const calls: string[] = [];
  const runtime: AiCompletionRuntime = {
    async prepare() {
      return { kind: "ready", hops: [{ provider: "jev", model: "jev-1" }] };
    },
    async invokeHop(input) {
      calls.push(input.task);
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
  return { complete: createAiComplete(runtime) as AiCompleteFn, calls };
}

const categorizeAs =
  (accountCode: string, confidence = 0.93, suggestedNewCategory = "") =>
  () => ({
    lines: [{ lineIndex: 0, accountCode, confidence, reason: "stub", suggestedNewCategory }],
  });

/** Pick the candidate ref whose name matches, from the prompt the model saw. */
const matchByName =
  (name: string, confidence = 0.92) =>
  (prompt: string) => {
    const candidates = JSON.parse(prompt.split("## Candidate parties\n")[1]) as Array<{
      ref: string;
      name: string;
    }>;
    return {
      choice: candidates.find((c) => c.name === name)?.ref ?? "new",
      confidence,
      reason: "",
    };
  };

async function linesOf(candidateId: string) {
  return db
    .select()
    .from(transactionCandidateLines)
    .where(eq(transactionCandidateLines.candidateId, candidateId))
    .orderBy(transactionCandidateLines.sortOrder);
}

async function openFindings(inboxItemId: string) {
  return db
    .select()
    .from(reviewFindings)
    .where(and(eq(reviewFindings.inboxItemId, inboxItemId), eq(reviewFindings.state, "open")));
}

integrationDescribe("inbox stage 2 — category checks", () => {
  it("enrichment queues stage 2 for the new revision and leaves the draft blocked", async () => {
    const fixture = await createOrganizationWithChart("stage2-enqueue");
    const { candidate, inboxItemId } = await uploadReceipt(fixture, {});

    const [job] = await db
      .select()
      .from(processingJobs)
      .where(
        and(
          eq(processingJobs.organizationId, fixture.orgId),
          eq(processingJobs.jobType, CLASSIFY_INBOX_CANDIDATE_JOB_TYPE),
        ),
      );
    expect(job).toMatchObject({
      status: "queued",
      dedupeKey: candidateClassificationDedupeKey(candidate.id, candidate.revision),
      payload: { candidateId: candidate.id, candidateRevision: candidate.revision },
    });
    const lines = await linesOf(candidate.id);
    expect(lines.map((line) => line.accountId)).toEqual([null, null]);
    expect((await openFindings(inboxItemId)).map((finding) => finding.ruleKey)).toContain(
      "uncategorized",
    );
  });

  it("a confident pick from the closed list sets the category line; the payment side still blocks", async () => {
    const fixture = await createOrganizationWithChart("stage2-pick");
    const staples = await addParty(fixture.orgId, { name: "Staples" });
    const { candidate, inboxItemId } = await uploadReceipt(fixture, {});
    const office = await accountByNumber(fixture.orgId, "67200");
    const { complete, calls } = stubbedComplete({ categorize: categorizeAs("67200", 0.93) });

    const result = await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );

    expect(result).toMatchObject({
      status: "classified",
      candidateRevision: candidate.revision + 1,
      party: { outcome: "exact", linkedPartyId: staples.id },
    });
    // Exact name matched the vendor: no model was asked about the party.
    expect(calls).toEqual(["categorize_lines"]);
    const [debit, credit] = await linesOf(candidate.id);
    expect(debit).toMatchObject({
      accountId: office.id,
      categoryConfidence: "0.9300",
      predictionEvidence: { source: "inbox_classification", selection: "model", code: "67200" },
    });
    expect(credit.accountId).toBeNull();

    const [updated] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, candidate.id));
    expect(updated).toMatchObject({ partyId: staples.id, revision: candidate.revision + 1 });
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId));
    expect(item.candidateRevision).toBe(candidate.revision + 1);

    const open = await openFindings(inboxItemId);
    const uncategorized = open.filter((finding) => finding.ruleKey === "uncategorized");
    expect(uncategorized).toHaveLength(1);
    expect(uncategorized[0]).toMatchObject({
      impact: "blocking",
      evidence: { lineIndexes: [1] },
      fingerprint: `${candidate.id}:${candidate.revision + 1}:uncategorized`,
    });
    expect(open.some((finding) => finding.ruleKey === "missing_vendor")).toBe(false);
    const [event] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.entityId, candidate.id),
          eq(workflowEvents.action, "candidate_classified"),
        ),
      );
    expect(event.actorType).toBe("system");
  });

  it("no fit resolves the line to the mapped Uncategorized Expense and the blocking finding names it", async () => {
    const fixture = await createOrganizationWithChart("stage2-nofit");
    const { candidate, inboxItemId } = await uploadReceipt(fixture, {
      description: "Green coffee beans, 60kg sack",
    });
    const uncategorized = await accountByNumber(fixture.orgId, "69999");
    expect(uncategorized.subtype).toBe("uncategorized_expenses");
    const { complete } = stubbedComplete({
      categorize: categorizeAs("none", 0.9, "Green Coffee Purchases"),
      matchParty: () => ({ choice: "new", confidence: 0.9, reason: "" }),
    });

    await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );

    const [debit] = await linesOf(candidate.id);
    expect(debit).toMatchObject({
      accountId: uncategorized.id,
      categoryConfidence: null,
      predictionEvidence: {
        selection: "no_fit_mapped_uncategorized",
        outcome: "no_fit",
        suggestedNewCategory: "Green Coffee Purchases",
      },
    });
    // The suggestion is a note, never an account.
    const created = await db
      .select({ id: accounts.id })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, fixture.orgId),
          eq(accounts.name, "Green Coffee Purchases"),
        ),
      );
    expect(created).toHaveLength(0);

    const finding = (await openFindings(inboxItemId)).find(
      (row) => row.ruleKey === "uncategorized",
    );
    expect(finding).toMatchObject({ impact: "blocking", evidence: { lineIndexes: [0, 1] } });
  });

  it("a code outside the list never lands: the answer is rejected and the line falls to no fit", async () => {
    const fixture = await createOrganizationWithChart("stage2-unknown");
    await addParty(fixture.orgId, { name: "Staples" });
    const { candidate, inboxItemId } = await uploadReceipt(fixture, {});
    const uncategorized = await accountByNumber(fixture.orgId, "69999");
    const bank = await accountByNumber(fixture.orgId, "11000");
    // 11000 is Bank Accounts: real, in this org, but not on the expense list.
    const { complete } = stubbedComplete({ categorize: categorizeAs("11000", 0.99) });

    await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );

    const [debit] = await linesOf(candidate.id);
    expect(debit.accountId).toBe(uncategorized.id);
    expect(debit.accountId).not.toBe(bank.id);
    expect(debit.predictionEvidence).toMatchObject({ outcome: "model_failed" });
    expect(
      (await openFindings(inboxItemId)).find((row) => row.ruleKey === "uncategorized"),
    ).toMatchObject({
      impact: "blocking",
      evidence: { lineIndexes: [0, 1] },
    });
  });

  it("an unavailable model degrades the same way instead of failing the job", async () => {
    const fixture = await createOrganizationWithChart("stage2-disabled");
    const { candidate } = await uploadReceipt(fixture, {});
    const complete = (async () => {
      throw new AiDisabledError(fixture.orgId);
    }) as unknown as AiCompleteFn;

    const result = await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );

    expect(result.status).toBe("classified");
    const [debit] = await linesOf(candidate.id);
    expect(debit.predictionEvidence).toMatchObject({
      outcome: "model_failed",
      failure: "AiDisabledError",
    });
    expect(debit.accountId).toBe((await accountByNumber(fixture.orgId, "69999")).id);
  });

  it("skips a revision a reviewer has already moved past", async () => {
    const fixture = await createOrganizationWithChart("stage2-stale");
    const { candidate } = await uploadReceipt(fixture, {});
    const { complete, calls } = stubbedComplete({ categorize: categorizeAs("67200") });

    const result = await classifyInboxCandidate(
      {
        orgId: fixture.orgId,
        candidateId: candidate.id,
        candidateRevision: candidate.revision - 1,
      },
      { complete },
    );
    expect(result).toEqual({ status: "skipped", reason: "stale_revision" });
    expect(calls).toEqual([]);
  });
});

integrationDescribe("inbox stage 2 — entity checks", () => {
  it("links a look-alike the model picks from the pg_trgm top five", async () => {
    const fixture = await createOrganizationWithChart("stage2-lookalike");
    const acme = await addParty(fixture.orgId, { name: "Acme Supply Co" });
    await addParty(fixture.orgId, { name: "Acme Supplies Ltd" });
    await addParty(fixture.orgId, { name: "Acmex Logistics" });
    const { candidate } = await uploadReceipt(fixture, { party: "ACME SUPPLY CO." });
    const { complete, calls } = stubbedComplete({
      categorize: categorizeAs("67200"),
      matchParty: matchByName("Acme Supply Co", 0.92),
    });

    const result = await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );

    expect(calls).toEqual(["categorize_lines", "match_party"]);
    expect(result).toMatchObject({ party: { outcome: "model", linkedPartyId: acme.id } });
  });

  it('"new" drafts a create_party proposal and links nothing', async () => {
    const fixture = await createOrganizationWithChart("stage2-new");
    const { candidate, inboxItemId } = await uploadReceipt(fixture, {
      party: "Blue Bottle Roasters",
      partyTaxId: "123-456-789-000",
      partyEmail: "billing@bluebottle.test",
    });
    const { complete, calls } = stubbedComplete({ categorize: categorizeAs("67200") });

    const result = await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );

    // Nothing looked alike, so no model was asked about the party at all.
    expect(calls).toEqual(["categorize_lines"]);
    expect(result).toMatchObject({ party: { outcome: "new", linkedPartyId: null } });
    const [proposal] = await db
      .select()
      .from(aiActionProposals)
      .where(
        and(
          eq(aiActionProposals.organizationId, fixture.orgId),
          eq(aiActionProposals.kind, "create_party"),
        ),
      );
    expect(proposal).toMatchObject({
      status: "pending",
      sourceRef: { entityType: "transaction_candidate", entityId: candidate.id },
      proposal: {
        entity: {
          entityType: "vendor",
          name: "Blue Bottle Roasters",
          taxId: "123-456-789-000",
          email: "billing@bluebottle.test",
        },
      },
    });
    const created = await db
      .select()
      .from(parties)
      .where(eq(parties.organizationId, fixture.orgId));
    expect(created).toHaveLength(0);
    expect((await openFindings(inboxItemId)).map((row) => row.ruleKey)).toContain("missing_vendor");
  });

  it("an exact tax id match beats a closer-looking name", async () => {
    const fixture = await createOrganizationWithChart("stage2-tin");
    const byTin = await addParty(fixture.orgId, { name: "ACME Holdings Inc", taxId: "123456789" });
    await addParty(fixture.orgId, { name: "Acme Supply Co" });
    const { candidate } = await uploadReceipt(fixture, {
      party: "Acme Supply Co.",
      partyTaxId: "123-456-789-000",
    });
    const { complete, calls } = stubbedComplete({ categorize: categorizeAs("67200") });

    const result = await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );
    expect(result).toMatchObject({ party: { outcome: "exact", linkedPartyId: byTin.id } });
    expect(calls).toEqual(["categorize_lines"]);
  });

  it("a changed payee bank account raises a blocking finding that a correction does not clear", async () => {
    const fixture = await createOrganizationWithChart("stage2-bank");
    const staples = await addParty(fixture.orgId, {
      name: "Staples",
      bankAccountNumber: "0001-2345-6789",
      bankRoutingNumber: "021000021",
    });
    const { candidate, inboxItemId } = await uploadReceipt(fixture, {
      payeeBankAccountNumber: "9876543210",
      payeeBankRoutingNumber: "026009593",
    });
    const { complete } = stubbedComplete({ categorize: categorizeAs("67200") });

    const result = await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );
    expect(result).toMatchObject({
      paymentDetailsChanged: true,
      party: { linkedPartyId: staples.id },
    });

    const finding = (await openFindings(inboxItemId)).find(
      (row) => row.ruleKey === "party_payment_details_changed",
    );
    expect(finding).toMatchObject({
      impact: "blocking",
      evidence: {
        partyId: staples.id,
        fields: ["bank_account_number", "bank_routing_number"],
        stored: { accountLast4: "6789", routingLast4: "0021" },
        document: { accountLast4: "3210", routingLast4: "9593" },
      },
    });
    // Evidence never carries a full account number.
    expect(JSON.stringify(finding!.evidence)).not.toContain("9876543210");
    // Nothing copies the document's bank details onto the party.
    const [party] = await db.select().from(parties).where(eq(parties.id, staples.id));
    expect(party.bankAccountNumber).toBe("0001-2345-6789");

    // A reviewer's edit re-evaluates the book rules but leaves this one open.
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId));
    const office = await accountByNumber(fixture.orgId, "67200");
    const bank = await accountByNumber(fixture.orgId, "11000");
    await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      correctInboxCandidate(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
        {
          inboxItemId,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
          transactionDate: "2026-07-23",
          transactionType: "pay_out",
          partyId: staples.id,
          originalCurrency: "USD",
          lines: [
            { accountId: office.id, debit: "84.25" },
            { accountId: bank.id, credit: "84.25" },
          ],
        },
      ),
    );
    const stillOpen = (await openFindings(inboxItemId)).filter(
      (row) => row.ruleKey === "party_payment_details_changed",
    );
    expect(stillOpen).toHaveLength(1);
    expect(stillOpen[0].id).toBe(finding!.id);
  });

  it("a reviewer who links a payee with different stored bank details gets the same finding", async () => {
    const fixture = await createOrganizationWithChart("stage2-bank-review");
    const vendor = await addParty(fixture.orgId, {
      name: "Northwind Traders",
      bankAccountNumber: "5555666677",
    });
    // The document names nobody the matcher can find, so stage 2 links no party.
    const { candidate, inboxItemId } = await uploadReceipt(fixture, {
      party: "",
      payeeBankAccountNumber: "1111222233",
    });
    const { complete } = stubbedComplete({ categorize: categorizeAs("67200") });
    await classifyInboxCandidate(
      { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
      { complete },
    );
    expect(
      (await openFindings(inboxItemId)).some(
        (row) => row.ruleKey === "party_payment_details_changed",
      ),
    ).toBe(false);

    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId));
    const office = await accountByNumber(fixture.orgId, "67200");
    const bank = await accountByNumber(fixture.orgId, "11000");
    await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      correctInboxCandidate(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
        {
          inboxItemId,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
          transactionDate: "2026-07-23",
          transactionType: "pay_out",
          partyId: vendor.id,
          originalCurrency: "USD",
          lines: [
            { accountId: office.id, debit: "84.25" },
            { accountId: bank.id, credit: "84.25" },
          ],
        },
      ),
    );
    expect(
      (await openFindings(inboxItemId)).find(
        (row) => row.ruleKey === "party_payment_details_changed",
      ),
    ).toMatchObject({ impact: "blocking", evidence: { partyId: vendor.id } });
  });
});

integrationDescribe("pg_trgm look-alikes", () => {
  /** Mirrors withOrgContext under the non-owner runtime role, so RLS applies. */
  async function asOrg<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return db.transaction(async (tx) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      return fn(tx);
    });
  }

  it("has the trigram index on parties.name", async () => {
    const rows = (await db.execute(
      drizzleSql`select indexdef from pg_indexes where indexname = 'parties_name_trgm_idx'`,
    )) as unknown as Array<{ indexdef: string }>;
    expect(rows[0]?.indexdef).toMatch(/gin \(name gin_trgm_ops\)/);
  });

  it("returns the top five of the right type, most similar first, from this org only", async () => {
    const orgA = `trgm-a-${randomUUID()}`;
    const orgB = `trgm-b-${randomUUID()}`;
    const names = [
      "Acme Supply Co",
      "Acme Supply Company",
      "Acme Supplies",
      "Acme Supply West",
      "Acme Supply East",
      "Acme Supply North",
      "Acme Supply South",
    ];
    const ownIds = new Set<string>();
    for (const name of names) ownIds.add((await addParty(orgA, { name })).id);
    await addParty(orgA, { name: "Acme Supply Co", partyType: "customer" });
    await addParty(orgA, { name: "Acme Supply Company Retired", isActive: false });
    const foreign = await addParty(orgB, { name: "Acme Supply Co" });

    const query = { name: "Acme Supply Co", entityType: "vendor" as const };
    const found = await asOrg(orgA, (tx) => findLookalikeParties(tx, orgA, query));
    expect(found).toHaveLength(5);
    expect(found[0].name).toBe("Acme Supply Co");
    expect(found.every((row) => ownIds.has(row.id))).toBe(true);
    expect(found.some((row) => row.id === foreign.id)).toBe(false);
    const scores = found.map((row) => row.score ?? 0);
    expect([...scores].sort((a, b) => b - a)).toEqual(scores);

    // RLS, not just the predicate: asking for org B from org A's session sees nothing.
    expect(await asOrg(orgA, (tx) => findLookalikeParties(tx, orgB, query))).toEqual([]);
    const fromB = await asOrg(orgB, (tx) => findLookalikeParties(tx, orgB, query));
    expect(fromB.map((row) => row.id)).toEqual([foreign.id]);

    await db.delete(parties).where(inArray(parties.organizationId, [orgA, orgB]));
  });
});

integrationDescribe("classify_inbox_candidate job (AI_MODE=mock)", () => {
  it("classifies and completes atomically; mock mode lands the draft in Needs you", async () => {
    const fixture = await createOrganizationWithChart("stage2-job");
    await addParty(fixture.orgId, { name: "Staples Business Advantage" });
    const { candidate, inboxItemId } = await uploadReceipt(fixture, {});
    const workerId = `test-worker-${randomUUID()}`;
    const [job] = await db
      .update(processingJobs)
      .set({
        status: "running",
        lockedBy: workerId,
        lockedUntil: new Date(Date.now() + 60_000),
        attempts: 1,
      })
      .where(
        and(
          eq(processingJobs.organizationId, fixture.orgId),
          eq(processingJobs.jobType, CLASSIFY_INBOX_CANDIDATE_JOB_TYPE),
        ),
      )
      .returning();

    const result = await processClassifyInboxCandidateJob(job, { workerId });

    expect(result).toMatchObject({ processed: true, candidateRevision: candidate.revision + 1 });
    const [completed] = await db.select().from(processingJobs).where(eq(processingJobs.id, job.id));
    expect(completed).toMatchObject({ status: "completed", lockedBy: null });
    // Mock mode answers "none" and "new": Uncategorized Expense, no party linked.
    const [debit] = await linesOf(candidate.id);
    expect(debit.accountId).toBe((await accountByNumber(fixture.orgId, "69999")).id);
    const open = await openFindings(inboxItemId);
    expect(open.find((row) => row.ruleKey === "uncategorized")).toMatchObject({
      impact: "blocking",
    });

    // A second delivery of the same revision finds the draft moved on.
    const [again] = await db
      .update(processingJobs)
      .set({ status: "running", lockedBy: workerId, lockedUntil: new Date(Date.now() + 60_000) })
      .where(eq(processingJobs.id, job.id))
      .returning();
    expect(await processClassifyInboxCandidateJob(again, { workerId })).toMatchObject({
      processed: true,
      skipped: "stale_revision",
    });
  });
});
