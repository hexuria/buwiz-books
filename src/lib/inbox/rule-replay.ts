/**
 * Rule replay — re-evaluate papers under a rule set without writing anything
 * (Inbox v2 spec §6 "replay on the practice pile", §9 scorecard).
 *
 * Pure: no database, no network, no clock, no randomness. The same cases and
 * rules always produce the same findings in the same order, and the inputs are
 * never mutated. It reuses the production evaluators rather than re-deriving
 * them, so a replayed finding is the finding the live path would raise:
 *
 *   - book rules through `evaluateCandidateRules` (src/lib/inbox/rules.ts),
 *     exactly as the candidate path applies a rule set;
 *   - `possible_duplicate` through the pure duplicate matcher and the engine's
 *     own disposition rules, for cases that carry their duplicate context
 *     (the paper's normalized source and the records it could duplicate);
 *   - `material_expense` through the review engine's evaluator, for cases that
 *     carry the recent ledger rows the engine would scan (already windowed to
 *     the rule's lookback). The paper is added as one more journal, the way it
 *     will appear once posted;
 *   - the `party_payment_details_changed` system rule through the same pure
 *     comparison the payee check uses, for cases that carry the payee's stored
 *     bank details and the ones printed on the paper. A system rule reads no
 *     config, so no rule set can switch it off — here as in production.
 *
 * Cases without that context are replayed for book rules only.
 */
import type { RuleSnapshotEntry } from "@/db/schema/rule-snapshots";
import { detectPaymentDetailsChange } from "@/lib/party-match/normalize";
import { duplicateEngineConfigFrom, effectiveDisposition } from "./duplicate-engine";
import { matchSourceAgainstCandidates, type DuplicateMatcherInput } from "./duplicate-matcher";
import { multiplyMoney } from "./money";
import { evaluateMaterialExpense } from "./review-engine";
import {
  DEFAULT_BOOK_RULE_FALLBACKS,
  evaluateCandidateRules,
  ruleConfigMapFromEntries,
  type BookRuleFallbacks,
  type RuleConfigView,
} from "./rule-set";
import type { BookRuleAccount, BookRuleDocument, BookRuleParty } from "./rules";
import type { CandidateLineInput, CreateCandidateInput } from "./types";

export interface ReplayLedgerRow {
  journalId: string;
  transactionDate: string;
  accountId: string;
  accountType: string;
  subtype: string | null;
  debit: string | null;
  credit: string | null;
}

export interface ReplayAccount {
  accountType: string;
  subtype: string | null;
  childCount: number;
}

export interface ReplayCase {
  id: string;
  candidate: {
    transactionDate: string;
    transactionType: CreateCandidateInput["transactionType"];
    originalCurrency: string;
    functionalCurrency: string;
    exchangeRate: string;
    memo?: string | null;
    referenceNumber?: string | null;
  };
  /** Posting lines as the candidate path evaluates them: amounts in the original currency. */
  lines: CandidateLineInput[];
  accounts: Record<string, ReplayAccount>;
  party: BookRuleParty | null;
  documents: BookRuleDocument[];
  duplicate?: { source: DuplicateMatcherInput; priorRecords: DuplicateMatcherInput[] } | null;
  ledgerHistory?: ReplayLedgerRow[] | null;
  /** The payee's stored bank details and the ones printed on the paper. */
  paymentDetails?: {
    stored: { bankAccountNumber: string | null; bankRoutingNumber: string | null };
    printed: { accountNumber: string | null; routingNumber: string | null };
  } | null;
}

export interface ReplayRuleSet {
  entries: readonly RuleSnapshotEntry[];
  /** Thresholds for entries that carry none. Defaults to the settings column defaults. */
  fallbacks?: BookRuleFallbacks;
}

export interface ReplayFinding {
  ruleKey: string;
  impact: "blocking" | "warning";
  message: string;
  evidence: Record<string, unknown>;
}

export interface ReplayCaseResult {
  caseId: string;
  findings: ReplayFinding[];
  /** Whether any finding blocks approval. */
  blocked: boolean;
}

/** The synthetic journal id the paper takes when it joins the replayed ledger. */
export function replayJournalId(caseId: string): string {
  return `replay:${caseId}`;
}

