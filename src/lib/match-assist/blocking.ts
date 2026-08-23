// ============================================================================
// Candidate blocking — pure, deterministic pre-filtering before any model
// call (AI_NATIVE_ARCHITECTURE §7: "blocking happens in SQL/code, the LLM
// arbitrates within blocks").
//
// The model never sees the whole ledger: for each residual unmatched
// statement line it receives a small candidate set assembled from
// amount/date proximity, token overlap, and vendor-alias hints — plus
// pre-computed split combinations, so the model chooses among arithmetic
// options rather than doing arithmetic.
// ============================================================================

import type { LedgerTransactionForMatching } from "../auto-matcher";
import { normalizeDescriptor } from "./normalize";
import type { MatchAssistBlock, MatchAssistCandidate } from "../ai/prompts/match-assist";

/** Statement line shape the blocker needs. */
export interface BlockableStatementLine {
  id: string;
  transactionDate: string; // YYYY-MM-DD
  description: string;
  amount: number; // signed, statement convention
}

export interface BuildBlocksOptions {
  /** Date window in days around the statement line (default ±7). */
  dateWindowDays?: number;
  /** Relative amount tolerance for near-amount candidates (default 1%). */
  amountTolerance?: number;
  /** Max candidates per line handed to the model (default 8). */
  maxCandidatesPerLine?: number;
  /** Max ledger lines per split combination (default 3). */
  maxSplitParts?: number;
  /** normalizedDescriptor → partyName, from vendor_aliases. */
  aliasPartyByDescriptor?: Map<string, string>;
}

const DEFAULTS = {
  dateWindowDays: 7,
  amountTolerance: 0.01,
  maxCandidatesPerLine: 8,
  maxSplitParts: 3,
};

function daysBetween(a: string, b: string): number {
  const ms = Math.abs(new Date(`${a}T00:00:00`).getTime() - new Date(`${b}T00:00:00`).getTime());
  return Math.round(ms / 86_400_000);
}

function centsEqual(a: number, b: number): boolean {
  return Math.round(a * 100) === Math.round(b * 100);
}

/** Word-token overlap (Jaccard) on normalized descriptors, 0–1. */
export function tokenOverlap(a: string, b: string): number {
  const tokensA = new Set(normalizeDescriptor(a).split(" ").filter(Boolean));
  const tokensB = new Set(normalizeDescriptor(b).split(" ").filter(Boolean));
  if (tokensA.size === 0 || tokensB.size === 0) return 0;
  let shared = 0;
  for (const token of tokensA) if (tokensB.has(token)) shared++;
  return shared / (tokensA.size + tokensB.size - shared);
}

/**
 * Enumerate ledger subsets (size 2..maxParts) whose amounts sum to the
 * statement line amount — the split candidates. Computed in TypeScript so
 * the model picks from verified arithmetic instead of producing it.
 */
export function findSplitCombinations(
  target: number,
  candidates: LedgerTransactionForMatching[],
  maxParts: number = DEFAULTS.maxSplitParts,
): Array<{ journalLineIds: string[]; total: number }> {
  const results: Array<{ journalLineIds: string[]; total: number }> = [];
  // Bounded search: blocking already trims the pool, and maxParts is small.
  // Only same-sign candidates: a +500/-200 pair "summing" to 300 is a pair
  // of offsetting entries, not a split of one statement charge (audit P6).
  const targetSign = Math.sign(target);
  const pool = candidates
    .filter((candidate) => candidate.amount === 0 || Math.sign(candidate.amount) === targetSign)
    .slice(0, 12);

  const walk = (start: number, picked: LedgerTransactionForMatching[], sum: number) => {
    if (picked.length >= 2 && centsEqual(sum, target)) {
      results.push({ journalLineIds: picked.map((p) => p.journalLineId), total: sum });
      return; // don't extend an exact match with zero-sum tails
    }
    if (picked.length >= maxParts) return;
    for (let i = start; i < pool.length; i++) {
      walk(i + 1, [...picked, pool[i]], sum + pool[i].amount);
    }
  };
  walk(0, [], 0);

  return results.slice(0, 3);
}

/**
 * Build one candidate block per unmatched statement line. Lines with no
 * plausible candidate are omitted entirely — no model call is wasted on them.
 */
export function buildMatchBlocks(
  statementLines: BlockableStatementLine[],
  ledgerTxns: LedgerTransactionForMatching[],
  options: BuildBlocksOptions = {},
): MatchAssistBlock[] {
  const opts = { ...DEFAULTS, ...options };
  const blocks: MatchAssistBlock[] = [];

  for (const line of statementLines) {
    const aliasParty = opts.aliasPartyByDescriptor?.get(normalizeDescriptor(line.description));

    const scored: Array<{ txn: LedgerTransactionForMatching; score: number; aliasMatch: boolean }> =
      [];

    for (const txn of ledgerTxns) {
      const dateDiff = daysBetween(line.transactionDate, txn.date);
      if (dateDiff > opts.dateWindowDays) continue;

      const exactAmount = centsEqual(Math.abs(txn.amount), Math.abs(line.amount));
      const nearAmount =
        !exactAmount &&
        Math.abs(Math.abs(txn.amount) - Math.abs(line.amount)) <=
          Math.abs(line.amount) * opts.amountTolerance;
      const overlap = tokenOverlap(line.description, txn.description);
      const aliasMatch = Boolean(aliasParty && txn.partyName && txn.partyName === aliasParty);

      // A candidate needs at least one real signal.
      if (!exactAmount && !nearAmount && overlap < 0.3 && !aliasMatch) continue;

      // Ranking only — the model makes the actual decision.
      const score =
        (exactAmount ? 60 : nearAmount ? 30 : 0) +
        overlap * 25 +
        (aliasMatch ? 20 : 0) +
        Math.max(0, 10 - dateDiff);
      scored.push({ txn, score, aliasMatch });
    }

    if (scored.length === 0) continue;
    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, opts.maxCandidatesPerLine);

    const candidates: MatchAssistCandidate[] = top.map(({ txn, aliasMatch }) => ({
      journalLineId: txn.journalLineId,
      date: txn.date,
      amount: txn.amount,
      description: txn.description,
      ...(txn.partyName ? { partyName: txn.partyName } : {}),
      ...(aliasMatch ? { aliasMatch: true } : {}),
    }));

    const splitCombinations = findSplitCombinations(
      line.amount,
      top.map((t) => t.txn),
      opts.maxSplitParts,
    );

    blocks.push({
      statementLine: {
        statementLineId: line.id,
        date: line.transactionDate,
        amount: line.amount,
        description: line.description,
      },
      candidates,
      ...(splitCombinations.length > 0 ? { splitCombinations } : {}),
    });
  }

  return blocks;
}
