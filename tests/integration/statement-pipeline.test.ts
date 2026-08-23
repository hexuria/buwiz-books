/**
 * Integration tests for the staged `statement_ocr` job handler.
 *
 * These drive the handler directly (no HTTP): seed org + reconciliation +
 * document + processing job, then assert the pipeline's durable behaviour —
 * batched inserts, the validation gate that actually blocks, crash-resume via
 * runStep, dismissal memory, and survival of user-decided lines.
 */
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type postgres from "postgres";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const aiState = vi.hoisted(() => ({
  statement: null as Record<string, unknown> | null,
  ok: true,
  issues: [] as string[],
  calls: 0,
}));

const storageState = vi.hoisted(() => ({ bytes: "fake-statement-bytes" }));

const resolveState = vi.hoisted(() => ({ throwOnce: false }));

vi.mock("@/lib/ai/facade", () => ({
  aiComplete: vi.fn(async () => {
    aiState.calls += 1;
    return aiState.ok
      ? { ok: true, data: aiState.statement, invocationId: null, model: "test-model" }
      : { ok: false, needsReview: true, invocationId: null, issues: aiState.issues };
  }),
}));

vi.mock("@/lib/storage", () => ({
  isR2Configured: () => true,
  downloadFromR2: async () => Buffer.from(storageState.bytes),
  uploadToR2: async () => undefined,
  deleteFromR2: async () => undefined,
}));

vi.mock("@/lib/resolve-candidate-accounts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/resolve-candidate-accounts")>();
  return {
    ...actual,
    resolveCandidateAccountIds: vi.fn(async (database: never, ledgerAccountId: string) => {
      if (resolveState.throwOnce) {
        resolveState.throwOnce = false;
        throw new Error("injected crash after insert_lines");
      }
      return actual.resolveCandidateAccountIds(database, ledgerAccountId);
    }),
  };
});

import { db } from "@/db";
import { accounts } from "@/db/schema/accounts";
import { agentRunSteps, agentRuns } from "@/db/schema/ai";
import { organization } from "@/db/schema/auth";
import { documents } from "@/db/schema/documents";
import { financialAccounts } from "@/db/schema/financial-accounts";
import { processingJobs } from "@/db/schema/inbox";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import {
  reconciliationFlags,
  reconciliationSuggestions,
  reconciliations,
  statementLines,
} from "@/db/schema/reconciliations";
import { processStatementOcrJob } from "@/lib/jobs/handlers/statement-ocr";
import type { ProcessingJob } from "@/lib/jobs/registry";
import { createTestDb } from "../utils/db-utils";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

const ORG_NAME = "Northwind Trading";
const PERIOD_START = "2026-03-01";
const PERIOD_END = "2026-03-31";

/** A statement whose beginning + net exactly equals its ending balance. */
function validStatement(
  transactions: Array<{ date: string; description: string; amount: number }>,
) {
  const net = transactions.reduce((sum, txn) => sum + txn.amount, 0);
  return {
    classification: { isStatement: true, documentType: "bank_statement", confidence: 97 },
    metadata: {
      institutionName: "Northwind Bank",
      accountHolderName: ORG_NAME,
      accountType: "checking",
      accountNumberLast4: "1234",
      statementPeriodStart: PERIOD_START,
      statementPeriodEnd: PERIOD_END,
      beginningBalance: 1000,
      endingBalance: 1000 + net,
      currency: "USD",
    },
    transactions,
    totalPages: 1,
  };
}

interface Fixture {
  orgId: string;
  reconciliationId: string;
  documentId: string;
  ledgerAccountId: string;
  contraAccountId: string;
  job: ProcessingJob;
  runId: string;
  workerId: string;
}

