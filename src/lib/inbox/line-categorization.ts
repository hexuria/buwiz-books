// ============================================================================
// Inbox stage 2: pick each category line's account from the org's own chart.
//
// The chart reaches the model as a CLOSED list built here, per request:
//   • active LEAF accounts of the types the line may take — never a parent
//     (posting rejects those) and never an uncategorized_* bucket (no fit is
//     the explicit "none" answer, resolved below);
//   • each under a compact code: its account number when that renders
//     unchanged through redaction, a minted "A<n>" otherwise. Never a uuid.
// The per-request response schema is an enum of exactly these codes, and the
// answer is mapped back here: an unknown code, a code of the wrong type, or a
// missing answer is never a guess — the line falls through to no-fit.
//
// No fit, low confidence, or model failure resolves the line to the MAPPED
// uncategorized account (resolve-mapped-account, never a subtype scan), so the
// blocking `uncategorized` book rule fires on it. When the mapping points at
// anything that is not an uncategorized_* bucket (revenue has no such mapping
// in any preset), the line stays unselected, which the same rule also blocks
// on. Accounts are never created here; a missing category is at most a
// non-binding suggestion in the line's prediction evidence.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { normalizeConfidence } from "@/lib/ai/confidence";
import { MAX_CATEGORIZE_ACCOUNTS } from "@/lib/ai/prompts/categorize-lines";
import { redactPII } from "@/lib/ai/redact";
import { NO_FIT_CODE, type CategorizeLinesOutput } from "@/lib/ai/schemas/categorize-lines";
import { resolveMappedAccountId } from "@/lib/coa/resolve-mapped-account";
import type { MappingType } from "@/lib/coa/mapping-types";

export type CategoryDirection = "outflow" | "inflow";

/** Account types a category line may take, by the money's direction. */
export const CATEGORY_ACCOUNT_TYPES: Record<CategoryDirection, readonly string[]> = {
  outflow: ["expense", "cost_of_revenue", "other_expense"],
  inflow: ["revenue", "other_income"],
};

/**
 * The mapping row whose target is the no-fit destination for a direction.
 * default_expense maps to Uncategorized Expense in every preset.
 * default_revenue maps to Sales Revenue, which is NOT an uncategorized bucket,
 * so inflow lines normally stay unselected on no-fit (see resolveNoFitAccount).
 */
export const NO_FIT_MAPPING: Record<
  CategoryDirection,
  { mappingType: MappingType; sourceKey: string }
> = {
  outflow: { mappingType: "bill", sourceKey: "default_expense" },
  inflow: { mappingType: "invoice", sourceKey: "default_revenue" },
};

export interface ChartAccount {
  id: string;
  accountNumber: string | null;
  name: string;
  accountType: string;
  subtype: string | null;
  parentId: string | null;
  isActive: boolean;
}

export interface AccountCodeEntry {
  code: string;
  accountId: string;
  name: string;
  type: string;
  /** Parent account name, for the model's context. */
  group: string;
}

export interface AccountCodeList {
  entries: AccountCodeEntry[];
  byCode: Map<string, AccountCodeEntry>;
  /** True when more eligible accounts existed than the prompt may list. */
  truncated: boolean;
}

const CODE_SHAPE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,9}$/u;

/**
 * Whether a code can be shown to the model and read back unchanged: a short
 * token that is not the no-fit answer and that redaction leaves alone (the
 * façade redacts the whole prompt; a masked code could never be answered).
 */
export function isSafeAccountCode(code: string): boolean {
  return (
    CODE_SHAPE.test(code) &&
    code.toLowerCase() !== NO_FIT_CODE &&
    redactPII(JSON.stringify({ code })).hits.length === 0
  );
}

