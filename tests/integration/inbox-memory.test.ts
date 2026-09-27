// ============================================================================
// Inbox v2 memory (spec §7) against a real database: a person's correction,
// remembered, answers the next matching paper deterministically — with no
// model on the answer path — and the rules still run on the result.
//
// Server functions run for real behind a reduced request (TanStack Start's
// plumbing and better-auth's cookie lookup are stood in for, exactly as in
// review-rule-settings.test.ts); the caller's role is read live from
// auth_members. Models are always a stub runtime behind the real façade, so
// "no model call" is asserted on the router itself.
// ============================================================================
import { randomUUID } from "node:crypto";
import { and, desc, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

const caller = vi.hoisted(() => ({ userId: "", orgId: "" }));

vi.mock("@tanstack/react-start", () => {
  type Validator = (input: unknown) => unknown;
  type Handler = (opts: { data: unknown }) => unknown;
  const builder = (validate?: Validator) => ({
    inputValidator: (next: Validator) => builder(next),
    handler: (fn: Handler) => async (opts?: { data?: unknown }) =>
      fn({ data: validate ? validate(opts?.data) : opts?.data }),
  });
  return { createServerFn: () => builder() };
});

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () => new Request("http://localhost:3001/_serverFn/inbox-memory", { method: "POST" }),
}));

vi.mock("@/lib/auth", () => ({
  auth: {
    api: {
      getSession: vi.fn(async () => ({
        user: { id: caller.userId },
        session: { activeOrganizationId: caller.orgId },
      })),
      setActiveOrganization: vi.fn(),
    },
  },
}));

