/**
 * Preset planner — PURE and synchronous.
 *
 * `previewCoaPreset` and `applyCoaPreset` run this same function, so what the
 * user approves is exactly what executes. Being database-free also makes every
 * conflict case a table-driven unit test.
 *
 * The planner never mutates an existing account beyond filling a NULL subtype:
 * an account may already carry journal lines, and renaming, retyping, or
 * reparenting one silently re-classifies posted history.
 */
import { createHash } from "node:crypto";
import {
  ACCOUNT_TYPE_RANGES,
  type AccountSubtype,
  type AccountType,
} from "../../db/schema/account-constants";
import { allMappingKeys, mappingRowFor } from "./mapping-registry";
import type { MappingType } from "./mapping-types";
import { flattenPresetAccounts, type CoaPreset, type PresetKey } from "./preset-types";

export interface ExistingAccount {
  id: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  subtype: string | null;
  parentId: string | null;
  isActive: boolean;
  isSystem: boolean;
}

export interface ExistingMapping {
  mappingType: string;
  sourceKey: string;
  targetCategoryId: string;
}

export interface CoaSnapshot {
  accounts: ExistingAccount[];
  mappings: ExistingMapping[];
}

export interface PlanOptions {
  /** What to do when a preset number is held by an account of a different type. */
  onConflict: "abort" | "renumber";
  /** Fill a NULL subtype on a reused account. Never overwrites a non-null one. */
  fillMissingSubtypes: boolean;
  /** Overwrite a mapping a human already set. Off by default. */
  overwriteExistingMappings: boolean;
  /** Create `financial_accounts` rows declared by the preset. Off by default. */
  createScaffoldEntities: boolean;
  /**
   * Synthesize an account for any mapping row nothing satisfies, and assert
   * completeness afterwards.
   *
   * On for the deterministic presets — that is the whole completeness
   * guarantee. OFF for a reviewed batch (the AI applier): a reviewer who
   * approved "add 6 accounts" must not silently receive twenty synthesized
   * ones because the org happened to be missing an unrelated mapping.
   */
  fillMappingGaps: boolean;
}

const DEFAULT_OPTIONS: PlanOptions = {
  onConflict: "abort",
  fillMissingSubtypes: true,
  overwriteExistingMappings: false,
  createScaffoldEntities: false,
  fillMappingGaps: true,
};

export interface PlannedAccount {
  key: PresetKey;
  name: string;
  accountNumber: string;
  accountType: AccountType;
  subtype: AccountSubtype | null;
  icon: string;
  description: string | null;
  isSystem: boolean;
  depth: number;
  /** Set when the parent already exists in the org. */
  parentAccountId: string | null;
  /** Set when the parent is another planned account. */
  parentKey: PresetKey | null;
  /** Present when the preset's preferred number was taken. */
  renumberedFrom?: string;
  /** Present when the account was synthesized to satisfy a mapping row. */
  synthesizedFor?: string;
}

export interface ReusedAccount {
  key: PresetKey;
  accountId: string;
  name: string;
  accountNumber: string | null;
  matchedBy: "number" | "name";
}

export interface SubtypeFill {
  accountId: string;
  key: PresetKey;
  name: string;
  subtype: AccountSubtype;
}

export type MappingSource = "preset" | "subtype" | "created" | "existing";

export interface PlannedMapping {
  mappingType: MappingType;
  sourceKey: string;
  /** Set when the target is an account that already exists. */
  targetAccountId: string | null;
  /** Set when the target is an account this plan creates. */
  targetKey: PresetKey | null;
  source: MappingSource;
  /** True when a human mapping already exists and is being left alone. */
  skipped: boolean;
}

export interface PresetConflict {
  key: PresetKey;
  accountNumber: string;
  existingAccountId: string;
  existingAccountType: string;
  presetAccountType: AccountType;
  resolution: "abort" | "renumber";
}

export interface PlannedEntity {
  key: PresetKey;
  accountName: string;
  accountType: string;
  ledgerAccountKey: PresetKey;
  institutionName: string | null;
}

