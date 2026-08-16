/**
 * The deterministic gate between model output and a chart-of-accounts write.
 *
 * Everything the model can influence — account names, subtypes, parent links,
 * mapping targets — is re-derived here from the ORG'S OWN data. That is what
 * makes prompt injection inert: text planted in an account name (which
 * `src/lib/entity-creation.ts` writes straight from OCR output) can change
 * what the model *says*, and change nothing about what gets written.
 *
 * It runs twice. Once before a proposal row is created, so a reviewer only
 * ever sees rows that could actually be applied; and again inside the applier,
 * because a proposal payload is data at rest — between the two runs a parent
 * can be deleted, a name can be taken, and an account number can be claimed.
 *
 * Pure and database-free: the caller supplies the chart. Every rejection and
 * every repair is RETURNED, never swallowed — a silently dropped account is
 * indistinguishable from a model that never proposed it.
 */
import {
  ACCOUNT_TYPE_RANGES,
  fallbackSubtypeFor,
  isAccountType,
  isSubtypeLegalForType,
  type AccountSubtype,
  type AccountType,
} from "../../db/schema/account-constants";
import { stripControlChars } from "../ai/prompts/sanitize";
import { isMappingTargetCompatible, mappingRowFor } from "./mapping-registry";
import type { MappingType } from "./mapping-types";
import type { ExistingAccount } from "./plan-preset";

/**
 * Ceiling on accounts per proposal. Gemini cannot enforce `maxItems` and a Zod
 * `.max()` would fail the WHOLE response, so the cap lives here and reports
 * itself through `truncated`.
 */
export const MAX_DRAFT_ACCOUNTS = 60;

/** `accounts.name` is varchar(255). */
export const MAX_ACCOUNT_NAME_CHARS = 255;

/**
 * Drafted accounts are numbered from the top of their type's band, so they
 * sort after the deterministic preset's accounts and never squat on a number
 * a future preset version wants. Falls back to the whole band when full.
 */
const DRAFT_NUMBER_OFFSET = 9000;

// ============================================================================
// Inputs and results
// ============================================================================

export interface DraftAccountInput {
  key: string;
  name: string;
  accountType: string;
  subtype: string;
  /** Key into `DraftValidationContext.parentKeys`. */
  parentKey: string;
  /** Key of another entry in this same batch. */
  parentDraftKey: string;
  description?: string;
}

export interface DraftValidationContext {
  /** The org's live chart, as loaded by `loadCoaSnapshot`. */
  existing: ExistingAccount[];
  /**
   * The grounded parent namespace: key -> existing account id. Anything not in
   * here is not a parent, whatever the model claimed.
   */
  parentKeys: Map<string, string>;
  /** Defaults to MAX_DRAFT_ACCOUNTS. */
  maxAccounts?: number;
}

export type DraftAdjustmentCode =
  | "control_chars_stripped"
  | "name_truncated"
  | "subtype_repaired"
  | "parent_reassigned";

export interface DraftAdjustment {
  code: DraftAdjustmentCode;
  message: string;
}

/**
 * Subtypes that denote a SPECIFIC bank or card. Only the bank onboarding flow
 * may create these, because it writes the linked `financial_accounts` row too.
 */
const BANK_OWNED_SUBTYPES: ReadonlySet<string> = new Set(["bank_accounts", "credit_cards"]);

export type DraftRejectionCode =
  | "empty_key"
  | "empty_name"
  | "duplicate_key"
  | "duplicate_name_existing"
  | "duplicate_name_batch"
  | "illegal_account_type"
  | "no_type_root"
  | "no_free_account_number"
  | "bank_account_not_allowed"
  | "over_cap";

export interface DraftRejection {
  key: string;
  name: string;
  code: DraftRejectionCode;
  message: string;
}

export interface ValidatedDraftAccount {
  key: string;
  name: string;
  accountType: AccountType;
  subtype: AccountSubtype;
  description: string;
  /** Assigned here, free against the supplied chart at validation time. */
  accountNumber: string;
  /** Existing parent; null exactly when `parentDraftKey` is set. */
  parentAccountId: string | null;
  /** Another validated account in this batch; "" when parented existing. */
  parentDraftKey: string;
  /** 1 = under an existing account, 2 = under another drafted account. */
  depth: 1 | 2;
  /** Deterministic repairs, surfaced to the reviewer. */
  adjustments: DraftAdjustment[];
}

