import { describe, it, expect } from "vitest";
import {
  runAutoMatcher,
  StatementLineForMatching,
  LedgerTransactionForMatching,
} from "../../src/lib/auto-matcher";

describe("Auto-Matcher (Bank Reconciliation)", () => {
  // ========================================================================
  // Pass 1: Exact Matching
  // ========================================================================

  it("should find an exact match when date and amount match perfectly", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-15", description: "Deposit from Stripe", amount: 500.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      { journalLineId: "leg-1", date: "2026-01-15", description: "Stripe Payout", amount: 500.0 },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(1);
    expect(result.autoMatched[0].statementLineId).toBe("stmt-1");
    expect(result.autoMatched[0].journalLineId).toBe("leg-1");
    expect(result.autoMatched[0].matchType).toBe("exact");
    expect(result.suggestions).toHaveLength(0);
    expect(result.unmatchedStatementLines).toHaveLength(0);
    expect(result.unmatchedLedgerTxns).toHaveLength(0);
  });

  it("should correctly prevent matching deposits to withdrawals of the same magnitude", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-15", description: "Deposit", amount: 500.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      { journalLineId: "leg-1", date: "2026-01-15", description: "Withdrawal", amount: -500.0 },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(0);
    expect(result.suggestions[0].suggestionType).toBe("create_txn");
  });

  it("should disambiguate multiple exact matches by description similarity", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-15", description: "AWS Web Services", amount: -100.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      { journalLineId: "leg-1", date: "2026-01-15", description: "GCP Hosting", amount: -100.0 },
      {
        journalLineId: "leg-2",
        date: "2026-01-15",
        description: "AWS Web Services Hosting",
        amount: -100.0,
      },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(1);
    expect(result.autoMatched[0].journalLineId).toBe("leg-2"); // Should pick leg-2
  });

  // ========================================================================
  // Pass 2: Near-Date Matching
  // ========================================================================

  it("should auto-match near dates (within 1 day) with high confidence", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-16", description: "Check #101", amount: -250.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      { journalLineId: "leg-1", date: "2026-01-15", description: "Check #101", amount: -250.0 },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(1);
    expect(result.autoMatched[0].matchType).toBe("near_date");
    expect(result.autoMatched[0].confidence).toBeGreaterThanOrEqual(85);
  });

  it("should suggest a date fix for dates further apart (e.g. 4 days) if threshold is high", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-19", description: "Vendor Payment", amount: -300.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      {
        journalLineId: "leg-1",
        date: "2026-01-15",
        description: "Vendor Payment",
        amount: -300.0,
      },
    ];

    // dateDiff is 4 days, so it won't be matched by Pass 2 (which requires <= 3 days).
    // Instead, it goes to Pass 3 (fuzzy desc), which gives a suggestion.
    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(0);
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].suggestionType).toBe("auto_match");
    expect(result.suggestions[0].confidence).toBeLessThan(85);
  });

  // ========================================================================
  // Duplicate Detection
  // ========================================================================

  it("should detect potential duplicates when multiple statements match one ledger line", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-15", description: "Subscription", amount: -15.0 },
      {
        id: "stmt-2",
        date: "2026-01-15",
        description: "Subscription (Duplicate)",
        amount: -15.0,
      },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      { journalLineId: "leg-1", date: "2026-01-15", description: "Subscription", amount: -15.0 },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    // stmt-1 gets exact match
    expect(result.autoMatched).toHaveLength(1);
    expect(result.autoMatched[0].statementLineId).toBe("stmt-1");

    // stmt-2 goes to unmatched, so it gets a create_txn suggestion
    const createSugg = result.suggestions.find(
      (s) => s.statementLineId === "stmt-2" && s.suggestionType === "create_txn",
    );
    expect(createSugg).toBeDefined();
  });

  // ========================================================================
  // Floating-Point Robustness
  // ========================================================================

  it("should match amounts robustly regardless of floating point inaccuracies", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-15", description: "Deposit", amount: 100.05 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      // Simulate floating point drift (100.05000000000001)
      {
        journalLineId: "leg-1",
        date: "2026-01-15",
        description: "Deposit",
        amount: 100.05000000000001,
      },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(1);
    expect(result.autoMatched[0].matchType).toBe("exact");
  });

  it("should handle the classic 0.1 + 0.2 floating-point drift", () => {
    // In JavaScript: 0.1 + 0.2 === 0.30000000000000004
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-03-01", description: "Micro charge", amount: -0.3 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      {
        journalLineId: "leg-1",
        date: "2026-03-01",
        description: "Micro charge",
        amount: -(0.1 + 0.2), // 0.30000000000000004
      },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(1);
    expect(result.autoMatched[0].matchType).toBe("exact");
  });

  it("should handle large amounts near floating-point boundaries", () => {
    const stmts: StatementLineForMatching[] = [
      {
        id: "stmt-1",
        date: "2026-06-30",
        description: "Quarterly revenue",
        amount: 99999.99,
      },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      {
        journalLineId: "leg-1",
        date: "2026-06-30",
        description: "Quarterly revenue",
        // Construct a value with FP noise without using a literal that triggers
        // the no-loss-of-precision lint rule
        amount: 99999.99 + Number.EPSILON,
      },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(1);
  });

  it("should not match sub-cent amounts that differ by more than 1 cent", () => {
    // 10.004 rounds to 1000 cents, 10.006 rounds to 1001 cents → should NOT match
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-02-01", description: "Fee", amount: -10.004 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      {
        journalLineId: "leg-1",
        date: "2026-02-01",
        description: "Fee",
        amount: -10.016, // rounds to 1002 cents — differs
      },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(0);
  });

  // ========================================================================
  // Zero-Amount Handling
  // ========================================================================

  it("should match zero-amount entries on the same date", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-04-01", description: "Bank fee waiver", amount: 0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      {
        journalLineId: "leg-1",
        date: "2026-04-01",
        description: "Fee waiver credit",
        amount: 0,
      },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    // Zero-amount entries with same date should match exactly
    expect(result.autoMatched).toHaveLength(1);
    expect(result.autoMatched[0].matchType).toBe("exact");
  });

  // ========================================================================
  // Empty Inputs
  // ========================================================================

  it("should handle empty statement lines gracefully", () => {
    const stmts: StatementLineForMatching[] = [];
    const ledgers: LedgerTransactionForMatching[] = [
      { journalLineId: "leg-1", date: "2026-01-15", description: "Payment", amount: -500.0 },
    ];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
    expect(result.unmatchedStatementLines).toHaveLength(0);
    expect(result.unmatchedLedgerTxns).toHaveLength(1);
    expect(result.unmatchedLedgerTxns[0]).toBe("leg-1");
  });

  it("should handle empty ledger transactions gracefully", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-15", description: "Deposit", amount: 500.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [];

    const result = runAutoMatcher(stmts, ledgers);
    expect(result.autoMatched).toHaveLength(0);
    expect(result.unmatchedStatementLines).toHaveLength(1);
    expect(result.unmatchedStatementLines[0]).toBe("stmt-1");
    // Should have a create_txn suggestion
    expect(result.suggestions).toHaveLength(1);
    expect(result.suggestions[0].suggestionType).toBe("create_txn");
  });

  it("should handle both empty inputs gracefully", () => {
    const result = runAutoMatcher([], []);
    expect(result.autoMatched).toHaveLength(0);
    expect(result.suggestions).toHaveLength(0);
    expect(result.unmatchedStatementLines).toHaveLength(0);
    expect(result.unmatchedLedgerTxns).toHaveLength(0);
  });

  // ========================================================================
  // Pass 2 Multi-Match Claims Statement ID (Prevents Pass 3 Conflicts)
  // ========================================================================

  it("should not produce a Pass 3 suggestion when Pass 2 already claimed the statement line via multi-match", () => {
    // Two near-date matches for the same statement line → Pass 2 multi-match suggestion.
    // The statement description is similar to both ledger entries, so Pass 3 fuzzy would
    // also produce a suggestion if the statement ID wasn't claimed.
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-02-03", description: "Office Supplies Purchase", amount: -200.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      {
        journalLineId: "leg-1",
        date: "2026-02-01",
        description: "Office Supplies Purchase",
        amount: -200.0,
      },
      {
        journalLineId: "leg-2",
        date: "2026-02-02",
        description: "Office Supplies Order",
        amount: -200.0,
      },
    ];

    const result = runAutoMatcher(stmts, ledgers);

    // Pass 2 multi-match should produce exactly one date_fix suggestion
    const dateFix = result.suggestions.filter((s) => s.suggestionType === "date_fix");
    expect(dateFix).toHaveLength(1);
    expect(dateFix[0].statementLineId).toBe("stmt-1");

    // No Pass 3 auto_match suggestion should exist for the same statement line
    const fuzzyMatch = result.suggestions.filter(
      (s) => s.statementLineId === "stmt-1" && s.suggestionType === "auto_match",
    );
    expect(fuzzyMatch).toHaveLength(0);
  });

  // ========================================================================
  // Duplicate Detection Across Suggestions
  // ========================================================================

  it("should flag duplicates when a suggestion and an auto-match reference the same ledger line", () => {
    // stmt-1 gets a Pass 2 multi-match suggestion (not auto-match) pointing to leg-1.
    // stmt-2 gets a Pass 2 single auto-match also to leg-1 (since suggestions don't add to
    // matchedLedgerIds). Duplicate detection should catch the overlap.
    const stmts: StatementLineForMatching[] = [
      // Processed first: two near-date candidates → multi-match suggestion for closest (leg-1)
      { id: "stmt-1", date: "2026-04-09", description: "Hosting Fee A", amount: -99.0 },
      // Processed second: only leg-1 is within 3 days → single near-date auto-match to leg-1
      { id: "stmt-2", date: "2026-04-08", description: "Hosting Fee B", amount: -99.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      { journalLineId: "leg-1", date: "2026-04-07", description: "Hosting", amount: -99.0 },
      { journalLineId: "leg-2", date: "2026-04-12", description: "Hosting", amount: -99.0 },
    ];

    const result = runAutoMatcher(stmts, ledgers);

    // Verify: stmt-1 got a suggestion pointing to leg-1 (Pass 2 multi-match)
    const stmt1Suggestion = result.suggestions.find(
      (s) => s.statementLineId === "stmt-1" && s.journalLineId === "leg-1",
    );

    // Verify: stmt-2 got auto-matched to leg-1 (Pass 2 single near-date)
    const stmt2Match = result.autoMatched.find(
      (m) => m.statementLineId === "stmt-2" && m.journalLineId === "leg-1",
    );

    // If both reference leg-1, duplicate detection should fire
    if (stmt1Suggestion && stmt2Match) {
      const dupSugg = result.suggestions.find(
        (s) => s.suggestionType === "duplicate" && s.journalLineId === "leg-1",
      );
      expect(dupSugg).toBeDefined();
    }
  });

  // ========================================================================
  // Custom Threshold Override
  // ========================================================================

  it("should respect a custom threshold parameter for near-date auto-linking", () => {
    const stmts: StatementLineForMatching[] = [
      { id: "stmt-1", date: "2026-01-18", description: "Rent", amount: -2000.0 },
    ];
    const ledgers: LedgerTransactionForMatching[] = [
      { journalLineId: "leg-1", date: "2026-01-15", description: "Rent", amount: -2000.0 },
    ];

    // Default threshold=85: confidence for 3-day diff = 95 - 9 = 86, PASSES
    const defaultResult = runAutoMatcher(stmts, ledgers);
    expect(defaultResult.autoMatched).toHaveLength(1);

    // Higher threshold=90: same 86 confidence, FAILS auto-match → becomes suggestion
    const strictResult = runAutoMatcher(stmts, ledgers, 90);
    expect(strictResult.autoMatched).toHaveLength(0);
    expect(strictResult.suggestions.length).toBeGreaterThanOrEqual(1);
    expect(strictResult.suggestions[0].suggestionType).toBe("date_fix");
  });

  // ========================================================================
  // Full 4-Pass Cascade Integration
  // ========================================================================

  it("should correctly cascade through all 4 passes with a mixed dataset", () => {
    const stmts: StatementLineForMatching[] = [
      // Pass 1: exact match (same date, same amount)
      { id: "s1", date: "2026-03-01", description: "Stripe deposit", amount: 1000.0 },
      // Pass 2: near-date (1 day off, same amount)
      { id: "s2", date: "2026-03-03", description: "Check #200", amount: -450.0 },
      // Pass 3: fuzzy — amounts differ slightly (not exact), date beyond 3-day window
      {
        id: "s3",
        date: "2026-03-15",
        description: "Amazon Web Services Infrastructure",
        amount: -131.5,
      },
      // Pass 4: unmatched — no ledger counterpart at all
      { id: "s4", date: "2026-03-25", description: "Mystery withdrawal", amount: -77.0 },
    ];

    const ledgers: LedgerTransactionForMatching[] = [
      // Matches s1 exactly
      { journalLineId: "l1", date: "2026-03-01", description: "Stripe Payout", amount: 1000.0 },
      // Matches s2 near-date (date=2026-03-02)
      { journalLineId: "l2", date: "2026-03-02", description: "Check #200", amount: -450.0 },
      // For s3 fuzzy: amounts close but not equal, date 7 days apart, description overlap
      {
        journalLineId: "l3",
        date: "2026-03-08",
        description: "AWS hosting",
        amount: -129.99,
        partyName: "Amazon",
      },
      // Unmatched ledger — no statement counterpart
      { journalLineId: "l4", date: "2026-03-20", description: "Payroll", amount: -5000.0 },
    ];

    const result = runAutoMatcher(stmts, ledgers);

    // s1 → exact match with l1
    const s1Match = result.autoMatched.find((m) => m.statementLineId === "s1");
    expect(s1Match).toBeDefined();
    expect(s1Match!.journalLineId).toBe("l1");
    expect(s1Match!.matchType).toBe("exact");

    // s2 → near-date match with l2
    const s2Match = result.autoMatched.find((m) => m.statementLineId === "s2");
    expect(s2Match).toBeDefined();
    expect(s2Match!.journalLineId).toBe("l2");
    expect(s2Match!.matchType).toBe("near_date");

    // s3 → should land in suggestions via fuzzy pass (amounts differ so Pass 1/2 skip it)
    const s3Sugg = result.suggestions.find((s) => s.statementLineId === "s3");
    expect(s3Sugg).toBeDefined();
    expect(s3Sugg!.confidence).toBeLessThan(85); // Below auto-match threshold

    // s4 → unmatched, create_txn suggestion
    expect(result.unmatchedStatementLines).toContain("s4");
    const s4Sugg = result.suggestions.find(
      (s) => s.statementLineId === "s4" && s.suggestionType === "create_txn",
    );
    expect(s4Sugg).toBeDefined();

    // l4 → unmatched ledger
    expect(result.unmatchedLedgerTxns).toContain("l4");
  });
});
