/**
 * Philippine BIR tax reference core.
 *
 * These four catalog tables are GLOBAL — no `organizationId`, deliberately
 * excluded from every RLS policy list, exactly like `review_rule_definitions`.
 * Statutory rates are not tenant data. A per-org copy is the drift bug
 * docs/tax/IMPLEMENTATION-PLAN.md blocker B11 describes: a national rate change
 * would never reach an org that already onboarded.
 *
 * The tables are created by drizzle/0037_tax_reference_core.sql, applied
 * pre-push by scripts/apply-tax-foundation.ts. These Drizzle definitions mirror
 * that DDL so application code has types; `drizzle-kit push` then diffs to
 * nothing. Changing a column here without changing the SQL is a silent
 * divergence — change both.
 *
 * Reads go through src/lib/tax/as-of.ts, never directly: every lookup is
 * effective-dated and the as-of date is mandatory.
 */
import {
  pgTable,
  text,
  uuid,
  integer,
  boolean,
  date,
  numeric,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { organization } from "./auth";

/**
 * The dataset version stamped onto filings and opening-balance intakes.
 *
 * An amended prior-period return must recompute against the figures as they
 * were understood when first filed, not against today's catalog.
 */
export const taxReferenceDatasets = pgTable("tax_reference_datasets", {
  version: text("version").primaryKey(),
  publishedAt: timestamp("published_at", { withTimezone: true }).defaultNow().notNull(),
  /** NULL until a human confirms the rows against primary sources. */
  lastVerifiedAt: timestamp("last_verified_at", { withTimezone: true }),
  sourceNote: text("source_note").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});

/** RR 11-2018 Annex D (2018-01-01..2022-12-31) or Annex E (2023-01-01..). */
export type WithholdingAnnex = "D" | "E";

export type PayrollPeriod = "daily" | "weekly" | "semi_monthly" | "monthly" | "annual";

/**
 * Withholding tax on compensation bracket rows.
 *
 * BOTH annexes are seeded. RR 11-2018's own Illustrations 6-15 — our golden
 * vectors — compute under Annex D, so seeding only Annex E red-builds the
 * vector suite and invites "fixing" the live constants (blocker B3).
 */
export const taxWithholdingTables = pgTable(
  "tax_withholding_tables",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetVersion: text("dataset_version")
      .notNull()
      .references(() => taxReferenceDatasets.version, { onDelete: "restrict" }),
    annex: text("annex").$type<WithholdingAnnex>().notNull(),
    payrollPeriod: text("payroll_period").$type<PayrollPeriod>().notNull(),
    bracketIndex: integer("bracket_index").notNull(),
    /** Bracket floor in pesos. Selection is `floorAmount <= compensation`. */
    floorAmount: numeric("floor_amount", { precision: 20, scale: 8 }).notNull(),
    prescribedTax: numeric("prescribed_tax", { precision: 20, scale: 8 }).notNull(),
    /** Basis points — exact integer data. 1500 = 15%. */
    rateBps: integer("rate_bps").notNull(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    citation: text("citation").notNull(),
  },
  (table) => [
    uniqueIndex("tax_withholding_tables_natural_key").on(
      table.datasetVersion,
      table.annex,
      table.payrollPeriod,
      table.bracketIndex,
    ),
    index("tax_withholding_tables_lookup").on(
      table.payrollPeriod,
      table.effectiveFrom,
      table.effectiveTo,
    ),
  ],
);

/**
 * How a de minimis ceiling is expressed.
 *
 * Four shapes, because the eleven RR 29-2025 benefits do not share one:
 * `pct_of_regional_smw` makes the de minimis engine depend on the DOLE wage
 * table, and `uncapped` exists because government VL/SL monetization has no
 * ceiling at all.
 */
export type DeMinimisLimitKind =
  | "peso_per_month"
  | "peso_per_semester"
  | "peso_per_year"
  | "days_per_year"
  | "pct_of_regional_smw"
  | "uncapped";

/**
 * De minimis benefit ceilings.
 *
 * `permittedForms` carries the dimension an amount-only table cannot express:
 * RR 4-2025 changed the permitted FORM of employee achievement awards (adding
 * cash and gift certificates) while leaving the amount at P10,000.
 */
export const taxDeMinimisCeilings = pgTable(
  "tax_de_minimis_ceilings",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    datasetVersion: text("dataset_version")
      .notNull()
      .references(() => taxReferenceDatasets.version, { onDelete: "restrict" }),
    benefitType: text("benefit_type").notNull(),
    limitKind: text("limit_kind").$type<DeMinimisLimitKind>().notNull(),
    /** NULL only when `limitKind` is `uncapped`. */
    limitAmount: numeric("limit_amount", { precision: 20, scale: 8 }),
    /** NULL means no form restriction; a non-empty array restricts it. */
    permittedForms: text("permitted_forms").array(),
    /**
     * Non-amount conditions the benefit must also satisfy. The achievement
     * award's exemption turns on three cumulative conditions, and failing any
     * takes the whole award out of de minimis rather than creating an excess —
     * a permitted-forms list alone over-exempts.
     */
    qualifyingConditions: text("qualifying_conditions").array(),
    effectiveFrom: date("effective_from").notNull(),
    effectiveTo: date("effective_to"),
    citation: text("citation").notNull(),
  },
  (table) => [
    uniqueIndex("tax_de_minimis_ceilings_natural_key").on(
      table.datasetVersion,
      table.benefitType,
      table.effectiveFrom,
    ),
    index("tax_de_minimis_ceilings_lookup").on(
      table.benefitType,
      table.effectiveFrom,
      table.effectiveTo,
    ),
  ],
);

