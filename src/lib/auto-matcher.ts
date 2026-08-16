// ============================================================================
// Auto-Matcher — AI-driven transaction matching for bank reconciliation
// Matches OCR-extracted statement lines against ledger transactions.
// Produces ranked suggestions with confidence scores.
// ============================================================================

// ============================================================================
// Types
// ============================================================================

/** A statement line to be matched */
export interface StatementLineForMatching {
  id: string; // statement_lines.id
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // Positive = deposit, negative = withdrawal
}

/** A ledger transaction to match against */
export interface LedgerTransactionForMatching {
  journalLineId: string; // journal_lines.id
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // Positive = debit, negative = credit (from bank's perspective)
  partyName?: string;
  memo?: string;
}

/** Individual match result */
export interface MatchCandidate {
  statementLineId: string;
  journalLineId: string;
  confidence: number; // 0-100
  matchType: "exact" | "near_date" | "fuzzy_description" | "amount_only";
  reasoning: string;
}

/** A suggestion generated from matching */
export interface MatchSuggestion {
  statementLineId: string;
  journalLineId: string | null;
  suggestionType: "auto_match" | "date_fix" | "create_txn" | "duplicate" | "ignore";
  confidence: number;
  description: string;
  proposedChanges?: Record<string, { from: unknown; to: unknown }>;
}

/** Full matching result */
export interface MatchingResult {
  autoMatched: MatchCandidate[]; // confidence >= threshold → auto-link
  suggestions: MatchSuggestion[]; // Below threshold → human review
  unmatchedStatementLines: string[]; // No candidates found
  unmatchedLedgerTxns: string[]; // Ledger entries with no statement match
}

// ============================================================================
// Constants
// ============================================================================

const AUTO_MATCH_THRESHOLD = 85; // Auto-link if confidence >= 85%
const DATE_WINDOW_DAYS = 3; // ±3 days for near-date matching
const DUPLICATE_THRESHOLD = 95; // Flag as potential duplicate if two statement lines match same ledger

// ============================================================================
// Main Matching Function
// ============================================================================

/**
 * Run the auto-matcher algorithm.
 * Matches statement lines against ledger transactions and generates suggestions.
 */
