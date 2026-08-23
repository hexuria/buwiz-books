// ============================================================================
// PH tax module state + organization country (audit D6).
//
// The country switch is the ONLY write here, and it is deliberately tiny:
// it upserts organization_accounting_settings.country and writes an activity
// row. It never touches a PH record — archiving is a DERIVED state, so
// switching back to PH restores the module losslessly.
// ============================================================================
import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { eq } from "drizzle-orm";
import { organizationAccountingSettings } from "../../db/schema/inbox";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import {
  phTaxModuleStatus,
  switchOrganizationCountry,
  type PhTaxModuleStatus,
} from "../../lib/tax/module-state";

export const getTaxModuleState = createServerFn({ method: "GET" }).handler(
  async (): Promise<PhTaxModuleStatus> => {
    return withSessionOrgContext(async ({ orgId, db }) => phTaxModuleStatus(db, orgId));
  },
);

const updateCountrySchema = z.object({
  /** ISO 3166-1 alpha-2, uppercase; null clears the setting. */
  country: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2}$/, "Country must be a two-letter ISO code")
    .nullable(),
});

export const updateOrganizationCountry = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "organization",
      "update",
      { routeKey: "org-settings:update-country", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const { country } = updateCountrySchema.parse(rawData);
        const result = await switchOrganizationCountry(db, { orgId, userId, country });
        return { success: true as const, changed: result.changed, status: result.after };
      },
    );
  },
);

/**
 * Base currency for the settings UI's PHP warning — the country switch UI
 * warns (does not block) when activating PH with a non-PHP book currency.
 */
export const getAccountingCurrency = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    const [row] = await db
      .select({ baseCurrency: organizationAccountingSettings.baseCurrency })
      .from(organizationAccountingSettings)
      .where(eq(organizationAccountingSettings.organizationId, orgId))
      .limit(1);
    return { baseCurrency: row?.baseCurrency ?? "USD" };
  });
});
