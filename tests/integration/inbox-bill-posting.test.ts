/**
 * Inbox v2 step 3 — shared posting cores.
 *
 * Emailed and uploaded vendor bills used to post their accrual journal from
 * the Inbox without ever becoming a bill: nothing in Bills, nothing in A/P
 * aging, nothing for the bill void path to find. Approval now writes them
 * through createBillCore, the same code the Bills editor uses, and refuses a
 * sub-cent amount instead of letting the 2-decimal bills table round it.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { activityLogs } from "@/db/schema/activity-logs";
import { member, organization, user } from "@/db/schema/auth";
import { billLineItems, bills } from "@/db/schema/bills";
import { dimensions } from "@/db/schema/dimensions";
import { documentAttachments, documents } from "@/db/schema/documents";
import {
  inboxItems,
  ledgerSourceLinks,
  organizationAccountingSettings,
  reviewDecisions,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidateSources,
  transactionCandidates,
} from "@/db/schema/inbox";
import { invoiceLineItems } from "@/db/schema/invoices";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import { listOrganizationBills } from "@/lib/bill-list";
import {
  correctInboxCandidate,
  type CandidateCorrectionLineInput,
  type CorrectInboxCandidateInput,
} from "@/lib/inbox/candidate-correction";
import { postBillAccrualJournal } from "@/lib/bill-journal";
import {
  approveInboxItem,
  BILL_ALREADY_ACCRUED_MESSAGE,
  BILL_DELETED_MESSAGE,
  BILL_VOIDED_MESSAGE,
  rejectInboxItem,
  type ApproveInboxResult,
} from "@/lib/inbox/service";
import { submitBillForReviewCore } from "@/lib/posting/bill-submission";
import { createInvoiceCore } from "@/lib/posting/invoice-core";
import { BILL_ACCRUAL_SHAPE_MESSAGE, BILL_SUB_CENT_MESSAGE } from "@/lib/posting/posting-lines";
import { postTransactionCore } from "@/lib/posting/transaction-core";

const BILL_DATE = "2026-07-20";

async function setupOrganization(
  prefix: string,
  settings: { requireDifferentApprover?: boolean } = {},
) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Bill Posting Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Bill Posting Organization",
    slug: `${prefix}-${suffix}`,
  });
  await db.insert(member).values({
    id: `${prefix}-member-${suffix}`,
    userId,
    organizationId: orgId,
    role: "owner",
  });
  const [bank, expense, ap, revenue] = await db
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
      {
        organizationId: orgId,
        accountNumber: "21000",
        name: "Accounts Payable",
        accountType: "liability",
        subtype: "accounts_payable",
      },
      {
        organizationId: orgId,
        accountNumber: "40000",
        name: "Services Revenue",
        accountType: "revenue",
        subtype: "service_revenue",
      },
    ])
    .returning();
  const [department, location] = await db
    .insert(dimensions)
    .values([
      { organizationId: orgId, dimensionType: "department", name: "Operations" },
      { organizationId: orgId, dimensionType: "location", name: "Main Office" },
    ])
    .returning();
  const [vendor, customer] = await db
    .insert(parties)
    .values([
      { organizationId: orgId, name: "Paper Supply Co", partyType: "vendor" },
      { organizationId: orgId, name: "Acme Customer", partyType: "customer" },
    ])
    .returning();
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: settings.requireDifferentApprover ?? false,
    // The receipt rule is not what these tests are about.
    missingReceiptThreshold: "100000",
  });
  return { orgId, userId, bank, expense, ap, revenue, department, location, vendor, customer };
}

type Fixture = Awaited<ReturnType<typeof setupOrganization>>;

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

/**
 * What the inbound-email worker (or document intake) leaves behind: an
 * accounting child classified bill_accrual that carries the vendor's PDF,
 * under an email container for email, waiting in needs_information.
 */