async function createFixture(label: string): Promise<Fixture> {
  const suffix = randomUUID();
  const orgId = `${label}-${suffix}`;
  const ledgerAccountId = randomUUID();
  const contraAccountId = randomUUID();
  const bankAccountId = randomUUID();

  await db.insert(organization).values({
    id: orgId,
    name: ORG_NAME,
    slug: `${label}-${suffix}`,
  });
  await db.insert(accounts).values([
    {
      id: ledgerAccountId,
      organizationId: orgId,
      name: "Checking (GL)",
      accountType: "asset",
      subtype: "bank_accounts",
    },
    { id: contraAccountId, organizationId: orgId, name: "Sales", accountType: "revenue" },
  ]);
  await db.insert(financialAccounts).values({
    id: bankAccountId,
    organizationId: orgId,
    accountName: "Checking",
    accountType: "checking",
    lastFour: "1234",
    ledgerAccountId,
  });
  const [recon] = await db
    .insert(reconciliations)
    .values({
      organizationId: orgId,
      bankAccountId,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      status: "in_progress",
    })
    .returning();
  const [document] = await db
    .insert(documents)
    .values({
      organizationId: orgId,
      originalFilename: "statement.png",
      mimeType: "image/png",
      fileType: "png",
      documentType: "statement",
      storagePath: `statements/${suffix}.png`,
      r2Key: `statements/${suffix}.png`,
      metadata: {},
    })
    .returning();
  await db
    .update(reconciliations)
    .set({ statementDocumentId: document.id })
    .where(eq(reconciliations.id, recon.id));

  const [run] = await db
    .insert(agentRuns)
    .values({ organizationId: orgId, kind: "statement_pipeline" })
    .returning();

  const workerId = `test-worker-${suffix}`;
  const [job] = await db
    .insert(processingJobs)
    .values({
      organizationId: orgId,
      jobType: "statement_ocr",
      dedupeKey: `statement_ocr:${recon.id}:${document.id}`,
      status: "running",
      attempts: 1,
      lockedBy: workerId,
      lockedUntil: new Date(Date.now() + 300_000),
      payload: {
        reconciliationId: recon.id,
        documentId: document.id,
        runId: run.id,
      },
    })
    .returning();

  return {
    orgId,
    reconciliationId: recon.id,
    documentId: document.id,
    ledgerAccountId,
    contraAccountId,
    job: job as ProcessingJob,
    runId: run.id,
    workerId,
  };
}

/** Post a balanced journal and return the bank-side journal line id. */
async function postBankTxn(
  fixture: Fixture,
  date: string,
  amount: number,
  description: string,
): Promise<string> {
  // Both sides in ONE transaction. The journal already balances, but a balance
  // check on posted journals is a deferred constraint evaluated at COMMIT, and
  // bare `db.insert` autocommits each statement — which would check the bank
  // line on its own, before its contra exists.
  return db.transaction(async (tx: any) => {
    const [header] = await tx
      .insert(journalHeaders)
      .values({
        organizationId: fixture.orgId,
        transactionDate: date,
        transactionType: "journal",
        status: "posted",
        memo: description,
      })
      .returning();
    const [bankLine] = await tx
      .insert(journalLines)
      .values({
        journalHeaderId: header.id,
        accountId: fixture.ledgerAccountId,
        debit: amount > 0 ? String(amount) : null,
        credit: amount < 0 ? String(Math.abs(amount)) : null,
        lineDescription: description,
        sortOrder: 0,
      })
      .returning();
    await tx.insert(journalLines).values({
      journalHeaderId: header.id,
      accountId: fixture.contraAccountId,
      debit: amount < 0 ? String(Math.abs(amount)) : null,
      credit: amount > 0 ? String(amount) : null,
      sortOrder: 1,
    });
    return bankLine.id as string;
  });
}

function reRunnableJob(fixture: Fixture): ProcessingJob {
  return fixture.job;
}

