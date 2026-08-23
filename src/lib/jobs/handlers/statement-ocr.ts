/**
 * Job handler for `statement_ocr` — the staged bank-statement pipeline.
 *
 * This replaces the old synchronous upload path, whose entire pipeline (a
 * Gemini call with a 120s timeout plus retries) ran inside the request's open
 * Postgres transaction. Here every stage's database work happens in its own
 * short `withOrgContext` transaction and the model call happens outside any
 * transaction at all.
 *
 * Stages (each wrapped in `runStep`, so a crash resumes at the first
 * incomplete one):
 *   triage             — deterministic CSV routing; a CSV never reaches a model
 *   ocr                — R2 download + password unlock + `aiComplete`
 *   validate           — the validation gate that now ACTUALLY blocks
 *   insert_lines       — batched line insert, preserving user-decided lines
 *   auto_match         — auto-matcher + auto-link + unmatched flags
 *   persist_suggestions— pending-suggestion refresh with dismissal memory
 *
 * Step outputRefs stay refs/counts only. The parsed statement and the matcher
 * result are stashed on `documents.metadata.statementPipeline` (the same shape
 * of cache the bill OCR path uses) so a resumed run can re-derive its state.
 *
 * Validation failures BLOCK the run and complete the job — they never throw,
 * because a bad statement is not a transient fault and must not burn retries.
 */
import { and, eq, gte, inArray, lte, ne, sql } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "@/db";
import { organization } from "@/db/schema/auth";
import { documents } from "@/db/schema/documents";
import { processingJobs } from "@/db/schema/inbox";
import { financialAccounts } from "@/db/schema/financial-accounts";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import {
  reconciliationFlags,
  reconciliationSuggestions,
  reconciliations,
  statementLines,
} from "@/db/schema/reconciliations";
import { aiComplete } from "@/lib/ai/facade";
import { blockRun, completeRun, failRun, runStep } from "@/lib/ai/agent-run";
import { getClaimedJournalLineIds } from "@/lib/reconciliation-claimed-lines";
import { enqueueMatchAssistJob, MATCH_ASSIST_JOB_TYPE } from "./match-assist";
import { triggerWorker } from "@/lib/jobs/trigger";
import {
  runAutoMatcher,
  type LedgerTransactionForMatching,
  type MatchingResult,
  type StatementLineForMatching,
} from "@/lib/auto-matcher";
import { getStatementPassword } from "@/lib/financial-account-secrets";
import { extendProcessingJobLease } from "@/lib/inbox/processing-job-lease";
import { createLogger } from "@/lib/logger";
import { probePdf, renderPdfPagesForOcr } from "@/lib/pdf-unlock";
import { resolveCandidateAccountIds } from "@/lib/resolve-candidate-accounts";
import { parseStatementCsv } from "@/lib/statement-csv";
import { validateStatement, type ValidationResult } from "@/lib/statement-validator";
import { downloadFromR2, isR2Configured } from "@/lib/storage";
import type { ParsedStatementData } from "@/routes/api/-ai-statement-ocr";
import { agentRuns } from "@/db/schema/ai";
import { retryPolicyFor } from "../retry-policy";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const logger = createLogger("jobs.statement-ocr");

export const STATEMENT_OCR_JOB_TYPE = "statement_ocr";

/** Statement lines carrying a human decision are never discarded by re-OCR. */
const USER_DECIDED_MATCH_STATUSES = ["matched", "created", "ignored"] as const;

/** Insert batch size — one round trip per 500 lines instead of per line. */
const STATEMENT_LINE_CHUNK = 500;

export interface StatementOcrJobPayload {
  reconciliationId: string;
  documentId: string;
  runId: string;
  /** Skip the validation gate (a human explicitly overrode it). */
  force?: boolean;
}

export function statementOcrDedupeKey(reconciliationId: string, documentId: string): string {
  return `statement_ocr:${reconciliationId}:${documentId}`;
}

// ============================================================================
// Stage hand-off stash (documents.metadata.statementPipeline)
// ============================================================================