async function receiveVendorBill(
  fixture: Fixture,
  candidateType: "email_transaction" | "document_transaction" = "email_transaction",
) {
  const token = randomUUID();
  const [container] =
    candidateType === "email_transaction"
      ? await db
          .insert(sourceRecords)
          .values({
            organizationId: fixture.orgId,
            recordType: "email",
            externalId: `email:${token}`,
            description: "Invoice from Paper Supply Co",
            economicEventClass: "other",
            direction: "unknown",
          })
          .returning()
      : [];
  const [origin] = await db
    .insert(sourceRecords)
    .values({
      organizationId: fixture.orgId,
      parentSourceRecordId: container?.id ?? null,
      recordType: candidateType === "email_transaction" ? "email_attachment" : "document_upload",
      externalId: `attachment:${token}`,
      transactionDate: BILL_DATE,
      description: "Office supplies invoice",
      economicEventClass: "bill_accrual",
      direction: "outflow",
    })
    .returning();
  const [pdf] = await db
    .insert(documents)
    .values({
      organizationId: fixture.orgId,
      originalFilename: "invoice-4242.pdf",
      storagePath: `r2://test/${token}/invoice-4242.pdf`,
      documentType: "bill",
      fileType: "pdf",
      contentHash: token.replaceAll("-", "").padEnd(64, "0"),
    })
    .returning();
  await db.insert(sourceRecordDocuments).values({
    organizationId: fixture.orgId,
    sourceRecordId: origin.id,
    documentId: pdf.id,
    relationship: "primary_document",
  });
  const [candidate] = await db
    .insert(transactionCandidates)
    .values({
      organizationId: fixture.orgId,
      sourceRecordId: origin.id,
      candidateType,
      transactionDate: BILL_DATE,
      transactionType: "journal",
      memo: "Office supplies invoice",
      originalCurrency: "USD",
      functionalCurrency: "USD",
      exchangeRate: "1",
      submittedBy: fixture.userId,
    })
    .returning();
  await db.insert(transactionCandidateSources).values([
    {
      organizationId: fixture.orgId,
      candidateId: candidate.id,
      sourceRecordId: origin.id,
      relationship: "origin",
      isPrimary: true,
    },
    ...(container
      ? [
          {
            organizationId: fixture.orgId,
            candidateId: candidate.id,
            sourceRecordId: container.id,
            relationship: "supporting",
            isPrimary: false,
          },
        ]
      : []),
  ]);
  const [item] = await db
    .insert(inboxItems)
    .values({
      organizationId: fixture.orgId,
      candidateId: candidate.id,
      sourceRecordId: origin.id,
      itemType: "classify_source_record",
      state: "needs_information",
      title: "Office supplies invoice",
      submittedBy: fixture.userId,
    })
    .returning();
  return { container: container ?? null, origin, pdf, candidate, item };
}

type Received = Awaited<ReturnType<typeof receiveVendorBill>>;

/** The reviewer's categorization, through the real correction path. */
async function categorize(
  fixture: Fixture,
  received: Received,
  lines: CandidateCorrectionLineInput[],
  overrides: Partial<CorrectInboxCandidateInput> = {},
) {
  return withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    correctInboxCandidate(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        inboxItemId: received.item.id,
        expectedRevision: received.item.candidateRevision,
        expectedLockVersion: received.item.lockVersion,
        transactionDate: BILL_DATE,
        transactionType: "journal",
        economicEventClass: "bill_accrual",
        memo: "Office supplies invoice",
        referenceNumber: "INV-4242",
        partyId: fixture.vendor.id,
        originalCurrency: "USD",
        exchangeRate: "1",
        lines,
        ...overrides,
      },
    ),
  );
}

function accrualLines(fixture: Fixture, amount: string): CandidateCorrectionLineInput[] {
  return [
    {
      accountId: fixture.expense.id,
      debit: amount,
      lineDescription: "Printer paper",
      departmentId: fixture.department.id,
      locationId: fixture.location.id,
    },
    { accountId: fixture.ap.id, credit: amount, lineDescription: "Owed to Paper Supply Co" },
  ];
}

async function approve(
  fixture: Fixture,
  inboxItemId: string,
  role = "owner",
): Promise<ApproveInboxResult> {
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId));
  return withOrgContext(fixture.orgId, fixture.userId, role, (tx) =>
    approveInboxItem(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role },
      {
        inboxItemId,
        expectedRevision: item.candidateRevision,
        expectedLockVersion: item.lockVersion,
      },
    ),
  );
}

