// ============================================================================
// Classification memory answers (Inbox v2 §7). Pure.
//
// An answer is what a person settled a paper as: the kind of paper (its
// economic event class), the party, and each line's account. It is built from
// a corrected draft (buildMemoryAnswer) and replayed onto a new draft
// (applyMemoryAnswer). Replay never invents a number:
//
//   • a side with ONE remembered line takes the new draft's total — the
//     same account, whatever the new paper's amount;
//   • a side with SEVERAL lines (a split) replays its exact remembered
//     amounts, and only onto a draft of exactly that total in the same
//     currency. Anything else is not this memory's paper, so it does not
//     apply — proportions are never guessed.
//
// Both sides therefore always sum to the draft's total, so a replayed draft
// balances to the cent by construction. Money is exact decimal strings,
// through src/lib/inbox/money.ts.
//
// An answer carries no bank or payment details — only a doc kind, a party id,
// and account ids.
// ============================================================================

import { z } from "zod";
import type { EconomicEventClass } from "../duplicate-matcher";
import { directionForEconomicEventClass } from "../economic-event";
import { parseMoneyToScaled, scaledToMoney } from "../money";

export type MemorySide = "debit" | "credit";
export type MemoryDirection = "outflow" | "inflow" | "neutral";

/** Kinds of paper a memory may answer. "other" has no direction to replay onto. */
export const MEMORY_DOC_KINDS = [
  "purchase",
  "sale",
  "bill_accrual",
  "bill_payment",
  "invoice_accrual",
  "invoice_payment",
  "transfer",
  "payroll",
] as const satisfies readonly EconomicEventClass[];

export type MemoryDocKind = (typeof MEMORY_DOC_KINDS)[number];

export function isMemoryDocKind(value: unknown): value is MemoryDocKind {
  return typeof value === "string" && (MEMORY_DOC_KINDS as readonly string[]).includes(value);
}

/** The direction a doc kind books, or null for one a memory cannot answer. */
export function memoryDirection(docKind: string | null | undefined): MemoryDirection | null {
  if (!isMemoryDocKind(docKind)) return null;
  const direction = directionForEconomicEventClass(docKind);
  return direction === "unknown" ? null : direction;
}

const EXPENSE_ACCOUNT_TYPES = new Set(["expense", "cost_of_revenue", "other_expense"]);
const INCOME_ACCOUNT_TYPES = new Set(["revenue", "other_income"]);

/**
 * The directions a balanced entry could book, read from its account types, for a
 * paper whose own kind is unknown (a hand-entered entry). An expense debit means
 * money out; an income credit means money in. With neither, the entry could be
 * any of the three (an asset bought with cash, a transfer, a loan), so every
 * direction stays open and the person's choice decides. With both, the entry is
 * mixed and no single kind of paper describes it.
 */
export function possibleEntryDirections(
  lines: ReadonlyArray<{ side: MemorySide; accountType: string }>,
): MemoryDirection[] {
  const expenseDebit = lines.some(
    (line) => line.side === "debit" && EXPENSE_ACCOUNT_TYPES.has(line.accountType),
  );
  const incomeCredit = lines.some(
    (line) => line.side === "credit" && INCOME_ACCOUNT_TYPES.has(line.accountType),
  );
  if (expenseDebit && incomeCredit) return [];
  if (expenseDebit) return ["outflow"];
  if (incomeCredit) return ["inflow"];
  return ["outflow", "inflow", "neutral"];
}

/** Any 8-4-4-4-12 hex id: row ids are gen_random_uuid(), but nothing here depends on the version. */
const uuidLike = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu);

/**
 * An exact, positive decimal with at most 8 places. The pattern check ABORTS the chain: Zod runs a
 * schema's remaining checks after one fails, and the positivity check parses the value, which
 * throws on a malformed string ("1e3"). A validator must fail validation, never throw — these
 * schemas read stored rows and eval cases, where a throw would crash the reader instead of
 * skipping the malformed answer.
 */
const decimal = z
  .string()
  .regex(/^\d+(?:\.\d{1,8})?$/u, { abort: true })
  .refine((value) => parseMoneyToScaled(value) > 0n, "must be greater than zero");

export const memoryAnswerLineSchema = z.object({
  lineMatch: z.object({
    side: z.enum(["debit", "credit"]),
    index: z.number().int().min(0),
  }),
  accountId: uuidLike,
  accountType: z.string().min(1).max(50),
  amount: decimal,
  currency: z.string().regex(/^[A-Z]{3}$/u),
  taxCode: z.string().max(32).nullable(),
});

export type MemoryAnswerLine = z.infer<typeof memoryAnswerLineSchema>;

