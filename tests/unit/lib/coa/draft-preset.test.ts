// ============================================================================
// The seam between AI-drafted accounts and the shared write path.
//
// `coaAccountsApplier` never inserts an account itself. It converts its
// payload into a CoaPreset and hands it to planCoaPreset + executeCoaPlan —
// the same code the deterministic presets use, which owns the advisory lock,
// level-by-level insertion, and the mapping-completeness postcondition.
//
// These tests pin the conversion, because it is the one place the two paths
// could silently drift: a drafted account that plans as a REUSE instead of a
// create, or one that loses its parent, writes nothing and reports success.
// ============================================================================
import { describe, expect, it } from "vitest";
import { buildDraftPreset } from "../../../../src/lib/ai/proposal-appliers/coa";
import { planCoaPreset, type ExistingAccount } from "../../../../src/lib/coa/plan-preset";
import { validateCoaDraft, type DraftAccountInput } from "../../../../src/lib/coa/validate-draft";

function account(overrides: Partial<ExistingAccount> & { id: string }): ExistingAccount {
  return {
    accountNumber: null,
    name: "Account",
    accountType: "expense",
    subtype: null,
    parentId: null,
    isActive: true,
    isSystem: false,
    ...overrides,
  };
}

const CHART: ExistingAccount[] = [
  account({
    id: "r-root",
    name: "Revenue",
    accountNumber: "40000",
    accountType: "revenue",
    isSystem: true,
  }),
  account({
    id: "sales",
    name: "Sales Revenue",
    accountNumber: "41000",
    accountType: "revenue",
    subtype: "sales_revenue",
    parentId: "r-root",
  }),
];

const KEYS = new Map([
  ["E0", "r-root"],
  ["E1", "sales"],
]);

const DRAFTS: DraftAccountInput[] = [
  {
    key: "D0",
    name: "Wholesale Revenue",
    accountType: "revenue",
    subtype: "sales_revenue",
    parentKey: "E0",
    parentDraftKey: "",
  },
  {
    key: "D1",
    name: "Cafe Accounts",
    accountType: "revenue",
    subtype: "sales_revenue",
    parentKey: "",
    parentDraftKey: "D0",
  },
];

function planFor(drafts: DraftAccountInput[], existing = CHART) {
  const validation = validateCoaDraft(drafts, { existing, parentKeys: KEYS });
  const preset = buildDraftPreset(validation.accounts, existing);
  return {
    validation,
    preset,
    plan: planCoaPreset({ accounts: existing, mappings: [] }, preset, {
      onConflict: "renumber",
      fillMissingSubtypes: false,
      overwriteExistingMappings: false,
      createScaffoldEntities: false,
    }),
  };
}

describe("buildDraftPreset", () => {
  it("nests drafted accounts under a REUSED node for their existing parent", () => {
    const { preset, plan } = planFor(DRAFTS);

    // One top-level node, and it is the existing Revenue root addressed by its
    // real account number — which is how the planner resolves it to a reuse.
    expect(preset.accounts).toHaveLength(1);
    expect(preset.accounts[0].accountNumber).toBe("40000");
    expect(plan.reuseAccounts.map((a) => a.accountId)).toContain("r-root");

    const created = plan.createAccounts.filter((a) => !a.synthesizedFor);
    expect(created.map((a) => a.name).sort()).toEqual(["Cafe Accounts", "Wholesale Revenue"]);
  });

  it("gives the depth-1 draft a real parent id and the depth-2 draft a planned parent", () => {
    const { plan } = planFor(DRAFTS);
    const wholesale = plan.createAccounts.find((a) => a.name === "Wholesale Revenue")!;
    const cafe = plan.createAccounts.find((a) => a.name === "Cafe Accounts")!;

    expect(wholesale.parentAccountId).toBe("r-root");
    expect(wholesale.parentKey).toBeNull();
    expect(wholesale.depth).toBe(1);

    // Resolved through the plan, so executeCoaPlan inserts the parent first.
    expect(cafe.parentAccountId).toBeNull();
    expect(cafe.parentKey).toBe("D0");
    expect(cafe.depth).toBe(2);
  });

  it("never marks a drafted account as a system account", () => {
    const { plan } = planFor(DRAFTS);
    for (const created of plan.createAccounts) expect(created.isSystem).toBe(false);
  });

  it("plans a CREATE, not a reuse — a drafted number is never a live one", () => {
    const { plan } = planFor(DRAFTS);
    const createdNames = plan.createAccounts.map((a) => a.name);
    expect(createdNames).not.toContain("Sales Revenue");
    // Nothing was renumbered, because validate-draft already picked free
    // numbers against this same chart.
    expect(plan.createAccounts.filter((a) => a.renumberedFrom)).toHaveLength(0);
  });

  it("mutates no existing account: no subtype fills, no conflicts", () => {
    const { plan } = planFor(DRAFTS);
    expect(plan.subtypeFills).toHaveLength(0);
    expect(plan.conflicts).toHaveLength(0);
  });

  it("leaves an already-mapped org's mappings alone", () => {
    const validation = validateCoaDraft(DRAFTS, { existing: CHART, parentKeys: KEYS });
    const preset = buildDraftPreset(validation.accounts, CHART);
    const plan = planCoaPreset(
      {
        accounts: CHART,
        mappings: [
          { mappingType: "invoice", sourceKey: "default_revenue", targetCategoryId: "sales" },
        ],
      },
      preset,
      {
        onConflict: "renumber",
        fillMissingSubtypes: false,
        overwriteExistingMappings: false,
        createScaffoldEntities: false,
      },
    );
    const revenueDefault = plan.mappings.find((m) => m.sourceKey === "default_revenue")!;
    expect(revenueDefault.skipped).toBe(true);
  });

  it("drops a drafted account whose existing parent vanished from the chart", () => {
    // buildDraftPreset cannot address a parent it has no number for, so the
    // group is omitted rather than silently re-rooted at the top level.
    const drafted = validateCoaDraft(DRAFTS, { existing: CHART, parentKeys: KEYS }).accounts;
    const preset = buildDraftPreset(drafted, []);
    expect(preset.accounts).toHaveLength(0);
  });
});
