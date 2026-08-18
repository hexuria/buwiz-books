/** Received 2307 capture — Stage 3a route glue. */
import { createServerFn } from "@tanstack/react-start";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { taxCertificates } from "../../db/schema/tax-certificates";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { validateReceived2307 } from "../../lib/tax/certificate-2307";

export const listReceived2307s = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    return db
      .select({
        id: taxCertificates.id,
        payorTin: taxCertificates.payorTin,
        payorRegisteredName: taxCertificates.payorRegisteredName,
        certificateNumber: taxCertificates.certificateNumber,
        periodStart: taxCertificates.periodStart,
        periodEnd: taxCertificates.periodEnd,
        atc: taxCertificates.atc,
        incomePayment: taxCertificates.incomePayment,
        taxWithheld: taxCertificates.taxWithheld,
        certificateStatus: taxCertificates.certificateStatus,
      })
      .from(taxCertificates)
      .where(eq(taxCertificates.organizationId, orgId))
      .orderBy(desc(taxCertificates.createdAt));
  });
});

const captureSchema = z.object({
  payorTin: z.string().min(9),
  payorRegisteredName: z.string().min(1),
  certificateNumber: z.string().optional(),
  periodStart: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
  periodEnd: z.string().regex(/^\\d{4}-\\d{2}-\\d{2}$/),
  atc: z.string().min(3),
  incomePayment: z.string().min(1),
  taxWithheld: z.string().min(1),
});

export const captureReceived2307 = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "create",
      { routeKey: "tax:2307-capture", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const input = captureSchema.parse(rawData);
        const { normalized, warnings } = validateReceived2307(input);
        const [row] = await db
          .insert(taxCertificates)
          .values({
            organizationId: orgId,
            certificateType: "received_2307",
            payorTin: normalized.payorTin,
            payorRegisteredName: normalized.payorRegisteredName,
            certificateNumber: normalized.certificateNumber || null,
            periodStart: normalized.periodStart,
            periodEnd: normalized.periodEnd,
            atc: normalized.atc,
            incomePayment: normalized.incomePayment,
            taxWithheld: normalized.taxWithheld,
            certificateStatus: "received",
            createdBy: userId,
          })
          .returning({ id: taxCertificates.id });
        if (!row) throw new Error("Could not capture certificate");
        return { id: row.id, warnings };
      },
    );
  },
);