export const memoryAnswerSchema = z.object({
  docKind: z.enum(MEMORY_DOC_KINDS),
  partyId: uuidLike.nullable(),
  lines: z.array(memoryAnswerLineSchema).min(2).max(100),
});

export type MemoryAnswer = z.infer<typeof memoryAnswerSchema>;

/** A memory row's answer columns as an answer, or null when they are unusable. */
export function memoryAnswerFromColumns(columns: {
  answerDocKind: string | null;
  answerPartyId: string | null;
  answerLines: unknown;
}): MemoryAnswer | null {
  const parsed = memoryAnswerSchema.safeParse({
    docKind: columns.answerDocKind,
    partyId: columns.answerPartyId,
    lines: columns.answerLines,
  });
  return parsed.success ? parsed.data : null;
}

function canonicalAmount(value: string): string {
  return scaledToMoney(parseMoneyToScaled(value));
}

/** An account as the answer builder needs to see it. */
export interface AnswerAccount {
  id: string;
  accountType: string;
  subtype: string | null;
  isActive: boolean;
  /** True when no account names this one as its parent. */
  isLeaf: boolean;
}

export interface CorrectedLine {
  accountId: string | null;
  originalDebit: string | null;
  originalCredit: string | null;
  originalCurrency: string;
}

export type MemoryAnswerProblem =
  | "doc_kind_unknown"
  | "too_few_lines"
  | "line_uncategorized"
  | "account_not_postable"
  | "line_amount_invalid"
  | "one_sided"
  | "unbalanced";

export type BuildMemoryAnswerResult =
  | { ok: true; answer: MemoryAnswer }
  | { ok: false; problem: MemoryAnswerProblem; message: string };

const PROBLEM_MESSAGES: Record<MemoryAnswerProblem, string> = {
  doc_kind_unknown: "Choose what kind of paper this is before remembering it.",
  too_few_lines: "The entry needs at least two lines to be remembered.",
  line_uncategorized: "Choose a category for every line before remembering this answer.",
  account_not_postable: "Every line must use an active leaf account before it can be remembered.",
  line_amount_invalid: "Every line needs exactly one positive debit or credit amount.",
  one_sided: "The entry needs both a debit and a credit side.",
  unbalanced: "The entry must balance before it can be remembered.",
};

function problem(code: MemoryAnswerProblem): BuildMemoryAnswerResult {
  return { ok: false, problem: code, message: PROBLEM_MESSAGES[code] };
}

/**
 * The answer a person's corrected draft states. Refuses anything that is not
 * an answer: an unselected or uncategorized line, an account that cannot be
 * posted to, an unbalanced or one-sided entry, or a paper of kind "other".
 */
export function buildMemoryAnswer(input: {
  docKind: string | null;
  partyId: string | null;
  lines: readonly CorrectedLine[];
  accounts: ReadonlyMap<string, AnswerAccount>;
}): BuildMemoryAnswerResult {
  if (!isMemoryDocKind(input.docKind) || memoryDirection(input.docKind) === null) {
    return problem("doc_kind_unknown");
  }
  if (input.lines.length < 2) return problem("too_few_lines");
  const sideCounts: Record<MemorySide, number> = { debit: 0, credit: 0 };
  const totals: Record<MemorySide, bigint> = { debit: 0n, credit: 0n };
  const lines: MemoryAnswerLine[] = [];
  for (const line of input.lines) {
    if (!line.accountId) return problem("line_uncategorized");
    const account = input.accounts.get(line.accountId);
    if (!account) return problem("account_not_postable");
    if (account.subtype?.startsWith("uncategorized_")) return problem("line_uncategorized");
    if (!account.isActive || !account.isLeaf) return problem("account_not_postable");
    const hasDebit = line.originalDebit != null && line.originalDebit !== "";
    const hasCredit = line.originalCredit != null && line.originalCredit !== "";
    if (hasDebit === hasCredit) return problem("line_amount_invalid");
    const side: MemorySide = hasDebit ? "debit" : "credit";
    const raw = (hasDebit ? line.originalDebit : line.originalCredit)!;
    let scaled: bigint;
    try {
      scaled = parseMoneyToScaled(raw);
    } catch {
      return problem("line_amount_invalid");
    }
    if (scaled <= 0n) return problem("line_amount_invalid");
    totals[side] += scaled;
    lines.push({
      lineMatch: { side, index: sideCounts[side] },
      accountId: account.id,
      accountType: account.accountType,
      amount: scaledToMoney(scaled),
      currency: line.originalCurrency.trim().toUpperCase(),
      taxCode: null,
    });
    sideCounts[side] += 1;
  }
  if (sideCounts.debit === 0 || sideCounts.credit === 0) return problem("one_sided");
  if (totals.debit !== totals.credit) return problem("unbalanced");
  const parsed = memoryAnswerSchema.safeParse({
    docKind: input.docKind,
    partyId: input.partyId,
    lines,
  });
  if (!parsed.success) return problem("line_amount_invalid");
  return { ok: true, answer: parsed.data };
}

