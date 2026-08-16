import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { organization } from "@/db/schema/auth";
import { documents } from "@/db/schema/documents";
import {
  sourceMatchCandidates,
  sourceRecordDocuments,
  sourceRecords,
  sourceRecordVersions,
  transactionCandidates,
  transactionCandidateSources,
  ledgerSourceLinks,
} from "@/db/schema/inbox";
import { journalHeaders } from "@/db/schema/journals";
import { journalDuplicateMerges } from "@/db/schema/match-history";
import { createTestDb } from "../utils/db-utils";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

const EXPECTED_TENANT_FOREIGN_KEYS = [
  "source_records_org_parent_source_fk",
  "source_record_versions_org_source_fk",
  "source_record_documents_org_source_fk",
  "source_record_documents_org_document_fk",
  "transaction_candidates_org_source_fk",
  "transaction_candidate_sources_org_candidate_fk",
  "transaction_candidate_sources_org_source_fk",
  "source_match_candidates_org_left_source_fk",
  "source_match_candidates_org_right_source_fk",
  "source_match_candidates_org_canonical_candidate_fk",
  "source_match_candidates_org_canonical_journal_fk",
  "ledger_source_links_org_journal_fk",
  "ledger_source_links_org_source_fk",
  "journal_headers_org_duplicate_of_fk",
  "journal_duplicate_merges_org_canonical_fk",
  "journal_duplicate_merges_org_duplicate_fk",
  "journal_duplicate_merges_org_case_fk",
] as const;