/**
 * Organization tax profile — the filing identity.
 *
 * A sidecar on `auth_organizations`, modelled on `organization_secrets`. NOT
 * `auth_organizations.metadata`: that is an unconstrained text JSON blob which
 * Better Auth returns to browser clients, and it is an exportable entity that
 * would drag the export/import protocol into every field change.
 */
export const orgTaxProfiles = pgTable("org_tax_profiles", {
  organizationId: text("organization_id")
    .primaryKey()
    .references(() => organization.id, { onDelete: "cascade" }),
  /** 9 digits, no separators. */
  tin: text("tin"),
  /**
   * Stored at 5 digits (eBIRForms v7.9.6.0). The alphalist .DAT layouts still
   * specify 4 — the encoder truncates and logs the divergence.
   */
  branchCode: text("branch_code").default("00000").notNull(),
  rdoCode: text("rdo_code"),
  registeredName: text("registered_name"),
  /** Drives EOPT penalty computation, not just reporting. */
  taxpayerClassification: text("taxpayer_classification").$type<
    "micro" | "small" | "medium" | "large"
  >(),
  efpsEnrolled: boolean("efps_enrolled").default(false).notNull(),
  /** RR 26-2002 staggered filing: A=+15d down to E=+11d, monthly WHT forms only. */
  efpsIndustryGroup: text("efps_industry_group").$type<"A" | "B" | "C" | "D" | "E">(),
  isNga: boolean("is_nga").default(false).notNull(),
  fiscalYearEndMonth: integer("fiscal_year_end_month").default(12).notNull(),
  /** RR 7-2024 invoice-face data. Stored now; enforced if PH invoicing ships. */
  accn: text("accn"),
  approvedSeriesFrom: text("approved_series_from"),
  approvedSeriesTo: text("approved_series_to"),
  approvedSeriesDate: date("approved_series_date"),
  /** Periods before this are "filed outside buwiz". */
  booksAsOf: date("books_as_of"),
  /** Pins reference data for reproducibility; NULL means latest. */
  referenceDatasetVersion: text("reference_dataset_version").references(
    () => taxReferenceDatasets.version,
    { onDelete: "set null" },
  ),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

/**
 * Registered branches.
 *
 * Shipped now because it is a column today and a migration over live filing
 * data later. Per-branch return SPLITTING is post-v1; v1 computes head-office
 * consolidated.
 */
export const orgTaxBranches = pgTable(
  "org_tax_branches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organization.id, { onDelete: "cascade" }),
    branchCode: text("branch_code").notNull(),
    name: text("name"),
    rdoCode: text("rdo_code"),
    isWithholdingAgent: boolean("is_withholding_agent").default(false).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("org_tax_branches_org_code_unique").on(table.organizationId, table.branchCode),
  ],
);
