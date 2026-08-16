// ============================================================================
// match_assist job — AI arbitration over the residual unmatched set.
//
// Chains after the statement pipeline (and is also triggerable by hand from
// the reconciliation page). Runs ONLY over lines the deterministic matcher
// could not settle, so the matcher stays the primary authority and token
// cost stays proportional to the leftovers.
//
// Everything the model produces is written through
// persistLlmMatchSuggestions — the hard 84-confidence cap — and then through
// txn_prefill for whatever still has no candidate at all.
// ============================================================================

import { and, eq, gte, inArray, lte } from "drizzle-orm";
import { db, withOrgContext, type DbExecutor } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import { reconciliations, statementLines } from "@/db/schema/reconciliations";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import { financialAccounts } from "@/db/schema/financial-accounts";
import { accounts } from "@/db/schema/accounts";
import type { LedgerTransactionForMatching } from "@/lib/auto-matcher";
import { resolveCandidateAccountIds } from "@/lib/resolve-candidate-accounts";
import { getClaimedJournalLineIds } from "@/lib/reconciliation-claimed-lines";
import { runMatchAssist } from "@/lib/match-assist/run";
import { runTxnPrefill } from "@/lib/match-assist/prefill";
import { startRun, runStep, completeRun, failRun } from "@/lib/ai/agent-run";
import { extendProcessingJobLease } from "@/lib/inbox/processing-job-lease";
import { createLogger } from "@/lib/logger";
import { retryPolicyFor } from "../retry-policy";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const logger = createLogger("jobs.match-assist");

export const MATCH_ASSIST_JOB_TYPE = "match_assist";

export interface MatchAssistJobPayload {
  reconciliationId: string;
  /** Also run create_txn prefill for lines with no candidates at all. */
  prefill?: boolean;
}

export function matchAssistDedupeKey(reconciliationId: string): string {
  return `match_assist:${reconciliationId}`;
}

/**
 * Load the residual set plus the ledger candidates it could match against.
 * Mirrors the statement pipeline's auto_match query so both stages agree on
 * what "available" means (posted, in-period, not already claimed).
 */
async function loadResidualContext(tx: DbExecutor, orgId: string, reconciliationId: string) {
  const [recon] = await tx
    .select({
      id: reconciliations.id,
      periodStart: reconciliations.periodStart,
      periodEnd: reconciliations.periodEnd,
      bankAccountId: reconciliations.bankAccountId,
    })
    .from(reconciliations)
    .where(and(eq(reconciliations.id, reconciliationId), eq(reconciliations.organizationId, orgId)))
    .limit(1);
  if (!recon) return null;

  const [bankAccount] = await tx
    .select({
      ledgerAccountId: financialAccounts.ledgerAccountId,
      accountName: financialAccounts.accountName,
    })
    .from(financialAccounts)
    .where(eq(financialAccounts.id, recon.bankAccountId))
    .limit(1);

  const unmatched = await tx
    .select({
      id: statementLines.id,
      transactionDate: statementLines.transactionDate,
      description: statementLines.description,
      amount: statementLines.amount,
    })
    .from(statementLines)
    .where(
      and(
        eq(statementLines.reconciliationId, reconciliationId),
        eq(statementLines.matchStatus, "unmatched"),
      ),
    );

  const candidateIds = bankAccount?.ledgerAccountId
    ? await resolveCandidateAccountIds(tx, bankAccount.ledgerAccountId)
    : [];

  let ledgerTxns: LedgerTransactionForMatching[] = [];
  if (candidateIds.length > 0 && unmatched.length > 0) {
    // Both 1:1 and split clearing count as claimed.
    const claimedIds = await getClaimedJournalLineIds(tx, reconciliationId);

    const rows = await tx
      .select({
        journalLineId: journalLines.id,
        date: journalHeaders.transactionDate,
        debit: journalLines.debit,
        credit: journalLines.credit,
        partyId: journalLines.partyId,
        partyName: parties.name,
        memo: journalHeaders.memo,
        lineDescription: journalLines.lineDescription,
      })
      .from(journalLines)
      .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
      .leftJoin(parties, eq(journalLines.partyId, parties.id))
      .where(
        and(
          inArray(journalLines.accountId, candidateIds),
          eq(journalHeaders.organizationId, orgId),
          eq(journalHeaders.status, "posted"),
          effectiveJournalPredicate(),
          gte(journalHeaders.transactionDate, recon.periodStart),
          lte(journalHeaders.transactionDate, recon.periodEnd),
        ),
      );

    ledgerTxns = rows
      .filter((r) => !claimedIds.has(r.journalLineId))
      .map((r) => ({
        journalLineId: r.journalLineId,
        date: r.date,
        description: r.lineDescription || r.memo || "",
        amount: Number(r.debit || 0) - Number(r.credit || 0),
        partyName: r.partyName || undefined,
        memo: r.memo || undefined,
      }));
  }

  const orgParties = await tx
    .select({ id: parties.id, name: parties.name })
    .from(parties)
    .where(eq(parties.organizationId, orgId));

  const bankLedgerAccount = bankAccount?.ledgerAccountId
    ? (
        await tx
          .select({ id: accounts.id, name: accounts.name })
          .from(accounts)
          .where(eq(accounts.id, bankAccount.ledgerAccountId))
          .limit(1)
      )[0]
    : undefined;

  return {
    unmatched: unmatched.map((l) => ({
      id: l.id,
      transactionDate: l.transactionDate,
      description: l.description,
      amount: Number(l.amount),
    })),
    ledgerTxns,
    partyNameById: new Map(orgParties.map((p) => [p.id, p.name])),
    bankAccount: bankLedgerAccount,
  };
}

