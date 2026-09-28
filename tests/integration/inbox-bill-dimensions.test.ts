/**
 * A vendor bill opened in the Inbox v2 reading pane is edited in the Bills editor, which had no
 * Department or Location field. With the default rules a bill with neither is blocked by Missing
 * Department and Missing Location, and a resolution note was the only way past them.
 *
 * These drive the pane's own mapping (candidate → Bills editor draft → correction) with a
 * department and location picked on the expense line, through the real correction and approval:
 * the two checks clear on the correction, and the accrual approval posts carries both on the
 * expense line, as does the bill it writes.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, asc, eq } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import { billLineItems, bills } from "@/db/schema/bills";
import { dimensions } from "@/db/schema/dimensions";
import {
  inboxItems,
  organizationAccountingSettings,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
} from "@/db/schema/inbox";
import { journalLines } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import {
  billDraftToCorrection,
  candidateToEditorDraft,
  type CandidateCorrection,
  type DraftSourceCandidate,
} from "@/components/inbox-v2/candidate-draft";
import { correctInboxCandidate } from "@/lib/inbox/candidate-correction";
import { approveInboxItem, type ApproveInboxResult } from "@/lib/inbox/service";
import { submitBillForReviewCore } from "@/lib/posting/bill-submission";

const BILL_DATE = "2026-07-21";
const DIMENSION_RULES = ["missing_department", "missing_location"];

async function setupOrganization(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Bill Dimensions Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Bill Dimensions Organization",
    slug: `${prefix}-${suffix}`,
  });
  await db.insert(member).values({
    id: `${prefix}-member-${suffix}`,
    userId,
    organizationId: orgId,
    role: "owner",
  });
  const [expense, ap] = await db
    .insert(accounts)
    .values([
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
    ])
    .returning();
  const [department, location] = await db
    .insert(dimensions)
    .values([
      { organizationId: orgId, dimensionType: "department", name: "Operations" },
      { organizationId: orgId, dimensionType: "location", name: "Main Office" },
    ])
    .returning();
  const [vendor] = await db
    .insert(parties)
    .values({ organizationId: orgId, name: "Paper Supply Co", partyType: "vendor" })
    .returning();
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: false,
    missingReceiptThreshold: "100000",
  });
  // A fresh bill has no invoice document yet; that rule is not what these tests are about.
  // Missing Department and Missing Location keep their catalog defaults: enabled, blocking.
  const [missingInvoice] = await db
    .select({ id: reviewRuleDefinitions.id })
    .from(reviewRuleDefinitions)
    .where(eq(reviewRuleDefinitions.key, "missing_invoice"));
  await db.insert(reviewRuleConfigs).values({
    organizationId: orgId,
    definitionId: missingInvoice.id,
    enabled: false,
    impact: "blocking",
    updatedBy: userId,
  });
  return { orgId, userId, expense, ap, department, location, vendor };
}

type Fixture = Awaited<ReturnType<typeof setupOrganization>>;

async function inboxItem(itemId: string) {
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, itemId));
  return item;
}

async function openFindings(itemId: string) {
  return db
    .select({ ruleKey: reviewFindings.ruleKey, impact: reviewFindings.impact })
    .from(reviewFindings)
    .where(and(eq(reviewFindings.inboxItemId, itemId), eq(reviewFindings.state, "open")));
}

/** The candidate as getInboxItem hands it to the reading pane. */
async function paneSource(itemId: string): Promise<DraftSourceCandidate> {
  const { candidateId } = await inboxItem(itemId);
  if (!candidateId) throw new Error("The Inbox item has no candidate.");
  const [candidate] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, candidateId));
  const lines = await db
    .select()
    .from(transactionCandidateLines)
    .where(eq(transactionCandidateLines.candidateId, candidate.id))
    .orderBy(asc(transactionCandidateLines.sortOrder));
  return {
    transactionType: candidate.transactionType,
    transactionDate: candidate.transactionDate,
    memo: candidate.memo,
    referenceNumber: candidate.referenceNumber,
    partyId: candidate.partyId,
    originalTotal: candidate.originalTotal,
    lines: lines.map((line) => ({
      id: line.id,
      accountId: line.accountId,
      originalDebit: line.originalDebit,
      originalCredit: line.originalCredit,
      lineDescription: line.lineDescription,
      departmentId: line.departmentId,
      locationId: line.locationId,
    })),
  };
}

