/**
 * Routine trigger configuration (Inbox v2 spec §3).
 *
 * `routines.trigger_config` is jsonb, so its shape is enforced here rather than
 * by the database. Two webhook shapes exist:
 *
 *   - the system-provisioned inbound email routine, authenticated upstream by
 *     Resend's Svix signature: `{ provider: "resend", auth: "svix" }`;
 *   - generic webhook routines, authenticated per routine with HMAC-SHA256:
 *     `{ provider: "buwiz", auth: "hmac_sha256", secret_ref, tolerance_s, max_bytes }`.
 *
 * `secret_ref` names a `routine_secrets` row. The secret itself is never part
 * of the config, so no routine read (and no future export) can carry it.
 *
 * Schedule routines store a preset plus the schedule source they run:
 * `{ preset, at?, weekday?, timezone, source }` (see ./schedule.ts and
 * ./schedule-sources.ts).
 */
import { z } from "zod";
import { refineSchedule, scheduleShape } from "./schedule";

export const INBOUND_EMAIL_PROVIDER = "resend";
export const INBOUND_EMAIL_ROUTINE_NAME = "Inbound email";
export const HMAC_WEBHOOK_PROVIDER = "buwiz";

/** Hard ceilings. A routine's own config may only tighten them. */
export const WEBHOOK_TOLERANCE_SECONDS = 300;
export const WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;

export const ROUTINE_WEBHOOK_JOB_TYPE = "routine_webhook";
export const ROUTINE_SCHEDULE_RUN_JOB_TYPE = "routine_schedule_run";

/** `integration_sources.provider` for the per-routine webhook source. */
export const ROUTINE_WEBHOOK_SOURCE_PROVIDER = "routine_webhook";

export const ROUTINE_NAME_MAX_LENGTH = 255;

export interface InboundEmailTriggerConfig {
  provider: typeof INBOUND_EMAIL_PROVIDER;
  auth: "svix";
}

const hmacWebhookConfigSchema = z.object({
  provider: z.literal(HMAC_WEBHOOK_PROVIDER),
  auth: z.literal("hmac_sha256"),
  secret_ref: z.string().uuid().nullable(),
  tolerance_s: z.number().int().positive(),
  max_bytes: z.number().int().positive(),
});

export type HmacWebhookTriggerConfig = z.infer<typeof hmacWebhookConfigSchema>;

export function inboundEmailTriggerConfig(): InboundEmailTriggerConfig {
  return { provider: INBOUND_EMAIL_PROVIDER, auth: "svix" };
}

export function defaultHmacWebhookConfig(): HmacWebhookTriggerConfig {
  return {
    provider: HMAC_WEBHOOK_PROVIDER,
    auth: "hmac_sha256",
    secret_ref: null,
    tolerance_s: WEBHOOK_TOLERANCE_SECONDS,
    max_bytes: WEBHOOK_MAX_BODY_BYTES,
  };
}

/** The HMAC webhook config, or null when the routine is not an HMAC webhook. */
export function parseHmacWebhookConfig(config: unknown): HmacWebhookTriggerConfig | null {
  const parsed = hmacWebhookConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}

export function isInboundEmailRoutine(routine: {
  triggerKind: string;
  triggerConfig: Record<string, unknown>;
}): boolean {
  return (
    routine.triggerKind === "webhook" && routine.triggerConfig.provider === INBOUND_EMAIL_PROVIDER
  );
}

/**
 * `ingestion_events.provider` for a generic webhook delivery.
 *
 * Routine-scoped on purpose. The older unique index on
 * (organization_id, provider, provider_event_id) still covers every row, so a
 * shared provider string would make event ids collide ACROSS routines — two
 * senders that both number their events 1, 2, 3 would have the second one's
 * events suppressed as duplicates. Namespacing the provider by routine keeps
 * that index and `ingestion_events_org_routine_event_unique` in agreement.
 */
export function routineWebhookEventProvider(routineId: string): string {
  return `routine:${routineId}`;
}

const scheduleTriggerConfigSchema = scheduleShape
  .extend({ source: z.string().min(1).max(64) })
  .superRefine(refineSchedule);

export type ScheduleTriggerConfig = z.output<typeof scheduleTriggerConfigSchema>;

/** The schedule config, or null when it is not a valid schedule config. */
export function parseScheduleTriggerConfig(config: unknown): ScheduleTriggerConfig | null {
  const parsed = scheduleTriggerConfigSchema.safeParse(config);
  return parsed.success ? parsed.data : null;
}