import { db, withOrgContext, type DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { aiEvalCases } from "@/db/schema/ai";
import { member, organization, user } from "@/db/schema/auth";
import { classificationMemories } from "@/db/schema/classification-memories";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  organizationAccountingSettings,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import { createAiComplete, type AiCompletionRuntime } from "@/lib/ai/facade-core";
import { executeCoaPlan } from "@/lib/coa/execute-plan";
import { planCoaPreset } from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import { hashDocumentContent } from "@/lib/documents/ensure-document";
import {
  correctInboxCandidate,
  enrichCandidateFromExtractedFacts,
  type CandidateCorrectionLineInput,
} from "@/lib/inbox/candidate-correction";
import { classifyInboxCandidate } from "@/lib/inbox/candidate-classification";
import { intakeStandaloneDocument } from "@/lib/inbox/document-intake";
import { deriveDocumentSourceFacts } from "@/lib/inbox/email-attachment-source";
import { lineTextKey } from "@/lib/inbox/memory/keys";
import { replayMemoryLock } from "@/lib/inbox/memory/lock";
import { noteReversedMemoryEntries } from "@/lib/inbox/memory/tracking";
import { approveInboxItem } from "@/lib/inbox/service";
import { listInboxV2Items } from "@/lib/inbox/v2/list";
import { amendPostedJournal } from "@/lib/journal-amendment";
import type { AiCompleteFn } from "@/lib/party-match/model-pick";

const integrationDescribe = process.env.TEST_DATABASE_URL ? describe : describe.skip;

// Imported after the mocks so the modules are built with them.
const api = await import("@/routes/api/-inbox-memory");
const { voidTransaction } = await import("@/routes/api/transactions/-_mutations");

const PAPER_DATE = "2026-07-23";

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
    name: "Memory Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "Memory Org", slug: `${prefix}-${suffix}` });
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

/** Another member of the organization, holding `role`. */
async function addMember(fixture: Fixture, role: string): Promise<string> {
  const suffix = randomUUID();
  const userId = `memory-${role}-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: `Memory ${role}`,
    email: `memory-${role}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db
    .insert(member)
    .values({ id: `memory-member-${suffix}`, userId, organizationId: fixture.orgId, role });
  return userId;
}

async function accountByNumber(orgId: string, accountNumber: string) {
  const [row] = await db
    .select()
    .from(accounts)
    .where(and(eq(accounts.organizationId, orgId), eq(accounts.accountNumber, accountNumber)));
  if (!row) throw new Error(`No account ${accountNumber}`);
  return row;
}

async function chartOf(fixture: Fixture) {
  const [office, computers, bank, card, ap, uncategorized] = await Promise.all(
    ["67200", "67100", "11000", "22000", "21000", "69999"].map((number) =>
      accountByNumber(fixture.orgId, number),
    ),
  );
  return { office, computers, bank, card, ap, uncategorized };
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

async function disableRule(fixture: Fixture, key: string) {
  const [definition] = await db
    .select({ id: reviewRuleDefinitions.id })
    .from(reviewRuleDefinitions)
    .where(eq(reviewRuleDefinitions.key, key));
  if (!definition) throw new Error(`Review rule ${key} is not seeded.`);
  await db.insert(reviewRuleConfigs).values({
    organizationId: fixture.orgId,
    definitionId: definition.id,
    enabled: false,
    impact: "blocking",
    updatedBy: fixture.userId,
  });
}

type Extraction = Record<string, unknown>;

async function insertDocument(fixture: Fixture, extraction: Extraction, bytes = randomUUID()) {
  const [document] = await db
    .insert(documents)
    .values({
      organizationId: fixture.orgId,
      originalFilename: `receipt-${randomUUID().slice(0, 8)}.pdf`,
      storagePath: `r2://test/${fixture.suffix}/receipt.pdf`,
      documentType: "receipt",
      fileType: "pdf",
      mimeType: "application/pdf",
      contentHash: hashDocumentContent(Buffer.from(`receipt-${bytes}`)),
      metadata: {
        inboxExtraction: {
          version: 1,
          cachedAt: "2026-07-24T00:00:00.000Z",
          result: {
            economicEventClass: "purchase",
            direction: "outflow",
            amount: "84.25",
            currency: "USD",
            date: PAPER_DATE,
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
  return document;
}

async function reloadCandidate(candidateId: string) {
  const [candidate] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, candidateId));
  return candidate;
}

/** A cached-extraction upload: intake creates the candidate and enriches it. */
async function uploadReceipt(fixture: Fixture, extraction: Extraction = {}) {
  const document = await insertDocument(fixture, extraction);
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
  return {
    document,
    candidate: await reloadCandidate(intake.candidate!.id),
    inboxItemId: intake.inboxItem!.id,
  };
}

/**
 * A new paper that carries files the organization already stored — what the
 * inbound-email worker leaves when a vendor re-sends the same PDF: a new
 * attachment source over the canonical (content-deduplicated) document,
 * enriched into the two placeholder lines.
 */
async function paperCarrying(
  fixture: Fixture,
  carried: Array<typeof documents.$inferSelect>,
  options: { from?: string } = {},
) {
  const [primary, ...extra] = carried;
  return withOrgContext(fixture.orgId, fixture.userId, "owner", async (tx) => {
    const facts = deriveDocumentSourceFacts({
      externalId: `resend-attachment:${randomUUID()}`,
      provider: "resend",
      filename: primary.originalFilename,
      documentType: primary.documentType,
      document: primary,
      fallbackDate: "2026-07-24",
      originalCurrency: "USD",
      functionalCurrency: "USD",
    });
    const [source] = await tx
      .insert(sourceRecords)
      .values({
        organizationId: fixture.orgId,
        recordType: "email_attachment",
        externalId: facts.externalId,
        transactionDate: facts.transactionDate,
        description: facts.description,
        amount: facts.amount,
        currency: facts.currency,
        economicEventClass: facts.economicEventClass,
        direction: facts.direction,
        originalAmount: facts.originalAmount,
        originalCurrency: facts.originalCurrency,
        functionalAmount: facts.functionalAmount,
        functionalCurrency: facts.functionalCurrency,
        effectiveDate: facts.effectiveDate,
        normalizedParty: facts.normalizedParty,
        normalizedReference: facts.normalizedReference,
        matcherInputHash: facts.matcherInputHash,
        matcherVersion: facts.matcherVersion,
        rawData: options.from ? { from: options.from } : {},
      })
      .returning();
    await tx.insert(sourceRecordDocuments).values({
      organizationId: fixture.orgId,
      sourceRecordId: source.id,
      documentId: primary.id,
      relationship: "primary_document",
    });
    const [candidate] = await tx
      .insert(transactionCandidates)
      .values({
        organizationId: fixture.orgId,
        sourceRecordId: source.id,
        candidateType: "email_transaction",
        transactionDate: facts.transactionDate ?? PAPER_DATE,
        transactionType: "pay_out",
        memo: facts.description,
        originalCurrency: "USD",
        functionalCurrency: "USD",
        exchangeRate: "1",
      })
      .returning();
    await tx.insert(transactionCandidateSources).values({
      organizationId: fixture.orgId,
      candidateId: candidate.id,
      sourceRecordId: source.id,
      relationship: "origin",
      isPrimary: true,
    });
    for (const document of extra) {
      await tx.insert(documentAttachments).values({
        organizationId: fixture.orgId,
        documentId: document.id,
        linkableType: "transaction_candidate",
        linkableId: candidate.id,
      });
    }
    const [item] = await tx
      .insert(inboxItems)
      .values({
        organizationId: fixture.orgId,
        candidateId: candidate.id,
        sourceRecordId: source.id,
        itemType: "classify_source_record",
        state: "needs_information",
        title: facts.description.slice(0, 255),
      })
      .returning();
    await enrichCandidateFromExtractedFacts({ db: tx, orgId: fixture.orgId }, candidate.id, [
      facts,
    ]);
    return { source, candidate: await reloadCandidateIn(tx, candidate.id), inboxItemId: item.id };
  });
}

async function reloadCandidateIn(tx: DbExecutor, id: string) {
  const [candidate] = await tx
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, id));
  return candidate;
}

/** The real façade over a runtime that records every routing and model call. */
function stubbedComplete(categorizeAs?: string) {
  const calls: string[] = [];
  const prepared: string[] = [];
  const runtime: AiCompletionRuntime = {
    async prepare(input) {
      prepared.push(input.task);
      return { kind: "ready", hops: [{ provider: "jev", model: "jev-1" }] };
    },
    async invokeHop(input) {
      calls.push(input.task);
      if (input.task === "categorize_lines" && categorizeAs) {
        return {
          text: JSON.stringify({
            lines: [
              {
                lineIndex: 0,
                accountCode: categorizeAs,
                confidence: 0.95,
                reason: "stub",
                suggestedNewCategory: "",
              },
            ],
          }),
          invocationId: null,
          model: "jev-1",
        };
      }
      if (input.task === "match_party") {
        return {
          text: JSON.stringify({ choice: "new", confidence: 0.9, reason: "" }),
          invocationId: null,
          model: "jev-1",
        };
      }
      throw new Error(`Unexpected model call: ${input.task}`);
    },
    async recordValidationOutcome() {},
  };
  return { complete: createAiComplete(runtime) as AiCompleteFn, calls, prepared };
}

async function classify(
  fixture: Fixture,
  candidate: { id: string; revision: number },
  complete: AiCompleteFn,
) {
  return classifyInboxCandidate(
    { orgId: fixture.orgId, candidateId: candidate.id, candidateRevision: candidate.revision },
    { complete },
  );
}

async function itemOf(inboxItemId: string) {
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId));
  return item;
}

/** A reviewer's correction, through the real correction path. */
async function correct(
  fixture: Fixture,
  inboxItemId: string,
  input: {
    partyId: string | null;
    lines: CandidateCorrectionLineInput[];
    economicEventClass?: "purchase" | "bill_accrual";
    memo?: string;
  },
  as: { userId: string; role: string } = { userId: fixture.userId, role: "owner" },
) {
  const item = await itemOf(inboxItemId);
  return withOrgContext(fixture.orgId, as.userId, as.role, (tx) =>
    correctInboxCandidate(
      { db: tx, orgId: fixture.orgId, userId: as.userId, role: as.role },
      {
        inboxItemId,
        expectedRevision: item.candidateRevision,
        expectedLockVersion: item.lockVersion,
        transactionDate: PAPER_DATE,
        transactionType: "pay_out",
        economicEventClass: input.economicEventClass,
        memo: input.memo ?? "Printer paper and toner",
        partyId: input.partyId,
        originalCurrency: "USD",
        lines: input.lines,
      },
    ),
  );
}

function asCaller(fixture: Fixture, userId = fixture.userId) {
  caller.orgId = fixture.orgId;
  caller.userId = userId;
}

async function remember(
  fixture: Fixture,
  candidateId: string,
  scope: "file_hash" | "sender_party" | "party" | "line_text",
  userId = fixture.userId,
) {
  asCaller(fixture, userId);
  return api.rememberCorrection({ data: { candidateId, scope } });
}

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

async function memoryRow(memoryId: string) {
  const [row] = await db
    .select()
    .from(classificationMemories)
    .where(eq(classificationMemories.id, memoryId));
  return row;
}

async function eventsFor(entityId: string, action?: string) {
  return db
    .select()
    .from(workflowEvents)
    .where(
      action
        ? and(eq(workflowEvents.entityId, entityId), eq(workflowEvents.action, action))
        : eq(workflowEvents.entityId, entityId),
    )
    .orderBy(desc(workflowEvents.createdAt));
}

/**
 * A corrected, remembered receipt: Office Supplies paid from the bank,
 * vendor Staples. Returns everything a follow-up paper needs.
 */
async function rememberedReceipt(
  fixture: Fixture,
  scope: "file_hash" | "sender_party" | "party" | "line_text",
  extraction: Extraction = {},
) {
  const chart = await chartOf(fixture);
  const [staples] = await db
    .select()
    .from(parties)
    .where(and(eq(parties.organizationId, fixture.orgId), eq(parties.name, "Staples")));
  const vendor = staples ?? (await addParty(fixture.orgId, { name: "Staples" }));
  const first = await uploadReceipt(fixture, extraction);
  // Stage 2 runs first, as it would in production, and guesses wrong.
  const { complete } = stubbedComplete("67100");
  await classify(fixture, first.candidate, complete);
  await correct(fixture, first.inboxItemId, {
    partyId: vendor.id,
    lines: [
      { accountId: chart.office.id, debit: "84.25" },
      { accountId: chart.bank.id, credit: "84.25" },
    ],
  });
  const saved = await remember(fixture, first.candidate.id, scope);
  return { chart, vendor, first, saved };
}

integrationDescribe("memory answers the next paper, with no model", () => {
  it("the same file again gets the same answer, and the router is never called", async () => {
    const fixture = await createOrganizationWithChart("memory-file");
    const { chart, vendor, first, saved } = await rememberedReceipt(fixture, "file_hash");
    expect(saved).toMatchObject({ matchKind: "file_hash", replaced: false });
    expect(saved.keyLabel).toContain(first.document.originalFilename);

    const second = await paperCarrying(fixture, [first.document], {
      from: '"Staples" <receipts@staples.test>',
    });
    const { complete, calls, prepared } = stubbedComplete();
    const result = await classify(fixture, second.candidate, complete);

    // No routing, no model call: the answer came from memory.
    expect(prepared).toEqual([]);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      status: "classified",
      memory: { outcome: "hit", matchKind: "file_hash", memoryIds: [saved.memoryId] },
      party: { outcome: "memory", linkedPartyId: vendor.id },
    });
    const [debit, credit] = await linesOf(second.candidate.id);
    expect(debit).toMatchObject({
      accountId: chart.office.id,
      originalDebit: "84.25000000",
      categoryConfidence: null,
      predictionEvidence: {
        source: "memory",
        memoryId: saved.memoryId,
        matchKind: "file_hash",
      },
    });
    expect(credit).toMatchObject({ accountId: chart.bank.id, originalCredit: "84.25000000" });
    expect((await reloadCandidate(second.candidate.id)).partyId).toBe(vendor.id);
    // The draft is fully answered, so the category rules have nothing to say.
    const ruleKeys = (await openFindings(second.inboxItemId)).map((finding) => finding.ruleKey);
    expect(ruleKeys).not.toContain("uncategorized");
    expect(ruleKeys).not.toContain("missing_vendor");
    expect((await memoryRow(saved.memoryId)).uses).toBe(1);
    expect(await eventsFor(second.candidate.id, "memory_applied")).toHaveLength(1);
  });

  it("writes a test lock that replays, and the org's memory reproduces it exactly", async () => {
    const fixture = await createOrganizationWithChart("memory-lock");
    const { chart, vendor, first, saved } = await rememberedReceipt(fixture, "file_hash");
    const [lock] = await db.select().from(aiEvalCases).where(eq(aiEvalCases.id, saved.evalCaseId));
    expect(lock).toMatchObject({
      organizationId: fixture.orgId,
      task: "inbox_memory",
      provenance: "authored",
      piiRedacted: true,
    });
    expect(lock.expected).toEqual({
      docKind: "purchase",
      partyId: vendor.id,
      lines: [
        { side: "debit", accountId: chart.office.id, amount: "84.25" },
        { side: "credit", accountId: chart.bank.id, amount: "84.25" },
      ],
    });
    // Hermetic replay of the stored row…
    expect(
      replayMemoryLock({
        task: lock.task,
        provenance: lock.provenance,
        inputRef: lock.inputRef,
        expected: lock.expected,
      }),
    ).toMatchObject({ passed: true });
    // …and the live path: the same paper through stage 2 lands on exactly it.
    const second = await paperCarrying(fixture, [first.document]);
    await classify(fixture, second.candidate, stubbedComplete().complete);
    const lines = await linesOf(second.candidate.id);
    const candidate = await reloadCandidate(second.candidate.id);
    const [source] = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, second.source.id));
    expect({
      docKind: source.economicEventClass,
      partyId: candidate.partyId,
      lines: lines.map((line) => ({
        side: line.originalDebit !== null ? "debit" : "credit",
        accountId: line.accountId,
        amount: String(Number(line.originalDebit ?? line.originalCredit)),
      })),
    }).toEqual(lock.expected);
  });

  it("a sender memory answers that sender's next paper at its own amount", async () => {
    const fixture = await createOrganizationWithChart("memory-sender");
    const { chart, vendor, saved } = await rememberedReceipt(fixture, "sender_party", {
      partyEmail: "receipts@staples.test",
      partyTaxId: "123-456-789-000",
    });
    expect(saved.keyLabel).toBe("receipts@staples.test · tax id 123456789000");

    const next = await uploadReceipt(fixture, {
      partyEmail: "Receipts@Staples.test",
      partyTaxId: "123456789000",
      amount: "19.99",
      description: "Stapler",
    });
    const { complete, calls } = stubbedComplete();
    const result = await classify(fixture, next.candidate, complete);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({ memory: { outcome: "hit", matchKind: "sender_party" } });
    const lines = await linesOf(next.candidate.id);
    expect(
      lines.map((line) => [line.accountId, line.originalDebit ?? line.originalCredit]),
    ).toEqual([
      [chart.office.id, "19.99000000"],
      [chart.bank.id, "19.99000000"],
    ]);
    expect((await reloadCandidate(next.candidate.id)).partyId).toBe(vendor.id);
  });

  it("a party memory answers a paper the party is matched to exactly", async () => {
    const fixture = await createOrganizationWithChart("memory-party");
    const { chart, vendor, saved } = await rememberedReceipt(fixture, "party");
    expect(saved.keyLabel).toBe("Staples");

    const next = await uploadReceipt(fixture, { description: "Envelopes", amount: "7.10" });
    const { complete, calls } = stubbedComplete();
    const result = await classify(fixture, next.candidate, complete);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      memory: { outcome: "hit", matchKind: "party", memoryIds: [saved.memoryId] },
    });
    expect((await linesOf(next.candidate.id)).map((line) => line.accountId)).toEqual([
      chart.office.id,
      chart.bank.id,
    ]);
    expect((await reloadCandidate(next.candidate.id)).partyId).toBe(vendor.id);
  });

  it("a remembered doc kind reclassifies the paper the way a reviewer would", async () => {
    const fixture = await createOrganizationWithChart("memory-kind");
    const chart = await chartOf(fixture);
    const vendor = await addParty(fixture.orgId, { name: "Staples" });
    const first = await uploadReceipt(fixture);
    await correct(fixture, first.inboxItemId, {
      partyId: vendor.id,
      economicEventClass: "bill_accrual",
      lines: [
        { accountId: chart.office.id, debit: "84.25" },
        { accountId: chart.ap.id, credit: "84.25" },
      ],
    });
    // No stage 2 ran on the first paper: its keys are derived live.
    const saved = await remember(fixture, first.candidate.id, "file_hash");

    const second = await paperCarrying(fixture, [first.document]);
    expect(second.source.economicEventClass).toBe("purchase");
    const result = await classify(fixture, second.candidate, stubbedComplete().complete);
    expect(result).toMatchObject({ memory: { outcome: "hit", memoryIds: [saved.memoryId] } });
    const [source] = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, second.source.id));
    expect(source.economicEventClass).toBe("bill_accrual");
    expect(source.rawData).toMatchObject({
      memoryReclassification: {
        memoryId: saved.memoryId,
        economicEventClassBefore: "purchase",
        economicEventClassAfter: "bill_accrual",
      },
    });
    expect((await linesOf(second.candidate.id)).map((line) => line.accountId)).toEqual([
      chart.office.id,
      chart.ap.id,
    ]);
  });
});

