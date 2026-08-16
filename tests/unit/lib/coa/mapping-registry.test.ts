import { describe, it, expect } from "vitest";
import {
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_RANGES,
  SUBTYPE_TO_TYPE,
  isSubtypeLegalForType,
} from "@/db/schema/account-constants";
import {
  ALL_MAPPING_CONFIGS,
  MAPPING_CONFIGS,
  allMappingKeys,
  isMappingTargetCompatible,
  mappingRowFor,
} from "@/lib/coa/mapping-registry";
import { MAPPING_TYPES } from "@/lib/coa/mapping-types";

describe("mapping registry", () => {
  it("registers every mapping type exactly once", () => {
    expect(Object.keys(MAPPING_CONFIGS).sort()).toEqual([...MAPPING_TYPES].sort());
    for (const type of MAPPING_TYPES) {
      expect(MAPPING_CONFIGS[type].mappingType).toBe(type);
    }
  });

  it("has unique sourceKeys within each config and unique storageKeys across them", () => {
    for (const config of ALL_MAPPING_CONFIGS) {
      const keys = config.rows.map((r) => r.type);
      expect(new Set(keys).size, `duplicate sourceKey in "${config.mappingType}"`).toBe(
        keys.length,
      );
      expect(config.rows.length).toBeGreaterThan(0);
    }
    const storageKeys = ALL_MAPPING_CONFIGS.map((c) => c.storageKey);
    expect(new Set(storageKeys).size).toBe(storageKeys.length);
  });

  it("allMappingKeys enumerates every row", () => {
    const total = ALL_MAPPING_CONFIGS.reduce((sum, c) => sum + c.rows.length, 0);
    expect(allMappingKeys()).toHaveLength(total);
  });
});

describe("mapping row defaults", () => {
  const rows = ALL_MAPPING_CONFIGS.flatMap((config) => config.rows.map((row) => ({ config, row })));

  it("every ledgerType is a real account type", () => {
    for (const { config, row } of rows) {
      expect(
        (ACCOUNT_TYPES as readonly string[]).includes(row.ledgerType),
        `${config.mappingType}.${row.type} has ledgerType "${row.ledgerType}"`,
      ).toBe(true);
    }
  });

  it("every defaultSubtype is a real subtype AND legal for its ledgerType", () => {
    // Without this, a mapping row can name a subtype no account will ever carry,
    // so its fallback silently never matches.
    for (const { config, row } of rows) {
      expect(
        SUBTYPE_TO_TYPE[row.defaultSubtype],
        `${config.mappingType}.${row.type}: "${row.defaultSubtype}" is not a canonical subtype`,
      ).toBeDefined();
      expect(
        isSubtypeLegalForType(row.ledgerType, row.defaultSubtype),
        `${config.mappingType}.${row.type}: "${row.defaultSubtype}" is not legal for "${row.ledgerType}"`,
      ).toBe(true);
    }
  });

  it("every defaultNumber falls inside its ledgerType's range", () => {
    // This is what catches a row pointing at a ROOT account's number (e.g. the
    // old accounts_payable -> 20000, which is the Liabilities root) or at a band
    // belonging to a different type.
    for (const { config, row } of rows) {
      const base = ACCOUNT_TYPE_RANGES[row.ledgerType];
      const value = Number(row.defaultNumber);
      expect(
        Number.isInteger(value),
        `${config.mappingType}.${row.type} number is not numeric`,
      ).toBe(true);
      expect(
        value >= base && value <= base + 9999,
        `${config.mappingType}.${row.type}: ${row.defaultNumber} is outside ${base}-${base + 9999} for "${row.ledgerType}"`,
      ).toBe(true);
    }
  });

  it("no defaultNumber is a bare root number", () => {
    // X0000 is the root account for that type; a mapping must target a real
    // posting account, and trying to create one at that number collides.
    for (const { config, row } of rows) {
      expect(
        Number(row.defaultNumber) % 10000,
        `${config.mappingType}.${row.type} targets root number ${row.defaultNumber}`,
      ).not.toBe(0);
    }
  });
});

describe("isMappingTargetCompatible", () => {
  it("accepts a matching account type and rejects a mismatched one", () => {
    const row = mappingRowFor("bill", "default_expense");
    expect(row).not.toBeNull();
    expect(isMappingTargetCompatible(row!, { accountType: "expense" })).toBe(true);
    // The injection case: mapping the default expense at a revenue account.
    expect(isMappingTargetCompatible(row!, { accountType: "revenue" })).toBe(false);
  });

  it("returns null for unknown mapping types or source keys", () => {
    expect(mappingRowFor("nope", "default_expense")).toBeNull();
    expect(mappingRowFor("bill", "nope")).toBeNull();
  });
});
