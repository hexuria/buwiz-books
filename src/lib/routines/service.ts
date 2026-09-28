/**
 * Routine configuration (Inbox v2 spec §3).
 *
 * Session-free on purpose: request code reaches these functions through the
 * server-context wrappers in src/routes/api/-routines.ts, the Resend webhook
 * calls `ensureInboundEmailRoutine` inside its own org-context transaction,
 * and tests call everything with an org-scoped executor. Every function takes
 * the executor it must use and an explicit organization id.
 *
 * Enabling a routine — at creation or later — requires an applied chart of
 * accounts. The one exception is the system-provisioned inbound email
 * routine, which starts enabled so that existing email intake keeps working
 * exactly as before routines existed.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbExecutor } from "@/db";
import { workflowEvents } from "@/db/schema/inbox";
import { routines, type RoutineTriggerKind } from "@/db/schema/routines";
import { assertChartOfAccountsApplied } from "@/lib/coa/chart-readiness";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { toSerializableRecord, type SerializableJson } from "@/lib/serializable-json";
import {
  INBOUND_EMAIL_PROVIDER,
  INBOUND_EMAIL_ROUTINE_NAME,
  ROUTINE_NAME_MAX_LENGTH,
  defaultHmacWebhookConfig,
  inboundEmailTriggerConfig,
  isInboundEmailRoutine,
  parseHmacWebhookConfig,
} from "./config";
import { generateRoutineWebhookSecret, replaceRoutineWebhookSecret } from "./secrets";

export type RoutineRow = typeof routines.$inferSelect;

/** What a client may see of a routine: never the secret reference. */
export interface RoutineView {
  id: string;
  name: string;
  enabled: boolean;
  triggerKind: RoutineTriggerKind;
  triggerConfig: Record<string, SerializableJson>;
  /** System-provisioned (the inbound email routine): config is not editable. */
  systemManaged: boolean;
  /** Whether an HMAC webhook routine has a signing secret yet. */
  hasSigningSecret: boolean;
  ruleSnapshotId: string | null;
  maxConcurrentRuns: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const routineName = z.string().trim().min(1).max(ROUTINE_NAME_MAX_LENGTH);

export const createRoutineInputSchema = z.discriminatedUnion("triggerKind", [
  z.object({
    triggerKind: z.literal("webhook"),
    name: routineName,
    enabled: z.boolean().default(true),
  }),
]);
export type CreateRoutineInput = z.input<typeof createRoutineInputSchema>;

export const updateRoutineInputSchema = z.object({
  routineId: z.string().uuid(),
  name: routineName.optional(),
});
export type UpdateRoutineInput = z.input<typeof updateRoutineInputSchema>;

export const routineIdInputSchema = z.object({ routineId: z.string().uuid() });

export function toRoutineView(row: RoutineRow): RoutineView {
  const { secret_ref: secretRef, ...publicConfig } = row.triggerConfig;
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    triggerKind: row.triggerKind,
    triggerConfig: toSerializableRecord(publicConfig),
    systemManaged: isInboundEmailRoutine(row),
    hasSigningSecret: typeof secretRef === "string" && secretRef.length > 0,
    ruleSnapshotId: row.ruleSnapshotId,
    maxConcurrentRuns: row.maxConcurrentRuns,
    nextRunAt: row.nextRunAt,
    lastRunAt: row.lastRunAt,
    lastError: row.lastError,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function listRoutines(db: DbExecutor, orgId: string): Promise<RoutineView[]> {
  const rows = await db
    .select()
    .from(routines)
    .where(eq(routines.organizationId, orgId))
    .orderBy(asc(routines.createdAt), asc(routines.id));
  return rows.map(toRoutineView);
}

/** Load one of this organization's routines under a row lock, or throw. */
async function lockRoutine(db: DbExecutor, orgId: string, routineId: string): Promise<RoutineRow> {
  const [row] = await db
    .select()
    .from(routines)
    .where(and(eq(routines.organizationId, orgId), eq(routines.id, routineId)))
    .for("update")
    .limit(1);
  if (!row) throw new Error("Routine not found.");
  return row;
}

export async function createRoutine(
  db: DbExecutor,
  input: { orgId: string; actorId: string; routine: CreateRoutineInput },
): Promise<RoutineView> {
  const routine = createRoutineInputSchema.parse(input.routine);
  if (routine.enabled) await assertChartOfAccountsApplied(db, input.orgId);

  const [created] = await db
    .insert(routines)
    .values({
      organizationId: input.orgId,
      name: routine.name,
      enabled: routine.enabled,
      triggerKind: routine.triggerKind,
      triggerConfig: { ...defaultHmacWebhookConfig() },
      createdBy: input.actorId,
    })
    .returning();

  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "routine",
      entityId: created.id,
      action: "routine_created",
      actorId: input.actorId,
      changes: {
        name: { old: null, new: created.name },
        triggerKind: { old: null, new: created.triggerKind },
        enabled: { old: null, new: created.enabled },
      },
    },
    db,
  );
  return toRoutineView(created);
}