integrationDescribe("memory hits are still drafts", () => {
  it("a memory never sets bank details, and the payment-details check still blocks", async () => {
    const fixture = await createOrganizationWithChart("memory-bank");
    const chart = await chartOf(fixture);
    const vendor = await addParty(fixture.orgId, {
      name: "Staples",
      bankAccountNumber: "0001-2345-6789",
    });
    const first = await uploadReceipt(fixture);
    await correct(fixture, first.inboxItemId, {
      partyId: vendor.id,
      lines: [
        { accountId: chart.office.id, debit: "84.25" },
        { accountId: chart.bank.id, credit: "84.25" },
      ],
    });
    await remember(fixture, first.candidate.id, "party");

    // A new paper from the same vendor asks to be paid somewhere new.
    const next = await uploadReceipt(fixture, {
      description: "Toner",
      payeeBankAccountNumber: "9876543210",
    });
    const result = await classify(fixture, next.candidate, stubbedComplete().complete);
    expect(result).toMatchObject({ memory: { outcome: "hit" }, paymentDetailsChanged: true });
    const blocking = (await openFindings(next.inboxItemId)).filter(
      (finding) => finding.impact === "blocking",
    );
    expect(blocking.map((finding) => finding.ruleKey)).toContain("party_payment_details_changed");
    const [party] = await db.select().from(parties).where(eq(parties.id, vendor.id));
    expect(party.bankAccountNumber).toBe("0001-2345-6789");
  });

  it("two memories of the same specificity that disagree answer nothing and block", async () => {
    const fixture = await createOrganizationWithChart("memory-conflict");
    const chart = await chartOf(fixture);
    const vendor = await addParty(fixture.orgId, { name: "Staples" });
    const fileA = await insertDocument(fixture, {});
    const fileB = await insertDocument(fixture, {});
    const answerTo = (accountId: string) => ({
      answerDocKind: "purchase",
      answerPartyId: vendor.id,
      answerLines: [
        {
          lineMatch: { side: "debit" as const, index: 0 },
          accountId,
          accountType: "expense",
          amount: "84.25",
          currency: "USD",
          taxCode: null,
        },
        {
          lineMatch: { side: "credit" as const, index: 0 },
          accountId: chart.bank.id,
          accountType: "asset",
          amount: "84.25",
          currency: "USD",
          taxCode: null,
        },
      ],
      createdBy: fixture.userId,
    });
    const [one, two] = await db
      .insert(classificationMemories)
      .values([
        {
          organizationId: fixture.orgId,
          matchKind: "file_hash",
          matchKey: fileA.contentHash!,
          ...answerTo(chart.office.id),
        },
        {
          organizationId: fixture.orgId,
          matchKind: "file_hash",
          matchKey: fileB.contentHash!,
          ...answerTo(chart.computers.id),
        },
        {
          // Less specific, and agreeing with one of them: never consulted.
          organizationId: fixture.orgId,
          matchKind: "party",
          matchKey: vendor.id,
          ...answerTo(chart.office.id),
        },
      ])
      .returning();

    const paper = await paperCarrying(fixture, [fileA, fileB]);
    const { complete, calls, prepared } = stubbedComplete("67200");
    const result = await classify(fixture, paper.candidate, complete);

    expect(prepared).toEqual([]);
    expect(calls).toEqual([]);
    expect(result).toMatchObject({
      memory: {
        outcome: "conflict",
        matchKind: "file_hash",
        memoryIds: [one.id, two.id].sort(),
      },
      categoryLines: [
        { lineIndex: 0, outcome: "memory_conflict", accountId: chart.uncategorized.id },
      ],
    });
    const [debit] = await linesOf(paper.candidate.id);
    expect(debit.accountId).toBe(chart.uncategorized.id);
    expect(debit.predictionEvidence).toMatchObject({
      source: "inbox_classification",
      outcome: "memory_conflict",
    });
    const conflict = (await openFindings(paper.inboxItemId)).find(
      (finding) => finding.ruleKey === "memory_conflict",
    );
    expect(conflict).toMatchObject({ impact: "blocking", evidence: { matchKind: "file_hash" } });
    expect((conflict!.evidence as { answers: unknown[] }).answers).toHaveLength(2);
    // Nothing was counted as a use.
    expect((await memoryRow(one.id)).uses).toBe(0);
    expect((await memoryRow(two.id)).uses).toBe(0);

    // With the wrong one turned off, the next paper is answered.
    asCaller(fixture);
    await api.disableMemory({ data: { memoryId: two.id } });
    const reenriched = await paperCarrying(fixture, [fileA, fileB]);
    const again = await classify(fixture, reenriched.candidate, stubbedComplete().complete);
    expect(again).toMatchObject({ memory: { outcome: "hit", memoryIds: [one.id] } });
    expect(
      (await openFindings(reenriched.inboxItemId)).some(
        (finding) => finding.ruleKey === "memory_conflict",
      ),
    ).toBe(false);
  });

  it("a memory that no longer passes the checks is a flagged miss, and the model answers", async () => {
    const fixture = await createOrganizationWithChart("memory-stale");
    const { chart, first, saved } = await rememberedReceipt(fixture, "file_hash");
    await db.update(accounts).set({ isActive: false }).where(eq(accounts.id, chart.office.id));

    const second = await paperCarrying(fixture, [first.document]);
    const { complete, calls } = stubbedComplete("67100");
    const result = await classify(fixture, second.candidate, complete);

    expect(calls).toEqual(["categorize_lines"]);
    expect(result).toMatchObject({
      memory: {
        outcome: "miss",
        rejected: [
          { memoryId: saved.memoryId, matchKind: "file_hash", reason: "account_inactive" },
        ],
      },
    });
    const [debit] = await linesOf(second.candidate.id);
    expect(debit.accountId).toBe(chart.computers.id);
    expect(debit.predictionEvidence).toMatchObject({
      source: "inbox_classification",
      memory: { outcome: "miss", rejected: [{ reason: "account_inactive" }] },
    });
    expect(await eventsFor(saved.memoryId, "memory_answer_rejected")).toHaveLength(1);
    expect((await memoryRow(saved.memoryId)).uses).toBe(0);

    asCaller(fixture);
    const [listed] = await api.listMemories();
    expect(listed).toMatchObject({
      id: saved.memoryId,
      problem: "An account in the answer is inactive.",
    });
  });
});

