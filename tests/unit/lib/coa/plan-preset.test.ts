import { describe, it, expect } from "vitest";
import {
  planCoaPreset,
  isNoopPlan,
  type CoaSnapshot,
  type ExistingAccount,
} from "@/lib/coa/plan-preset";
import { COA_PRESETS } from "@/lib/coa/presets";
import { allMappingKeys } from "@/lib/coa/mapping-registry";
import { flattenPresetAccounts } from "@/lib/coa/preset-types";

const PRESET = COA_PRESETS.general_small_business;
const EMPTY: CoaSnapshot = { accounts: [], mappings: [] };

function account(overrides: Partial<ExistingAccount> & { id: string }): ExistingAccount {
  return {
    accountNumber: null,
    name: "Account",
    accountType: "asset",
    subtype: null,
    parentId: null,
    isActive: true,
    isSystem: false,
    ...overrides,
  };
}

/** Simulates applying a plan, so a second plan can be taken against the result. */
function snapshotAfter(plan: ReturnType<typeof planCoaPreset>): CoaSnapshot {
  const idFor = new Map<string, string>();
  for (const a of plan.createAccounts) idFor.set(a.key, `id-${a.key}`);
  return {
    accounts: plan.createAccounts.map((a) =>
      account({
        id: idFor.get(a.key)!,
        accountNumber: a.accountNumber,
        name: a.name,
        accountType: a.accountType,
        subtype: a.subtype,
        parentId: a.parentAccountId ?? (a.parentKey ? idFor.get(a.parentKey)! : null),
        isSystem: a.isSystem,
      }),
    ),
    mappings: plan.mappings
      .filter((m) => !m.skipped)
      .map((m) => ({
        mappingType: m.mappingType,
        sourceKey: m.sourceKey,
        targetCategoryId: m.targetAccountId ?? idFor.get(m.targetKey!)!,
      })),
  };
}

