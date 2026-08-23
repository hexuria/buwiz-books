/** Stage 3b persist: we withheld from a supplier and may owe them a 2307. */
import { createServerFn } from "@tanstack/react-start";
import { and, desc, eq } from "drizzle-orm";
import { z } from "zod";
import { taxCertificates } from "../../db/schema/tax-certificates";
import { orgTaxProfiles } from "../../db/schema/tax-reference";
import { taxComputedReturns, taxWithholdingPayments } from "../../db/schema/tax-stage-remainder";
import { withMutationPermissionOrgContext, withSessionOrgContext } from "../../lib/server-context";
import { isPlaceholderTin } from "../../lib/tax/alphalist-preflight";
import { ATC_EXPECTED_RATE_BPS, normalizeTin } from "../../lib/tax/certificate-2307";
import { assessEwt, buildQap, computeEwt, remittanceObligationsFor } from "../../lib/tax/ewt";
import { form2307PdfBuffer } from "../../lib/tax/form-2307-pdf";
import { issueQapDat } from "../../lib/tax/issue-qap-dat";
import { asJsonPayload } from "../../lib/tax/json-payload";
import { postEwtRemittance } from "../../lib/tax/post-ewt-remittance";

export const listWithholdingPayments = createServerFn({ method: "GET" }).handler(async () => {
  return withSessionOrgContext(async ({ orgId, db }) => {
    return db
      .select({
        id: taxWithholdingPayments.id,
        payeeTin: taxWithholdingPayments.payeeTin,
        payeeRegisteredName: taxWithholdingPayments.payeeRegisteredName,
        periodStart: taxWithholdingPayments.periodStart,
        periodEnd: taxWithholdingPayments.periodEnd,
        atc: taxWithholdingPayments.atc,
        incomePayment: taxWithholdingPayments.incomePayment,
        taxWithheld: taxWithholdingPayments.taxWithheld,
        certificateIssued: taxWithholdingPayments.certificateIssued,
        certificateNumber: taxWithholdingPayments.certificateNumber,
      })
      .from(taxWithholdingPayments)
      .where(eq(taxWithholdingPayments.organizationId, orgId))
      .orderBy(desc(taxWithholdingPayments.createdAt));
  });
});

const captureSchema = z.object({
  payeeTin: z.string().min(9),
  payeeRegisteredName: z.string().min(1),
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  paymentType: z.string().min(1),
  payeeType: z.enum(["individual", "corporate"]),
  isTopWithholdingAgent: z.boolean(),
  hasSwornDeclaration: z.boolean().default(false),
  grossAmount: z.string().min(1),
  vatAmount: z.string().optional(),
  certificateIssued: z.boolean().default(false),
  certificateNumber: z.string().optional(),
});

export const captureWithholdingPayment = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "create",
      { routeKey: "tax:ewt-capture", limit: 30, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const input = captureSchema.parse(rawData);
        const payeeTin = normalizeTin(input.payeeTin);
        if (isPlaceholderTin(payeeTin)) {
          throw new Error("That payee TIN is a placeholder; dummy TINs are banned.");
        }
        const assessment = assessEwt({
          isTopWithholdingAgent: input.isTopWithholdingAgent,
          payeeType: input.payeeType,
          paymentType: input.paymentType,
          hasSwornDeclaration: input.hasSwornDeclaration,
        });
        if (!assessment.required || !assessment.atc) {
          throw new Error(assessment.reason);
        }
        const rateBps = assessment.rateBps ?? ATC_EXPECTED_RATE_BPS[assessment.atc];
        if (rateBps == null) {
          throw new Error(`ATC ${assessment.atc} has no rate, so withholding cannot be stored.`);
        }
        const computation = computeEwt({
          grossAmount: input.grossAmount,
          vatAmount: input.vatAmount,
          atc: assessment.atc,
          rateBps,
        });
        const [row] = await db
          .insert(taxWithholdingPayments)
          .values({
            organizationId: orgId,
            payeeTin,
            payeeRegisteredName: input.payeeRegisteredName,
            periodStart: input.periodStart,
            periodEnd: input.periodEnd,
            atc: computation.atc,
            incomePayment: computation.taxBase,
            taxWithheld: computation.taxWithheld,
            certificateIssued: input.certificateIssued,
            certificateNumber: input.certificateNumber ?? null,
            createdBy: userId,
          })
          .returning({ id: taxWithholdingPayments.id });
        if (!row) throw new Error("Could not store withholding payment");
        return { id: row.id, assessment, computation };
      },
    );
  },
);

const qapSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  periodEnd: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
});

export const buildStoredQap = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const input = qapSchema.parse(rawData);
      const payments = await db
        .select({
          payeeTin: taxWithholdingPayments.payeeTin,
          payeeRegisteredName: taxWithholdingPayments.payeeRegisteredName,
          atc: taxWithholdingPayments.atc,
          incomePayment: taxWithholdingPayments.incomePayment,
          taxWithheld: taxWithholdingPayments.taxWithheld,
          certificateIssued: taxWithholdingPayments.certificateIssued,
          periodStart: taxWithholdingPayments.periodStart,
          periodEnd: taxWithholdingPayments.periodEnd,
        })
        .from(taxWithholdingPayments)
        .where(eq(taxWithholdingPayments.organizationId, orgId));
      const inPeriod = payments.filter(
        (payment) =>
          payment.periodStart >= input.periodStart && payment.periodEnd <= input.periodEnd,
      );
      const month = Number(input.periodEnd.slice(5, 7));
      return {
        qap: buildQap({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          payments: inPeriod,
        }),
        remittance: remittanceObligationsFor(month, Number(input.periodEnd.slice(0, 4))),
      };
    });
  },
);

export const saveStoredQap = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:save-qap", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const input = qapSchema.parse(rawData);
        const payments = await db
          .select({
            payeeTin: taxWithholdingPayments.payeeTin,
            payeeRegisteredName: taxWithholdingPayments.payeeRegisteredName,
            atc: taxWithholdingPayments.atc,
            incomePayment: taxWithholdingPayments.incomePayment,
            taxWithheld: taxWithholdingPayments.taxWithheld,
            certificateIssued: taxWithholdingPayments.certificateIssued,
            periodStart: taxWithholdingPayments.periodStart,
            periodEnd: taxWithholdingPayments.periodEnd,
          })
          .from(taxWithholdingPayments)
          .where(eq(taxWithholdingPayments.organizationId, orgId));
        const inPeriod = payments.filter(
          (payment) =>
            payment.periodStart >= input.periodStart && payment.periodEnd <= input.periodEnd,
        );
        const qap = buildQap({
          periodStart: input.periodStart,
          periodEnd: input.periodEnd,
          payments: inPeriod,
        });
        const [row] = await db
          .insert(taxComputedReturns)
          .values({
            organizationId: orgId,
            formCode: "QAP",
            periodStart: qap.periodStart,
            periodEnd: qap.periodEnd,
            payload: asJsonPayload(qap),
            blockingIssueCount: qap.blockingIssues.length,
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
              payload: asJsonPayload(qap),
              blockingIssueCount: qap.blockingIssues.length,
              updatedAt: new Date(),
            },
          })
          .returning({ id: taxComputedReturns.id });
        if (!row) throw new Error("Could not save QAP");
        return { id: row.id, qap };
      },
    );
  },
);

const issueSchema = z.object({
  paymentId: z.string().uuid(),
});

