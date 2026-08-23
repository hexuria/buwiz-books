import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, inArray } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import { dimensions } from "@/db/schema/dimensions";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  ledgerSourceLinks,
  organizationAccountingSettings,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceMatchCandidates,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
} from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { bills } from "@/db/schema/bills";
import { parties } from "@/db/schema/parties";
import { resolveDuplicateCase } from "@/lib/inbox/duplicate-service";
import { runDuplicateMatchingForSource } from "@/lib/inbox/duplicate-engine";
import {
  approveInboxItem,
  type ApproveInboxResult,
  createTransactionCandidate,
} from "@/lib/inbox/service";

function assertApprovalSucceeded(
  result: ApproveInboxResult,
): asserts result is Extract<ApproveInboxResult, { approvalOutcome: "approved" }> {
  if (result.approvalOutcome !== "approved") {
    throw new Error(result.message);
  }
}

async function setupApprovalTestOrganization(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Inbox Approval Test Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Inbox Approval Test Organization",
    slug: `${prefix}-${suffix}`,
  });
  await db.insert(member).values({
    id: `${prefix}-member-${suffix}`,
    userId,
    organizationId: orgId,
    role: "owner",
  });
  const [bank, expense] = await db
    .insert(accounts)
    .values([
      {
        organizationId: orgId,
        accountNumber: "10000",
        name: "Operating Bank",
        accountType: "asset",
        subtype: "checking",
      },
      {
        organizationId: orgId,
        accountNumber: "61000",
        name: "Office Supplies",
        accountType: "expense",
        subtype: "office_supplies",
      },
    ])
    .returning();
  const [department, location] = await db
    .insert(dimensions)
    .values([
      {
        organizationId: orgId,
        dimensionType: "department",
        name: "Operations",
      },
      {
        organizationId: orgId,
        dimensionType: "location",
        name: "Main Office",
      },
    ])
    .returning();
  const [vendor] = await db
    .insert(parties)
    .values({
      organizationId: orgId,
      name: "Approval Test Vendor",
      partyType: "vendor",
    })
    .returning();
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: false,
  });
  return { orgId, userId, bank, expense, department, location, vendor };
}

type ApprovalTestOrganization = Awaited<ReturnType<typeof setupApprovalTestOrganization>>;

async function createWorkflowDocument(
  orgId: string,
  label: string,
  documentType: "receipt" | "other",
) {
  const token = randomUUID();
  const [document] = await db
    .insert(documents)
    .values({
      organizationId: orgId,
      originalFilename: `${label}.pdf`,
      storagePath: `r2://test/${token}/${label}.pdf`,
      documentType,
      fileType: "pdf",
      contentHash: token.replaceAll("-", "").padEnd(64, "0"),
    })
    .returning();
  return document;
}

async function submitDuplicateWorkflowCandidate(
  fixture: ApprovalTestOrganization,
  input: {
    externalId: string;
    documentId: string;
    sourceChannel: "email" | "upload";
    sourceProvider: string;
  },
) {
  return withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    createTransactionCandidate(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        memo: "Team offsite supplies from Workflow Vendor",
        referenceNumber: "WORKFLOW-4242",
        partyId: fixture.vendor.id,
        originalCurrency: "USD",
        sourceChannel: input.sourceChannel,
        sourceProvider: input.sourceProvider,
        externalId: input.externalId,
        documentIds: [input.documentId],
        lines: [
          {
            accountId: fixture.expense.id,
            debit: "84.25",
            departmentId: fixture.department.id,
            locationId: fixture.location.id,
          },
          {
            accountId: fixture.bank.id,
            credit: "84.25",
            departmentId: fixture.department.id,
            locationId: fixture.location.id,
          },
        ],
      },
    ),
  );
}

async function configureSemanticDuplicateShadowMode(fixture: ApprovalTestOrganization) {
  // The definition comes from the seeded catalog (tests/global-setup.ts) — this used to
  // hand-insert it, which masked the fact that CI ran against an empty catalog.
  const [definition] = await db
    .select({ id: reviewRuleDefinitions.id })
    .from(reviewRuleDefinitions)
    .where(eq(reviewRuleDefinitions.key, "possible_duplicate"));
  if (!definition) throw new Error("Possible Duplicate rule definition was not created.");

  await db
    .insert(reviewRuleConfigs)
    .values({
      organizationId: fixture.orgId,
      definitionId: definition.id,
      enabled: true,
      impact: "warning",
      config: {
        mode: "shadow",
        blockingScore: 70,
        shadowScore: 50,
        matchWindowDays: 3,
      },
      updatedBy: fixture.userId,
    })
    .onConflictDoUpdate({
      target: [reviewRuleConfigs.organizationId, reviewRuleConfigs.definitionId],
      set: {
        enabled: true,
        impact: "warning",
        config: {
          mode: "shadow",
          blockingScore: 70,
          shadowScore: 50,
          matchWindowDays: 3,
        },
        updatedBy: fixture.userId,
        updatedAt: new Date(),
      },
    });
}

async function loadOnlyOpenSemanticDuplicateCase(orgId: string) {
  const cases = await db
    .select()
    .from(sourceMatchCandidates)
    .where(
      and(eq(sourceMatchCandidates.organizationId, orgId), eq(sourceMatchCandidates.state, "open")),
    );
  expect(cases).toHaveLength(1);
  expect(cases[0]).toMatchObject({
    matchClass: "duplicate",
    disposition: "shadow",
    state: "open",
  });
  expect((cases[0].evidence as Record<string, unknown>).reason).not.toBe("exact_document");
  return cases[0];
}

