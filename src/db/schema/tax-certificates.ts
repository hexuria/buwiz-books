/**
 * Received (and later, issued) BIR Form 2307 certificates.
 *
 * A customer who withholds expanded withholding tax from a payment to us
 * issues a 2307. That certificate is the ONLY evidence supporting the
 * creditable withholding tax we claim against income tax — without it the BIR
 * disallows the credit regardless of what our books say.
 *
 * So the certificate and the journal entry are two different facts. A CWT
 * receivable with no certificate behind it is an asset that will be written
 * off at assessment, which is what `certificateStatus` exists to surface
 * before then rather than after.
 */
import { index, numeric, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";
import { parties } from "./parties";
import { journalHeaders } from "./journals";

export type TaxCertificateType = "received_2307" | "issued_2307";

/**
 * Whether the paper certificate is actually in hand.
 *
 * `pending` is the default and the honest one: the accrual is recognised when
 * the payment is received, but the certificate usually arrives later. A
 * quarter that closes with pending certificates has a credit at risk, and that
 * is a report worth running before filing rather than a surprise at audit.
 */
export type TaxCertificateStatus = "pending" | "received" | "lost" | "disputed";

export const taxCertificates = pgTable(
  "tax_certificates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),

    certificateType: text("certificate_type")
      .$type<TaxCertificateType>()
      .default("received_2307")
      .notNull(),

    /** The party that withheld FROM us and issued the certificate. */
    payorPartyId: uuid("payor_party_id").references(() => parties.id, { onDelete: "restrict" }),
    /** Kept alongside the party link: the certificate states a TIN, and that
     * stated value is what the SAWT must carry even if the party record is
     * later corrected. */
    payorTin: text("payor_tin").notNull(),
    payorRegisteredName: text("payor_registered_name").notNull(),

    certificateNumber: text("certificate_number"),

    /** 2307 is issued per quarter. */
    periodStart: text("period_start").notNull(),
    periodEnd: text("period_end").notNull(),

    /** Alphanumeric Tax Code — decides the rate and the SAWT column. */
    atc: text("atc").notNull(),
    incomePayment: numeric("income_payment", { precision: 20, scale: 8 }).notNull(),
    taxWithheld: numeric("tax_withheld", { precision: 20, scale: 8 }).notNull(),

    certificateStatus: text("certificate_status")
      .$type<TaxCertificateStatus>()
      .default("pending")
      .notNull(),

    journalHeaderId: uuid("journal_header_id").references(() => journalHeaders.id, {
      onDelete: "restrict",
    }),

    documentId: uuid("document_id"),
    notes: text("notes"),

    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    // Claiming one certificate twice overstates the credit and understates tax
    // due. Partial: a certificate captured before its number is known is
    // legitimate and must not collide with another such row.
    uniqueIndex("tax_certificates_natural_key")
      .on(
        table.organizationId,
        table.payorTin,
        table.certificateNumber,
        table.periodStart,
        table.periodEnd,
      )
      .where(sql`certificate_number IS NOT NULL`),
    index("tax_certificates_org_period").on(
      table.organizationId,
      table.periodStart,
      table.periodEnd,
    ),
    index("tax_certificates_org_status").on(table.organizationId, table.certificateStatus),
  ],
);