export interface CoaDraftValidation {
  accounts: ValidatedDraftAccount[];
  rejected: DraftRejection[];
  /** True when the model returned more accounts than the cap allows. */
  truncated: boolean;
}

// ============================================================================
// Accounts
// ============================================================================

function normalizeName(name: string): string {
  return name.trim().toLowerCase();
}

/**
 * Accounts a drafted account may be parented by.
 *
 * Active, and numbered. The number requirement is not cosmetic: the applier
 * addresses the parent through a synthesized preset, and the planner resolves
 * a preset node to an existing account by ACCOUNT NUMBER. It also happens to
 * exclude the accounts created outside the preset system — bank infrastructure
 * built from OCR-extracted names — which are precisely the ones a model should
 * not be reparenting onto.
 */
function eligibleParents(existing: ExistingAccount[]): Map<string, ExistingAccount> {
  const out = new Map<string, ExistingAccount>();
  for (const account of existing) {
    if (!account.isActive || !account.accountNumber) continue;
    out.set(account.id, account);
  }
  return out;
}

/**
 * The root account per type, used when a parent link cannot be honored.
 * Deterministic: system roots win, then the lowest account number.
 */
function typeRoots(existing: ExistingAccount[]): Map<string, ExistingAccount> {
  const roots = new Map<string, ExistingAccount>();
  const candidates = existing
    .filter((a) => a.isActive && a.accountNumber && a.parentId === null)
    .sort((a, b) => {
      if (a.isSystem !== b.isSystem) return a.isSystem ? -1 : 1;
      const byNumber = (a.accountNumber ?? "").localeCompare(b.accountNumber ?? "");
      return byNumber !== 0 ? byNumber : a.id.localeCompare(b.id);
    });
  for (const account of candidates) {
    if (!roots.has(account.accountType)) roots.set(account.accountType, account);
  }
  return roots;
}

/** First unclaimed number in a type's band, preferring the drafted sub-band. */
function allocateNumber(accountType: AccountType, used: Set<string>): string | null {
  const base = ACCOUNT_TYPE_RANGES[accountType];
  for (const start of [base + DRAFT_NUMBER_OFFSET, base + 1]) {
    for (let candidate = start; candidate <= base + 9999; candidate++) {
      const value = String(candidate);
      if (!used.has(value)) {
        used.add(value);
        return value;
      }
    }
  }
  return null;
}

interface PendingAccount {
  input: DraftAccountInput;
  key: string;
  name: string;
  accountType: AccountType;
  subtype: AccountSubtype;
  description: string;
  adjustments: DraftAdjustment[];
  /** Verbatim from the model — used for batch parenting, never for lookups. */
  rawParentDraftKey: string;
}

/**
 * Validate a batch of drafted accounts against a chart.
 *
 * Checks run in a fixed order (name, key, name collisions, type, subtype, then
 * parenting) so the same input always produces the same output — the applier's
 * second pass must be able to reproduce the first.
 */
