import { describe, it, expect } from "vitest";
import { BANK_MAPPING_CONFIG } from "../../../src/lib/bank-mapping-config";
import { BILL_MAPPING_CONFIG } from "../../../src/lib/bill-mapping-config";
import { INVOICE_MAPPING_CONFIG } from "../../../src/lib/invoice-mapping-config";
import type { MappingConfig } from "../../../src/components/shared/CategoryMappingSettings";

/**
 * Validates the structural integrity of all mapping configs.
 * These configs drive the Category Mappings UI and must have complete,
 * well-formed data or the settings page will silently render broken.
 */
describe("Category Mapping Configs", () => {
  const configs: Array<{ name: string; config: MappingConfig }> = [
    { name: "BANK_MAPPING_CONFIG", config: BANK_MAPPING_CONFIG },
    { name: "BILL_MAPPING_CONFIG", config: BILL_MAPPING_CONFIG },
    { name: "INVOICE_MAPPING_CONFIG", config: INVOICE_MAPPING_CONFIG },
  ];

  for (const { name, config } of configs) {
    describe(name, () => {
      it("should have a non-empty storageKey", () => {
        expect(config.storageKey).toBeTruthy();
        expect(typeof config.storageKey).toBe("string");
      });

      it("should have a title and description", () => {
        expect(config.title.length).toBeGreaterThan(0);
        expect(config.description.length).toBeGreaterThan(0);
      });

      it("should have at least one mapping row", () => {
        expect(config.rows.length).toBeGreaterThan(0);
      });

      it("should have unique type keys across all rows", () => {
        const types = config.rows.map((r) => r.type);
        const uniqueTypes = new Set(types);
        expect(uniqueTypes.size).toBe(types.length);
      });

      it("should have every row with required fields", () => {
        for (const row of config.rows) {
          expect(row.type).toBeTruthy();
          expect(row.label).toBeTruthy();
          expect(row.ledgerType).toBeTruthy();
          expect(row.defaultSubtype).toBeTruthy();
          expect(row.defaultName).toBeTruthy();
          expect(row.defaultNumber).toBeTruthy();
        }
      });

      it("should have valid ledgerType values", () => {
        const validTypes = [
          "asset",
          "liability",
          "equity",
          "revenue",
          "expense",
          "cost_of_revenue",
          "other_income",
          "other_expense",
        ];
        for (const row of config.rows) {
          expect(validTypes).toContain(row.ledgerType);
        }
      });
    });
  }

  // ── Cross-config uniqueness ─────────────────────────────────────────────

  it("should have unique storageKeys across all configs", () => {
    const keys = configs.map((c) => c.config.storageKey);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it("should have unique mappingTypes across all configs", () => {
    const types = configs.map((c) => c.config.mappingType);
    const uniqueTypes = new Set(types);
    expect(uniqueTypes.size).toBe(types.length);
  });
});
