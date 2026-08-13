import { and, eq, inArray, sql } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "@/db";
import { processingJobs } from "@/db/schema/inbox";
import { organizationReportingProjectionState } from "@/db/schema/reporting-projections";
import { retryPolicyFor } from "@/lib/jobs/retry-policy";
import type { ProjectionStateView } from "./projection-types";

export type { ProjectionStateView } from "./projection-types";

export const BUSINESS_GROUP_PROJECTION_JOB_TYPE = "business_group_projection_refresh";
export const BUSINESS_GROUP_PROJECTION_DEDUPE_KEY = "business_group_projection_refresh";

/**
 * Request a projection pass from inside the target organization's RLS
 * context. A full rebuild is used for first link/backfill; ordinary refreshes
 * only expedite already-dirty work and advance a pollable version.
 */
export async function requestReportingProjection(
  tx: DbExecutor,
  input: { organizationId: string; fullRebuild?: boolean },
): Promise<{ jobId: string | null; requestedVersion: number }> {
  const fullRebuild = input.fullRebuild ?? false;
  const now = new Date();
  const [state] = await tx
    .insert(organizationReportingProjectionState)
    .values({
      organizationId: input.organizationId,
      status: "pending",
      requestedVersion: 1,
      appliedVersion: 0,
      fullRebuildRequested: true,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: organizationReportingProjectionState.organizationId,
      set: {
        status: "pending",
        requestedVersion: sql`${organizationReportingProjectionState.requestedVersion} + 1`,
        fullRebuildRequested: fullRebuild
          ? true
          : sql`${organizationReportingProjectionState.fullRebuildRequested}`,
        lastError: null,
        updatedAt: now,
      },
    })
    .returning({ requestedVersion: organizationReportingProjectionState.requestedVersion });

  const [insertedJob] = await tx
    .insert(processingJobs)
    .values({
      organizationId: input.organizationId,
      jobType: BUSINESS_GROUP_PROJECTION_JOB_TYPE,
      dedupeKey: BUSINESS_GROUP_PROJECTION_DEDUPE_KEY,
      maxAttempts: retryPolicyFor(BUSINESS_GROUP_PROJECTION_JOB_TYPE).maxAttempts,
      payload: {},
    })
    .onConflictDoNothing()
    .returning({ id: processingJobs.id });

  let jobId = insertedJob?.id ?? null;
  if (!jobId) {
    const [queuedJob] = await tx
      .update(processingJobs)
      .set({ runAt: now, lastError: null, updatedAt: now })
      .where(
        and(
          eq(processingJobs.organizationId, input.organizationId),
          eq(processingJobs.dedupeKey, BUSINESS_GROUP_PROJECTION_DEDUPE_KEY),
          eq(processingJobs.status, "queued"),
        ),
      )
      .returning({ id: processingJobs.id });
    jobId = queuedJob?.id ?? null;
  }

  return { jobId, requestedVersion: state.requestedVersion };
}

/**
 * Enter a previously authorized linked organization's RLS context and request
 * a refresh. The caller must obtain the organization and role from
 * getAccessibleGroupEntitiesForGroups; neither value may come from the client.
 */
export async function requestAuthorizedReportingProjection(input: {
  organizationId: string;
  userId: string;
  role: string;
  fullRebuild?: boolean;
}): Promise<{ jobId: string | null; requestedVersion: number }> {
  return withOrgContext(input.organizationId, input.userId, input.role, (tx) =>
    requestReportingProjection(tx, {
      organizationId: input.organizationId,
      fullRebuild: input.fullRebuild,
    }),
  );
}

export async function getReportingProjectionStates(
  tx: DbExecutor,
  organizationIds: readonly string[],
): Promise<Map<string, ProjectionStateView>> {
  const uniqueIds = [...new Set(organizationIds)];
  if (uniqueIds.length === 0) return new Map();
  const rows = await tx
    .select()
    .from(organizationReportingProjectionState)
    .where(inArray(organizationReportingProjectionState.organizationId, uniqueIds));
  return new Map(
    rows.map((row) => [
      row.organizationId,
      {
        organizationId: row.organizationId,
        status: row.status,
        requestedVersion: row.requestedVersion,
        appliedVersion: row.appliedVersion,
        lastLedgerEventAt: row.lastLedgerEventAt,
        lastProjectedAt: row.lastProjectedAt,
        initialBackfillCompletedAt: row.initialBackfillCompletedAt,
        lastError: row.lastError,
        updatedAt: row.updatedAt,
      },
    ]),
  );
}

export async function getReportingProjectionState(
  tx: DbExecutor,
  organizationId: string,
): Promise<ProjectionStateView | null> {
  const states = await getReportingProjectionStates(tx, [organizationId]);
  return states.get(organizationId) ?? null;
}

export async function hasActiveProjectionJob(
  tx: DbExecutor,
  organizationId: string,
): Promise<boolean> {
  const [row] = await tx
    .select({ id: processingJobs.id })
    .from(processingJobs)
    .where(
      sql`${processingJobs.organizationId} = ${organizationId}
        and ${processingJobs.dedupeKey} = ${BUSINESS_GROUP_PROJECTION_DEDUPE_KEY}
        and ${processingJobs.status} in ('queued', 'running')`,
    )
    .limit(1);
  return Boolean(row);
}

export async function findProjectionStatesByStatus(
  tx: DbExecutor,
  statuses: readonly ("pending" | "building" | "ready" | "failed")[],
) {
  if (statuses.length === 0) return [];
  return tx
    .select()
    .from(organizationReportingProjectionState)
    .where(inArray(organizationReportingProjectionState.status, statuses));
}
