/** Received 2307 capture, SAWT, and CWT posting — Stage 3a route glue. */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { taxCertificates } from "../../db/schema/tax-certificates";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
// D6 country gate: every PH tax/payroll WRITE refuses unless the module is active.
import { assertPhTaxWritable } from "../../lib/tax/module-state";
import {
  buildSawt,
  certificatesInSawtPeriod,
  validateReceived2307,
} from "../../lib/tax/certificate-2307";
import { MissingPhAccountError } from "../../lib/tax/ph-account-resolver";
import { UnmappedAccountError } from "../../lib/coa/resolve-mapped-account";
import { postCwtReceivable } from "../../lib/tax/post-cwt-receivable";

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
        journalHeaderId: taxCertificates.journalHeaderId,
      })
      .from(taxCertificates)
      .where(
        and(
          eq(taxCertificates.organizationId, orgId),
          eq(taxCertificates.certificateType, "received_2307"),
        ),
      )
      .orderBy(desc(taxCertificates.createdAt));
  });
});

const captureSchema = z.object({
  payorTin: z.string().min(9),
  payorRegisteredName: z.string().min(1),
  certificateNumber: z.string().optional(),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
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
        await assertPhTaxWritable(db, orgId);
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
        let journalHeaderId: string | null = null;
        try {
          const posted = await db.transaction((tx) =>
            postCwtReceivable(tx, {
              organizationId: orgId,
              userId,
              certificateId: row.id,
            }),
          );
          journalHeaderId = posted.journalHeaderId;
        } catch (error) {
          if (error instanceof MissingPhAccountError || error instanceof UnmappedAccountError) {
            warnings.push({
              code: "CWT_NOT_POSTED",
              message: `Certificate captured, but the CWT receivable was not posted: ${error.message}`,
            });
          } else {
            throw error;
          }
        }
        return { id: row.id, warnings, journalHeaderId };
      },
    );
  },
);

const sawtSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const buildReceived2307Sawt = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const input = sawtSchema.parse(rawData);
      const certificates = await db
        .select({
          payorTin: taxCertificates.payorTin,
          payorRegisteredName: taxCertificates.payorRegisteredName,
          atc: taxCertificates.atc,
          incomePayment: taxCertificates.incomePayment,
          taxWithheld: taxCertificates.taxWithheld,
          certificateStatus: taxCertificates.certificateStatus,
          periodStart: taxCertificates.periodStart,
          periodEnd: taxCertificates.periodEnd,
        })
        .from(taxCertificates)
        .where(
          and(
            eq(taxCertificates.organizationId, orgId),
            eq(taxCertificates.certificateType, "received_2307"),
          ),
        );
      const inPeriod = certificatesInSawtPeriod(certificates, input.periodStart, input.periodEnd);
      return buildSawt({
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        certificates: inPeriod,
      });
    });
  },
);

const postCwtSchema = z.object({
  certificateId: z.string().uuid(),
});

export const postReceived2307Cwt = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "create",
      { routeKey: "tax:2307-cwt", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        await assertPhTaxWritable(db, orgId);
        const input = postCwtSchema.parse(rawData);
        return db.transaction((tx) =>
          postCwtReceivable(tx, {
            organizationId: orgId,
            userId,
            certificateId: input.certificateId,
          }),
        );
      },
    );
  },
);