export function validateCoaDraft(
  raw: DraftAccountInput[],
  ctx: DraftValidationContext,
): CoaDraftValidation {
  const cap = ctx.maxAccounts ?? MAX_DRAFT_ACCOUNTS;
  const rejected: DraftRejection[] = [];
  const pending: PendingAccount[] = [];
  let truncated = false;

  const existingNames = new Set(ctx.existing.map((a) => normalizeName(a.name)));
  const seenKeys = new Set<string>();
  const seenNames = new Set<string>();

  // ── Pass 1: per-account fields ────────────────────────────────────────
  for (const entry of raw) {
    const rawName = entry.name ?? "";
    const adjustments: DraftAdjustment[] = [];

    const stripped = stripControlChars(rawName);
    if (stripped !== rawName) {
      adjustments.push({
        code: "control_chars_stripped",
        message: "Removed control or bidirectional characters from the name",
      });
    }
    let name = stripped.trim();
    const key = (entry.key ?? "").trim();

    if (name.length === 0) {
      rejected.push({ key, name: "", code: "empty_name", message: "Account name was empty" });
      continue;
    }
    if (name.length > MAX_ACCOUNT_NAME_CHARS) {
      name = name.slice(0, MAX_ACCOUNT_NAME_CHARS).trim();
      adjustments.push({
        code: "name_truncated",
        message: `Name truncated to ${MAX_ACCOUNT_NAME_CHARS} characters`,
      });
    }

    if (pending.length >= cap) {
      truncated = true;
      rejected.push({
        key,
        name,
        code: "over_cap",
        message: `Only the first ${cap} accounts are kept`,
      });
      continue;
    }

    if (key.length === 0) {
      // Without a key the reviewer cannot exclude the row and no sibling can
      // reference it as a parent.
      rejected.push({ key, name, code: "empty_key", message: "Entry had no key" });
      continue;
    }
    if (seenKeys.has(key)) {
      rejected.push({ key, name, code: "duplicate_key", message: `Key "${key}" was reused` });
      continue;
    }

    const nameKey = normalizeName(name);
    if (existingNames.has(nameKey)) {
      rejected.push({
        key,
        name,
        code: "duplicate_name_existing",
        message: `"${name}" already exists in this chart`,
      });
      continue;
    }
    if (seenNames.has(nameKey)) {
      rejected.push({
        key,
        name,
        code: "duplicate_name_batch",
        message: `"${name}" was proposed more than once`,
      });
      continue;
    }

    const accountType = (entry.accountType ?? "").trim();
    if (!isAccountType(accountType)) {
      rejected.push({
        key,
        name,
        code: "illegal_account_type",
        message: `"${accountType}" is not an account type`,
      });
      continue;
    }

    const proposedSubtype = (entry.subtype ?? "").trim();
    let subtype: AccountSubtype;
    if (isSubtypeLegalForType(accountType, proposedSubtype)) {
      subtype = proposedSubtype;
    } else {
      subtype = fallbackSubtypeFor(accountType);
      adjustments.push({
        code: "subtype_repaired",
        message: proposedSubtype
          ? `Subtype "${proposedSubtype}" is not legal for ${accountType}; using "${subtype}"`
          : `No subtype supplied; using "${subtype}"`,
      });
    }

    // Checked on the RESOLVED subtype, so this only fires when the entry
    // genuinely claims to be a specific bank or card — a repaired subtype is
    // always an uncategorized_* bucket and never lands here.
    //
    // The prompt already tells the model not to propose these, and that is
    // demonstrably not enough: a description naming Chase, Wells Fargo and Amex
    // produced exactly those three accounts. Deterministic rules dispose.
    //
    // Two concrete harms beyond "the model invented a counterparty":
    //   * The ledger row has no `financial_accounts` sibling, so it can never
    //     reconcile or import a statement — it merely LOOKS like a bank account.
    //   * `ensureBankInfrastructure` matches financial accounts by name, so
    //     adding the real account later through the bank onboarding flow
    //     creates a SECOND ledger account and splits one bank's balance in two.
    if (BANK_OWNED_SUBTYPES.has(subtype)) {
      rejected.push({
        key,
        name,
        code: "bank_account_not_allowed",
        message: `"${name}" is a bank or card account. Add it under Entities → Banks so the ledger account and the linked financial account are created together.`,
      });
      continue;
    }

    seenKeys.add(key);
    seenNames.add(nameKey);
    pending.push({
      input: entry,
      key,
      name,
      accountType,
      subtype,
      description: stripControlChars(entry.description ?? "")
        .trim()
        .slice(0, 500),
      adjustments,
      rawParentDraftKey: (entry.parentDraftKey ?? "").trim(),
    });
  }

  // ── Pass 2: parenting ─────────────────────────────────────────────────
  // Batch-rooted entries resolve first so a child never sees a parent that
  // pass 2 is about to reject.
  const parents = eligibleParents(ctx.existing);
  const roots = typeRoots(ctx.existing);
  const resolved = new Map<string, ValidatedDraftAccount>();
  const accounts: ValidatedDraftAccount[] = [];

  const attachToExisting = (item: PendingAccount): ValidatedDraftAccount | null => {
    const adjustments = [...item.adjustments];
    const parentId = ctx.parentKeys.get((item.input.parentKey ?? "").trim());
    const parent = parentId ? parents.get(parentId) : undefined;

    let parentAccountId: string;
    if (parent && parent.accountType === item.accountType) {
      parentAccountId = parent.id;
    } else {
      const root = roots.get(item.accountType);
      if (!root) {
        rejected.push({
          key: item.key,
          name: item.name,
          code: "no_type_root",
          message: `This chart has no ${item.accountType} account to attach "${item.name}" to`,
        });
        return null;
      }
      parentAccountId = root.id;
      adjustments.push({
        code: "parent_reassigned",
        message: parent
          ? `Parent was a ${parent.accountType} account; attached to "${root.name}" instead`
          : `Proposed parent is not available; attached to "${root.name}" instead`,
      });
    }

    return {
      key: item.key,
      name: item.name,
      accountType: item.accountType,
      subtype: item.subtype,
      description: item.description,
      accountNumber: "",
      parentAccountId,
      parentDraftKey: "",
      depth: 1,
      adjustments,
    };
  };

  for (const item of pending) {
    if (item.rawParentDraftKey) continue;
    const account = attachToExisting(item);
    if (!account) continue;
    resolved.set(account.key, account);
    accounts.push(account);
  }

  for (const item of pending) {
    if (!item.rawParentDraftKey) continue;
    // The parent must already be resolved AND itself batch-rooted, which is
    // what caps depth at 2. Resolving batch-rooted entries in the pass above
    // means a normal parent-after-child emission order still works; a chain
    // that only becomes legal through another entry's own degradation may or
    // may not attach depending on emission order, which is acceptable because
    // every outcome is a legal tree and the applier re-runs this on the same
    // payload order, reproducing whatever the reviewer approved.
    const parent = resolved.get(item.rawParentDraftKey);
    const usable =
      parent !== undefined &&
      parent.key !== item.key &&
      parent.depth === 1 &&
      parent.accountType === item.accountType;

    if (!usable) {
      const account = attachToExisting(item);
      if (!account) continue;
      account.adjustments.push({
        code: "parent_reassigned",
        message:
          parent && parent.accountType !== item.accountType
            ? `Proposed parent "${parent.name}" is a ${parent.accountType} account`
            : `Proposed parent "${item.rawParentDraftKey}" is not a top-level account in this proposal`,
      });
      resolved.set(account.key, account);
      accounts.push(account);
      continue;
    }

    const account: ValidatedDraftAccount = {
      key: item.key,
      name: item.name,
      accountType: item.accountType,
      subtype: item.subtype,
      description: item.description,
      accountNumber: "",
      parentAccountId: null,
      parentDraftKey: parent.key,
      depth: 2,
      adjustments: item.adjustments,
    };
    resolved.set(account.key, account);
    accounts.push(account);
  }

  // ── Pass 3: numbering ─────────────────────────────────────────────────
  const used = new Set<string>();
  for (const account of ctx.existing) {
    if (account.accountNumber) used.add(account.accountNumber);
  }
  const numbered: ValidatedDraftAccount[] = [];
  const dropped = new Set<string>();
  for (const account of accounts) {
    const number = allocateNumber(account.accountType, used);
    if (!number) {
      dropped.add(account.key);
      rejected.push({
        key: account.key,
        name: account.name,
        code: "no_free_account_number",
        message: `No account number remains in the ${account.accountType} range`,
      });
      continue;
    }
    account.accountNumber = number;
    numbered.push(account);
  }

  // A dropped parent orphans its children; re-home them rather than emitting a
  // dangling reference the applier would have to interpret.
  const final: ValidatedDraftAccount[] = [];
  for (const account of numbered) {
    if (!account.parentDraftKey || !dropped.has(account.parentDraftKey)) {
      final.push(account);
      continue;
    }
    const root = roots.get(account.accountType);
    if (!root) {
      rejected.push({
        key: account.key,
        name: account.name,
        code: "no_type_root",
        message: `This chart has no ${account.accountType} account to attach "${account.name}" to`,
      });
      continue;
    }
    account.parentDraftKey = "";
    account.depth = 1;
    account.parentAccountId = root.id;
    account.adjustments.push({
      code: "parent_reassigned",
      message: `Proposed parent could not be created; attached to "${root.name}" instead`,
    });
    final.push(account);
  }

  return { accounts: final, rejected, truncated };
}

