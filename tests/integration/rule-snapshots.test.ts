/**
 * Rule snapshots (Inbox v2 spec §6, build step 8).
 *
 * Pins what a routine's papers are evaluated against: a pinned snapshot's
 * rules, not the live configs; an unpinned routine and manual entry exactly
 * as before; a shadow snapshot that is logged and never becomes a finding;
 * snapshots that cannot be edited, cannot be pinned across organizations, and
 * cannot be deleted while pinned; RLS; and the organization scorecard pile
 * read end to end through the CLI.
 */
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withOrgContext, type DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { aiEvalCases } from "@/db/schema/ai";
import { organization, user } from "@/db/schema/auth";
import {
  inboxItems,
  ingestionEvents,
  organizationAccountingSettings,
  processingJobs,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { routines } from "@/db/schema/routines";
import { ruleSnapshots } from "@/db/schema/rule-snapshots";
import { createAiComplete, type AiCompletionRuntime } from "@/lib/ai/facade-core";
import { classifyInboxCandidate } from "@/lib/inbox/candidate-classification";
import {
  correctInboxCandidate,
  enrichCandidateFromExtractedFacts,
} from "@/lib/inbox/candidate-correction";
import type { DocumentSourceFacts } from "@/lib/inbox/email-attachment-source";
import {
  buildLiveRuleSnapshotEntries,
  createRuleSnapshot,
  getRuleSnapshot,
  listRuleSnapshots,
  loadRuleFallbacks,
} from "@/lib/inbox/rule-snapshots";
import { runScorecard } from "@/lib/inbox/scorecard";
import { loadOrgScorecardPile } from "@/lib/inbox/scorecard-org-pile";
import { approveInboxItem, createTransactionCandidate } from "@/lib/inbox/service";
import { processRoutineWebhookJob } from "@/lib/jobs/handlers/routine-webhook";
import { defaultHmacWebhookConfig } from "@/lib/routines/config";
import { setRoutineRuleSnapshot } from "@/lib/routines/service";
import type { AiCompleteFn } from "@/lib/party-match/model-pick";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

interface Tenant {
  orgId: string;
  userId: string;
  approverId: string;
  bankId: string;
  expenseId: string;
  vendorId: string;
}

function asTenant<T>(tenant: Tenant, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return withOrgContext(tenant.orgId, tenant.userId, "owner", fn);
}

async function createTenant(label: string): Promise<Tenant> {
  const suffix = randomUUID();
  const orgId = `${label}-org-${suffix}`;
  const userId = `${label}-user-${suffix}`;
  const approverId = `${label}-approver-${suffix}`;
  await db.insert(user).values([
    { id: userId, name: "Rules Owner", email: `${suffix}@rules.test`, emailVerified: true },
    {
      id: approverId,
      name: "Rules Approver",
      email: `approver-${suffix}@rules.test`,
      emailVerified: true,
    },
  ]);
  await db.insert(organization).values({ id: orgId, name: "Rules Co", slug: `${label}-${suffix}` });
  await db.insert(organizationAccountingSettings).values({ organizationId: orgId });
  const [bank, expense] = await db
    .insert(accounts)
    .values([
      {
        organizationId: orgId,
        accountNumber: "10991",
        name: "Rules Test Bank",
        accountType: "asset",
        subtype: "bank_accounts",
      },
      {
        organizationId: orgId,
        accountNumber: "61991",
        name: "Rules Test Office Supplies",
        accountType: "expense",
        subtype: "office_supplies",
      },
    ])
    .returning();
  const [vendor] = await db
    .insert(parties)
    .values({ organizationId: orgId, name: "Rules Test Vendor", partyType: "vendor" })
    .returning();
  const tenant = {
    orgId,
    userId,
    approverId,
    bankId: bank.id,
    expenseId: expense.id,
    vendorId: vendor.id,
  };
  // This organization does not track departments or locations, so those two
  // rules are off; everything else keeps the catalog default until a test
  // says otherwise.
  await setLiveRule(tenant, "missing_department", { enabled: false });
  await setLiveRule(tenant, "missing_location", { enabled: false });
  return tenant;
}

async function setLiveRule(
  tenant: Tenant,
  key: string,
  values: { enabled?: boolean; impact?: "blocking" | "warning"; config?: Record<string, unknown> },
) {
  const [definition] = await db
    .select()
    .from(reviewRuleDefinitions)
    .where(eq(reviewRuleDefinitions.key, key));
  if (!definition) throw new Error(`Review rule ${key} is not seeded.`);
  await db
    .insert(reviewRuleConfigs)
    .values({
      organizationId: tenant.orgId,
      definitionId: definition.id,
      enabled: values.enabled ?? true,
      impact: values.impact ?? (definition.group === "review" ? "warning" : "blocking"),
      config: values.config ?? {},
    })
    .onConflictDoUpdate({
      target: [reviewRuleConfigs.organizationId, reviewRuleConfigs.definitionId],
      set: {
        ...(values.enabled !== undefined ? { enabled: values.enabled } : {}),
        ...(values.impact !== undefined ? { impact: values.impact } : {}),
        ...(values.config !== undefined ? { config: values.config } : {}),
        version: drizzleSql`${reviewRuleConfigs.version} + 1`,
      },
    });
}

/**
 * An enabled webhook routine, inserted directly: the chart-of-accounts gate on
 * enabling is covered by the routines suite and is not what these tests pin.
 */
async function webhookRoutine(tenant: Tenant, name = "Receipts webhook") {
  const [routine] = await db
    .insert(routines)
    .values({
      organizationId: tenant.orgId,
      name,
      enabled: true,
      triggerKind: "webhook",
      triggerConfig: { ...defaultHmacWebhookConfig() },
      createdBy: tenant.userId,
    })
    .returning();
  return routine;
}

/** A paper arriving through a routine: its ingestion event and the real job handler. */
async function paperThroughRoutine(tenant: Tenant, routineId: string) {
  const [event] = await db
    .insert(ingestionEvents)
    .values({
      organizationId: tenant.orgId,
      routineId,
      channel: "webhook",
      provider: `routine:${routineId}`,
      providerEventId: `evt-${randomUUID()}`,
      payload: { vendor: "Rules Test Vendor", total: "50.00" },
    })
    .returning();
  const workerId = `rule-snapshots-${randomUUID()}`;
  const [job] = await db
    .insert(processingJobs)
    .values({
      organizationId: tenant.orgId,
      routineId,
      ingestionEventId: event.id,
      jobType: "routine_webhook",
      status: "running",
      lockedBy: workerId,
      lockedUntil: new Date(Date.now() + 60_000),
    })
    .returning();
  const handled = await processRoutineWebhookJob(job, { workerId });
  expect(handled).toMatchObject({ processed: true, deduplicated: false });
  return handled.inboxItemId as string;
}

async function currentItem(itemId: string) {
  const [item] = await db.select().from(inboxItems).where(eq(inboxItems.id, itemId));
  return item;
}

/** The reviewer enters a USD expense paid from the bank, with the vendor. */
async function correct(tenant: Tenant, itemId: string, amount = "50.00") {
  const item = await currentItem(itemId);
  return asTenant(tenant, (tx) =>
    correctInboxCandidate(
      { db: tx, orgId: tenant.orgId, userId: tenant.userId, role: "owner" },
      {
        inboxItemId: itemId,
        expectedRevision: item.candidateRevision,
        expectedLockVersion: item.lockVersion,
        transactionDate: "2026-09-14",
        transactionType: "pay_out",
        partyId: tenant.vendorId,
        originalCurrency: "USD",
        lines: [
          { accountId: tenant.expenseId, debit: amount },
          { accountId: tenant.bankId, credit: amount },
        ],
      },
    ),
  );
}

async function openFindings(itemId: string) {
  return db
    .select()
    .from(reviewFindings)
    .where(and(eq(reviewFindings.inboxItemId, itemId), eq(reviewFindings.state, "open")));
}

async function snapshotNow(tenant: Tenant, label: string) {
  return asTenant(tenant, (tx) =>
    createRuleSnapshot(tx, { orgId: tenant.orgId, actorId: tenant.userId, label }),
  );
}

async function pin(
  tenant: Tenant,
  routineId: string,
  snapshotId: string | null,
  slot: "active" | "shadow" = "active",
) {
  return asTenant(tenant, (tx) =>
    setRoutineRuleSnapshot(tx, {
      orgId: tenant.orgId,
      actorId: tenant.userId,
      routineId,
      slot,
      snapshotId,
    }),
  );
}

/**
 * A routine paper the way an emailed receipt reaches stage 2: its source is a
 * purchase, extraction enriched it into the two unselected placeholder lines,
 * and the classification job is due for the new revision.
 */
async function enrichedPaperThroughRoutine(tenant: Tenant, routineId: string) {
  const itemId = await paperThroughRoutine(tenant, routineId);
  const item = await currentItem(itemId);
  const [candidate] = await db
    .select()
    .from(transactionCandidates)
    .where(eq(transactionCandidates.id, item.candidateId!));
  await db
    .update(sourceRecords)
    .set({ economicEventClass: "purchase", direction: "outflow" })
    .where(eq(sourceRecords.id, candidate.sourceRecordId!));
  const facts: DocumentSourceFacts = {
    externalId: `receipt-${randomUUID()}`,
    externalVersion: "1",
    transactionDate: "2026-09-14",
    description: "Printer paper and toner",
    amount: "50.00",
    currency: "USD",
    economicEventClass: "purchase",
    direction: "outflow",
    originalAmount: "50.00",
    originalCurrency: "USD",
    functionalAmount: "50.00",
    functionalCurrency: "USD",
    effectiveDate: "2026-09-14",
    normalizedParty: null,
    normalizedReference: null,
    sourceAccountRef: null,
    matcherInputHash: "a".repeat(64),
    matcherVersion: 1,
    extractedFrom: ["rule-snapshots-test"],
  };
  const enriched = await withOrgContext(tenant.orgId, "system", "admin", (tx) =>
    enrichCandidateFromExtractedFacts({ db: tx, orgId: tenant.orgId }, candidate.id, [facts]),
  );
  expect(enriched).toMatchObject({ enriched: true });
  return {
    itemId,
    candidateId: candidate.id,
    revision: (enriched as { revision: number }).revision,
  };
}

/** The real façade over a canned runtime: the model always picks `code` at `confidence`. */
function categorizeWith(code: string, confidence: number): AiCompleteFn {
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
            {
              lineIndex: 0,
              accountCode: code,
              confidence,
              reason: "stub",
              suggestedNewCategory: "",
            },
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

/** Drizzle wraps a trigger's refusal as "Failed query"; the message is in the cause chain. */
async function expectDatabaseRefusal(promise: Promise<unknown>, pattern: RegExp) {
  let refused = false;
  try {
    await promise;
  } catch (error) {
    refused = true;
    const seen: string[] = [];
    let current: unknown = error;
    while (current instanceof Error) {
      seen.push(current.message);
      current = current.cause;
    }
    expect(seen.join(" | ")).toMatch(pattern);
  }
  expect(refused, `expected the database to refuse with ${pattern}`).toBe(true);
}

describeDb("rule snapshots", () => {
  describe("creating a snapshot", () => {
    it("freezes the live configuration, fallbacks included, and never changes after", async () => {
      const tenant = await createTenant("snap-create");
      await setLiveRule(tenant, "missing_receipt", { config: { threshold: 10, currency: "USD" } });

      const created = await snapshotNow(tenant, "Receipts over 10");
      const byKey = new Map(created.snapshot.map((entry) => [entry.ruleKey, entry]));
      // Every configurable rule, and no system rule.
      expect(byKey.has("uncategorized")).toBe(true);
      expect(byKey.has("possible_duplicate")).toBe(true);
      expect(byKey.has("material_expense")).toBe(true);
      expect(byKey.has("source_processing_failed")).toBe(false);
      expect(byKey.get("missing_receipt")).toMatchObject({
        enabled: true,
        impact: "blocking",
        config: { threshold: 10, currency: "USD" },
      });
      expect(byKey.get("missing_department")).toMatchObject({ enabled: false });
      // No saved low-confidence config: the accounting-settings threshold is baked in.
      expect(byKey.get("low_confidence_category")?.config).toEqual({ threshold: "0.8000" });
      expect(byKey.get("possible_duplicate")?.formulaVersion).toBe(2);

      await setLiveRule(tenant, "missing_receipt", {
        config: { threshold: 1000, currency: "USD" },
      });
      const reread = await asTenant(tenant, (tx) => getRuleSnapshot(tx, tenant.orgId, created.id));
      expect(reread.snapshot).toEqual(created.snapshot);
      expect(reread.label).toBe("Receipts over 10");

      const listed = await asTenant(tenant, (tx) => listRuleSnapshots(tx, tenant.orgId));
      expect(listed).toMatchObject([
        { id: created.id, label: "Receipts over 10", ruleCount: created.snapshot.length },
      ]);
    });

    it("rejects every update at the database, whatever the column", async () => {
      const tenant = await createTenant("snap-immutable");
      const created = await snapshotNow(tenant, "Frozen");
      await expectDatabaseRefusal(
        db.update(ruleSnapshots).set({ label: "Edited" }).where(eq(ruleSnapshots.id, created.id)),
        /rule snapshot .* is immutable/,
      );
      await expectDatabaseRefusal(
        asTenant(tenant, (tx) =>
          tx
            .update(ruleSnapshots)
            .set({ snapshot: [] })
            .where(
              and(eq(ruleSnapshots.organizationId, tenant.orgId), eq(ruleSnapshots.id, created.id)),
            ),
        ),
        /rule snapshot .* is immutable/,
      );
      const [row] = await db.select().from(ruleSnapshots).where(eq(ruleSnapshots.id, created.id));
      expect(row.label).toBe("Frozen");
      expect(row.snapshot).toHaveLength(created.snapshot.length);
    });
  });

  describe("evaluating a routine's papers", () => {
    it("evaluates a pinned routine against its snapshot, not the live configs", async () => {
      const tenant = await createTenant("snap-pinned");
      await setLiveRule(tenant, "missing_receipt", { config: { threshold: 10, currency: "USD" } });
      const strict = await snapshotNow(tenant, "Receipts over 10");
      // Live now tolerates receipts up to 1000; the snapshot still says 10.
      await setLiveRule(tenant, "missing_receipt", {
        config: { threshold: 1000, currency: "USD" },
      });
      const routine = await webhookRoutine(tenant);
      const pinned = await pin(tenant, routine.id, strict.id);
      expect(pinned.ruleSnapshotId).toBe(strict.id);

      const itemId = await paperThroughRoutine(tenant, routine.id);
      await correct(tenant, itemId);
      const findings = await openFindings(itemId);
      expect(findings.map((finding) => finding.ruleKey)).toEqual(["missing_receipt"]);
      expect(findings[0].message).toBe("Attach a receipt for expenses over USD 10.");
      expect(findings[0].evidence.ruleSet).toEqual({
        source: "snapshot",
        snapshotId: strict.id,
        routineId: routine.id,
      });
      const item = await currentItem(itemId);
      const [corrected] = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.organizationId, tenant.orgId),
            eq(workflowEvents.entityId, item.candidateId!),
            eq(workflowEvents.action, "candidate_corrected"),
          ),
        );
      expect(corrected.data.ruleSet).toEqual({
        source: "snapshot",
        snapshotId: strict.id,
        routineId: routine.id,
      });

      // Unpinned, the same routine's next evaluation is live again.
      await pin(tenant, routine.id, null);
      await correct(tenant, itemId);
      const liveFindings = await openFindings(itemId);
      expect(liveFindings).toEqual([]);
      const events = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.entityId, item.candidateId!),
            eq(workflowEvents.action, "candidate_corrected"),
          ),
        );
      expect(events.map((event) => event.data.ruleSet)).toContainEqual({
        source: "live",
        snapshotId: null,
        routineId: routine.id,
      });
    });

    it("evaluates a snapshot of the live configuration exactly like live", async () => {
      const tenant = await createTenant("snap-equivalent");
      const routine = await webhookRoutine(tenant);

      // No saved missing_receipt config: live falls back to the settings row.
      const liveItem = await paperThroughRoutine(tenant, routine.id);
      await correct(tenant, liveItem, "180.00");
      const live = await openFindings(liveItem);

      const copy = await snapshotNow(tenant, "Copy of live");
      await pin(tenant, routine.id, copy.id);
      const pinnedItem = await paperThroughRoutine(tenant, routine.id);
      // A different amount, so the two papers are not each other's duplicate;
      // the receipt message does not depend on the amount.
      await correct(tenant, pinnedItem, "190.00");
      const pinned = await openFindings(pinnedItem);

      const shape = (rows: typeof live) =>
        rows
          .map(({ ruleKey, impact, message }) => ({ ruleKey, impact, message }))
          .sort((left, right) => left.ruleKey.localeCompare(right.ruleKey));
      expect(shape(live)).toEqual([
        {
          ruleKey: "missing_receipt",
          impact: "blocking",
          message: "Attach a receipt for expenses over USD 75.00000000.",
        },
      ]);
      expect(shape(pinned)).toEqual(shape(live));
      expect(live[0].evidence.ruleSet).toMatchObject({ source: "live" });
      expect(pinned[0].evidence.ruleSet).toMatchObject({ source: "snapshot", snapshotId: copy.id });
    });

    it("classifies a pinned routine's paper with the snapshot's threshold and rules", async () => {
      const tenant = await createTenant("snap-classify");
      await setLiveRule(tenant, "low_confidence_category", { config: { threshold: 0.95 } });
      const strict = await snapshotNow(tenant, "Picks need 0.95");
      await setLiveRule(tenant, "low_confidence_category", { config: { threshold: 0.5 } });
      const pinnedRoutine = await webhookRoutine(tenant, "Pinned receipts");
      const liveRoutine = await webhookRoutine(tenant, "Live receipts");
      await pin(tenant, pinnedRoutine.id, strict.id);
      // The model is 0.85 sure of the one expense account on the list.
      const complete = categorizeWith("61991", 0.85);

      const pinnedPaper = await enrichedPaperThroughRoutine(tenant, pinnedRoutine.id);
      const pinned = await classifyInboxCandidate(
        {
          orgId: tenant.orgId,
          candidateId: pinnedPaper.candidateId,
          candidateRevision: pinnedPaper.revision,
        },
        { complete },
      );
      expect(pinned.status).toBe("classified");
      const [pinnedLine] = await db
        .select()
        .from(transactionCandidateLines)
        .where(eq(transactionCandidateLines.candidateId, pinnedPaper.candidateId))
        .orderBy(transactionCandidateLines.sortOrder);
      // 0.85 is below the pinned 0.95: the pick is only a hint.
      expect(pinnedLine.accountId).toBeNull();
      expect(pinnedLine.predictionEvidence).toMatchObject({
        outcome: "low_confidence",
        threshold: 0.95,
      });
      const pinnedFindings = await openFindings(pinnedPaper.itemId);
      expect(pinnedFindings.map((finding) => finding.ruleKey)).toEqual(["uncategorized"]);
      expect(pinnedFindings[0].evidence).toMatchObject({
        lineIndexes: [0, 1],
        ruleSet: { source: "snapshot", snapshotId: strict.id, routineId: pinnedRoutine.id },
      });
      const [classified] = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.entityId, pinnedPaper.candidateId),
            eq(workflowEvents.action, "candidate_classified"),
          ),
        );
      expect(classified.data.ruleSet).toEqual({
        source: "snapshot",
        snapshotId: strict.id,
        routineId: pinnedRoutine.id,
      });

      // The same paper through the unpinned routine: live 0.5 applies the pick.
      const livePaper = await enrichedPaperThroughRoutine(tenant, liveRoutine.id);
      await classifyInboxCandidate(
        {
          orgId: tenant.orgId,
          candidateId: livePaper.candidateId,
          candidateRevision: livePaper.revision,
        },
        { complete },
      );
      const [liveLine] = await db
        .select()
        .from(transactionCandidateLines)
        .where(eq(transactionCandidateLines.candidateId, livePaper.candidateId))
        .orderBy(transactionCandidateLines.sortOrder);
      expect(liveLine).toMatchObject({ accountId: tenant.expenseId, categoryConfidence: "0.8500" });
      expect(liveLine.predictionEvidence).toMatchObject({ outcome: "picked", threshold: 0.5 });
      // Now an expense line exists, and the paper named no vendor.
      const liveFindings = await openFindings(livePaper.itemId);
      expect(liveFindings.map((finding) => finding.ruleKey).sort()).toEqual([
        "missing_vendor",
        "uncategorized",
      ]);
      for (const finding of liveFindings) {
        expect(finding.evidence.ruleSet).toEqual({
          source: "live",
          snapshotId: null,
          routineId: liveRoutine.id,
        });
      }
      expect(
        liveFindings.find((finding) => finding.ruleKey === "uncategorized")?.evidence,
      ).toMatchObject({ lineIndexes: [1] });
    });

    it("leaves manual entry on live configs and records that it did", async () => {
      const tenant = await createTenant("snap-manual");
      await setLiveRule(tenant, "missing_receipt", { config: { threshold: 10, currency: "USD" } });
      const strict = await snapshotNow(tenant, "Receipts over 10");
      await setLiveRule(tenant, "missing_receipt", {
        config: { threshold: 1000, currency: "USD" },
      });
      // A pinned routine elsewhere in the org changes nothing for manual entry.
      const routine = await webhookRoutine(tenant);
      await pin(tenant, routine.id, strict.id);

      const created = await asTenant(tenant, (tx) =>
        createTransactionCandidate(
          { db: tx, orgId: tenant.orgId, userId: tenant.userId, role: "owner" },
          {
            transactionDate: "2026-09-14",
            transactionType: "pay_out",
            partyId: tenant.vendorId,
            originalCurrency: "USD",
            lines: [
              { accountId: tenant.expenseId, debit: "50.00", categoryConfidence: "0.4000" },
              { accountId: tenant.bankId, credit: "50.00" },
            ],
          },
        ),
      );
      const findings = await openFindings(created.inboxItem.id);
      expect(findings.map((finding) => finding.ruleKey)).toEqual(["low_confidence_category"]);
      expect(findings[0].evidence).toMatchObject({
        lineIndexes: [0],
        ruleSet: { source: "live", snapshotId: null, routineId: null },
      });
      const [submitted] = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.inboxItemId, created.inboxItem.id),
            eq(workflowEvents.action, "submitted"),
          ),
        );
      expect(submitted.data).toMatchObject({
        findingCount: 1,
        ruleSet: { source: "live", snapshotId: null, routineId: null },
      });
    });
  });

  describe("shadow snapshots", () => {
    it("logs shadow findings as a workflow event and never as a finding", async () => {
      const tenant = await createTenant("snap-shadow");
      await setLiveRule(tenant, "missing_receipt", { config: { threshold: 10, currency: "USD" } });
      const candidateRules = await snapshotNow(tenant, "Receipts over 10");
      await setLiveRule(tenant, "missing_receipt", {
        config: { threshold: 1000, currency: "USD" },
      });
      const routine = await webhookRoutine(tenant);
      const shadowed = await pin(tenant, routine.id, candidateRules.id, "shadow");
      expect(shadowed).toMatchObject({
        ruleSnapshotId: null,
        shadowRuleSnapshotId: candidateRules.id,
      });

      const itemId = await paperThroughRoutine(tenant, routine.id);
      await correct(tenant, itemId);
      const item = await currentItem(itemId);

      const allFindings = await db
        .select()
        .from(reviewFindings)
        .where(eq(reviewFindings.inboxItemId, itemId));
      expect(allFindings.some((finding) => finding.ruleKey === "missing_receipt")).toBe(false);
      expect(await openFindings(itemId)).toEqual([]);

      const [shadowEvent] = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.organizationId, tenant.orgId),
            eq(workflowEvents.entityId, item.candidateId!),
            eq(workflowEvents.action, "rule_shadow_evaluated"),
          ),
        );
      expect(shadowEvent).toMatchObject({
        inboxItemId: itemId,
        entityType: "transaction_candidate",
        actorType: "system",
      });
      expect(shadowEvent.data).toMatchObject({
        routineId: routine.id,
        candidateRevision: item.candidateRevision,
        shadowSnapshotId: candidateRules.id,
        enforced: { source: "live", snapshotId: null, findings: [] },
        shadowFindings: [
          {
            ruleKey: "missing_receipt",
            impact: "blocking",
            evidence: { ruleSet: { source: "snapshot", snapshotId: candidateRules.id } },
          },
        ],
        diff: { onlyInShadow: ["missing_receipt"], onlyEnforced: [], impactChanged: [] },
      });

      // The shadow's blocking opinion does not hold the paper back.
      const approved = await withOrgContext(tenant.orgId, tenant.approverId, "owner", (tx) =>
        approveInboxItem(
          { db: tx, orgId: tenant.orgId, userId: tenant.approverId, role: "owner" },
          {
            inboxItemId: itemId,
            expectedRevision: item.candidateRevision,
            expectedLockVersion: item.lockVersion,
          },
        ),
      );
      expect(approved.approvalOutcome).toBe("approved");
      const after = await db
        .select()
        .from(reviewFindings)
        .where(eq(reviewFindings.inboxItemId, itemId));
      expect(after.some((finding) => finding.ruleKey === "missing_receipt")).toBe(false);
    });
  });

  describe("pinning", () => {
    it("promotes a shadow by repinning and refuses to shadow the active snapshot", async () => {
      const tenant = await createTenant("snap-promote");
      const first = await snapshotNow(tenant, "First");
      const second = await snapshotNow(tenant, "Second");
      const routine = await webhookRoutine(tenant);

      await pin(tenant, routine.id, first.id);
      await pin(tenant, routine.id, second.id, "shadow");
      await expect(pin(tenant, routine.id, first.id, "shadow")).rejects.toThrow(
        /compare it with itself/,
      );
      const promoted = await pin(tenant, routine.id, second.id);
      expect(promoted).toMatchObject({ ruleSnapshotId: second.id, shadowRuleSnapshotId: null });

      // The older snapshot stays for rollback.
      const listed = await asTenant(tenant, (tx) => listRuleSnapshots(tx, tenant.orgId));
      expect(listed.map((snapshot) => snapshot.id).sort()).toEqual([first.id, second.id].sort());
      expect(listed.find((snapshot) => snapshot.id === second.id)?.pinnedBy).toEqual([
        { routineId: routine.id, routineName: routine.name, slot: "active" },
      ]);
      const rolledBack = await pin(tenant, routine.id, first.id);
      expect(rolledBack.ruleSnapshotId).toBe(first.id);
    });

    it("never pins another organization's snapshot", async () => {
      const owner = await createTenant("snap-owner");
      const intruder = await createTenant("snap-intruder");
      const foreign = await snapshotNow(owner, "Owner's rules");
      const routine = await webhookRoutine(intruder);

      await expect(pin(intruder, routine.id, foreign.id)).rejects.toThrow(
        "Rule snapshot not found.",
      );
      await expect(pin(intruder, routine.id, foreign.id, "shadow")).rejects.toThrow(
        "Rule snapshot not found.",
      );
      await expect(
        asTenant(intruder, (tx) => getRuleSnapshot(tx, intruder.orgId, foreign.id)),
      ).rejects.toThrow("Rule snapshot not found.");
      const [unchanged] = await db.select().from(routines).where(eq(routines.id, routine.id));
      expect(unchanged.ruleSnapshotId).toBeNull();
    });

    it("keeps a pinned snapshot from being deleted", async () => {
      const tenant = await createTenant("snap-restrict");
      const created = await snapshotNow(tenant, "Pinned");
      const routine = await webhookRoutine(tenant);
      await pin(tenant, routine.id, created.id);
      await expect(
        db.delete(ruleSnapshots).where(eq(ruleSnapshots.id, created.id)),
      ).rejects.toThrow();
      const rows = await db.select().from(ruleSnapshots).where(eq(ruleSnapshots.id, created.id));
      expect(rows).toHaveLength(1);
    });
  });

  describe("organization scorecard pile", () => {
    it("replays decided papers with their recorded outcomes and labels, read-only", async () => {
      const tenant = await createTenant("snap-pile");
      await setLiveRule(tenant, "missing_receipt", { config: { threshold: 10, currency: "USD" } });

      // An emailed-style paper: entered by a reviewer (one edit), then approved.
      const routine = await webhookRoutine(tenant);
      const routineItem = await paperThroughRoutine(tenant, routine.id);
      await correct(tenant, routineItem, "8.00");
      const corrected = await currentItem(routineItem);
      const routineApproval = await withOrgContext(tenant.orgId, tenant.approverId, "owner", (tx) =>
        approveInboxItem(
          { db: tx, orgId: tenant.orgId, userId: tenant.approverId, role: "owner" },
          {
            inboxItemId: routineItem,
            expectedRevision: corrected.candidateRevision,
            expectedLockVersion: corrected.lockVersion,
          },
        ),
      );
      expect(routineApproval.approvalOutcome).toBe("approved");

      // A manual paper approved exactly as submitted.
      const manual = await asTenant(tenant, (tx) =>
        createTransactionCandidate(
          { db: tx, orgId: tenant.orgId, userId: tenant.userId, role: "owner" },
          {
            transactionDate: "2026-09-15",
            transactionType: "pay_out",
            partyId: tenant.vendorId,
            originalCurrency: "USD",
            lines: [
              { accountId: tenant.expenseId, debit: "6.00" },
              { accountId: tenant.bankId, credit: "6.00" },
            ],
          },
        ),
      );
      const manualApproval = await withOrgContext(tenant.orgId, tenant.approverId, "owner", (tx) =>
        approveInboxItem(
          { db: tx, orgId: tenant.orgId, userId: tenant.approverId, role: "owner" },
          {
            inboxItemId: manual.inboxItem.id,
            expectedRevision: manual.inboxItem.candidateRevision,
            expectedLockVersion: manual.inboxItem.lockVersion,
          },
        ),
      );
      expect(manualApproval.approvalOutcome).toBe("approved");
      await db.insert(aiEvalCases).values({
        organizationId: tenant.orgId,
        task: "inbox_rules",
        inputRef: { candidateId: manual.candidate.id },
        expected: { problems: [], blocked: false, locked: true },
        provenance: "authored",
      });

      const loaded = await withOrgContext(tenant.orgId, "system", "admin", async (tx) => {
        // Proves the loader only reads: any write here would fail.
        await tx.execute(drizzleSql`SET TRANSACTION READ ONLY`);
        return {
          pile: await loadOrgScorecardPile(tx, tenant.orgId),
          entries: await buildLiveRuleSnapshotEntries(tx, tenant.orgId),
          fallbacks: await loadRuleFallbacks(tx, tenant.orgId),
        };
      });
      expect(loaded.pile.skipped).toBe(0);
      const byId = new Map(loaded.pile.cases.map((item) => [item.id, item]));
      const routineCase = byId.get(`candidate:${corrected.candidateId}`)!;
      const manualCase = byId.get(`candidate:${manual.candidate.id}`)!;
      expect(routineCase).toMatchObject({
        outcome: { decision: "approved", edits: 1 },
        expected: null,
        locked: false,
      });
      expect(routineCase.lines).toEqual([
        expect.objectContaining({ accountId: tenant.expenseId, debit: "8.00000000" }),
        expect.objectContaining({ accountId: tenant.bankId, credit: "8.00000000" }),
      ]);
      expect(manualCase).toMatchObject({
        outcome: { decision: "approved", edits: 0 },
        expected: { problems: [], blocked: false },
        locked: true,
        party: { id: tenant.vendorId, partyType: "vendor" },
      });

      const { report } = runScorecard({
        cases: loaded.pile.cases,
        entries: loaded.entries,
        fallbacks: loaded.fallbacks,
        pile: `org:${tenant.orgId}`,
        rules: "live",
        chain: "recorded",
      });
      expect(report).toMatchObject({
        cases: 2,
        labeled_cases: 1,
        real_problems_total: 0,
        false_alarms: 0,
        approved_zero_edits: 1,
        locked_cases_total: 1,
        locked_cases_passing: 1,
        memory_hit_rate: null,
        cost_per_100: null,
      });

      // The same pile through the command, reading the database in org context.
      const cli = spawnSync(
        "bun",
        ["run", "scripts/eval-scorecard.ts", "--pile", `org:${tenant.orgId}`, "--json"],
        {
          cwd: resolve(__dirname, "../.."),
          encoding: "utf8",
          env: { ...process.env, DATABASE_URL: process.env.TEST_DATABASE_URL },
          timeout: 60_000,
        },
      );
      expect(cli.status, cli.stderr).toBe(0);
      expect(JSON.parse(cli.stdout)).toMatchObject({
        pile: `org:${tenant.orgId}`,
        cases: 2,
        approved_zero_edits: 1,
        locked_cases_passing: 1,
      });
      expect(cli.stderr).toContain(`organization ${tenant.orgId}`);
      // Spawning bun is the slow part; keep a loaded CI runner from timing it out.
    }, 90_000);
  });
});

