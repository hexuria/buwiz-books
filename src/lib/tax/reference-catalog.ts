/**
 * The seeded Philippine tax reference catalog.
 *
 * Mirrors the `review-rule-catalog` precedent: a TypeScript constant, seeded
 * `ON CONFLICT DO NOTHING`, wired into every path that builds a database, with
 * tests/unit/tax-reference-wiring.test.ts asserting those links still exist.
 *
 * THE SEEDER NEVER UPDATES AN EXISTING ROW, and must stay that way. A rate is
 * behaviour-bearing data: a `DO UPDATE` would let an edit to this file
 * silently retune withholding for every tenant at deploy time, with no version
 * bump and no audit row. Changing a shipped figure means a NEW dataset version
 * (and, for a correction rather than a new issuance, a reviewed numbered
 * migration). See DECISIONS D-N12.
 *
 * ── VERIFICATION STATUS ──────────────────────────────────────────────────────
 * WITHHOLDING BRACKETS: verified against primary BIR text. All 48 sub-annual
 * rows (2 annexes × 4 payroll periods × 6 brackets) match the official annex
 * PDFs cell for cell:
 *   https://bir-cdn.bir.gov.ph/local/pdf/Annex%20D%20RR%2011-2018.pdf
 *   https://bir-cdn.bir.gov.ph/local/pdf/Annex%20E%20RR%2011-2018.pdf
 * An earlier pass reported these as unretrievable; that was a URL-path problem,
 * not an availability one — the `/BIR/pdf/` prefix now 403s while `/local/pdf/`
 * serves fine. Do NOT guess bare filenames on that CDN: `Annex D.pdf` resolves
 * to an unrelated BIR Bacolod procurement template.
 *
 * The two annexes are built by DIFFERENT rules, which is worth knowing before
 * anyone "corrects" a constant that looks wrong:
 *   Annex D = exact division of the annual schedule (30,000/365 = 82.19).
 *   Annex E = a BRACKET CHAIN off its own printed whole-peso floors:
 *             prescribed[i] = prescribed[i-1] + rate[i-1] × (floor[i] − floor[i-1]).
 * So Annex E monthly 8,541.80 is 1,875.00 + 20% × (66,667 − 33,333) — it is not
 * a botched 8,541.67, and dividing the annual figures will not reproduce it.
 *
 * DE MINIMIS CEILINGS: all 33 amounts and all 11 limit KINDS verified against
 * primary text — RR 11-2018, RR 5-2011 and RR 1-2015 for the 2018 generation,
 * RR 4-2025 and RR 29-2025 for the later two.
 *
 * The surprise was structural rather than numeric: NO regulation restates the
 * whole enumeration. RR 11-2018 restates only items (a)-(e) and prints
 * "xxx xxx xxx"; items (f)-(j) survive unamended from RR 5-2011 and item (k)
 * was added by RR 1-2015. RR 4-2025 amended only items (e) and (h). So the
 * citation is per-BENEFIT, not per-generation — see `citation2018` below.
 * Pre-2018 RRs are not on the CDN under any name; the Supreme Court E-Library
 * carries them.
 *
 * EFFECTIVE DATES are the weakest link and neither regulation states one.
 * 14 Feb 2025 and 6 Jan 2026 both rest on professional secondary sources that
 * agree with each other. Treat both boundaries as derived.
 *
 * `last_verified_at` still stays NULL, now for a narrower reason: the amounts
 * are verified but the two generation BOUNDARIES are not, and a wrong boundary
 * silently applies the wrong ceiling to a whole payroll period.
 *
 * OPERATIONAL TRAP: `sourceNote` lives on a row seeded ON CONFLICT DO NOTHING,
 * so editing the string here does NOT propagate to a database already seeded.
 * Correcting provenance on a live database needs a deliberate UPDATE or a new
 * dataset version.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import {
  taxDeMinimisCeilings,
  taxReferenceDatasets,
  taxWithholdingTables,
  type DeMinimisLimitKind,
  type PayrollPeriod,
  type WithholdingAnnex,
} from "../../db/schema/tax-reference";

export const DATASET_V1 = {
  version: "2026-08-16",
  sourceNote:
    "Withholding brackets VERIFIED cell-for-cell against the primary BIR annex PDFs " +
    "(bir-cdn.bir.gov.ph/local/pdf/Annex D RR 11-2018.pdf and Annex E RR 11-2018.pdf) and " +
    "independently re-derived: Annex D by exact annual division, Annex E by its own bracket " +
    "chain. Annual-period rows are the Sec. 24(A)(2) schedule from the RR body, not an annex. " +
    "De minimis: all 33 amounts and 11 limit kinds verified against RR 11-2018, RR 5-2011, " +
    "RR 1-2015, RR 4-2025 and RR 29-2025. Citations are per-benefit because no single RR " +
    "restates the whole enumeration. The two generation boundaries (14 Feb 2025, 6 Jan 2026) " +
    "rest on professional secondary sources — neither RR states a publication date — so " +
    "last_verified_at stays NULL. See IMPLEMENTATION-PLAN.md B3 and DECISIONS U6.",
} as const;

export interface WithholdingBracketSeed {
  annex: WithholdingAnnex;
  payrollPeriod: PayrollPeriod;
  bracketIndex: number;
  floorAmount: string;
  prescribedTax: string;
  rateBps: number;
  effectiveFrom: string;
  effectiveTo: string | null;
  citation: string;
}

const ANNEX_D_FROM = "2018-01-01";
const ANNEX_D_TO = "2022-12-31";
const ANNEX_E_FROM = "2023-01-01";

const ANNEX_D_CITATION = "RR 11-2018 Annex D (TRAIN Phase 1, 1 Jan 2018 - 31 Dec 2022)";
const ANNEX_E_CITATION = "RR 11-2018 Annex E (TRAIN Phase 2, 1 Jan 2023 onwards)";

/**
 * The annual rows are NOT from an annex.
 *
 * Neither Annex D nor Annex E contains an annual table — both cover exactly
 * four payroll periods (daily, weekly, semi-monthly, monthly). The annual
 * figures are the NIRC Sec. 24(A)(2) schedule reproduced in the RR body, and
 * they are used only for the year-end and termination annualization, never for
 * per-period withholding. Labelling them "Annex D/E" is a false citation on
 * otherwise-correct values.
 */
