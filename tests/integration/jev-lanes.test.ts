/**
 * Jev approval lanes (Inbox v2 spec §8, build step 11): the table itself.
 *
 * What the database guarantees on its own, whatever the application does: an
 * organization sees and writes only its own lanes (RLS), one lane per identity
 * (including the no-party lane), and no lane at `auto` without its party,
 * amount cap and confidence threshold.
 */
import { randomUUID } from "node:crypto";
import { eq, inArray, sql as drizzleSql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db } from "@/db";
import { aiAutonomyLanes } from "@/db/schema/ai";
import { organization } from "@/db/schema/auth";
import { parties } from "@/db/schema/parties";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

async function organizationWithVendor(prefix: string) {
  const orgId = `${prefix}-${randomUUID()}`;
  await db.insert(organization).values({ id: orgId, name: "Lane Co", slug: orgId });
  const [vendor] = await db
    .insert(parties)
    .values({ organizationId: orgId, name: "Lane Vendor", partyType: "vendor" })
    .returning();
  return { orgId, vendor };
}

describeDb("ai_autonomy_lanes constraints", () => {
  it("allows one lane per identity, the no-party lane included", async () => {
    const { orgId, vendor } = await organizationWithVendor("lane-unique");
    await db.insert(aiAutonomyLanes).values([
      { organizationId: orgId, laneKey: "inbox_approve", partyId: vendor.id, docKind: "expense" },
      { organizationId: orgId, laneKey: "inbox_approve", partyId: null, docKind: "expense" },
      {
        organizationId: orgId,
        laneKey: "inbox_approve",
        partyId: vendor.id,
        docKind: "vendor_bill",
      },
    ]);
    await expect(
      db.insert(aiAutonomyLanes).values({
        organizationId: orgId,
        laneKey: "inbox_approve",
        partyId: vendor.id,
        docKind: "expense",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(aiAutonomyLanes).values({
        organizationId: orgId,
        laneKey: "inbox_approve",
        partyId: null,
        docKind: "expense",
      }),
    ).rejects.toThrow();
  });

  it("refuses an auto lane without its party, cap and threshold, and unknown levels or lanes", async () => {
    const { orgId, vendor } = await organizationWithVendor("lane-limits");
    const base = { organizationId: orgId, laneKey: "inbox_approve" as const, docKind: "expense" };
    await expect(
      db.insert(aiAutonomyLanes).values({ ...base, partyId: vendor.id, level: "auto" }),
    ).rejects.toThrow();
    await expect(
      db.insert(aiAutonomyLanes).values({
        ...base,
        partyId: null,
        level: "auto",
        amountCap: "500",
        confidenceThreshold: "0.95",
      }),
    ).rejects.toThrow();
    await expect(
      db.insert(aiAutonomyLanes).values({ ...base, partyId: vendor.id, level: "always" as never }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(aiAutonomyLanes)
        .values({ ...base, laneKey: "post_anything" as never, partyId: vendor.id }),
    ).rejects.toThrow();
    await expect(
      db
        .insert(aiAutonomyLanes)
        .values({ ...base, partyId: vendor.id, confidenceThreshold: "1.5" }),
    ).rejects.toThrow();

    const [auto] = await db
      .insert(aiAutonomyLanes)
      .values({
        ...base,
        partyId: vendor.id,
        level: "auto",
        amountCap: "500.00",
        confidenceThreshold: "0.9500",
      })
      .returning();
    expect(auto).toMatchObject({ level: "auto", amountCap: "500.00000000" });
    // Clearing the cap of an auto lane is refused too.
    await expect(
      db.update(aiAutonomyLanes).set({ amountCap: null }).where(eq(aiAutonomyLanes.id, auto.id)),
    ).rejects.toThrow();
  });
});

describeDb("ai_autonomy_lanes RLS isolation", () => {
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

  it("keeps each organization's lanes invisible and unwritable to the other", async () => {
    const a = await organizationWithVendor("rls-lane-a");
    const b = await organizationWithVendor("rls-lane-b");
    const [laneA] = await db
      .insert(aiAutonomyLanes)
      .values({
        organizationId: a.orgId,
        laneKey: "inbox_approve",
        partyId: a.vendor.id,
        docKind: "expense",
      })
      .returning();
    const [laneB] = await db
      .insert(aiAutonomyLanes)
      .values({
        organizationId: b.orgId,
        laneKey: "inbox_approve",
        partyId: b.vendor.id,
        docKind: "expense",
      })
      .returning();
    const both = [laneA.id, laneB.id];

    const visibleToA = await asRuntimeRole(a.orgId, (tx) =>
      tx
        .select({ id: aiAutonomyLanes.id })
        .from(aiAutonomyLanes)
        .where(inArray(aiAutonomyLanes.id, both)),
    );
    expect(visibleToA).toEqual([{ id: laneA.id }]);

    // A's context cannot promote B's lane: the update touches nothing.
    const promoted = await asRuntimeRole(a.orgId, (tx) =>
      tx
        .update(aiAutonomyLanes)
        .set({ level: "suggest" })
        .where(eq(aiAutonomyLanes.id, laneB.id))
        .returning({ id: aiAutonomyLanes.id }),
    );
    expect(promoted).toHaveLength(0);
    const [stillWatching] = await db
      .select({ level: aiAutonomyLanes.level })
      .from(aiAutonomyLanes)
      .where(eq(aiAutonomyLanes.id, laneB.id));
    expect(stillWatching.level).toBe("watch");

    // And A's context cannot plant a lane in B's books.
    await expect(
      asRuntimeRole(a.orgId, (tx) =>
        tx.insert(aiAutonomyLanes).values({
          organizationId: b.orgId,
          laneKey: "inbox_approve",
          partyId: b.vendor.id,
          docKind: "vendor_bill",
        }),
      ),
    ).rejects.toThrow();
  });
});
