/**
 * Turn a computed payroll run into the January artifacts: 2316 per employee
 * and the 1604-C Schedule 1 alphalist.
 *
 * Blocking issues stay visible. A certificate with no employer TIN is still
 * generated, watermarked by form-2316-pdf, rather than silently omitted.
 */
import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { partyTaxProfiles } from "@/db/schema/party-tax";
import {
  payrollEmployeeYearState,
  payrollLines,
  payrollRuns,
  previousEmployer2316,
} from "@/db/schema/payroll";
import { orgTaxProfiles } from "@/db/schema/tax-reference";
import { preflightAlphalist } from "@/lib/tax/alphalist-preflight";
import { encodeDat } from "@/lib/tax/dat-encoder";
import { ALPHALIST_1604C_HEADER, ALPHALIST_1604C_SCHEDULE_1_DETAIL } from "@/lib/tax/dat-layouts";
import { buildForm2316, type Form2316 } from "@/lib/tax/form-2316";
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

function retrnPeriod(periodEnd: string): string {
  const [year, month, day] = periodEnd.split("-");
  return `${month}/${day}/${year}`;
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

  const lines = await db
    .select()
    .from(payrollLines)
    .where(
      and(eq(payrollLines.payrollRunId, runId), eq(payrollLines.organizationId, organizationId)),
    );

  const certificates: IssuedPayrollArtifacts["certificates"] = [];
  const detailRecords: Array<Record<string, string>> = [];
  const preflightRows = [];

  for (const [index, line] of lines.entries()) {
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

    const [yearState] = await db
      .select()
      .from(payrollEmployeeYearState)
      .where(
        and(
          eq(payrollEmployeeYearState.organizationId, organizationId),
          eq(payrollEmployeeYearState.employeePartyId, line.employeePartyId),
          eq(payrollEmployeeYearState.taxableYear, run.taxableYear),
        ),
      )
      .limit(1);

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
    const taxWithheld = line.reportedTaxWithheld ?? line.computedTaxWithheld ?? "0";
    const taxDue = yearState?.ytdTaxWithheld ?? taxWithheld;

    const form = buildForm2316({
      taxableYear: run.taxableYear,
      employer: {
        tin: employer.tin,
        branchCode: employer.branchCode ?? "00000",
        registeredName: employer.registeredName,
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
    });

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
      retrnPeriod: retrnPeriod(run.periodEnd),
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
      retrnPeriod: retrnPeriod(run.periodEnd),
    },
  ]);
  const details = encodeDat(ALPHALIST_1604C_SCHEDULE_1_DETAIL, detailRecords);
  const blockingIssues = [
    ...certificates.flatMap((c) => c.form.blockingIssues),
    ...findings.filter((f) => f.severity === "fatal").map((f) => `${f.code}: ${f.message}`),
  ];

  return {
    runId,
    certificates,
    alphalist: {
      fileName: `1604C-${employer.tin}-${run.taxableYear}.dat`,
      content: header.content + details.content,
      blockingIssues,
    },
  };
}
