// ============================================================================
// Program 2 P12 — the D6 country gate against a real database:
//
//   • State machine: off (no country, no records) → active (country PH) →
//     archived (records exist, country moved away) → active again with the
//     SAME records (lossless switch-back).
//   • assertPhTaxWritable refuses archived/off and passes active — this is
//     what every payroll/tax mutation calls first (wiring-ratcheted in unit).
//   • switchOrganizationCountry writes the audit row with the record counts
//     and deletes NOTHING.
// ============================================================================
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { organization } from "../../src/db/schema/auth";
import { payrollRuns } from "../../src/db/schema/payroll";
import { activityLogs } from "../../src/db/schema/activity-logs";
import {
  assertPhTaxWritable,
  phTaxModuleStatus,
  switchOrganizationCountry,
  PhTaxModuleInactiveError,
} from "../../src/lib/tax/module-state";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("PH country gate (D6)", () => {
  let db: any;
  let sql: postgres.Sql;
  const ORG = `ph-gate-${randomUUID()}`;
  const USER = "user-ph-gate";

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    await db.insert(organization).values({
      id: ORG,
      name: "PH Gate Org",
      slug: `phg-${randomUUID().slice(0, 8)}`,
    });
  });

  afterAll(async () => {
    await sql.end();
  });

  it("starts off: no country, no records", async () => {
    const status = await phTaxModuleStatus(db, ORG);
    expect(status.state).toBe("off");
    expect(status.totalRecords).toBe(0);
    await expect(assertPhTaxWritable(db, ORG)).rejects.toThrow(PhTaxModuleInactiveError);
    await expect(assertPhTaxWritable(db, ORG)).rejects.toThrow(/not enabled/);
  });

  it("activates on PH, with the audit row capturing the transition", async () => {
    const result = await switchOrganizationCountry(db, { orgId: ORG, userId: USER, country: "PH" });
    expect(result.changed).toBe(true);
    expect(result.after.state).toBe("active");

    await expect(assertPhTaxWritable(db, ORG)).resolves.toBeUndefined();

    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.organizationId, ORG),
          eq(activityLogs.action, "organization_country_changed"),
        ),
      );
    expect(logs.length).toBe(1);
    expect(logs[0].actorId).toBe(USER);
    expect(logs[0].changes.country).toEqual({ old: null, new: "PH" });
    expect(logs[0].changes.phTaxModuleState).toEqual({ old: "off", new: "active" });
  });

  it("archives on switch-away WITH records — and deletes nothing", async () => {
    await db.insert(payrollRuns).values({
      organizationId: ORG,
      taxableYear: 2026,
      payrollPeriod: "monthly",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      periodIndex: 7,
    });

    const result = await switchOrganizationCountry(db, { orgId: ORG, userId: USER, country: "US" });
    expect(result.after.state).toBe("archived");
    expect(result.after.records.payrollRuns).toBe(1);

    // The run is still there — archived is derived, not destructive.
    const runs = await db
      .select({ id: payrollRuns.id })
      .from(payrollRuns)
      .where(eq(payrollRuns.organizationId, ORG));
    expect(runs.length).toBe(1);

    // Writes refuse with the archived message; reads (status itself) work.
    await expect(assertPhTaxWritable(db, ORG)).rejects.toThrow(/archived/);
  });

  it("switch-back to PH restores active with the SAME records (lossless)", async () => {
    const result = await switchOrganizationCountry(db, { orgId: ORG, userId: USER, country: "PH" });
    expect(result.after.state).toBe("active");
    expect(result.after.records.payrollRuns).toBe(1);
    await expect(assertPhTaxWritable(db, ORG)).resolves.toBeUndefined();

    const logs = await db
      .select()
      .from(activityLogs)
      .where(
        and(
          eq(activityLogs.organizationId, ORG),
          eq(activityLogs.action, "organization_country_changed"),
        ),
      );
    expect(logs.length).toBe(3);
  });

  it("no-op switch writes no audit row", async () => {
    const before = (
      await db
        .select({ id: activityLogs.id })
        .from(activityLogs)
        .where(eq(activityLogs.organizationId, ORG))
    ).length;
    const result = await switchOrganizationCountry(db, { orgId: ORG, userId: USER, country: "PH" });
    expect(result.changed).toBe(false);
    const after = (
      await db
        .select({ id: activityLogs.id })
        .from(activityLogs)
        .where(eq(activityLogs.organizationId, ORG))
    ).length;
    expect(after).toBe(before);
  });
});
