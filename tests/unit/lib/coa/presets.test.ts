import { describe, it, expect } from "vitest";
import { ACCOUNT_TYPES } from "@/db/schema/account-constants";
import { COA_PRESETS, listPresets, presetForIndustry, getPreset } from "@/lib/coa/presets";
import { allMappingKeys, mappingRowFor } from "@/lib/coa/mapping-registry";
import { flattenPresetAccounts } from "@/lib/coa/preset-types";
import { validatePreset } from "@/lib/coa/validate-preset";
import {
  OPERATING_SUBTYPES,
  INVESTING_SUBTYPES,
  FINANCING_SUBTYPES,
} from "@/lib/report-calculations";

const presets = listPresets();

describe.each(presets.map((p) => [p.id, p] as const))("preset: %s", (_id, preset) => {
  const flat = flattenPresetAccounts(preset.accounts);

  it("passes structural validation with no errors", () => {
    const errors = validatePreset(preset);
    expect(errors.map((e) => `${e.code}${e.key ? ` (${e.key})` : ""}: ${e.message}`)).toEqual([]);
  });

  it("has unique keys and unique account numbers", () => {
    const keys = flat.map((n) => n.account.key);
    const numbers = flat.map((n) => n.account.accountNumber);
    expect(new Set(keys).size).toBe(keys.length);
    expect(new Set(numbers).size).toBe(numbers.length);
  });

  it("has exactly one system root per account type", () => {
    const roots = flat.filter((n) => n.depth === 0);
    expect(roots).toHaveLength(ACCOUNT_TYPES.length);
    expect(roots.every((r) => r.account.isSystem === true)).toBe(true);
    expect(new Set(roots.map((r) => r.account.accountType)).size).toBe(ACCOUNT_TYPES.length);
    // Only roots may be system — an AI- or user-created undeletable account
    // would be a permanent artifact the org cannot remove.
    expect(flat.filter((n) => n.depth > 0 && n.account.isSystem)).toEqual([]);
  });

  it("resolves every mapping row to a compatible account", () => {
    const byKey = new Map(flat.map((n) => [n.account.key, n.account]));
    const declared = new Map(
      preset.mappings.map((m) => [`${m.mappingType}:${m.sourceKey}`, m.targetKey]),
    );

    for (const { mappingType, sourceKey } of allMappingKeys()) {
      const row = mappingRowFor(mappingType, sourceKey)!;
      const targetKey = declared.get(`${mappingType}:${sourceKey}`);
      const target = targetKey
        ? byKey.get(targetKey)
        : flat.find(
            (n) =>
              n.account.subtype === row.defaultSubtype && n.account.accountType === row.ledgerType,
          )?.account;

      expect(target, `${mappingType}.${sourceKey} has no target`).toBeDefined();
      // The check that makes "map default_expense at a revenue account"
      // impossible, whether the mapping came from a preset or an agent.
      expect(
        target!.accountType,
        `${mappingType}.${sourceKey} -> ${target!.key} has the wrong account type`,
      ).toBe(row.ledgerType);
    }
  });

  it("never leaves a balance-sheet account out of the cash-flow statement", () => {
    // An unclassified balance-sheet subtype is silently dropped from cash flow,
    // so the statement stops tying with no error anywhere.
    const classified = new Set<string>([
      ...OPERATING_SUBTYPES,
      ...INVESTING_SUBTYPES,
      ...FINANCING_SUBTYPES,
      "bank_accounts",
    ]);
    const offenders = flat
      .filter(
        (n) =>
          n.depth > 0 &&
          ["asset", "liability", "equity"].includes(n.account.accountType) &&
          !classified.has(n.account.subtype ?? ""),
      )
      .map((n) => `${n.account.key} (${n.account.subtype})`);
    expect(offenders).toEqual([]);
  });

  it("declares no scaffolded entities", () => {
    // A financial_accounts row asserts a real account at a real institution.
    expect(preset.entities).toEqual([]);
  });
});

describe("preset catalog", () => {
  it("keys each preset by its own id", () => {
    for (const [id, preset] of Object.entries(COA_PRESETS)) {
      expect(preset.id).toBe(id);
      expect(preset.version).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
      expect(preset.description.length).toBeGreaterThan(0);
    }
  });

  it("claims each industry at most once", () => {
    const claimed = presets.flatMap((p) => p.industries);
    expect(new Set(claimed).size, "two presets claim the same industry").toBe(claimed.length);
  });

  it("falls back to the baseline for unknown or missing industries", () => {
    expect(presetForIndustry("technology").id).toBe("saas_startup");
    expect(presetForIndustry("retail").id).toBe("retail_ecommerce");
    expect(presetForIndustry("not_a_real_industry").id).toBe("general_small_business");
    expect(presetForIndustry(null).id).toBe("general_small_business");
  });

  it("getPreset returns null for an unknown id", () => {
    expect(getPreset("general_small_business")).not.toBeNull();
    expect(getPreset("nope")).toBeNull();
  });

  it("keeps the freelancer pack materially smaller than the baseline", () => {
    const size = (id: string) => flattenPresetAccounts(getPreset(id)!.accounts).length;
    expect(size("freelancer")).toBeLessThan(size("general_small_business") * 0.7);
  });
});