/**
 * What the pane saves when a reviewer opens the bill in the Bills editor, and on its first line
 * picks a category (when the paper had none yet) plus the given department and location.
 */
async function billCorrectionFromPane(
  fixture: Fixture,
  itemId: string,
  picks: { departmentId: string | null; locationId: string | null },
): Promise<CandidateCorrection> {
  const opened = candidateToEditorDraft(await paneSource(itemId), "vendor_bill");
  if (opened.editor !== "bill") throw new Error("The bill did not open in the Bills editor.");
  const [first, ...rest] = opened.draft.lineItems;
  return billDraftToCorrection(
    {
      ...opened.draft,
      vendorId: opened.draft.vendorId || fixture.vendor.id,
      lineItems: [
        { ...first, accountId: first.accountId || fixture.expense.id, ...picks },
        ...rest,
      ],
    },
    {
      originalCurrency: "USD",
      functionalCurrency: "USD",
      exchangeRate: "1",
      creditLine: opened.creditLine,
      payableAccountId: fixture.ap.id,
    },
  );
}

async function correct(fixture: Fixture, itemId: string, correction: CandidateCorrection) {
  const item = await inboxItem(itemId);
  return withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    correctInboxCandidate(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        inboxItemId: itemId,
        expectedRevision: item.candidateRevision,
        expectedLockVersion: item.lockVersion,
        ...correction,
      },
    ),
  );
}

