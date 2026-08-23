/** Org-level tax identity beyond the employer TIN captured on /payroll. */
import { createServerFn } from "@tanstack/react-start";
import { taxReferenceDatasets } from "../../db/schema/tax-reference";
import { buildStalenessReport } from "../../lib/tax/reference-data-staleness";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { orgTaxBranches, orgTaxProfiles } from "../../db/schema/tax-reference";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
// D6 country gate: every PH tax/payroll WRITE refuses unless the module is active.
import { assertPhTaxWritable } from "../../lib/tax/module-state";
import { filingDeadlineOverrides, orgTaxYearElections } from "../../db/schema/tax-stage-remainder";

export const getTaxSettings = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    const [profile] = await db
      .select({
        tin: orgTaxProfiles.tin,
        branchCode: orgTaxProfiles.branchCode,
        rdoCode: orgTaxProfiles.rdoCode,
        registeredName: orgTaxProfiles.registeredName,
        taxpayerClassification: orgTaxProfiles.taxpayerClassification,
        efpsEnrolled: orgTaxProfiles.efpsEnrolled,
        efpsIndustryGroup: orgTaxProfiles.efpsIndustryGroup,
        fiscalYearEndMonth: orgTaxProfiles.fiscalYearEndMonth,
        isNga: orgTaxProfiles.isNga,
      })
      .from(orgTaxProfiles)
      .where(eq(orgTaxProfiles.organizationId, orgId))
      .limit(1);
    const branches = await db
      .select({
        id: orgTaxBranches.id,
        branchCode: orgTaxBranches.branchCode,
        name: orgTaxBranches.name,
        rdoCode: orgTaxBranches.rdoCode,
        isWithholdingAgent: orgTaxBranches.isWithholdingAgent,
      })
      .from(orgTaxBranches)
      .where(eq(orgTaxBranches.organizationId, orgId));
    const elections = await db
      .select({
        taxableYear: orgTaxYearElections.taxableYear,
        regime: orgTaxYearElections.regime,
        hasCompensationIncome: orgTaxYearElections.hasCompensationIncome,
        irrevocable: orgTaxYearElections.irrevocable,
      })
      .from(orgTaxYearElections)
      .where(eq(orgTaxYearElections.organizationId, orgId));
    return {
      profile: profile ?? {
        tin: null,
        branchCode: "00000",
        rdoCode: null,
        registeredName: null,
        taxpayerClassification: null,
        efpsEnrolled: false,
        efpsIndustryGroup: null,
        fiscalYearEndMonth: 12,
        isNga: false,
      },
      branches,
      elections,
    };
  });
});

const settingsSchema = z.object({
  tin: z
    .string()
    .regex(/^\d{9}$/)
    .optional(),
  registeredName: z.string().min(1).optional(),
  branchCode: z
    .string()
    .regex(/^\d{5}$/)
    .default("00000"),
  rdoCode: z.string().min(1).optional(),
  taxpayerClassification: z.enum(["micro", "small", "medium", "large"]).optional(),
  efpsEnrolled: z.boolean(),
  efpsIndustryGroup: z.enum(["A", "B", "C", "D", "E"]).optional().nullable(),
  fiscalYearEndMonth: z.number().int().min(1).max(12),
  isNga: z.boolean().default(false),
});

export const upsertTaxSettings = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:settings", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const input = settingsSchema.parse(rawData);
        await db
          .insert(orgTaxProfiles)
          .values({
            organizationId: orgId,
            tin: input.tin ?? null,
            registeredName: input.registeredName ?? null,
            branchCode: input.branchCode,
            rdoCode: input.rdoCode ?? null,
            taxpayerClassification: input.taxpayerClassification ?? null,
            efpsEnrolled: input.efpsEnrolled,
            efpsIndustryGroup: input.efpsIndustryGroup ?? null,
            fiscalYearEndMonth: input.fiscalYearEndMonth,
            isNga: input.isNga,
          })
          .onConflictDoUpdate({
            target: orgTaxProfiles.organizationId,
            set: {
              tin: input.tin ?? null,
              registeredName: input.registeredName ?? null,
              branchCode: input.branchCode,
              rdoCode: input.rdoCode ?? null,
              taxpayerClassification: input.taxpayerClassification ?? null,
              efpsEnrolled: input.efpsEnrolled,
              efpsIndustryGroup: input.efpsIndustryGroup ?? null,
              fiscalYearEndMonth: input.fiscalYearEndMonth,
              isNga: input.isNga,
              updatedAt: new Date(),
            },
          });
        return input;
      },
    );
  },
);

