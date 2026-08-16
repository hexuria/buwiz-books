import { and, asc, eq, inArray, or, sql } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import {
  organizationDailyAccountActivity,
  organizationReportingAccounts,
  organizationReportingDirtyDates,
  organizationReportingProjectionState,
} from "@/db/schema/reporting-projections";
import { BUSINESS_GROUP_PROJECTION_JOB_TYPE } from "@/lib/reporting/projection";
import type { JobContext, JobHandlerResult, ProcessingJob } from "../registry";

const DATE_CHUNK_SIZE = 31;

interface ProjectedAccountRow {
  activityDate: string;
  accountId: string;
  totalDebit: string;
  totalCredit: string;
}

async function syncReportingAccounts(tx: DbExecutor, organizationId: string) {
  await tx
    .delete(organizationReportingAccounts)
    .where(eq(organizationReportingAccounts.organizationId, organizationId));
  await tx.execute(sql`
    insert into organization_reporting_accounts (
      organization_id,
      account_id,
      account_name,
      account_number,
      account_type,
      subtype,
      parent_id,
      synced_at
    )
    select
      accounts.organization_id,
      accounts.id,
      accounts.name,
      accounts.account_number,
      accounts.account_type,
      accounts.subtype,
      accounts.parent_id,
      now()
    from accounts
    where accounts.organization_id = ${organizationId}
  `);
}

async function seedFullRebuild(tx: DbExecutor, organizationId: string, requestedVersion: number) {
  await tx
    .delete(organizationDailyAccountActivity)
    .where(eq(organizationDailyAccountActivity.organizationId, organizationId));
  await tx.execute(sql`
    insert into organization_reporting_dirty_dates (
      organization_id,
      activity_date,
      version,
      marked_at
    )
    select distinct
      ${organizationId},
      headers.transaction_date,
      ${requestedVersion}::integer,
      now()
    from journal_headers headers
    where headers.organization_id = ${organizationId}
    on conflict (organization_id, activity_date) do update
    set version = greatest(organization_reporting_dirty_dates.version, excluded.version),
        marked_at = excluded.marked_at
  `);
  await tx
    .update(organizationReportingProjectionState)
    .set({ fullRebuildRequested: false, status: "building", updatedAt: new Date() })
    .where(eq(organizationReportingProjectionState.organizationId, organizationId));
}

async function aggregateDates(
  tx: DbExecutor,
  organizationId: string,
  dates: readonly string[],
): Promise<ProjectedAccountRow[]> {
  if (dates.length === 0) return [];
  const result = await tx.execute(sql`
    select
      headers.transaction_date as "activityDate",
      lines.account_id as "accountId",
      coalesce(sum(lines.debit), 0)::text as "totalDebit",
      coalesce(sum(lines.credit), 0)::text as "totalCredit"
    from journal_headers headers
    join journal_lines lines on lines.journal_header_id = headers.id
    where headers.organization_id = ${organizationId}
      and headers.status = 'posted'
      and headers.duplicate_of_header_id is null
      and headers.transaction_date in (${sql.join(
        dates.map((date) => sql`${date}::date`),
        sql`, `,
      )})
    group by headers.transaction_date, lines.account_id
  `);
  return result as unknown as ProjectedAccountRow[];
}