async function approve(fixture: Fixture, itemId: string): Promise<ApproveInboxResult> {
  const item = await inboxItem(itemId);
  return withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    approveInboxItem(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        inboxItemId: itemId,
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

async function postedDimensions(journalHeaderId: string) {
  return db
    .select({
      accountId: journalLines.accountId,
      debit: journalLines.debit,
      credit: journalLines.credit,
      departmentId: journalLines.departmentId,
      locationId: journalLines.locationId,
    })
    .from(journalLines)
    .where(eq(journalLines.journalHeaderId, journalHeaderId))
    .orderBy(asc(journalLines.sortOrder));
}

async function billLineDimensions(billId: string) {
  return db
    .select({
      accountId: billLineItems.accountId,
      departmentId: billLineItems.departmentId,
      locationId: billLineItems.locationId,
    })
    .from(billLineItems)
    .where(eq(billLineItems.billId, billId));
}

describe("department and location picked on an Inbox bill", () => {
  it("clear the dimension checks on a Bills-editor bill and post on its accrual's expense line", async () => {
    const fixture = await setupOrganization("bill-dims-editor");
    const submitted = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
      submitBillForReviewCore(
        tx,
        fixture.orgId,
        { type: "user", userId: fixture.userId },
        {
          idempotencyKey: randomUUID(),
          vendorId: fixture.vendor.id,
          billNumber: "PSC-88",
          billDate: BILL_DATE,
          dueDate: "2026-08-20",
          memo: "Toner",
          status: "in_review",
          lineItems: [
            { description: "Toner cartridges", amount: "45.50", accountId: fixture.expense.id },
          ],
        },
      ),
    );
    if (submitted.deduplicated) throw new Error("A first submission cannot be a replay.");
    const itemId = submitted.inboxItemId;

    // Saved with no department or location, the bill is blocked on exactly those two checks.
    expect(await openFindings(itemId)).toEqual(
      expect.arrayContaining(
        DIMENSION_RULES.map((ruleKey) => ({ ruleKey, impact: "blocking" as const })),
      ),
    );
    await expect(approve(fixture, itemId)).rejects.toThrow(/blocking Book finding/);

    await correct(
      fixture,
      itemId,
      await billCorrectionFromPane(fixture, itemId, {
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      }),
    );
    // Both checks clear on the correction, with no resolution note from anyone.
    expect(await openFindings(itemId)).toEqual([]);
    const cleared = await db
      .select({ ruleKey: reviewFindings.ruleKey, state: reviewFindings.state })
      .from(reviewFindings)
      .where(eq(reviewFindings.inboxItemId, itemId));
    expect(cleared.filter((finding) => DIMENSION_RULES.includes(finding.ruleKey))).toEqual(
      expect.arrayContaining(DIMENSION_RULES.map((ruleKey) => ({ ruleKey, state: "resolved" }))),
    );
    expect((await inboxItem(itemId)).state).toBe("ready_for_review");

    const approval = await approve(fixture, itemId);
    assertApproved(approval);
    expect(approval.billId).toBe(submitted.id);
    expect(await postedDimensions(approval.journalHeaderId)).toEqual([
      {
        accountId: fixture.expense.id,
        debit: "45.50000000",
        credit: null,
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      {
        accountId: fixture.ap.id,
        debit: null,
        credit: "45.50000000",
        departmentId: null,
        locationId: null,
      },
    ]);
    expect(await billLineDimensions(submitted.id)).toEqual([
      {
        accountId: fixture.expense.id,
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
    ]);
  });

  it("clear the dimension checks on an emailed bill and land on the bill approval writes", async () => {
    const fixture = await setupOrganization("bill-dims-email");
    const token = randomUUID();
    const [origin] = await db
      .insert(sourceRecords)
      .values({
        organizationId: fixture.orgId,
        recordType: "email_attachment",
        externalId: `attachment:${token}`,
        transactionDate: BILL_DATE,
        description: "Courier invoice",
        economicEventClass: "bill_accrual",
        direction: "outflow",
      })
      .returning();
    const [candidate] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: fixture.orgId,
        sourceRecordId: origin.id,
        candidateType: "email_transaction",
        transactionDate: BILL_DATE,
        transactionType: "journal",
        memo: "Courier invoice",
        referenceNumber: "CC-19",
        partyId: fixture.vendor.id,
        originalCurrency: "USD",
        functionalCurrency: "USD",
        exchangeRate: "1",
        originalTotal: "18.75000000",
        submittedBy: fixture.userId,
      })
      .returning();
    await db.insert(transactionCandidateSources).values({
      organizationId: fixture.orgId,
      candidateId: candidate.id,
      sourceRecordId: origin.id,
      relationship: "origin",
      isPrimary: true,
    });
    const [item] = await db
      .insert(inboxItems)
      .values({
        organizationId: fixture.orgId,
        candidateId: candidate.id,
        sourceRecordId: origin.id,
        itemType: "classify_source_record",
        state: "needs_information",
        title: "Courier invoice",
        submittedBy: fixture.userId,
      })
      .returning();

    // The paper's total, categorized, with nothing picked: the two checks block it.
    await correct(
      fixture,
      item.id,
      await billCorrectionFromPane(fixture, item.id, { departmentId: null, locationId: null }),
    );
    expect((await openFindings(item.id)).map(({ ruleKey }) => ruleKey).sort()).toEqual(
      DIMENSION_RULES,
    );

    // Picked on the (now categorized) line in the Bills editor: nothing is left open.
    await correct(
      fixture,
      item.id,
      await billCorrectionFromPane(fixture, item.id, {
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      }),
    );
    expect(await openFindings(item.id)).toEqual([]);

    const approval = await approve(fixture, item.id);
    assertApproved(approval);
    const [bill] = await db.select().from(bills).where(eq(bills.id, approval.billId!));
    expect(bill).toMatchObject({ vendorId: fixture.vendor.id, amount: "18.75" });
    expect(await postedDimensions(approval.journalHeaderId)).toEqual([
      {
        accountId: fixture.expense.id,
        debit: "18.75000000",
        credit: null,
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
      {
        accountId: fixture.ap.id,
        debit: null,
        credit: "18.75000000",
        departmentId: null,
        locationId: null,
      },
    ]);
    expect(await billLineDimensions(bill.id)).toEqual([
      {
        accountId: fixture.expense.id,
        departmentId: fixture.department.id,
        locationId: fixture.location.id,
      },
    ]);
  });
});