function assertApproved(
  result: ApproveInboxResult,
): asserts result is Extract<ApproveInboxResult, { approvalOutcome: "approved" }> {
  if (result.approvalOutcome !== "approved") throw new Error(result.message);
}

async function orgBills(orgId: string) {
  return db.select().from(bills).where(eq(bills.organizationId, orgId));
}

async function orgJournals(orgId: string) {
  return db.select().from(journalHeaders).where(eq(journalHeaders.organizationId, orgId));
}

describe("Inbox approval of vendor bills", () => {
  it("creates a bill from an emailed bill_accrual paper, linked to its accrual journal", async () => {
    const fixture = await setupOrganization("bill-email");
    const received = await receiveVendorBill(fixture);
    const corrected = await categorize(fixture, received, accrualLines(fixture, "84.25"));
    expect(corrected.findingCount).toBe(0);

    const approval = await approve(fixture, received.item.id);
    assertApproved(approval);
    expect(approval.billId).toBeDefined();

    const [bill] = await orgBills(fixture.orgId);
    expect(bill).toMatchObject({
      id: approval.billId,
      vendorId: fixture.vendor.id,
      billNumber: "INV-4242",
      billDate: BILL_DATE,
      dueDate: BILL_DATE,
      memo: "Office supplies invoice",
      amount: "84.25",
      balanceDue: "84.25",
      status: "awaiting_payment",
      approverId: fixture.userId,
      journalHeaderId: approval.journalHeaderId,
      documentUrl: received.pdf.storagePath,
      documentType: "pdf",
    });
    const lineItems = await db
      .select()
      .from(billLineItems)
      .where(eq(billLineItems.billId, bill.id));
    expect(lineItems).toEqual([
      expect.objectContaining({
        description: "Printer paper",
        amount: "84.25",
        accountId: fixture.expense.id,
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
        sortOrder: 0,
      }),
    ]);

    // The journal is the accrual the bill points at, stamped so bill void and
    // A/P aging (which find journals only through this pair) can see it.
    const [journal] = await orgJournals(fixture.orgId);
    expect(journal).toMatchObject({
      id: approval.journalHeaderId,
      status: "posted",
      partyId: fixture.vendor.id,
      sourceDocumentType: "bill",
      sourceDocumentId: bill.id,
      createdBy: fixture.userId,
      idempotencyKey: `inbox:${received.item.id}:approve:2`,
      totalAmount: "84.25000000",
    });
    const lines = await db
      .select()
      .from(journalLines)
      .where(eq(journalLines.journalHeaderId, journal.id));
    const sum = (values: (string | null)[]) =>
      values.reduce((total, value) => total + BigInt((value ?? "0").replace(".", "")), 0n);
    expect(sum(lines.map((line) => line.debit))).toBe(sum(lines.map((line) => line.credit)));
    const [payable] = await db
      .select({
        balance: sql<string>`(coalesce(sum(${journalLines.credit}), 0) - coalesce(sum(${journalLines.debit}), 0))::text`,
      })
      .from(journalLines)
      .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
      .where(
        and(
          eq(journalHeaders.sourceDocumentType, "bill"),
          eq(journalHeaders.sourceDocumentId, bill.id),
          eq(journalLines.accountId, fixture.ap.id),
        ),
      );
    expect(payable.balance).toBe("84.25000000");

    const links = await db
      .select({
        sourceRecordId: ledgerSourceLinks.sourceRecordId,
        relationship: ledgerSourceLinks.relationship,
      })
      .from(ledgerSourceLinks)
      .where(eq(ledgerSourceLinks.journalHeaderId, journal.id));
    expect(links).toEqual(
      expect.arrayContaining([
        { sourceRecordId: received.origin.id, relationship: "origin" },
        { sourceRecordId: received.container!.id, relationship: "supporting" },
      ]),
    );

    const billAttachments = await db
      .select({ documentId: documentAttachments.documentId })
      .from(documentAttachments)
      .where(
        and(
          eq(documentAttachments.linkableType, "bill"),
          eq(documentAttachments.linkableId, bill.id),
        ),
      );
    expect(billAttachments).toEqual([{ documentId: received.pdf.id }]);

    // Visible through the same query the Bills list serves.
    const listed = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      listOrganizationBills(tx, fixture.orgId, { status: "awaiting_payment", limit: 100 }),
    );
    expect(listed).toEqual([
      expect.objectContaining({
        id: bill.id,
        vendorName: "Paper Supply Co",
        amount: "84.25",
        journalHeaderId: journal.id,
      }),
    ]);

    const [decision] = await db
      .select()
      .from(reviewDecisions)
      .where(eq(reviewDecisions.inboxItemId, received.item.id));
    expect(decision).toMatchObject({
      decision: "approved",
      actorType: "user",
      actorId: fixture.userId,
      actorKey: null,
      journalHeaderId: journal.id,
    });
    const [created] = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.entityType, "bill"),
          eq(activityLogs.entityId, bill.id),
          eq(activityLogs.action, "created"),
        ),
      );
    expect(created.actorId).toBe(fixture.userId);
    expect(created.changes).toMatchObject({
      source: "inbox",
      inboxItemId: received.item.id,
      journalHeaderId: journal.id,
      totalAmount: "84.25",
    });
  });

  it("creates the bill for an uploaded document classified bill_accrual too", async () => {
    const fixture = await setupOrganization("bill-upload");
    const received = await receiveVendorBill(fixture, "document_transaction");
    await categorize(fixture, received, accrualLines(fixture, "120.00"));

    const approval = await approve(fixture, received.item.id);
    assertApproved(approval);
    const [bill] = await orgBills(fixture.orgId);
    expect(bill).toMatchObject({
      id: approval.billId,
      amount: "120.00",
      status: "awaiting_payment",
      journalHeaderId: approval.journalHeaderId,
    });
  });

  it("is idempotent: approving the same item twice leaves one bill and one journal", async () => {
    const fixture = await setupOrganization("bill-twice");
    const received = await receiveVendorBill(fixture);
    await categorize(fixture, received, accrualLines(fixture, "84.25"));
    const [itemBefore] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, received.item.id));

    const first = await approve(fixture, received.item.id);
    assertApproved(first);
    const second = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      approveInboxItem(
        { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
        {
          inboxItemId: received.item.id,
          expectedRevision: itemBefore.candidateRevision,
          expectedLockVersion: itemBefore.lockVersion,
        },
      ),
    );
    expect(second).toMatchObject({
      approvalOutcome: "approved",
      journalHeaderId: first.journalHeaderId,
      alreadyApproved: true,
    });
    expect(await orgBills(fixture.orgId)).toHaveLength(1);
    expect(await orgJournals(fixture.orgId)).toHaveLength(1);
  });

  it("still refuses a locked period, and nothing is written", async () => {
    const fixture = await setupOrganization("bill-locked");
    const received = await receiveVendorBill(fixture);
    await categorize(fixture, received, accrualLines(fixture, "84.25"));
    await db
      .update(organization)
      .set({ closedThrough: "2026-07-31" })
      .where(eq(organization.id, fixture.orgId));

    await expect(approve(fixture, received.item.id)).rejects.toThrow(
      "The accounting period is locked through 2026-07-31.",
    );
    expect(await orgBills(fixture.orgId)).toHaveLength(0);
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
    const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, received.item.id));
    expect(item.state).toBe("ready_for_review");
  });

  it("rejects sub-cent amounts instead of rounding them into the bill", async () => {
    const fixture = await setupOrganization("bill-subcent");
    const received = await receiveVendorBill(fixture);
    await categorize(fixture, received, accrualLines(fixture, "10.005"));

    await expect(approve(fixture, received.item.id)).rejects.toThrow(BILL_SUB_CENT_MESSAGE);
    expect(await orgBills(fixture.orgId)).toHaveLength(0);
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
  });

  it("keeps FX on the journal, and refuses a conversion that lands below a cent", async () => {
    const fixture = await setupOrganization("bill-fx");
    const exact = await receiveVendorBill(fixture);
    await categorize(fixture, exact, accrualLines(fixture, "100.00"), {
      originalCurrency: "EUR",
      exchangeRate: "1.1",
    });
    const approval = await approve(fixture, exact.item.id);
    assertApproved(approval);
    const [bill] = await orgBills(fixture.orgId);
    expect(bill.amount).toBe("110.00");
    const [journal] = await orgJournals(fixture.orgId);
    expect(journal).toMatchObject({ transactionCurrency: "EUR", functionalCurrency: "USD" });
    expect(journal.exchangeRateId).not.toBeNull();
    const [apLine] = await db
      .select()
      .from(journalLines)
      .where(
        and(
          eq(journalLines.journalHeaderId, journal.id),
          eq(journalLines.accountId, fixture.ap.id),
        ),
      );
    expect(apLine).toMatchObject({
      credit: "110.00000000",
      originalCredit: "100.00000000",
      originalCurrency: "EUR",
      exchangeRate: "1.1000000000",
      exchangeRateId: journal.exchangeRateId,
    });

    // A separate organization: the same paper again would (rightly) be held
    // as a possible duplicate before the cent policy is reached.
    const other = await setupOrganization("bill-fx-subcent");
    const subCent = await receiveVendorBill(other);
    await categorize(other, subCent, accrualLines(other, "100.00"), {
      originalCurrency: "EUR",
      exchangeRate: "1.08375",
    });
    await expect(approve(other, subCent.item.id)).rejects.toThrow(BILL_SUB_CENT_MESSAGE);
    expect(await orgBills(other.orgId)).toHaveLength(0);
    expect(await orgJournals(other.orgId)).toHaveLength(0);
  });

  it("posts a bill_accrual paper booked against cash as a plain journal, with no bill", async () => {
    const fixture = await setupOrganization("bill-cash");
    const received = await receiveVendorBill(fixture);
    await categorize(fixture, received, [
      {
        accountId: fixture.expense.id,
        debit: "84.25",
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      { accountId: fixture.bank.id, credit: "84.25" },
    ]);

    const approval = await approve(fixture, received.item.id);
    assertApproved(approval);
    expect(approval.billId).toBeUndefined();
    expect(await orgBills(fixture.orgId)).toHaveLength(0);
    const [journal] = await orgJournals(fixture.orgId);
    expect(journal.sourceDocumentId).toBeNull();
  });

  it("blocks an entry that touches payables but is not a bill", async () => {
    const fixture = await setupOrganization("bill-shape");
    const received = await receiveVendorBill(fixture);
    await categorize(fixture, received, [
      {
        accountId: fixture.expense.id,
        debit: "100.00",
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      { accountId: fixture.ap.id, credit: "90.00" },
      { accountId: fixture.bank.id, credit: "10.00" },
    ]);

    await expect(approve(fixture, received.item.id)).rejects.toThrow(BILL_ACCRUAL_SHAPE_MESSAGE);
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
  });

  it("blocks a vendor bill with no vendor even when the vendor rule is switched off", async () => {
    const fixture = await setupOrganization("bill-no-vendor");
    await disableRule(fixture, "missing_vendor");
    const received = await receiveVendorBill(fixture);
    await categorize(fixture, received, accrualLines(fixture, "84.25"), { partyId: null });

    await expect(approve(fixture, received.item.id)).rejects.toThrow(
      "Choose the vendor for this bill before approving it.",
    );
    expect(await orgBills(fixture.orgId)).toHaveLength(0);
  });

  it("keeps maker-checker: the submitter cannot approve their own bill", async () => {
    const fixture = await setupOrganization("bill-maker-checker", {
      requireDifferentApprover: true,
    });
    const received = await receiveVendorBill(fixture);
    await categorize(fixture, received, accrualLines(fixture, "84.25"));

    await expect(approve(fixture, received.item.id, "member")).rejects.toThrow(
      "The submitter cannot approve their own transaction.",
    );
    expect(await orgBills(fixture.orgId)).toHaveLength(0);
  });
});