const ANNUAL_D_CITATION =
  "NIRC Sec. 24(A)(2) schedule (1 Jan 2018 - 31 Dec 2022), per RR 11-2018 annualized " +
  "withholding method Step 3 — NOT from Annex D, which has no annual table";
const ANNUAL_E_CITATION =
  "NIRC Sec. 24(A)(2) schedule (1 Jan 2023 onwards), per RR 11-2018 annualized " +
  "withholding method Step 3 — NOT from Annex E, which has no annual table";

/**
 * Annex E, daily, top bracket: the official PDF prints this cell malformed as
 * "P 6,034.00.30" — a number with two decimal points, confirmed at glyph level
 * as a single contiguous text run, so the defect is in the published document
 * rather than in extraction.
 *
 * The bracket chain that reproduces all 19 other Annex E cells exactly gives
 * 1,102.60 + 30% × (21,918 − 5,479) = 6,034.30, which is the value seeded here.
 * The rival reading 6,034.25 (exact 2,202,500/365) is inconsistent with the
 * construction rule governing every other cell in the annex.
 */
const ANNEX_E_DAILY_TOP_NOTE =
  " [printed malformed in the source PDF as 'P 6,034.00.30'; 6,034.30 is what the annex's " +
  "own bracket-chain construction yields and is independently corroborated]";

/**
 * Bracket rows as `[floorAmount, prescribedTax, ratePercent]`, lowest first.
 *
 * The first row of every table is the 0% bracket. Note that its prescribed tax
 * is 0 for EVERY period including daily — the BIR calculator has a genuine bug
 * here, returning the full compensation as tax for daily pay below P685
 * (DECISIONS §2.5c). We do not replicate it; the differential harness asserts
 * this as a documented divergence.
 */
type BracketTuple = readonly [floor: string, prescribed: string, ratePercent: number];

const ANNEX_D: Record<PayrollPeriod, readonly BracketTuple[]> = {
  daily: [
    ["0", "0", 0],
    ["685", "0", 20],
    ["1096", "82.19", 25],
    ["2192", "356.16", 30],
    ["5479", "1342.47", 32],
    ["21918", "6602.74", 35],
  ],
  weekly: [
    ["0", "0", 0],
    ["4808", "0", 20],
    ["7692", "576.92", 25],
    ["15385", "2500", 30],
    ["38462", "9423.08", 32],
    ["153846", "46346.15", 35],
  ],
  semi_monthly: [
    ["0", "0", 0],
    ["10417", "0", 20],
    ["16667", "1250", 25],
    ["33333", "5416.67", 30],
    ["83333", "20416.67", 32],
    ["333333", "100416.67", 35],
  ],
  monthly: [
    ["0", "0", 0],
    ["20833", "0", 20],
    ["33333", "2500", 25],
    ["66667", "10833.33", 30],
    ["166667", "40833.33", 32],
    ["666667", "200833.33", 35],
  ],
  annual: [
    ["0", "0", 0],
    ["250000", "0", 20],
    ["400000", "30000", 25],
    ["800000", "130000", 30],
    ["2000000", "490000", 32],
    ["8000000", "2410000", 35],
  ],
};