export function runAutoMatcher(
  statementLines: StatementLineForMatching[],
  ledgerTxns: LedgerTransactionForMatching[],
  threshold: number = AUTO_MATCH_THRESHOLD,
): MatchingResult {
  const autoMatched: MatchCandidate[] = [];
  const suggestions: MatchSuggestion[] = [];
  const matchedLedgerIds = new Set<string>();
  const matchedStatementIds = new Set<string>();
  const unmatchedStatementLines: string[] = [];

  // ── Pass 1: Exact matches (same date + same amount) ────────────────────
  for (const stmtLine of statementLines) {
    const exactMatches = ledgerTxns.filter(
      (lt) =>
        !matchedLedgerIds.has(lt.journalLineId) &&
        lt.date === stmtLine.date &&
        amountsEqual(stmtLine.amount, lt.amount),
    );

    if (exactMatches.length === 1) {
      const match: MatchCandidate = {
        statementLineId: stmtLine.id,
        journalLineId: exactMatches[0].journalLineId,
        confidence: 100,
        matchType: "exact",
        reasoning: `Exact match: same date (${stmtLine.date}) and amount ($${Math.abs(stmtLine.amount).toFixed(2)})`,
      };

      autoMatched.push(match);
      matchedLedgerIds.add(exactMatches[0].journalLineId);
      matchedStatementIds.add(stmtLine.id);
    } else if (exactMatches.length > 1) {
      // Multiple exact matches — try to disambiguate by description
      const best = findBestDescriptionMatch(stmtLine, exactMatches);
      if (best && best.score > 0.5) {
        const match: MatchCandidate = {
          statementLineId: stmtLine.id,
          journalLineId: best.txn.journalLineId,
          confidence: 95,
          matchType: "exact",
          reasoning: `Exact date+amount with best description match (${(best.score * 100).toFixed(0)}% similarity)`,
        };
        autoMatched.push(match);
        matchedLedgerIds.add(best.txn.journalLineId);
        matchedStatementIds.add(stmtLine.id);
      }
    }
  }

  // ── Pass 2: Near-date matches (amount matches, date within ±3 days) ────
  for (const stmtLine of statementLines) {
    if (matchedStatementIds.has(stmtLine.id)) continue;

    const nearMatches = ledgerTxns.filter(
      (lt) =>
        !matchedLedgerIds.has(lt.journalLineId) &&
        amountsEqual(stmtLine.amount, lt.amount) &&
        dateDiffDays(stmtLine.date, lt.date) <= DATE_WINDOW_DAYS,
    );

    if (nearMatches.length === 1) {
      const daysDiff = dateDiffDays(stmtLine.date, nearMatches[0].date);
      const confidence = 95 - daysDiff * 3; // 92, 89, 86 for 1,2,3 days

      if (confidence >= threshold) {
        autoMatched.push({
          statementLineId: stmtLine.id,
          journalLineId: nearMatches[0].journalLineId,
          confidence,
          matchType: "near_date",
          reasoning: `Amount matches, date differs by ${daysDiff} day(s): statement ${stmtLine.date} vs ledger ${nearMatches[0].date}`,
        });
        matchedLedgerIds.add(nearMatches[0].journalLineId);
        matchedStatementIds.add(stmtLine.id);
      } else {
        // Below threshold → suggest with date fix
        suggestions.push({
          statementLineId: stmtLine.id,
          journalLineId: nearMatches[0].journalLineId,
          suggestionType: "date_fix",
          confidence,
          description: `Amount matches ($${Math.abs(stmtLine.amount).toFixed(2)}), date differs by ${daysDiff} day(s). Consider adjusting ledger date from ${nearMatches[0].date} to ${stmtLine.date}.`,
          proposedChanges: {
            date: { from: nearMatches[0].date, to: stmtLine.date },
          },
        });
        matchedStatementIds.add(stmtLine.id);
      }
    } else if (nearMatches.length > 1) {
      // Multiple near matches — pick closest date
      const sorted = nearMatches.sort(
        (a, b) => dateDiffDays(stmtLine.date, a.date) - dateDiffDays(stmtLine.date, b.date),
      );
      const best = sorted[0];
      const daysDiff = dateDiffDays(stmtLine.date, best.date);
      const confidence = 90 - daysDiff * 3;

      suggestions.push({
        statementLineId: stmtLine.id,
        journalLineId: best.journalLineId,
        suggestionType: "date_fix",
        confidence,
        description: `${nearMatches.length} potential matches found. Closest: date differs by ${daysDiff} day(s), amount $${Math.abs(stmtLine.amount).toFixed(2)}.`,
        proposedChanges: {
          date: { from: best.date, to: stmtLine.date },
        },
      });
      matchedStatementIds.add(stmtLine.id);
    }
  }

  // ── Pass 3: Fuzzy description match (similar description + close amount) ─
  for (const stmtLine of statementLines) {
    if (matchedStatementIds.has(stmtLine.id)) continue;

    const candidates = ledgerTxns
      .filter((lt) => !matchedLedgerIds.has(lt.journalLineId))
      .map((lt) => ({
        txn: lt,
        descScore: descriptionSimilarity(stmtLine.description, lt),
        amountClose: amountProximity(stmtLine.amount, lt.amount),
        dateDiff: dateDiffDays(stmtLine.date, lt.date),
      }))
      .filter((c) => c.descScore > 0.3 && c.amountClose > 0.8)
      .sort((a, b) => {
        // Combined score
        const scoreA = a.descScore * 0.5 + a.amountClose * 0.3 + (1 - a.dateDiff / 30) * 0.2;
        const scoreB = b.descScore * 0.5 + b.amountClose * 0.3 + (1 - b.dateDiff / 30) * 0.2;
        return scoreB - scoreA;
      });

    if (candidates.length > 0) {
      const best = candidates[0];
      const confidence = Math.round(
        best.descScore * 40 + best.amountClose * 40 + (1 - best.dateDiff / 30) * 20,
      );

      suggestions.push({
        statementLineId: stmtLine.id,
        journalLineId: best.txn.journalLineId,
        suggestionType: "auto_match",
        confidence: Math.min(confidence, 84), // Cap below auto-match threshold
        description: `Possible match: "${stmtLine.description}" ↔ "${best.txn.description}" (${confidence}% combined score)`,
      });
      matchedStatementIds.add(stmtLine.id);
    }
  }

  // ── Pass 4: Unmatched statement lines → suggest creating transactions ──
  for (const stmtLine of statementLines) {
    if (matchedStatementIds.has(stmtLine.id)) continue;

    unmatchedStatementLines.push(stmtLine.id);
    suggestions.push({
      statementLineId: stmtLine.id,
      journalLineId: null,
      suggestionType: "create_txn",
      confidence: 0,
      description: `No matching ledger transaction found for "${stmtLine.description}" ($${Math.abs(stmtLine.amount).toFixed(2)} on ${stmtLine.date}). Consider creating a new transaction.`,
    });
  }

  // ── Unmatched ledger transactions ──────────────────────────────────────
  const unmatchedLedgerTxns = ledgerTxns
    .filter((lt) => !matchedLedgerIds.has(lt.journalLineId))
    .map((lt) => lt.journalLineId);

  // ── Duplicate detection ──────────────────────────────────────────────────
  // Check if multiple statement lines target the same ledger transaction
  // (across both autoMatched and suggestions)
  const ledgerMatchCounts = new Map<string, string[]>();
  for (const m of autoMatched) {
    const existing = ledgerMatchCounts.get(m.journalLineId) || [];
    existing.push(m.statementLineId);
    ledgerMatchCounts.set(m.journalLineId, existing);
  }
  for (const s of suggestions) {
    if (s.journalLineId) {
      const existing = ledgerMatchCounts.get(s.journalLineId) || [];
      existing.push(s.statementLineId);
      ledgerMatchCounts.set(s.journalLineId, existing);
    }
  }
  for (const [ledgerId, stmtIds] of ledgerMatchCounts) {
    if (stmtIds.length > 1) {
      for (const stmtId of stmtIds.slice(1)) {
        // Avoid adding duplicate suggestion if one already exists for this pair
        const alreadyFlagged = suggestions.some(
          (s) =>
            s.statementLineId === stmtId &&
            s.journalLineId === ledgerId &&
            s.suggestionType === "duplicate",
        );
        if (!alreadyFlagged) {
          suggestions.push({
            statementLineId: stmtId,
            journalLineId: ledgerId,
            suggestionType: "duplicate",
            confidence: DUPLICATE_THRESHOLD,
            description: `Possible duplicate: this statement line matches the same ledger transaction as another line.`,
          });
        }
      }
    }
  }

  return {
    autoMatched,
    suggestions,
    unmatchedStatementLines,
    unmatchedLedgerTxns,
  };
}

