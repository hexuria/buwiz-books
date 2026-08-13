// ============================================================================
// match_assist job, end to end against the database.
//
// The façade is mocked (no model calls); everything else is real, so this
// exercises blocking → grounding → the 84 cap → dismissal memory on actual
// rows, plus the run ledger.
// ============================================================================
import { describe, it, expect, beforeAll, afterAll, vi, beforeEach } from "vitest";
import { createTestDb } from "../utils/db-utils";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import {
  reconciliations,
  statementLines,
  reconciliationSuggestions,
} from "../../src/db/schema/reconciliations";
import { financialAccounts } from "../../src/db/schema/financial-accounts";
import { accounts } from "../../src/db/schema/accounts";
import { journalHeaders, journalLines } from "../../src/db/schema/journals";
import { agentRuns } from "../../src/db/schema/ai";

const { aiCompleteMock } = vi.hoisted(() => ({ aiCompleteMock: vi.fn() }));
vi.mock("../../src/lib/ai/facade", () => ({ aiComplete: aiCompleteMock }));
vi.mock("../../src/lib/jobs/trigger", () => ({ triggerWorker: vi.fn() }));

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

describeDb("match_assist job", () => {
  let db: any;
  let sql: postgres.Sql;
  let processMatchAssistJob: typeof import("../../src/lib/jobs/handlers/match-assist").processMatchAssistJob;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
    ({ processMatchAssistJob } = await import("../../src/lib/jobs/handlers/match-assist"));
  });

  afterAll(async () => {
    await sql.end();
  });

  beforeEach(() => {
    aiCompleteMock.mockReset();
  });

  /** Seed an org with a bank account, a reconciliation, one unmatched line and one ledger candidate. */
  async function seedScenario() {
    const orgId = crypto.randomUUID();

    const [ledgerAccount] = await db
      .insert(accounts)
      .values({
        organizationId: orgId,
        name: "Business Checking",
        accountNumber: `1100-${crypto.randomUUID().slice(0, 4)}`,
        accountType: "asset" as const,
        subtype: "bank_accounts" as const,
      })
      .returning();

    const [bank] = await db
      .insert(financialAccounts)
      .values({
        organizationId: orgId,
        accountName: "Checking",
        accountType: "checking" as const,
        ledgerAccountId: ledgerAccount.id,
        isManual: true,
      })
      .returning();

    const [recon] = await db
      .insert(reconciliations)
      .values({
        organizationId: orgId,
        bankAccountId: bank.id,
        periodStart: "2026-01-01",
        periodEnd: "2026-01-31",
      })
      .returning();

    const [line] = await db
      .insert(statementLines)
      .values({
        reconciliationId: recon.id,
        transactionDate: "2026-01-10",
        description: "ACME SUPPLY CO 4471",
        amount: "-250.00",
        matchStatus: "unmatched" as const,
        source: "ocr" as const,
      })
      .returning();

    const [header] = await db
      .insert(journalHeaders)
      .values({
        organizationId: orgId,
        transactionDate: "2026-01-09",
        transactionType: "pay_out" as const,
        memo: "Acme Supply invoice",
        status: "posted" as const,
        transactionNumber: `TXN-${crypto.randomUUID().slice(0, 8)}`,
      })
      .returning();

    const [jl] = await db
      .insert(journalLines)
      .values({
        organizationId: orgId,
        journalHeaderId: header.id,
        accountId: ledgerAccount.id,
        credit: "250.00",
        debit: "0",
        lineDescription: "ACME SUPPLY CO",
      })
      .returning();

    return { orgId, reconciliationId: recon.id, statementLineId: line.id, journalLineId: jl.id };
  }

  const job = (orgId: string, reconciliationId: string, prefill = false) =>
    ({
      id: crypto.randomUUID(),
      organizationId: orgId,
      payload: { reconciliationId, ...(prefill ? { prefill: true } : {}) },
    }) as never;

  const ctx = { workerId: "test-worker" } as never;

  it("caps a fully-confident AI match at 84 and records the run", async () => {
    const s = await seedScenario();
    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: null,
      model: "test",
      data: {
        decisions: [
          {
            statementLineId: s.statementLineId,
            decision: "match",
            journalLineIds: [s.journalLineId],
            confidence: 1.0,
            reason: "exact amount and payee",
          },
        ],
      },
    });

    const result = await processMatchAssistJob(job(s.orgId, s.reconciliationId), ctx);
    expect(result.processed).toBe(true);

    const suggestions = await db
      .select()
      .from(reconciliationSuggestions)
      .where(eq(reconciliationSuggestions.reconciliationId, s.reconciliationId));
    expect(suggestions).toHaveLength(1);
    expect(Number(suggestions[0].confidence)).toBe(84);
    expect(suggestions[0].status).toBe("pending");

    // The statement line must NOT have been auto-linked.
    const [line] = await db
      .select()
      .from(statementLines)
      .where(eq(statementLines.id, s.statementLineId));
    expect(line.matchStatus).toBe("unmatched");
    expect(line.matchedJournalLineId).toBeNull();

    const runs = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.organizationId, s.orgId), eq(agentRuns.kind, "match_assist")));
    expect(runs[0].status).toBe("completed");
  });

  it("drops a hallucinated ledger line instead of persisting it", async () => {
    const s = await seedScenario();
    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: null,
      model: "test",
      data: {
        decisions: [
          {
            statementLineId: s.statementLineId,
            decision: "match",
            journalLineIds: [crypto.randomUUID()],
            confidence: 0.9,
            reason: "invented",
          },
        ],
      },
    });

    await processMatchAssistJob(job(s.orgId, s.reconciliationId), ctx);
    const suggestions = await db
      .select()
      .from(reconciliationSuggestions)
      .where(eq(reconciliationSuggestions.reconciliationId, s.reconciliationId));
    expect(suggestions).toHaveLength(0);
  });

  it("never re-creates a dismissed suggestion", async () => {
    const s = await seedScenario();
    await db.insert(reconciliationSuggestions).values({
      organizationId: s.orgId,
      reconciliationId: s.reconciliationId,
      statementLineId: s.statementLineId,
      journalLineId: s.journalLineId,
      suggestionType: "auto_match" as const,
      confidence: "80",
      status: "dismissed" as const,
    });

    aiCompleteMock.mockResolvedValue({
      ok: true,
      invocationId: null,
      model: "test",
      data: {
        decisions: [
          {
            statementLineId: s.statementLineId,
            decision: "match",
            journalLineIds: [s.journalLineId],
            confidence: 0.95,
            reason: "same pairing as before",
          },
        ],
      },
    });

    await processMatchAssistJob(job(s.orgId, s.reconciliationId), ctx);
    const pending = await db
      .select()
      .from(reconciliationSuggestions)
      .where(
        and(
          eq(reconciliationSuggestions.reconciliationId, s.reconciliationId),
          eq(reconciliationSuggestions.status, "pending"),
        ),
      );
    expect(pending).toHaveLength(0);
  });

  it("completes without calling the model when nothing is unmatched", async () => {
    const s = await seedScenario();
    await db
      .update(statementLines)
      .set({ matchStatus: "matched", matchedJournalLineId: s.journalLineId })
      .where(eq(statementLines.id, s.statementLineId));

    const result = await processMatchAssistJob(job(s.orgId, s.reconciliationId), ctx);
    expect(result.processed).toBe(true);
    expect(aiCompleteMock).not.toHaveBeenCalled();
  });

  it("fails the run when the reconciliation is gone", async () => {
    const orgId = crypto.randomUUID();
    const result = await processMatchAssistJob(job(orgId, crypto.randomUUID()), ctx);
    expect(result.reason).toBe("reconciliation_missing");
    const runs = await db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.organizationId, orgId), eq(agentRuns.kind, "match_assist")));
    expect(runs[0].status).toBe("failed");
  });
});