async function completeOrRequeue(
  tx: DbExecutor,
  input: {
    job: ProcessingJob;
    workerId: string;
    organizationId: string;
    processedAny: boolean;
  },
): Promise<"completed" | "requeued" | "lease_lost"> {
  const [remaining] = await tx
    .select({ organizationId: organizationReportingDirtyDates.organizationId })
    .from(organizationReportingDirtyDates)
    .where(eq(organizationReportingDirtyDates.organizationId, input.organizationId))
    .limit(1);
  const [state] = await tx
    .select()
    .from(organizationReportingProjectionState)
    .where(eq(organizationReportingProjectionState.organizationId, input.organizationId))
    .limit(1);
  const now = new Date();

  if (remaining || state?.fullRebuildRequested) {
    await tx
      .update(organizationReportingProjectionState)
      .set({
        status: "building",
        ...(input.processedAny ? { lastProjectedAt: now } : {}),
        lastError: null,
        updatedAt: now,
      })
      .where(eq(organizationReportingProjectionState.organizationId, input.organizationId));
    const [requeued] = await tx
      .update(processingJobs)
      .set({
        status: "queued",
        attempts: 0,
        runAt: now,
        lockedBy: null,
        lockedUntil: null,
        lastError: null,
        updatedAt: now,
      })
      .where(
        and(
          eq(processingJobs.id, input.job.id),
          eq(processingJobs.status, "running"),
          eq(processingJobs.lockedBy, input.workerId),
        ),
      )
      .returning({ id: processingJobs.id });
    return requeued ? "requeued" : "lease_lost";
  }

  if (state) {
    await tx
      .update(organizationReportingProjectionState)
      .set({
        status: "ready",
        appliedVersion: state.requestedVersion,
        lastProjectedAt: now,
        initialBackfillCompletedAt: state.initialBackfillCompletedAt ?? now,
        lastError: null,
        updatedAt: now,
      })
      .where(eq(organizationReportingProjectionState.organizationId, input.organizationId));
  }
  const [completed] = await tx
    .update(processingJobs)
    .set({
      status: "completed",
      lockedBy: null,
      lockedUntil: null,
      completedAt: now,
      lastError: null,
      updatedAt: now,
    })
    .where(
      and(
        eq(processingJobs.id, input.job.id),
        eq(processingJobs.status, "running"),
        eq(processingJobs.lockedBy, input.workerId),
      ),
    )
    .returning({ id: processingJobs.id });
  return completed ? "completed" : "lease_lost";
}

export async function processBusinessGroupProjectionJob(
  job: ProcessingJob,
  ctx: JobContext,
): Promise<JobHandlerResult> {
  const organizationId = job.organizationId;
  try {
    const outcome = await withOrgContext(organizationId, "system", "admin", async (tx) => {
      const [state] = await tx
        .select()
        .from(organizationReportingProjectionState)
        .where(eq(organizationReportingProjectionState.organizationId, organizationId))
        .for("update")
        .limit(1);
      if (!state) {
        return completeOrRequeue(tx, {
          job,
          workerId: ctx.workerId,
          organizationId,
          processedAny: false,
        });
      }

      if (state.fullRebuildRequested) {
        await seedFullRebuild(tx, organizationId, state.requestedVersion);
      }
      await syncReportingAccounts(tx, organizationId);

      const dirtyDates = await tx
        .select({
          activityDate: organizationReportingDirtyDates.activityDate,
          version: organizationReportingDirtyDates.version,
        })
        .from(organizationReportingDirtyDates)
        .where(eq(organizationReportingDirtyDates.organizationId, organizationId))
        .orderBy(asc(organizationReportingDirtyDates.activityDate))
        .limit(DATE_CHUNK_SIZE);

      if (dirtyDates.length > 0) {
        const dates = dirtyDates.map((dirty) => dirty.activityDate);
        const rows = await aggregateDates(tx, organizationId, dates);
        await tx
          .delete(organizationDailyAccountActivity)
          .where(
            and(
              eq(organizationDailyAccountActivity.organizationId, organizationId),
              inArray(organizationDailyAccountActivity.activityDate, dates),
            ),
          );
        if (rows.length > 0) {
          await tx.insert(organizationDailyAccountActivity).values(
            rows.map((row) => ({
              organizationId,
              activityDate: row.activityDate,
              accountId: row.accountId,
              totalDebit: row.totalDebit,
              totalCredit: row.totalCredit,
              computedAt: new Date(),
            })),
          );
        }
        await tx
          .delete(organizationReportingDirtyDates)
          .where(
            or(
              ...dirtyDates.map((dirty) =>
                and(
                  eq(organizationReportingDirtyDates.organizationId, organizationId),
                  eq(organizationReportingDirtyDates.activityDate, dirty.activityDate),
                  eq(organizationReportingDirtyDates.version, dirty.version),
                ),
              ),
            ),
          );
      }

      return completeOrRequeue(tx, {
        job,
        workerId: ctx.workerId,
        organizationId,
        processedAny: dirtyDates.length > 0,
      });
    });

    return {
      processed: outcome !== "lease_lost",
      reason: outcome,
      jobId: job.id,
      organizationId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await withOrgContext(organizationId, "system", "admin", (tx) =>
      tx
        .update(organizationReportingProjectionState)
        .set({ status: "failed", lastError: message, updatedAt: new Date() })
        .where(eq(organizationReportingProjectionState.organizationId, organizationId)),
    ).catch(() => undefined);
    throw error;
  }
}

export { BUSINESS_GROUP_PROJECTION_JOB_TYPE };