integrationDescribe("a remembered answer that settles the entry", () => {
  async function listedItem(fixture: Fixture, inboxItemId: string) {
    const list = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      listInboxV2Items(tx, fixture.orgId),
    );
    return list.items.find((item) => item.id === inboxItemId);
  }

  it("moves to ready for review, reads Ready to approve, and approves as-is", async () => {
    const fixture = await createOrganizationWithChart("memory-ready");
    await disableRule(fixture, "missing_department");
    await disableRule(fixture, "missing_location");
    const { chart, vendor, saved } = await rememberedReceipt(fixture, "party");

    const paper = await uploadReceipt(fixture, { description: "Envelopes", amount: "7.10" });
    expect((await itemOf(paper.inboxItemId)).state).toBe("needs_information");
    const result = await classify(fixture, paper.candidate, stubbedComplete().complete);
    expect(result).toMatchObject({ memory: { outcome: "hit" }, readyForReview: true });
    const item = await itemOf(paper.inboxItemId);
    expect(item.state).toBe("ready_for_review");
    const [classified] = await eventsFor(paper.candidate.id, "candidate_classified");
    expect(classified.data).toMatchObject({
      stateBefore: "needs_information",
      stateAfter: "ready_for_review",
    });

    // The list says so, with the Remembered badge.
    expect(await listedItem(fixture, paper.inboxItemId)).toMatchObject({
      reason: "ready",
      reasonDetail: "remembered",
      sourceBadge: { kind: "remembered" },
    });

    // No correction needed: approval takes the remembered entry as it stands.
    const approval = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
        {
          inboxItemId: paper.inboxItemId,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
        },
      ),
    );
    if (approval.approvalOutcome !== "approved") throw new Error(approval.message);
    expect(await eventsFor(paper.candidate.id, "memory_confirmed")).toHaveLength(1);
    expect(await memoryRow(saved.memoryId)).toMatchObject({ uses: 1, undos: 0 });
    const posted = await linesOf(paper.candidate.id);
    expect(posted.map((line) => line.accountId)).toEqual([chart.office.id, chart.bank.id]);
    expect((await reloadCandidate(paper.candidate.id)).partyId).toBe(vendor.id);
  });

  it("stays in needs_information while any check blocks it", async () => {
    // Department and location are required by default, and nothing remembers them.
    const fixture = await createOrganizationWithChart("memory-not-ready");
    await rememberedReceipt(fixture, "party");
    const paper = await uploadReceipt(fixture, { description: "Envelopes", amount: "7.10" });
    const result = await classify(fixture, paper.candidate, stubbedComplete().complete);
    expect(result).toMatchObject({ memory: { outcome: "hit" }, readyForReview: false });
    expect((await itemOf(paper.inboxItemId)).state).toBe("needs_information");
    expect(await listedItem(fixture, paper.inboxItemId)).toMatchObject({
      reason: "needs_fix",
      sourceBadge: { kind: "remembered" },
    });
  });

  it("names disagreeing memories as the fix and leaves the item where it was", async () => {
    const fixture = await createOrganizationWithChart("memory-conflict-list");
    const chart = await chartOf(fixture);
    const vendor = await addParty(fixture.orgId, { name: "Staples" });
    const fileA = await insertDocument(fixture, {});
    const fileB = await insertDocument(fixture, {});
    const answerTo = (accountId: string) => ({
      organizationId: fixture.orgId,
      matchKind: "file_hash" as const,
      answerDocKind: "purchase",
      answerPartyId: vendor.id,
      answerLines: [
        {
          lineMatch: { side: "debit" as const, index: 0 },
          accountId,
          accountType: "expense",
          amount: "84.25",
          currency: "USD",
          taxCode: null,
        },
        {
          lineMatch: { side: "credit" as const, index: 0 },
          accountId: chart.bank.id,
          accountType: "asset",
          amount: "84.25",
          currency: "USD",
          taxCode: null,
        },
      ],
      createdBy: fixture.userId,
    });
    await db.insert(classificationMemories).values([
      { ...answerTo(chart.office.id), matchKey: fileA.contentHash! },
      { ...answerTo(chart.computers.id), matchKey: fileB.contentHash! },
    ]);
    const paper = await paperCarrying(fixture, [fileA, fileB]);
    const result = await classify(fixture, paper.candidate, stubbedComplete().complete);
    expect(result).toMatchObject({ memory: { outcome: "conflict" }, readyForReview: false });
    expect((await itemOf(paper.inboxItemId)).state).toBe("needs_information");
    const listed = await listedItem(fixture, paper.inboxItemId);
    expect(listed).toMatchObject({ reason: "needs_fix", reasonDetail: "blocking_finding" });
    expect(listed?.reasonText).toMatch(/remembered answers for this file disagree/u);
    expect(listed?.sourceBadge).toBeNull();
  });

  it("writes a remembered bill's payable line to its vendor, as a correction would", async () => {
    const fixture = await createOrganizationWithChart("memory-line-party");
    const chart = await chartOf(fixture);
    const vendor = await addParty(fixture.orgId, { name: "Staples" });
    const first = await uploadReceipt(fixture);
    await correct(fixture, first.inboxItemId, {
      partyId: vendor.id,
      economicEventClass: "bill_accrual",
      lines: [
        { accountId: chart.office.id, debit: "84.25" },
        { accountId: chart.ap.id, credit: "84.25" },
      ],
    });
    await remember(fixture, first.candidate.id, "party");

    const next = await uploadReceipt(fixture, { description: "Toner", amount: "19.99" });
    const result = await classify(fixture, next.candidate, stubbedComplete().complete);
    expect(result).toMatchObject({ memory: { outcome: "hit", matchKind: "party" } });
    const lines = await linesOf(next.candidate.id);
    expect(lines.map((line) => [line.accountId, line.partyId])).toEqual([
      [chart.office.id, null],
      [chart.ap.id, vendor.id],
    ]);
  });
});

