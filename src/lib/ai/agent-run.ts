// ============================================================================
// Agent-run checkpointing — the durable pipeline primitives (typed state,
// code-owned routing, per-step provenance) without a graph executor.
//
// A pipeline handler wraps each stage in runStep(). Completed steps are
// SKIPPED on re-execution (crash/retry resume): the step's outputRef (IDs
// only, never blobs) is returned so the handler can re-derive state from the
// database. An auditor can replay every edge from agent_run_steps.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { agentRuns, agentRunSteps, type AgentRunKind } from "../../db/schema/ai";

export interface StartRunInput {
  orgId: string;
  kind: AgentRunKind;
  /** Prompt versions, chains, thresholds active for this run. */
  configSnapshot?: Record<string, unknown>;
}

export async function startRun(db: DbExecutor, input: StartRunInput): Promise<string> {
  const [run] = await db
    .insert(agentRuns)
    .values({
      organizationId: input.orgId,
      kind: input.kind,
      configSnapshot: input.configSnapshot,
    })
    .returning({ id: agentRuns.id });
  return run.id;
}

export interface RunStepResult<T> {
  /** True when the step had already completed (resume) — fn was NOT run. */
  skipped: boolean;
  /** The completed step's outputRef (fresh or from the prior execution). */
  output: Record<string, unknown> | null;
  /** fn's return value; null when skipped. */
  value: T | null;
}

/**
 * Execute one pipeline stage idempotently. If a completed row for
 * (runId, step) exists, fn is skipped and the recorded outputRef returned —
 * handlers must be able to re-derive their state from the DB via that ref.
 * Failures are recorded on the step row and rethrown.
 */
export async function runStep<T = unknown>(
  db: DbExecutor,
  run: { runId: string; orgId: string; processingJobId?: string },
  step: string,
  fn: () => Promise<{ value?: T; output?: Record<string, unknown> }>,
): Promise<RunStepResult<T>> {
  const [existing] = await db
    .select()
    .from(agentRunSteps)
    .where(
      and(
        eq(agentRunSteps.runId, run.runId),
        eq(agentRunSteps.step, step),
        eq(agentRunSteps.status, "completed"),
      ),
    )
    .limit(1);
  if (existing) {
    return { skipped: true, output: existing.outputRef ?? null, value: null };
  }

  const [stepRow] = await db
    .insert(agentRunSteps)
    .values({
      organizationId: run.orgId,
      runId: run.runId,
      step,
      processingJobId: run.processingJobId,
    })
    .returning({ id: agentRunSteps.id });

  try {
    const { value, output } = await fn();
    await db
      .update(agentRunSteps)
      .set({ status: "completed", outputRef: output ?? null, finishedAt: new Date() })
      .where(eq(agentRunSteps.id, stepRow.id));
    return { skipped: false, output: output ?? null, value: value ?? null };
  } catch (err) {
    await db
      .update(agentRunSteps)
      .set({
        status: "failed",
        error: { message: err instanceof Error ? err.message : String(err) },
        finishedAt: new Date(),
      })
      .where(eq(agentRunSteps.id, stepRow.id));
    throw err;
  }
}

export async function completeRun(db: DbExecutor, runId: string): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: "completed", finishedAt: new Date() })
    .where(eq(agentRuns.id, runId));
}

/**
 * Mark a run failed. Pass `orgId` from any caller that has no session
 * context — the worker terminalizer reaches this from a job payload, and an
 * unscoped update keyed only on a payload-supplied id is a cross-tenant
 * write waiting to happen.
 */
export async function failRun(
  db: DbExecutor,
  runId: string,
  reason?: Record<string, unknown>,
  orgId?: string,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: "failed", blockedReason: reason, finishedAt: new Date() })
    .where(
      orgId
        ? and(eq(agentRuns.id, runId), eq(agentRuns.organizationId, orgId))
        : eq(agentRuns.id, runId),
    );
}

/**
 * Block a run pending human input (e.g. the statement validation gate).
 * A blocked run is terminal until an explicit re-enqueue (force) restarts it.
 */
export async function blockRun(
  db: DbExecutor,
  runId: string,
  reason: Record<string, unknown>,
): Promise<void> {
  await db
    .update(agentRuns)
    .set({ status: "blocked", blockedReason: reason, finishedAt: new Date() })
    .where(eq(agentRuns.id, runId));
}

export interface RunStatus {
  runId: string;
  kind: AgentRunKind;
  status: string;
  blockedReason: Record<string, unknown> | null;
  steps: Array<{ step: string; status: string; error: Record<string, unknown> | null }>;
}

/** Client-pollable run status (org-scoped). */
export async function getRunStatus(
  db: DbExecutor,
  orgId: string,
  runId: string,
): Promise<RunStatus | null> {
  const [run] = await db
    .select()
    .from(agentRuns)
    .where(and(eq(agentRuns.id, runId), eq(agentRuns.organizationId, orgId)))
    .limit(1);
  if (!run) return null;
  const steps = await db
    .select()
    .from(agentRunSteps)
    .where(eq(agentRunSteps.runId, runId))
    .orderBy(agentRunSteps.startedAt);
  return {
    runId: run.id,
    kind: run.kind,
    status: run.status,
    blockedReason: run.blockedReason ?? null,
    steps: steps.map((s) => ({ step: s.step, status: s.status, error: s.error ?? null })),
  };
}