interface StatementPipelineStash {
  runId: string;
  cachedAt: string;
  source: "csv" | "ocr";
  parsed: ParsedStatementData;
  matching?: MatchingResult;
}

async function writeStash(
  tx: DbExecutor,
  orgId: string,
  documentId: string,
  patch: Partial<StatementPipelineStash> & { runId: string },
): Promise<void> {
  const [row] = await tx
    .select({ metadata: documents.metadata })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
    .limit(1);
  if (!row) throw new Error("Statement document no longer exists.");
  const previous = row.metadata?.statementPipeline;
  const carried = previous?.runId === patch.runId ? previous : undefined;
  await tx
    .update(documents)
    .set({
      metadata: {
        ...row.metadata,
        statementPipeline: {
          ...carried,
          ...patch,
          cachedAt: new Date().toISOString(),
        } as NonNullable<typeof row.metadata>["statementPipeline"],
      },
      updatedAt: new Date(),
    })
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)));
}

async function readStash(
  tx: DbExecutor,
  orgId: string,
  documentId: string,
  runId: string,
): Promise<StatementPipelineStash | null> {
  const [row] = await tx
    .select({ metadata: documents.metadata })
    .from(documents)
    .where(and(eq(documents.id, documentId), eq(documents.organizationId, orgId)))
    .limit(1);
  const stash = row?.metadata?.statementPipeline;
  if (!stash || stash.runId !== runId) return null;
  return stash as unknown as StatementPipelineStash;
}

// ============================================================================
// Helpers
// ============================================================================

function orgTx<T>(orgId: string, fn: (tx: DbExecutor) => Promise<T>): Promise<T> {
  // Worker paths hold system context: no interactive session exists, and the
  // job row itself is the authorization record.
  return withOrgContext(orgId, "system", "admin", fn);
}

interface PipelineContext {
  reconciliationId: string;
  bankAccountId: string;
  periodStart: string;
  periodEnd: string;
  status: string;
  documentId: string;
  r2Key: string | null;
  mimeType: string | null;
  originalFilename: string | null;
  fileType: string | null;
  accountName: string;
  accountType: string | null;
  lastFour: string | null;
  ledgerAccountId: string | null;
  organizationName: string;
}

async function loadPipelineContext(
  tx: DbExecutor,
  orgId: string,
  payload: StatementOcrJobPayload,
): Promise<PipelineContext | null> {
  const [row] = await tx
    .select({
      reconciliationId: reconciliations.id,
      bankAccountId: reconciliations.bankAccountId,
      periodStart: reconciliations.periodStart,
      periodEnd: reconciliations.periodEnd,
      status: reconciliations.status,
      accountName: financialAccounts.accountName,
      accountType: financialAccounts.accountType,
      lastFour: financialAccounts.lastFour,
      ledgerAccountId: financialAccounts.ledgerAccountId,
    })
    .from(reconciliations)
    .innerJoin(financialAccounts, eq(reconciliations.bankAccountId, financialAccounts.id))
    .where(
      and(
        eq(reconciliations.id, payload.reconciliationId),
        eq(reconciliations.organizationId, orgId),
      ),
    )
    .limit(1);
  if (!row) return null;

  const [doc] = await tx
    .select({
      id: documents.id,
      r2Key: documents.r2Key,
      mimeType: documents.mimeType,
      originalFilename: documents.originalFilename,
      fileType: documents.fileType,
    })
    .from(documents)
    .where(and(eq(documents.id, payload.documentId), eq(documents.organizationId, orgId)))
    .limit(1);
  if (!doc) return null;

  const [org] = await tx
    .select({ name: organization.name })
    .from(organization)
    .where(eq(organization.id, orgId))
    .limit(1);

  return {
    ...row,
    documentId: doc.id,
    r2Key: doc.r2Key,
    mimeType: doc.mimeType,
    originalFilename: doc.originalFilename,
    fileType: doc.fileType,
    organizationName: org?.name ?? "",
  };
}

