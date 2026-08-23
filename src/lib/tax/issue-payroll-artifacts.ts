/**
 * Turn a computed payroll run into the January artifacts: 2316 per employee
 * and the 1604-C Schedule 1 alphalist.
 *
 * Blocking issues stay visible. A certificate with no employer TIN is still
 * generated, watermarked by form-2316-pdf, rather than silently omitted.
 */
import { and, asc, eq, isNotNull, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { partyTaxProfiles } from "@/db/schema/party-tax";
import { payrollLines, payrollRuns, previousEmployer2316 } from "@/db/schema/payroll";
import { orgTaxProfiles } from "@/db/schema/tax-reference";
import { preflightAlphalist } from "@/lib/tax/alphalist-preflight";
import { encodeDat } from "@/lib/tax/dat-encoder";
import { ALPHALIST_1604C_HEADER, ALPHALIST_1604C_SCHEDULE_1_DETAIL } from "@/lib/tax/dat-layouts";
import { annualize } from "@/lib/tax/annualization";
import { buildForm2316, type Form2316 } from "@/lib/tax/form-2316";
import { taxWithholdingTables } from "@/db/schema/tax-reference";
import type { Bracket } from "@/lib/tax/withholding";
import { form2316PdfBuffer } from "@/lib/tax/form-2316-pdf";
import { addAll, fromScaled, toScaled } from "@/lib/tax/money";

export interface IssuedPayrollArtifacts {
  runId: string;
  certificates: Array<{ employeePartyId: string; form: Form2316; pdfBase64: string }>;
  alphalist: { fileName: string; content: string; blockingIssues: string[] };
}

function money(value: string | null | undefined): string {
  return value ?? "0";
}

/**
 * The 1604-C is an ANNUAL information return: its return period is 12/31 of
 * the taxable year, never the issuing run's own period end (a November run
 * used to stamp 11/30 on the header and every detail row).
 */
function annualReturnPeriod(taxableYear: number): string {
  return `12/31/${taxableYear}`;
}

const SUM_COLUMNS = [
  "basicSalaryMwe",
  "holidayPayMwe",
  "overtimePayMwe",
  "nightShiftDifferentialMwe",
  "hazardPayMwe",
  "thirteenthMonthAndOtherBenefits",
  "deMinimisBenefits",
  "sssEmployeeShare",
  "philHealthEmployeeShare",
  "pagIbigEmployeeShare",
  "unionDues",
  "otherExempt",
  "basicSalary",
  "representationAllowance",
  "transportationAllowance",
  "costOfLivingAllowance",
  "fixedHousingAllowance",
  "otherTaxableRegular",
  "commission",
  "profitSharing",
  "directorsFees",
  "hazardPay",
  "overtimePay",
  "otherTaxableSupplementary",
] as const;

type YearTotals = Record<(typeof SUM_COLUMNS)[number], string> & {
  employeePartyId: string;
  taxWithheld: string;
};

/** Annual brackets in force at year end, for the annualized tax due. */
async function loadAnnualBrackets(db: DbExecutor, taxableYear: number): Promise<Bracket[]> {
  const at = `${taxableYear}-12-31`;
  const rows = await db
    .select()
    .from(taxWithholdingTables)
    .where(eq(taxWithholdingTables.payrollPeriod, "annual"))
    .orderBy(asc(taxWithholdingTables.bracketIndex));
  return rows
    .filter((r) => r.effectiveFrom <= at && (r.effectiveTo == null || r.effectiveTo >= at))
    .map((r) => ({
      bracketIndex: r.bracketIndex,
      floorAmount: r.floorAmount,
      prescribedTax: r.prescribedTax,
      rateBps: r.rateBps,
    }));
}

type EmployerProfileRow = {
  tin: string | null;
  branchCode: string | null;
  registeredName: string | null;
};

function form2316Input(
  taxableYear: number,
  employer: EmployerProfileRow,
  profile: any,
  line: YearTotals,
  contributions: string,
  previous: any,
  taxWithheld: string,
  taxDue: string,
) {
  return {
    taxableYear,
    employer: {
      // Nullability is guarded at the entry point (the run refuses to issue
      // without employer TIN + name); the coalesce keeps the helper total.
      tin: employer.tin ?? "",
      branchCode: employer.branchCode ?? "00000",
      registeredName: employer.registeredName ?? "",
      address: "",
      isMainEmployer: true,
    },
    employee: {
      tin: profile.tin ?? "",
      lastName: profile.lastName ?? "",
      firstName: profile.firstName ?? "",
      middleName: profile.middleName ?? "",
      address: [profile.addressLine1, profile.city].filter(Boolean).join(", "),
      birthDate: profile.birthDate,
      dateHired: profile.dateHired,
      dateSeparated: profile.dateSeparated,
      isMinimumWageEarner: profile.isMinimumWageEarner,
      substitutedFilingEligible: profile.substitutedFilingEligible,
    },
    compensation: {
      basicSalaryMwe: money(line.basicSalaryMwe),
      holidayPayMwe: money(line.holidayPayMwe),
      overtimePayMwe: money(line.overtimePayMwe),
      nightShiftDifferentialMwe: money(line.nightShiftDifferentialMwe),
      hazardPayMwe: money(line.hazardPayMwe),
      thirteenthMonthAndOtherBenefits: money(line.thirteenthMonthAndOtherBenefits),
      deMinimisBenefits: money(line.deMinimisBenefits),
      mandatoryContributions: contributions,
      otherNonTaxable: money(line.otherExempt),
      basicSalary: money(line.basicSalary),
      representationAllowance: money(line.representationAllowance),
      transportationAllowance: money(line.transportationAllowance),
      costOfLivingAllowance: money(line.costOfLivingAllowance),
      fixedHousingAllowance: money(line.fixedHousingAllowance),
      otherTaxableRegular: money(line.otherTaxableRegular),
      commission: money(line.commission),
      profitSharing: money(line.profitSharing),
      directorsFees: money(line.directorsFees),
      taxableThirteenthMonthAndOtherBenefits: "0",
      hazardPay: money(line.hazardPay),
      overtimePay: money(line.overtimePay),
      otherTaxableSupplementary: money(line.otherTaxableSupplementary),
    },
    previousEmployer: previous
      ? {
          tin: previous.previousEmployerTin ?? "",
          registeredName: previous.previousEmployerName,
          taxableCompensation: previous.taxableCompensation,
          taxWithheld: previous.taxWithheld,
        }
      : null,
    taxWithheldByThisEmployer: taxWithheld,
    taxDue,
  };
}

export async function issuePayrollArtifacts(
  db: DbExecutor,
  organizationId: string,
  runId: string,
): Promise<IssuedPayrollArtifacts> {
  const [run] = await db
    .select()
    .from(payrollRuns)
    .where(and(eq(payrollRuns.id, runId), eq(payrollRuns.organizationId, organizationId)))
    .limit(1);
  if (!run) throw new Error("Payroll run not found");
  if (
    !run.computedAt &&
    run.status !== "computed" &&
    run.status !== "acknowledged" &&
    run.status !== "locked"
  ) {
    throw new Error("Compute the run before issuing 2316 or the alphalist.");
  }

  const [employer] = await db
    .select()
    .from(orgTaxProfiles)
    .where(eq(orgTaxProfiles.organizationId, organizationId))
    .limit(1);
  if (!employer?.tin || !employer.registeredName) {
    throw new Error("Save the employer TIN and registered name on /payroll first.");
  }

  // YEAR-SCOPED, not run-scoped. The 2316 and the 1604-C report the taxable
  // YEAR; building them from one run's lines under-reported every employee by
  // a factor equal to the number of periods (the audit's second critical).
  // payroll_employee_year_state carries only collapsed aggregates, so the
  // per-component figures the artifacts need are summed from payroll_lines
  // across every computed run of the year.
  const sumExprs = Object.fromEntries(
    SUM_COLUMNS.map((column) => [
      column,
      // Peso strings (2dp) straight from SQL: the raw scale-8 SUM ("….00000000")
      // is 15 characters at ₱100,000 and the .DAT layouts refuse width > 14.
      sql<string>`(COALESCE(SUM(COALESCE(${payrollLines[column]}, 0)), 0))::numeric(18,2)`,
    ]),
  ) as Record<(typeof SUM_COLUMNS)[number], ReturnType<typeof sql<string>>>;
  const yearTotals = (await db
    .select({
      employeePartyId: payrollLines.employeePartyId,
      ...sumExprs,
      taxWithheld: sql<string>`(COALESCE(SUM(COALESCE(${payrollLines.reportedTaxWithheld}, ${payrollLines.computedTaxWithheld}, 0)), 0))::numeric(18,2)`,
    })
    .from(payrollLines)
    .innerJoin(payrollRuns, eq(payrollLines.payrollRunId, payrollRuns.id))
    .where(
      and(
        eq(payrollRuns.organizationId, organizationId),
        eq(payrollRuns.taxableYear, run.taxableYear),
        isNotNull(payrollRuns.computedAt),
      ),
    )
    .groupBy(payrollLines.employeePartyId)) as YearTotals[];

  const annualBrackets = await loadAnnualBrackets(db, run.taxableYear);

  const certificates: IssuedPayrollArtifacts["certificates"] = [];
  const detailRecords: Array<Record<string, string>> = [];
  const preflightRows = [];

  for (const [index, line] of yearTotals.entries()) {
    const [profile] = await db
      .select()
      .from(partyTaxProfiles)
      .where(
        and(
          eq(partyTaxProfiles.organizationId, organizationId),
          eq(partyTaxProfiles.partyId, line.employeePartyId),
        ),
      )
      .limit(1);
    if (!profile) {
      throw new Error(`Employee ${line.employeePartyId} has no tax profile.`);
    }

    const [previous] = await db
      .select()
      .from(previousEmployer2316)
      .where(
        and(
          eq(previousEmployer2316.organizationId, organizationId),
          eq(previousEmployer2316.employeePartyId, line.employeePartyId),
          eq(previousEmployer2316.taxableYear, run.taxableYear),
        ),
      )
      .limit(1);

    const contributions = fromScaled(
      addAll(
        toScaled(line.sssEmployeeShare ?? "0"),
        toScaled(line.philHealthEmployeeShare ?? "0"),
        toScaled(line.pagIbigEmployeeShare ?? "0"),
        toScaled(line.unionDues ?? "0"),
      ),
    );
    const taxWithheld = line.taxWithheld;

    // taxDue comes from ANNUALIZATION, never from the amount withheld — the
    // audit's third critical set taxDue = ytdTaxWithheld, which made
    // refundOrDeficiency structurally zero: an over-withheld employee showed
    // a 0.00 refund and an under-withheld one showed nothing owed. The form
    // computes its own present-employer taxable total (it owns the MWE
    // rules), so build it once to obtain that figure, annualize, then build
    // again with the real tax due. buildForm2316 is pure; the double call is
    // the price of not re-implementing its aggregation here.
    const draft = buildForm2316(
      form2316Input(
        run.taxableYear,
        employer,
        profile,
        line,
        contributions,
        previous,
        taxWithheld,
        "0",
      ),
    );
    const annualization =
      annualBrackets.length > 0
        ? annualize({
            trigger: "year_end",
            taxableRegular: draft.totalTaxableFromPresentEmployer,
            taxableSupplementary: "0",
            previousEmployerTaxable: previous?.taxableCompensation ?? "0",
            taxWithheldByThisEmployer: taxWithheld,
            taxWithheldByPreviousEmployer: previous?.taxWithheld ?? "0",
            annualBrackets,
          })
        : null;
    const taxDue = annualization ? annualization.taxDuePesos : "0";

    const form = buildForm2316(
      form2316Input(
        run.taxableYear,
        employer,
        profile,
        line,
        contributions,
        previous,
        taxWithheld,
        taxDue,
      ),
    );

    certificates.push({
      employeePartyId: line.employeePartyId,
      form,
      pdfBase64: form2316PdfBuffer(form),
    });

    preflightRows.push({
      tin: profile.tin,
      branchCode: profile.branchCode,
      lastName: profile.lastName,
      firstName: profile.firstName,
      registeredName: null,
      amount: taxWithheld,
    });

    const presentNonTax = form.totalNonTaxable;
    const presentTaxable = form.totalTaxableFromPresentEmployer;
    detailRecords.push({
      tinEmpyr: employer.tin,
      branchCodeEmplyr: (employer.branchCode ?? "00000").slice(0, 4),
      retrnPeriod: annualReturnPeriod(run.taxableYear),
      seqNum: String(index + 1),
      tin: profile.tin ?? "",
      branchCode: (profile.branchCode ?? "00000").slice(0, 4),
      lastName: profile.lastName ?? "",
      firstName: profile.firstName ?? "",
      middleName: profile.middleName ?? "",
      regionNum: profile.regionCode ?? "",
      prevNontaxGrossCompIncome: previous?.nonTaxableCompensation ?? "0",
      prevNontaxBasicSmw: previous?.mweCompensation ?? "0",
      prevNontax13thMonth: "0",
      prevNontaxDeMinimis: "0",
      prevNontaxSssEtc: "0",
      prevNontaxSalaries: "0",
      prevTotalNontaxCompIncome: previous?.nonTaxableCompensation ?? "0",
      prevTaxableBasicSalary: previous?.taxableCompensation ?? "0",
      prevTaxable13thMonth: "0",
      prevTaxableSalaries: "0",
      prevTotalTaxable: previous?.taxableCompensation ?? "0",
      employmentFrom: profile.dateHired ?? run.periodStart,
      employmentTo: profile.dateSeparated ?? run.periodEnd,
      presNontaxGrossCompIncome: presentNonTax,
      presNontaxBasicSmw: money(line.basicSalaryMwe),
      presNontax13thMonth: money(line.thirteenthMonthAndOtherBenefits),
      presNontaxDeMinimis: money(line.deMinimisBenefits),
      presNontaxSssEtc: contributions,
      presNontaxSalaries: "0",
      presTotalNontaxCompIncome: presentNonTax,
      presTaxableBasicSalary: money(line.basicSalary),
      presTaxable13thMonth: "0",
      presTaxableSalaries: presentTaxable,
      presTotalTaxable: presentTaxable,
      grossCompIncome: fromScaled(addAll(toScaled(presentNonTax), toScaled(presentTaxable))),
      netTaxableCompIncome: form.grossTaxableIncome,
      taxDue: form.taxDue,
      prevTaxWthld: previous?.taxWithheld ?? "0",
      presTaxWthld: taxWithheld,
      amtWthldDec: "0",
      overWthld: form.refundOrDeficiency.startsWith("-") ? "0" : form.refundOrDeficiency,
      actualAmtWthld: form.totalTaxWithheld,
      nationality: "FILIPINO",
      employmentStatus: profile.dateSeparated ? "S" : "RE",
      reasonSeparation: "",
      subsFiling: profile.substitutedFilingEligible ? "Y" : "N",
      taxCreditPera: "0",
    });
  }

  const findings = preflightAlphalist(preflightRows);
  const header = encodeDat(ALPHALIST_1604C_HEADER, [
    {
      tin: employer.tin,
      branchCode: (employer.branchCode ?? "00000").slice(0, 4),
      retrnPeriod: annualReturnPeriod(run.taxableYear),
    },
  ]);
  const details = encodeDat(ALPHALIST_1604C_SCHEDULE_1_DETAIL, detailRecords);
  const blockingIssues = [
    ...certificates.flatMap((c) => c.form.blockingIssues),
    ...findings.filter((f) => f.severity === "fatal").map((f) => `${f.code}: ${f.message}`),
  ];

  // The 1604-C layout mandates one Header, N Details, ONE CONTROL record per
  // schedule — and the C1 control record layout is still untranscribed
  // (dat-layouts UNTRANSCRIBED_LAYOUTS). A file without it will be rejected
  // by the BIR validation module, so the gap is made LOUD: the filename
  // cannot be mistaken for a submittable .dat, and the blocking issue names
  // exactly what is missing. The 2316 certificates are unaffected.
  const controlRecordMissing = true;
  const fileName = controlRecordMissing
    ? `1604C-${employer.tin}-${run.taxableYear}.dat.incomplete`
    : `1604C-${employer.tin}-${run.taxableYear}.dat`;
  if (controlRecordMissing) {
    blockingIssues.unshift(
      "1604C_C1_CONTROL_UNTRANSCRIBED: the Schedule 1 control record layout has not been " +
        "transcribed (docs/tax/IMPLEMENTATION-PLAN.md, .DAT spike) — this file is a PREVIEW and " +
        "must not be submitted.",
    );
  }

  return {
    runId,
    certificates,
    alphalist: {
      fileName,
      content: header.content + details.content,
      blockingIssues,
    },
  };
}