export async function updateRoutine(
  db: DbExecutor,
  input: { orgId: string; actorId: string; update: UpdateRoutineInput },
): Promise<RoutineView> {
  const update = updateRoutineInputSchema.parse(input.update);
  const current = await lockRoutine(db, input.orgId, update.routineId);
  if (update.name === undefined || update.name === current.name) return toRoutineView(current);

  const [updated] = await db
    .update(routines)
    .set({ name: update.name, updatedAt: new Date() })
    .where(and(eq(routines.organizationId, input.orgId), eq(routines.id, current.id)))
    .returning();
  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "routine",
      entityId: current.id,
      action: "routine_updated",
      actorId: input.actorId,
      changes: { name: { old: current.name, new: updated.name } },
    },
    db,
  );
  return toRoutineView(updated);
}

/**
 * Enable or disable a routine. Enabling requires an applied chart of accounts;
 * disabling never does — turning intake off must always be possible.
 */
export async function setRoutineEnabled(
  db: DbExecutor,
  input: { orgId: string; actorId: string; routineId: string; enabled: boolean },
): Promise<RoutineView> {
  const current = await lockRoutine(db, input.orgId, input.routineId);
  if (current.enabled === input.enabled) return toRoutineView(current);
  if (input.enabled) await assertChartOfAccountsApplied(db, input.orgId);

  const [updated] = await db
    .update(routines)
    .set({ enabled: input.enabled, updatedAt: new Date() })
    .where(and(eq(routines.organizationId, input.orgId), eq(routines.id, current.id)))
    .returning();
  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "routine",
      entityId: current.id,
      action: input.enabled ? "routine_enabled" : "routine_disabled",
      actorId: input.actorId,
      changes: { enabled: { old: current.enabled, new: updated.enabled } },
    },
    db,
  );
  return toRoutineView(updated);
}

/**
 * Generate a new signing secret for an HMAC webhook routine and return it.
 *
 * This is the ONLY time the plaintext leaves the server: it is stored
 * encrypted, the routine's `secret_ref` is repointed in the same transaction,
 * and the previous secret stops verifying as soon as this commits.
 */
export async function rotateRoutineWebhookSecret(
  db: DbExecutor,
  input: { orgId: string; actorId: string; routineId: string },
): Promise<{ routine: RoutineView; secret: string }> {
  const current = await lockRoutine(db, input.orgId, input.routineId);
  const config = parseHmacWebhookConfig(current.triggerConfig);
  if (current.triggerKind !== "webhook" || !config) {
    throw new Error("This routine does not use a signing secret.");
  }

  const secret = generateRoutineWebhookSecret();
  const { secretRef } = await replaceRoutineWebhookSecret(db, {
    orgId: input.orgId,
    routineId: current.id,
    actorId: input.actorId,
    secret,
  });
  const [updated] = await db
    .update(routines)
    .set({ triggerConfig: { ...config, secret_ref: secretRef }, updatedAt: new Date() })
    .where(and(eq(routines.organizationId, input.orgId), eq(routines.id, current.id)))
    .returning();
  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "routine",
      entityId: current.id,
      // The diff records THAT the secret changed, never its value.
      action: "routine_secret_rotated",
      actorId: input.actorId,
      changes: { hadSigningSecret: { old: config.secret_ref !== null, new: true } },
    },
    db,
  );
  return { routine: toRoutineView(updated), secret };
}

/**
 * The organization's inbound email routine, provisioned on first use.
 *
 * Called from the Resend webhook inside the organization's context. Two
 * emails racing for a brand-new organization converge on one row through
 * `routines_org_inbound_email_unique`: the loser's insert does nothing and it
 * re-reads the winner's committed row.
 */
export async function ensureInboundEmailRoutine(
  db: DbExecutor,
  orgId: string,
): Promise<RoutineRow> {
  const findExisting = async () => {
    const [row] = await db
      .select()
      .from(routines)
      .where(
        and(
          eq(routines.organizationId, orgId),
          eq(routines.triggerKind, "webhook"),
          sql`${routines.triggerConfig} ->> 'provider' = ${INBOUND_EMAIL_PROVIDER}`,
        ),
      )
      .limit(1);
    return row;
  };

  const existing = await findExisting();
  if (existing) return existing;

  const [created] = await db
    .insert(routines)
    .values({
      organizationId: orgId,
      name: INBOUND_EMAIL_ROUTINE_NAME,
      enabled: true,
      triggerKind: "webhook",
      triggerConfig: { ...inboundEmailTriggerConfig() },
    })
    .onConflictDoNothing()
    .returning();
  if (!created) {
    const winner = await findExisting();
    if (!winner) throw new Error("Inbound email routine could not be provisioned.");
    return winner;
  }

  await db
    .insert(workflowEvents)
    .values({
      organizationId: orgId,
      entityType: "routine",
      entityId: created.id,
      action: "routine_provisioned",
      actorType: "system",
      idempotencyKey: `routine:${created.id}:provisioned`,
      data: { triggerKind: "webhook", provider: INBOUND_EMAIL_PROVIDER },
    })
    .onConflictDoNothing();
  return created;
}