describeDb("tenant-consistent transaction lineage", () => {
  let db: any;
  let sqlClient: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
    const migration = await readFile(
      resolve(process.cwd(), "drizzle/0024_tenant_lineage_integrity.sql"),
      "utf8",
    );

    // Applying twice is part of the migration contract: manual deploy retries must be safe.
    await sqlClient.unsafe(migration);
    await sqlClient.unsafe(migration);
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  async function createFixture(prefix: string) {
    const suffix = randomUUID();
    const orgA = `${prefix}-a-${suffix}`;
    const orgB = `${prefix}-b-${suffix}`;
    await db.insert(organization).values([
      { id: orgA, name: "Tenant A", slug: `${prefix}-a-${suffix}` },
      { id: orgB, name: "Tenant B", slug: `${prefix}-b-${suffix}` },
    ]);

    const [sourceA1, sourceA2] = await db
      .insert(sourceRecords)
      .values([
        {
          organizationId: orgA,
          recordType: "document_upload",
          externalId: `a-1-${suffix}`,
        },
        {
          organizationId: orgA,
          recordType: "bank_transaction",
          externalId: `a-2-${suffix}`,
        },
      ])
      .returning();
    const [sourceB1, sourceB2] = await db
      .insert(sourceRecords)
      .values([
        {
          organizationId: orgB,
          recordType: "document_upload",
          externalId: `b-1-${suffix}`,
        },
        {
          organizationId: orgB,
          recordType: "bank_transaction",
          externalId: `b-2-${suffix}`,
        },
      ])
      .returning();

    const [documentA, documentB] = await db
      .insert(documents)
      .values([
        {
          organizationId: orgA,
          originalFilename: "tenant-a.pdf",
          storagePath: `${orgA}/tenant-a.pdf`,
        },
        {
          organizationId: orgB,
          originalFilename: "tenant-b.pdf",
          storagePath: `${orgB}/tenant-b.pdf`,
        },
      ])
      .returning();

    const [candidateA] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: orgA,
        sourceRecordId: sourceA1.id,
        transactionDate: "2026-07-24",
        transactionType: "journal",
        originalCurrency: "USD",
        functionalCurrency: "USD",
      })
      .returning();
    const [candidateB] = await db
      .insert(transactionCandidates)
      .values({
        organizationId: orgB,
        sourceRecordId: sourceB1.id,
        transactionDate: "2026-07-24",
        transactionType: "journal",
        originalCurrency: "USD",
        functionalCurrency: "USD",
      })
      .returning();

    const [journalA1, journalA2] = await db
      .insert(journalHeaders)
      .values([
        {
          organizationId: orgA,
          transactionDate: "2026-07-24",
          transactionType: "journal",
        },
        {
          organizationId: orgA,
          transactionDate: "2026-07-24",
          transactionType: "journal",
        },
      ])
      .returning();
    const [journalB1, journalB2] = await db
      .insert(journalHeaders)
      .values([
        {
          organizationId: orgB,
          transactionDate: "2026-07-24",
          transactionType: "journal",
        },
        {
          organizationId: orgB,
          transactionDate: "2026-07-24",
          transactionType: "journal",
        },
      ])
      .returning();

    async function createCase(
      organizationId: string,
      sources: Array<{ id: string }>,
      canonicalCandidateId: string,
      canonicalJournalHeaderId: string,
    ) {
      const [left, right] = [...sources].sort((a, b) => a.id.localeCompare(b.id));
      const [matchCase] = await db
        .insert(sourceMatchCandidates)
        .values({
          organizationId,
          leftSourceRecordId: left.id,
          rightSourceRecordId: right.id,
          matchType: "duplicate",
          confidence: "0.90",
          score: "90",
          canonicalCandidateId,
          canonicalJournalHeaderId,
        })
        .returning();
      return matchCase;
    }

    const caseA = await createCase(orgA, [sourceA1, sourceA2], candidateA.id, journalA1.id);
    const caseB = await createCase(orgB, [sourceB1, sourceB2], candidateB.id, journalB1.id);

    return {
      orgA,
      orgB,
      sourceA1,
      sourceA2,
      sourceB1,
      documentA,
      documentB,
      candidateA,
      candidateB,
      journalA1,
      journalA2,
      journalB1,
      journalB2,
      caseA,
      caseB,
    };
  }

  function pairKey(leftId: string, rightId: string): string {
    return [leftId, rightId].sort().join(":");
  }

  async function expectConstraintViolation(
    operation: Promise<unknown>,
    expected: string | RegExp,
  ): Promise<void> {
    try {
      await operation;
      expect.fail("Expected a tenant-lineage foreign key violation");
    } catch (error) {
      const constraintName = (
        error as {
          cause?: { constraint_name?: string };
          constraint_name?: string;
        }
      ).cause?.constraint_name;
      if (typeof expected === "string") {
        expect(constraintName).toBe(expected);
      } else {
        expect(constraintName).toMatch(expected);
      }
    }
  }

  it("installs every composite foreign key exactly once", async () => {
    const constraints = await sqlClient<Array<{ name: string; type: string }>>`
      SELECT conname AS name, contype::text AS type
      FROM pg_constraint
      WHERE conname LIKE '%_org_%_fk'
    `;
    const matching = constraints.filter((constraint) =>
      EXPECTED_TENANT_FOREIGN_KEYS.includes(
        constraint.name as (typeof EXPECTED_TENANT_FOREIGN_KEYS)[number],
      ),
    );

    expect(matching).toHaveLength(EXPECTED_TENANT_FOREIGN_KEYS.length);
    expect(new Set(matching.map((constraint) => constraint.name)).size).toBe(
      EXPECTED_TENANT_FOREIGN_KEYS.length,
    );
    expect(matching.every((constraint) => constraint.type === "f")).toBe(true);
  });

  it("accepts same-organization evidence, candidate, case, ledger, and merge lineage", async () => {
    const fixture = await createFixture("valid-lineage");

    await db.insert(sourceRecordDocuments).values({
      organizationId: fixture.orgA,
      sourceRecordId: fixture.sourceA1.id,
      documentId: fixture.documentA.id,
      relationship: "primary_document",
    });
    await db.insert(transactionCandidateSources).values({
      organizationId: fixture.orgA,
      candidateId: fixture.candidateA.id,
      sourceRecordId: fixture.sourceA1.id,
      relationship: "origin",
      isPrimary: true,
    });
    await db.insert(ledgerSourceLinks).values({
      organizationId: fixture.orgA,
      journalHeaderId: fixture.journalA1.id,
      sourceRecordId: fixture.sourceA1.id,
      relationship: "supporting",
    });
    const [merge] = await db
      .insert(journalDuplicateMerges)
      .values({
        organizationId: fixture.orgA,
        canonicalHeaderId: fixture.journalA1.id,
        duplicateHeaderId: fixture.journalA2.id,
        duplicateCaseId: fixture.caseA.id,
        pairKey: pairKey(fixture.journalA1.id, fixture.journalA2.id),
        reason: "Confirmed duplicate",
        idempotencyKey: `valid-${randomUUID()}`,
        matchedBy: "test-user",
      })
      .returning();

    expect(merge.organizationId).toBe(fixture.orgA);
  });

  it("preserves the existing cascade and set-null lifecycle semantics", async () => {
    const fixture = await createFixture("lineage-delete-semantics");
    const [merge] = await db
      .insert(journalDuplicateMerges)
      .values({
        organizationId: fixture.orgA,
        canonicalHeaderId: fixture.journalA1.id,
        duplicateHeaderId: fixture.journalA2.id,
        duplicateCaseId: fixture.caseA.id,
        pairKey: pairKey(fixture.journalA1.id, fixture.journalA2.id),
        reason: "Lifecycle semantics",
        idempotencyKey: `lifecycle-${randomUUID()}`,
        matchedBy: "test-user",
      })
      .returning();

    await db
      .delete(transactionCandidates)
      .where(eq(transactionCandidates.id, fixture.candidateA.id));
    expect(
      await db
        .select({ canonicalCandidateId: sourceMatchCandidates.canonicalCandidateId })
        .from(sourceMatchCandidates)
        .where(eq(sourceMatchCandidates.id, fixture.caseA.id)),
    ).toEqual([{ canonicalCandidateId: null }]);

    await db.delete(journalHeaders).where(eq(journalHeaders.id, fixture.journalB1.id));
    expect(
      await db
        .select({ canonicalJournalHeaderId: sourceMatchCandidates.canonicalJournalHeaderId })
        .from(sourceMatchCandidates)
        .where(eq(sourceMatchCandidates.id, fixture.caseB.id)),
    ).toEqual([{ canonicalJournalHeaderId: null }]);

    await db.delete(sourceRecords).where(eq(sourceRecords.id, fixture.sourceB1.id));
    expect(
      await db
        .select({ sourceRecordId: transactionCandidates.sourceRecordId })
        .from(transactionCandidates)
        .where(eq(transactionCandidates.id, fixture.candidateB.id)),
    ).toEqual([{ sourceRecordId: null }]);
    expect(
      await db
        .select({ id: sourceMatchCandidates.id })
        .from(sourceMatchCandidates)
        .where(eq(sourceMatchCandidates.id, fixture.caseB.id)),
    ).toEqual([]);

    await db.delete(sourceMatchCandidates).where(eq(sourceMatchCandidates.id, fixture.caseA.id));
    expect(
      await db
        .select({ duplicateCaseId: journalDuplicateMerges.duplicateCaseId })
        .from(journalDuplicateMerges)
        .where(eq(journalDuplicateMerges.id, merge.id)),
    ).toEqual([{ duplicateCaseId: null }]);
  });

  it("rejects cross-organization source, document, and candidate lineage", async () => {
    const fixture = await createFixture("invalid-evidence-lineage");

    await expectConstraintViolation(
      db.insert(sourceRecordDocuments).values({
        organizationId: fixture.orgA,
        sourceRecordId: fixture.sourceA1.id,
        documentId: fixture.documentB.id,
      }),
      "source_record_documents_org_document_fk",
    );

    await expectConstraintViolation(
      db.insert(transactionCandidateSources).values({
        organizationId: fixture.orgA,
        candidateId: fixture.candidateA.id,
        sourceRecordId: fixture.sourceB1.id,
      }),
      "transaction_candidate_sources_org_source_fk",
    );

    await expectConstraintViolation(
      db.insert(sourceRecordVersions).values({
        organizationId: fixture.orgA,
        sourceRecordId: fixture.sourceB1.id,
        externalVersion: `cross-org-${randomUUID()}`,
      }),
      "source_record_versions_org_source_fk",
    );

    await expectConstraintViolation(
      db
        .update(sourceRecords)
        .set({ parentSourceRecordId: fixture.sourceB1.id })
        .where(eq(sourceRecords.id, fixture.sourceA1.id)),
      "source_records_org_parent_source_fk",
    );

    await expectConstraintViolation(
      db
        .update(transactionCandidates)
        .set({ sourceRecordId: fixture.sourceB1.id })
        .where(eq(transactionCandidates.id, fixture.candidateA.id)),
      "transaction_candidates_org_source_fk",
    );
  });

  it("rejects cross-organization duplicate-case sources and canonical targets", async () => {
    const fixture = await createFixture("invalid-case-lineage");
    const [left, right] = [fixture.sourceA2, fixture.sourceB1].sort((a, b) =>
      a.id.localeCompare(b.id),
    );

    await expectConstraintViolation(
      db.insert(sourceMatchCandidates).values({
        organizationId: fixture.orgA,
        leftSourceRecordId: left.id,
        rightSourceRecordId: right.id,
        matchType: "duplicate",
      }),
      /source_match_candidates_org_(left|right)_source_fk/,
    );

    await expectConstraintViolation(
      db
        .update(sourceMatchCandidates)
        .set({ canonicalCandidateId: fixture.candidateB.id })
        .where(eq(sourceMatchCandidates.id, fixture.caseA.id)),
      "source_match_candidates_org_canonical_candidate_fk",
    );

    await expectConstraintViolation(
      db
        .update(sourceMatchCandidates)
        .set({ canonicalJournalHeaderId: fixture.journalB1.id })
        .where(eq(sourceMatchCandidates.id, fixture.caseA.id)),
      "source_match_candidates_org_canonical_journal_fk",
    );
  });

  it("rejects cross-organization ledger links, duplicate pointers, and merge endpoints", async () => {
    const fixture = await createFixture("invalid-ledger-lineage");

    await expectConstraintViolation(
      db.insert(ledgerSourceLinks).values({
        organizationId: fixture.orgA,
        journalHeaderId: fixture.journalB1.id,
        sourceRecordId: fixture.sourceA1.id,
        relationship: "supporting",
      }),
      "ledger_source_links_org_journal_fk",
    );

    await expectConstraintViolation(
      db
        .update(journalHeaders)
        .set({ duplicateOfHeaderId: fixture.journalB1.id })
        .where(eq(journalHeaders.id, fixture.journalA2.id)),
      "journal_headers_org_duplicate_of_fk",
    );

    await expectConstraintViolation(
      db.insert(journalDuplicateMerges).values({
        organizationId: fixture.orgA,
        canonicalHeaderId: fixture.journalB1.id,
        duplicateHeaderId: fixture.journalA2.id,
        duplicateCaseId: fixture.caseA.id,
        pairKey: pairKey(fixture.journalB1.id, fixture.journalA2.id),
        reason: "Invalid canonical tenant",
        idempotencyKey: `invalid-canonical-${randomUUID()}`,
        matchedBy: "test-user",
      }),
      "journal_duplicate_merges_org_canonical_fk",
    );

    await expectConstraintViolation(
      db.insert(journalDuplicateMerges).values({
        organizationId: fixture.orgA,
        canonicalHeaderId: fixture.journalA1.id,
        duplicateHeaderId: fixture.journalB2.id,
        duplicateCaseId: fixture.caseA.id,
        pairKey: pairKey(fixture.journalA1.id, fixture.journalB2.id),
        reason: "Invalid duplicate tenant",
        idempotencyKey: `invalid-duplicate-${randomUUID()}`,
        matchedBy: "test-user",
      }),
      "journal_duplicate_merges_org_duplicate_fk",
    );

    await expectConstraintViolation(
      db.insert(journalDuplicateMerges).values({
        organizationId: fixture.orgA,
        canonicalHeaderId: fixture.journalA1.id,
        duplicateHeaderId: fixture.journalA2.id,
        duplicateCaseId: fixture.caseB.id,
        pairKey: pairKey(fixture.journalA1.id, fixture.journalA2.id),
        reason: "Invalid case tenant",
        idempotencyKey: `invalid-case-${randomUUID()}`,
        matchedBy: "test-user",
      }),
      "journal_duplicate_merges_org_case_fk",
    );
  });
});