const ANNEX_E: Record<PayrollPeriod, readonly BracketTuple[]> = {
  daily: [
    ["0", "0", 0],
    ["685", "0", 15],
    ["1096", "61.65", 20],
    ["2192", "280.85", 25],
    ["5479", "1102.60", 30],
    ["21918", "6034.30", 35],
  ],
  weekly: [
    ["0", "0", 0],
    ["4808", "0", 15],
    ["7692", "432.60", 20],
    ["15385", "1971.20", 25],
    ["38462", "7740.45", 30],
    ["153846", "42355.65", 35],
  ],
  semi_monthly: [
    ["0", "0", 0],
    ["10417", "0", 15],
    ["16667", "937.50", 20],
    ["33333", "4270.70", 25],
    ["83333", "16770.70", 30],
    ["333333", "91770.70", 35],
  ],
  monthly: [
    ["0", "0", 0],
    ["20833", "0", 15],
    ["33333", "1875", 20],
    ["66667", "8541.80", 25],
    ["166667", "33541.80", 30],
    ["666667", "183541.80", 35],
  ],
  annual: [
    ["0", "0", 0],
    ["250000", "0", 15],
    ["400000", "22500", 20],
    ["800000", "102500", 25],
    ["2000000", "402500", 30],
    ["8000000", "2202500", 35],
  ],
};

function expand(
  annex: WithholdingAnnex,
  tables: Record<PayrollPeriod, readonly BracketTuple[]>,
  effectiveFrom: string,
  effectiveTo: string | null,
  annexCitation: string,
  annualCitation: string,
): WithholdingBracketSeed[] {
  const periods: PayrollPeriod[] = ["daily", "weekly", "semi_monthly", "monthly", "annual"];
  return periods.flatMap((payrollPeriod) =>
    tables[payrollPeriod].map(([floorAmount, prescribedTax, ratePercent], bracketIndex) => {
      // The annual rows come from the RR body, not the annex — see the citation
      // constants. Same values, different instrument.
      let citation = payrollPeriod === "annual" ? annualCitation : annexCitation;
      if (annex === "E" && payrollPeriod === "daily" && bracketIndex === 5) {
        citation += ANNEX_E_DAILY_TOP_NOTE;
      }
      return {
        annex,
        payrollPeriod,
        bracketIndex,
        floorAmount,
        prescribedTax,
        rateBps: ratePercent * 100,
        effectiveFrom,
        effectiveTo,
        citation,
      };
    }),
  );
}

export const WITHHOLDING_BRACKETS: readonly WithholdingBracketSeed[] = [
  ...expand("D", ANNEX_D, ANNEX_D_FROM, ANNEX_D_TO, ANNEX_D_CITATION, ANNUAL_D_CITATION),
  ...expand("E", ANNEX_E, ANNEX_E_FROM, null, ANNEX_E_CITATION, ANNUAL_E_CITATION),
];

export interface DeMinimisCeilingSeed {
  benefitType: string;
  limitKind: DeMinimisLimitKind;
  limitAmount: string | null;
  permittedForms: string[] | null;
  qualifyingConditions: string[] | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  citation: string;
}

/** RR 11-2018 as amended by RR 4-2025 (eff. 2025-02-14) and RR 29-2025 (eff. 2026-01-06). */
const RR_11_2018_FROM = "2018-01-01";
const RR_4_2025_FROM = "2025-02-14";
const RR_29_2025_FROM = "2026-01-06";

/**
 * The eleven de minimis benefits, across three generations.
 *
 * Tuple: `[limitKind, rr11_2018, rr4_2025, rr29_2025]`. A `null` amount is only
 * legal with `uncapped`. Where a generation did not change the figure, the
 * value simply repeats — each generation gets its own effective-dated row so a
 * 2025 payroll run and a 2026 one resolve independently.
 */
const DE_MINIMIS: ReadonlyArray<
  readonly [
    benefitType: string,
    limitKind: DeMinimisLimitKind,
    v2018: string | null,
    v2025: string | null,
    v2026: string | null,
  ]
