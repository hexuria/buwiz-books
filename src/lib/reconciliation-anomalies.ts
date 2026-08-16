// ============================================================================
// Reconciliation anomaly detection — DETERMINISTIC, no model involved.
//
// Runs at finalize as a non-blocking warning pass (the arithmetic gate in
// reconciliation-finalize.ts is untouched). It finally gives producers to
// reconciliation_flags enum values that were defined but never emitted.
// ============================================================================

import { normalizeDescriptor } from "./match-assist/normalize";

export type AnomalyFlagType =
  | "duplicate"
  | "amount_discrepancy"
  | "date_mismatch"
  | "overmatched"
  | "unmatched_statement";

export interface AnomalyInputLine {
  id: string;
  transactionDate: string; // YYYY-MM-DD
  description: string;
  amount: number;
  matchStatus?: string;
}

/** Trailing history for outlier/known-payee comparison (same org+account). */
export interface AnomalyHistoryEntry {
  description: string;
  amount: number;
}

export interface DetectedAnomaly {
  statementLineId: string;
  flagType: AnomalyFlagType;
  suggestedAction: "manual_review";
  description: string;
}

export interface DetectAnomaliesOptions {
  /** Std-devs from the payee's historical mean to call an outlier (default 3). */
  outlierSigma?: number;
  /** Minimum history samples before outlier detection applies (default 4). */
  minHistorySamples?: number;
}

/** Extract a check number from a statement description, when present. */
export function parseCheckNumber(description: string): number | null {
  const match = /\b(?:CHECK|CHK|CHEQUE|CK)\s*#?\s*(\d{2,7})\b/i.exec(description);
  if (!match) return null;
  const n = Number(match[1]);
  return Number.isFinite(n) ? n : null;
}

function mean(values: number[]): number {
  return values.reduce((s, v) => s + v, 0) / values.length;
}

function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = mean(values);
  return Math.sqrt(mean(values.map((v) => (v - m) ** 2)));
}

/**
 * Detect anomalies across a reconciliation's statement lines.
 * Pure function — callers persist the results as reconciliation_flags.
 */
export function detectAnomalies(
  lines: AnomalyInputLine[],
  history: AnomalyHistoryEntry[] = [],
  options: DetectAnomaliesOptions = {},
): DetectedAnomaly[] {
  const outlierSigma = options.outlierSigma ?? 3;
  const minHistorySamples = options.minHistorySamples ?? 4;
  const anomalies: DetectedAnomaly[] = [];

  // ── Same-day, same-amount duplicates ──────────────────────────────────
  const byDayAmount = new Map<string, AnomalyInputLine[]>();
  for (const line of lines) {
    const key = `${line.transactionDate}|${Math.round(line.amount * 100)}`;
    const bucket = byDayAmount.get(key);
    if (bucket) bucket.push(line);
    else byDayAmount.set(key, [line]);
  }
  for (const bucket of byDayAmount.values()) {
    if (bucket.length < 2) continue;
    // Flag the later occurrences, not the first.
    for (const line of bucket.slice(1)) {
      anomalies.push({
        statementLineId: line.id,
        flagType: "duplicate",
        suggestedAction: "manual_review",
        description: `Same date and amount as ${bucket.length - 1} other line(s) on this statement`,
      });
    }
  }

  // ── History-based checks ──────────────────────────────────────────────
  const historyByPayee = new Map<string, number[]>();
  for (const entry of history) {
    const key = normalizeDescriptor(entry.description);
    if (!key) continue;
    const bucket = historyByPayee.get(key);
    if (bucket) bucket.push(Math.abs(entry.amount));
    else historyByPayee.set(key, [Math.abs(entry.amount)]);
  }

  for (const line of lines) {
    const key = normalizeDescriptor(line.description);
    if (!key) continue;
    const samples = historyByPayee.get(key);

    if (!samples || samples.length === 0) {
      // New payee: only interesting when there IS history to be new against.
      if (historyByPayee.size > 0) {
        anomalies.push({
          statementLineId: line.id,
          flagType: "unmatched_statement",
          suggestedAction: "manual_review",
          description: `First transaction with "${line.description}" for this account`,
        });
      }
      continue;
    }

    if (samples.length >= minHistorySamples) {
      const m = mean(samples);
      const sd = stdDev(samples);
      const amount = Math.abs(line.amount);
      if (sd > 0 && Math.abs(amount - m) > outlierSigma * sd) {
        anomalies.push({
          statementLineId: line.id,
          flagType: "amount_discrepancy",
          suggestedAction: "manual_review",
          description: `Amount ${amount.toFixed(2)} is unusual for this payee (typical ≈ ${m.toFixed(2)})`,
        });
      }
    }
  }

  // ── Check-sequence gaps ───────────────────────────────────────────────
  const checkLines = lines
    .map((line) => ({ line, number: parseCheckNumber(line.description) }))
    .filter((entry): entry is { line: AnomalyInputLine; number: number } => entry.number !== null)
    .sort((a, b) => a.number - b.number);

  for (let i = 1; i < checkLines.length; i++) {
    const gap = checkLines[i].number - checkLines[i - 1].number;
    // A gap of 1 is contiguous; huge jumps are usually a different series.
    if (gap > 1 && gap <= 20) {
      anomalies.push({
        statementLineId: checkLines[i].line.id,
        flagType: "date_mismatch",
        suggestedAction: "manual_review",
        description: `Check number gap: ${checkLines[i - 1].number} → ${checkLines[i].number} (${gap - 1} missing)`,
      });
    }
  }

  return anomalies;
}