describe("Inbox-first transaction workflow", () => {
  it("does not create a journal until a reviewed candidate is approved", async () => {
    const suffix = randomUUID();
    const orgId = `inbox-test-${suffix}`;
    const userId = `inbox-user-${suffix}`;
    await db.insert(user).values({
      id: userId,
      name: "Inbox Test Owner",
      email: `${suffix}@test.local`,
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: orgId,
      name: "Inbox Test Organization",
      slug: `inbox-test-${suffix}`,
    });
    await db.insert(member).values({
      id: `member-${suffix}`,
      userId,
      organizationId: orgId,
      role: "owner",
    });
    const [bank, expense] = await db
      .insert(accounts)
      .values([
        {
          organizationId: orgId,
          accountNumber: "10000",
          name: "Operating Bank",
          accountType: "asset",
          subtype: "checking",
        },
        {
          organizationId: orgId,
          accountNumber: "61000",
          name: "Advertising",
          accountType: "expense",
          subtype: "advertising",
        },
      ])
      .returning();
    const [department, location] = await db
      .insert(dimensions)
      .values([
        {
          organizationId: orgId,
          dimensionType: "department",
          name: "Marketing",
        },
        {
          organizationId: orgId,
          dimensionType: "location",
          name: "Main Office",
        },
      ])
      .returning();
    const [vendor] = await db
      .insert(parties)
      .values({
        organizationId: orgId,
        name: "Test Vendor",
        partyType: "vendor",
      })
      .returning();
    await db.insert(organizationAccountingSettings).values({
      organizationId: orgId,
      baseCurrency: "USD",
      requireDifferentApprover: false,
    });

    const submitted = await withOrgContext(orgId, userId, "owner", (tx) =>
      createTransactionCandidate(
        { db: tx, orgId, userId, role: "owner" },
        {
          transactionDate: "2026-07-24",
          transactionType: "pay_out",
          memo: "Campaign supplies",
          partyId: vendor.id,
          lines: [
            {
              accountId: expense.id,
              debit: "50",
              departmentId: department.id,
              locationId: location.id,
            },
            {
              accountId: bank.id,
              credit: "50",
              departmentId: department.id,
              locationId: location.id,
            },
          ],
        },
      ),
    );

    expect(submitted.findingCount).toBe(0);
    expect(
      await db
        .select({ id: journalHeaders.id })
        .from(journalHeaders)
        .where(eq(journalHeaders.organizationId, orgId)),
    ).toHaveLength(0);

    const approved = await withOrgContext(orgId, userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: submitted.inboxItem.id,
          expectedRevision: submitted.inboxItem.candidateRevision,
          expectedLockVersion: submitted.inboxItem.lockVersion,
        },
      ),
    );
    assertApprovalSucceeded(approved);

    const [posted] = await db
      .select()
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.id, approved.journalHeaderId),
          eq(journalHeaders.organizationId, orgId),
        ),
      );
    expect(posted.status).toBe("posted");
    expect(posted.totalAmount).toBe("50.00000000");
    const [resolvedInbox] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, submitted.inboxItem.id));
    expect(resolvedInbox.state).toBe("approved");
    expect(resolvedInbox.resolvedBy).toBe(userId);
  });

  it("blocks an exact-document duplicate until a durable structured decision is made", async () => {
    const suffix = randomUUID();
    const orgId = `duplicate-test-${suffix}`;
    const userId = `duplicate-user-${suffix}`;
    await db.insert(user).values({
      id: userId,
      name: "Duplicate Test Owner",
      email: `${suffix}@duplicate.test`,
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: orgId,
      name: "Duplicate Test Organization",
      slug: `duplicate-test-${suffix}`,
    });
    await db.insert(member).values({
      id: `member-${suffix}`,
      userId,
      organizationId: orgId,
      role: "owner",
    });
    const [bank, expense] = await db
      .insert(accounts)
      .values([
        {
          organizationId: orgId,
          accountNumber: "10000",
          name: "Operating Bank",
          accountType: "asset",
          subtype: "checking",
        },
        {
          organizationId: orgId,
          accountNumber: "61000",
          name: "Office Supplies",
          accountType: "expense",
          subtype: "office_supplies",
        },
      ])
      .returning();
    const [department, location] = await db
      .insert(dimensions)
      .values([
        {
          organizationId: orgId,
          dimensionType: "department",
          name: "Operations",
        },
        {
          organizationId: orgId,
          dimensionType: "location",
          name: "Main Office",
        },
      ])
      .returning();
    const [vendor] = await db
      .insert(parties)
      .values({
        organizationId: orgId,
        name: "Acme Office Supply",
        partyType: "vendor",
      })
      .returning();
    const [receipt] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "receipt.pdf",
        storagePath: "r2://test/receipt.pdf",
        documentType: "receipt",
        fileType: "pdf",
        contentHash: "a".repeat(64),
      })
      .returning();
    await db.insert(organizationAccountingSettings).values({
      organizationId: orgId,
      baseCurrency: "USD",
      requireDifferentApprover: false,
    });

    const submit = (requestIdempotencyKey: string, externalId: string) =>
      withOrgContext(orgId, userId, "owner", (tx) =>
        createTransactionCandidate(
          { db: tx, orgId, userId, role: "owner" },
          {
            transactionDate: "2026-07-24",
            transactionType: "pay_out",
            memo: "Printer paper from Acme",
            referenceNumber: "RCPT-4242",
            partyId: vendor.id,
            originalCurrency: "USD",
            sourceChannel: "upload",
            sourceProvider: "receipt_upload",
            requestIdempotencyKey,
            externalId,
            documentIds: [receipt.id],
            lines: [
              {
                accountId: expense.id,
                debit: "49.99",
                departmentId: department.id,
                locationId: location.id,
              },
              {
                accountId: bank.id,
                credit: "49.99",
                departmentId: department.id,
                locationId: location.id,
              },
            ],
          },
        ),
      );

    const first = await submit(randomUUID(), `email:${suffix}`);
    const second = await submit(randomUUID(), `upload:${suffix}`);
    expect(second.findingCount).toBe(1);

    const [duplicateCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.organizationId, orgId));
    expect(duplicateCase).toMatchObject({
      state: "open",
      disposition: "blocking",
      score: "100.00",
    });

    const [emailContainer] = await db
      .insert(sourceRecords)
      .values({
        organizationId: orgId,
        recordType: "email",
        externalId: `email-container:${suffix}`,
        description: "Forwarded receipt email",
      })
      .returning();
    await db.insert(sourceRecordDocuments).values({
      organizationId: orgId,
      sourceRecordId: emailContainer.id,
      documentId: receipt.id,
      relationship: "email_attachment",
    });
    const [legacyLeftSourceId, legacyRightSourceId] = [
      emailContainer.id,
      first.candidate.sourceRecordId!,
    ].sort();
    const [legacyContainerCase] = await db
      .insert(sourceMatchCandidates)
      .values({
        organizationId: orgId,
        leftSourceRecordId: legacyLeftSourceId,
        rightSourceRecordId: legacyRightSourceId,
        matchType: "exact",
        confidence: "1",
        matchClass: "duplicate",
        disposition: "blocking",
        score: "100",
        state: "open",
      })
      .returning();
    const containerMatch = await withOrgContext(orgId, userId, "owner", (tx) =>
      runDuplicateMatchingForSource({ db: tx, orgId, userId }, emailContainer.id, "source_updated"),
    );
    expect(containerMatch).toMatchObject({
      evaluated: 0,
      blockingCases: [],
      skipped: true,
    });
    expect(containerMatch.staleCases).toContain(legacyContainerCase.id);
    const [staleContainerCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, legacyContainerCase.id));
    expect(staleContainerCase.state).toBe("stale");

    await db
      .delete(sourceRecordDocuments)
      .where(
        and(
          eq(sourceRecordDocuments.organizationId, orgId),
          eq(sourceRecordDocuments.sourceRecordId, second.candidate.sourceRecordId!),
          eq(sourceRecordDocuments.documentId, receipt.id),
        ),
      );
    await db
      .update(sourceRecords)
      .set({ amount: "75", originalAmount: "75", updatedAt: new Date() })
      .where(eq(sourceRecords.id, second.candidate.sourceRecordId!));
    const staleMatch = await withOrgContext(orgId, userId, "owner", (tx) =>
      runDuplicateMatchingForSource(
        { db: tx, orgId, userId },
        second.candidate.sourceRecordId!,
        "source_updated",
      ),
    );
    expect(staleMatch.staleCases).toContain(duplicateCase.id);
    const [staleCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, duplicateCase.id));
    expect(staleCase.state).toBe("stale");
    const staleFindings = await db
      .select({ state: reviewFindings.state })
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, orgId),
          eq(reviewFindings.ruleKey, "possible_duplicate"),
        ),
      );
    expect(staleFindings.length).toBeGreaterThan(0);
    expect(staleFindings.every(({ state }) => state === "resolved")).toBe(true);

    await db
      .update(sourceRecords)
      .set({ amount: "49.99", originalAmount: "49.99", updatedAt: new Date() })
      .where(eq(sourceRecords.id, second.candidate.sourceRecordId!));
    await db.insert(sourceRecordDocuments).values({
      organizationId: orgId,
      sourceRecordId: second.candidate.sourceRecordId!,
      documentId: receipt.id,
    });
    const reopenedMatch = await withOrgContext(orgId, userId, "owner", (tx) =>
      runDuplicateMatchingForSource(
        { db: tx, orgId, userId },
        second.candidate.sourceRecordId!,
        "document_attached",
      ),
    );
    expect(reopenedMatch.blockingCases).toContain(duplicateCase.id);
    const [reopenedCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, duplicateCase.id));
    expect(reopenedCase.state).toBe("open");

    const firstBlockedApproval = await withOrgContext(orgId, userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: first.inboxItem.id,
          expectedRevision: first.inboxItem.candidateRevision,
          expectedLockVersion: first.inboxItem.lockVersion,
        },
      ),
    );
    expect(firstBlockedApproval).toMatchObject({
      approvalOutcome: "blocked",
      reason: "possible_duplicate",
      caseId: reopenedCase.id,
    });

    // Even if a stale/legacy path clears the finding row, approval must query
    // the durable duplicate case directly.
    await db
      .update(reviewFindings)
      .set({ state: "resolved", resolvedAt: new Date() })
      .where(
        and(
          eq(reviewFindings.organizationId, orgId),
          eq(reviewFindings.ruleKey, "possible_duplicate"),
        ),
      );
    const blockedWithoutFinding = await withOrgContext(orgId, userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: first.inboxItem.id,
          expectedRevision: first.inboxItem.candidateRevision,
          expectedLockVersion: first.inboxItem.lockVersion,
        },
      ),
    );
    expect(blockedWithoutFinding).toMatchObject({
      approvalOutcome: "blocked",
      reason: "possible_duplicate",
      caseId: reopenedCase.id,
    });

    const [caseAfterApprovalGate] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, reopenedCase.id));
    const resolutionIdempotencyKey = randomUUID();
    const resolutionInput = {
      caseId: reopenedCase.id,
      action: "keep_separate" as const,
      reason: "These are distinct purchases made on the same receipt template.",
      expectedVersion: caseAfterApprovalGate.lockVersion,
      idempotencyKey: resolutionIdempotencyKey,
    };
    await withOrgContext(orgId, userId, "owner", (tx) =>
      resolveDuplicateCase({ db: tx, orgId, userId, role: "owner" }, resolutionInput),
    );
    const replayedResolution = await withOrgContext(orgId, userId, "owner", (tx) =>
      resolveDuplicateCase({ db: tx, orgId, userId, role: "owner" }, resolutionInput),
    );
    expect(replayedResolution.alreadyResolved).toBe(true);
    await expect(
      withOrgContext(orgId, userId, "owner", (tx) =>
        resolveDuplicateCase(
          { db: tx, orgId, userId, role: "owner" },
          {
            ...resolutionInput,
            reason: "A different request must not reuse this key.",
          },
        ),
      ),
    ).rejects.toThrow("different duplicate resolution");

    const rematch = await withOrgContext(orgId, userId, "owner", (tx) =>
      runDuplicateMatchingForSource(
        { db: tx, orgId, userId },
        second.candidate.sourceRecordId!,
        "source_updated",
      ),
    );
    expect(rematch.blockingCases).toEqual([]);
    expect(rematch.shadowCases).toEqual([]);

    for (const submitted of [first, second]) {
      await withOrgContext(orgId, userId, "owner", (tx) =>
        approveInboxItem(
          { db: tx, orgId, userId, role: "owner" },
          {
            inboxItemId: submitted.inboxItem.id,
            expectedRevision: submitted.inboxItem.candidateRevision,
            expectedLockVersion: submitted.inboxItem.lockVersion,
          },
        ),
      );
    }

    const posted = await db
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(eq(journalHeaders.organizationId, orgId));
    expect(posted).toHaveLength(2);
  });

  it("returns the existing Inbox candidate when a manual request is retried", async () => {
    const suffix = randomUUID();
    const orgId = `retry-test-${suffix}`;
    const userId = `retry-user-${suffix}`;
    await db.insert(user).values({
      id: userId,
      name: "Retry Test Owner",
      email: `${suffix}@retry.test`,
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: orgId,
      name: "Retry Test Organization",
      slug: `retry-test-${suffix}`,
    });
    await db.insert(member).values({
      id: `member-${suffix}`,
      userId,
      organizationId: orgId,
      role: "owner",
    });
    const [bank, expense] = await db
      .insert(accounts)
      .values([
        {
          organizationId: orgId,
          accountNumber: "10000",
          name: "Operating Bank",
          accountType: "asset",
          subtype: "checking",
        },
        {
          organizationId: orgId,
          accountNumber: "61000",
          name: "Supplies",
          accountType: "expense",
          subtype: "supplies",
        },
      ])
      .returning();
    await db.insert(organizationAccountingSettings).values({
      organizationId: orgId,
      baseCurrency: "USD",
      requireDifferentApprover: false,
    });

    const requestIdempotencyKey = randomUUID();
    const submit = () =>
      withOrgContext(orgId, userId, "owner", (tx) =>
        createTransactionCandidate(
          { db: tx, orgId, userId, role: "owner" },
          {
            transactionDate: "2026-07-24",
            transactionType: "pay_out",
            memo: "Retry-safe purchase",
            requestIdempotencyKey,
            lines: [
              { accountId: expense.id, debit: "10" },
              { accountId: bank.id, credit: "10" },
            ],
          },
        ),
      );

    const first = await submit();
    const replay = await submit();
    expect(replay.deduplicated).toBe(true);
    expect(replay.candidate.id).toBe(first.candidate.id);
    expect(replay.inboxItem.id).toBe(first.inboxItem.id);
  });

  it("does not post a second journal for a source that already has an origin journal", async () => {
    const { orgId, userId, bank, expense, department, location, vendor } =
      await setupApprovalTestOrganization("origin-safety");
    const first = await withOrgContext(orgId, userId, "owner", (tx) =>
      createTransactionCandidate(
        { db: tx, orgId, userId, role: "owner" },
        {
          transactionDate: "2026-07-24",
          transactionType: "pay_out",
          memo: "Single economic event",
          partyId: vendor.id,
          sourceChannel: "bank",
          sourceProvider: "test_bank",
          externalId: `bank-event:${randomUUID()}`,
          lines: [
            {
              accountId: expense.id,
              debit: "25",
              departmentId: department.id,
              locationId: location.id,
            },
            {
              accountId: bank.id,
              credit: "25",
              departmentId: department.id,
              locationId: location.id,
            },
          ],
        },
      ),
    );
    const firstApproval = await withOrgContext(orgId, userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: first.inboxItem.id,
          expectedRevision: first.inboxItem.candidateRevision,
          expectedLockVersion: first.inboxItem.lockVersion,
        },
      ),
    );
    assertApprovalSucceeded(firstApproval);

    const [secondCandidate] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: orgId,
        sourceRecordId: first.candidate.sourceRecordId,
        requestIdempotencyKey: randomUUID(),
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        memo: "A second candidate for the same source",
        partyId: vendor.id,
        originalCurrency: "USD",
        functionalCurrency: "USD",
        originalTotal: "25",
        functionalTotal: "25",
        submittedBy: userId,
      })
      .returning();
    await db.insert(transactionCandidateSources).values({
      organizationId: orgId,
      candidateId: secondCandidate.id,
      sourceRecordId: first.candidate.sourceRecordId!,
      relationship: "origin",
      isPrimary: true,
    });
    await db.insert(transactionCandidateLines).values([
      {
        organizationId: orgId,
        candidateId: secondCandidate.id,
        accountId: expense.id,
        originalDebit: "25",
        functionalDebit: "25",
        originalCurrency: "USD",
        departmentId: department.id,
        locationId: location.id,
        sortOrder: 0,
      },
      {
        organizationId: orgId,
        candidateId: secondCandidate.id,
        accountId: bank.id,
        originalCredit: "25",
        functionalCredit: "25",
        originalCurrency: "USD",
        departmentId: department.id,
        locationId: location.id,
        sortOrder: 1,
      },
    ]);
    const [secondInboxItem] = await db
      .insert(inboxItems)
      .values({
        organizationId: orgId,
        candidateId: secondCandidate.id,
        sourceRecordId: first.candidate.sourceRecordId,
        title: "Review repeated source",
        submittedBy: userId,
      })
      .returning();

    await expect(
      withOrgContext(orgId, userId, "owner", (tx) =>
        approveInboxItem(
          { db: tx, orgId, userId, role: "owner" },
          {
            inboxItemId: secondInboxItem.id,
            expectedRevision: secondInboxItem.candidateRevision,
            expectedLockVersion: secondInboxItem.lockVersion,
          },
        ),
      ),
    ).rejects.toThrow("already produced posted transaction");

    const postedHeaders = await db
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(eq(journalHeaders.organizationId, orgId));
    expect(postedHeaders).toEqual([{ id: firstApproval.journalHeaderId }]);
    const postedLines = await db
      .select({ id: journalLines.id })
      .from(journalLines)
      .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
      .where(eq(journalHeaders.organizationId, orgId));
    expect(postedLines).toHaveLength(2);
    const originLinks = await db
      .select({
        journalHeaderId: ledgerSourceLinks.journalHeaderId,
        sourceRecordId: ledgerSourceLinks.sourceRecordId,
      })
      .from(ledgerSourceLinks)
      .where(
        and(
          eq(ledgerSourceLinks.organizationId, orgId),
          eq(ledgerSourceLinks.sourceRecordId, first.candidate.sourceRecordId!),
          eq(ledgerSourceLinks.relationship, "origin"),
        ),
      );
    expect(originLinks).toEqual([
      {
        journalHeaderId: firstApproval.journalHeaderId,
        sourceRecordId: first.candidate.sourceRecordId,
      },
    ]);
    const [unchangedCandidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, secondCandidate.id));
    const [unchangedInboxItem] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, secondInboxItem.id));
    expect(unchangedCandidate).toMatchObject({
      status: "current",
      postedJournalHeaderId: null,
    });
    expect(unchangedInboxItem).toMatchObject({
      state: "ready_for_review",
      resolvedBy: null,
      resolvedAt: null,
      lockVersion: secondInboxItem.lockVersion,
    });
  });

  it("posts an accounting child as origin instead of its email container", async () => {
    const fixture = await setupApprovalTestOrganization("email-child-origin");
    const [emailContainer] = await db
      .insert(sourceRecords)
      .values({
        organizationId: fixture.orgId,
        recordType: "email",
        externalId: `email:${randomUUID()}`,
        description: "Payment confirmation email",
        economicEventClass: "other",
        direction: "unknown",
      })
      .returning();
    const [paymentChild] = await db
      .insert(sourceRecords)
      .values({
        organizationId: fixture.orgId,
        parentSourceRecordId: emailContainer.id,
        recordType: "email_attachment",
        externalId: `attachment:${randomUUID()}`,
        transactionDate: "2026-07-24",
        description: "Vendor bill payment confirmation",
        economicEventClass: "bill_payment",
        direction: "outflow",
        originalAmount: "84.25",
        originalCurrency: "USD",
        functionalAmount: "84.25",
        functionalCurrency: "USD",
        effectiveDate: "2026-07-24",
        normalizedParty: "approval test vendor",
        normalizedReference: "payment4242",
      })
      .returning();
    const [candidate] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: fixture.orgId,
        sourceRecordId: emailContainer.id,
        candidateType: "transaction",
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        memo: "Vendor bill payment confirmation",
        referenceNumber: "PAYMENT-4242",
        partyId: fixture.vendor.id,
        originalCurrency: "USD",
        functionalCurrency: "USD",
        exchangeRate: "1",
        originalTotal: "84.25",
        functionalTotal: "84.25",
        submittedBy: fixture.userId,
      })
      .returning();
    await db.insert(transactionCandidateSources).values([
      {
        organizationId: fixture.orgId,
        candidateId: candidate.id,
        sourceRecordId: emailContainer.id,
        relationship: "origin",
        isPrimary: true,
      },
      {
        organizationId: fixture.orgId,
        candidateId: candidate.id,
        sourceRecordId: paymentChild.id,
        relationship: "supporting",
        isPrimary: false,
      },
    ]);
    await db.insert(transactionCandidateLines).values([
      {
        organizationId: fixture.orgId,
        candidateId: candidate.id,
        accountId: fixture.expense.id,
        originalDebit: "84.25",
        functionalDebit: "84.25",
        originalCurrency: "USD",
        exchangeRate: "1",
        sortOrder: 0,
      },
      {
        organizationId: fixture.orgId,
        candidateId: candidate.id,
        accountId: fixture.bank.id,
        originalCredit: "84.25",
        functionalCredit: "84.25",
        originalCurrency: "USD",
        exchangeRate: "1",
        sortOrder: 1,
      },
    ]);
    const [item] = await db
      .insert(inboxItems)
      .values({
        organizationId: fixture.orgId,
        candidateId: candidate.id,
        sourceRecordId: emailContainer.id,
        state: "ready_for_review",
        title: "Vendor bill payment confirmation",
        submittedBy: fixture.userId,
      })
      .returning();

    const approval = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      approveInboxItem(
        {
          db: tx,
          orgId: fixture.orgId,
          userId: fixture.userId,
          role: "owner",
        },
        {
          inboxItemId: item.id,
          expectedRevision: item.candidateRevision,
          expectedLockVersion: item.lockVersion,
        },
      ),
    );
    assertApprovalSucceeded(approval);

    const sourceLinks = await db
      .select({
        sourceRecordId: ledgerSourceLinks.sourceRecordId,
        relationship: ledgerSourceLinks.relationship,
      })
      .from(ledgerSourceLinks)
      .where(eq(ledgerSourceLinks.journalHeaderId, approval.journalHeaderId));
    expect(sourceLinks).toEqual(
      expect.arrayContaining([
        { sourceRecordId: paymentChild.id, relationship: "origin" },
        { sourceRecordId: emailContainer.id, relationship: "supporting" },
      ]),
    );
  });

  it("keeps an exact-document duplicate blocking while semantic matching is in shadow mode", async () => {
    const { orgId, userId, bank, expense, department, location, vendor } =
      await setupApprovalTestOrganization("duplicate-config");
    const [receipt] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "shared-receipt.pdf",
        storagePath: `r2://test/${randomUUID()}/shared-receipt.pdf`,
        documentType: "receipt",
        fileType: "pdf",
        contentHash: randomUUID().replaceAll("-", "").padEnd(64, "0"),
      })
      .returning();
    const submit = (externalId: string) =>
      withOrgContext(orgId, userId, "owner", (tx) =>
        createTransactionCandidate(
          { db: tx, orgId, userId, role: "owner" },
          {
            transactionDate: "2026-07-24",
            transactionType: "pay_out",
            memo: "Receipt captured through two channels",
            partyId: vendor.id,
            sourceChannel: "upload",
            sourceProvider: "receipt_upload",
            externalId,
            documentIds: [receipt.id],
            lines: [
              {
                accountId: expense.id,
                debit: "42",
                departmentId: department.id,
                locationId: location.id,
              },
              {
                accountId: bank.id,
                credit: "42",
                departmentId: department.id,
                locationId: location.id,
              },
            ],
          },
        ),
      );
    const first = await submit(`email:${randomUUID()}`);
    await submit(`upload:${randomUUID()}`);

    const [historicalCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.organizationId, orgId));
    const historicalFindings = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, orgId),
          eq(reviewFindings.ruleKey, "possible_duplicate"),
          eq(reviewFindings.state, "open"),
          eq(reviewFindings.impact, "blocking"),
        ),
      );
    expect(historicalCase).toMatchObject({
      state: "open",
      disposition: "blocking",
      score: "100.00",
    });
    expect(historicalFindings.length).toBeGreaterThan(0);

    // Provided by the seeded catalog — this assertion now proves the seed ran.
    const [definition] = await db
      .select({ id: reviewRuleDefinitions.id })
      .from(reviewRuleDefinitions)
      .where(eq(reviewRuleDefinitions.key, "possible_duplicate"));
    expect(definition).toBeDefined();
    await db.insert(reviewRuleConfigs).values({
      organizationId: orgId,
      definitionId: definition!.id,
      enabled: true,
      impact: "blocking",
      config: { mode: "shadow" },
      updatedBy: userId,
    });

    const approval = await withOrgContext(orgId, userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: first.inboxItem.id,
          expectedRevision: first.inboxItem.candidateRevision,
          expectedLockVersion: first.inboxItem.lockVersion,
        },
      ),
    );
    expect(approval).toMatchObject({
      approvalOutcome: "blocked",
      reason: "possible_duplicate",
      caseId: historicalCase.id,
    });
    expect(
      await db
        .select({ id: journalHeaders.id })
        .from(journalHeaders)
        .where(eq(journalHeaders.organizationId, orgId)),
    ).toEqual([]);
    const [unchangedHistoricalCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, historicalCase.id));
    expect(unchangedHistoricalCase).toMatchObject({
      state: "open",
      disposition: "blocking",
    });
    const stillOpenHistoricalFindings = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, orgId),
          eq(reviewFindings.ruleKey, "possible_duplicate"),
          eq(reviewFindings.state, "open"),
          eq(reviewFindings.impact, "blocking"),
        ),
      );
    expect(stillOpenHistoricalFindings.length).toBe(historicalFindings.length);
  });

  it("persists a newly enforced duplicate case when approval is blocked after shadow mode", async () => {
    const fixture = await setupApprovalTestOrganization("shadow-enforce-approval");
    const [definition] = await db
      .select({ id: reviewRuleDefinitions.id })
      .from(reviewRuleDefinitions)
      .where(eq(reviewRuleDefinitions.key, "possible_duplicate"));
    expect(definition).toBeDefined();
    await db
      .insert(reviewRuleConfigs)
      .values({
        organizationId: fixture.orgId,
        definitionId: definition!.id,
        enabled: true,
        impact: "blocking",
        config: {
          mode: "shadow",
          blockingScore: 70,
          shadowScore: 50,
          matchWindowDays: 3,
        },
        updatedBy: fixture.userId,
      })
      .onConflictDoUpdate({
        target: [reviewRuleConfigs.organizationId, reviewRuleConfigs.definitionId],
        set: {
          enabled: true,
          impact: "blocking",
          config: {
            mode: "shadow",
            blockingScore: 70,
            shadowScore: 50,
            matchWindowDays: 3,
          },
          updatedBy: fixture.userId,
          updatedAt: new Date(),
        },
      });

    const emailDocument = await createWorkflowDocument(
      fixture.orgId,
      "shadow-email-evidence",
      "receipt",
    );
    const uploadedDocument = await createWorkflowDocument(
      fixture.orgId,
      "shadow-upload-evidence",
      "receipt",
    );
    const first = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `shadow-email:${randomUUID()}`,
      documentId: emailDocument.id,
      sourceChannel: "email",
      sourceProvider: "resend",
    });
    await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `shadow-upload:${randomUUID()}`,
      documentId: uploadedDocument.id,
      sourceChannel: "upload",
      sourceProvider: "receipt_upload",
    });

    const [shadowCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.organizationId, fixture.orgId));
    expect(shadowCase).toMatchObject({
      state: "open",
      matchClass: "duplicate",
      disposition: "shadow",
    });

    await db
      .update(reviewRuleConfigs)
      .set({
        config: {
          mode: "enforce",
          blockingScore: 70,
          shadowScore: 50,
          matchWindowDays: 3,
        },
        updatedBy: fixture.userId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(reviewRuleConfigs.organizationId, fixture.orgId),
          eq(reviewRuleConfigs.definitionId, definition!.id),
        ),
      );

    const blocked = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      approveInboxItem(
        {
          db: tx,
          orgId: fixture.orgId,
          userId: fixture.userId,
          role: "owner",
        },
        {
          inboxItemId: first.inboxItem.id,
          expectedRevision: first.inboxItem.candidateRevision,
          expectedLockVersion: first.inboxItem.lockVersion,
        },
      ),
    );
    expect(blocked).toMatchObject({
      approvalOutcome: "blocked",
      reason: "possible_duplicate",
      caseId: shadowCase.id,
    });

    const [persistedCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, shadowCase.id));
    expect(persistedCase).toMatchObject({
      state: "open",
      matchClass: "duplicate",
      disposition: "blocking",
    });
    const persistedFindings = await db
      .select()
      .from(reviewFindings)
      .where(
        and(
          eq(reviewFindings.organizationId, fixture.orgId),
          eq(reviewFindings.ruleKey, "possible_duplicate"),
          eq(reviewFindings.state, "open"),
          eq(reviewFindings.impact, "blocking"),
        ),
      );
    expect(persistedFindings.length).toBeGreaterThan(0);
    expect(
      await db
        .select({ id: journalHeaders.id })
        .from(journalHeaders)
        .where(eq(journalHeaders.organizationId, fixture.orgId)),
    ).toHaveLength(0);
  });

  it("consolidates two Inbox candidates without losing either source or document", async () => {
    const fixture = await setupApprovalTestOrganization("candidate-consolidation");
    const emailDocument = await createWorkflowDocument(fixture.orgId, "purchase-email", "other");
    const receiptDocument = await createWorkflowDocument(
      fixture.orgId,
      "purchase-receipt",
      "receipt",
    );
    const emailCandidate = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `email:${randomUUID()}`,
      documentId: emailDocument.id,
      sourceChannel: "email",
      sourceProvider: "resend",
    });
    const receiptCandidate = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `receipt:${randomUUID()}`,
      documentId: receiptDocument.id,
      sourceChannel: "upload",
      sourceProvider: "receipt_upload",
    });

    const [duplicateCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(
        and(
          eq(sourceMatchCandidates.organizationId, fixture.orgId),
          eq(sourceMatchCandidates.state, "open"),
        ),
      );
    expect(duplicateCase).toMatchObject({
      matchClass: "duplicate",
      disposition: "blocking",
      state: "open",
    });

    const resolution = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      resolveDuplicateCase(
        {
          db: tx,
          orgId: fixture.orgId,
          userId: fixture.userId,
          role: "owner",
        },
        {
          caseId: duplicateCase.id,
          action: "consolidate_candidates",
          canonicalId: emailCandidate.candidate.id,
          reason: "The receipt is supporting evidence for the emailed purchase.",
          expectedVersion: duplicateCase.lockVersion,
          idempotencyKey: randomUUID(),
        },
      ),
    );
    expect(resolution).toMatchObject({
      action: "consolidate_candidates",
      canonicalCandidateId: emailCandidate.candidate.id,
      supersededCandidateId: receiptCandidate.candidate.id,
      alreadyResolved: false,
    });

    const candidateRows = await db
      .select({
        id: transactionCandidates.id,
        status: transactionCandidates.status,
        supersededById: transactionCandidates.supersededById,
      })
      .from(transactionCandidates)
      .where(
        and(
          eq(transactionCandidates.organizationId, fixture.orgId),
          inArray(transactionCandidates.id, [
            emailCandidate.candidate.id,
            receiptCandidate.candidate.id,
          ]),
        ),
      );
    expect(candidateRows).toEqual(
      expect.arrayContaining([
        {
          id: emailCandidate.candidate.id,
          status: "current",
          supersededById: null,
        },
        {
          id: receiptCandidate.candidate.id,
          status: "superseded",
          supersededById: emailCandidate.candidate.id,
        },
      ]),
    );

    const canonicalSources = await db
      .select({
        sourceRecordId: transactionCandidateSources.sourceRecordId,
        relationship: transactionCandidateSources.relationship,
        isPrimary: transactionCandidateSources.isPrimary,
      })
      .from(transactionCandidateSources)
      .where(
        and(
          eq(transactionCandidateSources.organizationId, fixture.orgId),
          eq(transactionCandidateSources.candidateId, emailCandidate.candidate.id),
        ),
      );
    expect(canonicalSources).toEqual(
      expect.arrayContaining([
        {
          sourceRecordId: emailCandidate.candidate.sourceRecordId,
          relationship: "origin",
          isPrimary: true,
        },
        {
          sourceRecordId: receiptCandidate.candidate.sourceRecordId,
          relationship: "supporting",
          isPrimary: false,
        },
      ]),
    );

    const preservedSourceDocuments = await db
      .select({
        sourceRecordId: sourceRecordDocuments.sourceRecordId,
        documentId: sourceRecordDocuments.documentId,
      })
      .from(sourceRecordDocuments)
      .where(
        and(
          eq(sourceRecordDocuments.organizationId, fixture.orgId),
          inArray(sourceRecordDocuments.sourceRecordId, [
            emailCandidate.candidate.sourceRecordId!,
            receiptCandidate.candidate.sourceRecordId!,
          ]),
        ),
      );
    expect(preservedSourceDocuments).toEqual(
      expect.arrayContaining([
        {
          sourceRecordId: emailCandidate.candidate.sourceRecordId,
          documentId: emailDocument.id,
        },
        {
          sourceRecordId: receiptCandidate.candidate.sourceRecordId,
          documentId: receiptDocument.id,
        },
      ]),
    );

    const canonicalDocuments = await db
      .select({ documentId: documentAttachments.documentId })
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.organizationId, fixture.orgId),
          eq(documentAttachments.linkableType, "transaction_candidate"),
          eq(documentAttachments.linkableId, emailCandidate.candidate.id),
        ),
      );
    expect(canonicalDocuments.map(({ documentId }) => documentId).sort()).toEqual(
      [emailDocument.id, receiptDocument.id].sort(),
    );
    const duplicateDocuments = await db
      .select({ documentId: documentAttachments.documentId })
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.organizationId, fixture.orgId),
          eq(documentAttachments.linkableType, "transaction_candidate"),
          eq(documentAttachments.linkableId, receiptCandidate.candidate.id),
        ),
      );
    expect(duplicateDocuments).toEqual([{ documentId: receiptDocument.id }]);

    const [canonicalInbox, supersededInbox] = await Promise.all([
      db
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.id, emailCandidate.inboxItem.id))
        .then((rows) => rows[0]),
      db
        .select()
        .from(inboxItems)
        .where(eq(inboxItems.id, receiptCandidate.inboxItem.id))
        .then((rows) => rows[0]),
    ]);
    expect(canonicalInbox).toMatchObject({
      state: "ready_for_review",
      resolvedAt: null,
    });
    expect(supersededInbox).toMatchObject({
      state: "dismissed",
      resolvedBy: fixture.userId,
    });

    const [resolvedCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, duplicateCase.id));
    expect(resolvedCase).toMatchObject({
      state: "resolved",
      resolutionAction: "consolidate_candidates",
      canonicalCandidateId: emailCandidate.candidate.id,
      resolvedBy: fixture.userId,
    });
    expect(
      await db
        .select({ id: journalHeaders.id })
        .from(journalHeaders)
        .where(eq(journalHeaders.organizationId, fixture.orgId)),
    ).toHaveLength(0);
  });

  it("attaches an Inbox candidate to a posted transaction without creating a second journal", async () => {
    const fixture = await setupApprovalTestOrganization("candidate-attachment");
    const emailDocument = await createWorkflowDocument(
      fixture.orgId,
      "posted-purchase-email",
      "receipt",
    );
    const receiptDocument = await createWorkflowDocument(
      fixture.orgId,
      "later-receipt-upload",
      "receipt",
    );
    const emailCandidate = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `email:${randomUUID()}`,
      documentId: emailDocument.id,
      sourceChannel: "email",
      sourceProvider: "resend",
    });
    const posted = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      approveInboxItem(
        {
          db: tx,
          orgId: fixture.orgId,
          userId: fixture.userId,
          role: "owner",
        },
        {
          inboxItemId: emailCandidate.inboxItem.id,
          expectedRevision: emailCandidate.inboxItem.candidateRevision,
          expectedLockVersion: emailCandidate.inboxItem.lockVersion,
        },
      ),
    );
    assertApprovalSucceeded(posted);
    const receiptCandidate = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `receipt:${randomUUID()}`,
      documentId: receiptDocument.id,
      sourceChannel: "upload",
      sourceProvider: "receipt_upload",
    });

    const [duplicateCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(
        and(
          eq(sourceMatchCandidates.organizationId, fixture.orgId),
          eq(sourceMatchCandidates.state, "open"),
        ),
      );
    expect(duplicateCase).toMatchObject({
      matchClass: "duplicate",
      disposition: "blocking",
      state: "open",
    });

    const resolution = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      resolveDuplicateCase(
        {
          db: tx,
          orgId: fixture.orgId,
          userId: fixture.userId,
          role: "owner",
        },
        {
          caseId: duplicateCase.id,
          action: "attach_to_posted",
          canonicalId: posted.journalHeaderId,
          reason: "The uploaded receipt supports the already-posted email transaction.",
          expectedVersion: duplicateCase.lockVersion,
          idempotencyKey: randomUUID(),
        },
      ),
    );
    expect(resolution).toMatchObject({
      action: "attach_to_posted",
      canonicalJournalHeaderId: posted.journalHeaderId,
      attachedCandidateId: receiptCandidate.candidate.id,
      alreadyResolved: false,
    });

    const journalRows = await db
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(eq(journalHeaders.organizationId, fixture.orgId));
    expect(journalRows).toEqual([{ id: posted.journalHeaderId }]);
    const journalLineRows = await db
      .select({ id: journalLines.id })
      .from(journalLines)
      .where(eq(journalLines.journalHeaderId, posted.journalHeaderId));
    expect(journalLineRows).toHaveLength(2);

    const [attachedCandidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, receiptCandidate.candidate.id));
    expect(attachedCandidate).toMatchObject({
      status: "attached",
      postedJournalHeaderId: posted.journalHeaderId,
    });
    const [dismissedInbox] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, receiptCandidate.inboxItem.id));
    expect(dismissedInbox).toMatchObject({
      state: "dismissed",
      resolvedBy: fixture.userId,
    });

    const journalSources = await db
      .select({
        sourceRecordId: ledgerSourceLinks.sourceRecordId,
        relationship: ledgerSourceLinks.relationship,
      })
      .from(ledgerSourceLinks)
      .where(
        and(
          eq(ledgerSourceLinks.organizationId, fixture.orgId),
          eq(ledgerSourceLinks.journalHeaderId, posted.journalHeaderId),
        ),
      );
    expect(journalSources).toEqual(
      expect.arrayContaining([
        {
          sourceRecordId: emailCandidate.candidate.sourceRecordId,
          relationship: "origin",
        },
        {
          sourceRecordId: receiptCandidate.candidate.sourceRecordId,
          relationship: "supporting",
        },
      ]),
    );

    const preservedSourceDocuments = await db
      .select({
        sourceRecordId: sourceRecordDocuments.sourceRecordId,
        documentId: sourceRecordDocuments.documentId,
      })
      .from(sourceRecordDocuments)
      .where(
        and(
          eq(sourceRecordDocuments.organizationId, fixture.orgId),
          inArray(sourceRecordDocuments.sourceRecordId, [
            emailCandidate.candidate.sourceRecordId!,
            receiptCandidate.candidate.sourceRecordId!,
          ]),
        ),
      );
    expect(preservedSourceDocuments).toEqual(
      expect.arrayContaining([
        {
          sourceRecordId: emailCandidate.candidate.sourceRecordId,
          documentId: emailDocument.id,
        },
        {
          sourceRecordId: receiptCandidate.candidate.sourceRecordId,
          documentId: receiptDocument.id,
        },
      ]),
    );

    const journalDocuments = await db
      .select({ documentId: documentAttachments.documentId })
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.organizationId, fixture.orgId),
          eq(documentAttachments.linkableType, "journal_header"),
          eq(documentAttachments.linkableId, posted.journalHeaderId),
        ),
      );
    expect(journalDocuments.map(({ documentId }) => documentId).sort()).toEqual(
      [emailDocument.id, receiptDocument.id].sort(),
    );

    const candidateEvidence = await db
      .select({ documentId: documentAttachments.documentId })
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.organizationId, fixture.orgId),
          eq(documentAttachments.linkableType, "transaction_candidate"),
          eq(documentAttachments.linkableId, receiptCandidate.candidate.id),
        ),
      );
    expect(candidateEvidence).toEqual([{ documentId: receiptDocument.id }]);

    const [resolvedCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, duplicateCase.id));
    expect(resolvedCase).toMatchObject({
      state: "resolved",
      resolutionAction: "attach_to_posted",
      canonicalJournalHeaderId: posted.journalHeaderId,
      resolvedBy: fixture.userId,
    });
  });

  it("serializes approval racing candidate consolidation under semantic shadow mode", async () => {
    const fixture = await setupApprovalTestOrganization("consolidate-approval-race");
    await configureSemanticDuplicateShadowMode(fixture);
    const emailDocument = await createWorkflowDocument(
      fixture.orgId,
      "consolidate-race-email",
      "receipt",
    );
    const receiptDocument = await createWorkflowDocument(
      fixture.orgId,
      "consolidate-race-receipt",
      "receipt",
    );
    const canonical = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `consolidate-race-email:${randomUUID()}`,
      documentId: emailDocument.id,
      sourceChannel: "email",
      sourceProvider: "resend",
    });
    const target = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `consolidate-race-upload:${randomUUID()}`,
      documentId: receiptDocument.id,
      sourceChannel: "upload",
      sourceProvider: "receipt_upload",
    });
    const duplicateCase = await loadOnlyOpenSemanticDuplicateCase(fixture.orgId);

    const [approvalRace, resolutionRace] = await Promise.allSettled([
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        approveInboxItem(
          {
            db: tx,
            orgId: fixture.orgId,
            userId: fixture.userId,
            role: "owner",
          },
          {
            inboxItemId: target.inboxItem.id,
            expectedRevision: target.inboxItem.candidateRevision,
            expectedLockVersion: target.inboxItem.lockVersion,
          },
        ),
      ),
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        resolveDuplicateCase(
          {
            db: tx,
            orgId: fixture.orgId,
            userId: fixture.userId,
            role: "owner",
          },
          {
            caseId: duplicateCase.id,
            action: "consolidate_candidates",
            canonicalId: canonical.candidate.id,
            reason: "The uploaded receipt is evidence for the emailed purchase.",
            expectedVersion: duplicateCase.lockVersion,
            idempotencyKey: randomUUID(),
          },
        ),
      ),
    ]);
    expect(
      [approvalRace, resolutionRace].filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const approvalWon = approvalRace.status === "fulfilled";
    let approvedJournalHeaderId: string | null = null;
    if (approvalWon) {
      assertApprovalSucceeded(approvalRace.value);
      approvedJournalHeaderId = approvalRace.value.journalHeaderId;
    } else {
      if (resolutionRace.status !== "fulfilled") {
        throw new Error("Neither approval nor consolidation completed.");
      }
      expect(resolutionRace.value).toMatchObject({
        action: "consolidate_candidates",
        canonicalCandidateId: canonical.candidate.id,
        supersededCandidateId: target.candidate.id,
      });
    }

    const [[canonicalCandidate], [targetCandidate], [canonicalInbox], [targetInbox], [caseAfter]] =
      await Promise.all([
        db
          .select()
          .from(transactionCandidates)
          .where(eq(transactionCandidates.id, canonical.candidate.id)),
        db
          .select()
          .from(transactionCandidates)
          .where(eq(transactionCandidates.id, target.candidate.id)),
        db.select().from(inboxItems).where(eq(inboxItems.id, canonical.inboxItem.id)),
        db.select().from(inboxItems).where(eq(inboxItems.id, target.inboxItem.id)),
        db
          .select()
          .from(sourceMatchCandidates)
          .where(eq(sourceMatchCandidates.id, duplicateCase.id)),
      ]);
    const journals = await db
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(eq(journalHeaders.organizationId, fixture.orgId));
    expect(canonicalCandidate).toMatchObject({
      status: "current",
      postedJournalHeaderId: null,
      supersededById: null,
    });
    expect(canonicalInbox).toMatchObject({ state: "ready_for_review", resolvedAt: null });

    if (approvalWon) {
      if (!approvedJournalHeaderId) throw new Error("Approved journal ID is missing.");
      expect(targetCandidate).toMatchObject({
        status: "posted",
        postedJournalHeaderId: approvedJournalHeaderId,
        supersededById: null,
      });
      expect(targetInbox).toMatchObject({
        state: "approved",
        resolvedBy: fixture.userId,
      });
      expect(caseAfter).toMatchObject({ state: "open", resolutionAction: null });
      expect(journals).toEqual([{ id: approvedJournalHeaderId }]);
    } else {
      expect(targetCandidate).toMatchObject({
        status: "superseded",
        postedJournalHeaderId: null,
        supersededById: canonical.candidate.id,
      });
      expect(targetInbox).toMatchObject({
        state: "dismissed",
        resolvedBy: fixture.userId,
      });
      expect(caseAfter).toMatchObject({
        state: "resolved",
        resolutionAction: "consolidate_candidates",
        canonicalCandidateId: canonical.candidate.id,
      });
      expect(journals).toHaveLength(0);
    }
  });

  it("serializes approval racing attachment to a posted journal under semantic shadow mode", async () => {
    const fixture = await setupApprovalTestOrganization("attach-approval-race");
    await configureSemanticDuplicateShadowMode(fixture);
    const emailDocument = await createWorkflowDocument(
      fixture.orgId,
      "attach-race-email",
      "receipt",
    );
    const receiptDocument = await createWorkflowDocument(
      fixture.orgId,
      "attach-race-receipt",
      "receipt",
    );
    const postedCandidate = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `attach-race-email:${randomUUID()}`,
      documentId: emailDocument.id,
      sourceChannel: "email",
      sourceProvider: "resend",
    });
    const posted = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      approveInboxItem(
        {
          db: tx,
          orgId: fixture.orgId,
          userId: fixture.userId,
          role: "owner",
        },
        {
          inboxItemId: postedCandidate.inboxItem.id,
          expectedRevision: postedCandidate.inboxItem.candidateRevision,
          expectedLockVersion: postedCandidate.inboxItem.lockVersion,
        },
      ),
    );
    assertApprovalSucceeded(posted);
    const target = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `attach-race-upload:${randomUUID()}`,
      documentId: receiptDocument.id,
      sourceChannel: "upload",
      sourceProvider: "receipt_upload",
    });
    const duplicateCase = await loadOnlyOpenSemanticDuplicateCase(fixture.orgId);

    const [approvalRace, resolutionRace] = await Promise.allSettled([
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        approveInboxItem(
          {
            db: tx,
            orgId: fixture.orgId,
            userId: fixture.userId,
            role: "owner",
          },
          {
            inboxItemId: target.inboxItem.id,
            expectedRevision: target.inboxItem.candidateRevision,
            expectedLockVersion: target.inboxItem.lockVersion,
          },
        ),
      ),
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        resolveDuplicateCase(
          {
            db: tx,
            orgId: fixture.orgId,
            userId: fixture.userId,
            role: "owner",
          },
          {
            caseId: duplicateCase.id,
            action: "attach_to_posted",
            canonicalId: posted.journalHeaderId,
            reason: "The uploaded receipt supports the posted email transaction.",
            expectedVersion: duplicateCase.lockVersion,
            idempotencyKey: randomUUID(),
          },
        ),
      ),
    ]);
    expect(
      [approvalRace, resolutionRace].filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const approvalWon = approvalRace.status === "fulfilled";
    let approvedJournalHeaderId: string | null = null;
    if (approvalWon) {
      assertApprovalSucceeded(approvalRace.value);
      approvedJournalHeaderId = approvalRace.value.journalHeaderId;
    } else {
      if (resolutionRace.status !== "fulfilled") {
        throw new Error("Neither approval nor evidence attachment completed.");
      }
      expect(resolutionRace.value).toMatchObject({
        action: "attach_to_posted",
        canonicalJournalHeaderId: posted.journalHeaderId,
        attachedCandidateId: target.candidate.id,
      });
    }

    const [[targetCandidate], [targetInbox], [caseAfter], targetSourceLinks] = await Promise.all([
      db
        .select()
        .from(transactionCandidates)
        .where(eq(transactionCandidates.id, target.candidate.id)),
      db.select().from(inboxItems).where(eq(inboxItems.id, target.inboxItem.id)),
      db.select().from(sourceMatchCandidates).where(eq(sourceMatchCandidates.id, duplicateCase.id)),
      db
        .select({
          journalHeaderId: ledgerSourceLinks.journalHeaderId,
          relationship: ledgerSourceLinks.relationship,
        })
        .from(ledgerSourceLinks)
        .where(
          and(
            eq(ledgerSourceLinks.organizationId, fixture.orgId),
            eq(ledgerSourceLinks.sourceRecordId, target.candidate.sourceRecordId!),
          ),
        ),
    ]);
    const journals = await db
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(eq(journalHeaders.organizationId, fixture.orgId));

    if (approvalWon) {
      if (!approvedJournalHeaderId) throw new Error("Approved journal ID is missing.");
      expect(targetCandidate).toMatchObject({
        status: "posted",
        postedJournalHeaderId: approvedJournalHeaderId,
      });
      expect(targetInbox).toMatchObject({
        state: "approved",
        resolvedBy: fixture.userId,
      });
      expect(caseAfter).toMatchObject({ state: "open", resolutionAction: null });
      expect(journals.map(({ id }) => id).sort()).toEqual(
        [posted.journalHeaderId, approvedJournalHeaderId].sort(),
      );
      expect(targetSourceLinks).toEqual([
        {
          journalHeaderId: approvedJournalHeaderId,
          relationship: "origin",
        },
      ]);
    } else {
      expect(targetCandidate).toMatchObject({
        status: "attached",
        postedJournalHeaderId: posted.journalHeaderId,
      });
      expect(targetInbox).toMatchObject({
        state: "dismissed",
        resolvedBy: fixture.userId,
      });
      expect(caseAfter).toMatchObject({
        state: "resolved",
        resolutionAction: "attach_to_posted",
        canonicalJournalHeaderId: posted.journalHeaderId,
      });
      expect(journals).toEqual([{ id: posted.journalHeaderId }]);
      expect(targetSourceLinks).toEqual([
        {
          journalHeaderId: posted.journalHeaderId,
          relationship: "supporting",
        },
      ]);
    }
  });

  it("serializes approval racing source rejection under semantic shadow mode", async () => {
    const fixture = await setupApprovalTestOrganization("reject-approval-race");
    await configureSemanticDuplicateShadowMode(fixture);
    const emailDocument = await createWorkflowDocument(
      fixture.orgId,
      "reject-race-email",
      "receipt",
    );
    const receiptDocument = await createWorkflowDocument(
      fixture.orgId,
      "reject-race-receipt",
      "receipt",
    );
    const retained = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `reject-race-email:${randomUUID()}`,
      documentId: emailDocument.id,
      sourceChannel: "email",
      sourceProvider: "resend",
    });
    const target = await submitDuplicateWorkflowCandidate(fixture, {
      externalId: `reject-race-upload:${randomUUID()}`,
      documentId: receiptDocument.id,
      sourceChannel: "upload",
      sourceProvider: "receipt_upload",
    });
    const duplicateCase = await loadOnlyOpenSemanticDuplicateCase(fixture.orgId);

    const [approvalRace, resolutionRace] = await Promise.allSettled([
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        approveInboxItem(
          {
            db: tx,
            orgId: fixture.orgId,
            userId: fixture.userId,
            role: "owner",
          },
          {
            inboxItemId: target.inboxItem.id,
            expectedRevision: target.inboxItem.candidateRevision,
            expectedLockVersion: target.inboxItem.lockVersion,
          },
        ),
      ),
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        resolveDuplicateCase(
          {
            db: tx,
            orgId: fixture.orgId,
            userId: fixture.userId,
            role: "owner",
          },
          {
            caseId: duplicateCase.id,
            action: "reject_source",
            canonicalId: target.candidate.id,
            reason: "The uploaded item is not valid accounting evidence.",
            expectedVersion: duplicateCase.lockVersion,
            idempotencyKey: randomUUID(),
          },
        ),
      ),
    ]);
    expect(
      [approvalRace, resolutionRace].filter(({ status }) => status === "fulfilled"),
    ).toHaveLength(1);
    const approvalWon = approvalRace.status === "fulfilled";
    let approvedJournalHeaderId: string | null = null;
    if (approvalWon) {
      assertApprovalSucceeded(approvalRace.value);
      approvedJournalHeaderId = approvalRace.value.journalHeaderId;
    } else {
      if (resolutionRace.status !== "fulfilled") {
        throw new Error("Neither approval nor source rejection completed.");
      }
      expect(resolutionRace.value).toMatchObject({
        action: "reject_source",
        rejectedSourceRecordId: target.candidate.sourceRecordId,
      });
    }

    const [
      [retainedCandidate],
      [retainedInbox],
      [targetCandidate],
      [targetInbox],
      [targetSource],
      [caseAfter],
      targetSourceLinks,
    ] = await Promise.all([
      db
        .select()
        .from(transactionCandidates)
        .where(eq(transactionCandidates.id, retained.candidate.id)),
      db.select().from(inboxItems).where(eq(inboxItems.id, retained.inboxItem.id)),
      db
        .select()
        .from(transactionCandidates)
        .where(eq(transactionCandidates.id, target.candidate.id)),
      db.select().from(inboxItems).where(eq(inboxItems.id, target.inboxItem.id)),
      db.select().from(sourceRecords).where(eq(sourceRecords.id, target.candidate.sourceRecordId!)),
      db.select().from(sourceMatchCandidates).where(eq(sourceMatchCandidates.id, duplicateCase.id)),
      db
        .select({
          journalHeaderId: ledgerSourceLinks.journalHeaderId,
          relationship: ledgerSourceLinks.relationship,
        })
        .from(ledgerSourceLinks)
        .where(
          and(
            eq(ledgerSourceLinks.organizationId, fixture.orgId),
            eq(ledgerSourceLinks.sourceRecordId, target.candidate.sourceRecordId!),
          ),
        ),
    ]);
    const journals = await db
      .select({ id: journalHeaders.id })
      .from(journalHeaders)
      .where(eq(journalHeaders.organizationId, fixture.orgId));
    expect(retainedCandidate).toMatchObject({
      status: "current",
      postedJournalHeaderId: null,
    });
    expect(retainedInbox).toMatchObject({ state: "ready_for_review", resolvedAt: null });

    if (approvalWon) {
      if (!approvedJournalHeaderId) throw new Error("Approved journal ID is missing.");
      expect(targetCandidate).toMatchObject({
        status: "posted",
        postedJournalHeaderId: approvedJournalHeaderId,
      });
      expect(targetInbox).toMatchObject({
        state: "approved",
        resolvedBy: fixture.userId,
      });
      expect(targetSource.recordState).toBe("active");
      expect(caseAfter).toMatchObject({ state: "open", resolutionAction: null });
      expect(journals).toEqual([{ id: approvedJournalHeaderId }]);
      expect(targetSourceLinks).toEqual([
        {
          journalHeaderId: approvedJournalHeaderId,
          relationship: "origin",
        },
      ]);
    } else {
      expect(targetCandidate).toMatchObject({
        status: "rejected",
        postedJournalHeaderId: null,
      });
      expect(targetInbox).toMatchObject({
        state: "rejected",
        resolvedBy: fixture.userId,
      });
      expect(targetSource.recordState).toBe("rejected");
      expect(caseAfter).toMatchObject({
        state: "resolved",
        resolutionAction: "reject_source",
      });
      expect(journals).toHaveLength(0);
      expect(targetSourceLinks).toHaveLength(0);
    }
    // Deliberate concurrency test: it races an approval against a source
    // rejection. ~1s in isolation, but it exceeds the default 5s timeout
    // under full-suite database load, and a red pre-push hook trains people
    // to bypass it.
  }, 30000);
});