/** A Bills-editor save, as the createBill server function submits it. */
function editorBillDraft(fixture: Fixture) {
  return {
    idempotencyKey: randomUUID(),
    vendorId: fixture.vendor.id,
    billNumber: "PSC-77",
    billDate: BILL_DATE,
    dueDate: "2026-08-19",
    memo: "Toner",
    status: "in_review" as const,
    lineItems: [
      {
        description: "Toner cartridges",
        amount: "45.50",
        accountId: fixture.expense.id,
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
    ],
  };
}

async function submitEditorBill(fixture: Fixture, draft: ReturnType<typeof editorBillDraft>) {
  const submitted = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    submitBillForReviewCore(tx, fixture.orgId, { type: "user", userId: fixture.userId }, draft),
  );
  if (submitted.deduplicated) throw new Error("A first submission cannot be a replay.");
  return submitted;
}

describe("Bills editor submission through the bill core", () => {
  it("saves the bill for review, replays exactly, and approval posts onto the same bill", async () => {
    const fixture = await setupOrganization("bill-editor");
    // A fresh editor bill has no invoice document linked yet.
    await disableRule(fixture, "missing_invoice");
    const draft = editorBillDraft(fixture);
    const { idempotencyKey } = draft;
    const actor = { type: "user" as const, userId: fixture.userId };

    const submitted = await submitEditorBill(fixture, draft);
    expect(submitted).toMatchObject({
      status: "in_review",
      amount: "45.50",
      journalHeaderId: null,
    });
    const replay = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      submitBillForReviewCore(tx, fixture.orgId, actor, draft),
    );
    expect(replay).toMatchObject({ id: submitted.id, deduplicated: true });
    await expect(
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        submitBillForReviewCore(tx, fixture.orgId, actor, { ...draft, memo: "Different" }),
      ),
    ).rejects.toThrow("already used for a different bill submission");

    const [candidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.organizationId, fixture.orgId));
    expect(candidate).toMatchObject({
      candidateType: "bill",
      requestIdempotencyKey: idempotencyKey,
    });

    const approval = await approve(fixture, submitted.inboxItemId);
    assertApproved(approval);
    expect(approval.billId).toBe(submitted.id);
    const allBills = await orgBills(fixture.orgId);
    expect(allBills).toHaveLength(1);
    expect(allBills[0]).toMatchObject({
      id: submitted.id,
      status: "awaiting_payment",
      journalHeaderId: approval.journalHeaderId,
      approverId: fixture.userId,
    });
    const [journal] = await orgJournals(fixture.orgId);
    expect(journal).toMatchObject({ sourceDocumentType: "bill", sourceDocumentId: submitted.id });
  });
});

