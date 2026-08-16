// ============================================================================
// Eval graders — CODE graders first (AI_NATIVE_ARCHITECTURE §8).
//
// Finance extraction is mostly exact-match: amounts, dates, currencies, and
// account codes are either right or wrong. LLM-as-judge is reserved for
// genuinely fuzzy fields (a description's plausibility) and only in live
// mode, judged by a DIFFERENT provider than the generator.
// ============================================================================

import { isAccountType, isSubtypeLegalForType } from "../../src/db/schema/account-constants";
import { mappingRowFor } from "../../src/lib/coa/mapping-registry";

export interface FieldResult {
  field: string;
  passed: boolean;
  expected: unknown;
  actual: unknown;
}

export interface GradeResult {
  passed: boolean;
  score: number;
  fields: FieldResult[];
}

function get(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((node, key) => {
    if (node == null) return undefined;
    const match = /^(.+)\[(\d+)\]$/.exec(key);
    if (match) {
      const arr = (node as Record<string, unknown>)[match[1]];
      return Array.isArray(arr) ? arr[Number(match[2])] : undefined;
    }
    return (node as Record<string, unknown>)[key];
  }, obj);
}

/** Money compared in cents — never as floats. */
export function amountsEqual(expected: unknown, actual: unknown): boolean {
  const e = typeof expected === "string" ? Number(expected) : (expected as number);
  const a = typeof actual === "string" ? Number(actual) : (actual as number);
  if (!Number.isFinite(e) || !Number.isFinite(a)) return false;
  return Math.round(e * 100) === Math.round(a * 100);
}

/** Dates may legitimately differ by a small settlement window. */
export function datesWithin(expected: unknown, actual: unknown, toleranceDays = 0): boolean {
  if (typeof expected !== "string" || typeof actual !== "string") return false;
  const e = new Date(`${expected}T00:00:00`).getTime();
  const a = new Date(`${actual}T00:00:00`).getTime();
  if (Number.isNaN(e) || Number.isNaN(a)) return false;
  return Math.abs(e - a) <= toleranceDays * 86_400_000;
}

export type FieldGrader = (expected: unknown, actual: unknown) => boolean;

export const exact: FieldGrader = (e, a) => JSON.stringify(e) === JSON.stringify(a);
export const caseInsensitive: FieldGrader = (e, a) =>
  String(e).trim().toLowerCase() === String(a).trim().toLowerCase();
export const money: FieldGrader = amountsEqual;
export const dateExact: FieldGrader = (e, a) => datesWithin(e, a, 0);
export const dateWithin3Days: FieldGrader = (e, a) => datesWithin(e, a, 3);

export interface FieldSpec {
  path: string;
  grader?: FieldGrader;
  /** A wrong value here fails the case outright (amounts, dates). */
  critical?: boolean;
}

/**
 * Grade one case. `passed` requires every CRITICAL field to match; `score`
 * is the fraction of all graded fields that matched, so partial regressions
 * are visible even when the case still passes.
 */
export function gradeCase(
  expected: Record<string, unknown>,
  actual: Record<string, unknown>,
  fields: FieldSpec[],
): GradeResult {
  const results: FieldResult[] = fields.map((spec) => {
    const grader = spec.grader ?? exact;
    // Expected values may be written either as a nested object mirroring the
    // output, or as a flat map of dotted paths (which reads better for the
    // handful of fields a case actually pins). Literal key wins.
    const expectedValue = Object.hasOwn(expected, spec.path)
      ? expected[spec.path]
      : get(expected, spec.path);
    const actualValue = get(actual, spec.path);
    return {
      field: spec.path,
      passed: grader(expectedValue, actualValue),
      expected: expectedValue,
      actual: actualValue,
    };
  });

  const criticalPaths = new Set(fields.filter((f) => f.critical).map((f) => f.path));
  const criticalOk = results.every((r) => !criticalPaths.has(r.field) || r.passed);
  const score = results.length === 0 ? 1 : results.filter((r) => r.passed).length / results.length;

  return { passed: criticalOk, score, fields: results };
}

/**
 * pass^k — the probability all k independent samples pass. Finance tasks are
 * graded this way because "usually right" is not a useful property for a
 * ledger: one bad extraction in ten is a bad extraction.
 */
export function passCaretK(results: boolean[]): number {
  if (results.length === 0) return 0;
  return results.every(Boolean) ? 1 : 0;
}

// ============================================================================
// Output invariants
//
// Field graders answer "did the model produce the expected VALUE?". Invariants
// answer "is this output structurally legal at all?" — a property that must
// hold for EVERY response to the task, whatever the input. They are the eval
// mirror of the deterministic validators: a batch of drafted accounts with two
// identical names, an illegal subtype, or a mapping pointed at the wrong
// ledger type is wrong regardless of what the fixture expected.
//
// Cheap to write, and they generalize — one invariant covers every case for
// the task, so an adversarial case only has to supply the hostile input.
// ============================================================================

export interface OutputInvariant {
  name: string;
  /** null when the invariant holds; otherwise a human-readable violation. */
  check(output: Record<string, unknown>): string | null;
}

export interface InvariantResult {
  name: string;
  passed: boolean;
  detail: string | null;
}

export function checkInvariants(
  output: Record<string, unknown>,
  invariants: OutputInvariant[],
): InvariantResult[] {
  return invariants.map((invariant) => {
    const detail = invariant.check(output);
    return { name: invariant.name, passed: detail === null, detail };
  });
}

