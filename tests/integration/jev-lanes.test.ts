/**
 * Jev approval lanes (Inbox v2 spec §8, build step 11): the table and the lane
 * lifecycle.
 *
 * What the database guarantees on its own, whatever the application does: an
 * organization sees and writes only its own lanes (RLS), one lane per identity
 * (including the no-party lane), and no lane at `auto` without its party,
 * amount cap and confidence threshold. And what the lane functions add:
 * eligibility over the lane's own labels, re-verified at the moment of a
 * promotion, a threshold only the lane's calibration supports, and automatic
 * demotion when the trailing window slips.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withOrgContext } from "@/db";
import { aiAutonomyLanes, aiRunFeedback } from "@/db/schema/ai";
import { organization, user } from "@/db/schema/auth";
import { workflowEvents } from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import {
  computeLaneEligibility,
  demoteAutonomyLane,
  demoteLaneIfSlipped,
  ensureAutonomyLane,
  listAutonomyLanes,
  loadLaneReliability,
  promoteAutonomyLane,
  setAutonomyLaneLimits,
} from "@/lib/ai/autonomy-lanes";
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

async function organizationWithAdmin(prefix: string) {
  const { orgId, vendor } = await organizationWithVendor(prefix);
  const userId = `${prefix}-admin-${randomUUID()}`;
  await db.insert(user).values({
    id: userId,
    name: "Lane Admin",
    email: `${userId}@test.local`,
    emailVerified: true,
  });
  return { orgId, vendor, userId };
}

/**
 * `accepted` then `other` labels on a lane, oldest first, each a second apart so
 * the trailing window is well defined. `other` are corrections unless given.
 */
async function label(
  orgId: string,
  laneId: string,
  counts: {
    accepted: number;
    other?: number;
    confidence?: number;
    verdict?: "corrected" | "rejected";
  },
  startAt = Date.now() - 1_000_000,
) {
  const rows = [
    ...Array.from({ length: counts.accepted }, () => "accepted" as const),
    ...Array.from({ length: counts.other ?? 0 }, () => counts.verdict ?? ("corrected" as const)),
  ].map((verdict, index) => ({
    organizationId: orgId,
    laneId,
    verdict,
    laneEvidence: { confidence: counts.confidence ?? 0.99, wouldApprove: true },
    createdAt: new Date(startAt + index * 1000),
  }));
  if (rows.length > 0) await db.insert(aiRunFeedback).values(rows);
}

function asOrg<T>(orgId: string, userId: string, fn: (tx: any) => Promise<T>): Promise<T> {
  return withOrgContext(orgId, userId, "admin", fn);
}