describe("a bill the Bills page settled while its Inbox item was pending", () => {
  it("refuses a second accrual and leaves the Inbox item for a person to reject", async () => {
    const fixture = await setupOrganization("bill-race");
    await disableRule(fixture, "missing_invoice");
    const submitted = await submitEditorBill(fixture, editorBillDraft(fixture));

    // Approved on the Bills page first, exactly as transitionBillStatus does
    // for in_review -> awaiting_payment: lock the row, post the accrual, link it.
    const accrualId = await withOrgContext(fixture.orgId, fixture.userId, "owner", async (tx) => {
      const [bill] = await tx
        .select()
        .from(bills)
        .where(eq(bills.id, submitted.id))
        .limit(1)
        .for("update");
      const journalId = await postBillAccrualJournal(tx, {
        organizationId: fixture.orgId,
        userId: fixture.userId,
        bill,
      });
      await tx
        .update(bills)
        .set({ status: "awaiting_payment", journalHeaderId: journalId, updatedAt: new Date() })
        .where(eq(bills.id, bill.id));
      return journalId;
    });
    const [itemBefore] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, submitted.inboxItemId));

    await expect(approve(fixture, submitted.inboxItemId)).rejects.toThrow(
      BILL_ALREADY_ACCRUED_MESSAGE,
    );

    const journals = await orgJournals(fixture.orgId);
    expect(journals).toHaveLength(1);
    expect(journals[0]).toMatchObject({
      id: accrualId,
      idempotencyKey: `bill-accrual:${submitted.id}`,
      sourceDocumentId: submitted.id,
    });
    const [bill] = await orgBills(fixture.orgId);
    expect(bill).toMatchObject({ status: "awaiting_payment", journalHeaderId: accrualId });
    const [itemAfter] = await db
      .select()
      .from(inboxItems)
      .where(eq(inboxItems.id, submitted.inboxItemId));
    expect(itemAfter).toMatchObject({
      state: "ready_for_review",
      lockVersion: itemBefore.lockVersion,
    });
    const [candidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, itemAfter.candidateId!));
    expect(candidate).toMatchObject({ status: "current", postedJournalHeaderId: null });
    expect(
      await db
        .select()
        .from(reviewDecisions)
        .where(eq(reviewDecisions.inboxItemId, submitted.inboxItemId)),
    ).toHaveLength(0);

    // The person resolves it by rejecting; the ledger and the bill stay put.
    await rejectPendingItem(fixture, submitted.inboxItemId, "Already approved in Bills.");
    expect(await orgJournals(fixture.orgId)).toHaveLength(1);
    const [billAfter] = await orgBills(fixture.orgId);
    expect(billAfter).toMatchObject({ status: "awaiting_payment", journalHeaderId: accrualId });
  });

  it("refuses to revive a bill that was voided in Bills", async () => {
    const fixture = await setupOrganization("bill-voided");
    await disableRule(fixture, "missing_invoice");
    const submitted = await submitEditorBill(fixture, editorBillDraft(fixture));
    // in_review -> voided on the Bills page: no accrual existed to void.
    await db
      .update(bills)
      .set({ status: "voided", updatedAt: new Date() })
      .where(eq(bills.id, submitted.id));

    await expect(approve(fixture, submitted.inboxItemId)).rejects.toThrow(BILL_VOIDED_MESSAGE);
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
    const [bill] = await orgBills(fixture.orgId);
    expect(bill).toMatchObject({ status: "voided", journalHeaderId: null });
    await rejectPendingItem(fixture, submitted.inboxItemId, "Voided in Bills.");
  });

  it("refuses to recreate a bill that was deleted in Bills", async () => {
    const fixture = await setupOrganization("bill-deleted");
    await disableRule(fixture, "missing_invoice");
    const submitted = await submitEditorBill(fixture, editorBillDraft(fixture));
    // Deleted on the Bills page while in review: deleteBill had no accrual to
    // void, so the row (and its line items, by cascade) is simply gone.
    await db.delete(bills).where(eq(bills.id, submitted.id));

    await expect(approve(fixture, submitted.inboxItemId)).rejects.toThrow(BILL_DELETED_MESSAGE);
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
    expect(await orgBills(fixture.orgId)).toHaveLength(0);
    await rejectPendingItem(fixture, submitted.inboxItemId, "Deleted in Bills.");
    expect(await orgBills(fixture.orgId)).toHaveLength(0);
  });
});

