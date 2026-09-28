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
 *
 * Setting a schedule (creating a schedule routine, changing its schedule, or
 * enabling it) computes its first `next_run_at`; disabling clears it.
 *
 * Pinning rules (spec §6): `setRoutineRuleSnapshot` pins, unpins, or shadows
 * one of the organization's immutable rule snapshots. Pinning the snapshot a
 * routine was shadowing promotes it and clears the shadow.
 */
import { and, asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { DbExecutor } from "@/db";
import { workflowEvents } from "@/db/schema/inbox";
import { routines, type RoutineTriggerKind } from "@/db/schema/routines";
import { ruleSnapshots } from "@/db/schema/rule-snapshots";
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
  parseScheduleTriggerConfig,
} from "./config";
import { computeNextRunAt, scheduleConfigSchema, type ScheduleConfig } from "./schedule";
import { getScheduleSource } from "./schedule-sources";
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
  /** The pinned rule snapshot; null = the organization's live rule configs. */
  ruleSnapshotId: string | null;
  /** A snapshot evaluated alongside and logged, never enforced. */
  shadowRuleSnapshotId: string | null;
  maxConcurrentRuns: number;
  nextRunAt: Date | null;
  lastRunAt: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const routineName = z.string().trim().min(1).max(ROUTINE_NAME_MAX_LENGTH);
const scheduleSource = z
  .string()
  .min(1)
  .max(64)
  .refine((key) => getScheduleSource(key) !== null, "Unknown schedule source.");

export const createRoutineInputSchema = z.discriminatedUnion("triggerKind", [
  z.object({
    triggerKind: z.literal("webhook"),
    name: routineName,
    enabled: z.boolean().default(true),
  }),
  z.object({
    triggerKind: z.literal("schedule"),
    name: routineName,
    enabled: z.boolean().default(true),
    schedule: scheduleConfigSchema,
    source: scheduleSource,
  }),
]);
export type CreateRoutineInput = z.input<typeof createRoutineInputSchema>;

export const updateRoutineInputSchema = z.object({
  routineId: z.string().uuid(),
  name: routineName.optional(),
  /** Replaces the whole schedule (a schedule routine only). */
  schedule: scheduleConfigSchema.optional(),
  source: scheduleSource.optional(),
});
export type UpdateRoutineInput = z.input<typeof updateRoutineInputSchema>;

export const routineIdInputSchema = z.object({ routineId: z.string().uuid() });

export const pinRoutineRuleSnapshotInputSchema = z.object({
  routineId: z.string().uuid(),
  snapshotId: z.string().uuid(),
  /** Pin as the routine's shadow (evaluated and logged) instead of its enforced rules. */
  shadow: z.boolean().default(false),
});
export type PinRoutineRuleSnapshotInput = z.input<typeof pinRoutineRuleSnapshotInputSchema>;

export const unpinRoutineRuleSnapshotInputSchema = z.object({
  routineId: z.string().uuid(),
  shadow: z.boolean().default(false),
});
export type UnpinRoutineRuleSnapshotInput = z.input<typeof unpinRoutineRuleSnapshotInputSchema>;

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
    shadowRuleSnapshotId: row.shadowRuleSnapshotId,
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

/** The stored schedule's preset fields, without its source. */
function scheduleOf(config: ScheduleConfig): ScheduleConfig {
  return {
    preset: config.preset,
    at: config.at,
    weekday: config.weekday,
    timezone: config.timezone,
  };
}

