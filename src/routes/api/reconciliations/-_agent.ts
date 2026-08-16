/**
 * Reconciliation API — AI Agent (autonomous reconciliation orchestrator)
 */
import { createServerFn } from "@tanstack/react-start";
import {
  reconciliations,
  statementLines,
  reconciliationFlags,
  reconciliationSuggestions,
} from "../../../db/schema/reconciliations";
import { financialAccounts } from "../../../db/schema/financial-accounts";
import { eq, and, desc, sql } from "drizzle-orm";
import { withMutationPermissionOrgContext } from "../../../lib/server-context";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { runReconciliationAgent, type AgentResult } from "../../../lib/reconciliation-agent";
import {
  computeFinalizeBalances,
  RECONCILIATION_BALANCE_TOLERANCE,
} from "../../../lib/reconciliation-finalize";

// ============================================================================
// AI Agent — autonomous reconciliation orchestrator
// ============================================================================

/**
 * Run the AI agent on a reconciliation.
 * The agent auto-applies high-confidence suggestions, dismisses duplicates,
 * and optionally auto-finalizes when all items are resolved.
 */
export const runAgentOnReconciliation = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "reconciliation",
      "create",
      { routeKey: "reconciliation:run-agent", limit: 15, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { reconciliationId, autoFinalizeEnabled = false } = rawData as {
          reconciliationId: string;
          autoFinalizeEnabled?: boolean;
        };

        if (!reconciliationId) throw new Error("reconciliationId is required");

        // ── 1. Fetch reconciliation detail ─────────────────────────────────────
        const [recon] = await db
          .select({
            id: reconciliations.id,
            status: reconciliations.status,
            bankAccountId: reconciliations.bankAccountId,
            periodStart: reconciliations.periodStart,
            periodEnd: reconciliations.periodEnd,
            statementBeginningBalance: reconciliations.statementBeginningBalance,
            statementEndingBalance: reconciliations.statementEndingBalance,
          })
          .from(reconciliations)
          .where(
            and(
              eq(reconciliations.id, reconciliationId),
              eq(reconciliations.organizationId, orgId),
            ),
          )
          .limit(1)
          .for("update");

        if (!recon) throw new Error("Reconciliation not found");
        if (recon.status === "finalized") throw new Error("Reconciliation already finalized");

        // ── 2. Fetch pending suggestions ───────────────────────────────────────
        const suggestions = await db
          .select({
            id: reconciliationSuggestions.id,
            suggestionType: reconciliationSuggestions.suggestionType,
            confidence: reconciliationSuggestions.confidence,
            description: reconciliationSuggestions.description,
            status: reconciliationSuggestions.status,
            statementLineId: reconciliationSuggestions.statementLineId,
            journalLineId: reconciliationSuggestions.journalLineId,
            proposedChanges: reconciliationSuggestions.proposedChanges,
          })
          .from(reconciliationSuggestions)
          .where(
            and(
              eq(reconciliationSuggestions.reconciliationId, reconciliationId),
              eq(reconciliationSuggestions.organizationId, orgId),
            ),
          )
          .orderBy(desc(reconciliationSuggestions.confidence));

        // ── 3. Count unresolved flags ──────────────────────────────────────────
        const [flagCount] = await db
          .select({ count: sql<number>`count(*)::int` })
          .from(reconciliationFlags)
          .where(
            and(
              eq(reconciliationFlags.reconciliationId, reconciliationId),
              eq(reconciliationFlags.resolved, false),
            ),
          );

        // ── 4. Compute the finalize gate (same cleared/uncleared math as the human
        //       finalize path, so the agent's auto-finalize verdict can't disagree) ──
        // agentBalances is hoisted so the finalize step (below) can persist the same
        // snapshot columns the human path writes. finalizeGateEvaluable is false when
        // the bank account has no ledger mapping — the agent then declines to finalize.
        let netDifference = 0;
        let unmatchedStatementLines = 0;
        let finalizeGateEvaluable = false;
        let agentBalances: Awaited<ReturnType<typeof computeFinalizeBalances>> | null = null;
        if (recon.bankAccountId) {
          const [agentBankAcct] = await db
            .select({ ledgerAccountId: financialAccounts.ledgerAccountId })
            .from(financialAccounts)
            .where(eq(financialAccounts.id, recon.bankAccountId))
            .limit(1);

          if (agentBankAcct?.ledgerAccountId) {
            agentBalances = await computeFinalizeBalances(db, {
              orgId,
              reconciliationId,
              ledgerAccountId: agentBankAcct.ledgerAccountId,
              periodStart: recon.periodStart,
              periodEnd: recon.periodEnd,
              statementBeginningBalance: Number.parseFloat(recon.statementBeginningBalance ?? "0"),
              statementEndingBalance: Number.parseFloat(recon.statementEndingBalance ?? "0"),
            });
            netDifference = agentBalances.clearedDifference;
            unmatchedStatementLines = agentBalances.unmatchedStatementLines;
            finalizeGateEvaluable = true;
          }
        }

        // ── 5. Run the agent ───────────────────────────────────────────────────
        const agentSuggestions = suggestions.map((s) => ({
          id: s.id,
          suggestionType: s.suggestionType,
          confidence: Number(s.confidence ?? 0),
          description: s.description ?? "",
          status: s.status,
          statementLineId: s.statementLineId,
          journalLineId: s.journalLineId,
        }));

        const plan: AgentResult = runReconciliationAgent({
          suggestions: agentSuggestions,
          unresolvedFlagCount: flagCount?.count ?? 0,
          reconId: reconciliationId,
          reconStatus: recon.status,
          netDifference,
          unmatchedStatementLines,
          finalizeGateEvaluable,
          autoFinalizeEnabled,
        });

        // ── 6. Execute the plan ────────────────────────────────────────────────
        let executedCount = 0;

        for (const step of plan.steps) {
          switch (step.action) {
            case "apply_suggestion": {
              // Fetch the full suggestion to apply
              const [s] = await db
                .select()
                .from(reconciliationSuggestions)
                .where(
                  and(
                    eq(reconciliationSuggestions.id, step.targetId),
                    eq(reconciliationSuggestions.organizationId, orgId),
                    eq(reconciliationSuggestions.reconciliationId, reconciliationId),
                    eq(reconciliationSuggestions.status, "pending"),
                  ),
                );

              if (!s) continue;

              let resolutionSummary = "";

              switch (s.suggestionType) {
                case "auto_match": {
                  if (s.statementLineId && s.journalLineId) {
                    await db
                      .update(statementLines)
                      .set({
                        matchedJournalLineId: s.journalLineId,
                        matchStatus: "matched",
                        matchConfidence: s.confidence,
                      })
                      .where(
                        and(
                          eq(statementLines.id, s.statementLineId),
                          eq(statementLines.reconciliationId, reconciliationId),
                        ),
                      );
                    resolutionSummary =
                      "AI Agent: auto-matched statement line to ledger transaction";
                  }
                  break;
                }
                case "date_fix": {
                  // Match WITHOUT rewriting the posted journal's date. Date differences
                  // between ledger and statement are normal timing gaps (the human
                  // applySuggestion path treats them the same way); silently redating a
                  // posted transaction could move it across months or into a closed period.
                  if (s.journalLineId && s.statementLineId) {
                    await db
                      .update(statementLines)
                      .set({
                        matchedJournalLineId: s.journalLineId,
                        matchStatus: "matched",
                        matchConfidence: s.confidence,
                      })
                      .where(
                        and(
                          eq(statementLines.id, s.statementLineId),
                          eq(statementLines.reconciliationId, reconciliationId),
                        ),
                      );
                    resolutionSummary =
                      "AI Agent: matched despite date difference (ledger date preserved)";
                  }
                  break;
                }
                case "ignore": {
                  if (s.statementLineId) {
                    await db
                      .update(statementLines)
                      .set({ matchStatus: "ignored" })
                      .where(
                        and(
                          eq(statementLines.id, s.statementLineId),
                          eq(statementLines.reconciliationId, reconciliationId),
                        ),
                      );
                    resolutionSummary = "AI Agent: statement line marked as ignored";
                  }
                  break;
                }
                case "create_txn":
                case "duplicate":
                case "split": {
                  // These suggestion types require human judgment — skip in AI agent
                  resolutionSummary = `AI Agent: skipped '${s.suggestionType}' (requires manual review)`;
                  // Don't mark as applied — leave as pending for human review
                  continue;
                }
                default:
                  resolutionSummary = `AI Agent: acknowledged '${s.suggestionType}'`;
              }

              // Update suggestion status
              await db
                .update(reconciliationSuggestions)
                .set({
                  status: "applied",
                  appliedAt: new Date(),
                  appliedById: "ai-agent",
                  resolutionSummary,
                })
                .where(
                  and(
                    eq(reconciliationSuggestions.id, step.targetId),
                    eq(reconciliationSuggestions.organizationId, orgId),
                    eq(reconciliationSuggestions.reconciliationId, reconciliationId),
                  ),
                );

              // Resolve linked flags
              if (s.statementLineId) {
                await db
                  .update(reconciliationFlags)
                  .set({
                    resolved: true,
                    resolvedAt: new Date(),
                    resolutionNotes: resolutionSummary,
                  })
                  .where(
                    and(
                      eq(reconciliationFlags.reconciliationId, reconciliationId),
                      eq(reconciliationFlags.statementLineId, s.statementLineId),
                      eq(reconciliationFlags.resolved, false),
                    ),
                  );
              }

              executedCount++;
              break;
            }

            case "dismiss_suggestion": {
              await db
                .update(reconciliationSuggestions)
                .set({
                  status: "dismissed",
                  appliedAt: new Date(),
                  appliedById: "ai-agent",
                  resolutionSummary: "AI Agent: dismissed (overlapping duplicate)",
                })
                .where(
                  and(
                    eq(reconciliationSuggestions.id, step.targetId),
                    eq(reconciliationSuggestions.organizationId, orgId),
                    eq(reconciliationSuggestions.reconciliationId, reconciliationId),
                    eq(reconciliationSuggestions.status, "pending"),
                  ),
                );
              executedCount++;
              break;
            }

            case "finalize": {
              if (!recon.bankAccountId) {
                throw new Error("Cannot auto-finalize without a bank account");
              }
              const [bankAccount] = await db
                .select({ ledgerAccountId: financialAccounts.ledgerAccountId })
                .from(financialAccounts)
                .where(
                  and(
                    eq(financialAccounts.id, recon.bankAccountId),
                    eq(financialAccounts.organizationId, orgId),
                  ),
                )
                .limit(1);
              if (!bankAccount?.ledgerAccountId) {
                throw new Error("Cannot auto-finalize without a linked ledger account");
              }
              const freshBalances = await computeFinalizeBalances(db, {
                orgId,
                reconciliationId,
                ledgerAccountId: bankAccount.ledgerAccountId,
                periodStart: recon.periodStart,
                periodEnd: recon.periodEnd,
                statementBeginningBalance: Number.parseFloat(
                  recon.statementBeginningBalance ?? "0",
                ),
                statementEndingBalance: Number.parseFloat(recon.statementEndingBalance ?? "0"),
              });
              if (
                freshBalances.unmatchedStatementLines > 0 ||
                Math.abs(freshBalances.clearedDifference) > RECONCILIATION_BALANCE_TOLERANCE
              ) {
                throw new Error("Reconciliation changed and no longer passes the finalize gate");
              }
              // finalizedById is a uuid column — writing the literal "ai-agent" was
              // rejected by Postgres and silently swallowed, so auto-finalize never
              // actually worked. Attribute finalization to the user who ran the agent.
              await db
                .update(reconciliations)
                .set({
                  status: "finalized",
                  finalizedAt: new Date(),
                  finalizedById: userId,
                  updatedAt: new Date(),
                  // Persist the cleared/uncleared snapshot, same as the human finalize
                  // path — otherwise an AI-finalized reconciliation reaches the same
                  // terminal state with these columns left NULL, giving inconsistent
                  // audit records for identical outcomes. The agent only reaches this
                  // step when finalizeGateEvaluable was true, so agentBalances is set.
                  ledgerBalance: freshBalances.ledgerBalance.toFixed(2),
                  clearedBalance: freshBalances.clearedBalance.toFixed(2),
                  unclearedTotal: freshBalances.unclearedTotal.toFixed(2),
                })
                .where(eq(reconciliations.id, step.targetId));
              executedCount++;
              break;
            }
          }

          // Log activity for each step
          await insertActivityLog(
            {
              orgId,
              entityType: "reconciliation",
              entityId: reconciliationId,
              action: `ai_agent_${step.action}`,
              actorId: "ai-agent",
              changes: {
                targetId: step.targetId,
                reason: step.reason,
                confidence: step.confidence,
              },
            },
            db,
          );
        }

        return {
          ...plan,
          executedCount,
        };
      },
    );
  },
);
