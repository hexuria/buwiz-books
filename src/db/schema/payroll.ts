/**
 * Payroll compliance schema — Stage 5a of docs/tax/IMPLEMENTATION-PLAN.md.
 *
 * The January slice produces BIR Form 2316 per employee and the 1604-C
 * alphalist. Neither reads a journal line, which is what takes Stage 0 (ledger
 * hardening) off the critical path and makes November credible.
 *
 * But this is the REAL payroll model, not a throwaway import-and-print path.
 * Stage 5b adds the journal posting; it does not rewrite these tables. Building
 * a parallel structure now would be the classic way to end up with an island
 * that never integrates — see IMPLEMENTATION-PLAN.md §2.
 *
 * WHY THIS IS STATEFUL AT ALL. An "engine only, no payroll tables" scope is not
 * achievable, because the law is stateful (DECISIONS D2):
 *   - the cumulative-average method latch is per employee, per calendar year,
 *     and one-way
 *   - that method averages over year-to-date accumulators
 *   - the ₱90,000 benefits ceiling is annual and tested on YTD totals
 *   - each of the eleven de minimis types accumulates against its own ceiling
 *   - a mid-year hire's prior-employer 2316 feeds both the cumulative method
 *     and the year-end annualization
 *
 * TENANCY. Every table here is org-scoped with a NOT NULL organization_id, an
 * explicit predicate on every query, and a policy in rls_policies.sql. RLS is
 * NOT actually enforced today (drizzle/rls_hardening.sql Section B is commented
 * out and the app connects as the table owner), so the application-level
 * predicate is the real boundary — see IMPLEMENTATION-PLAN.md blocker B5.
 */