/** A refused item is still open, and rejecting it is how a person resolves it. */
async function rejectPendingItem(fixture: Fixture, inboxItemId: string, reason: string) {
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, inboxItemId));
  expect(item.state).toBe("ready_for_review");
  const rejected = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    rejectInboxItem(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      { inboxItemId, expectedLockVersion: item.lockVersion, reason },
    ),
  );
  expect(rejected.state).toBe("rejected");
}

describe("postTransactionCore", () => {
  const balanced = (fixture: Fixture, amount: string) => [
    { accountId: fixture.expense.id, debit: amount, credit: null, sortOrder: 0 },
    { accountId: fixture.bank.id, debit: null, credit: amount, sortOrder: 1 },
  ];

  it("posts a balanced draft once per idempotency key", async () => {
    const fixture = await setupOrganization("core-post");
    const draft = {
      idempotencyKey: `core-test:${randomUUID()}`,
      transactionDate: BILL_DATE,
      transactionType: "pay_out" as const,
      source: "manual" as const,
      memo: "Direct core posting",
      functionalCurrency: "USD",
      lines: balanced(fixture, "12.34"),
    };
    const actor = { type: "user" as const, userId: fixture.userId };
    const posted = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      postTransactionCore(tx, fixture.orgId, actor, draft),
    );
    expect(posted.transactionNumber).toMatch(/^TXN-\d{6}$/);
    const [header] = await orgJournals(fixture.orgId);
    expect(header).toMatchObject({
      id: posted.journalHeaderId,
      status: "posted",
      totalAmount: "12.34000000",
      createdBy: fixture.userId,
    });
    expect(header.postedAt).not.toBeNull();

    await expect(
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        postTransactionCore(tx, fixture.orgId, actor, draft),
      ),
    ).rejects.toThrow();
    expect(await orgJournals(fixture.orgId)).toHaveLength(1);
  });

  it("refuses an unbalanced draft and a locked date before writing", async () => {
    const fixture = await setupOrganization("core-guards");
    const actor = { type: "user" as const, userId: fixture.userId };
    const draft = {
      idempotencyKey: `core-test:${randomUUID()}`,
      transactionDate: BILL_DATE,
      transactionType: "journal" as const,
      source: "manual" as const,
      functionalCurrency: "USD",
      lines: balanced(fixture, "5.00"),
    };
    await expect(
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        postTransactionCore(tx, fixture.orgId, actor, {
          ...draft,
          lines: [draft.lines[0], { ...draft.lines[1], credit: "5.00000001" }],
        }),
      ),
    ).rejects.toThrow("Unbalanced entry");

    await db
      .update(organization)
      .set({ closedThrough: "2026-07-31" })
      .where(eq(organization.id, fixture.orgId));
    await expect(
      withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
        postTransactionCore(tx, fixture.orgId, actor, draft),
      ),
    ).rejects.toThrow("The accounting period is locked through 2026-07-31.");
    expect(await orgJournals(fixture.orgId)).toHaveLength(0);
  });
});

