import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db, withOrgContext } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { member, organization, user } from "@/db/schema/auth";
import { dimensions } from "@/db/schema/dimensions";
import { inboxItems, organizationAccountingSettings, reviewFindings } from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import type { CandidateLineInput } from "@/lib/inbox/types";
import { approveInboxItem, createTransactionCandidate, rejectInboxItem } from "@/lib/inbox/service";
import { listInboxV2Items } from "@/lib/inbox/v2/list";

/**
 * The Inbox v2 list is everything that needs a human (spec §10): open states plus `failed`,
 * never approved, rejected, or dismissed — there is no Done folder — each with one reason. It is
 * also the sidebar badge, so an item that leaks across organizations or survives its decision
 * would show up as a wrong count everywhere.
 */

async function setupOrganization(prefix: string) {
  const suffix = randomUUID();
  const orgId = `${prefix}-org-${suffix}`;
  const userId = `${prefix}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Inbox v2 Owner",
    email: `${prefix}-${suffix}@test.local`,
    emailVerified: true,
  });
  await db.insert(organization).values({
    id: orgId,
    name: "Inbox v2 Test Organization",
    slug: `${prefix}-${suffix}`,
    metadata: JSON.stringify({ currency: "USD", phone: "+1 555 0100" }),
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
      { organizationId: orgId, dimensionType: "department", name: "Operations" },
      { organizationId: orgId, dimensionType: "location", name: "Main Office" },
    ])
    .returning();
  const [vendor] = await db
    .insert(parties)
    .values({ organizationId: orgId, name: "Paper Street Supply", partyType: "vendor" })
    .returning();
  await db.insert(organizationAccountingSettings).values({
    organizationId: orgId,
    baseCurrency: "USD",
    requireDifferentApprover: false,
  });
  return { orgId, userId, bank, expense, department, location, vendor };
}

type Fixture = Awaited<ReturnType<typeof setupOrganization>>;

/**
 * A paid expense small enough to need no receipt. Amounts, dates and references differ per call
 * so the duplicate engine never pairs two fixtures.
 */
async function submit(
  fixture: Fixture,
  input: {
    amount: string;
    day: number;
    memo: string;
    withVendor?: boolean;
    expenseLine?: Partial<CandidateLineInput>;
  },
) {
  const dimensionsOn = {
    departmentId: fixture.department.id,
    locationId: fixture.location.id,
  };
  const result = await withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    createTransactionCandidate(
      { db: tx, orgId: fixture.orgId, userId: fixture.userId, role: "owner" },
      {
        transactionDate: `2026-08-${String(input.day).padStart(2, "0")}`,
        transactionType: "pay_out",
        memo: input.memo,
        referenceNumber: `V2-${input.day}-${randomUUID().slice(0, 8)}`,
        partyId: input.withVendor === false ? null : fixture.vendor.id,
        lines: [
          {
            accountId: fixture.expense.id,
            debit: input.amount,
            ...dimensionsOn,
            ...input.expenseLine,
          },
          { accountId: fixture.bank.id, credit: input.amount, ...dimensionsOn },
        ],
      },
    ),
  );
  return result.inboxItem;
}

function list(fixture: Fixture, options?: { limit?: number }) {
  return withOrgContext(fixture.orgId, fixture.userId, "owner", (tx) =>
    listInboxV2Items(tx, fixture.orgId, options),
  );
}

describe("Inbox v2 list", () => {
  it("lists what needs a person and failed items, one reason each, never a decided one", async () => {
    const org = await setupOrganization("inbox-v2-list");

    const clean = await submit(org, { amount: "42.10", day: 3, memo: "Printer paper" });
    const missingVendor = await submit(org, {
      amount: "17.35",
      day: 5,
      memo: "Unlabelled receipt",
      withVendor: false,
    });
    const unsure = await submit(org, {
      amount: "23.40",
      day: 7,
      memo: "Toner, maybe",
      expenseLine: { categoryConfidence: "0.4200" },
    });
    const remembered = await submit(org, {
      amount: "31.15",
      day: 9,
      memo: "Monthly stationery",
      expenseLine: {
        categoryConfidence: "0.9900",
        predictionEvidence: { source: "memory", memoryId: "fixture" },
      },
    });
    const failed = await submit(org, { amount: "12.80", day: 11, memo: "Garbled scan" });
    const processingFailed = await submit(org, { amount: "9.65", day: 13, memo: "Email bounce" });

    const approved = await submit(org, { amount: "56.20", day: 15, memo: "Approved stock" });
    const rejected = await submit(org, { amount: "61.05", day: 17, memo: "Rejected stock" });
    const dismissed = await submit(org, { amount: "66.90", day: 19, memo: "Dismissed stock" });
    const beingProcessed = await submit(org, { amount: "71.30", day: 20, memo: "Email in flight" });
    const justReceived = await submit(org, { amount: "72.45", day: 21, memo: "Upload in flight" });

    await withOrgContext(org.orgId, org.userId, "owner", async (tx) => {
      const ctx = { db: tx, orgId: org.orgId, userId: org.userId, role: "owner" };
      const outcome = await approveInboxItem(ctx, {
        inboxItemId: approved.id,
        expectedRevision: approved.candidateRevision,
        expectedLockVersion: approved.lockVersion,
      });
      expect(outcome.approvalOutcome).toBe("approved");
      await rejectInboxItem(ctx, {
        inboxItemId: rejected.id,
        expectedLockVersion: rejected.lockVersion,
        reason: "Not ours",
      });
    });
    await db.update(inboxItems).set({ state: "dismissed" }).where(eq(inboxItems.id, dismissed.id));
    await db
      .update(inboxItems)
      .set({ state: "processing" })
      .where(eq(inboxItems.id, beingProcessed.id));
    await db
      .update(inboxItems)
      .set({ state: "received" })
      .where(eq(inboxItems.id, justReceived.id));
    await db.update(inboxItems).set({ state: "failed" }).where(eq(inboxItems.id, failed.id));
    await db
      .update(inboxItems)
      .set({ state: "needs_information" })
      .where(eq(inboxItems.id, processingFailed.id));
    await db.insert(reviewFindings).values({
      organizationId: org.orgId,
      inboxItemId: processingFailed.id,
      candidateId: processingFailed.candidateId,
      ruleKey: "source_processing_failed",
      impact: "blocking",
      subjectType: "processing_job",
      subjectId: randomUUID(),
      fingerprint: `${processingFailed.candidateId}:source-processing-failed:fixture`,
      message: "Inbound email processing failed after 8 attempt(s).",
      evidence: { source: "resend", emailId: "email-fixture" },
    });

    const { items, truncated, beingRead } = await list(org);
    expect(truncated).toBe(false);
    // Papers still being read need nobody yet: counted, never listed.
    expect(beingRead).toBe(2);
    for (const inFlight of [beingProcessed, justReceived]) {
      expect(items.some((item) => item.id === inFlight.id)).toBe(false);
    }
    const byId = new Map(items.map((item) => [item.id, item]));

    // Terminal states never come back: no Done folder.
    for (const decided of [approved, rejected, dismissed]) expect(byId.has(decided.id)).toBe(false);
    expect(items).toHaveLength(6);
    // Newest first.
    expect(items.map((item) => item.id)).toEqual([
      processingFailed.id,
      failed.id,
      remembered.id,
      unsure.id,
      missingVendor.id,
      clean.id,
    ]);

    // Typed by hand with nothing open: ready to approve, not "Jev unsure".
    expect(byId.get(clean.id)).toMatchObject({
      reason: "ready",
      reasonDetail: "ready",
      who: "Paper Street Supply",
      kind: "expense",
      originalCurrency: "USD",
      sourceBadge: null,
    });
    expect(byId.get(clean.id)!.originalTotal).toMatch(/^42\.10*$/);
    expect(byId.get(missingVendor.id)).toMatchObject({
      reason: "needs_fix",
      reasonDetail: "blocking_finding",
      reasonText: "Assign a vendor to this expense transaction.",
      // No counterparty yet, so the row names the paper.
      who: "Unlabelled receipt",
    });
    expect(byId.get(unsure.id)).toMatchObject({
      reason: "jev_unsure",
      reasonDetail: "low_confidence",
      sourceBadge: { kind: "jev", confidence: 0.42 },
    });
    // A confident, remembered answer is ready too; the badge says where it came from.
    expect(byId.get(remembered.id)).toMatchObject({
      reason: "ready",
      sourceBadge: { kind: "remembered" },
    });
    expect(byId.get(failed.id)).toMatchObject({ state: "failed", reason: "failed" });
    expect(byId.get(processingFailed.id)).toMatchObject({
      state: "needs_information",
      reason: "failed",
      reasonText: "Inbound email processing failed after 8 attempt(s).",
    });

    // The badge caps with the list: past the limit it says there are more.
    const capped = await list(org, { limit: 2 });
    expect(capped.items.map((item) => item.id)).toEqual([processingFailed.id, failed.id]);
    expect(capped.truncated).toBe(true);
    expect(capped.beingRead).toBe(2);
  });

  it("returns only the organization's own items, and RLS hides them from another org", async () => {
    const orgA = await setupOrganization("inbox-v2-iso-a");
    const orgB = await setupOrganization("inbox-v2-iso-b");
    const itemA = await submit(orgA, { amount: "14.60", day: 21, memo: "Org A paper" });
    const readingA = await submit(orgA, { amount: "15.10", day: 23, memo: "Org A in flight" });
    await db.update(inboxItems).set({ state: "processing" }).where(eq(inboxItems.id, readingA.id));
    const itemB = await submit(orgB, { amount: "18.25", day: 22, memo: "Org B paper" });

    expect(await list(orgA)).toMatchObject({ beingRead: 1 });
    expect((await list(orgA)).items.map((item) => item.id)).toEqual([itemA.id]);
    expect(await list(orgB)).toMatchObject({ beingRead: 0 });
    expect((await list(orgB)).items.map((item) => item.id)).toEqual([itemB.id]);

    // Under the non-owner runtime role, org B's session cannot read org A's rows even when the
    // query asks for org A by id — while org A's own session, same role, still can.
    const listAsRuntimeRole = (session: Fixture, target: Fixture) =>
      db.transaction(async (tx) => {
        await tx.execute(sql`SET LOCAL ROLE buwiz_app`);
        await tx.execute(sql`
          SELECT set_config('app.current_organization_id', ${session.orgId}, true),
                 set_config('app.current_user_id', ${session.userId}, true),
                 set_config('app.user_role', 'owner', true)
        `);
        return listInboxV2Items(tx, target.orgId);
      });
    expect((await listAsRuntimeRole(orgA, orgA)).items.map((item) => item.id)).toEqual([itemA.id]);
    expect(await listAsRuntimeRole(orgB, orgA)).toMatchObject({ items: [], beingRead: 0 });
  });

  it("keeps an item listed with its fix reason until the blocking finding is resolved", async () => {
    const org = await setupOrganization("inbox-v2-resolve");
    const item = await submit(org, {
      amount: "27.45",
      day: 25,
      memo: "Needs a vendor",
      withVendor: false,
    });
    expect((await list(org)).items[0]).toMatchObject({ id: item.id, reason: "needs_fix" });

    await db
      .update(reviewFindings)
      .set({ state: "resolved", resolvedBy: org.userId, resolvedAt: new Date() })
      .where(and(eq(reviewFindings.inboxItemId, item.id), eq(reviewFindings.state, "open")));
    expect((await list(org)).items[0]).toMatchObject({
      id: item.id,
      reason: "ready",
      reasonDetail: "ready",
    });
  });
});
