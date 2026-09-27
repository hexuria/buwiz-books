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
