// ============================================================================
// Persist deterministic anomaly annotations for a reconciliation.
//
// Advisory only: this never blocks finalization (the arithmetic gate in
// reconciliation-finalize.ts is the authority). Flags land in the same
// transaction as the finalize so a finalized reconciliation carries its
// annotations for audit.
// ============================================================================

import { and, desc, eq, ne } from "drizzle-orm";
import type { DbExecutor } from "../db";
import { reconciliationFlags, reconciliations, statementLines } from "../db/schema/reconciliations";
import { detectAnomalies, type AnomalyHistoryEntry } from "./reconciliation-anomalies";
import { createLogger } from "./logger";

const logger = createLogger("reconciliation.anomalies");

/** Prior statement lines to compare against (same bank account, earlier periods). */
const HISTORY_LIMIT = 500;

/**
 * Detect and persist anomaly flags for a reconciliation.
 * Best-effort: a failure here must never fail a finalize.
 * Returns the number of flags written.
 */
export async function persistReconciliationAnomalies(
  db: DbExecutor,
  input: { orgId: string; reconciliationId: string; bankAccountId: string },
): Promise<number> {
  try {
    const lines = await db
      .select({
        id: statementLines.id,
        transactionDate: statementLines.transactionDate,
        description: statementLines.description,
        amount: statementLines.amount,
        matchStatus: statementLines.matchStatus,
      })
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, input.reconciliationId));
    if (lines.length === 0) return 0;

    // History: this bank account's lines from OTHER reconciliations.
    const historyRows = await db
      .select({
        description: statementLines.description,
        amount: statementLines.amount,
      })
      .from(statementLines)
      .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
      .where(
        and(
          eq(reconciliations.organizationId, input.orgId),
          eq(reconciliations.bankAccountId, input.bankAccountId),
          ne(statementLines.reconciliationId, input.reconciliationId),
        ),
      )
      .orderBy(desc(statementLines.createdAt))
      .limit(HISTORY_LIMIT);

    const history: AnomalyHistoryEntry[] = historyRows.map((r) => ({
      description: r.description,
      amount: Number(r.amount),
    }));

    const anomalies = detectAnomalies(
      lines.map((l) => ({
        id: l.id,
        transactionDate: l.transactionDate,
        description: l.description,
        amount: Number(l.amount),
        matchStatus: l.matchStatus,
      })),
      history,
    );
    if (anomalies.length === 0) return 0;

    // Don't duplicate annotations on re-finalize: clear this reconciliation's
    // prior unresolved anomaly flags that have no linked suggestion.
    await db
      .delete(reconciliationFlags)
      .where(
        and(
          eq(reconciliationFlags.reconciliationId, input.reconciliationId),
          eq(reconciliationFlags.resolved, false),
          eq(reconciliationFlags.suggestedAction, "manual_review"),
        ),
      );

    await db.insert(reconciliationFlags).values(
      anomalies.map((a) => ({
        reconciliationId: input.reconciliationId,
        statementLineId: a.statementLineId,
        flagType: a.flagType,
        suggestedAction: a.suggestedAction,
        description: a.description,
      })),
    );

    return anomalies.length;
  } catch (err) {
    logger.warn("Anomaly detection failed (non-fatal)", {
      orgId: input.orgId,
      reconciliationId: input.reconciliationId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}