> = [
  ["monetized_unused_vacation_leave_private", "days_per_year", "10", "10", "12"],
  ["monetized_vl_sl_government", "uncapped", null, null, null],
  ["medical_cash_allowance_dependents", "peso_per_semester", "1500", "1500", "2000"],
  ["rice_subsidy", "peso_per_month", "2000", "2000", "2500"],
  ["uniform_clothing_allowance", "peso_per_year", "6000", "7000", "8000"],
  ["actual_medical_assistance", "peso_per_year", "10000", "10000", "12000"],
  ["laundry_allowance", "peso_per_month", "300", "300", "400"],
  ["employee_achievement_award", "peso_per_year", "10000", "10000", "12000"],
  ["christmas_anniversary_gifts", "peso_per_year", "5000", "5000", "6000"],
  ["daily_meal_allowance_ot_nightshift", "pct_of_regional_smw", "25", "25", "30"],
  ["cba_productivity_incentive", "peso_per_year", "10000", "10000", "12000"],
];

/**
 * The form dimension, which an amount-only table cannot represent.
 *
 * RR 4-2025 added cash and gift certificates as permitted forms of an employee
 * achievement award while leaving the amount at P10,000 — so the 2025 row
 * differs from the 2018 row in `permittedForms` alone.
 */
const AWARD_FORMS_2018 = ["tangible_personal_property"];
const AWARD_FORMS_2025 = ["tangible_personal_property", "cash", "gift_certificate"];

function permittedFormsFor(benefitType: string, generation: 2018 | 2025 | 2026): string[] | null {
  if (benefitType !== "employee_achievement_award") return null;
  return generation === 2018 ? AWARD_FORMS_2018 : AWARD_FORMS_2025;
}

/**
 * Non-amount conditions, which survive every amendment.
 *
 * The achievement award's exemption is subject to THREE cumulative conditions,
 * not one: the form, the occasion, and receipt under an established written
 * non-discriminatory plan. RR 4-2025 relaxed only the form limb and expressly
 * retained the other two. Failing any of them takes the whole award out of de
 * minimis rather than creating an excess, so the engine must be able to see
 * them — a permitted-forms list alone over-exempts.
 */
const AWARD_CONDITIONS = [
  "granted for length of service or safety achievement",
  "received under an established written plan",
  "the plan does not discriminate in favor of highly paid employees",
];

function qualifyingConditionsFor(benefitType: string): string[] | null {
  return benefitType === "employee_achievement_award" ? AWARD_CONDITIONS : null;
}

/**
 * Citations, which are per-benefit and NOT per-generation.
 *
 * Both 2025 regulations restate §2.78.1 only in part and elide the rest as
 * "xxx xxx xxx", so attributing every row of a generation to that generation's
 * RR is a false citation on otherwise-correct values — the same defect class
 * already noted above for the annual withholding rows.
 *
 *   RR 11-2018 restates only items (a)-(e). Items (f)-(j) survive unamended
 *   from RR 5-2011, and item (k) was ADDED by RR 1-2015 and appears in neither.
 *
 *   RR 4-2025 amended ONLY item (e) uniform and clothing allowance and item (h)
 *   employee achievement awards. The other nine keep their prior authority.
 *
 * RR 29-2025 does restate the full enumeration, so every 2026 row genuinely
 * cites it.
 */
const RR_5_2011 = "RR 5-2011 Sec. 2.78.1(A)(3) (unamended by RR 11-2018, which elides it)";
const RR_1_2015 = "RR 1-2015 (added item (k); unamended by RR 11-2018, which elides it)";
const RR_11_2018_CITATION = "RR 11-2018 Sec. 4 (amending RR 2-98 Sec. 2.78.1(A)(3))";

/** Items (a)-(e) — the only ones RR 11-2018 actually restates. */
const RESTATED_BY_RR_11_2018 = new Set([
  "monetized_unused_vacation_leave_private",
  "monetized_vl_sl_government",
  "medical_cash_allowance_dependents",
  "rice_subsidy",
  "uniform_clothing_allowance",
]);

/** The only two items RR 4-2025 amended. */
const AMENDED_BY_RR_4_2025 = new Set(["uniform_clothing_allowance", "employee_achievement_award"]);

function citation2018(benefitType: string): string {
  if (RESTATED_BY_RR_11_2018.has(benefitType)) return RR_11_2018_CITATION;
  if (benefitType === "cba_productivity_incentive") return RR_1_2015;
  return RR_5_2011;
}

function citation2025(benefitType: string): string {
  return AMENDED_BY_RR_4_2025.has(benefitType)
    ? "RR 4-2025 (published 30 Jan 2025; effectivity 14 Feb 2025 per professional sources — " +
        "the RR itself states no publication date)"
    : `unamended by RR 4-2025, which elides this item — authority remains ${citation2018(benefitType)}`;
}

