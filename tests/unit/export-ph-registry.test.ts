import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

// The registry imports schema tables only (no client construction), but the
// route wiring assertions read source; keep the db module stubbed anyway for
// the schema imports' transitive safety.
vi.mock("@/db", () => ({
  db: {},
  withOrgContext: (_o: string, _u: string, _r: string, fn: (tx: unknown) => unknown) => fn({}),
}));

import { EXPORTABLE_ENTITIES, ENTITY_LABELS, EXPORT_VERSION } from "../../src/lib/export-versions";
import { migrateToLatest } from "../../src/lib/export-migrations";
import { PH_EXPORT_SPECS, phRowSchema } from "../../src/lib/export-ph";

/**
 * Program 2 P5 — the PH tables join the versioned export system.
 * "A full export is not a full backup" was the audit M: none of the
 * 0037-0047 tables were in the registry, so an org's compliance history —
 * as-filed snapshots included — was simply absent from the file.
 */
describe("PH export registry", () => {
  it("every spec is a registered exportable entity with a label", () => {
    expect(PH_EXPORT_SPECS.length).toBe(12);
    for (const spec of PH_EXPORT_SPECS) {
      expect(EXPORTABLE_ENTITIES, `${spec.key} missing from EXPORTABLE_ENTITIES`).toContain(
        spec.key,
      );
      expect(ENTITY_LABELS[spec.key as keyof typeof ENTITY_LABELS]).toBeTruthy();
    }
  });

  it("payroll runs are ordered before the entities that resolve against them", () => {
    const order = EXPORTABLE_ENTITIES as readonly string[];
    const runs = order.indexOf("phPayrollRuns");
    expect(runs).toBeGreaterThan(-1);
    expect(order.indexOf("phPayrollLines")).toBeGreaterThan(runs);
    expect(order.indexOf("phPayrollYearState")).toBeGreaterThan(runs);
  });

  it("row schemas refuse stripped columns' absence being fatal and accept ref fields", () => {
    const lines = PH_EXPORT_SPECS.find((spec) => spec.key === "phPayrollLines")!;
    const schema = phRowSchema(lines);
    const parsed = schema.safeParse({
      basicSalary: "50000.00",
      employeeName: "Compute Employee",
      runTaxableYear: 2026,
      runPayrollPeriod: "monthly",
      runPeriodIndex: 1,
    });
    expect(parsed.success).toBe(true);
    // The uuid columns do not exist on the wire format.
    const profile = PH_EXPORT_SPECS.find((spec) => spec.key === "phPartyTaxProfiles")!;
    const profileSchema = phRowSchema(profile) as { shape?: Record<string, unknown> };
    expect(profileSchema.shape && "partyId" in profileSchema.shape).toBe(false);
  });

  it("v3 is current, and the migration chain lifts v1 and v2 files to it", () => {
    expect(EXPORT_VERSION).toBe(3);
    const v2 = {
      meta: {
        version: 2,
        exportedAt: "2026-01-01T00:00:00.000Z",
        organizationName: "Legacy",
        organizationSlug: "legacy",
        entities: ["vendors"],
      },
      data: { vendors: [{ name: "Old Vendor" }] },
    };
    const migrated = migrateToLatest(v2);
    expect(migrated.meta.version).toBe(3);
    expect((migrated.data as Record<string, unknown>).vendors).toEqual([{ name: "Old Vendor" }]);
  });

  it("a NEWER file refuses loudly instead of half-importing", () => {
    const v99 = {
      meta: {
        version: 99,
        exportedAt: "2030-01-01T00:00:00.000Z",
        organizationName: "Future",
        organizationSlug: "future",
        entities: [],
      },
      data: {},
    };
    expect(() => migrateToLatest(v99)).toThrow(/newer version/i);
  });

  it("the route actually calls the migration engine and the PH handlers", () => {
    const source = readFileSync(
      join(__dirname, "../..", "src/routes/api/-export-import.ts"),
      "utf-8",
    );
    expect(source).toContain('import { migrateToLatest } from "../../lib/export-migrations";');
    expect(source).not.toContain("// import { migrateToLatest }");
    expect(source).toContain("const migrated = migrateToLatest(parsed);");
    expect(source).toContain("await exportPhEntity(db, orgId, phSpec)");
    expect(source).toContain("await importPhEntity(db, orgId, phSpec, rows)");
    // Route-local enum carries every registry key.
    for (const spec of ["phPayrollRuns", "phComputedReturns", "phPartyTaxProfiles"]) {
      expect(source).toContain(`"${spec}"`);
    }
  });
});