// ============================================================================
// Mappings
// ============================================================================

export interface MappingSuggestionInput {
  mappingType: string;
  sourceKey: string;
  /** Key into `MappingValidationContext.targetKeys`. */
  targetKey: string;
  reason?: string;
}

export interface MappingValidationContext {
  /** The grounded target namespace: key -> existing account id. */
  targetKeys: Map<string, string>;
  existing: ExistingAccount[];
  /** `${mappingType}:${sourceKey}` -> account id currently mapped. */
  currentTargets: Map<string, string>;
}

export type MappingRejectionCode =
  | "unknown_mapping_row"
  | "unknown_target"
  | "inactive_target"
  | "incompatible_target"
  | "duplicate_row"
  | "no_change";

export interface MappingRejection {
  key: string;
  code: MappingRejectionCode;
  message: string;
}

export interface ValidatedMappingAssignment {
  mappingType: MappingType;
  sourceKey: string;
  label: string;
  targetAccountId: string;
  targetName: string;
  targetAccountType: string;
  reason: string;
}

export interface MappingValidation {
  assignments: ValidatedMappingAssignment[];
  rejected: MappingRejection[];
}

/**
 * Validate mapping suggestions against a chart.
 *
 * The type check is the load-bearing one: `isMappingTargetCompatible` is what
 * makes "map default_expense to Sales Revenue" impossible, whether that
 * sentence came from a confused model or from text an attacker planted in an
 * account name.
 */