function compareAccounts(a: ChartAccount, b: ChartAccount): number {
  if (a.accountNumber !== b.accountNumber) {
    if (a.accountNumber === null) return 1;
    if (b.accountNumber === null) return -1;
    return a.accountNumber < b.accountNumber ? -1 : 1;
  }
  if (a.name !== b.name) return a.name < b.name ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Build the closed code list for a request. Deterministic for a given chart:
 * ordered by account number, then name, then id.
 */
export function buildAccountCodeList(
  chart: readonly ChartAccount[],
  allowedTypes: readonly string[],
  max = MAX_CATEGORIZE_ACCOUNTS,
): AccountCodeList {
  const parentIds = new Set(
    chart.flatMap((account) => (account.parentId ? [account.parentId] : [])),
  );
  const nameById = new Map(chart.map((account) => [account.id, account.name]));
  const allowed = new Set(allowedTypes);
  const eligible = chart
    .filter(
      (account) =>
        account.isActive &&
        allowed.has(account.accountType) &&
        !parentIds.has(account.id) &&
        !account.subtype?.startsWith("uncategorized_"),
    )
    .sort(compareAccounts);
  const listed = eligible.slice(0, max);

  const taken = new Set<string>();
  for (const account of listed) {
    if (account.accountNumber && isSafeAccountCode(account.accountNumber)) {
      taken.add(account.accountNumber);
    }
  }
  const byCode = new Map<string, AccountCodeEntry>();
  const entries: AccountCodeEntry[] = [];
  let minted = 0;
  for (const account of listed) {
    let code = account.accountNumber;
    if (!code || !isSafeAccountCode(code) || byCode.has(code)) {
      do {
        minted += 1;
        code = `A${minted}`;
      } while (taken.has(code));
      taken.add(code);
    }
    const entry: AccountCodeEntry = {
      code,
      accountId: account.id,
      name: account.name,
      type: account.accountType,
      group: account.parentId ? (nameById.get(account.parentId) ?? "") : "",
    };
    byCode.set(code, entry);
    entries.push(entry);
  }
  return { entries, byCode, truncated: eligible.length > listed.length };
}

export interface CategoryLineRequest {
  lineIndex: number;
  side: "debit" | "credit";
  direction: CategoryDirection;
  description: string;
  amount: string;
}

export type LineCategoryDecision =
  | { lineIndex: number; outcome: "picked"; accountId: string; code: string; confidence: number }
  | {
      lineIndex: number;
      outcome: "low_confidence";
      suggestedAccountId: string;
      code: string;
      confidence: number;
    }
  | {
      lineIndex: number;
      outcome: "no_fit";
      confidence: number;
      suggestedNewCategory: string | null;
    }
  | {
      lineIndex: number;
      outcome: "rejected";
      code: string;
      /** account_no_longer_postable: deactivated or given children while the model ran. */
      reason: "unknown_code" | "type_not_allowed" | "account_no_longer_postable";
    }
  | { lineIndex: number; outcome: "missing" }
  | { lineIndex: number; outcome: "model_failed"; reason: string };

const MAX_SUGGESTION_CHARS = 80;

/**
 * Map the model's answer back onto the requested lines. Pure: every code is
 * re-checked against the list the request carried and the line's allowed
 * types; the first answer per line counts; a line with no answer is missing.
 */
export function mapCategorizeLinesOutput(
  output: CategorizeLinesOutput,
  input: {
    lines: readonly CategoryLineRequest[];
    codes: AccountCodeList;
    minConfidence: number;
  },
): LineCategoryDecision[] {
  const answers = new Map<number, CategorizeLinesOutput["lines"][number]>();
  for (const answer of output.lines) {
    if (!answers.has(answer.lineIndex)) answers.set(answer.lineIndex, answer);
  }
  return input.lines.map((line): LineCategoryDecision => {
    const answer = answers.get(line.lineIndex);
    if (!answer) return { lineIndex: line.lineIndex, outcome: "missing" };
    // The schema pins confidence to 0..1, so a bare 1 means certain.
    const confidence = normalizeConfidence(answer.confidence, { scaleHint: "unit" });
    if (answer.accountCode === NO_FIT_CODE) {
      const suggestion = answer.suggestedNewCategory.trim().slice(0, MAX_SUGGESTION_CHARS);
      return {
        lineIndex: line.lineIndex,
        outcome: "no_fit",
        confidence,
        suggestedNewCategory: suggestion || null,
      };
    }
    const entry = input.codes.byCode.get(answer.accountCode);
    if (!entry) {
      return {
        lineIndex: line.lineIndex,
        outcome: "rejected",
        code: answer.accountCode,
        reason: "unknown_code",
      };
    }
    if (!CATEGORY_ACCOUNT_TYPES[line.direction].includes(entry.type)) {
      return {
        lineIndex: line.lineIndex,
        outcome: "rejected",
        code: answer.accountCode,
        reason: "type_not_allowed",
      };
    }
    if (confidence < input.minConfidence) {
      return {
        lineIndex: line.lineIndex,
        outcome: "low_confidence",
        suggestedAccountId: entry.accountId,
        code: entry.code,
        confidence,
      };
    }
    return {
      lineIndex: line.lineIndex,
      outcome: "picked",
      accountId: entry.accountId,
      code: entry.code,
      confidence,
    };
  });
}

/** Every requested line as failed, for a model call that produced nothing usable. */
export function failedDecisions(
  lines: readonly CategoryLineRequest[],
  reason: string,
): LineCategoryDecision[] {
  return lines.map((line) => ({ lineIndex: line.lineIndex, outcome: "model_failed", reason }));
}

export interface NoFitAccount {
  id: string;
  subtype: string | null;
}

/**
 * The account a no-fit line resolves to, or null when the line must stay
 * unselected. Resolved through the org's mapping, and accepted only when the
 * target is an active leaf uncategorized_* bucket — anything else would let
 * an unreviewed line post somewhere the `uncategorized` rule cannot see.
 */
export async function resolveNoFitAccount(
  db: DbExecutor,
  orgId: string,
  direction: CategoryDirection,
): Promise<NoFitAccount | null> {
  const { mappingType, sourceKey } = NO_FIT_MAPPING[direction];
  const accountId = await resolveMappedAccountId(db, orgId, mappingType, sourceKey);
  if (!accountId) return null;
  const [account] = await db
    .select({ id: accounts.id, subtype: accounts.subtype, isActive: accounts.isActive })
    .from(accounts)
    .where(and(eq(accounts.organizationId, orgId), eq(accounts.id, accountId)))
    .limit(1);
  if (!account?.isActive || !account.subtype?.startsWith("uncategorized_")) return null;
  const [child] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(and(eq(accounts.organizationId, orgId), eq(accounts.parentId, accountId)))
    .limit(1);
  return child ? null : { id: account.id, subtype: account.subtype };
}

export interface ResolvedCategoryLine {
  accountId: string | null;
  /** Stored on the line only when the model's own pick is applied. */
  categoryConfidence: string | null;
  evidence: Record<string, unknown>;
}

/** Four decimals, matching transaction_candidate_lines.category_confidence. */
export function formatConfidence(confidence: number): string {
  return String(Math.round(Math.min(Math.max(confidence, 0), 1) * 10_000) / 10_000);
}

/**
 * Turn one decision into the line's account, confidence, and evidence. Only
 * a confident pick of a listed account is applied; every other outcome takes
 * the no-fit account (or stays unselected when there is none).
 */
export function resolveCategoryLine(
  decision: LineCategoryDecision,
  noFitAccount: NoFitAccount | null,
  minConfidence: number,
): ResolvedCategoryLine {
  if (decision.outcome === "picked") {
    return {
      accountId: decision.accountId,
      categoryConfidence: formatConfidence(decision.confidence),
      evidence: {
        selection: "model",
        outcome: "picked",
        code: decision.code,
        confidence: decision.confidence,
        threshold: minConfidence,
      },
    };
  }
  const evidence: Record<string, unknown> = {
    selection: noFitAccount ? "no_fit_mapped_uncategorized" : "no_fit_unselected",
    outcome: decision.outcome,
    threshold: minConfidence,
  };
  if (decision.outcome === "low_confidence") {
    // Non-binding: what the model would have chosen, for the reviewer.
    evidence.suggestedAccountId = decision.suggestedAccountId;
    evidence.code = decision.code;
    evidence.confidence = decision.confidence;
  } else if (decision.outcome === "no_fit") {
    evidence.confidence = decision.confidence;
    if (decision.suggestedNewCategory)
      evidence.suggestedNewCategory = decision.suggestedNewCategory;
  } else if (decision.outcome === "rejected") {
    evidence.rejectedCode = decision.code;
    evidence.rejectionReason = decision.reason;
  } else if (decision.outcome === "model_failed") {
    evidence.failure = decision.reason;
  }
  return { accountId: noFitAccount?.id ?? null, categoryConfidence: null, evidence };
}