describeDb("lane lifecycle", () => {
  it("creates each lane once, at watch, and only for the organization's own party", async () => {
    const { orgId, vendor, userId } = await organizationWithAdmin("lane-ensure");
    const identity = { laneKey: "inbox_approve" as const, partyId: vendor.id, docKind: "expense" };
    const [first, second] = await Promise.all([
      asOrg(orgId, userId, (tx) => ensureAutonomyLane(tx, orgId, identity)),
      asOrg(orgId, userId, (tx) => ensureAutonomyLane(tx, orgId, identity)),
    ]);
    expect(first.id).toBe(second.id);
    expect(first.level).toBe("watch");
    const partyless = await asOrg(orgId, userId, (tx) =>
      ensureAutonomyLane(tx, orgId, { ...identity, partyId: null }),
    );
    expect(partyless.id).not.toBe(first.id);
    expect(
      (
        await asOrg(orgId, userId, (tx) =>
          ensureAutonomyLane(tx, orgId, { ...identity, partyId: null }),
        )
      ).id,
    ).toBe(partyless.id);

    const other = await organizationWithAdmin("lane-ensure-other");
    await expect(
      asOrg(orgId, userId, (tx) =>
        ensureAutonomyLane(tx, orgId, { ...identity, partyId: other.vendor.id }),
      ),
    ).rejects.toThrow(/does not belong to this organization/);
  });

  it("counts only the lane's own labels toward eligibility", async () => {
    const { orgId, vendor, userId } = await organizationWithAdmin("lane-eligibility");
    const lane = await asOrg(orgId, userId, (tx) =>
      ensureAutonomyLane(tx, orgId, {
        laneKey: "inbox_approve",
        partyId: vendor.id,
        docKind: "expense",
      }),
    );
    const sibling = await asOrg(orgId, userId, (tx) =>
      ensureAutonomyLane(tx, orgId, {
        laneKey: "inbox_approve",
        partyId: vendor.id,
        docKind: "vendor_bill",
      }),
    );
    await label(orgId, sibling.id, { accepted: 300 });
    await label(orgId, lane.id, { accepted: 150 });
    // Feedback outside any lane (the per-kind flywheel) never counts either.
    await db.insert(aiRunFeedback).values({ organizationId: orgId, verdict: "accepted" });

    const eligibility = await asOrg(orgId, userId, (tx) =>
      computeLaneEligibility(tx, orgId, lane.id),
    );
    expect(eligibility).toMatchObject({ eligible: false, total: 150, remaining: 50 });
    expect(
      await asOrg(orgId, userId, (tx) => computeLaneEligibility(tx, orgId, sibling.id)),
    ).toMatchObject({ eligible: true, total: 300 });
  });

  it("re-verifies eligibility at the moment of each promotion, one step at a time", async () => {
    const { orgId, vendor, userId } = await organizationWithAdmin("lane-promote");
    const lane = await asOrg(orgId, userId, (tx) =>
      ensureAutonomyLane(tx, orgId, {
        laneKey: "inbox_approve",
        partyId: vendor.id,
        docKind: "expense",
      }),
    );
    await label(orgId, lane.id, { accepted: 199 });
    await expect(
      asOrg(orgId, userId, (tx) =>
        promoteAutonomyLane(tx, { orgId, laneId: lane.id, to: "suggest", actorId: userId }),
      ),
    ).rejects.toThrow(/has not earned suggest yet. Needs 1 more reviewed papers/);
    await expect(
      asOrg(orgId, userId, (tx) =>
        promoteAutonomyLane(tx, {
          orgId,
          laneId: lane.id,
          to: "auto",
          actorId: userId,
          amountCap: "500",
          confidenceThreshold: "0.98",
        }),
      ),
    ).rejects.toThrow(/one step at a time/);

    await label(orgId, lane.id, { accepted: 1 }, Date.now() - 1000);
    const suggest = await asOrg(orgId, userId, (tx) =>
      promoteAutonomyLane(tx, { orgId, laneId: lane.id, to: "suggest", actorId: userId }),
    );
    expect(suggest).toMatchObject({ level: "suggest", promotedBy: userId });

    // Auto needs a cap and a threshold the lane's calibration supports: every
    // label so far sits in the 0.98–1 bucket, so nothing below 0.98.
    const auto = (overrides: Record<string, string | null>) =>
      asOrg(orgId, userId, (tx) =>
        promoteAutonomyLane(tx, {
          orgId,
          laneId: lane.id,
          to: "auto",
          actorId: userId,
          amountCap: "500",
          confidenceThreshold: "0.98",
          ...overrides,
        }),
      );
    await expect(auto({ amountCap: null })).rejects.toThrow(/Set an amount cap/);
    await expect(auto({ amountCap: "0" })).rejects.toThrow(/positive amount/);
    await expect(auto({ confidenceThreshold: "0.95" })).rejects.toThrow(
      /does not support a threshold below 0.98/,
    );
    const promoted = await auto({});
    expect(promoted).toMatchObject({
      level: "auto",
      amountCap: "500.00000000",
      confidenceThreshold: "0.9800",
    });
    const events = await db
      .select({ action: workflowEvents.action, data: workflowEvents.data })
      .from(workflowEvents)
      .where(and(eq(workflowEvents.organizationId, orgId), eq(workflowEvents.entityId, lane.id)));
    expect(events.map((event) => event.data.toLevel).sort()).toEqual(["auto", "suggest"]);

    const [summary] = await asOrg(orgId, userId, (tx) =>
      listAutonomyLanes(tx, orgId, "inbox_approve"),
    );
    expect(summary).toMatchObject({
      partyName: "Lane Vendor",
      promotedByName: "Lane Admin",
      agreement: { labeled: 200, accepted: 200, wouldApprove: 200, wouldApproveUndone: 0 },
      eligibility: { eligible: true },
    });
    expect(summary.reliability.minimumThreshold).toBe(0.98);
  });

  it("refuses to promote the no-party lane to auto: new parties always need a person", async () => {
    const { orgId, userId } = await organizationWithAdmin("lane-partyless");
    const lane = await asOrg(orgId, userId, (tx) =>
      ensureAutonomyLane(tx, orgId, {
        laneKey: "inbox_approve",
        partyId: null,
        docKind: "expense",
      }),
    );
    await label(orgId, lane.id, { accepted: 200 });
    await asOrg(orgId, userId, (tx) =>
      promoteAutonomyLane(tx, { orgId, laneId: lane.id, to: "suggest", actorId: userId }),
    );
    await expect(
      asOrg(orgId, userId, (tx) =>
        promoteAutonomyLane(tx, {
          orgId,
          laneId: lane.id,
          to: "auto",
          actorId: userId,
          amountCap: "100",
          confidenceThreshold: "0.99",
        }),
      ),
    ).rejects.toThrow(/new parties always need a person/);
  });

  it("demotes an auto lane to suggest when its trailing window slips, and only then", async () => {
    const { orgId, vendor, userId } = await organizationWithAdmin("lane-demote");
    const lane = await asOrg(orgId, userId, (tx) =>
      ensureAutonomyLane(tx, orgId, {
        laneKey: "inbox_approve",
        partyId: vendor.id,
        docKind: "expense",
      }),
    );
    await label(orgId, lane.id, { accepted: 200 });
    await db
      .update(aiAutonomyLanes)
      .set({ level: "auto", amountCap: "500", confidenceThreshold: "0.98" })
      .where(eq(aiAutonomyLanes.id, lane.id));

    // Two disagreements in the newest 50: 96%, still above the floor.
    await label(orgId, lane.id, { accepted: 0, other: 2, verdict: "rejected" }, Date.now() - 500);
    expect(
      await asOrg(orgId, userId, (tx) =>
        demoteLaneIfSlipped(tx, { orgId, laneId: lane.id, triggeredBy: userId }),
      ),
    ).toBe(false);

    await label(orgId, lane.id, { accepted: 0, other: 1 }, Date.now() - 100);
    expect(
      await asOrg(orgId, userId, (tx) =>
        demoteLaneIfSlipped(tx, { orgId, laneId: lane.id, triggeredBy: userId }),
      ),
    ).toBe(true);
    const [demoted] = await db
      .select()
      .from(aiAutonomyLanes)
      .where(eq(aiAutonomyLanes.id, lane.id));
    expect(demoted.level).toBe("suggest");
    expect(demoted.demotedAt).toBeInstanceOf(Date);
    const [event] = await db
      .select()
      .from(workflowEvents)
      .where(
        and(eq(workflowEvents.entityId, lane.id), eq(workflowEvents.action, "jev_lane_demoted")),
      );
    expect(event).toMatchObject({
      actorType: "system",
      actorId: userId,
      data: { fromLevel: "auto", toLevel: "suggest", automatic: true },
    });

    // A suggest lane is never demoted automatically; an admin may still.
    expect(
      await asOrg(orgId, userId, (tx) =>
        demoteLaneIfSlipped(tx, { orgId, laneId: lane.id, triggeredBy: userId }),
      ),
    ).toBe(false);
    const watch = await asOrg(orgId, userId, (tx) =>
      demoteAutonomyLane(tx, { orgId, laneId: lane.id, to: "watch", actorId: userId }),
    );
    expect(watch.level).toBe("watch");
    await expect(
      asOrg(orgId, userId, (tx) =>
        demoteAutonomyLane(tx, { orgId, laneId: lane.id, to: "suggest", actorId: userId }),
      ),
    ).rejects.toThrow(/cannot be demoted/);
  });

  it("re-verifies eligibility and calibration when an auto lane is widened", async () => {
    const { orgId, vendor, userId } = await organizationWithAdmin("lane-limits-change");
    const lane = await asOrg(orgId, userId, (tx) =>
      ensureAutonomyLane(tx, orgId, {
        laneKey: "inbox_approve",
        partyId: vendor.id,
        docKind: "expense",
      }),
    );
    await label(orgId, lane.id, { accepted: 150, confidence: 0.99 });
    await label(orgId, lane.id, { accepted: 50, confidence: 0.96 }, Date.now() - 500_000);
    await db
      .update(aiAutonomyLanes)
      .set({ level: "auto", amountCap: "500", confidenceThreshold: "0.98" })
      .where(eq(aiAutonomyLanes.id, lane.id));
    const table = await asOrg(orgId, userId, (tx) => loadLaneReliability(tx, orgId, lane.id));
    expect(table.minimumThreshold).toBe(0.95);

    const widened = await asOrg(orgId, userId, (tx) =>
      setAutonomyLaneLimits(tx, {
        orgId,
        laneId: lane.id,
        actorId: userId,
        confidenceThreshold: "0.95",
        amountCap: "750",
      }),
    );
    expect(widened).toMatchObject({ confidenceThreshold: "0.9500", amountCap: "750.00000000" });
    await expect(
      asOrg(orgId, userId, (tx) =>
        setAutonomyLaneLimits(tx, {
          orgId,
          laneId: lane.id,
          actorId: userId,
          confidenceThreshold: "0.9",
        }),
      ),
    ).rejects.toThrow(/does not support a threshold below 0.95/);

    // Once the lane is no longer eligible, only narrowing is allowed.
    await label(orgId, lane.id, { accepted: 0, other: 10 }, Date.now() - 100);
    await expect(
      asOrg(orgId, userId, (tx) =>
        setAutonomyLaneLimits(tx, { orgId, laneId: lane.id, actorId: userId, amountCap: "900" }),
      ),
    ).rejects.toThrow(/Widening this lane needs it to be eligible/);
    const narrowed = await asOrg(orgId, userId, (tx) =>
      setAutonomyLaneLimits(tx, { orgId, laneId: lane.id, actorId: userId, amountCap: "100" }),
    );
    expect(narrowed.amountCap).toBe("100.00000000");
  });

  it("keeps lane feedback when a party is deleted, and drops only the lane", async () => {
    const { orgId, userId } = await organizationWithAdmin("lane-party-delete");
    const [temporary] = await db
      .insert(parties)
      .values({ organizationId: orgId, name: "Created by mistake", partyType: "vendor" })
      .returning();
    const lane = await asOrg(orgId, userId, (tx) =>
      ensureAutonomyLane(tx, orgId, {
        laneKey: "inbox_approve",
        partyId: temporary.id,
        docKind: "expense",
      }),
    );
    await label(orgId, lane.id, { accepted: 1 });
    await db.delete(parties).where(eq(parties.id, temporary.id));
    expect(
      await db.select().from(aiAutonomyLanes).where(eq(aiAutonomyLanes.id, lane.id)),
    ).toHaveLength(0);
    const kept = await db
      .select({ laneId: aiRunFeedback.laneId })
      .from(aiRunFeedback)
      .where(
        and(eq(aiRunFeedback.organizationId, orgId), inArray(aiRunFeedback.verdict, ["accepted"])),
      );
    expect(kept).toEqual([{ laneId: null }]);
  });
});
