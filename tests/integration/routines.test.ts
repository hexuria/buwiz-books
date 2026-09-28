/**
 * Routine configuration (Inbox v2 §3, build step 4).
 *
 * Pins the rules a routine lives by: no enabling before the chart of accounts
 * is applied (disabling always works), one inbound email routine per org even
 * under a race, a webhook secret that is returned once and stored only as
 * ciphertext, and RLS keeping one organization's routines invisible to another.
 */
import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql as drizzleSql } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { db, withOrgContext, type DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { organization, user } from "@/db/schema/auth";
import { workflowEvents } from "@/db/schema/inbox";
import { routineSecrets, routines } from "@/db/schema/routines";
import { executeCoaPlan } from "@/lib/coa/execute-plan";
import { planCoaPreset } from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { loadCoaSnapshot } from "@/lib/coa/snapshot";
import { loadRoutineWebhookSecret } from "@/lib/routines/secrets";
import {
  createRoutine,
  ensureInboundEmailRoutine,
  listRoutines,
  rotateRoutineWebhookSecret,
  setRoutineEnabled,
  updateRoutine,
} from "@/lib/routines/service";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

interface Tenant {
  orgId: string;
  userId: string;
}

async function createTenant(label: string): Promise<Tenant> {
  const suffix = randomUUID();
  const orgId = `${label}-org-${suffix}`;
  const userId = `${label}-user-${suffix}`;
  await db.insert(user).values({
    id: userId,
    name: "Routine Admin",
    email: `${suffix}@routines.test`,
    emailVerified: true,
  });
  await db
    .insert(organization)
    .values({ id: orgId, name: "Routine Co", slug: `${label}-${suffix}` });
  return { orgId, userId };
}

async function applyChart(orgId: string) {
  await withOrgContext(orgId, "system", "admin", async (tx) => {
    const snapshot = await loadCoaSnapshot(tx, orgId);
    const plan = planCoaPreset(snapshot, COA_PRESETS.general_small_business, {
      onConflict: "renumber",
    });
    await executeCoaPlan(tx, orgId, plan, null);
  });
}

function asTenant<T>(tenant: Tenant, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  return withOrgContext(tenant.orgId, tenant.userId, "admin", fn);
}

describeDb("routines", () => {
  async function tenant(label: string, options: { chart?: boolean } = {}) {
    const created = await createTenant(label);
    if (options.chart) await applyChart(created.orgId);
    return created;
  }

  describe("chart-of-accounts gate", () => {
    it("refuses to create an enabled routine before the chart is applied", async () => {
      const org = await tenant("gate-create");
      await expect(
        asTenant(org, (tx) =>
          createRoutine(tx, {
            orgId: org.orgId,
            actorId: org.userId,
            routine: { triggerKind: "webhook", name: "Receipts" },
          }),
        ),
      ).rejects.toThrow("Set up your chart of accounts first.");
      const rows = await db.select().from(routines).where(eq(routines.organizationId, org.orgId));
      expect(rows).toHaveLength(0);
    });

    it("creates a disabled routine without a chart but refuses to enable it", async () => {
      const org = await tenant("gate-enable");
      const created = await asTenant(org, (tx) =>
        createRoutine(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routine: { triggerKind: "webhook", name: "Receipts", enabled: false },
        }),
      );
      expect(created).toMatchObject({ enabled: false, triggerKind: "webhook" });

      await expect(
        asTenant(org, (tx) =>
          setRoutineEnabled(tx, {
            orgId: org.orgId,
            actorId: org.userId,
            routineId: created.id,
            enabled: true,
          }),
        ),
      ).rejects.toThrow("Set up your chart of accounts first.");
      const [row] = await db.select().from(routines).where(eq(routines.id, created.id));
      expect(row.enabled).toBe(false);
    });

    it("enables once the chart is applied, and audits every change", async () => {
      const org = await tenant("gate-applied");
      const created = await asTenant(org, (tx) =>
        createRoutine(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routine: { triggerKind: "webhook", name: "Receipts", enabled: false },
        }),
      );
      await applyChart(org.orgId);

      const enabled = await asTenant(org, (tx) =>
        setRoutineEnabled(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routineId: created.id,
          enabled: true,
        }),
      );
      expect(enabled.enabled).toBe(true);

      const disabled = await asTenant(org, (tx) =>
        setRoutineEnabled(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routineId: created.id,
          enabled: false,
        }),
      );
      expect(disabled.enabled).toBe(false);

      const audit = await db
        .select({ action: activityLogs.action, actorId: activityLogs.actorId })
        .from(activityLogs)
        .where(
          and(eq(activityLogs.organizationId, org.orgId), eq(activityLogs.entityId, created.id)),
        );
      expect(audit.map(({ action }) => action).sort()).toEqual([
        "routine_created",
        "routine_disabled",
        "routine_enabled",
      ]);
      expect(new Set(audit.map(({ actorId }) => actorId))).toEqual(new Set([org.userId]));
    });

    it("always allows disabling, chart or not", async () => {
      const org = await tenant("gate-disable");
      const email = await asTenant(org, (tx) => ensureInboundEmailRoutine(tx, org.orgId));
      expect(email.enabled).toBe(true);
      const disabled = await asTenant(org, (tx) =>
        setRoutineEnabled(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routineId: email.id,
          enabled: false,
        }),
      );
      expect(disabled.enabled).toBe(false);
    });
  });

  describe("CRUD", () => {
    it("lists and renames routines without exposing the secret reference", async () => {
      const org = await tenant("crud", { chart: true });
      const created = await asTenant(org, (tx) =>
        createRoutine(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routine: { triggerKind: "webhook", name: "  Zapier receipts  " },
        }),
      );
      expect(created).toMatchObject({
        name: "Zapier receipts",
        enabled: true,
        systemManaged: false,
        hasSigningSecret: false,
        triggerConfig: {
          provider: "buwiz",
          auth: "hmac_sha256",
          tolerance_s: 300,
          max_bytes: 1024 * 1024,
        },
      });
      expect(created.triggerConfig).not.toHaveProperty("secret_ref");

      const renamed = await asTenant(org, (tx) =>
        updateRoutine(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          update: { routineId: created.id, name: "Receipts webhook" },
        }),
      );
      expect(renamed.name).toBe("Receipts webhook");

      const listed = await asTenant(org, (tx) => listRoutines(tx, org.orgId));
      expect(listed.map(({ id, name }) => ({ id, name }))).toEqual([
        { id: created.id, name: "Receipts webhook" },
      ]);
    });

    it("does not touch another organization's routine", async () => {
      const owner = await tenant("crud-owner", { chart: true });
      const other = await tenant("crud-other", { chart: true });
      const created = await asTenant(owner, (tx) =>
        createRoutine(tx, {
          orgId: owner.orgId,
          actorId: owner.userId,
          routine: { triggerKind: "webhook", name: "Owner only" },
        }),
      );
      await expect(
        asTenant(other, (tx) =>
          setRoutineEnabled(tx, {
            orgId: other.orgId,
            actorId: other.userId,
            routineId: created.id,
            enabled: false,
          }),
        ),
      ).rejects.toThrow("Routine not found.");
    });
  });

  describe("webhook signing secret", () => {
    it("returns the secret once, stores only ciphertext, and rotation retires the old one", async () => {
      const org = await tenant("secret", { chart: true });
      const created = await asTenant(org, (tx) =>
        createRoutine(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routine: { triggerKind: "webhook", name: "Signed" },
        }),
      );

      const first = await asTenant(org, (tx) =>
        rotateRoutineWebhookSecret(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routineId: created.id,
        }),
      );
      expect(first.secret).toMatch(/^bwz_whsec_[A-Za-z0-9_-]{43}$/);
      expect(first.routine.hasSigningSecret).toBe(true);
      expect(JSON.stringify(first.routine)).not.toContain(first.secret);

      const [stored] = await db
        .select()
        .from(routineSecrets)
        .where(eq(routineSecrets.routineId, created.id));
      expect(stored.secretEnc.startsWith("enc:v1:")).toBe(true);
      expect(stored.secretEnc).not.toContain(first.secret);
      const [row] = await db.select().from(routines).where(eq(routines.id, created.id));
      expect(row.triggerConfig.secret_ref).toBe(stored.id);

      // Nothing a client can read carries the secret or its reference.
      const listed = await asTenant(org, (tx) => listRoutines(tx, org.orgId));
      expect(JSON.stringify(listed)).not.toContain(first.secret);
      expect(JSON.stringify(listed)).not.toContain(stored.id);

      const second = await asTenant(org, (tx) =>
        rotateRoutineWebhookSecret(tx, {
          orgId: org.orgId,
          actorId: org.userId,
          routineId: created.id,
        }),
      );
      expect(second.secret).not.toBe(first.secret);
      const secrets = await db
        .select()
        .from(routineSecrets)
        .where(eq(routineSecrets.routineId, created.id));
      expect(secrets).toHaveLength(1);
      expect(secrets[0].id).not.toBe(stored.id);

      const [current] = await db.select().from(routines).where(eq(routines.id, created.id));
      const resolved = await asTenant(org, (tx) =>
        loadRoutineWebhookSecret(tx, {
          orgId: org.orgId,
          routineId: created.id,
          secretRef: current.triggerConfig.secret_ref as string,
        }),
      );
      expect(resolved).toBe(second.secret);
      // The retired reference resolves to nothing.
      const retired = await asTenant(org, (tx) =>
        loadRoutineWebhookSecret(tx, {
          orgId: org.orgId,
          routineId: created.id,
          secretRef: stored.id,
        }),
      );
      expect(retired).toBeNull();

      const audit = await db
        .select({ action: activityLogs.action, changes: activityLogs.changes })
        .from(activityLogs)
        .where(
          and(
            eq(activityLogs.organizationId, org.orgId),
            eq(activityLogs.action, "routine_secret_rotated"),
          ),
        );
      expect(audit).toHaveLength(2);
      expect(JSON.stringify(audit)).not.toContain(first.secret);
      expect(JSON.stringify(audit)).not.toContain(second.secret);
    });

    it("refuses a signing secret for the inbound email routine", async () => {
      const org = await tenant("secret-email", { chart: true });
      const email = await asTenant(org, (tx) => ensureInboundEmailRoutine(tx, org.orgId));
      await expect(
        asTenant(org, (tx) =>
          rotateRoutineWebhookSecret(tx, {
            orgId: org.orgId,
            actorId: org.userId,
            routineId: email.id,
          }),
        ),
      ).rejects.toThrow("This routine does not use a signing secret.");
    });
  });

  describe("inbound email routine", () => {
    it("provisions exactly one per organization, even when two emails race", async () => {
      const org = await tenant("email-race");
      const [left, right] = await Promise.all([
        withOrgContext(org.orgId, "system", "admin", (tx) =>
          ensureInboundEmailRoutine(tx, org.orgId),
        ),
        withOrgContext(org.orgId, "system", "admin", (tx) =>
          ensureInboundEmailRoutine(tx, org.orgId),
        ),
      ]);
      expect(left.id).toBe(right.id);
      const rows = await db.select().from(routines).where(eq(routines.organizationId, org.orgId));
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        name: "Inbound email",
        enabled: true,
        triggerKind: "webhook",
        triggerConfig: { provider: "resend", auth: "svix" },
        createdBy: null,
      });
      const provisioned = await db
        .select()
        .from(workflowEvents)
        .where(
          and(
            eq(workflowEvents.organizationId, org.orgId),
            eq(workflowEvents.action, "routine_provisioned"),
          ),
        );
      expect(provisioned).toHaveLength(1);

      const listed = await asTenant(org, (tx) => listRoutines(tx, org.orgId));
      expect(listed[0]).toMatchObject({ systemManaged: true, hasSigningSecret: false });
    });
  });
});

