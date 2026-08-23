// ============================================================================
// ai_reflection job — bounded reflection over an org's recent corrections.
//
// ONE cheap model call per (org, task), no loop, no tools. Output is only
// ever a PROPOSED lesson; an org admin approves before anything is injected
// into a future prompt, and injection itself is JSON data behind an
// untrusted-content preamble (lessons.ts).
//
// This is the "reflect" stage of the improvement loop, and it is deliberately
// the least powerful part of it: everything it produces is inert until a
// human says otherwise.
// ============================================================================

import { and, desc, eq, inArray, sql } from "drizzle-orm";
import { completeProcessingJob } from "@/lib/inbox/processing-job-lease";
import { withOrgContext, type DbExecutor } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import { aiActionProposals, aiLessons, aiRunFeedback } from "@/db/schema/ai";
import { aiComplete } from "@/lib/ai/facade";
import type { ReflectionOutput } from "@/lib/ai/schemas/reflection";
import { MAX_LESSON_CHARS } from "@/lib/ai/lessons";
import { createLogger } from "@/lib/logger";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";
import type { AiProposalKind } from "@/db/schema/ai";

const logger = createLogger("jobs.reflection");

export const REFLECTION_JOB_TYPE = "ai_reflection";

/** Enough corrections to see a pattern; few enough to keep the prompt small. */
const MIN_CORRECTIONS = 5;
const MAX_CORRECTIONS = 40;
const MAX_PROPOSED_PER_RUN = 5;
const LESSON_TTL_DAYS = 180;

export interface ReflectionJobPayload {
  /** Proposal kinds to reflect over; defaults to everything with feedback. */
  kinds?: AiProposalKind[];
}

export function reflectionDedupeKey(orgId: string, isoWeek: string): string {
  return `reflection:${orgId}:${isoWeek}`;
}

export async function processReflectionJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const orgId = job.organizationId;
  const payload = (job.payload ?? {}) as unknown as ReflectionJobPayload;

  const orgTx = <T>(fn: (tx: DbExecutor) => Promise<T>) =>
    withOrgContext(orgId, "system", "admin", fn);

  // Which kinds actually have correction volume?
  const kinds = await orgTx((tx) =>
    tx
      .select({ kind: aiActionProposals.kind, total: sql<number>`count(*)` })
      .from(aiRunFeedback)
      .innerJoin(aiActionProposals, eq(aiRunFeedback.proposalId, aiActionProposals.id))
      .where(
        and(
          eq(aiRunFeedback.organizationId, orgId),
          eq(aiRunFeedback.verdict, "corrected"),
          ...(payload.kinds?.length ? [inArray(aiActionProposals.kind, payload.kinds)] : []),
        ),
      )
      .groupBy(aiActionProposals.kind),
  );

  let proposed = 0;
  for (const { kind, total } of kinds) {
    if (Number(total) < MIN_CORRECTIONS) continue;

    const corrections = await orgTx((tx) =>
      tx
        .select({
          feedbackId: aiRunFeedback.id,
          proposed: aiActionProposals.proposal,
          corrected: aiRunFeedback.correction,
        })
        .from(aiRunFeedback)
        .innerJoin(aiActionProposals, eq(aiRunFeedback.proposalId, aiActionProposals.id))
        .where(
          and(
            eq(aiRunFeedback.organizationId, orgId),
            eq(aiRunFeedback.verdict, "corrected"),
            eq(aiActionProposals.kind, kind),
          ),
        )
        .orderBy(desc(aiRunFeedback.createdAt))
        .limit(MAX_CORRECTIONS),
    );
    if (corrections.length < MIN_CORRECTIONS) continue;

    // Model call OUTSIDE any transaction.
    const result = await aiComplete<ReflectionOutput>({
      task: "reflection",
      input: {
        task: kind,
        corrections: corrections.map((c) => ({
          feedbackId: c.feedbackId,
          task: kind,
          proposed: c.proposed,
          corrected: c.corrected,
        })),
      },
      ctx: { orgId },
    });
    if (!result.ok) {
      logger.warn("Reflection output failed validation", { orgId, kind, issues: result.issues });
      continue;
    }

    const candidates = result.data.lessons.slice(0, MAX_PROPOSED_PER_RUN);
    if (candidates.length === 0) continue;

    await orgTx(async (tx) => {
      // Never stack duplicates of a note the org already has in any state.
      const existing = await tx
        .select({ lesson: aiLessons.lesson })
        .from(aiLessons)
        .where(and(eq(aiLessons.organizationId, orgId), eq(aiLessons.task, kind)));
      const seen = new Set(existing.map((e) => e.lesson.trim().toLowerCase()));

      const rows = candidates
        .map((c) => ({ ...c, text: c.text.slice(0, MAX_LESSON_CHARS).trim() }))
        .filter((c) => c.text.length > 0 && !seen.has(c.text.toLowerCase()))
        .map((c) => ({
          organizationId: orgId,
          task: kind,
          lesson: c.text,
          sourceFeedbackIds: c.sourceFeedbackIds,
          status: "proposed" as const,
          expiresAt: new Date(Date.now() + LESSON_TTL_DAYS * 24 * 60 * 60 * 1000),
        }));

      if (rows.length > 0) {
        await tx.insert(aiLessons).values(rows);
        proposed += rows.length;
      }
    });
  }

  logger.info("Reflection complete", { orgId, kindsExamined: kinds.length, proposed });
  const completed = await withOrgContext(orgId, "system", "admin", (tx) =>
    completeProcessingJob(tx, job.id, ctx.workerId),
  );
  if (!completed) {
    return { processed: false, reason: "lease_lost", jobId: job.id };
  }
  return { processed: true, jobId: job.id, lessonsProposed: proposed };
}

/** Enqueue the weekly reflection job for an org (idempotent per ISO week). */
export async function enqueueReflectionJob(
  tx: DbExecutor,
  input: { organizationId: string; isoWeek: string; kinds?: AiProposalKind[] },
): Promise<string | null> {
  const [created] = await tx
    .insert(processingJobs)
    .values({
      organizationId: input.organizationId,
      jobType: REFLECTION_JOB_TYPE,
      dedupeKey: reflectionDedupeKey(input.organizationId, input.isoWeek),
      payload: (input.kinds ? { kinds: input.kinds } : {}) as Record<string, unknown>,
    })
    .onConflictDoNothing()
    .returning({ id: processingJobs.id });
  return created?.id ?? null;
}