function rows(output: Record<string, unknown>, path: string): Record<string, unknown>[] {
  const value = get(output, path);
  return Array.isArray(value) ? (value as Record<string, unknown>[]) : [];
}

function str(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  return typeof value === "string" ? value : "";
}

/** No two entries share a key — a duplicate silently drops one of them. */
export function noDuplicateKeys(path = "accounts", field = "key"): OutputInvariant {
  return {
    name: `${path}[].${field} is unique`,
    check(output) {
      const seen = new Set<string>();
      for (const row of rows(output, path)) {
        const key = str(row, field);
        if (seen.has(key)) return `duplicate ${field} "${key}"`;
        seen.add(key);
      }
      return null;
    },
  };
}

/** No two entries share a name, case-insensitively. */
export function noDuplicateNames(path = "accounts", field = "name"): OutputInvariant {
  return {
    name: `${path}[].${field} is unique (case-insensitive)`,
    check(output) {
      const seen = new Set<string>();
      for (const row of rows(output, path)) {
        const name = str(row, field).trim().toLowerCase();
        if (name.length === 0) continue;
        if (seen.has(name)) return `duplicate name "${str(row, field)}"`;
        seen.add(name);
      }
      return null;
    },
  };
}

/** Every accountType is one of the 8 roots. */
export function noAccountsOutsideTypes(path = "accounts"): OutputInvariant {
  return {
    name: `${path}[].accountType is a known account type`,
    check(output) {
      for (const row of rows(output, path)) {
        const type = str(row, "accountType");
        if (!isAccountType(type)) return `"${type}" is not an account type`;
      }
      return null;
    },
  };
}

/** Every subtype is legal for its own accountType. */
export function subtypesLegalForType(path = "accounts"): OutputInvariant {
  return {
    name: `${path}[].subtype is legal for its accountType`,
    check(output) {
      for (const row of rows(output, path)) {
        const type = str(row, "accountType");
        const subtype = str(row, "subtype");
        if (subtype.length === 0) continue; // repaired deterministically
        if (!isSubtypeLegalForType(type, subtype)) {
          return `subtype "${subtype}" is not legal for "${type}"`;
        }
      }
      return null;
    },
  };
}

/**
 * Parent links resolve, and the tree they describe is legal:
 *  • parentKey names an account the caller actually supplied (grounding);
 *  • parentDraftKey names another entry in the SAME batch;
 *  • that entry is itself top-level, which is what caps depth at two;
 *  • a child never changes account type across the link.
 */
export function parentHierarchyValid(existingKeys: string[], path = "accounts"): OutputInvariant {
  const allowed = new Set(existingKeys);
  return {
    name: `${path}[] parent links resolve and keep their account type`,
    check(output) {
      const batch = rows(output, path);
      const byKey = new Map(batch.map((row) => [str(row, "key"), row]));
      for (const row of batch) {
        const parentKey = str(row, "parentKey");
        const parentDraftKey = str(row, "parentDraftKey");
        if (parentKey && parentDraftKey) {
          return `"${str(row, "key")}" sets both parentKey and parentDraftKey`;
        }
        if (parentKey && !allowed.has(parentKey)) {
          return `parentKey "${parentKey}" was not supplied to the model`;
        }
        if (!parentDraftKey) continue;

        const parent = byKey.get(parentDraftKey);
        if (!parent) return `parentDraftKey "${parentDraftKey}" is not in this response`;
        if (parent === row) return `"${parentDraftKey}" is its own parent`;
        if (str(parent, "parentDraftKey")) {
          return `parentDraftKey "${parentDraftKey}" is itself nested (depth > 2)`;
        }
        if (str(parent, "accountType") !== str(row, "accountType")) {
          return `"${str(row, "key")}" is ${str(row, "accountType")} under a ${str(parent, "accountType")} parent`;
        }
      }
      return null;
    },
  };
}

/**
 * Every mapping assignment targets an account of the ledger type its row
 * requires. This is the invariant that makes "map default_expense to Sales
 * Revenue" a test failure rather than an unbalanced journal.
 */
export function accountTypeMatches(
  accountTypeByKey: Record<string, string>,
  path = "assignments",
): OutputInvariant {
  return {
    name: `${path}[] target account type matches the mapping row`,
    check(output) {
      for (const row of rows(output, path)) {
        const mappingType = str(row, "mappingType");
        const sourceKey = str(row, "sourceKey");
        const targetKey = str(row, "targetKey");
        const config = mappingRowFor(mappingType, sourceKey);
        if (!config) return `"${mappingType}:${sourceKey}" is not a mapping row`;
        const targetType = accountTypeByKey[targetKey];
        if (!targetType) return `target "${targetKey}" was not supplied to the model`;
        if (targetType !== config.ledgerType) {
          return `"${mappingType}:${sourceKey}" needs a ${config.ledgerType} account but "${targetKey}" is ${targetType}`;
        }
      }
      return null;
    },
  };
}

/** The response is not trivially empty. */
export function coverageAtLeast(minimum: number, path = "accounts"): OutputInvariant {
  return {
    name: `${path}[] has at least ${minimum} entr${minimum === 1 ? "y" : "ies"}`,
    check(output) {
      const count = rows(output, path).length;
      return count >= minimum ? null : `only ${count} entries`;
    },
  };
}
