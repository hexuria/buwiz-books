import { describe, it, expect } from "vitest";
import {
  ACCOUNT_SUBTYPES,
  ACCOUNT_TYPES,
  ACCOUNT_TYPE_RANGES,
  SUBTYPES_BY_TYPE,
  SUBTYPE_TO_TYPE,
  fallbackSubtypeFor,
  isSubtypeLegalForType,
  type AccountType,
} from "@/db/schema/account-constants";
import { SUBTYPE_LABELS } from "@/lib/coa/subtype-labels";

describe("SUBTYPES_BY_TYPE", () => {
  it("partitions ACCOUNT_SUBTYPES exactly — no duplicates, no orphans", () => {
    const grouped = ACCOUNT_TYPES.flatMap((type) => SUBTYPES_BY_TYPE[type]);
    // A subtype listed under two types would make SUBTYPE_TO_TYPE lossy and make
    // "is this legal here?" answerable two ways.
    expect(new Set(grouped).size, "a subtype appears under more than one type").toBe(
      grouped.length,
    );
    expect(new Set(ACCOUNT_SUBTYPES)).toEqual(new Set(grouped));
  });

  it("covers all 8 account types", () => {
    expect(Object.keys(SUBTYPES_BY_TYPE).sort()).toEqual([...ACCOUNT_TYPES].sort());
    for (const type of ACCOUNT_TYPES) {
      expect(SUBTYPES_BY_TYPE[type].length, `${type} has no subtypes`).toBeGreaterThan(0);
    }
  });

  it("SUBTYPE_TO_TYPE round-trips every subtype", () => {
    for (const subtype of ACCOUNT_SUBTYPES) {
      const type = SUBTYPE_TO_TYPE[subtype];
      expect(type, `no reverse mapping for "${subtype}"`).toBeDefined();
      expect(isSubtypeLegalForType(type, subtype)).toBe(true);
    }
  });

  it("rejects a subtype used under the wrong type", () => {
    expect(isSubtypeLegalForType("asset", "account_receivable")).toBe(true);
    expect(isSubtypeLegalForType("expense", "account_receivable")).toBe(false);
    expect(isSubtypeLegalForType("not_a_type", "account_receivable")).toBe(false);
    // The historical singular/plural trap: the canonical value is singular.
    expect(isSubtypeLegalForType("asset", "accounts_receivable")).toBe(false);
  });

  it("every fallback subtype is legal for its own type", () => {
    for (const type of ACCOUNT_TYPES) {
      expect(isSubtypeLegalForType(type, fallbackSubtypeFor(type as AccountType))).toBe(true);
    }
  });

  it("every subtype has a display label", () => {
    for (const subtype of ACCOUNT_SUBTYPES) {
      expect(SUBTYPE_LABELS[subtype], `missing label for "${subtype}"`).toBeTruthy();
    }
  });
});

describe("ACCOUNT_TYPE_RANGES", () => {
  it("covers every account type with a distinct 10000-aligned band", () => {
    const bands = ACCOUNT_TYPES.map((type) => ACCOUNT_TYPE_RANGES[type]);
    expect(bands.every((b) => b % 10000 === 0)).toBe(true);
    expect(new Set(bands).size, "two account types share a number range").toBe(bands.length);
  });

  it("puts other_income at 80000 and other_expense at 90000", () => {
    // A previous copy used 70000/80000, which made an auto-generated root-level
    // other_expense collide with the seeded "Other Income" root (80000).
    expect(ACCOUNT_TYPE_RANGES.other_income).toBe(80000);
    expect(ACCOUNT_TYPE_RANGES.other_expense).toBe(90000);
  });
});