function numberConfig(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function duplicateFindings(
  replayCase: ReplayCase,
  rule: RuleConfigView | undefined,
  formulaVersion: number | undefined,
): ReplayFinding[] {
  if (!replayCase.duplicate) return [];
  const config = duplicateEngineConfigFrom({
    config: rule?.config,
    enabled: rule?.enabled,
    impact: rule?.impact,
    formulaVersion,
  });
  if (!config.enabled || config.mode === "off") return [];
  return matchSourceAgainstCandidates(
    replayCase.duplicate.source,
    replayCase.duplicate.priorRecords,
    config,
  )
    .map((match, index) => ({ match, index }))
    .filter(({ match }) => effectiveDisposition(match.result, config) === "blocking")
    .map(({ match, index }) => ({
      ruleKey: "possible_duplicate",
      impact: "blocking" as const,
      message: `A ${match.result.score}% duplicate match must be resolved before this transaction can post.`,
      evidence: {
        priorRecord: match.candidate.sourceRecordId ?? index,
        score: match.result.score,
        reason: match.result.reason,
        signals: match.result.signals,
      },
    }));
}

function materialExpenseFindings(
  replayCase: ReplayCase,
  rule: RuleConfigView | undefined,
): ReplayFinding[] {
  if (!replayCase.ledgerHistory || rule?.enabled === false) return [];
  const journalId = replayJournalId(replayCase.id);
  const { candidate } = replayCase;
  const toFunctional = (amount: string | null | undefined): string | null => {
    if (amount == null) return null;
    return candidate.originalCurrency === candidate.functionalCurrency
      ? amount
      : multiplyMoney(amount, candidate.exchangeRate);
  };
  const paperRows = replayCase.lines.flatMap((line) => {
    const account = line.accountId ? replayCase.accounts[line.accountId] : undefined;
    if (!line.accountId || !account) return [];
    return [
      {
        journalId,
        transactionDate: candidate.transactionDate,
        accountId: line.accountId,
        accountType: account.accountType,
        subtype: account.subtype,
        parentId: null,
        debit: toFunctional(line.debit),
        credit: toFunctional(line.credit),
      },
    ];
  });
  const ledgerRows = [
    ...replayCase.ledgerHistory.map((row) => ({ ...row, parentId: null })),
    ...paperRows,
  ];
  const percent = numberConfig(rule?.config ?? {}, "annualizedExpensePercent", 1);
  const impact = rule?.impact === "blocking" ? "blocking" : "warning";
  return evaluateMaterialExpense(ledgerRows, percent)
    .filter((target) => target.subjectId === journalId)
    .map((target) => ({
      ruleKey: "material_expense",
      impact,
      message: target.message,
      evidence: { ...target.evidence },
    }));
}

/** `payment-details-check.ts`'s rule key; that module reads the database, so it is not imported. */
export const PAYMENT_DETAILS_RULE_KEY = "party_payment_details_changed";

/** The party types the correction path treats as payees (candidate-correction.ts). */
const PAYEE_PARTY_TYPES = new Set(["vendor", "both", "employee"]);

function paymentDetailsFindings(replayCase: ReplayCase): ReplayFinding[] {
  const details = replayCase.paymentDetails;
  if (!details || !replayCase.party || !PAYEE_PARTY_TYPES.has(replayCase.party.partyType)) {
    return [];
  }
  const change = detectPaymentDetailsChange(details.stored, details.printed);
  if (!change) return [];
  return [
    {
      ruleKey: PAYMENT_DETAILS_RULE_KEY,
      impact: "blocking",
      message:
        "This document asks for payment to bank details that differ from the ones on file for the payee.",
      evidence: { fields: change.fields, stored: change.stored, document: change.document },
    },
  ];
}

function replayCase(
  replayCase: ReplayCase,
  configByKey: ReadonlyMap<string, RuleConfigView>,
  formulaVersions: ReadonlyMap<string, number>,
  fallbacks: BookRuleFallbacks,
): ReplayCaseResult {
  const accounts = new Map<string, BookRuleAccount>(
    Object.entries(replayCase.accounts).map(([id, account]) => [
      id,
      {
        id,
        accountType: account.accountType,
        subtype: account.subtype,
        childCount: account.childCount,
      },
    ]),
  );
  const bookFindings = evaluateCandidateRules(
    { configByKey, fallbacks },
    {
      candidate: { ...replayCase.candidate, lines: replayCase.lines },
      lines: replayCase.lines,
      accounts,
      party: replayCase.party,
      documents: replayCase.documents,
      functionalCurrency: replayCase.candidate.functionalCurrency,
    },
  ).map((finding) => ({ ...finding, evidence: { ...finding.evidence } }));
  const findings = [
    ...bookFindings,
    ...duplicateFindings(
      replayCase,
      configByKey.get("possible_duplicate"),
      formulaVersions.get("possible_duplicate"),
    ),
    ...materialExpenseFindings(replayCase, configByKey.get("material_expense")),
    ...paymentDetailsFindings(replayCase),
  ]
    .map((finding, order) => ({ finding, order }))
    // Stable: by rule key, then the order the evaluators produced them.
    .sort(
      (left, right) =>
        compareText(left.finding.ruleKey, right.finding.ruleKey) || left.order - right.order,
    )
    .map(({ finding }) => finding);
  return {
    caseId: replayCase.id,
    findings,
    blocked: findings.some((finding) => finding.impact === "blocking"),
  };
}

/** Re-evaluate every case under one rule set. Writes nothing. */
export function replayRules(input: {
  cases: readonly ReplayCase[];
  rules: ReplayRuleSet;
}): ReplayCaseResult[] {
  const configByKey = ruleConfigMapFromEntries(input.rules.entries);
  const formulaVersions = new Map(
    input.rules.entries.map((entry) => [entry.ruleKey, entry.formulaVersion]),
  );
  const fallbacks = input.rules.fallbacks ?? DEFAULT_BOOK_RULE_FALLBACKS;
  return input.cases.map((item) => replayCase(item, configByKey, formulaVersions, fallbacks));
}
