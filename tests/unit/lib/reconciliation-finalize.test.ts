/**
 * Unit tests for the cleared/uncleared reconciliation finalize math.
 * These encode the bank-rec correctness rules the finalize gate must enforce.
 */
import { describe, it, expect } from "vitest";
import { computeClearedBalance } from "@/lib/reconciliation-finalize";

describe("computeClearedBalance", () => {
  it("clears exactly the matched activity (happy path)", () => {
    // Bank opens at 1000. Two deposits (300, 200) both matched. Statement ends at 1500.
    const r = computeClearedBalance({
      statementBeginningBalance: 1000,
      statementEndingBalance: 1500,
      clearedDebit: 500,
      clearedCredit: 0,
      totalDebit: 500,
      totalCredit: 0,
      unmatchedStatementLines: 0,
    });
    expect(r.clearedBalance).toBe(1500);
    expect(r.clearedDifference).toBe(0);
    expect(r.unclearedTotal).toBe(0);
  });

  it("an outstanding check (uncleared GL) does NOT break the gate", () => {
    // Bank opens 1000, statement ends 1500 (deposits 500 cleared). A 200 check was
    // written (GL credit) but hasn't hit the bank — classic deposit-in-transit/outstanding.
    const r = computeClearedBalance({
      statementBeginningBalance: 1000,
      statementEndingBalance: 1500,
      clearedDebit: 500,
      clearedCredit: 0,
      totalDebit: 500,
      totalCredit: 200, // outstanding check in GL, not on the statement
      unmatchedStatementLines: 0,
    });
    // Gate passes: cleared balance matches the statement.
    expect(r.clearedDifference).toBe(0);
    // The outstanding check is surfaced as a timing difference, not an error.
    expect(r.unclearedTotal).toBe(-200);
    // Legacy all-GL ledger balance shows the historical (wrong-gate) figure.
    expect(r.ledgerBalance).toBe(1300);
  });

  it("unmatched statement activity DOES break the gate", () => {
    // Statement ends 1500 (500 of deposits on the statement) but nothing was matched.
    // Historical bug: all-GL math would pass this if GL totals coincided.
    const r = computeClearedBalance({
      statementBeginningBalance: 1000,
      statementEndingBalance: 1500,
      clearedDebit: 0,
      clearedCredit: 0,
      totalDebit: 500, // GL has the activity, but nothing is matched
      totalCredit: 0,
      unmatchedStatementLines: 2,
    });
    // Cleared balance is still the opening balance → gate difference of 500 blocks finalize.
    expect(r.clearedBalance).toBe(1000);
    expect(r.clearedDifference).toBe(500);
    expect(r.unmatchedStatementLines).toBe(2);
  });

  it("rounds to cents", () => {
    const r = computeClearedBalance({
      statementBeginningBalance: 0.1,
      statementEndingBalance: 0.3,
      clearedDebit: 0.2,
      clearedCredit: 0,
      totalDebit: 0.2,
      totalCredit: 0,
      unmatchedStatementLines: 0,
    });
    expect(r.clearedBalance).toBe(0.3);
    expect(r.clearedDifference).toBe(0);
  });
});