export const issueWithholding2307 = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "tax:issue-2307", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const input = issueSchema.parse(rawData);
        const [payment] = await db
          .select()
          .from(taxWithholdingPayments)
          .where(
            and(
              eq(taxWithholdingPayments.id, input.paymentId),
              eq(taxWithholdingPayments.organizationId, orgId),
            ),
          )
          .limit(1);
        if (!payment) throw new Error("Withholding payment not found");

        const [payor] = await db
          .select({
            tin: orgTaxProfiles.tin,
            registeredName: orgTaxProfiles.registeredName,
          })
          .from(orgTaxProfiles)
          .where(eq(orgTaxProfiles.organizationId, orgId))
          .limit(1);

        const blockingIssues: string[] = [];
        if (!payor?.tin || !payor.registeredName) {
          blockingIssues.push(
            "Employer TIN and registered name are required before a 2307 can be issued.",
          );
        }

        const certificateNumber = payment.certificateNumber ?? `2307-${payment.id.slice(0, 8)}`;
        const pdfBase64 = form2307PdfBuffer({
          payorTin: payor?.tin ?? "000000000",
          payorRegisteredName: payor?.registeredName ?? "UNREGISTERED PAYOR",
          payeeTin: payment.payeeTin,
          payeeRegisteredName: payment.payeeRegisteredName,
          periodStart: payment.periodStart,
          periodEnd: payment.periodEnd,
          atc: payment.atc,
          incomePayment: payment.incomePayment,
          taxWithheld: payment.taxWithheld,
          certificateNumber,
          blockingIssues,
        });

        if (blockingIssues.length === 0 && !payment.certificateIssued) {
          await db.insert(taxCertificates).values({
            organizationId: orgId,
            certificateType: "issued_2307",
            payorTin: payor!.tin!,
            payorRegisteredName: payor!.registeredName!,
            certificateNumber,
            periodStart: payment.periodStart,
            periodEnd: payment.periodEnd,
            atc: payment.atc,
            incomePayment: payment.incomePayment,
            taxWithheld: payment.taxWithheld,
            certificateStatus: "received",
            createdBy: userId,
          });
          await db
            .update(taxWithholdingPayments)
            .set({
              certificateIssued: true,
              certificateNumber,
              updatedAt: new Date(),
            })
            .where(eq(taxWithholdingPayments.id, payment.id));
        }

        return {
          paymentId: payment.id,
          certificateNumber,
          pdfBase64,
          blockingIssues,
        };
      },
    );
  },
);

const remitSchema = z.object({
  month: z.number().int().min(1).max(12),
  year: z.number().int().min(2000).max(2100),
});

export const remitWithholding = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "create",
      { routeKey: "tax:ewt-remit", limit: 10, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const input = remitSchema.parse(rawData);
        // One transaction: the poster documents that it needs a
        // transaction-scoped executor (header+lines+certificate pin must be
        // atomic, and its FOR UPDATE is a no-op outside one).
        return db.transaction((tx) =>
          postEwtRemittance(tx, {
            organizationId: orgId,
            userId,
            month: input.month,
            year: input.year,
          }),
        );
      },
    );
  },
);

export const issueStoredQapDat = createServerFn({ method: "POST" }).handler(
  async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const input = qapSchema.parse(rawData);
      const [payor] = await db
        .select({
          tin: orgTaxProfiles.tin,
          branchCode: orgTaxProfiles.branchCode,
          registeredName: orgTaxProfiles.registeredName,
          rdoCode: orgTaxProfiles.rdoCode,
        })
        .from(orgTaxProfiles)
        .where(eq(orgTaxProfiles.organizationId, orgId))
        .limit(1);
      if (!payor?.tin || !payor.registeredName) {
        throw new Error(
          "Employer TIN and registered name are required before a QAP .DAT can be issued.",
        );
      }
      const payments = await db
        .select({
          payeeTin: taxWithholdingPayments.payeeTin,
          payeeRegisteredName: taxWithholdingPayments.payeeRegisteredName,
          atc: taxWithholdingPayments.atc,
          incomePayment: taxWithholdingPayments.incomePayment,
          taxWithheld: taxWithholdingPayments.taxWithheld,
          certificateIssued: taxWithholdingPayments.certificateIssued,
          periodStart: taxWithholdingPayments.periodStart,
          periodEnd: taxWithholdingPayments.periodEnd,
        })
        .from(taxWithholdingPayments)
        .where(eq(taxWithholdingPayments.organizationId, orgId));
      const inPeriod = payments.filter(
        (payment) =>
          payment.periodStart >= input.periodStart && payment.periodEnd <= input.periodEnd,
      );
      return issueQapDat({
        payorTin: payor.tin,
        payorBranchCode: payor.branchCode ?? "00000",
        payorRegisteredName: payor.registeredName,
        rdoCode: payor.rdoCode,
        periodStart: input.periodStart,
        periodEnd: input.periodEnd,
        payments: inPeriod,
      });
    });
  },
);
