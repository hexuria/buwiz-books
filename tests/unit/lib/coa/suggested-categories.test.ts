import { describe, it, expect } from "vitest";
import suggestedCategories from "@/lib/suggested-categories.json";
import { listPresets } from "@/lib/coa/presets";
import { flattenPresetAccounts } from "@/lib/coa/preset-types";
import { ACCOUNT_TYPES, isSubtypeLegalForType } from "@/db/schema/account-constants";

/**
 * `suggested-categories.json` feeds the "Create New" section of every category
 * picker on /transactions/new. It is hand-curated on purpose — its `keywords`
 * have no analogue in the preset tree, and its whole value is offering accounts
 * an org does NOT already have, so it cannot be generated from the chart.
 *
 * That curation is exactly why it drifted: 40 of 90 entries had carried an
 * `accountNumber` belonging to a DIFFERENT account (suggested "Accounts
 * Receivable" was 11000, which is Bank Accounts), and 23 named a parent
 * "Expenses" that does not exist. The number is now assigned server-side from
 * the resolved parent, and these assertions keep the rest tied to reality.
 */
type Suggestion = {
  name: string;
  accountType: string;
  subtype: string;
  parentName?: string;
  description?: string;
  keywords?: string[];
  accountNumber?: string;
};

const catalog = suggestedCategories as Suggestion[];

/** Suggestions may target any account across the shipped packs, not just the baseline. */
const presetAccountNames = new Set(
  listPresets()
    .flatMap((preset) => flattenPresetAccounts(preset.accounts))
    .map((node) => node.account.name.toLowerCase()),
);

describe("suggested-categories catalog", () => {
  it("is non-empty and free of duplicate names", () => {
    expect(catalog.length).toBeGreaterThan(50);
    // Names are React keys in the Combobox suggestion list, and the dedupe
    // against the existing chart is name-based too.
    const names = catalog.map((c) => c.name.toLowerCase());
    expect(new Set(names).size).toBe(names.length);
  });

  it("carries NO accountNumber", () => {
    // The regression that caused ~44% of picks to fail silently. Numbers are a
    // second source of truth that cannot track a per-org chart; `createAccount`
    // derives one from the chosen parent instead.
    const withNumbers = catalog.filter((c) => c.accountNumber !== undefined);
    expect(withNumbers.map((c) => c.name)).toEqual([]);
  });

  it("names a parent that actually exists in the shipped charts", () => {
    // An unresolvable parent fails SILENTLY to a root-level account, so this
    // can never be caught at runtime.
    const unresolved = catalog
      .filter((c) => c.parentName && !presetAccountNames.has(c.parentName.toLowerCase()))
      .map((c) => `${c.name} -> "${c.parentName}"`);
    expect(unresolved).toEqual([]);
  });

  it("uses a real account type and a subtype legal for it", () => {
    // Now that the suggestion's subtype is actually forwarded, an illegal pair
    // would be rejected by createAccountSchema and fail the whole submit.
    const bad = catalog
      .filter(
        (c) =>
          !(ACCOUNT_TYPES as readonly string[]).includes(c.accountType) ||
          !isSubtypeLegalForType(c.accountType, c.subtype),
      )
      .map((c) => `${c.name}: ${c.accountType}/${c.subtype}`);
    expect(bad).toEqual([]);
  });

  it("gives every entry keywords, since matching depends on them", () => {
    // filterCategorySuggestions matches on name OR keywords; an entry with none
    // is only findable by typing its exact name, which defeats the feature.
    const missing = catalog.filter((c) => !c.keywords?.length).map((c) => c.name);
    expect(missing).toEqual([]);
  });

  it("still offers a useful number of accounts a seeded org lacks", () => {
    // The catalog's purpose is suggesting what the org does NOT have. If it
    // ever collapses to the baseline chart, a seeded org sees nothing.
    const baseline = new Set(
      flattenPresetAccounts(
        listPresets().find((p) => p.id === "general_small_business")!.accounts,
      ).map((n) => n.account.name.toLowerCase()),
    );
    const novel = catalog.filter((c) => !baseline.has(c.name.toLowerCase()));
    expect(novel.length).toBeGreaterThan(50);
  });
});
