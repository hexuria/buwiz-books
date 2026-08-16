import { describe, it, expect } from "vitest";
import {
  getReadPartyTypes,
  getMutatePartyTypes,
  toPartyApiFilter,
  getDefaultPartyTypeForCreation,
  SUBTYPE_READ_MAP,
  SUBTYPE_MUTATE_MAP,
  type PartyType,
  type PartyMappingOverride,
} from "../../../src/lib/party-scoping";

describe("Party Scoping", () => {
  // ========================================================================
  // getReadPartyTypes — 3-tier resolution
  // ========================================================================

  describe("getReadPartyTypes", () => {
    it("should return system default for a known subtype", () => {
      const types = getReadPartyTypes("accounts_payable");
      expect(types).toEqual(["vendor"]);
    });

    it("should return multiple types for bank_accounts (vendor, customer, government, lender)", () => {
      const types = getReadPartyTypes("bank_accounts");
      expect(types).toContain("vendor");
      expect(types).toContain("customer");
      expect(types).toContain("government");
      expect(types).toContain("lender");
    });

    it("should return empty array for subtypes with no party association", () => {
      const types = getReadPartyTypes("asset_clearing");
      expect(types).toEqual([]);
    });

    it("should return empty array for unknown subtype and no transaction type", () => {
      const types = getReadPartyTypes("made_up_subtype");
      expect(types).toEqual([]);
    });

    it("should fall back to transaction type when subtype is null", () => {
      expect(getReadPartyTypes(null, "pay_out")).toEqual(["vendor"]);
      expect(getReadPartyTypes(null, "pay_in")).toEqual(["customer"]);
    });

    it("should return empty for journal/transfer transaction types", () => {
      expect(getReadPartyTypes(null, "journal")).toEqual([]);
      expect(getReadPartyTypes(null, "transfer")).toEqual([]);
    });

    // Tier 1: Account-level override
    it("should prioritize account-level readPartyTypes over everything else", () => {
      const types = getReadPartyTypes("accounts_payable", "pay_out", undefined, [
        "employee",
        "shareholder",
      ]);
      expect(types).toEqual(["employee", "shareholder"]);
    });

    // Tier 2: Org-level override
    it("should use org-level override when account-level is absent", () => {
      const overrides: Record<string, PartyMappingOverride> = {
        accounts_payable: {
          readTypes: ["lender", "government"],
          mutateTypes: ["lender"],
        },
      };
      const types = getReadPartyTypes("accounts_payable", undefined, overrides);
      expect(types).toEqual(["lender", "government"]);
    });

    // Tier 1 beats Tier 2
    it("should prefer account-level types over org-level overrides", () => {
      const overrides: Record<string, PartyMappingOverride> = {
        accounts_payable: {
          readTypes: ["lender"],
          mutateTypes: [],
        },
      };
      const types = getReadPartyTypes("accounts_payable", undefined, overrides, ["bank"]);
      expect(types).toEqual(["bank"]);
    });
  });

  // ========================================================================
  // getMutatePartyTypes — 3-tier resolution
  // ========================================================================

  describe("getMutatePartyTypes", () => {
    it("should return system default for a known subtype", () => {
      expect(getMutatePartyTypes("accounts_payable")).toEqual(["vendor"]);
    });

    it("should return 'bank' for credit_cards (differs from read map)", () => {
      expect(getMutatePartyTypes("credit_cards")).toEqual(["bank"]);
    });

    it("should fall back to vendor when no subtype or transaction type", () => {
      expect(getMutatePartyTypes()).toEqual(["vendor"]);
    });

    it("should fall back to vendor for pay_out, customer for pay_in", () => {
      expect(getMutatePartyTypes(null, "pay_out")).toEqual(["vendor"]);
      expect(getMutatePartyTypes(null, "pay_in")).toEqual(["customer"]);
    });

    it("should prioritize account-level mutatePartyTypes", () => {
      const types = getMutatePartyTypes("accounts_payable", undefined, undefined, ["shareholder"]);
      expect(types).toEqual(["shareholder"]);
    });
  });

  // ========================================================================
  // toPartyApiFilter
  // ========================================================================

  describe("toPartyApiFilter", () => {
    it('should return "all" for empty array', () => {
      expect(toPartyApiFilter([])).toBe("all");
    });

    it("should return the single type directly for one-element array", () => {
      expect(toPartyApiFilter(["vendor"])).toBe("vendor");
    });

    it("should return the full array for multiple types", () => {
      const types: PartyType[] = ["vendor", "customer"];
      expect(toPartyApiFilter(types)).toEqual(["vendor", "customer"]);
    });
  });

  // ========================================================================
  // getDefaultPartyTypeForCreation
  // ========================================================================

  describe("getDefaultPartyTypeForCreation", () => {
    it("should return the first mutate type for a known subtype", () => {
      expect(getDefaultPartyTypeForCreation("accounts_payable")).toBe("vendor");
      expect(getDefaultPartyTypeForCreation("sales_revenue")).toBe("customer");
    });

    it('should fall back to "vendor" when no types are available', () => {
      expect(getDefaultPartyTypeForCreation("asset_clearing")).toBe("vendor");
    });
  });

  // ========================================================================
  // Map consistency checks
  // ========================================================================

  describe("Map consistency", () => {
    it("should have the same keys in READ and MUTATE maps", () => {
      const readKeys = new Set(Object.keys(SUBTYPE_READ_MAP));
      const mutateKeys = new Set(Object.keys(SUBTYPE_MUTATE_MAP));

      // Every read key should exist in mutate
      for (const key of readKeys) {
        expect(mutateKeys.has(key)).toBe(true);
      }

      // Every mutate key should exist in read
      for (const key of mutateKeys) {
        expect(readKeys.has(key)).toBe(true);
      }
    });

    it("should only contain valid PartyType values in both maps", () => {
      const validTypes: PartyType[] = [
        "vendor",
        "customer",
        "both",
        "employee",
        "shareholder",
        "lender",
        "bank",
        "government",
        "other",
      ];

      for (const types of Object.values(SUBTYPE_READ_MAP)) {
        for (const t of types) {
          expect(validTypes).toContain(t);
        }
      }

      for (const types of Object.values(SUBTYPE_MUTATE_MAP)) {
        for (const t of types) {
          expect(validTypes).toContain(t);
        }
      }
    });
  });
});