export const DE_MINIMIS_CEILINGS: readonly DeMinimisCeilingSeed[] = DE_MINIMIS.flatMap(
  ([benefitType, limitKind, v2018, v2025, v2026]) => [
    {
      benefitType,
      limitKind,
      limitAmount: v2018,
      permittedForms: permittedFormsFor(benefitType, 2018),
      qualifyingConditions: qualifyingConditionsFor(benefitType),
      effectiveFrom: RR_11_2018_FROM,
      effectiveTo: "2025-02-13",
      citation: citation2018(benefitType),
    },
    {
      benefitType,
      limitKind,
      limitAmount: v2025,
      permittedForms: permittedFormsFor(benefitType, 2025),
      qualifyingConditions: qualifyingConditionsFor(benefitType),
      effectiveFrom: RR_4_2025_FROM,
      effectiveTo: "2026-01-05",
      citation: citation2025(benefitType),
    },
    {
      benefitType,
      limitKind,
      limitAmount: v2026,
      permittedForms: permittedFormsFor(benefitType, 2026),
      qualifyingConditions: qualifyingConditionsFor(benefitType),
      effectiveFrom: RR_29_2025_FROM,
      effectiveTo: null,
      // DECISIONS U6: the 6 January 2026 date is derived from the 22 December
      // 2025 issuance date and corroborated by KPMG/PwC, not read off an
      // Official Gazette publication page. Verify before relying on the boundary.
      citation: "RR 29-2025 (effective ~6 January 2026 — publication date unverified, U6)",
    },
  ],
);

export interface SeedResult {
  datasetInserted: boolean;
  brackets: { inserted: number; skipped: number };
  deMinimis: { inserted: number; skipped: number };
}

/**
 * Seed the catalog. Idempotent, additive, and never updates an existing row.
 *
 * `onConflictDoNothing` is load-bearing — see the file header.
 */
export async function seedTaxReference(
  // The concrete driver type varies between the app pool and the seeder's own
  // client; the catalog only needs `insert`.
  db: PostgresJsDatabase<Record<string, unknown>>,
): Promise<SeedResult> {
  const dataset = await db
    .insert(taxReferenceDatasets)
    .values({ version: DATASET_V1.version, sourceNote: DATASET_V1.sourceNote })
    .onConflictDoNothing()
    .returning({ version: taxReferenceDatasets.version });

  const brackets = await db
    .insert(taxWithholdingTables)
    .values(WITHHOLDING_BRACKETS.map((row) => ({ ...row, datasetVersion: DATASET_V1.version })))
    .onConflictDoNothing()
    .returning({ id: taxWithholdingTables.id });

  const ceilings = await db
    .insert(taxDeMinimisCeilings)
    .values(DE_MINIMIS_CEILINGS.map((row) => ({ ...row, datasetVersion: DATASET_V1.version })))
    .onConflictDoNothing()
    .returning({ id: taxDeMinimisCeilings.id });

  return {
    datasetInserted: dataset.length > 0,
    brackets: {
      inserted: brackets.length,
      skipped: WITHHOLDING_BRACKETS.length - brackets.length,
    },
    deMinimis: {
      inserted: ceilings.length,
      skipped: DE_MINIMIS_CEILINGS.length - ceilings.length,
    },
  };
}

/** Read-only: is the catalog present and complete on this database? */
export async function taxReferenceStatus(db: PostgresJsDatabase<Record<string, unknown>>) {
  const rows = (await db.execute(sql`
    SELECT
      (SELECT count(*) FROM tax_withholding_tables
        WHERE dataset_version = ${DATASET_V1.version})::int AS brackets,
      (SELECT count(*) FROM tax_de_minimis_ceilings
        WHERE dataset_version = ${DATASET_V1.version})::int AS ceilings,
      (SELECT last_verified_at FROM tax_reference_datasets
        WHERE version = ${DATASET_V1.version})           AS last_verified_at
  `)) as unknown;
  const [row] = (
    Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])
  ) as Array<{
    brackets: number;
    ceilings: number;
    last_verified_at: string | null;
  }>;
  return {
    brackets: { actual: row?.brackets ?? 0, expected: WITHHOLDING_BRACKETS.length },
    deMinimis: { actual: row?.ceilings ?? 0, expected: DE_MINIMIS_CEILINGS.length },
    lastVerifiedAt: row?.last_verified_at ?? null,
  };
}
