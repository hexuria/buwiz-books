import { describe, expect, it } from "vitest";
import { isLegacyExport, getExportVersion, EXPORT_VERSION } from "@/lib/export-versions";

describe("export-versions", () => {
  // ── isLegacyExport ────────────────────────────────────────────────────────

  describe("isLegacyExport", () => {
    it("returns true for v1 format with exportedAt and entities", () => {
      const v1 = {
        exportedAt: "2026-01-15T10:30:00.000Z",
        entities: { banks: [], vendors: [] },
      };
      expect(isLegacyExport(v1)).toBe(true);
    });

    it("returns false for v2 format with meta block", () => {
      const v2 = {
        meta: { version: 2, exportedAt: "2026-04-22T05:30:00.000Z" },
        data: { banks: [] },
      };
      expect(isLegacyExport(v2)).toBe(false);
    });

    it("returns false for null", () => {
      expect(isLegacyExport(null)).toBe(false);
    });

    it("returns false for undefined", () => {
      expect(isLegacyExport(undefined)).toBe(false);
    });

    it("returns false for arrays", () => {
      expect(isLegacyExport([1, 2, 3])).toBe(false);
    });

    it("returns false for empty object", () => {
      expect(isLegacyExport({})).toBe(false);
    });

    it("returns false for object with exportedAt but no entities", () => {
      expect(isLegacyExport({ exportedAt: "2026-01-01" })).toBe(false);
    });

    it("returns false for object with entities but no exportedAt", () => {
      expect(isLegacyExport({ entities: { banks: [] } })).toBe(false);
    });
  });

  // ── getExportVersion ──────────────────────────────────────────────────────

  describe("getExportVersion", () => {
    it("returns 1 for legacy v1 format", () => {
      const v1 = {
        exportedAt: "2026-01-15T10:30:00.000Z",
        entities: { banks: [] },
      };
      expect(getExportVersion(v1)).toBe(1);
    });

    it("returns 2 for v2 format with meta.version = 2", () => {
      const v2 = {
        meta: { version: 2, exportedAt: "2026-04-22T05:30:00.000Z" },
        data: {},
      };
      expect(getExportVersion(v2)).toBe(2);
    });

    it("returns the correct version for any meta.version value", () => {
      const future = {
        meta: { version: 99 },
        data: {},
      };
      expect(getExportVersion(future)).toBe(99);
    });

    it("returns 0 for unrecognized format (empty object)", () => {
      expect(getExportVersion({})).toBe(0);
    });

    it("returns 0 for null", () => {
      expect(getExportVersion(null)).toBe(0);
    });

    it("returns 0 for a plain string", () => {
      expect(getExportVersion("not a valid export")).toBe(0);
    });

    it("returns 0 for a number", () => {
      expect(getExportVersion(42)).toBe(0);
    });
  });

  // ── EXPORT_VERSION constant ───────────────────────────────────────────────

  describe("EXPORT_VERSION", () => {
    it("is a positive integer", () => {
      expect(Number.isInteger(EXPORT_VERSION)).toBe(true);
      expect(EXPORT_VERSION).toBeGreaterThan(0);
    });

    it("is currently 2", () => {
      expect(EXPORT_VERSION).toBe(2);
    });
  });
});