integrationDescribe("undo tracking", () => {
  it("two consecutive corrections away turn a memory off", async () => {
    const fixture = await createOrganizationWithChart("memory-undo");
    const { chart, vendor, first, saved } = await rememberedReceipt(fixture, "file_hash");

    for (const round of [1, 2]) {
      const paper = await paperCarrying(fixture, [first.document]);
      const result = await classify(fixture, paper.candidate, stubbedComplete().complete);
      expect(result).toMatchObject({ memory: { outcome: "hit" } });
      const corrected = await correct(fixture, paper.inboxItemId, {
        partyId: vendor.id,
        lines: [
          { accountId: chart.computers.id, debit: "84.25" },
          { accountId: chart.bank.id, credit: "84.25" },
        ],
      });
      expect(corrected.memory).toMatchObject({ outcome: "undone", memoryIds: [saved.memoryId] });
      const row = await memoryRow(saved.memoryId);
      expect(row).toMatchObject({ undos: round, consecutiveUndos: round, uses: round });
      expect(row.enabled).toBe(round < 2);
    }
    const [disabled] = await eventsFor(saved.memoryId, "memory_auto_disabled");
    expect(disabled).toMatchObject({
      actorType: "system",
      data: { consecutiveUndos: 2, limit: 2 },
    });

    // Off means off: the next paper goes to the model.
    const next = await paperCarrying(fixture, [first.document]);
    const { complete, calls } = stubbedComplete("67200");
    const result = await classify(fixture, next.candidate, complete);
    expect(result).toMatchObject({ memory: { outcome: "none" } });
    expect(calls).toEqual(["categorize_lines"]);

    asCaller(fixture);
    const listed = (await api.listMemories()).find((item) => item.id === saved.memoryId);
    expect(listed).toMatchObject({ enabled: false, autoDisabled: true, undos: 2 });
  });

  /**
   * A party memory answers a new paper; the reviewer keeps the answer (editing
   * only the memo) and approves it. A party memory and a different paper,
   * because the same file again is an exact duplicate that blocks approval.
   */
  async function approvedMemoryAnswer(prefix: string, before: { undos?: number } = {}) {
    const fixture = await createOrganizationWithChart(prefix);
    await disableRule(fixture, "missing_department");
    await disableRule(fixture, "missing_location");
    const { chart, vendor, saved } = await rememberedReceipt(fixture, "party");
    if (before.undos) {
      await db
        .update(classificationMemories)
        .set({ undos: before.undos, consecutiveUndos: before.undos })
        .where(eq(classificationMemories.id, saved.memoryId));
    }
    const paper = await uploadReceipt(fixture, { description: "Envelopes", amount: "7.10" });
    const hit = await classify(fixture, paper.candidate, stubbedComplete().complete);
    expect(hit).toMatchObject({ memory: { outcome: "hit", memoryIds: [saved.memoryId] } });
    const kept = await correct(fixture, paper.inboxItemId, {
      partyId: vendor.id,
      memo: "Envelopes — Q3",
      lines: [
        { accountId: chart.office.id, debit: "7.10" },
        { accountId: chart.bank.id, credit: "7.10" },
      ],
    });
    expect(kept.memory).toMatchObject({ outcome: "kept" });
    const item = await itemOf(paper.inboxItemId);
    const approval = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
        {
          inboxItemId: paper.inboxItemId,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
        },
      ),
    );
    if (approval.approvalOutcome !== "approved") throw new Error(approval.message);
    return { fixture, chart, saved, paper, journalHeaderId: approval.journalHeaderId };
  }

  it("editing only the memo is not an undo; approving unchanged is an accepted hit", async () => {
    const { fixture, saved, paper, journalHeaderId } = await approvedMemoryAnswer("memory-accept", {
      undos: 1,
    });
    expect(await memoryRow(saved.memoryId)).toMatchObject({
      uses: 1,
      undos: 1,
      consecutiveUndos: 0,
    });
    expect(await eventsFor(paper.candidate.id, "memory_confirmed")).toHaveLength(1);

    // Reversing the approved entry later is an undo after all.
    await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      amendPostedJournal(tx, {
        organizationId: fixture.orgId,
        userId: fixture.userId,
        headerId: journalHeaderId,
        reason: "Should never have been booked",
      }),
    );
    expect(await memoryRow(saved.memoryId)).toMatchObject({ consecutiveUndos: 1, undos: 2 });
    expect(await eventsFor(paper.candidate.id, "memory_undone")).toHaveLength(1);
  });

  it("an amendment that keeps the memory's accounts only fixes figures: not an undo", async () => {
    const { fixture, chart, saved, paper, journalHeaderId } =
      await approvedMemoryAnswer("memory-amend");
    await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      amendPostedJournal(tx, {
        organizationId: fixture.orgId,
        userId: fixture.userId,
        headerId: journalHeaderId,
        reason: "The receipt said 7.01",
        lines: [
          { accountId: chart.office.id, debit: "7.01" },
          { accountId: chart.bank.id, credit: "7.01" },
        ],
      }),
    );
    expect(await memoryRow(saved.memoryId)).toMatchObject({ undos: 0, consecutiveUndos: 0 });
    expect(await eventsFor(paper.candidate.id, "memory_undone")).toHaveLength(0);
  });

  it("voiding an approved memory answer counts as an undo, once", async () => {
    const { fixture, saved, journalHeaderId } = await approvedMemoryAnswer("memory-void");
    expect(await memoryRow(saved.memoryId)).toMatchObject({ uses: 1, undos: 0 });

    asCaller(fixture);
    // voidTransaction parses its payload in the handler, so Start types it as `undefined`.
    await voidTransaction({ data: { id: journalHeaderId } } as never);
    const [journal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, journalHeaderId));
    expect(journal.status).toBe("voided");
    expect(await memoryRow(saved.memoryId)).toMatchObject({ undos: 1, consecutiveUndos: 1 });

    // A retried hook finds the application already undone.
    await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      noteReversedMemoryEntries(tx, {
        orgId: fixture.orgId,
        journalHeaderIds: [journalHeaderId],
        reason: "posted_entry_voided",
        actorId: fixture.userId,
      }),
    );
    expect(await memoryRow(saved.memoryId)).toMatchObject({ undos: 1, consecutiveUndos: 1 });
  });
});