export interface PresetPlan {
  presetId: string;
  presetVersion: number;
  options: PlanOptions;
  createAccounts: PlannedAccount[];
  reuseAccounts: ReusedAccount[];
  subtypeFills: SubtypeFill[];
  mappings: PlannedMapping[];
  entities: PlannedEntity[];
  conflicts: PresetConflict[];
  warnings: string[];
  /** Stable over identical inputs; guards the preview-then-apply round trip. */
  planHash: string;
}

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/** Deterministic ordering so two accounts sharing a subtype always resolve the same way. */
function compareCandidates(
  a: { accountNumber: string | null; name: string; id: string },
  b: { accountNumber: string | null; name: string; id: string },
  preferredNumber: string,
): number {
  const aPreferred = a.accountNumber === preferredNumber ? 0 : 1;
  const bPreferred = b.accountNumber === preferredNumber ? 0 : 1;
  if (aPreferred !== bPreferred) return aPreferred - bPreferred;
  // NULL account numbers sort last.
  if (a.accountNumber !== b.accountNumber) {
    if (a.accountNumber === null) return 1;
    if (b.accountNumber === null) return -1;
    return a.accountNumber.localeCompare(b.accountNumber);
  }
  if (a.name !== b.name) return a.name.localeCompare(b.name);
  return a.id.localeCompare(b.id);
}

