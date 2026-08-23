/** Saved working returns for Stages 6 and 7. Computation only — no posting. */
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { taxComputedReturns } from "../../db/schema/tax-stage-remainder";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
// D6 country gate: every PH tax/payroll WRITE refuses unless the module is active.
import { assertPhTaxWritable } from "../../lib/tax/module-state";
import { isPlaceholderTin } from "../../lib/tax/alphalist-preflight";
import { asJsonPayload } from "../../lib/tax/json-payload";
import { buildPercentageTaxReturn } from "../../lib/tax/percentage-tax";
import { buildSlspSection, buildVatReturn } from "../../lib/tax/vat";

export const listComputedReturns = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    const rows = await db
      .select({
        id: taxComputedReturns.id,
        formCode: taxComputedReturns.formCode,
        periodStart: taxComputedReturns.periodStart,
        periodEnd: taxComputedReturns.periodEnd,
        blockingIssueCount: taxComputedReturns.blockingIssueCount,
        payload: taxComputedReturns.payload,
      })
      .from(taxComputedReturns)
      .where(eq(taxComputedReturns.organizationId, orgId))
      .orderBy(desc(taxComputedReturns.createdAt));
    return rows.map((row) => ({ ...row, payload: JSON.stringify(row.payload) }));
  });
});

const vatSchema = z.object({
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  year: z.number().int().min(2000).max(2100),
  outputVat: z.string().min(1),
  creditableInputVat: z.string().default("0"),
  uncollectedDeduction: z.string().optional(),
});

export const saveVatReturn = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:save-2550q", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const input = vatSchema.parse(rawData);
        const ret = buildVatReturn(input);
        const payload = asJsonPayload(ret);
        const [row] = await db
          .insert(taxComputedReturns)
          .values({
            organizationId: orgId,
            formCode: "2550Q",
            periodStart: ret.periodStart,
            periodEnd: ret.periodEnd,
            payload,
            blockingIssueCount: ret.blockingIssues.length,
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [
              taxComputedReturns.organizationId,
              taxComputedReturns.formCode,
              taxComputedReturns.periodStart,
              taxComputedReturns.periodEnd,
            ],
            set: {
              payload: asJsonPayload(ret),
              blockingIssueCount: ret.blockingIssues.length,
              updatedAt: new Date(),
            },
          })
          .returning({ id: taxComputedReturns.id });
        if (!row) throw new Error("Could not save 2550Q");
        return { id: row.id, ret };
      },
    );
  },
);

const pctSchema = z.object({
  quarter: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]),
  year: z.number().int().min(2000).max(2100),
  grossReceipts: z.string().min(1),
  electedEightPercent: z.boolean().default(false),
});

export const savePercentageTaxReturn = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:save-2551q", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const input = pctSchema.parse(rawData);
        const ret = buildPercentageTaxReturn(input);
        const [row] = await db
          .insert(taxComputedReturns)
          .values({
            organizationId: orgId,
            formCode: "2551Q",
            periodStart: ret.periodStart,
            periodEnd: ret.periodEnd,
            payload: asJsonPayload(ret),
            blockingIssueCount: ret.blockingIssues.length,
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [
              taxComputedReturns.organizationId,
              taxComputedReturns.formCode,
              taxComputedReturns.periodStart,
              taxComputedReturns.periodEnd,
            ],
            set: {
              payload: asJsonPayload(ret),
              blockingIssueCount: ret.blockingIssues.length,
              updatedAt: new Date(),
            },
          })
          .returning({ id: taxComputedReturns.id });
        if (!row) throw new Error("Could not save 2551Q");
        return { id: row.id, ret };
      },
    );
  },
);

const slspSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  entries: z
    .array(
      z.object({
        tin: z.string().min(9),
        registeredName: z.string().min(1),
        netAmount: z.string().min(1),
        vatAmount: z.string().min(1),
        treatment: z.enum(["vatable", "zero_rated", "exempt"]),
      }),
    )
    .min(1),
});

export const saveSlspReturn = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:save-slsp", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const input = slspSchema.parse(rawData);
        for (const entry of input.entries) {
          if (isPlaceholderTin(entry.tin)) {
            throw new Error(
              `TIN ${entry.tin} is a placeholder; dummy TINs are banned on the SLSP.`,
            );
          }
        }
        const section = buildSlspSection(input.entries);
        const payload = asJsonPayload({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          totalNet: section.totalNet,
          totalVat: section.totalVat,
          totalExempt: section.totalExempt,
          totalZeroRated: section.totalZeroRated,
          lineCount: String(section.lines.length),
        });
        const [row] = await db
          .insert(taxComputedReturns)
          .values({
            organizationId: orgId,
            formCode: "SLSP",
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            payload,
            blockingIssueCount: 0,
            createdBy: userId,
          })
          .onConflictDoUpdate({
            target: [
              taxComputedReturns.organizationId,
              taxComputedReturns.formCode,
              taxComputedReturns.periodStart,
              taxComputedReturns.periodEnd,
            ],
            set: {
              payload,
              updatedAt: new Date(),
            },
          })
          .returning({ id: taxComputedReturns.id });
        if (!row) throw new Error("Could not save SLSP");
        return { id: row.id, section };
      },
    );
  },
);