integrationDescribe("permissions", () => {
  it("only roles that can post entries may save a memory", async () => {
    const fixture = await createOrganizationWithChart("memory-perm");
    const chart = await chartOf(fixture);
    const vendor = await addParty(fixture.orgId, { name: "Staples" });
    const paper = await uploadReceipt(fixture);
    await correct(fixture, paper.inboxItemId, {
      partyId: vendor.id,
      lines: [
        { accountId: chart.office.id, debit: "84.25" },
        { accountId: chart.bank.id, credit: "84.25" },
      ],
    });
    const memberId = await addMember(fixture, "member");
    const viewerId = await addMember(fixture, "report_viewer");
    for (const userId of [memberId, viewerId]) {
      await expect(remember(fixture, paper.candidate.id, "file_hash", userId)).rejects.toThrow(
        /Permission denied: approve on inbox/u,
      );
      asCaller(fixture, userId);
      await expect(
        api.previewMemoryScope({ data: { candidateId: paper.candidate.id, scope: "file_hash" } }),
      ).rejects.toThrow(/Permission denied/u);
    }
    const approverId = await addMember(fixture, "client_approver");
    await expect(
      remember(fixture, paper.candidate.id, "file_hash", approverId),
    ).resolves.toMatchObject({ matchKind: "file_hash" });
    expect(
      await db
        .select()
        .from(classificationMemories)
        .where(eq(classificationMemories.organizationId, fixture.orgId)),
    ).toHaveLength(1);
  });

  it("memories that answer more than one party are admin-only", async () => {
    const fixture = await createOrganizationWithChart("memory-admin");
    const chart = await chartOf(fixture);
    const vendor = await addParty(fixture.orgId, { name: "Staples" });
    const paper = await uploadReceipt(fixture, { partyEmail: "receipts@staples.test" });
    await correct(fixture, paper.inboxItemId, {
      partyId: vendor.id,
      lines: [
        { accountId: chart.office.id, debit: "84.25" },
        { accountId: chart.bank.id, credit: "84.25" },
      ],
    });
    const approverId = await addMember(fixture, "client_approver");
    await expect(remember(fixture, paper.candidate.id, "line_text", approverId)).rejects.toThrow(
      /Permission denied: configure on agentRule/u,
    );
    asCaller(fixture, approverId);
    expect(
      await api.previewMemoryScope({
        data: { candidateId: paper.candidate.id, scope: "line_text" },
      }),
    ).toMatchObject({ available: true, requiresAdmin: true, allowed: false });

    const adminId = await addMember(fixture, "admin");
    const saved = await remember(fixture, paper.candidate.id, "line_text", adminId);
    const row = await memoryRow(saved.memoryId);
    // These words match any party's paper, so they never pin one.
    expect(row).toMatchObject({
      matchKind: "line_text",
      matchKey: lineTextKey("Printer paper and toner"),
      answerPartyId: null,
    });

    // …and they answer another vendor's paper without borrowing Staples.
    const otherVendor = await addParty(fixture.orgId, { name: "Office Depot" });
    const other = await uploadReceipt(fixture, { party: "Office Depot", amount: "12.00" });
    const result = await classify(fixture, other.candidate, stubbedComplete().complete);
    expect(result).toMatchObject({
      memory: { outcome: "hit", matchKind: "line_text" },
      party: { outcome: "exact", linkedPartyId: otherVendor.id },
    });
  });

  it("turning memories on and off, and deleting them, is admin-only", async () => {
    const fixture = await createOrganizationWithChart("memory-manage");
    const { saved } = await rememberedReceipt(fixture, "file_hash");
    const approverId = await addMember(fixture, "client_approver");
    const memberId = await addMember(fixture, "member");
    for (const userId of [approverId, memberId]) {
      asCaller(fixture, userId);
      await expect(api.disableMemory({ data: { memoryId: saved.memoryId } })).rejects.toThrow(
        /Permission denied: configure on agentRule/u,
      );
      await expect(api.deleteMemory({ data: { memoryId: saved.memoryId } })).rejects.toThrow(
        /Permission denied/u,
      );
      // Anyone who can see the Inbox can see what it remembers.
      expect((await api.listMemories()).map((item) => item.id)).toEqual([saved.memoryId]);
    }

    const adminId = await addMember(fixture, "admin");
    asCaller(fixture, adminId);
    await db
      .update(classificationMemories)
      .set({ consecutiveUndos: 2, enabled: false })
      .where(eq(classificationMemories.id, saved.memoryId));
    await api.enableMemory({ data: { memoryId: saved.memoryId } });
    // A person turning it back on gives it a fresh start.
    expect(await memoryRow(saved.memoryId)).toMatchObject({ enabled: true, consecutiveUndos: 0 });
    await api.disableMemory({ data: { memoryId: saved.memoryId } });
    expect((await memoryRow(saved.memoryId)).enabled).toBe(false);
    await api.deleteMemory({ data: { memoryId: saved.memoryId } });
    expect(await memoryRow(saved.memoryId)).toBeUndefined();
    expect((await eventsFor(saved.memoryId)).map((event) => event.action).sort()).toEqual([
      "memory_created",
      "memory_deleted",
      "memory_disabled",
      "memory_enabled",
    ]);
    // The test lock outlives the memory: it is a statement about replay.
    expect(
      await db.select().from(aiEvalCases).where(eq(aiEvalCases.id, saved.evalCaseId)),
    ).toHaveLength(1);
  });

  it("refuses to remember anything but a person's correction", async () => {
    const fixture = await createOrganizationWithChart("memory-guess");
    const paper = await uploadReceipt(fixture);
    await classify(fixture, paper.candidate, stubbedComplete("67200").complete);
    await expect(remember(fixture, paper.candidate.id, "file_hash")).rejects.toThrow(
      /Correct the draft first/u,
    );
    asCaller(fixture);
    expect(
      await api.previewMemoryScope({
        data: { candidateId: paper.candidate.id, scope: "file_hash" },
      }),
    ).toMatchObject({
      available: false,
      reason: expect.stringMatching(/Correct the draft first/u),
    });
  });
});