const branchSchema = z.object({
  branchCode: z.string().regex(/^\d{5}$/),
  name: z.string().min(1),
  rdoCode: z.string().min(1).optional(),
  isWithholdingAgent: z.boolean().default(false),
});

export const upsertTaxBranch = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:branch", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const input = branchSchema.parse(rawData);
        const [row] = await db
          .insert(orgTaxBranches)
          .values({
            organizationId: orgId,
            branchCode: input.branchCode,
            name: input.name,
            rdoCode: input.rdoCode ?? null,
            isWithholdingAgent: input.isWithholdingAgent,
          })
          .onConflictDoUpdate({
            target: [orgTaxBranches.organizationId, orgTaxBranches.branchCode],
            set: {
              name: input.name,
              rdoCode: input.rdoCode ?? null,
              isWithholdingAgent: input.isWithholdingAgent,
              updatedAt: new Date(),
            },
          })
          .returning({ id: orgTaxBranches.id, branchCode: orgTaxBranches.branchCode });
        if (!row) throw new Error("Could not save branch");
        return row;
      },
    );
  },
);

const electionSchema = z.object({
  taxableYear: z.number().int().min(2000).max(2100),
  regime: z.enum(["vat", "percentage_tax", "eight_percent"]),
  hasCompensationIncome: z.boolean().default(false),
  electedViaForm: z.string().optional(),
  taxpayerKind: z.enum(["individual", "corporation"]).default("individual"),
});

export const upsertTaxYearElection = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:year-election", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const input = electionSchema.parse(rawData);
        if (input.regime === "eight_percent" && input.taxpayerKind === "corporation") {
          throw new Error(
            "The 8% option is available only to self-employed individuals and professionals, not to corporations.",
          );
        }
        const [existing] = await db
          .select({
            id: orgTaxYearElections.id,
            regime: orgTaxYearElections.regime,
            irrevocable: orgTaxYearElections.irrevocable,
          })
          .from(orgTaxYearElections)
          .where(
            and(
              eq(orgTaxYearElections.organizationId, orgId),
              eq(orgTaxYearElections.taxableYear, input.taxableYear),
            ),
          )
          .limit(1);
        if (existing?.irrevocable && existing.regime !== input.regime) {
          throw new Error(
            `The ${existing.regime} election for ${input.taxableYear} is irrevocable. A later form cannot replace it.`,
          );
        }
        const [row] = await db
          .insert(orgTaxYearElections)
          .values({
            organizationId: orgId,
            taxableYear: input.taxableYear,
            regime: input.regime,
            hasCompensationIncome: input.hasCompensationIncome,
            electedViaForm: input.electedViaForm ?? null,
            irrevocable: true,
          })
          .onConflictDoUpdate({
            target: [orgTaxYearElections.organizationId, orgTaxYearElections.taxableYear],
            set: {
              regime: input.regime,
              hasCompensationIncome: input.hasCompensationIncome,
              electedViaForm: input.electedViaForm ?? null,
              updatedAt: new Date(),
            },
          })
          .returning({ id: orgTaxYearElections.id, taxableYear: orgTaxYearElections.taxableYear });
        if (!row) throw new Error("Could not save year election");
        return row;
      },
    );
  },
);

export const listDeadlineOverrides = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ db }) => {
    return db
      .select({
        formCode: filingDeadlineOverrides.formCode,
        periodStart: filingDeadlineOverrides.periodStart,
        periodEnd: filingDeadlineOverrides.periodEnd,
        dueDate: filingDeadlineOverrides.dueDate,
        citation: filingDeadlineOverrides.citation,
      })
      .from(filingDeadlineOverrides);
  });
});

/**
 * Read-only staleness report over the global tax reference datasets, for the
 * /tax/settings surface. The sweep job logs the same assessment on a
 * schedule; this makes it visible to the person about to file.
 */
export const getTaxReferenceStaleness = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ db }) => {
    const datasets = await db.select().from(taxReferenceDatasets);
    return buildStalenessReport(
      datasets.map((dataset) => ({
        datasetKey: dataset.version,
        lastVerifiedAt: dataset.lastVerifiedAt ? dataset.lastVerifiedAt.toISOString() : null,
        ownerName: null,
        asOf: new Date().toISOString(),
      })),
    );
  });
});