export function validateMappingSuggestions(
  raw: MappingSuggestionInput[],
  ctx: MappingValidationContext,
): MappingValidation {
  const byId = new Map(ctx.existing.map((a) => [a.id, a]));
  const assignments: ValidatedMappingAssignment[] = [];
  const rejected: MappingRejection[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    const mappingType = (entry.mappingType ?? "").trim();
    const sourceKey = (entry.sourceKey ?? "").trim();
    const composite = `${mappingType}:${sourceKey}`;

    const row = mappingRowFor(mappingType, sourceKey);
    if (!row) {
      rejected.push({
        key: composite,
        code: "unknown_mapping_row",
        message: `"${composite}" is not a mapping row this system has`,
      });
      continue;
    }
    if (seen.has(composite)) {
      rejected.push({
        key: composite,
        code: "duplicate_row",
        message: `"${composite}" was assigned more than once; kept the first`,
      });
      continue;
    }

    const targetId = ctx.targetKeys.get((entry.targetKey ?? "").trim());
    const target = targetId ? byId.get(targetId) : undefined;
    if (!target) {
      rejected.push({
        key: composite,
        code: "unknown_target",
        message: `No account matches the proposed target for "${row.label}"`,
      });
      continue;
    }
    if (!target.isActive) {
      rejected.push({
        key: composite,
        code: "inactive_target",
        message: `"${target.name}" is not active`,
      });
      continue;
    }
    if (!isMappingTargetCompatible(row, target)) {
      rejected.push({
        key: composite,
        code: "incompatible_target",
        message: `"${row.label}" must post to a ${row.ledgerType} account, but "${target.name}" is ${target.accountType}`,
      });
      continue;
    }
    if (ctx.currentTargets.get(composite) === target.id) {
      rejected.push({
        key: composite,
        code: "no_change",
        message: `"${row.label}" already posts to "${target.name}"`,
      });
      continue;
    }

    seen.add(composite);
    assignments.push({
      mappingType: mappingType as MappingType,
      sourceKey,
      label: row.label,
      targetAccountId: target.id,
      targetName: target.name,
      targetAccountType: target.accountType,
      reason: stripControlChars(entry.reason ?? "")
        .trim()
        .slice(0, 300),
    });
  }

  return { assignments, rejected };
}