integrationDescribe("scope preview", () => {
  it("counts only this organization's recent papers, and how many it would change", async () => {
    const fixture = await createOrganizationWithChart("memory-preview");
    const chart = await chartOf(fixture);
    const vendor = await addParty(fixture.orgId, { name: "Staples" });
    const sameAnswer = await uploadReceipt(fixture);
    await correct(fixture, sameAnswer.inboxItemId, {
      partyId: vendor.id,
      lines: [
        { accountId: chart.office.id, debit: "84.25" },
        { accountId: chart.bank.id, credit: "84.25" },
      ],
    });
    const otherAnswer = await uploadReceipt(fixture, { description: "Toner and printer paper" });
    await correct(fixture, otherAnswer.inboxItemId, {
      partyId: vendor.id,
      lines: [
        { accountId: chart.computers.id, debit: "84.25" },
        { accountId: chart.bank.id, credit: "84.25" },
      ],
    });
    // Still a draft with placeholders: the memory would change it too.
    await uploadReceipt(fixture, { description: "PRINTER paper and TONER." });
    // A different description does not match at all.
    await uploadReceipt(fixture, { description: "Coffee beans" });

    // Another organization with the very same words is invisible here.
    const elsewhere = await createOrganizationWithChart("memory-preview-b");
    await uploadReceipt(elsewhere, {});

    const target = await uploadReceipt(fixture);
    await correct(fixture, target.inboxItemId, {
      partyId: vendor.id,
      lines: [
        { accountId: chart.office.id, debit: "84.25" },
        { accountId: chart.bank.id, credit: "84.25" },
      ],
    });
    asCaller(fixture);
    const preview = await api.previewMemoryScope({
      data: { candidateId: target.candidate.id, scope: "line_text" },
    });
    expect(preview).toMatchObject({
      available: true,
      keyLabel: "and paper printer toner",
      matched: 3,
      changed: 2,
      capped: false,
      windowMonths: 12,
      existingMemory: null,
    });
    if (!preview.available) throw new Error("preview unavailable");
    // Past papers only: this one is not counted against itself.
    expect(preview.examined).toBe(4);

    const byFile = await api.previewMemoryScope({
      data: { candidateId: target.candidate.id, scope: "file_hash" },
    });
    expect(byFile).toMatchObject({ available: true, matched: 0, changed: 0 });

    // Papers older than the window are not read at all.
    await db
      .update(transactionCandidates)
      .set({ createdAt: new Date("2024-01-01T00:00:00.000Z") })
      .where(eq(transactionCandidates.id, otherAnswer.candidate.id));
    expect(
      await api.previewMemoryScope({
        data: { candidateId: target.candidate.id, scope: "line_text" },
      }),
    ).toMatchObject({ matched: 2, changed: 1 });
  });
});

