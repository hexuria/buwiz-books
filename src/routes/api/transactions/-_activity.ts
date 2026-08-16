/**
 * Transactions API — Activity Logs
 * List activity log entries with actor name resolution
 */
import { createServerFn } from "@tanstack/react-start";
import { activityLogs } from "../../../db/schema/activity-logs";
import { user as authUsers } from "../../../db/schema/auth";
import { eq, desc, and } from "drizzle-orm";
import { z } from "zod";
import { withSessionOrgContext } from "../../../lib/server-context";
import { listActivityLogsSchema } from "../../../db/validation/activity-logs";

// ============================================================================
// Server Functions — Activity
// ============================================================================

/**
 * List activity logs for a given entity (e.g. a transaction).
 * Joins auth_users to resolve actor names. Ordered newest-first.
 */
export const listActivityLogs = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof listActivityLogsSchema>) =>
    listActivityLogsSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const parsed = listActivityLogsSchema.parse(rawData);

      const logs = await db
        .select({
          id: activityLogs.id,
          entityType: activityLogs.entityType,
          entityId: activityLogs.entityId,
          action: activityLogs.action,
          actorId: activityLogs.actorId,
          actorName: authUsers.name,
          changes: activityLogs.changes,
          createdAt: activityLogs.createdAt,
        })
        .from(activityLogs)
        .leftJoin(authUsers, eq(activityLogs.actorId, authUsers.id))
        .where(
          and(
            eq(activityLogs.organizationId, orgId),
            eq(activityLogs.entityType, parsed.entityType),
            eq(activityLogs.entityId, parsed.entityId),
          ),
        )
        .orderBy(desc(activityLogs.createdAt));

      return logs.map((log) => ({
        ...log,
        changes: (log.changes ?? null) as Record<string, any> | null,
      }));
    });
  });
