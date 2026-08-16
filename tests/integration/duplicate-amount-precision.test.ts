import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { organization } from "@/db/schema/auth";
import { sourceMatchCandidates, sourceRecords } from "@/db/schema/inbox";
import { runDuplicateMatchingForSource } from "@/lib/inbox/duplicate-engine";

describe("duplicate matcher currency-precision lookup", () => {
  it("discovers a legacy unquantized JPY amount without considering another currency", async () => {
    const suffix = randomUUID();
    const orgId = `dedup-jpy-${suffix}`;
    await db.insert(organization).values({
      id: orgId,
      name: "JPY duplicate precision test",
      slug: `dedup-jpy-${suffix}`,
    });

    const [legacyJpy, currentJpy, sameNumberKwd] = await db
      .insert(sourceRecords)
      .values([
        {
          organizationId: orgId,
          recordType: "receipt",
          externalId: `legacy-jpy-${suffix}`,
          transactionDate: "2026-07-24",
          description: "Tokyo office supply purchase",
          amount: "1234.4",
          currency: "JPY",
          economicEventClass: "purchase",
          direction: "outflow",
          originalAmount: "1234.4",
          originalCurrency: "JPY",
          effectiveDate: "2026-07-24",
          normalizedParty: "tokyo office supply",
          normalizedReference: "receipt4242",
        },
        {
          organizationId: orgId,
          recordType: "bank_transaction",
          externalId: `current-jpy-${suffix}`,
          transactionDate: "2026-07-24",
          description: "Tokyo office supply purchase",
          amount: "1234",
          currency: "JPY",
          economicEventClass: "purchase",
          direction: "outflow",
          originalAmount: "1234",
          originalCurrency: "JPY",
          effectiveDate: "2026-07-24",
          normalizedParty: "tokyo office supply",
          normalizedReference: "receipt4242",
        },
        {
          organizationId: orgId,
          recordType: "bank_transaction",
          externalId: `kwd-${suffix}`,
          transactionDate: "2026-07-24",
          description: "Tokyo office supply purchase",
          amount: "1234.000",
          currency: "KWD",
          economicEventClass: "purchase",
          direction: "outflow",
          originalAmount: "1234.000",
          originalCurrency: "KWD",
          effectiveDate: "2026-07-24",
          normalizedParty: "tokyo office supply",
          normalizedReference: "receipt4242",
        },
      ])
      .returning();

    const result = await runDuplicateMatchingForSource(
      { db, orgId, userId: "system:precision-test" },
      currentJpy.id,
      "source_updated",
    );

    expect(result.evaluated).toBe(1);
    expect(result.blockingCases).toHaveLength(1);

    const cases = await db
      .select()
      .from(sourceMatchCandidates)
      .where(eq(sourceMatchCandidates.organizationId, orgId));
    expect(cases).toHaveLength(1);
    expect(new Set([cases[0].leftSourceRecordId, cases[0].rightSourceRecordId])).toEqual(
      new Set([legacyJpy.id, currentJpy.id]),
    );
    expect([cases[0].leftSourceRecordId, cases[0].rightSourceRecordId]).not.toContain(
      sameNumberKwd.id,
    );
  });
});