function isCsvStatement(context: PipelineContext): boolean {
  const mime = (context.mimeType ?? "").toLowerCase();
  if (mime === "text/csv" || mime === "application/csv" || mime === "text/comma-separated-values") {
    return true;
  }
  if (context.fileType === "csv") return true;
  return (context.originalFilename ?? "").toLowerCase().endsWith(".csv");
}

async function downloadStatement(context: PipelineContext): Promise<Buffer> {
  if (!context.r2Key) throw new Error("Statement document has no storage object key.");
  if (!isR2Configured()) throw new Error("Document storage is not configured.");
  return downloadFromR2(context.r2Key);
}

/**
 * Build a ParsedStatementData-equivalent from a deterministic CSV parse.
 *
 * A CSV export carries no institution/account header, so the identity fields
 * are filled from the reconciliation context the user already chose. The
 * balance, date-range and transaction-count checks still gate normally, and
 * every derived field is recorded as an issue on the triage step.
 */
function synthesizeCsvStatement(
  context: PipelineContext,
  parsed: ReturnType<typeof parseStatementCsv>,
): { statement: ParsedStatementData; issues: string[] } {
  const issues = [...parsed.issues];
  const transactions = parsed.transactions;
  const dates = transactions.map((t) => t.date).sort();

  // FILE order is not statement order — many banks export newest-first, which
  // swapped beginning and ending balances here while the period dates (taken
  // from the sorted copy) stayed correct. Order by date for the balance
  // endpoints too.
  const ordered = [...transactions].sort((a, b) => a.date.localeCompare(b.date));
  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  let beginningBalance = 0;
  let endingBalance = 0;
  if (first?.runningBalance != null && last?.runningBalance != null) {
    beginningBalance = first.runningBalance - first.amount;
    endingBalance = last.runningBalance;
  } else {
    issues.push("CSV has no running-balance column — beginning and ending balances default to 0.");
  }

  issues.push(
    "Account identity was taken from the reconciliation — a CSV carries no statement header.",
  );

  return {
    statement: {
      classification: {
        isStatement: true,
        documentType: "bank_statement",
        confidence: 100,
      },
      metadata: {
        institutionName: "",
        accountHolderName: context.organizationName,
        accountType: context.accountType || "checking",
        accountNumberLast4: context.lastFour || "",
        statementPeriodStart: dates[0] ?? context.periodStart,
        statementPeriodEnd: dates[dates.length - 1] ?? context.periodEnd,
        beginningBalance,
        endingBalance,
        currency: "USD",
      },
      transactions: transactions.map((t) => ({
        date: t.date,
        description: t.description,
        amount: t.amount,
        ...(t.runningBalance != null ? { runningBalance: t.runningBalance } : {}),
        ...(t.referenceNumber ? { referenceNumber: t.referenceNumber } : {}),
      })),
      totalPages: 1,
    },
    issues,
  };
}

/** Record a validation verdict on the run without changing its status. */
async function recordRunValidation(
  tx: DbExecutor,
  runId: string,
  kind: string,
  validation: ValidationResult,
): Promise<void> {
  await tx
    .update(agentRuns)
    .set({ blockedReason: { kind, validation } })
    .where(eq(agentRuns.id, runId));
}

async function completeJob(tx: DbExecutor, job: ProcessingJob, workerId: string): Promise<boolean> {
  const [completed] = await tx
    .update(processingJobs)
    .set({
      status: "completed",
      lockedBy: null,
      lockedUntil: null,
      completedAt: new Date(),
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(processingJobs.id, job.id),
        eq(processingJobs.status, "running"),
        eq(processingJobs.lockedBy, workerId),
      ),
    )
    .returning({ id: processingJobs.id });
  return Boolean(completed);
}

type StageOutcome = { blocked: true; reason: Record<string, unknown> } | { blocked: false };

// ============================================================================
// Handler
// ============================================================================