integrationDescribe("classification_memories under RLS", () => {
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

  it("keeps each organization's memories to itself", async () => {
    const orgA = await createOrganizationWithChart("memory-rls-a");
    const orgB = await createOrganizationWithChart("memory-rls-b");
    const { saved } = await rememberedReceipt(orgA, "file_hash");

    const seenFromA: Array<{ id: string }> = await asOrg(orgA.orgId, (tx) =>
      tx.select().from(classificationMemories),
    );
    expect(seenFromA.map((row) => row.id)).toEqual([saved.memoryId]);
    expect(await asOrg(orgB.orgId, (tx) => tx.select().from(classificationMemories))).toEqual([]);
    const bUpdate = await asOrg(orgB.orgId, (tx) =>
      tx
        .update(classificationMemories)
        .set({ enabled: false })
        .where(eq(classificationMemories.id, saved.memoryId))
        .returning(),
    );
    expect(bUpdate).toEqual([]);
    await expect(
      asOrg(orgB.orgId, (tx) =>
        tx.insert(classificationMemories).values({
          organizationId: orgA.orgId,
          matchKind: "line_text",
          matchKey: "SMUGGLED",
          createdBy: orgB.userId,
        }),
      ),
    ).rejects.toThrow();

    // A request in org B cannot reach org A's memory through the server functions either.
    asCaller(orgB);
    await expect(api.disableMemory({ data: { memoryId: saved.memoryId } })).rejects.toThrow(
      /Memory not found/u,
    );
    expect((await memoryRow(saved.memoryId)).enabled).toBe(true);

    await db
      .delete(classificationMemories)
      .where(inArray(classificationMemories.organizationId, [orgA.orgId, orgB.orgId]));
  });
});