/** The draft a memory is replayed onto: the paper's direction, total, and currency. */
export interface MemoryDraft {
  direction: MemoryDirection;
  /** The amount on each side of the draft, exact decimal. */
  total: string;
  currency: string;
}

export const memoryDraftSchema = z.object({
  direction: z.enum(["outflow", "inflow", "neutral"]),
  total: decimal,
  currency: z.string().regex(/^[A-Z]{3}$/u),
});

export interface AppliedMemoryLine {
  side: MemorySide;
  accountId: string;
  amount: string;
}

/** A replayed answer: debit lines first, then credit lines, each in remembered order. */
export interface MemoryApplication {
  docKind: MemoryDocKind;
  partyId: string | null;
  lines: AppliedMemoryLine[];
}

export const memoryApplicationSchema = z.object({
  docKind: z.enum(MEMORY_DOC_KINDS),
  partyId: uuidLike.nullable(),
  lines: z
    .array(
      z.object({
        side: z.enum(["debit", "credit"]),
        accountId: uuidLike,
        amount: decimal,
      }),
    )
    .min(2),
});

export type MemoryApplyFailure =
  | "direction_mismatch"
  | "split_currency_differs"
  | "split_amounts_differ"
  | "answer_incomplete";

export type ApplyMemoryResult =
  | { ok: true; application: MemoryApplication }
  | { ok: false; reason: MemoryApplyFailure };

/**
 * Replay an answer onto a draft. Deterministic and pure — this is the
 * function the test lock replays (src/lib/inbox/memory/lock.ts).
 */
export function applyMemoryAnswer(answer: MemoryAnswer, draft: MemoryDraft): ApplyMemoryResult {
  if (memoryDirection(answer.docKind) !== draft.direction) {
    return { ok: false, reason: "direction_mismatch" };
  }
  const total = parseMoneyToScaled(draft.total);
  const currency = draft.currency.trim().toUpperCase();
  const lines: AppliedMemoryLine[] = [];
  for (const side of ["debit", "credit"] as const) {
    const sideLines = answer.lines
      .filter((line) => line.lineMatch.side === side)
      .sort((left, right) => left.lineMatch.index - right.lineMatch.index);
    if (sideLines.length === 0) return { ok: false, reason: "answer_incomplete" };
    if (sideLines.length === 1) {
      lines.push({ side, accountId: sideLines[0].accountId, amount: scaledToMoney(total) });
      continue;
    }
    if (sideLines.some((line) => line.currency !== currency)) {
      return { ok: false, reason: "split_currency_differs" };
    }
    const sideTotal = sideLines.reduce((sum, line) => sum + parseMoneyToScaled(line.amount), 0n);
    if (sideTotal !== total) return { ok: false, reason: "split_amounts_differ" };
    for (const line of sideLines) {
      lines.push({ side, accountId: line.accountId, amount: canonicalAmount(line.amount) });
    }
  }
  return {
    ok: true,
    application: { docKind: answer.docKind, partyId: answer.partyId, lines },
  };
}

/** One string per distinct replayed answer, for agreement checks and the test lock. */
export function applicationKey(application: MemoryApplication): string {
  return JSON.stringify({
    docKind: application.docKind,
    partyId: application.partyId,
    lines: application.lines.map((line) => [
      line.side,
      line.accountId,
      canonicalAmount(line.amount),
    ]),
  });
}

/** Accounts per side, order-free: what a person changed when they changed a category. */
export function accountSignature(
  lines: ReadonlyArray<{ side: MemorySide; accountId: string | null }>,
): string {
  return lines
    .map((line) => `${line.side}:${line.accountId ?? "-"}`)
    .sort()
    .join(",");
}

/**
 * Whether a person's settled draft departs from what a memory answered. Only
 * the classification counts — accounts per side, the party the memory set,
 * and the kind of paper. Editing amounts, dates, or memo is not disagreement.
 */
export function departsFromApplication(
  application: MemoryApplication,
  settled: {
    docKind: string | null;
    partyId: string | null;
    lines: ReadonlyArray<{ side: MemorySide; accountId: string | null }>;
  },
): boolean {
  if (settled.docKind !== application.docKind) return true;
  if (application.partyId !== null && settled.partyId !== application.partyId) return true;
  return accountSignature(settled.lines) !== accountSignature(application.lines);
}