export async function processStatementOcrJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const { workerId } = ctx;
  const orgId = job.organizationId;
  const payload = job.payload as Partial<StatementOcrJobPayload>;
  if (!payload.reconciliationId || !payload.documentId || !payload.runId) {
    throw new Error("Statement OCR job payload is incomplete.");
  }
  const { reconciliationId, documentId, runId } = payload as StatementOcrJobPayload;
  const force = payload.force === true;
  const run = { runId, orgId, processingJobId: job.id };

  const finish = async (extra: Record<string, unknown>): Promise<JobHandlerResult> => {
    if (!(await orgTx(orgId, (tx) => completeJob(tx, job, workerId)))) {
      return { processed: false, reason: "lease_lost", jobId: job.id };
    }
    return { processed: true, jobId: job.id, reconciliationId, documentId, runId, ...extra };
  };
  const block = async (reason: Record<string, unknown>): Promise<JobHandlerResult> => {
    await orgTx(orgId, (tx) => blockRun(tx, runId, reason));
    logger.warn("Statement pipeline blocked", { reconciliationId, runId, kind: reason.kind });
    return finish({ blocked: reason.kind });
  };

  const context = await orgTx(orgId, (tx) =>
    loadPipelineContext(tx, orgId, payload as StatementOcrJobPayload),
  );
  if (!context) {
    await orgTx(orgId, (tx) => failRun(tx, runId, { kind: "missing_context" }));
    return finish({ failed: "missing_context" });
  }
  if (context.status === "finalized") {
    await orgTx(orgId, (tx) => failRun(tx, runId, { kind: "reconciliation_finalized" }));
    return finish({ failed: "reconciliation_finalized" });
  }

  // ── a. triage — deterministic routing; CSV never reaches a vision model ──
  const triage = await runStep<{ source: "csv" | "ocr" } & StageOutcome>(
    run,
    "triage",
    async () => {
      if (!isCsvStatement(context)) {
        return { value: { source: "ocr", blocked: false }, output: { source: "ocr" } };
      }
      const buffer = await downloadStatement(context);
      const csv = parseStatementCsv(buffer.toString("utf8"));
      if (!csv.ok) {
        return {
          value: {
            source: "csv",
            blocked: true,
            reason: { kind: "parse_failed", issues: csv.issues },
          },
          output: { source: "csv", parsed: false },
        };
      }
      const { statement, issues } = synthesizeCsvStatement(context, csv);
      await orgTx(orgId, (tx) =>
        writeStash(tx, orgId, documentId, { runId, source: "csv", parsed: statement }),
      );
      return {
        value: { source: "csv", blocked: false },
        output: {
          source: "csv",
          documentId,
          stash: "statementPipeline",
          transactionCount: statement.transactions.length,
          detected: csv.detected,
          issues,
        },
      };
    },
  );
  if (triage.value?.blocked) return block(triage.value.reason);
  const source: "csv" | "ocr" =
    triage.value?.source ?? (triage.output?.source as "csv" | "ocr" | undefined) ?? "ocr";

  await extendProcessingJobLease(orgId, job.id, workerId);

  // ── b. ocr — the ONLY model call, and it runs outside every transaction ──
  if (source === "ocr") {
    const ocr = await runStep<StageOutcome>(run, "ocr", async () => {
      const buffer = await downloadStatement(context);
      const mimeType = context.mimeType || "application/pdf";
      let media: Array<{ mimeType: string; dataBase64: string }> | null = null;

      if (mimeType === "application/pdf" && (await probePdf(buffer)) !== "ok") {
        // No human is present: only a previously stored password can unlock it.
        const stored = await orgTx(orgId, (tx) => getStatementPassword(tx, context.bankAccountId));
        if (!stored || (await probePdf(buffer, stored)) !== "ok") {
          return {
            value: { blocked: true, reason: { kind: "password_required" } },
            output: { blocked: "password_required" },
          };
        }
        const pages = await renderPdfPagesForOcr(buffer, { password: stored });
        media = pages.map((page) => ({ mimeType: page.mimeType, dataBase64: page.data }));
      }
      media ??= [{ mimeType, dataBase64: buffer.toString("base64") }];

      const result = await aiComplete<ParsedStatementData>({
        task: "statement_ocr",
        input: undefined,
        ctx: { orgId },
        media,
      });
      if (!result.ok) {
        return {
          value: { blocked: true, reason: { kind: "parse_failed", issues: result.issues } },
          output: { blocked: "parse_failed", invocationId: result.invocationId },
        };
      }
      await orgTx(orgId, (tx) =>
        writeStash(tx, orgId, documentId, { runId, source: "ocr", parsed: result.data }),
      );
      return {
        value: { blocked: false },
        output: {
          source: "ocr",
          documentId,
          stash: "statementPipeline",
          transactionCount: result.data.transactions.length,
          invocationId: result.invocationId,
          model: result.model,
        },
      };
    });
    if (ocr.value?.blocked) return block(ocr.value.reason);
  }

  await extendProcessingJobLease(orgId, job.id, workerId);

  const parsed = await orgTx(orgId, (tx) => readStash(tx, orgId, documentId, runId));
  if (!parsed?.parsed) {
    await orgTx(orgId, (tx) => failRun(tx, runId, { kind: "missing_extraction" }));
    return finish({ failed: "missing_extraction" });
  }
  const statement = parsed.parsed;

  // ── c. validate — the gate that used to be computed and then ignored ──
  const validate = await runStep<StageOutcome>(run, "validate", async () => {
    const validation = validateStatement(statement, {
      organizationName: context.organizationName,
      periodStart: context.periodStart,
      periodEnd: context.periodEnd,
      accountType: context.accountType || "checking",
      accountLastFour: context.lastFour || "",
      accountName: context.accountName || "",
    });
    const errorCount = validation.checks.filter(
      (check) => !check.passed && check.severity === "error",
    ).length;
    const warningCount = validation.checks.filter(
      (check) => !check.passed && check.severity === "warning",
    ).length;

    if (errorCount > 0 && !force) {
      return {
        value: { blocked: true, reason: { kind: "validation", validation } },
        output: { valid: false, errorCount, warningCount, gated: true },
      };
    }
    await orgTx(orgId, (tx) =>
      recordRunValidation(
        tx,
        runId,
        errorCount > 0 ? "validation_overridden" : "validation_passed",
        validation,
      ),
    );
    return {
      value: { blocked: false },
      output: { valid: validation.valid, errorCount, warningCount, forced: force },
    };
  });
  if (validate.value?.blocked) return block(validate.value.reason);

  await extendProcessingJobLease(orgId, job.id, workerId);

  // ── d. insert_lines — batched, and user decisions survive re-OCR ──
  await runStep(run, "insert_lines", async () =>
    orgTx(orgId, async (tx) => {
      await tx
        .update(reconciliations)
        .set({
          statementTotalPages: statement.totalPages,
          statementBeginningBalance: String(statement.metadata.beginningBalance),
          statementEndingBalance: String(statement.metadata.endingBalance),
          status: "in_progress",
          updatedAt: new Date(),
        })
        .where(eq(reconciliations.id, reconciliationId));

      const existing = await tx
        .select({
          id: statementLines.id,
          matchStatus: statementLines.matchStatus,
          source: statementLines.source,
          transactionDate: statementLines.transactionDate,
          description: statementLines.description,
          amount: statementLines.amount,
        })
        .from(statementLines)
        .where(eq(statementLines.reconciliationId, reconciliationId));

      // A suggestion the user already acted on is durable memory; its line has
      // to outlive re-OCR too or the foreign key (and the memory) breaks.
      const decidedSuggestionLines = await tx
        .selectDistinct({ statementLineId: reconciliationSuggestions.statementLineId })
        .from(reconciliationSuggestions)
        .where(
          and(
            eq(reconciliationSuggestions.reconciliationId, reconciliationId),
            ne(reconciliationSuggestions.status, "pending"),
            sql`${reconciliationSuggestions.statementLineId} is not null`,
          ),
        );
      const protectedIds = new Set(
        decidedSuggestionLines
          .map((row) => row.statementLineId)
          .filter((id): id is string => Boolean(id)),
      );

      const deletableIds = existing
        .filter((line) => {
          if (protectedIds.has(line.id)) return false;
          // Generated placeholder lines are pure derived data — a real
          // statement always supersedes them (parity with the old path).
          if (line.source === "generated") return true;
          if (line.source !== "ocr") return false;
          return !USER_DECIDED_MATCH_STATUSES.includes(
            line.matchStatus as (typeof USER_DECIDED_MATCH_STATUSES)[number],
          );
        })
        .map((line) => line.id);

      // Flags are wholly derived from the matcher and are regenerated below.
      // They must go first: they reference both lines and suggestions.
      await tx
        .delete(reconciliationFlags)
        .where(eq(reconciliationFlags.reconciliationId, reconciliationId));
      if (deletableIds.length > 0) {
        await tx
          .delete(reconciliationSuggestions)
          .where(
            and(
              eq(reconciliationSuggestions.reconciliationId, reconciliationId),
              inArray(reconciliationSuggestions.statementLineId, deletableIds),
            ),
          );
        await tx.delete(statementLines).where(inArray(statementLines.id, deletableIds));
      }

      // Re-running OCR on the SAME document must not duplicate the lines a
      // user already decided. Survivors (protected / user-decided / manual)
      // are removed from the fresh extraction as a MULTISET — one survivor
      // consumes one extracted row — so two genuinely identical bank
      // transactions still import as two when only one was decided.
      const deletable = new Set(deletableIds);
      const lineKey = (date: string, amount: string | number, description: string) =>
        `${date}|${Number(amount).toFixed(2)}|${description.trim().toLowerCase().replace(/\s+/g, " ")}`;
      const survivorCounts = new Map<string, number>();
      for (const line of existing) {
        if (deletable.has(line.id)) continue;
        const key = lineKey(line.transactionDate, line.amount, line.description);
        survivorCounts.set(key, (survivorCounts.get(key) ?? 0) + 1);
      }

      const confidence = statement.classification.confidence
        ? String(statement.classification.confidence)
        : null;
      const rows: Array<typeof statementLines.$inferInsert> = statement.transactions
        .filter((txn) => {
          const key = lineKey(txn.date, txn.amount, txn.description);
          const remaining = survivorCounts.get(key) ?? 0;
          if (remaining > 0) {
            survivorCounts.set(key, remaining - 1);
            return false;
          }
          return true;
        })
        .map((txn, index) => ({
          reconciliationId,
          transactionDate: txn.date,
          description: txn.description,
          amount: String(txn.amount),
          sortOrder: index,
          source: "ocr" as const,
          ocrConfidence: confidence,
        }));
      for (let offset = 0; offset < rows.length; offset += STATEMENT_LINE_CHUNK) {
        await tx.insert(statementLines).values(rows.slice(offset, offset + STATEMENT_LINE_CHUNK));
      }

      return {
        output: {
          insertedLines: rows.length,
          deletedLines: deletableIds.length,
          keptLines: existing.length - deletableIds.length,
        },
      };
    }),
  );

  await extendProcessingJobLease(orgId, job.id, workerId);

  // ── e. auto_match — ledger fetch + matcher + auto-link + unmatched flags ──
  await runStep(run, "auto_match", async () =>
    orgTx(orgId, async (tx) => {
      // The lines this run owns are exactly the freshly inserted, still
      // undecided OCR lines — the same set on a fresh run and on a resume.
      const pendingLines = await tx
        .select({
          id: statementLines.id,
          date: statementLines.transactionDate,
          description: statementLines.description,
          amount: statementLines.amount,
        })
        .from(statementLines)
        .where(
          and(
            eq(statementLines.reconciliationId, reconciliationId),
            eq(statementLines.source, "ocr"),
            eq(statementLines.matchStatus, "unmatched"),
          ),
        );

      const candidateIds = context.ledgerAccountId
        ? await resolveCandidateAccountIds(tx, context.ledgerAccountId)
        : [];
      if (candidateIds.length === 0 || pendingLines.length === 0) {
        await writeStash(tx, orgId, documentId, {
          runId,
          matching: {
            autoMatched: [],
            suggestions: [],
            unmatchedStatementLines: pendingLines.map((line) => line.id),
            unmatchedLedgerTxns: [],
          },
        });
        return { output: { autoMatched: 0, suggestions: 0, skipped: true } };
      }

      const ledgerRows = await tx
        .select({
          journalLineId: journalLines.id,
          date: journalHeaders.transactionDate,
          debit: journalLines.debit,
          credit: journalLines.credit,
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
            gte(journalHeaders.transactionDate, context.periodStart),
            lte(journalHeaders.transactionDate, context.periodEnd),
          ),
        );

      // A journal line already claimed by a surviving user-decided line cannot
      // be matched twice (statement_lines_matched_journal_line_unique).
      // Both 1:1 and split clearing count as claimed.
      const claimedIds = await getClaimedJournalLineIds(tx, reconciliationId);

      const stmtForMatching: StatementLineForMatching[] = pendingLines.map((line) => ({
        id: line.id,
        date: line.date,
        description: line.description,
        amount: Number(line.amount),
      }));
      const ledgerForMatching: LedgerTransactionForMatching[] = ledgerRows
        .filter((row) => !claimedIds.has(row.journalLineId))
        .map((row) => ({
          journalLineId: row.journalLineId,
          date: row.date,
          description: row.lineDescription || row.memo || "",
          amount: Number(row.debit || 0) - Number(row.credit || 0),
          partyName: row.partyName || undefined,
          memo: row.memo || undefined,
        }));

      const matching = runAutoMatcher(stmtForMatching, ledgerForMatching);

      for (const match of matching.autoMatched) {
        await tx
          .update(statementLines)
          .set({
            matchedJournalLineId: match.journalLineId,
            matchStatus: "matched",
            matchConfidence: String(match.confidence),
          })
          .where(eq(statementLines.id, match.statementLineId));
      }

      const flags: Array<typeof reconciliationFlags.$inferInsert> = [];
      for (const statementLineId of matching.unmatchedStatementLines) {
        const line = stmtForMatching.find((entry) => entry.id === statementLineId);
        flags.push({
          reconciliationId,
          statementLineId,
          flagType: "unmatched_statement",
          suggestedAction: "create_transaction",
          description: line
            ? `No matching ledger transaction for "${line.description}" ($${Math.abs(line.amount).toFixed(2)})`
            : "No matching ledger transaction found",
        });
      }
      for (const journalLineId of matching.unmatchedLedgerTxns) {
        const ledgerTxn = ledgerForMatching.find((entry) => entry.journalLineId === journalLineId);
        flags.push({
          reconciliationId,
          flagType: "unmatched_ledger",
          suggestedAction: "manual_review",
          description: ledgerTxn
            ? `Ledger transaction "${ledgerTxn.description}" ($${Math.abs(ledgerTxn.amount).toFixed(2)}) has no matching statement line`
            : "Ledger transaction has no matching statement line",
        });
      }
      if (flags.length > 0) await tx.insert(reconciliationFlags).values(flags);

      await writeStash(tx, orgId, documentId, { runId, matching });

      return {
        output: {
          autoMatched: matching.autoMatched.length,
          suggestions: matching.suggestions.length,
          unmatchedStatementLines: matching.unmatchedStatementLines.length,
          unmatchedLedgerTxns: matching.unmatchedLedgerTxns.length,
        },
      };
    }),
  );

  await extendProcessingJobLease(orgId, job.id, workerId);

  // ── f. persist_suggestions — refresh pending, respect dismissal memory ──
  await runStep(run, "persist_suggestions", async () =>
    orgTx(orgId, async (tx) => {
      const stash = await readStash(tx, orgId, documentId, runId);
      const candidates = stash?.matching?.suggestions ?? [];

      // Accepted/applied/dismissed rows are the user's memory — only the
      // stale pending set is replaced.
      await tx
        .delete(reconciliationSuggestions)
        .where(
          and(
            eq(reconciliationSuggestions.reconciliationId, reconciliationId),
            eq(reconciliationSuggestions.status, "pending"),
          ),
        );

      const dismissed = await tx
        .select({
          statementLineId: reconciliationSuggestions.statementLineId,
          journalLineId: reconciliationSuggestions.journalLineId,
          suggestionType: reconciliationSuggestions.suggestionType,
        })
        .from(reconciliationSuggestions)
        .where(
          and(
            eq(reconciliationSuggestions.reconciliationId, reconciliationId),
            eq(reconciliationSuggestions.status, "dismissed"),
          ),
        );
      const fingerprint = (
        statementLineId: string | null,
        journalLineId: string | null,
        suggestionType: string,
      ) => `${statementLineId ?? ""}|${journalLineId ?? ""}|${suggestionType}`;
      const suppressed = new Set(
        dismissed.map((row) =>
          fingerprint(row.statementLineId, row.journalLineId, row.suggestionType),
        ),
      );

      const rows = candidates
        .filter(
          (candidate) =>
            !suppressed.has(
              fingerprint(
                candidate.statementLineId,
                candidate.journalLineId,
                candidate.suggestionType,
              ),
            ),
        )
        .map((candidate) => ({
          organizationId: orgId,
          reconciliationId,
          statementLineId: candidate.statementLineId,
          journalLineId: candidate.journalLineId,
          suggestionType:
            candidate.suggestionType as typeof reconciliationSuggestions.$inferInsert.suggestionType,
          confidence: candidate.confidence != null ? String(candidate.confidence) : null,
          description: candidate.description,
          proposedChanges: candidate.proposedChanges || null,
        }));
      if (rows.length > 0) await tx.insert(reconciliationSuggestions).values(rows);

      return {
        output: {
          suggestions: rows.length,
          suppressedByDismissal: candidates.length - rows.length,
        },
      };
    }),
  );

  // Chain AI match-assist over whatever the deterministic matcher left
  // unmatched. Enqueued as its OWN job so a slow arbitration can't hold this
  // job's lease, and so it can be re-run by hand from the reconciliation page.
  const matchAssistJobId = await orgTx(orgId, (tx) =>
    enqueueMatchAssistJob(tx, {
      organizationId: orgId,
      reconciliationId,
      prefill: true,
    }),
  ).catch(() => null);
  if (matchAssistJobId) triggerWorker([MATCH_ASSIST_JOB_TYPE]);

  await orgTx(orgId, (tx) => completeRun(tx, runId));
  return finish({ completed: true, source, matchAssistJobId });
}

// ============================================================================
// Enqueue
// ============================================================================

/**
 * Enqueue (or reuse) the statement pipeline job for a reconciliation document.
 *
 * The partial-unique dedupe index makes a concurrent double-enqueue impossible;
 * on conflict the live job is returned so callers stay idempotent.
 */
export async function enqueueStatementOcrJob(
  tx: DbExecutor,
  input: StatementOcrJobPayload & { organizationId: string },
): Promise<string | null> {
  const dedupeKey = statementOcrDedupeKey(input.reconciliationId, input.documentId);
  const payload: StatementOcrJobPayload = {
    reconciliationId: input.reconciliationId,
    documentId: input.documentId,
    runId: input.runId,
    ...(input.force ? { force: true } : {}),
  };
  const [created] = await tx
    .insert(processingJobs)
    .values({
      organizationId: input.organizationId,
      jobType: STATEMENT_OCR_JOB_TYPE,
      // Interactive: the upload UI polls this to completion, so the retry
      // budget must terminate well inside that poll window.
      maxAttempts: retryPolicyFor(STATEMENT_OCR_JOB_TYPE).maxAttempts,
      dedupeKey,
      payload: payload as unknown as Record<string, unknown>,
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