describeDb("routines RLS isolation", () => {
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

  it("keeps each organization's routines and secrets invisible to the other", async () => {
    const [orgA, orgB] = [`rls-a-${randomUUID()}`, `rls-b-${randomUUID()}`];
    for (const id of [orgA, orgB]) {
      await db.insert(organization).values({ id, name: "RLS Co", slug: id });
    }
    const [routineA] = await db
      .insert(routines)
      .values({ organizationId: orgA, name: "A", triggerKind: "webhook", triggerConfig: {} })
      .returning();
    const [routineB] = await db
      .insert(routines)
      .values({ organizationId: orgB, name: "B", triggerKind: "webhook", triggerConfig: {} })
      .returning();
    await db.insert(routineSecrets).values([
      { organizationId: orgA, routineId: routineA.id, secretEnc: "enc:v1:a:a:a" },
      { organizationId: orgB, routineId: routineB.id, secretEnc: "enc:v1:b:b:b" },
    ]);
    const both = [routineA.id, routineB.id];

    const visibleToA = await asRuntimeRole(orgA, (tx) =>
      tx.select({ id: routines.id }).from(routines).where(inArray(routines.id, both)),
    );
    expect(visibleToA).toEqual([{ id: routineA.id }]);
    const secretsVisibleToA = await asRuntimeRole(orgA, (tx) =>
      tx
        .select({ routineId: routineSecrets.routineId })
        .from(routineSecrets)
        .where(inArray(routineSecrets.routineId, both)),
    );
    expect(secretsVisibleToA).toEqual([{ routineId: routineA.id }]);

    // Addressing B's row by id from A's context changes nothing.
    const updated = await asRuntimeRole(orgA, (tx) =>
      tx
        .update(routines)
        .set({ enabled: false })
        .where(eq(routines.id, routineB.id))
        .returning({ id: routines.id }),
    );
    expect(updated).toHaveLength(0);
    const [stillEnabled] = await db.select().from(routines).where(eq(routines.id, routineB.id));
    expect(stillEnabled.enabled).toBe(true);

    // And A's context cannot write a routine into B's books.
    await expect(
      asRuntimeRole(orgA, (tx) =>
        tx
          .insert(routines)
          .values({ organizationId: orgB, name: "Planted", triggerKind: "webhook" }),
      ),
    ).rejects.toThrow();
  });
});