import {
  pgTable,
  uuid,
  text,
  date,
  integer,
  numeric,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { relations } from "drizzle-orm";
import { parties } from "./parties";

/** Which statutory path computed a line. Mirrors `WithholdingMethod` plus the annual true-up. */
export type PayrollWithholdingPath = "regular" | "cumulative_average" | "annualized";

/** Why the cumulative-average latch engaged. Mirrors `TriggerReason`. */
export type PayrollLatchReason =
  | "already_latched"
  | "regular_below_level_with_supplementary"
  | "supplementary_at_or_above_regular"
  | "new_hire_with_previous_employer";

export type PayrollRunStatus = "draft" | "imported" | "computed" | "acknowledged" | "locked";

/**
 * Whether the statutory contribution figures were checked against the schedule.
 *
 * `skipped_non_monthly` is not a gap in the implementation: SSS, PhilHealth and
 * Pag-IBIG are MONTHLY obligations, so a semi-monthly or weekly period holds a
 * fraction of the monthly amount and employers split it by differing
 * conventions. Comparing per-period would manufacture variances that are not
 * errors.
 */
export type ContributionCheckStatus =
  | "checked"
  | "skipped_non_monthly"
  | "skipped_not_reported"
  // Semi-monthly first half: SSS/PhilHealth/Pag-IBIG are MONTHLY obligations,
  // so the expected figures are computed and recognized on the run that
  // completes the month; the opening half records that the check is pending
  // rather than silently skipped.
  | "deferred_month_end";

/**
 * A previous employer's year-to-date figures, from the employee's BIR 2316.
 *
 * A BLOCKING precondition of the first payroll run for any mid-year hire
 * (DECISIONS D7 Tier 1). Without it the cumulative-average method has an
 * incomplete numerator and the year-end annualization credits too little tax.
 *
 * `periodsCovered` is captured EXPLICITLY rather than inferred from the
 * employment dates, because it is the cumulative method's Step 2 divisor and
 * getting it from the calendar is exactly the bug that made a July hire
 * withhold nothing (IMPLEMENTATION-PLAN.md blocker B4). An employment gap makes
 * the calendar reading wrong, and the 2316 does not always state the count — in
 * which case it must be keyed by a human, not guessed.
 */
export const previousEmployer2316 = pgTable(
  "payroll_previous_employer_2316",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    employeePartyId: uuid("employee_party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    taxableYear: integer("taxable_year").notNull(),

    previousEmployerTin: text("previous_employer_tin"),
    previousEmployerName: text("previous_employer_name").notNull(),

    taxableCompensation: numeric("taxable_compensation", { precision: 20, scale: 8 }).notNull(),
    taxWithheld: numeric("tax_withheld", { precision: 20, scale: 8 }).notNull(),
    /** Non-taxable compensation, needed for the 2316's own breakdown. */
    nonTaxableCompensation: numeric("non_taxable_compensation", { precision: 20, scale: 8 }),
    /** The MWE portion, which stays exempt — RR 11-2018 §2.78.1(B)(13). */
    mweCompensation: numeric("mwe_compensation", { precision: 20, scale: 8 }),

    /** The Step 2 divisor contribution. Explicit, never derived. */
    periodsCovered: integer("periods_covered").notNull(),
    employmentFrom: date("employment_from").notNull(),
    employmentTo: date("employment_to").notNull(),

    /** Scan or PDF of the 2316 itself, for the audit trail. */
    documentId: uuid("document_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("payroll_prev_2316_employee_year_employer").on(
      table.organizationId,
      table.employeePartyId,
      table.taxableYear,
      table.previousEmployerName,
    ),
    index("payroll_prev_2316_lookup").on(
      table.organizationId,
      table.employeePartyId,
      table.taxableYear,
    ),
  ],
);

/**
 * Per-employee, per-calendar-year withholding state.
 *
 * The accumulators the cumulative-average method averages over, plus the latch.
 * One row per employee per taxable year; `periodsElapsed` counts payroll
 * periods actually paid at THIS employer, which is the other half of the Step 2
 * divisor.
 */
export const payrollEmployeeYearState = pgTable(
  "payroll_employee_year_state",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    employeePartyId: uuid("employee_party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "cascade" }),
    taxableYear: integer("taxable_year").notNull(),

    /** One-way within the year: `regular` may become `cumulative_average`, never back. */
    withholdingMethod: text("withholding_method")
      .$type<"regular" | "cumulative_average">()
      .default("regular")
      .notNull(),
    latchedReason: text("latched_reason").$type<PayrollLatchReason>(),
    latchedAtPeriodEnd: date("latched_at_period_end"),

    ytdTaxableRegular: numeric("ytd_taxable_regular", { precision: 20, scale: 8 })
      .default("0")
      .notNull(),
    ytdTaxableSupplementary: numeric("ytd_taxable_supplementary", { precision: 20, scale: 8 })
      .default("0")
      .notNull(),
    ytdNonTaxable: numeric("ytd_non_taxable", { precision: 20, scale: 8 }).default("0").notNull(),
    ytdTaxWithheld: numeric("ytd_tax_withheld", { precision: 20, scale: 8 }).default("0").notNull(),
    /** Tested against the ₱90,000 annual ceiling. Annual, so it must be YTD. */
    ytdThirteenthMonthAndOtherBenefits: numeric("ytd_13th_month_and_other_benefits", {
      precision: 20,
      scale: 8,
    })
      .default("0")
      .notNull(),
    /**
     * Per-de-minimis-type accumulation, keyed by benefit type.
     *
     * Eleven independent ceilings mean an aggregate cannot reproduce the excess
     * computation (DECISIONS A6). JSONB rather than a child table because it is
     * read and written as one blob per period and never queried across
     * employees by type.
     */
    ytdDeMinimisByType: text("ytd_de_minimis_by_type"),

    /** Payroll periods paid at THIS employer this year — the divisor's other half. */
    periodsElapsed: integer("periods_elapsed").default(0).notNull(),
    /**
     * Immutable opening balance for organizations migrating mid-year: history
     * that exists in no payroll_lines row. The replay-based compute uses these
     * as its base and NEVER writes them; the plain ytd/periods columns above
     * are derived output, rewritten on every compute.
     */
    openingPeriodsElapsed: integer("opening_periods_elapsed"),
    openingYtdTaxableRegular: numeric("opening_ytd_taxable_regular", { precision: 20, scale: 8 }),
    openingYtdTaxableSupplementary: numeric("opening_ytd_taxable_supplementary", {
      precision: 20,
      scale: 8,
    }),
    openingYtdTaxWithheld: numeric("opening_ytd_tax_withheld", { precision: 20, scale: 8 }),

    /**
     * Opening-balance intake marker. Rows carried in from a prior system are
     * excluded from the reconciliation invariant by construction (D7).
     */
    isPreMigration: boolean("is_pre_migration").default(false).notNull(),
    openingBalanceAsOf: date("opening_balance_as_of"),
    /** The reference dataset the opening figures were understood under. */
    referenceDatasetVersion: text("reference_dataset_version"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("payroll_employee_year_state_key").on(
      table.organizationId,
      table.employeePartyId,
      table.taxableYear,
    ),
  ],
);

/**
 * One payroll period for one organization.
 *
 * `status` is a one-way ladder. `acknowledged` is the D-N7 variance gate: the
 * product files the CLIENT's figure, records the variance and the client's
 * acknowledgement immutably, and refuses to advance while an unacknowledged
 * blocking variance exists. The product is the control, not the computer of
 * record.
 */
export const payrollRuns = pgTable(
  "payroll_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    taxableYear: integer("taxable_year").notNull(),
    payrollPeriod: text("payroll_period")
      .$type<"daily" | "weekly" | "semi_monthly" | "monthly" | "annual">()
      .notNull(),
    periodStart: date("period_start").notNull(),
    /** Selects the annex generation — the date compensation is PAID. */
    periodEnd: date("period_end").notNull(),
    /** Ordinal within the calendar year: 1..12 monthly, 1..24 semi-monthly. */
    periodIndex: integer("period_index").notNull(),

    status: text("status").$type<PayrollRunStatus>().default("draft").notNull(),
    /**
     * The journal this run posted. Absent until posted; a unique index makes a
     * second posting for the same run impossible rather than merely unlikely.
     */
    journalHeaderId: uuid("journal_header_id"),
    /** Set for the December run and the final run on termination. */
    isAnnualizationRun: boolean("is_annualization_run").default(false).notNull(),

    /** Where the register came from, for the audit trail. */
    importSource: text("import_source"),
    importedDocumentId: uuid("imported_document_id"),
    /** The reference dataset used, so an amendment recomputes against it. */
    referenceDatasetVersion: text("reference_dataset_version"),

    computedAt: timestamp("computed_at", { withTimezone: true }),
    acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
    acknowledgedBy: text("acknowledged_by"),
    /**
     * WHY the client's figures stand despite a variance. Recorded because the
     * reason is the part that answers an assessment — "we withheld less
     * because the employee started mid-month" is an answer; a bare timestamp
     * is not. A CHECK constraint requires all three acknowledgement fields
     * together, so an empty click cannot be stored.
     */
    acknowledgementNote: text("acknowledgement_note"),

    /**
     * Filing state. The checksum links the run to the immutable figures it
     * reported — without it a filed period can no longer prove what it said.
     * CHECK constraints require checksum+time together, reference+time
     * together, and refuse a filed period with no snapshot behind it.
     */
    snapshotChecksum: text("snapshot_checksum"),
    snapshotTakenAt: timestamp("snapshot_taken_at", { withTimezone: true }),
    filingReference: text("filing_reference"),
    filedAt: timestamp("filed_at", { withTimezone: true }),
    lockedAt: timestamp("locked_at", { withTimezone: true }),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("payroll_runs_org_period").on(
      table.organizationId,
      table.taxableYear,
      table.payrollPeriod,
      table.periodIndex,
    ),
    index("payroll_runs_org_year").on(table.organizationId, table.taxableYear),
  ],
);

/**
 * One employee's compensation for one payroll run.
 *
 * Carries BOTH the imported figures and the engine's own, because the v1
 * deliverable is a VERIFIER: the value is `expected vs reported vs delta`, not
 * a replacement payroll calculation (DECISIONS D2).
 *
 * The compensation columns mirror the three-bucket segregation in
 * `src/lib/tax/compensation.ts` exactly. Gross goes in and the engine nets the
 * employee's mandatory contributions itself — there is deliberately no column
 * meaning "basic salary already net of contributions", which is the shape of
 * the trap in the BIR's own calculator.
 */
export const payrollLines = pgTable(
  "payroll_lines",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    payrollRunId: uuid("payroll_run_id")
      .notNull()
      .references(() => payrollRuns.id, { onDelete: "cascade" }),
    employeePartyId: uuid("employee_party_id")
      .notNull()
      .references(() => parties.id, { onDelete: "restrict" }),

    // ── Taxable regular — selects the bracket ───────────────────────────────
    basicSalary: numeric("basic_salary", { precision: 20, scale: 8 }).default("0").notNull(),
    representationAllowance: numeric("representation_allowance", { precision: 20, scale: 8 }),
    transportationAllowance: numeric("transportation_allowance", { precision: 20, scale: 8 }),
    costOfLivingAllowance: numeric("cost_of_living_allowance", { precision: 20, scale: 8 }),
    fixedHousingAllowance: numeric("fixed_housing_allowance", { precision: 20, scale: 8 }),
    otherTaxableRegular: numeric("other_taxable_regular", { precision: 20, scale: 8 }),

    // ── Taxable supplementary — joins the excess, does not move the bracket ──
    commission: numeric("commission", { precision: 20, scale: 8 }),
    profitSharing: numeric("profit_sharing", { precision: 20, scale: 8 }),
    directorsFees: numeric("directors_fees", { precision: 20, scale: 8 }),
    overtimePay: numeric("overtime_pay", { precision: 20, scale: 8 }),
    /** Hazard pay that does NOT qualify for the MWE exemption. */
    hazardPay: numeric("hazard_pay", { precision: 20, scale: 8 }),
    otherTaxableSupplementary: numeric("other_taxable_supplementary", { precision: 20, scale: 8 }),

    // ── Non-taxable. MWE items stay exempt even alongside other taxable pay ──
    basicSalaryMwe: numeric("basic_salary_mwe", { precision: 20, scale: 8 }),
    holidayPayMwe: numeric("holiday_pay_mwe", { precision: 20, scale: 8 }),
    overtimePayMwe: numeric("overtime_pay_mwe", { precision: 20, scale: 8 }),
    nightShiftDifferentialMwe: numeric("night_shift_differential_mwe", { precision: 20, scale: 8 }),
    /** Hazard pay that QUALIFIES for the MWE exemption. */
    hazardPayMwe: numeric("hazard_pay_mwe", { precision: 20, scale: 8 }),
    /**
     * DOLE certification reference justifying exempt hazard pay. 1604-C requires
     * the employer to justify it (DECISIONS D4).
     */
    hazardPayDoleCertificationRef: text("hazard_pay_dole_certification_ref"),
    thirteenthMonthAndOtherBenefits: numeric("thirteenth_month_and_other_benefits", {
      precision: 20,
      scale: 8,
    }),
    deMinimisBenefits: numeric("de_minimis_benefits", { precision: 20, scale: 8 }),
    /** Per-type breakdown, since each of the eleven has its own ceiling. */
    deMinimisByType: text("de_minimis_by_type"),
    nonTaxableRetirementSeparation: numeric("non_taxable_retirement_separation", {
      precision: 20,
      scale: 8,
    }),
    otherExempt: numeric("other_exempt", { precision: 20, scale: 8 }),

    // ── Employee-share contributions. A DEDUCTION, never an employer expense ─
    sssEmployeeShare: numeric("sss_employee_share", { precision: 20, scale: 8 }),
    philHealthEmployeeShare: numeric("philhealth_employee_share", { precision: 20, scale: 8 }),
    pagIbigEmployeeShare: numeric("pagibig_employee_share", { precision: 20, scale: 8 }),
    unionDues: numeric("union_dues", { precision: 20, scale: 8 }),

    // ── The verification, which is the whole point of v1 ─────────────────────
    /** What the client's payroll system withheld. */
    reportedTaxWithheld: numeric("reported_tax_withheld", { precision: 20, scale: 8 }),
    /** What the engine computes. */
    computedTaxWithheld: numeric("computed_tax_withheld", { precision: 20, scale: 8 }),
    /** computed − reported. Non-zero needs an explanation before filing. */
    varianceAmount: numeric("variance_amount", { precision: 20, scale: 8 }),
    varianceAcknowledgedAt: timestamp("variance_acknowledged_at", { withTimezone: true }),
    varianceAcknowledgedBy: text("variance_acknowledged_by"),
    varianceNote: text("variance_note"),

    // ── Statutory contribution check ────────────────────────────────────────
    /**
     * What the statutory schedules say the EMPLOYEE should contribute.
     *
     * The withholding computation nets the employee share off gross before
     * selecting the bracket, so a wrong contribution makes the taxable base
     * wrong too — and because the engine nets whatever the register reported,
     * the two errors cancel and the tax variance reads zero. Checking the
     * contributions independently is what stops a clean-looking run over a
     * register built on a wrong deduction.
     */
    expectedSssEmployeeShare: numeric("expected_sss_employee_share", { precision: 20, scale: 8 }),
    expectedPhilHealthEmployeeShare: numeric("expected_philhealth_employee_share", {
      precision: 20,
      scale: 8,
    }),
    expectedPagIbigEmployeeShare: numeric("expected_pagibig_employee_share", {
      precision: 20,
      scale: 8,
    }),
    expectedSssEmployerShare: numeric("expected_sss_employer_share", { precision: 20, scale: 8 }),
    expectedPhilHealthEmployerShare: numeric("expected_philhealth_employer_share", {
      precision: 20,
      scale: 8,
    }),
    expectedPagIbigEmployerShare: numeric("expected_pagibig_employer_share", {
      precision: 20,
      scale: 8,
    }),
    /** Employee-side total: expected minus reported. */
    contributionVarianceAmount: numeric("contribution_variance_amount", {
      precision: 20,
      scale: 8,
    }),
    /** Why the check did or did not run. An unchecked line must not look clean. */
    contributionCheckStatus: text("contribution_check_status").$type<ContributionCheckStatus>(),
    /**
     * The monthly basic salary the PhilHealth premium was computed on.
     *
     * Recorded because it is a NARROWER figure than compensation — excluding
     * commission, overtime, allowances, 13th month and bonuses — and it is the
     * most common source of a wrong premium. A filed number should be
     * re-explainable without re-deriving which base was used.
     */
    philHealthBaseUsed: numeric("philhealth_base_used", { precision: 20, scale: 8 }),

    /** Which statutory path produced `computedTaxWithheld`. */
    withholdingPath: text("withholding_path").$type<PayrollWithholdingPath>(),
    /** The Step 2 divisor actually used, so a filed figure can be re-explained. */
    cumulativeDivisor: integer("cumulative_divisor"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("payroll_lines_run_employee").on(table.payrollRunId, table.employeePartyId),
    index("payroll_lines_org_employee").on(table.organizationId, table.employeePartyId),
  ],
);

export const payrollRunsRelations = relations(payrollRuns, ({ many }) => ({
  lines: many(payrollLines),
}));

export const payrollLinesRelations = relations(payrollLines, ({ one }) => ({
  run: one(payrollRuns, {
    fields: [payrollLines.payrollRunId],
    references: [payrollRuns.id],
  }),
  employee: one(parties, {
    fields: [payrollLines.employeePartyId],
    references: [parties.id],
  }),
}));

export const payrollEmployeeYearStateRelations = relations(payrollEmployeeYearState, ({ one }) => ({
  employee: one(parties, {
    fields: [payrollEmployeeYearState.employeePartyId],
    references: [parties.id],
  }),
}));

export const previousEmployer2316Relations = relations(previousEmployer2316, ({ one }) => ({
  employee: one(parties, {
    fields: [previousEmployer2316.employeePartyId],
    references: [parties.id],
  }),
}));
