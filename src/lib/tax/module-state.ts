// ============================================================================
// PH tax module gate (audit D6).
//
// One org has ONE active tax jurisdiction; the Philippine module derives a
// three-way state instead of a boolean so that switching country never
// destroys or hides history:
//
//   active   — organization country is "PH": full read/write.
//   archived — country is NOT "PH" but PH records exist: read-only. Every
//              mutation refuses; reads and exports keep working so history
//              stays auditable and exportable.
//   off      — country is not "PH" and no PH records exist: module hidden.
//
// There is deliberately NO delete path here. Switching back to "PH" restores
// the module exactly as it was (lossless), and the switch itself is written
// to the activity log by the settings mutation.
// ============================================================================
import { createHash } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { insertActivityLog } from "../insert-activity-log";
import type { DbExecutor } from "../../db";
import { organizationAccountingSettings } from "../../db/schema/inbox";
import { payrollRuns } from "../../db/schema/payroll";
import { taxCertificates } from "../../db/schema/tax-certificates";
import { orgTaxProfiles } from "../../db/schema/tax-reference";
import { taxComputedReturns, taxWithholdingPayments } from "../../db/schema/tax-stage-remainder";

import type { PhTaxModuleState, PhTaxModuleStatus, PhTaxRecordCounts } from "./module-state-types";

export type { PhTaxModuleState, PhTaxModuleStatus, PhTaxRecordCounts } from "./module-state-types";

export const PH_COUNTRY_CODE = "PH";

/** Pure derivation — the whole gate policy in one testable function. */
export function derivePhTaxModuleState(input: {
  country: string | null;
  totalRecords: number;
}): PhTaxModuleState {
  if (input.country === PH_COUNTRY_CODE) return "active";
  return input.totalRecords > 0 ? "archived" : "off";
}

export async function phTaxModuleStatus(db: DbExecutor, orgId: string): Promise<PhTaxModuleStatus> {
  const [settingsRow] = await db
    .select({ country: organizationAccountingSettings.country })
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);

  const countOf = async (table: any, orgColumn: any): Promise<number> => {
    const [row] = await db.select({ n: count() }).from(table).where(eq(orgColumn, orgId));
    return Number(row?.n ?? 0);
  };

  const [runs, certificates, returns, remittances, profiles] = await Promise.all([
    countOf(payrollRuns, payrollRuns.organizationId),
    countOf(taxCertificates, taxCertificates.organizationId),
    countOf(taxComputedReturns, taxComputedReturns.organizationId),
    countOf(taxWithholdingPayments, taxWithholdingPayments.organizationId),
    countOf(orgTaxProfiles, orgTaxProfiles.organizationId),
  ]);

  const records: PhTaxRecordCounts = {
    payrollRuns: runs,
    taxCertificates: certificates,
    computedReturns: returns,
    withholdingRemittances: remittances,
    taxProfiles: profiles,
  };
  const totalRecords = runs + certificates + returns + remittances + profiles;
  const country = settingsRow?.country ?? null;

  return {
    state: derivePhTaxModuleState({ country, totalRecords }),
    country,
    records,
    totalRecords,
  };
}

export class PhTaxModuleInactiveError extends Error {
  readonly state: PhTaxModuleState;
  constructor(state: PhTaxModuleState) {
    super(
      state === "archived"
        ? "The Philippine tax module is archived (organization country is no longer PH). Records stay readable and exportable, but writes are disabled — set the organization country back to Philippines to resume."
        : "The Philippine tax module is not enabled. Set the organization country to Philippines in settings to use payroll and tax filing.",
    );
    this.name = "PhTaxModuleInactiveError";
    this.state = state;
  }
}

/**
 * Mutation gate: every payroll/tax WRITE calls this first. Reads and exports
 * deliberately do not — archived history must stay visible and exportable.
 */
export async function assertPhTaxWritable(db: DbExecutor, orgId: string): Promise<void> {
  const status = await phTaxModuleStatus(db, orgId);
  if (status.state !== "active") {
    throw new PhTaxModuleInactiveError(status.state);
  }
}

// activity_logs.entity_id is a uuid column while org ids are Better-Auth
// text ids — same problem the AI settings log solved with a deterministic
// v5-style surrogate (org-ai-config.ts aiConfigEntityId). Same technique.
const COUNTRY_SETTINGS_UUID_NAMESPACE = "9c1f7c2e-5a83-4b6f-9a4e-2d94f1f0c3a7";

function uuidV5(name: string, namespaceUuid: string): string {
  const ns = Buffer.from(namespaceUuid.replace(/-/g, ""), "hex");
  const digest = createHash("sha1").update(ns).update(Buffer.from(name, "utf8")).digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

/** Stable surrogate entity id for an org's country/settings log rows. */
export function countrySettingsEntityId(orgId: string): string {
  return uuidV5(`org-country:${orgId}`, COUNTRY_SETTINGS_UUID_NAMESPACE);
}

export interface SwitchCountryResult {
  changed: boolean;
  before: PhTaxModuleStatus;
  after: PhTaxModuleStatus;
}

/**
 * The ONLY writer of organization country. Upserts the setting and writes an
 * activity row capturing the module-state transition and the record counts
 * as they stood — and touches nothing else. Archiving is derived state;
 * there is no delete path (D6).
 */
export async function switchOrganizationCountry(
  db: DbExecutor,
  input: { orgId: string; userId: string; country: string | null },
): Promise<SwitchCountryResult> {
  const before = await phTaxModuleStatus(db, input.orgId);
  if (before.country === input.country) {
    return { changed: false, before, after: before };
  }

  await db
    .insert(organizationAccountingSettings)
    .values({ organizationId: input.orgId, country: input.country })
    .onConflictDoUpdate({
      target: organizationAccountingSettings.organizationId,
      set: { country: input.country, updatedAt: new Date() },
    });

  const after = await phTaxModuleStatus(db, input.orgId);

  await insertActivityLog(
    {
      orgId: input.orgId,
      entityType: "organization_settings",
      entityId: countrySettingsEntityId(input.orgId),
      action: "organization_country_changed",
      actorId: input.userId,
      changes: {
        country: { old: before.country, new: input.country },
        phTaxModuleState: { old: before.state, new: after.state },
        phRecordCounts: { old: before.records, new: after.records },
      },
    },
    db,
  );

  return { changed: true, before, after };
}
