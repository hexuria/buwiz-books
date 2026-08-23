import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { organization } from "@/db/schema/auth";
import { documents } from "@/db/schema/documents";
import {
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceMatchCandidates,
  sourceRecordDocuments,
  sourceRecords,
} from "@/db/schema/inbox";
import {
  loadDuplicateEngineConfig,
  runDuplicateMatchingForSource,
} from "@/lib/inbox/duplicate-engine";

/**
 * Audit PR-18 — duplicate engine discovery and versioning.
 *
 * Discovery filtered candidates on the RAW original_currency and
 * effective_date columns while the matcher normalizes both sides with
 * originalCurrency ?? currency and effectiveDate ?? transactionDate — so a
 * counterpart whose original_* columns were NULL was never even offered to
 * the matcher. And the scoring version used to absorb the config row's
 * edit counter, so ANY settings save invalidated every open finding.
 */
describe("duplicate engine discovery and version", () => {
  async function seedOrg(label: string) {
    const orgId = `${label}-${randomUUID()}`;
    await db.insert(organization).values({
      id: orgId,
      name: "Duplicate Engine Org",
      slug: `${label}-${randomUUID().slice(0, 8)}`,
    });
    return orgId;
  }

  function baseSource(orgId: string, externalId: string) {
    return {
      organizationId: orgId,
      recordType: "receipt",
      externalId,
      transactionDate: "2026-07-24",
      description: "Legacy import purchase",
      amount: "250.00",
      currency: "USD",
      economicEventClass: "purchase" as const,
      direction: "outflow" as const,
      normalizedParty: "acme supply",
      normalizedReference: "ref-9000",
    };
  }

  it("discovers a counterpart whose original_* and effective_date columns are NULL", async () => {
    const orgId = await seedOrg("dedup-null");
    const suffix = randomUUID();

    const [probe, legacy] = await db
      .insert(sourceRecords)
      .values([
        {
          ...baseSource(orgId, `probe-${suffix}`),
          originalAmount: "250.00",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
        // The legacy row carries ONLY the base columns — exactly the shape
        // the discovery predicate used to skip.
        baseSource(orgId, `legacy-${suffix}`),
      ])
      .returning();

    const result = await runDuplicateMatchingForSource(
      { db, orgId, userId: "system:pr18-test" },
      probe.id,
      "source_updated",
    );

    expect(result.evaluated).toBeGreaterThanOrEqual(1);
    const cases = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.organizationId, orgId));
    expect(cases).toHaveLength(1);
    expect(new Set([cases[0].leftSourceRecordId, cases[0].rightSourceRecordId])).toEqual(
      new Set([probe.id, legacy.id]),
    );
  });

  it("an unrelated config edit does not retune the scoring version", async () => {
    const orgId = await seedOrg("dedup-ver");
    const [definition] = await db
      .select({
        id: reviewRuleDefinitions.id,
        formulaVersion: reviewRuleDefinitions.formulaVersion,
      })
      .from(reviewRuleDefinitions)
      .where(eq(reviewRuleDefinitions.key, "possible_duplicate"))
      .limit(1);
    expect(definition).toBeDefined();

    // A config row whose edit counter is far ahead of any scoring version —
    // e.g. an admin fiddled with non-scoring settings seven times.
    await db.insert(reviewRuleConfigs).values({
      organizationId: orgId,
      definitionId: definition.id,
      impact: "blocking",
      config: { matchWindowDays: 5 },
      version: 7,
    });

    const config = await loadDuplicateEngineConfig(db, orgId);
    expect(config.matchWindowDays).toBe(5);
    // Scoring version stays the definition's formula version — NOT 7.
    expect(config.algorithmVersion).toBe(definition.formulaVersion);
  });

  it("shadow mode demotes even exact-document hits", async () => {
    const orgId = await seedOrg("dedup-shadow");
    const suffix = randomUUID();
    const [definition] = await db
      .select({ id: reviewRuleDefinitions.id })
      .from(reviewRuleDefinitions)
      .where(eq(reviewRuleDefinitions.key, "possible_duplicate"))
      .limit(1);
    await db.insert(reviewRuleConfigs).values({
      organizationId: orgId,
      definitionId: definition.id,
      impact: "blocking",
      config: { mode: "shadow" },
      version: 1,
    });

    const [probe, twin] = await db
      .insert(sourceRecords)
      .values([
        {
          ...baseSource(orgId, `probe-${suffix}`),
          originalAmount: "250.00",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
        {
          ...baseSource(orgId, `twin-${suffix}`),
          originalAmount: "250.00",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
      ])
      .returning();

    // Both sources link the SAME document (documents are content-deduped
    // per org) — the strongest signal, which used to block even in shadow
    // mode.
    const contentHash = `hash-${suffix}`;
    const [doc] = await db
      .insert(documents)
      .values({
        organizationId: orgId,
        originalFilename: "receipt.pdf",
        storagePath: `test/receipt-${suffix}.pdf`,
        contentHash,
      })
      .returning({ id: documents.id });
    await db.insert(sourceRecordDocuments).values([
      { organizationId: orgId, sourceRecordId: probe.id, documentId: doc.id },
      { organizationId: orgId, sourceRecordId: twin.id, documentId: doc.id },
    ]);

    const result = await runDuplicateMatchingForSource(
      { db, orgId, userId: "system:pr18-test" },
      probe.id,
      "document_attached",
    );

    expect(result.blockingCases).toHaveLength(0);
    expect(result.shadowCases.length).toBeGreaterThanOrEqual(1);
  });

  it("disabling the rule stales the open cases it left behind", async () => {
    const orgId = await seedOrg("dedup-off");
    const suffix = randomUUID();
    const [probe] = await db
      .insert(sourceRecords)
      .values([
        {
          ...baseSource(orgId, `probe-${suffix}`),
          originalAmount: "250.00",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
        {
          ...baseSource(orgId, `twin-${suffix}`),
          originalAmount: "250.00",
          originalCurrency: "USD",
          effectiveDate: "2026-07-24",
        },
      ])
      .returning();

    const first = await runDuplicateMatchingForSource(
      { db, orgId, userId: "system:pr18-test" },
      probe.id,
      "source_updated",
    );
    expect(first.blockingCases.length).toBeGreaterThanOrEqual(1);

    const [definition] = await db
      .select({ id: reviewRuleDefinitions.id })
      .from(reviewRuleDefinitions)
      .where(eq(reviewRuleDefinitions.key, "possible_duplicate"))
      .limit(1);
    await db.insert(reviewRuleConfigs).values({
      organizationId: orgId,
      definitionId: definition.id,
      enabled: false,
      impact: "blocking",
      version: 1,
    });

    const second = await runDuplicateMatchingForSource(
      { db, orgId, userId: "system:pr18-test" },
      probe.id,
      "source_updated",
    );
    expect(second.skipped).toBe(true);
    expect(second.staleCases.length).toBeGreaterThanOrEqual(1);

    const openLeft = await db
      .select()
      .from(sourceMatchCandidates)
      .where(
        and(
          eq(sourceMatchCandidates.organizationId, orgId),
          eq(sourceMatchCandidates.state, "open"),
        ),
      );
    expect(openLeft).toHaveLength(0);
  });
});