// ============================================================================
// Helpers
// ============================================================================

/**
 * Check if two amounts are equal (accounting for sign conventions).
 * Statement: positive = deposit, negative = withdrawal.
 * Ledger: from the bank account's perspective, debits increase the balance (deposits),
 *   credits decrease (withdrawals). The sign convention is passed through directly.
 */
function amountsEqual(stmtAmount: number, ledgerAmount: number): boolean {
  // Sign check: both must be same direction (deposit vs withdrawal)
  // to prevent matching a $500 deposit to a $500 withdrawal.
  if (Math.sign(stmtAmount) !== Math.sign(ledgerAmount) && stmtAmount !== 0 && ledgerAmount !== 0) {
    return false;
  }
  const stmtCents = Math.round(Math.abs(stmtAmount) * 100);
  const ledgerCents = Math.round(Math.abs(ledgerAmount) * 100);
  return stmtCents === ledgerCents;
}

/**
 * How close two amounts are (0-1 scale).
 * 1.0 = exact match, decreases as amounts diverge.
 */
function amountProximity(a: number, b: number): number {
  const absA = Math.abs(a);
  const absB = Math.abs(b);
  if (absA === 0 && absB === 0) return 1;
  // Penalize mismatched signs heavily
  if (Math.sign(a) !== Math.sign(b) && a !== 0 && b !== 0) return 0;
  const diff = Math.abs(absA - absB);
  const max = Math.max(absA, absB);
  return Math.max(0, 1 - diff / max);
}

/**
 * Absolute difference in days between two date strings.
 */
function dateDiffDays(dateA: string, dateB: string): number {
  const a = new Date(dateA);
  const b = new Date(dateB);
  return Math.round(Math.abs(a.getTime() - b.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Description similarity score (0-1).
 * Combines token overlap with containment checks.
 */
function descriptionSimilarity(stmtDesc: string, ledgerTxn: LedgerTransactionForMatching): number {
  const normalize = (s: string) =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9]/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  const stmtNorm = normalize(stmtDesc);

  // Combine ledger description, party name, and memo
  const ledgerParts = [ledgerTxn.description, ledgerTxn.partyName || "", ledgerTxn.memo || ""]
    .filter(Boolean)
    .join(" ");
  const ledgerNorm = normalize(ledgerParts);

  if (!stmtNorm || !ledgerNorm) return 0;

  // Containment check
  if (stmtNorm.includes(ledgerNorm) || ledgerNorm.includes(stmtNorm)) return 0.9;

  // Token overlap (Jaccard)
  const stmtTokens = new Set(stmtNorm.split(" ").filter((t) => t.length > 2));
  const ledgerTokens = new Set(ledgerNorm.split(" ").filter((t) => t.length > 2));

  if (stmtTokens.size === 0 || ledgerTokens.size === 0) return 0;

  let intersection = 0;
  for (const token of stmtTokens) {
    if (ledgerTokens.has(token)) intersection++;
  }

  const union = new Set([...stmtTokens, ...ledgerTokens]).size;
  return intersection / union;
}

/**
 * Find the best description match among multiple amount-matching candidates.
 */
function findBestDescriptionMatch(
  stmtLine: StatementLineForMatching,
  candidates: LedgerTransactionForMatching[],
): { txn: LedgerTransactionForMatching; score: number } | null {
  let best: { txn: LedgerTransactionForMatching; score: number } | null = null;

  for (const txn of candidates) {
    const score = descriptionSimilarity(stmtLine.description, txn);
    if (!best || score > best.score) {
      best = { txn, score };
    }
  }

  return best;
}