describe("inbox approval source-document stamping", () => {
  // The bill/invoice void paths and the AP/AR aging reports find journals
  // EXCLUSIVELY through (source_document_type, source_document_id). Before
  // the stamp, a bill approved through the Inbox produced a journal those
  // queries could never see: the bill flipped to voided while its journal
  // stayed posted forever, and the bill never appeared in AP aging at all.
  it("stamps a bill candidate's journal with the bill source pair", async () => {
    const fixture = await setupApprovalTestOrganization("stamp-bill");
    const { orgId, userId } = fixture;

    const [bill] = await db
      .insert(bills)
      .values({
        organizationId: orgId,
        vendorId: fixture.vendor.id,
        billNumber: `BILL-${randomUUID().slice(0, 8)}`,
        billDate: "2026-07-20",
        dueDate: "2026-08-20",
        amount: "84.25",
        balanceDue: "84.25",
        status: "in_review",
      })
      .returning();

    const receipt = await createWorkflowDocument(orgId, "stamp-bill", "receipt");
    const submitted = await withOrgContext(orgId, userId, "owner", (tx) =>
      createTransactionCandidate(
        { db: tx, orgId, userId, role: "owner" },
        {
          candidateType: "bill",
          transactionDate: "2026-07-24",
          transactionType: "pay_out",
          memo: "Bill accrual via inbox",
          referenceNumber: "STAMP-1",
          partyId: fixture.vendor.id,
          originalCurrency: "USD",
          sourceChannel: "upload",
          sourceProvider: "internal",
          externalId: bill.id,
          documentIds: [receipt.id],
          lines: [
            {
              accountId: fixture.expense.id,
              debit: "84.25",
              departmentId: fixture.department.id,
              locationId: fixture.location.id,
            },
            {
              accountId: fixture.bank.id,
              credit: "84.25",
              departmentId: fixture.department.id,
              locationId: fixture.location.id,
            },
          ],
        },
      ),
    );

    await withOrgContext(orgId, userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: submitted.inboxItem.id,
          expectedRevision: submitted.inboxItem.candidateRevision,
          expectedLockVersion: submitted.inboxItem.lockVersion,
        },
      ),
    );

    const [header] = await db
      .select({
        id: journalHeaders.id,
        sourceDocumentId: journalHeaders.sourceDocumentId,
        sourceDocumentType: journalHeaders.sourceDocumentType,
      })
      .from(journalHeaders)
      .where(eq(journalHeaders.organizationId, orgId));
    expect(header.sourceDocumentType).toBe("bill");
    expect(header.sourceDocumentId).toBe(bill.id);

    // The link the void path walks in the OTHER direction must agree.
    const [linked] = await db
      .select({ journalHeaderId: bills.journalHeaderId, status: bills.status })
      .from(bills)
      .where(eq(bills.id, bill.id));
    expect(linked.journalHeaderId).toBe(header.id);
    expect(linked.status).toBe("awaiting_payment");
  }, 30000);

  it("leaves plain transaction candidates unstamped", async () => {
    const fixture = await setupApprovalTestOrganization("stamp-plain");
    const { orgId, userId } = fixture;

    const receipt = await createWorkflowDocument(orgId, "stamp-plain", "receipt");
    const submitted = await withOrgContext(orgId, userId, "owner", (tx) =>
      createTransactionCandidate(
        { db: tx, orgId, userId, role: "owner" },
        {
          transactionDate: "2026-07-24",
          transactionType: "pay_out",
          memo: "Ordinary spend",
          referenceNumber: "STAMP-2",
          partyId: fixture.vendor.id,
          originalCurrency: "USD",
          sourceChannel: "upload",
          sourceProvider: "internal",
          externalId: `upload:${randomUUID()}`,
          documentIds: [receipt.id],
          lines: [
            {
              accountId: fixture.expense.id,
              debit: "10.00",
              departmentId: fixture.department.id,
              locationId: fixture.location.id,
            },
            {
              accountId: fixture.bank.id,
              credit: "10.00",
              departmentId: fixture.department.id,
              locationId: fixture.location.id,
            },
          ],
        },
      ),
    );

    await withOrgContext(orgId, userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: submitted.inboxItem.id,
          expectedRevision: submitted.inboxItem.candidateRevision,
          expectedLockVersion: submitted.inboxItem.lockVersion,
        },
      ),
    );

    const [header] = await db
      .select({ sourceDocumentId: journalHeaders.sourceDocumentId })
      .from(journalHeaders)
      .where(eq(journalHeaders.organizationId, orgId));
    expect(header.sourceDocumentId).toBeNull();
  }, 30000);
});
