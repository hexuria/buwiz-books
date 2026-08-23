/** Remaining Stage 1/3b/4/6/7 persist tables. Created by drizzle/0047_tax_stage_remainder.sql. */
import {
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  date,
  numeric,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";
import { parties } from "./parties";
import { journalHeaders } from "./journals";

export type TaxYearRegime = "vat" | "percentage_tax" | "eight_percent";
export type TaxRegistrationKind = "vat" | "twa" | "percentage_tax" | "eight_percent";
export type ComputedReturnForm = "2550Q" | "2551Q" | "1601C" | "1601EQ" | "0619E" | "QAP" | "SLSP";

export const orgTaxYearElections = pgTable(
  "org_tax_year_elections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    taxableYear: integer("taxable_year").notNull(),
    regime: text("regime").$type<TaxYearRegime>().notNull(),
    electedViaForm: text("elected_via_form"),
    irrevocable: boolean("irrevocable").default(true).notNull(),
    hasCompensationIncome: boolean("has_compensation_income").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("org_tax_year_elections_org_year").on(table.organizationId, table.taxableYear),
  ],
);

export const orgTaxRegistrations = pgTable(
  "org_tax_registrations",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    regimeKind: text("regime_kind").$type<TaxRegistrationKind>().notNull(),
    value: text("value").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    sourceEvent: text("source_event"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("org_tax_registrations_org_kind").on(
      table.organizationId,
      table.regimeKind,
      table.effectiveFrom,
    ),
  ],
);

/** Official deadline moves. Global on purpose — no organization_id. */
export const filingDeadlineOverrides = pgTable(
  "filing_deadline_overrides",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    formCode: text("form_code").notNull(),
    periodStart: date("period_start"),
    periodEnd: date("period_end"),
    dueDate: date("due_date").notNull(),
    citation: text("citation").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("filing_deadline_overrides_natural_key").on(
      table.formCode,
      table.periodStart,
      table.periodEnd,
    ),
  ],
);

export const taxWithholdingPayments = pgTable(
  "tax_withholding_payments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    payeePartyId: uuid("payee_party_id").references(() => parties.id, { onDelete: "restrict" }),
    payeeTin: text("payee_tin").notNull(),
    payeeRegisteredName: text("payee_registered_name").notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    atc: text("atc").notNull(),
    incomePayment: numeric("income_payment", { precision: 20, scale: 8 }).notNull(),
    taxWithheld: numeric("tax_withheld", { precision: 20, scale: 8 }).notNull(),
    certificateIssued: boolean("certificate_issued").default(false).notNull(),
    certificateNumber: text("certificate_number"),
    journalHeaderId: uuid("journal_header_id").references(() => journalHeaders.id, {
      onDelete: "restrict",
    }),
    createdBy: text("created_by"),
    /**
     * Stamped when an 0619-E/1601-EQ remittance journal covered this row.
     * Null = still owed — which is how a payment captured AFTER its period
     * was remitted surfaces in the next remittance instead of never.
     */
    remittedAt: timestamp("remitted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("tax_withholding_payments_org_period").on(
      table.organizationId,
      table.periodStart,
      table.periodEnd,
    ),
  ],
);

export const taxComputedReturns = pgTable(
  "tax_computed_returns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    formCode: text("form_code").$type<ComputedReturnForm>().notNull(),
    periodStart: date("period_start").notNull(),
    periodEnd: date("period_end").notNull(),
    payload: jsonb("payload")
      .$type<Record<string, string | number | boolean | string[]>>()
      .notNull(),
    blockingIssueCount: integer("blocking_issue_count").default(0).notNull(),
    createdBy: text("created_by"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("tax_computed_returns_natural_key").on(
      table.organizationId,
      table.formCode,
      table.periodStart,
      table.periodEnd,
    ),
  ],
);