describe("createInvoiceCore", () => {
  it("allocates the number and writes the draft the invoice editor used to", async () => {
    const fixture = await setupOrganization("invoice-core");
    const invoice = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      createInvoiceCore(
        tx,
        fixture.orgId,
        { type: "user", userId: fixture.userId },
        {
          customerId: fixture.customer.id,
          issueDate: BILL_DATE,
          dueDate: "2026-08-19",
          discountAmount: "0",
          taxAmount: "1.50",
          lineItems: [
            {
              description: "Consulting",
              quantity: "2",
              unitPrice: "40.25",
              revenueAccountId: fixture.revenue.id,
              sortOrder: 0,
            },
          ],
        },
      ),
    );
    expect(invoice).toMatchObject({
      invoiceNumber: "INV-0001",
      status: "draft",
      subtotal: "80.50",
      taxAmount: "1.50",
      total: "82.00",
      balanceDue: "82.00",
    });
    const lines = await db
      .select()
      .from(invoiceLineItems)
      .where(eq(invoiceLineItems.invoiceId, invoice.id));
    expect(lines).toEqual([expect.objectContaining({ amount: "80.50", quantity: "2.0000" })]);
  });
});

describe("review_decisions actor columns (0053)", () => {
  it("records a system decision by key and refuses a user decision without a user", async () => {
    const fixture = await setupOrganization("decision-actor");
    const received = await receiveVendorBill(fixture);
    const base = {
      organizationId: fixture.orgId,
      inboxItemId: received.item.id,
      decision: "approved",
      candidateRevision: 1,
      beforeState: "ready_for_review",
      afterState: "approved",
    };

    const [system] = await db
      .insert(reviewDecisions)
      .values({ ...base, actorType: "system", actorKey: "jev" })
      .returning();
    expect(system).toMatchObject({ actorType: "system", actorKey: "jev", actorId: null });

    await expect(
      db.insert(reviewDecisions).values({ ...base, actorType: "user", actorId: null }),
    ).rejects.toThrow();
    await expect(
      db.insert(reviewDecisions).values({ ...base, actorType: "system" }),
    ).rejects.toThrow();
    await expect(
      db.insert(reviewDecisions).values({ ...base, actorType: "robot", actorKey: "jev" }),
    ).rejects.toThrow();
  });
});
