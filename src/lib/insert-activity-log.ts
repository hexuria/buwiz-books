/**
 * Shared Activity Log Helper
 * Insert an activity log entry for any entity (transaction, bill, invoice, etc.)
 * The executor is required so the insert always runs on the caller's RLS org
 * context (ctx.db or the enclosing transaction), never the raw pool.
 */
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";

export async function insertActivityLog(
  params: {
    orgId: string;
    entityType: string;
    entityId: string;
    action: string;
    actorId: string;
    changes?: Record<string, unknown>;
  },
  tx: DbExecutor,
) {
  await tx.insert(activityLogs).values({
    organizationId: params.orgId,
    entityType: params.entityType,
    entityId: params.entityId,
    action: params.action,
    actorId: params.actorId,
    changes: params.changes ?? null,
  });
}
