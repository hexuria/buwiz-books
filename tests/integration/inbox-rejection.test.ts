import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { db, withOrgContext } from "@/db";
import { member, organization, user } from "@/db/schema/auth";
import {
  inboxItems,
  reviewFindings,
  sourceMatchCandidates,
  sourceRecords,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { rejectInboxItem } from "@/lib/inbox/service";

describe("Inbox rejection lifecycle", () => {
  it("rejects a needs-information candidate, retires its evidence, and resolves duplicate state", async () => {
    const suffix = randomUUID();
    const orgId = `inbox-rejection-${suffix}`;
    const userId = `inbox-rejection-user-${suffix}`;
    await db.insert(user).values({
      id: userId,
      name: "Inbox Rejection Owner",
      email: `${suffix}@inbox-rejection.test`,
      emailVerified: true,
    });
    await db.insert(organization).values({
      id: orgId,
      name: "Inbox Rejection",
      slug: `inbox-rejection-${suffix}`,
    });
    await db.insert(member).values({
      id: `member-${suffix}`,
      organizationId: orgId,
      userId,
      role: "owner",
    });
    const sources = await db
      .insert(sourceRecords)
      .values([
        {
          organizationId: orgId,
          recordType: "email_attachment",
          externalId: `rejected-${suffix}`,
          economicEventClass: "purchase",
          direction: "outflow",
          originalAmount: "25",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
        {
          organizationId: orgId,
          recordType: "bank_transaction",
          externalId: `comparison-${suffix}`,
          economicEventClass: "purchase",
          direction: "outflow",
          originalAmount: "25",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
      ])
      .returning();
    const rejectedSource = sources[0];
    const comparisonSource = sources[1];
    const [candidate] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: orgId,
        sourceRecordId: rejectedSource.id,
        candidateType: "email_transaction",
        transactionDate: "2026-07-24",
        transactionType: "pay_out",
        originalCurrency: "USD",
        functionalCurrency: "USD",
      })
      .returning();
    await db.insert(transactionCandidateSources).values({
      organizationId: orgId,
      candidateId: candidate.id,
      sourceRecordId: rejectedSource.id,
      relationship: "origin",
      isPrimary: true,
    });
    const [item] = await db
      .insert(inboxItems)
      .values({
        organizationId: orgId,
        candidateId: candidate.id,
        sourceRecordId: rejectedSource.id,
        state: "needs_information",
        title: "Unclassifiable email evidence",
      })
      .returning();
    const [leftSourceRecordId, rightSourceRecordId] = [
      rejectedSource.id,
      comparisonSource.id,
    ].sort();
    const [duplicateCase] = await db
      .insert(sourceMatchCandidates)
      .values({
        organizationId: orgId,
        leftSourceRecordId,
        rightSourceRecordId,
        matchType: "fuzzy",
        matchClass: "duplicate",
        disposition: "blocking",
        score: "85",
      })
      .returning();
    await db.insert(reviewFindings).values([
      {
        organizationId: orgId,
        inboxItemId: item.id,
        candidateId: candidate.id,
        ruleKey: "source_processing_failed",
        impact: "blocking",
        subjectType: "transaction_candidate",
        subjectId: candidate.id,
        fingerprint: `${candidate.id}:source-processing-failed`,
        message: "The source could not be processed.",
      },
      {
        organizationId: orgId,
        inboxItemId: item.id,
        candidateId: candidate.id,
        ruleKey: "possible_duplicate",
        impact: "blocking",
        subjectType: "transaction_candidate",
        subjectId: candidate.id,
        fingerprint: `${candidate.id}:possible_duplicate:${duplicateCase.id}`,
        message: "This may be a duplicate.",
        evidence: { caseId: duplicateCase.id },
      },
    ]);

    await withOrgContext(orgId, userId, "owner", (tx) =>
      rejectInboxItem(
        { db: tx, orgId, userId, role: "owner" },
        {
          inboxItemId: item.id,
          expectedLockVersion: item.lockVersion,
          reason: "This email is not an accounting transaction.",
        },
      ),
    );

    const [rejectedItem] = await db.select().from(inboxItems).where(eq(inboxItems.id, item.id));
    expect(rejectedItem.state).toBe("rejected");
    const [rejectedCandidate] = await db
      .select()
      .from(transactionCandidates)
      .where(eq(transactionCandidates.id, candidate.id));
    expect(rejectedCandidate.status).toBe("rejected");
    const [retiredSource] = await db
      .select()
      .from(sourceRecords)
      .where(eq(sourceRecords.id, rejectedSource.id));
    expect(retiredSource.recordState).toBe("rejected");
    const [resolvedCase] = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.id, duplicateCase.id));
    expect(resolvedCase).toMatchObject({
      state: "resolved",
      resolutionAction: "reject_source",
      resolvedBy: userId,
    });
    const findings = await db
      .select()
      .from(reviewFindings)
      .where(
        and(eq(reviewFindings.organizationId, orgId), eq(reviewFindings.inboxItemId, item.id)),
      );
    expect(findings.every(({ state }) => state === "resolved")).toBe(true);
    const [audit] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.organizationId, orgId),
          eq(workflowEvents.entityId, item.id),
          eq(workflowEvents.action, "rejected"),
        ),
      );
    expect(audit.data).toMatchObject({
      candidateId: candidate.id,
      rejectedSourceRecordIds: [rejectedSource.id],
      resolvedDuplicateCaseIds: [duplicateCase.id],
    });
  });
});