export function planCoaPreset(
  snapshot: CoaSnapshot,
  preset: CoaPreset,
  overrides: Partial<PlanOptions> = {},
): PresetPlan {
  const options: PlanOptions = { ...DEFAULT_OPTIONS, ...overrides };

  const createAccounts: PlannedAccount[] = [];
  const reuseAccounts: ReusedAccount[] = [];
  const subtypeFills: SubtypeFill[] = [];
  const conflicts: PresetConflict[] = [];
  const warnings: string[] = [];

  const byNumber = new Map<string, ExistingAccount>();
  const byName = new Map<string, ExistingAccount[]>();
  const usedNumbers = new Set<string>();
  for (const account of snapshot.accounts) {
    if (account.accountNumber) {
      byNumber.set(account.accountNumber, account);
      usedNumbers.add(account.accountNumber);
    }
    const nameKey = normalizeName(account.name);
    const bucket = byName.get(nameKey);
    if (bucket) bucket.push(account);
    else byName.set(nameKey, [account]);
  }

  /** Next free number in a type's band, tracked in-memory so there are no per-allocation queries. */
  const nextFreeNumber = (accountType: AccountType, preferred: string): string => {
    if (!usedNumbers.has(preferred)) {
      usedNumbers.add(preferred);
      return preferred;
    }
    const base = ACCOUNT_TYPE_RANGES[accountType];
    for (let candidate = base + 1; candidate <= base + 9999; candidate++) {
      const str = String(candidate);
      if (!usedNumbers.has(str)) {
        usedNumbers.add(str);
        return str;
      }
    }
    throw new Error(`No free account number remains in the ${accountType} range`);
  };

  // Resolution of a preset key to either an existing account or a planned one.
  type Resolved =
    | { kind: "existing"; account: ExistingAccount }
    | { kind: "planned"; planned: PlannedAccount };
  const resolved = new Map<PresetKey, Resolved>();

  // Depth-first, parent before child, so a parent is always resolved first.
  for (const { account, depth, parentKey } of flattenPresetAccounts(preset.accounts)) {
    // 1) accountNumber is the only column with a DB uniqueness guarantee, so it wins.
    const numberMatch = byNumber.get(account.accountNumber);
    if (numberMatch) {
      if (numberMatch.accountType !== account.accountType) {
        // Never mutate: journal lines may reference this account, and flipping
        // its type flips its sign convention across every posted period.
        conflicts.push({
          key: account.key,
          accountNumber: account.accountNumber,
          existingAccountId: numberMatch.id,
          existingAccountType: numberMatch.accountType,
          presetAccountType: account.accountType,
          resolution: options.onConflict,
        });
        if (options.onConflict === "abort") continue;
      } else {
        reuseAccounts.push({
          key: account.key,
          accountId: numberMatch.id,
          name: numberMatch.name,
          accountNumber: numberMatch.accountNumber,
          matchedBy: "number",
        });
        resolved.set(account.key, { kind: "existing", account: numberMatch });
        if (!numberMatch.subtype && account.subtype && options.fillMissingSubtypes) {
          // The one deliberate mutation, and strictly a repair: a NULL subtype
          // is already dropped from the cash-flow statement.
          subtypeFills.push({
            accountId: numberMatch.id,
            key: account.key,
            name: numberMatch.name,
            subtype: account.subtype,
          });
        } else if (
          numberMatch.subtype &&
          account.subtype &&
          numberMatch.subtype !== account.subtype
        ) {
          warnings.push(
            `"${numberMatch.name}" keeps its subtype "${numberMatch.subtype}" (preset expects "${account.subtype}")`,
          );
        }
        if (!numberMatch.isActive) {
          warnings.push(`"${numberMatch.name}" is inactive and was not reactivated`);
        }
        continue;
      }
    }

    // 2) name + same type. Name is not unique in the schema, so tie-break stably.
    if (!numberMatch) {
      const nameMatches = (byName.get(normalizeName(account.name)) ?? []).filter(
        (candidate) => candidate.accountType === account.accountType,
      );
      if (nameMatches.length > 0) {
        const chosen = [...nameMatches].sort((a, b) =>
          compareCandidates(a, b, account.accountNumber),
        )[0];
        reuseAccounts.push({
          key: account.key,
          accountId: chosen.id,
          name: chosen.name,
          accountNumber: chosen.accountNumber,
          matchedBy: "name",
        });
        resolved.set(account.key, { kind: "existing", account: chosen });
        if (!chosen.subtype && account.subtype && options.fillMissingSubtypes) {
          subtypeFills.push({
            accountId: chosen.id,
            key: account.key,
            name: chosen.name,
            subtype: account.subtype,
          });
        }
        if (nameMatches.length > 1) {
          warnings.push(
            `"${account.name}" matched ${nameMatches.length} existing accounts; used ${chosen.accountNumber ?? chosen.id}`,
          );
        }
        continue;
      }
    }

    // 3) create.
    const parent = parentKey ? resolved.get(parentKey) : undefined;
    if (parentKey && !parent) {
      // Only reachable when the parent hit an aborted conflict.
      warnings.push(`"${account.name}" skipped: its parent could not be resolved`);
      continue;
    }
    const assignedNumber = nextFreeNumber(account.accountType, account.accountNumber);
    const planned: PlannedAccount = {
      key: account.key,
      name: account.name,
      accountNumber: assignedNumber,
      accountType: account.accountType,
      subtype: account.subtype,
      icon: account.icon,
      description: account.description ?? null,
      isSystem: account.isSystem === true,
      depth,
      parentAccountId: parent?.kind === "existing" ? parent.account.id : null,
      parentKey: parent?.kind === "planned" ? parent.planned.key : null,
      ...(assignedNumber !== account.accountNumber
        ? { renumberedFrom: account.accountNumber }
        : {}),
    };
    createAccounts.push(planned);
    resolved.set(account.key, { kind: "planned", planned });
  }

  // ── Mapping completeness ────────────────────────────────────────────────
  // Walk EVERY row of every config, not just the ones the preset declares.
  const presetAssignments = new Map(
    preset.mappings.map((m) => [`${m.mappingType}:${m.sourceKey}`, m.targetKey]),
  );
  const existingMappings = new Set(snapshot.mappings.map((m) => `${m.mappingType}:${m.sourceKey}`));
  const mappings: PlannedMapping[] = [];

  for (const { mappingType, sourceKey } of allMappingKeys()) {
    const row = mappingRowFor(mappingType, sourceKey);
    if (!row) continue;
    const composite = `${mappingType}:${sourceKey}`;

    if (existingMappings.has(composite) && !options.overwriteExistingMappings) {
      mappings.push({
        mappingType,
        sourceKey,
        targetAccountId: null,
        targetKey: null,
        source: "existing",
        skipped: true,
      });
      continue;
    }

    const push = (target: Resolved, source: MappingSource) =>
      mappings.push({
        mappingType,
        sourceKey,
        targetAccountId: target.kind === "existing" ? target.account.id : null,
        targetKey: target.kind === "planned" ? target.planned.key : null,
        source,
        skipped: false,
      });

    // 1) explicit preset assignment
    const assignedKey = presetAssignments.get(composite);
    const assigned = assignedKey ? resolved.get(assignedKey) : undefined;
    if (assigned) {
      push(assigned, "preset");
      continue;
    }

    // 2) subtype match across existing ∪ planned, restricted to the row's ledger type
    const existingCandidates = snapshot.accounts
      .filter(
        (a) => a.isActive && a.accountType === row.ledgerType && a.subtype === row.defaultSubtype,
      )
      .sort((a, b) => compareCandidates(a, b, row.defaultNumber));
    if (existingCandidates.length > 0) {
      push({ kind: "existing", account: existingCandidates[0] }, "subtype");
      continue;
    }
    const plannedCandidate = createAccounts
      .filter((a) => a.accountType === row.ledgerType && a.subtype === row.defaultSubtype)
      .sort((a, b) =>
        compareCandidates(
          { accountNumber: a.accountNumber, name: a.name, id: a.key },
          { accountNumber: b.accountNumber, name: b.name, id: b.key },
          row.defaultNumber,
        ),
      )[0];
    if (plannedCandidate) {
      push({ kind: "planned", planned: plannedCandidate }, "subtype");
      continue;
    }

    // 3) synthesize from the mapping row itself, under the root for its type
    if (!options.fillMappingGaps) continue;
    const root =
      [...resolved.values()].find((r) =>
        r.kind === "existing"
          ? r.account.accountType === row.ledgerType && r.account.parentId === null
          : r.planned.accountType === row.ledgerType && r.planned.depth === 0,
      ) ?? null;
    const synthesized: PlannedAccount = {
      key: `__synth_${mappingType}_${sourceKey}`,
      name: row.defaultName,
      accountNumber: nextFreeNumber(row.ledgerType, row.defaultNumber),
      accountType: row.ledgerType,
      subtype: row.defaultSubtype,
      icon: row.icon,
      description: null,
      isSystem: false,
      depth: 1,
      parentAccountId: root?.kind === "existing" ? root.account.id : null,
      parentKey: root?.kind === "planned" ? root.planned.key : null,
      synthesizedFor: composite,
    };
    createAccounts.push(synthesized);
    resolved.set(synthesized.key, { kind: "planned", planned: synthesized });
    push({ kind: "planned", planned: synthesized }, "created");
  }

  const entities: PlannedEntity[] = options.createScaffoldEntities
    ? preset.entities.map((entity) => ({
        key: entity.key,
        accountName: entity.accountName,
        accountType: entity.accountType,
        ledgerAccountKey: entity.ledgerAccountKey,
        institutionName: entity.institutionName ?? null,
      }))
    : [];

  const plan: Omit<PresetPlan, "planHash"> = {
    presetId: preset.id,
    presetVersion: preset.version,
    options,
    createAccounts,
    reuseAccounts,
    subtypeFills,
    mappings,
    entities,
    conflicts,
    warnings,
  };

  return { ...plan, planHash: hashPlan(plan) };
}

function hashPlan(plan: Omit<PresetPlan, "planHash">): string {
  const stable = JSON.stringify({
    presetId: plan.presetId,
    presetVersion: plan.presetVersion,
    options: plan.options,
    create: plan.createAccounts.map((a) => [
      a.key,
      a.accountNumber,
      a.parentAccountId,
      a.parentKey,
    ]),
    reuse: plan.reuseAccounts.map((a) => [a.key, a.accountId]),
    fills: plan.subtypeFills.map((f) => [f.accountId, f.subtype]),
    mappings: plan.mappings.map((m) => [
      m.mappingType,
      m.sourceKey,
      m.targetAccountId,
      m.targetKey,
      m.skipped,
    ]),
    conflicts: plan.conflicts.map((c) => [c.key, c.existingAccountId]),
  });
  return createHash("sha256").update(stable).digest("hex").slice(0, 32);
}

/** True when the plan would change nothing. */
export function isNoopPlan(plan: PresetPlan): boolean {
  return (
    plan.createAccounts.length === 0 &&
    plan.subtypeFills.length === 0 &&
    plan.mappings.every((m) => m.skipped)
  );
}
