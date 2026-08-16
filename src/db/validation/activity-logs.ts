import { z } from "zod";

/**
 * Schema for inserting an activity log entry (server-side only)
 */
export const insertActivityLogSchema = z.object({
  organizationId: z.string(),
  entityType: z.string(),
  entityId: z.string().uuid(),
  action: z.string(),
  actorId: z.string().nullable().optional(),
  changes: z.record(z.string(), z.any()).nullable().optional(),
});

export type InsertActivityLogInput = z.infer<typeof insertActivityLogSchema>;

/**
 * Schema for querying activity logs by entity
 */
export const listActivityLogsSchema = z.object({
  entityType: z.string().default("transaction"),
  entityId: z.string().uuid(),
});

export type ListActivityLogsInput = z.infer<typeof listActivityLogsSchema>;
