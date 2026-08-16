/**
 * Pure helpers for composing preset account trees.
 *
 * Every pack is expressed as a diff on top of BASE_ACCOUNTS rather than as its
 * own copy, so a correction to a shared account lands everywhere at once.
 * These are values-in/values-out and never throw at module load — a bad
 * composition is reported by `validatePreset`, not by taking down SSR.
 */
import type { PresetAccount, PresetKey } from "./preset-types";

/** Add children under the named parent keys. Unknown keys are ignored here and reported by validatePreset. */
export function withChildren(
  accounts: readonly PresetAccount[],
  additions: Record<PresetKey, readonly PresetAccount[]>,
): readonly PresetAccount[] {
  return accounts.map((account) => {
    const extra = additions[account.key] ?? [];
    const children = account.children ? withChildren(account.children, additions) : undefined;
    if (extra.length === 0) {
      return children ? { ...account, children } : account;
    }
    return { ...account, children: [...(children ?? []), ...extra] };
  });
}

/** Replace fields on specific accounts, e.g. renaming one for a vertical. */
export function withOverrides(
  accounts: readonly PresetAccount[],
  overrides: Record<PresetKey, Partial<Omit<PresetAccount, "key" | "children">>>,
): readonly PresetAccount[] {
  return accounts.map((account) => {
    const patch = overrides[account.key];
    const children = account.children ? withOverrides(account.children, overrides) : undefined;
    const next = patch ? { ...account, ...patch } : account;
    return children ? { ...next, children } : next;
  });
}

/**
 * Keep only the named accounts and their ancestors.
 *
 * Roots are always kept: the 8 root types are structural accounting facts and
 * every account must hang under one. A parent is kept when any descendant
 * survives, so callers name leaves rather than whole paths.
 */
export function pruneToKeys(
  accounts: readonly PresetAccount[],
  keep: ReadonlySet<PresetKey>,
  isRoot = true,
): readonly PresetAccount[] {
  const out: PresetAccount[] = [];
  for (const account of accounts) {
    const children = account.children ? pruneToKeys(account.children, keep, false) : [];
    const keepThis = isRoot || keep.has(account.key) || children.length > 0;
    if (!keepThis) continue;
    out.push(children.length > 0 ? { ...account, children } : { ...account, children: undefined });
  }
  return out;
}

export function findPresetAccount(
  accounts: readonly PresetAccount[],
  key: PresetKey,
): PresetAccount | null {
  for (const account of accounts) {
    if (account.key === key) return account;
    if (account.children) {
      const hit = findPresetAccount(account.children, key);
      if (hit) return hit;
    }
  }
  return null;
}