describeDb("statement_ocr pipeline handler", () => {
  let sqlClient: postgres.Sql;

  beforeAll(async () => {
    ({ sql: sqlClient } = await createTestDb());
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  beforeEach(() => {
    aiState.ok = true;
    aiState.issues = [];
    aiState.calls = 0;
    storageState.bytes = "fake-statement-bytes";
    resolveState.throwOnce = false;
  });

  it("extracts, batch-inserts lines and completes the run", async () => {
    const fixture = await createFixture("stmt-ok");
    aiState.statement = validStatement([
      { date: "2026-03-05", description: "ACME DEPOSIT", amount: 300 },
      { date: "2026-03-12", description: "OFFICE SUPPLIES", amount: -75.5 },
      { date: "2026-03-20", description: "CLIENT WIRE", amount: 1200 },
    ]);

    const result = await processStatementOcrJob(reRunnableJob(fixture), {
      workerId: fixture.workerId,
    });
    expect(result.processed).toBe(true);
    expect(result.completed).toBe(true);

    const lines = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.source === "ocr")).toBe(true);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, fixture.runId));
    expect(run.status).toBe("completed");

    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, fixture.job.id));
    expect(job.status).toBe("completed");

    const steps = await db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, fixture.runId));
    expect(steps.map((step) => step.step).sort()).toEqual(
      ["auto_match", "insert_lines", "ocr", "persist_suggestions", "triage", "validate"].sort(),
    );
    expect(steps.every((step) => step.status === "completed")).toBe(true);

    // Reconciliation balances came from the parsed statement.
    const [recon] = await db
      .select()
      .from(reconciliations)
      .where(eq(reconciliations.id, fixture.reconciliationId));
    expect(recon.statementBeginningBalance).toBe("1000.00");
  });

  it("blocks the run on an error-severity validation failure and inserts NO lines", async () => {
    const fixture = await createFixture("stmt-bad");
    const statement = validStatement([
      { date: "2026-03-05", description: "ACME DEPOSIT", amount: 300 },
    ]);
    // Beginning + net no longer equals ending (warning) AND the account number
    // does not match the reconciliation's bank account (error → gate).
    statement.metadata.endingBalance = 9999;
    statement.metadata.accountNumberLast4 = "9876";
    aiState.statement = statement;

    const result = await processStatementOcrJob(reRunnableJob(fixture), {
      workerId: fixture.workerId,
    });
    expect(result.processed).toBe(true);
    expect(result.blocked).toBe("validation");

    const lines = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    expect(lines).toHaveLength(0);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, fixture.runId));
    expect(run.status).toBe("blocked");
    const reason = run.blockedReason as {
      kind: string;
      validation: { errors: string[]; warnings: string[] };
    };
    expect(reason.kind).toBe("validation");
    expect(reason.validation.errors.join(" ")).toContain("Account number mismatch");
    // Balance discrepancy is BLOCKING now (audit C3) — it moved from
    // warnings to errors, because it is the one check that catches
    // dropped/duplicated rows and inverted balances.
    expect(reason.validation.errors.join(" ")).toContain("Balance discrepancy");

    // The job itself completed — a bad statement is not a transient fault.
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, fixture.job.id));
    expect(job.status).toBe("completed");
  });

  it("skips the gate and imports when the job carries force", async () => {
    const fixture = await createFixture("stmt-force");
    const statement = validStatement([
      { date: "2026-03-05", description: "ACME DEPOSIT", amount: 300 },
    ]);
    statement.metadata.accountNumberLast4 = "9876";
    aiState.statement = statement;
    await db
      .update(processingJobs)
      .set({
        payload: {
          reconciliationId: fixture.reconciliationId,
          documentId: fixture.documentId,
          runId: fixture.runId,
          force: true,
        },
      })
      .where(eq(processingJobs.id, fixture.job.id));
    const [job] = await db
      .select()
      .from(processingJobs)
      .where(eq(processingJobs.id, fixture.job.id));

    const result = await processStatementOcrJob(job as ProcessingJob, {
      workerId: fixture.workerId,
    });
    expect(result.completed).toBe(true);

    const lines = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    expect(lines).toHaveLength(1);

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, fixture.runId));
    expect(run.status).toBe("completed");
    // The overridden verdict is still recorded on the run.
    expect((run.blockedReason as { kind: string }).kind).toBe("validation_overridden");
  });

  it("resumes after a crash without duplicating inserted lines", async () => {
    const fixture = await createFixture("stmt-resume");
    aiState.statement = validStatement([
      { date: "2026-03-05", description: "ACME DEPOSIT", amount: 300 },
      { date: "2026-03-12", description: "OFFICE SUPPLIES", amount: -75.5 },
    ]);

    resolveState.throwOnce = true;
    await expect(
      processStatementOcrJob(reRunnableJob(fixture), { workerId: fixture.workerId }),
    ).rejects.toThrow("injected crash after insert_lines");

    const afterCrash = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    expect(afterCrash).toHaveLength(2);

    const crashedSteps = await db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, fixture.runId));
    expect(crashedSteps.find((step) => step.step === "insert_lines")?.status).toBe("completed");
    expect(crashedSteps.find((step) => step.step === "auto_match")?.status).toBe("failed");

    // Re-run the same job: completed steps are skipped, so the batch insert
    // does not run twice.
    const result = await processStatementOcrJob(reRunnableJob(fixture), {
      workerId: fixture.workerId,
    });
    expect(result.completed).toBe(true);

    const afterResume = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    expect(afterResume).toHaveLength(2);
    expect(new Set(afterResume.map((line) => line.id))).toEqual(
      new Set(afterCrash.map((line) => line.id)),
    );

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, fixture.runId));
    expect(run.status).toBe("completed");
  });

  it("keeps user-decided lines and does not recreate a dismissed suggestion", async () => {
    const fixture = await createFixture("stmt-memory");

    // TWO ledger transactions of the same amount within the near-date window:
    // an ambiguous near match is proposed as a date_fix rather than auto-linked,
    // and the closest date (03-13) is the one the matcher proposes.
    await postBankTxn(fixture, "2026-03-10", -75.5, "OFFICE SUPPLIES");
    const journalLineId = await postBankTxn(fixture, "2026-03-13", -75.5, "OFFICE SUPPLIES CO");
    const keptJournalLineId = await postBankTxn(fixture, "2026-03-05", 300, "ACME DEPOSIT");

    // A line the user matched by hand — it must survive re-OCR untouched.
    const [userMatched] = await db
      .insert(statementLines)
      .values({
        reconciliationId: fixture.reconciliationId,
        transactionDate: "2026-03-05",
        description: "ACME DEPOSIT (hand matched)",
        amount: "300.00",
        source: "ocr",
        matchStatus: "matched",
        matchedJournalLineId: keptJournalLineId,
        sortOrder: 0,
      })
      .returning();

    // A still-unmatched line the user already dismissed a suggestion for. The
    // dismissal is the memory: the same proposal must not come back.
    const [dismissedLine] = await db
      .insert(statementLines)
      .values({
        reconciliationId: fixture.reconciliationId,
        transactionDate: "2026-03-12",
        description: "OFFICE SUPPLIES",
        amount: "-75.50",
        source: "ocr",
        matchStatus: "unmatched",
        sortOrder: 1,
      })
      .returning();
    await db.insert(reconciliationSuggestions).values({
      organizationId: fixture.orgId,
      reconciliationId: fixture.reconciliationId,
      statementLineId: dismissedLine.id,
      journalLineId,
      suggestionType: "date_fix",
      status: "dismissed",
      description: "Previously dismissed by the user",
    });

    aiState.statement = validStatement([
      { date: "2026-03-20", description: "CLIENT WIRE", amount: 1200 },
    ]);

    const result = await processStatementOcrJob(reRunnableJob(fixture), {
      workerId: fixture.workerId,
    });
    expect(result.completed).toBe(true);

    const lines = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    const ids = new Set(lines.map((line) => line.id));
    // The hand-matched line survived, the dismissal-protected line survived,
    // and the newly extracted line was added.
    expect(ids.has(userMatched.id)).toBe(true);
    expect(ids.has(dismissedLine.id)).toBe(true);
    expect(lines).toHaveLength(3);
    const [stillMatched] = lines.filter((line) => line.id === userMatched.id);
    expect(stillMatched.matchStatus).toBe("matched");
    expect(stillMatched.matchedJournalLineId).toBe(keptJournalLineId);

    const suggestions = await db
      .select()
      .from(reconciliationSuggestions)
      .where(eq(reconciliationSuggestions.reconciliationId, fixture.reconciliationId));
    // The dismissed row is still there…
    expect(suggestions.filter((suggestion) => suggestion.status === "dismissed")).toHaveLength(1);
    // …and no pending clone of it was recreated.
    expect(
      suggestions.filter(
        (suggestion) =>
          suggestion.status === "pending" &&
          suggestion.statementLineId === dismissedLine.id &&
          suggestion.journalLineId === journalLineId &&
          suggestion.suggestionType === "date_fix",
      ),
    ).toHaveLength(0);
    // The matcher DID propose it — the fingerprint filter is what dropped it,
    // and unrelated proposals still land.
    const [persistStep] = await db
      .select()
      .from(agentRunSteps)
      .where(
        and(eq(agentRunSteps.runId, fixture.runId), eq(agentRunSteps.step, "persist_suggestions")),
      );
    expect(persistStep.outputRef?.suppressedByDismissal).toBe(1);
    expect(
      suggestions.some(
        (suggestion) =>
          suggestion.status === "pending" && suggestion.suggestionType === "create_txn",
      ),
    ).toBe(true);

    // Flags are regenerated derived data, scoped to this reconciliation.
    const flags = await db
      .select()
      .from(reconciliationFlags)
      .where(eq(reconciliationFlags.reconciliationId, fixture.reconciliationId));
    expect(flags.every((flag) => flag.reconciliationId === fixture.reconciliationId)).toBe(true);
  });

  it("re-running OCR on the same statement does not duplicate decided lines", async () => {
    const fixture = await createFixture("stmt-reocr-dup");
    const keptJournalLineId = await postBankTxn(fixture, "2026-03-05", 300, "ACME DEPOSIT");

    // The extraction the document ALWAYS yields — both runs see these two.
    const sameStatement = [
      { date: "2026-03-05", description: "ACME DEPOSIT", amount: 300 },
      { date: "2026-03-12", description: "OFFICE SUPPLIES", amount: -75.5 },
    ];
    aiState.statement = validStatement(sameStatement);

    const first = await processStatementOcrJob(reRunnableJob(fixture), {
      workerId: fixture.workerId,
    });
    expect(first.completed).toBe(true);

    // The user matches one of the two extracted lines by hand.
    const linesAfterFirst = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    expect(linesAfterFirst).toHaveLength(2);
    const deposit = linesAfterFirst.find((line) => Number(line.amount) === 300);
    expect(deposit).toBeDefined();
    await db
      .update(statementLines)
      .set({ matchStatus: "matched", matchedJournalLineId: keptJournalLineId })
      .where(eq(statementLines.id, deposit!.id));

    // Re-run OCR on the SAME document: identical extraction, but a FRESH run
    // and job — the real re-OCR path opens a new run, and steps are memoized
    // per run. Before the multiset dedupe, the surviving matched line stayed
    // AND the same transaction was inserted again — a phantom unmatched twin
    // that blocked finalization and inflated the totals.
    aiState.statement = validStatement(sameStatement);
    const [rerun] = await db
      .insert(agentRuns)
      .values({ organizationId: fixture.orgId, kind: "statement_pipeline" })
      .returning();
    const [rerunJob] = await db
      .insert(processingJobs)
      .values({
        organizationId: fixture.orgId,
        jobType: "statement_ocr",
        dedupeKey: `statement_ocr:${fixture.reconciliationId}:${fixture.documentId}:rerun`,
        status: "running",
        attempts: 1,
        lockedBy: fixture.workerId,
        lockedUntil: new Date(Date.now() + 300_000),
        payload: {
          reconciliationId: fixture.reconciliationId,
          documentId: fixture.documentId,
          runId: rerun.id,
        },
      })
      .returning();
    const second = await processStatementOcrJob(rerunJob as ProcessingJob, {
      workerId: fixture.workerId,
    });
    expect(second.completed).toBe(true);

    const lines = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    expect(lines).toHaveLength(2);
    const matched = lines.filter((line) => line.matchStatus === "matched");
    expect(matched).toHaveLength(1);
    expect(matched[0]!.matchedJournalLineId).toBe(keptJournalLineId);
    // Two genuinely identical bank transactions still import as two: the
    // dedupe consumes ONE extracted row per surviving line, no more.
    const supplies = lines.filter((line) => Number(line.amount) === -75.5);
    expect(supplies).toHaveLength(1);
  });

  it("parses a CSV deterministically and never calls the model", async () => {
    const fixture = await createFixture("stmt-csv");
    await db
      .update(documents)
      .set({ mimeType: "text/csv", fileType: "csv", originalFilename: "statement.csv" })
      .where(eq(documents.id, fixture.documentId));
    storageState.bytes = [
      "Date,Description,Amount,Balance",
      "03/05/2026,ACME DEPOSIT,300.00,1300.00",
      "03/12/2026,OFFICE SUPPLIES,(75.50),1224.50",
    ].join("\n");

    const result = await processStatementOcrJob(reRunnableJob(fixture), {
      workerId: fixture.workerId,
    });
    expect(result.completed).toBe(true);
    expect(result.source).toBe("csv");
    expect(aiState.calls).toBe(0);

    const lines = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.reconciliationId, fixture.reconciliationId));
    expect(lines.map((line) => line.amount)).toEqual(["300.00", "-75.50"]);

    // The ocr step is never even created for a CSV.
    const steps = await db
      .select()
      .from(agentRunSteps)
      .where(eq(agentRunSteps.runId, fixture.runId));
    expect(steps.map((step) => step.step)).not.toContain("ocr");

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, fixture.runId));
    expect(run.status).toBe("completed");
  });

  it("blocks without retrying when the extraction fails schema validation", async () => {
    const fixture = await createFixture("stmt-parse-fail");
    aiState.ok = false;
    aiState.issues = ["transactions.0.amount: expected number"];

    const result = await processStatementOcrJob(reRunnableJob(fixture), {
      workerId: fixture.workerId,
    });
    expect(result.blocked).toBe("parse_failed");

    const [run] = await db.select().from(agentRuns).where(eq(agentRuns.id, fixture.runId));
    expect(run.status).toBe("blocked");
    expect((run.blockedReason as { kind: string }).kind).toBe("parse_failed");

    const [job] = await db
      .select()
      .from(processingJobs)
      .where(and(eq(processingJobs.id, fixture.job.id)));
    expect(job.status).toBe("completed");
    expect(job.attempts).toBe(1);
  });
});