describeDb("rule snapshots RLS isolation", () => {
  let sqlClient: postgres.Sql;
  let rlsDb: any;

  beforeAll(async () => {
    ({ db: rlsDb, sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  /** Mirrors withOrgContext, as the non-owner runtime role RLS applies to. */
  async function asRuntimeRole<T>(orgId: string, fn: (tx: any) => Promise<T>): Promise<T> {
    return rlsDb.transaction(async (tx: any) => {
      await tx.execute(drizzleSql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        drizzleSql`SELECT set_config('app.current_organization_id', ${orgId}, true)`,
      );
      return fn(tx);
    });
  }

  it("keeps each organization's snapshots invisible and unwritable to the other", async () => {
    const [orgA, orgB] = [`rls-snap-a-${randomUUID()}`, `rls-snap-b-${randomUUID()}`];
    for (const id of [orgA, orgB]) {
      await db.insert(organization).values({ id, name: "RLS Rules Co", slug: id });
    }
    const [snapshotA] = await db
      .insert(ruleSnapshots)
      .values({ organizationId: orgA, label: "A", snapshot: [] })
      .returning();
    const [snapshotB] = await db
      .insert(ruleSnapshots)
      .values({ organizationId: orgB, label: "B", snapshot: [] })
      .returning();
    const both = [snapshotA.id, snapshotB.id];

    const visibleToA = await asRuntimeRole(orgA, (tx) =>
      tx
        .select({ id: ruleSnapshots.id })
        .from(ruleSnapshots)
        .where(inArray(ruleSnapshots.id, both)),
    );
    expect(visibleToA).toEqual([{ id: snapshotA.id }]);

    // Deleting B's snapshot from A's context touches nothing.
    const deleted = await asRuntimeRole(orgA, (tx) =>
      tx
        .delete(ruleSnapshots)
        .where(eq(ruleSnapshots.id, snapshotB.id))
        .returning({ id: ruleSnapshots.id }),
    );
    expect(deleted).toHaveLength(0);
    expect(
      await db.select().from(ruleSnapshots).where(eq(ruleSnapshots.id, snapshotB.id)),
    ).toHaveLength(1);

    // And A's context cannot write a snapshot into B's books.
    await expect(
      asRuntimeRole(orgA, (tx) =>
        tx.insert(ruleSnapshots).values({ organizationId: orgB, label: "Planted", snapshot: [] }),
      ),
    ).rejects.toThrow();
  });
});