export async function createRoutine(
  db: DbExecutor,
  input: { orgId: string; actorId: string; routine: CreateRoutineInput; now?: Date },
): Promise<RoutineView> {
  const routine = createRoutineInputSchema.parse(input.routine);
  if (routine.enabled) await assertChartOfAccountsApplied(db, input.orgId);

  const now = input.now ?? new Date();
  const trigger =
    routine.triggerKind === "schedule"
      ? {
          triggerConfig: { ...scheduleOf(routine.schedule), source: routine.source },
          nextRunAt: routine.enabled ? computeNextRunAt(routine.schedule, now) : null,
        }
      : { triggerConfig: { ...defaultHmacWebhookConfig() }, nextRunAt: null };

  const [created] = await db
    .insert(routines)
    .values({
      organizationId: input.orgId,
      name: routine.name,
      enabled: routine.enabled,
      triggerKind: routine.triggerKind,
      triggerConfig: trigger.triggerConfig,
      nextRunAt: trigger.nextRunAt,
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
  input: { orgId: string; actorId: string; update: UpdateRoutineInput; now?: Date },
): Promise<RoutineView> {
  const update = updateRoutineInputSchema.parse(input.update);
  const current = await lockRoutine(db, input.orgId, update.routineId);
  const now = input.now ?? new Date();

  const set: Partial<typeof routines.$inferInsert> = {};
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  if (update.name !== undefined && update.name !== current.name) {
    set.name = update.name;
    changes.name = { old: current.name, new: update.name };
  }
  if (update.schedule !== undefined || update.source !== undefined) {
    if (current.triggerKind !== "schedule") {
      throw new Error("Only a schedule routine has a schedule.");
    }
    const existing = parseScheduleTriggerConfig(current.triggerConfig);
    const schedule = update.schedule ?? (existing ? scheduleOf(existing) : null);
    const source = update.source ?? existing?.source;
    if (!schedule || !source) {
      throw new Error("Provide the full schedule and source for this routine.");
    }
    const triggerConfig = { ...schedule, source };
    set.triggerConfig = triggerConfig;
    // Setting a schedule computes its next slot; a corrected config also
    // clears the error that stopped an invalid one from firing.
    set.nextRunAt = current.enabled ? computeNextRunAt(schedule, now) : null;
    set.lastError = null;
    changes.triggerConfig = {
      old: current.triggerConfig,
      new: toSerializableRecord(triggerConfig),
    };
  }
  if (Object.keys(set).length === 0) return toRoutineView(current);

  const [updated] = await db
    .update(routines)
    .set({ ...set, updatedAt: now })
    .where(and(eq(routines.organizationId, input.orgId), eq(routines.id, current.id)))
    .returning();
  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "routine",
      entityId: current.id,
      action: "routine_updated",
      actorId: input.actorId,
      changes,
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
  input: { orgId: string; actorId: string; routineId: string; enabled: boolean; now?: Date },
): Promise<RoutineView> {
  const current = await lockRoutine(db, input.orgId, input.routineId);
  if (current.enabled === input.enabled) return toRoutineView(current);
  if (input.enabled) await assertChartOfAccountsApplied(db, input.orgId);

  const now = input.now ?? new Date();
  let nextRunAt: Date | null | undefined;
  if (current.triggerKind === "schedule") {
    if (input.enabled) {
      // Re-enabling starts from the next future slot — never a catch-up
      // burst for the slots missed while the routine was off.
      const config = parseScheduleTriggerConfig(current.triggerConfig);
      if (!config) throw new Error("Fix this routine's schedule before enabling it.");
      nextRunAt = computeNextRunAt(config, now);
    } else {
      nextRunAt = null;
    }
  }

  const [updated] = await db
    .update(routines)
    .set({
      enabled: input.enabled,
      ...(nextRunAt !== undefined ? { nextRunAt } : {}),
      updatedAt: now,
    })
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
 * Pin, unpin, or shadow a rule snapshot on a routine (spec §6).
 *
 * `slot: "active"` sets the rules the routine's papers are evaluated against
 * (null = live configs); `slot: "shadow"` sets a snapshot that is evaluated
 * alongside and only logged. The snapshot must be one of this organization's —
 * an explicit predicate on top of RLS, with the same "not found" for another
 * organization's snapshot as for a missing one. Pinning the snapshot the
 * routine was shadowing promotes it: the shadow is cleared in the same write.
 */
export async function setRoutineRuleSnapshot(
  db: DbExecutor,
  input: {
    orgId: string;
    actorId: string;
    routineId: string;
    slot: "active" | "shadow";
    snapshotId: string | null;
    now?: Date;
  },
): Promise<RoutineView> {
  const current = await lockRoutine(db, input.orgId, input.routineId);
  if (input.snapshotId) {
    const [snapshot] = await db
      .select({ id: ruleSnapshots.id })
      .from(ruleSnapshots)
      .where(
        and(eq(ruleSnapshots.organizationId, input.orgId), eq(ruleSnapshots.id, input.snapshotId)),
      )
      .limit(1);
    if (!snapshot) throw new Error("Rule snapshot not found.");
  }

  const set: Partial<typeof routines.$inferInsert> = {};
  const changes: Record<string, { old: unknown; new: unknown }> = {};
  if (input.slot === "active") {
    if (current.ruleSnapshotId === input.snapshotId) return toRoutineView(current);
    set.ruleSnapshotId = input.snapshotId;
    changes.ruleSnapshotId = { old: current.ruleSnapshotId, new: input.snapshotId };
    if (input.snapshotId && current.shadowRuleSnapshotId === input.snapshotId) {
      set.shadowRuleSnapshotId = null;
      changes.shadowRuleSnapshotId = { old: current.shadowRuleSnapshotId, new: null };
    }
  } else {
    if (current.shadowRuleSnapshotId === input.snapshotId) return toRoutineView(current);
    if (input.snapshotId && input.snapshotId === current.ruleSnapshotId) {
      throw new Error(
        "This snapshot already evaluates this routine's papers; shadowing it would compare it with itself.",
      );
    }
    set.shadowRuleSnapshotId = input.snapshotId;
    changes.shadowRuleSnapshotId = { old: current.shadowRuleSnapshotId, new: input.snapshotId };
  }

  const [updated] = await db
    .update(routines)
    .set({ ...set, updatedAt: input.now ?? new Date() })
    .where(and(eq(routines.organizationId, input.orgId), eq(routines.id, current.id)))
    .returning();
  const action =
    input.slot === "active"
      ? input.snapshotId
        ? "routine_rules_pinned"
        : "routine_rules_unpinned"
      : input.snapshotId
        ? "routine_rules_shadow_set"
        : "routine_rules_shadow_cleared";
  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "routine",
      entityId: current.id,
      action,
      actorId: input.actorId,
      changes,
    },
    db,
  );
  return toRoutineView(updated);
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