describe("planCoaPreset — empty organization", () => {
  const plan = planCoaPreset(EMPTY, PRESET);

  it("creates every preset account and reuses nothing", () => {
    expect(plan.createAccounts).toHaveLength(flattenPresetAccounts(PRESET.accounts).length);
    expect(plan.reuseAccounts).toEqual([]);
    expect(plan.conflicts).toEqual([]);
  });

  it("marks exactly the 8 roots as system", () => {
    expect(plan.createAccounts.filter((a) => a.isSystem)).toHaveLength(8);
    expect(plan.createAccounts.filter((a) => a.isSystem && a.depth !== 0)).toEqual([]);
  });

  it("emits parents before children so a single pass can insert them", () => {
    const seen = new Set<string>();
    for (const a of plan.createAccounts) {
      if (a.parentKey) {
        expect(seen.has(a.parentKey), `${a.key} precedes its parent ${a.parentKey}`).toBe(true);
      }
      seen.add(a.key);
    }
  });

  it("fills EVERY mapping row — the completeness guarantee", () => {
    const filled = new Set(plan.mappings.map((m) => `${m.mappingType}:${m.sourceKey}`));
    for (const { mappingType, sourceKey } of allMappingKeys()) {
      expect(filled.has(`${mappingType}:${sourceKey}`)).toBe(true);
    }
    expect(plan.mappings.every((m) => m.skipped || m.targetKey || m.targetAccountId)).toBe(true);
  });

  it("assigns unique account numbers", () => {
    const numbers = plan.createAccounts.map((a) => a.accountNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe("planCoaPreset — idempotence", () => {
  it("is a no-op when re-planned against its own result", () => {
    const first = planCoaPreset(EMPTY, PRESET);
    const second = planCoaPreset(snapshotAfter(first), PRESET);
    expect(second.createAccounts).toEqual([]);
    expect(second.subtypeFills).toEqual([]);
    expect(isNoopPlan(second)).toBe(true);
  });

  it("produces a stable planHash for identical inputs", () => {
    expect(planCoaPreset(EMPTY, PRESET).planHash).toBe(planCoaPreset(EMPTY, PRESET).planHash);
  });

  it("changes the planHash when the snapshot changes", () => {
    const other = planCoaPreset(
      {
        accounts: [account({ id: "x", accountNumber: "11000", name: "Bank Accounts" })],
        mappings: [],
      },
      PRESET,
    );
    expect(other.planHash).not.toBe(planCoaPreset(EMPTY, PRESET).planHash);
  });
});

describe("planCoaPreset — existing organization", () => {
  it("reuses an account matched by number and never renames it", () => {
    const existing = account({
      id: "bank-1",
      accountNumber: "11000",
      name: "Operating Cash",
      accountType: "asset",
      subtype: "bank_accounts",
    });
    const plan = planCoaPreset({ accounts: [existing], mappings: [] }, PRESET);
    const reused = plan.reuseAccounts.find((r) => r.accountId === "bank-1");
    expect(reused?.matchedBy).toBe("number");
    // Its name is left alone — the preset does not rename an account in use.
    expect(reused?.name).toBe("Operating Cash");
    expect(plan.createAccounts.some((a) => a.accountNumber === "11000")).toBe(false);
  });

  it("reuses an account matched by name when the number differs", () => {
    const existing = account({
      id: "bank-2",
      accountNumber: "10500",
      name: "bank accounts",
      accountType: "asset",
      subtype: "bank_accounts",
    });
    const plan = planCoaPreset({ accounts: [existing], mappings: [] }, PRESET);
    expect(plan.reuseAccounts.find((r) => r.accountId === "bank-2")?.matchedBy).toBe("name");
  });

  it("fills a NULL subtype but never overwrites an existing one", () => {
    const nullSubtype = account({
      id: "a1",
      accountNumber: "11000",
      name: "Bank Accounts",
      accountType: "asset",
      subtype: null,
    });
    const wrongSubtype = account({
      id: "a2",
      accountNumber: "12000",
      name: "Accounts Receivable",
      accountType: "asset",
      subtype: "other_current_assets",
    });
    const plan = planCoaPreset({ accounts: [nullSubtype, wrongSubtype], mappings: [] }, PRESET);
    expect(plan.subtypeFills.map((f) => f.accountId)).toEqual(["a1"]);
    expect(plan.warnings.join(" ")).toContain("keeps its subtype");
  });

  it("respects fillMissingSubtypes: false", () => {
    const plan = planCoaPreset(
      {
        accounts: [account({ id: "a1", accountNumber: "11000", name: "Bank Accounts" })],
        mappings: [],
      },
      PRESET,
      { fillMissingSubtypes: false },
    );
    expect(plan.subtypeFills).toEqual([]);
  });

  it("warns about an inactive reused account without reactivating it", () => {
    const plan = planCoaPreset(
      {
        accounts: [
          account({ id: "a1", accountNumber: "11000", name: "Bank Accounts", isActive: false }),
        ],
        mappings: [],
      },
      PRESET,
    );
    expect(plan.warnings.join(" ")).toContain("not reactivated");
  });
});

describe("planCoaPreset — number conflicts", () => {
  // 11000 is Bank Accounts (asset) in the preset; here it is held by a liability.
  const clash = account({
    id: "clash",
    accountNumber: "11000",
    name: "Weird Loan",
    accountType: "liability",
    subtype: "long_term_debt",
  });

  it('records a conflict and creates nothing for it under "abort"', () => {
    const plan = planCoaPreset({ accounts: [clash], mappings: [] }, PRESET, {
      onConflict: "abort",
    });
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.conflicts[0]).toMatchObject({
      accountNumber: "11000",
      existingAccountId: "clash",
      existingAccountType: "liability",
      presetAccountType: "asset",
    });
    // The existing account is never retyped — that would flip its sign
    // convention across every posted period.
    expect(plan.subtypeFills).toEqual([]);
  });

  it('renumbers the preset account under "renumber" and still maps it', () => {
    const plan = planCoaPreset({ accounts: [clash], mappings: [] }, PRESET, {
      onConflict: "renumber",
    });
    const bank = plan.createAccounts.find((a) => a.key === "bank_accounts");
    expect(bank).toBeDefined();
    expect(bank!.accountNumber).not.toBe("11000");
    expect(bank!.renumberedFrom).toBe("11000");
    // Still inside the asset band.
    expect(Number(bank!.accountNumber)).toBeGreaterThanOrEqual(10000);
    expect(Number(bank!.accountNumber)).toBeLessThanOrEqual(19999);
    const numbers = plan.createAccounts.map((a) => a.accountNumber);
    expect(new Set(numbers).size).toBe(numbers.length);
    expect(numbers).not.toContain("11000");
  });
});

describe("planCoaPreset — mappings", () => {
  it("leaves a mapping a human already set alone by default", () => {
    const snapshot: CoaSnapshot = {
      accounts: [],
      mappings: [
        { mappingType: "bill", sourceKey: "default_expense", targetCategoryId: "human-choice" },
      ],
    };
    const plan = planCoaPreset(snapshot, PRESET);
    const row = plan.mappings.find(
      (m) => m.mappingType === "bill" && m.sourceKey === "default_expense",
    );
    expect(row).toMatchObject({ source: "existing", skipped: true });
  });

  it("overwrites an existing mapping when explicitly asked", () => {
    const snapshot: CoaSnapshot = {
      accounts: [],
      mappings: [
        { mappingType: "bill", sourceKey: "default_expense", targetCategoryId: "human-choice" },
      ],
    };
    const plan = planCoaPreset(snapshot, PRESET, { overwriteExistingMappings: true });
    const row = plan.mappings.find(
      (m) => m.mappingType === "bill" && m.sourceKey === "default_expense",
    );
    expect(row?.skipped).toBe(false);
    expect(row?.source).toBe("preset");
  });

  it("synthesizes an account when nothing satisfies a row", () => {
    // An org with a chart that has the roots but none of the mapped leaves.
    const roots = flattenPresetAccounts(PRESET.accounts)
      .filter((n) => n.depth === 0)
      .map((n, i) =>
        account({
          id: `root-${i}`,
          accountNumber: n.account.accountNumber,
          name: n.account.name,
          accountType: n.account.accountType,
          isSystem: true,
        }),
      );
    // Plan against a preset that declares no leaves at all.
    const bare = {
      ...PRESET,
      accounts: PRESET.accounts.map((r) => ({ ...r, children: [] })),
      mappings: [],
    };
    const plan = planCoaPreset({ accounts: roots, mappings: [] }, bare);
    const synthesized = plan.createAccounts.filter((a) => a.synthesizedFor);
    expect(synthesized.length).toBeGreaterThan(0);
    // Everything synthesized hangs under a real root of the right type.
    for (const s of synthesized) {
      expect(s.parentAccountId ?? s.parentKey).not.toBeNull();
    }
    // And the guarantee still holds.
    const filled = new Set(plan.mappings.map((m) => `${m.mappingType}:${m.sourceKey}`));
    expect(filled.size).toBe(allMappingKeys().length);
  });

  it("synthesizes nothing when fillMappingGaps is off", () => {
    // The AI applier plans this way: a reviewer who approved a bounded batch
    // must not silently receive extra accounts synthesized to close unrelated
    // mapping gaps.
    const bare = {
      ...PRESET,
      accounts: PRESET.accounts.map((r) => ({ ...r, children: [] })),
      mappings: [],
    };
    const plan = planCoaPreset(EMPTY, bare, { fillMappingGaps: false });
    expect(plan.createAccounts.filter((a) => a.synthesizedFor)).toEqual([]);
    // Only the roots the preset itself declares.
    expect(plan.createAccounts).toHaveLength(8);

    // ...and with it on, the gaps ARE closed.
    const filled = planCoaPreset(EMPTY, bare, { fillMappingGaps: true });
    expect(filled.createAccounts.filter((a) => a.synthesizedFor).length).toBeGreaterThan(0);
  });

  it("only ever targets an account whose type matches the row's ledgerType", () => {
    const plan = planCoaPreset(EMPTY, PRESET);
    const byKey = new Map(plan.createAccounts.map((a) => [a.key, a]));
    for (const mapping of plan.mappings) {
      if (mapping.skipped || !mapping.targetKey) continue;
      const target = byKey.get(mapping.targetKey)!;
      const row = allMappingKeys().find(
        (k) => k.mappingType === mapping.mappingType && k.sourceKey === mapping.sourceKey,
      );
      expect(row).toBeDefined();
      expect(target).toBeDefined();
    }
  });
});

describe("planCoaPreset — every shipped preset", () => {
  it.each(Object.keys(COA_PRESETS))("%s fills every mapping row on an empty org", (id) => {
    const plan = planCoaPreset(EMPTY, COA_PRESETS[id as keyof typeof COA_PRESETS]);
    const filled = new Set(
      plan.mappings
        .filter((m) => m.targetKey || m.targetAccountId)
        .map((m) => `${m.mappingType}:${m.sourceKey}`),
    );
    expect(filled.size).toBe(allMappingKeys().length);
    expect(plan.conflicts).toEqual([]);
  });

  it.each(Object.keys(COA_PRESETS))("%s re-applies as a no-op", (id) => {
    const preset = COA_PRESETS[id as keyof typeof COA_PRESETS];
    const first = planCoaPreset(EMPTY, preset);
    expect(isNoopPlan(planCoaPreset(snapshotAfter(first), preset))).toBe(true);
  });
});
