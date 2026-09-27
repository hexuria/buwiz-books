// ============================================================================
// The organization's Jev-approval settings (organization_ai_settings, 0060).
//
// Read fresh inside the caller's transaction, never through the AI settings
// read cache: these decide whether a system actor may post, so a switch an
// admin just turned off must hold the very next paper. The approval job reads
// them with a share lock, so the switch cannot flip mid-approval.
// ============================================================================

import { eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { organizationAiSettings } from "@/db/schema/ai";
import { aiConfigEntityId } from "@/lib/ai/org-ai-config";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { DEFAULT_SPOT_CHECK_RATE, normalizeSpotCheckRate } from "./spot-check";

export interface JevApprovalSettings {
  /** The organization's Jev-approval switch. Off when no settings row exists. */
  autoApproveEnabled: boolean;
  /** Admin opt-in to Jev approval while maker-checker is required. */
  makerCheckerOptIn: boolean;
  spotCheckRate: number;
  /** The row's random salt; the organization id when no row exists yet. */
  spotCheckSalt: string;
  /** The organization-wide AI kill switch: nothing AI runs while it is on. */
  aiKillSwitch: boolean;
}

export async function loadJevApprovalSettings(
  db: DbExecutor,
  orgId: string,
  options: { lock?: "share" } = {},
): Promise<JevApprovalSettings> {
  const query = db
    .select({
      autoApproveEnabled: organizationAiSettings.inboxAutoapproveEnabled,
      makerCheckerOptIn: organizationAiSettings.inboxAutoapproveWithMakerChecker,
      spotCheckRate: organizationAiSettings.inboxSpotCheckRate,
      spotCheckSalt: organizationAiSettings.inboxSpotCheckSalt,
      aiKillSwitch: organizationAiSettings.killSwitch,
    })
    .from(organizationAiSettings)
    .where(eq(organizationAiSettings.organizationId, orgId))
    .limit(1);
  const [row] = options.lock ? await query.for(options.lock) : await query;
  if (!row) {
    return {
      autoApproveEnabled: false,
      makerCheckerOptIn: false,
      spotCheckRate: DEFAULT_SPOT_CHECK_RATE,
      spotCheckSalt: orgId,
      aiKillSwitch: false,
    };
  }
  return {
    autoApproveEnabled: row.autoApproveEnabled,
    makerCheckerOptIn: row.makerCheckerOptIn,
    spotCheckRate: normalizeSpotCheckRate(row.spotCheckRate),
    spotCheckSalt: row.spotCheckSalt,
    aiKillSwitch: row.aiKillSwitch,
  };
}

/** Four decimals between 0 and 1, the column's shape. */
const RATE_SHAPE = /^(?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?)$/;

/**
 * Change the organization's Jev-approval settings (admin-only; the server
 * function checks the role). Only the fields given change; the diff lands in
 * activity_logs like every other AI settings change.
 */
export async function updateJevApprovalSettings(
  db: DbExecutor,
  input: {
    orgId: string;
    actorId: string;
    autoApproveEnabled?: boolean;
    makerCheckerOptIn?: boolean;
    spotCheckRate?: string;
  },
): Promise<JevApprovalSettings> {
  const patch: Partial<typeof organizationAiSettings.$inferInsert> = {};
  if (input.autoApproveEnabled !== undefined) {
    patch.inboxAutoapproveEnabled = input.autoApproveEnabled;
  }
  if (input.makerCheckerOptIn !== undefined) {
    patch.inboxAutoapproveWithMakerChecker = input.makerCheckerOptIn;
  }
  if (input.spotCheckRate !== undefined) {
    const rate = input.spotCheckRate.trim();
    if (!RATE_SHAPE.test(rate)) {
      throw new Error("The spot-check rate must be between 0 and 1, to four decimal places.");
    }
    patch.inboxSpotCheckRate = rate;
  }
  if (Object.keys(patch).length === 0) throw new Error("No Jev approval settings supplied.");

  const before = await loadJevApprovalSettings(db, input.orgId);
  const now = new Date();
  await db
    .insert(organizationAiSettings)
    .values({ organizationId: input.orgId, ...patch, updatedBy: input.actorId, updatedAt: now })
    .onConflictDoUpdate({
      target: organizationAiSettings.organizationId,
      set: { ...patch, updatedBy: input.actorId, updatedAt: now },
    });
  const after = await loadJevApprovalSettings(db, input.orgId);

  const changes: Record<string, { old: unknown; new: unknown }> = {};
  for (const key of ["autoApproveEnabled", "makerCheckerOptIn", "spotCheckRate"] as const) {
    if (before[key] !== after[key]) changes[key] = { old: before[key], new: after[key] };
  }
  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "ai_settings",
      entityId: aiConfigEntityId(input.orgId),
      action: "jev_approval_settings_updated",
      actorId: input.actorId,
      changes,
    },
    db,
  );
  return after;
}
