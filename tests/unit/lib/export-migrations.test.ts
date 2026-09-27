import { describe, expect, it } from "vitest";
import { migrateToLatest } from "@/lib/export-migrations";
import { EXPORT_VERSION } from "@/lib/export-versions";

// Load fixture files
import v1Sample from "../../fixtures/export-v1-sample.json";
import v2Sample from "../../fixtures/export-v2-sample.json";
import v5Sample from "../../fixtures/export-v5-sample.json";

/** What v4 → v5 adds to every older file: the Inbox configuration, empty. */
const V5_EMPTY = { ruleSnapshots: [], routines: [], classificationMemories: [] };

describe("export-migrations", () => {
  // ── migrateToLatest ───────────────────────────────────────────────────────

  describe("migrateToLatest", () => {
    // P5 deliberate change: v3 added the PH tax entities, so a v2 file now
    // MIGRATES (data untouched, meta lifted) instead of passing through. v5
    // then adds the Inbox configuration entities as empty arrays.
    it("lifts v2 data to the current version, adding only the empty v5 entities", () => {
      const result = migrateToLatest(v2Sample);
      expect(result.data).toEqual({ ...v2Sample.data, ...V5_EMPTY });
      expect(result.meta.version).toBe(EXPORT_VERSION);
    });

    it("preserves meta identity on the v2 lift", () => {
      const result = migrateToLatest(v2Sample);
      expect(result.meta.organizationName).toBe("Test Org");
      expect(result.meta.entities).toEqual(["categories", "departments", "vendors"]);
    });

    it("transforms v1 legacy format to v2", () => {
      const result = migrateToLatest(v1Sample);
      expect(result.meta).toBeDefined();
      expect(result.data).toBeDefined();
      expect(result.meta.version).toBe(EXPORT_VERSION);
    });

    it("chains v1 all the way to the current version", () => {
      const result = migrateToLatest(v1Sample);
      expect(result.meta.version).toBe(EXPORT_VERSION);
    });

    it("preserves exportedAt from v1", () => {
      const result = migrateToLatest(v1Sample);
      expect(result.meta.exportedAt).toBe("2026-01-15T10:30:00.000Z");
    });

    it("sets organizationName to migration placeholder", () => {
      const result = migrateToLatest(v1Sample);
      expect(result.meta.organizationName).toBe("Unknown (migrated from v1)");
    });

    it("populates meta.entities from v1 entity keys", () => {
      const result = migrateToLatest(v1Sample);
      expect(result.meta.entities).toContain("banks");
      expect(result.meta.entities).toContain("vendors");
      expect(result.meta.entities).toContain("customers");
      expect(result.meta.entities).toContain("categories");
      expect(result.meta.entities).toContain("departments");
      expect(result.meta.entities).toContain("locations");
    });

    it("moves v1 entities into data block", () => {
      const result = migrateToLatest(v1Sample);
      const data = result.data as Record<string, unknown>;
      expect(Array.isArray(data.banks)).toBe(true);
      expect(Array.isArray(data.vendors)).toBe(true);
      expect(Array.isArray(data.categories)).toBe(true);
    });

    it("preserves entity data during v1→v2 migration", () => {
      const result = migrateToLatest(v1Sample);
      const banks = result.data.banks as Array<Record<string, unknown>>;
      expect(banks).toHaveLength(1);
      expect(banks[0].accountName).toBe("Business Checking");
      expect(banks[0].institutionName).toBe("First National Bank");
    });

    it("throws for unrecognized format (version 0)", () => {
      expect(() => migrateToLatest({ random: "garbage" })).toThrow(
        /Unrecognized export file format/,
      );
    });

    it("throws for future version (version 99)", () => {
      const future = { meta: { version: 99 }, data: {} };
      expect(() => migrateToLatest(future)).toThrow(/newer version/);
    });

    it("handles empty entities object in v1 gracefully", () => {
      const emptyV1 = { exportedAt: "2026-01-01T00:00:00Z", entities: {} };
      const result = migrateToLatest(emptyV1);
      expect(result.meta.version).toBe(EXPORT_VERSION);
      expect(result.meta.entities).toEqual([]);
      expect(result.data).toEqual(V5_EMPTY);
    });

    it("handles v1 with missing exportedAt gracefully", () => {
      // entities present but exportedAt is not a string — should still be treated as non-legacy
      const broken = { entities: { banks: [] } };
      // This should be version 0 since exportedAt is missing
      expect(() => migrateToLatest(broken)).toThrow(/Unrecognized export file format/);
    });
  });

  // ── v4 → v5: Inbox configuration ──────────────────────────────────────────

  describe("v4 → v5", () => {
    const v4 = {
      meta: {
        version: 4,
        exportedAt: "2026-09-01T00:00:00.000Z",
        organizationName: "Before Inbox v2",
        organizationSlug: "before",
        entities: ["vendors", "phOrgTaxProfile"],
      },
      data: {
        vendors: [{ name: "Old Vendor" }],
        phOrgTaxProfile: [{ registeredName: "OLD CORP", tin: "123456789" }],
        someFutureKey: { kept: true },
      },
    };

    it("gives an old file empty routines, rule snapshots and memories", () => {
      const result = migrateToLatest(v4);
      expect(result.meta).toEqual({ ...v4.meta, version: 5 });
      expect(result.data).toEqual({ ...v4.data, ...V5_EMPTY });
    });

    it("never mutates the file it was given", () => {
      const copy = structuredClone(v4);
      migrateToLatest(copy);
      expect(copy).toEqual(v4);
    });

    it("keeps any of the v5 arrays a v4 file somehow already has", () => {
      const withRoutines = { ...v4, data: { ...v4.data, routines: [{ name: "Kept" }] } };
      const result = migrateToLatest(withRoutines);
      expect(result.data.routines).toEqual([{ name: "Kept" }]);
      expect(result.data.ruleSnapshots).toEqual([]);
    });

    it("chains a v1 file through to v5", () => {
      const result = migrateToLatest(v1Sample);
      expect(result.meta.version).toBe(5);
      expect(result.data).toMatchObject(V5_EMPTY);
      expect((result.data.banks as unknown[]).length).toBe(1);
    });

    it("passes a v5 file through unchanged", () => {
      const result = migrateToLatest(v5Sample);
      expect(result).toBe(v5Sample);
      expect((result.data.routines as unknown[]).length).toBe(2);
    });
  });
});