export async function processMatchAssistJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const payload = job.payload as unknown as MatchAssistJobPayload;
  const orgId = job.organizationId;
  const { reconciliationId } = payload;

  const orgTx = <T>(fn: (tx: DbExecutor) => Promise<T>) =>
    withOrgContext(orgId, "system", "admin", fn);

  const runId = await orgTx((tx) =>
    startRun(tx, {
      orgId,
      kind: "match_assist",
      configSnapshot: { reconciliationId, prefill: payload.prefill ?? false },
    }),
  );
  const run = { runId, orgId, processingJobId: job.id };

  try {
    const context = await orgTx((tx) => loadResidualContext(tx, orgId, reconciliationId));
    if (!context) {
      await orgTx((tx) => failRun(tx, runId, { kind: "reconciliation_missing" }));
      return { processed: true, jobId: job.id, reason: "reconciliation_missing" };
    }

    // ── Arbitration over blocked candidate sets ────────────────────────────
    // The model call lives INSIDE runMatchAssist and must not run in an open
    // transaction, so the step body opens short org-context transactions for
    // its reads/writes and lets the façade call happen between them.
    let suggested = 0;
    await runStep(db, run, "arbitrate", async () => {
      const result = await runMatchAssist(db, {
        orgId,
        reconciliationId,
        statementLines: context.unmatched,
        ledgerTxns: context.ledgerTxns,
        partyNameById: context.partyNameById,
      });
      suggested = result.suggestionsInserted;
      return {
        output: {
          blocksBuilt: result.blocksBuilt,
          suggestionsInserted: result.suggestionsInserted,
          rejected: result.rejected.length,
          degraded: result.degraded,
        },
      };
    });

    await extendProcessingJobLease(db, job.id, ctx.workerId);

    // ── Prefill whatever still has nothing ────────────────────────────────
    let prefilled = 0;
    if (payload.prefill) {
      await runStep(db, run, "prefill", async () => {
        const stillUnmatched = await orgTx((tx) =>
          tx
            .select({
              id: statementLines.id,
              transactionDate: statementLines.transactionDate,
              description: statementLines.description,
              amount: statementLines.amount,
            })
            .from(statementLines)
            .where(
              and(
                eq(statementLines.reconciliationId, reconciliationId),
                eq(statementLines.matchStatus, "unmatched"),
              ),
            ),
        );

        const result = await runTxnPrefill(db, {
          orgId,
          reconciliationId,
          lines: stillUnmatched.map((l) => ({
            id: l.id,
            transactionDate: l.transactionDate,
            description: l.description,
            amount: Number(l.amount),
          })),
          bankAccount: context.bankAccount,
        });
        prefilled = result.proposalsCreated;
        return { output: { proposalsCreated: result.proposalsCreated, skipped: result.skipped } };
      });
    }

    await orgTx((tx) => completeRun(tx, runId));
    return {
      processed: true,
      jobId: job.id,
      runId,
      suggestionsInserted: suggested,
      prefillProposals: prefilled,
    };
  } catch (err) {
    logger.error("Match-assist job failed", {
      orgId,
      reconciliationId,
      error: err instanceof Error ? err.message : String(err),
    });
    await orgTx((tx) =>
      failRun(tx, runId, { message: err instanceof Error ? err.message : String(err) }),
    ).catch(() => undefined);
    throw err;
  }
}

/** Enqueue (or reuse) the match-assist job for a reconciliation. */
export async function enqueueMatchAssistJob(
  tx: DbExecutor,
  input: { organizationId: string; reconciliationId: string; prefill?: boolean },
): Promise<string | null> {
  const dedupeKey = matchAssistDedupeKey(input.reconciliationId);
  const [created] = await tx
    .insert(processingJobs)
    .values({
      organizationId: input.organizationId,
      jobType: MATCH_ASSIST_JOB_TYPE,
      maxAttempts: retryPolicyFor(MATCH_ASSIST_JOB_TYPE).maxAttempts,
      dedupeKey,
      payload: {
        reconciliationId: input.reconciliationId,
        ...(input.prefill ? { prefill: true } : {}),
      } as unknown as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning({ id: processingJobs.id });
  if (created) return created.id;

  const [existing] = await tx
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      and(
        eq(processingJobs.organizationId, input.organizationId),
        eq(processingJobs.dedupeKey, dedupeKey),
        inArray(processingJobs.status, ["queued", "running"]),
      ),
    )
    .limit(1);
  return existing?.id ?? null;
}
