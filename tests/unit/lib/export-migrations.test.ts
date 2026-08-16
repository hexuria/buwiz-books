import { describe, expect, it } from "vitest";
import { migrateToLatest } from "@/lib/export-migrations";
import { EXPORT_VERSION } from "@/lib/export-versions";

// Load fixture files
import v1Sample from "../../fixtures/export-v1-sample.json";
import v2Sample from "../../fixtures/export-v2-sample.json";

describe("export-migrations", () => {
  // ── migrateToLatest ───────────────────────────────────────────────────────

  describe("migrateToLatest", () => {
    it("passes through v2 data unchanged", () => {
      const result = migrateToLatest(v2Sample);
      expect(result).toEqual(v2Sample);
    });

    it("preserves meta block on v2 passthrough", () => {
      const result = migrateToLatest(v2Sample);
      expect(result.meta.version).toBe(2);
      expect(result.meta.organizationName).toBe("Test Org");
      expect(result.meta.entities).toEqual(["categories", "departments", "vendors"]);
    });

    it("transforms v1 legacy format to v2", () => {
      const result = migrateToLatest(v1Sample);
      expect(result.meta).toBeDefined();
      expect(result.data).toBeDefined();
      expect(result.meta.version).toBe(EXPORT_VERSION);
    });

    it("sets meta.version = 2 after v1 migration", () => {
      const result = migrateToLatest(v1Sample);
      expect(result.meta.version).toBe(2);
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
      expect(result.meta.version).toBe(2);
      expect(result.meta.entities).toEqual([]);
      expect(result.data).toEqual({});
    });

    it("handles v1 with missing exportedAt gracefully", () => {
      // entities present but exportedAt is not a string — should still be treated as non-legacy
      const broken = { entities: { banks: [] } };
      // This should be version 0 since exportedAt is missing
      expect(() => migrateToLatest(broken)).toThrow(/Unrecognized export file format/);
    });
  });
});
