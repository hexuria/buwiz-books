/** Encode a QAP .DAT from stored withholding payments. Schedule 1 only. */
import { moneyToCents } from "../money";
import { preflightAlphalist } from "./alphalist-preflight";
import { ATC_EXPECTED_RATE_BPS } from "./certificate-2307";
import { encodeDat } from "./dat-encoder";
import {
  QAP_1601EQ_HEADER,
  QAP_1601EQ_SCHEDULE_1_CONTROL,
  QAP_1601EQ_SCHEDULE_1_DETAIL,
} from "./dat-layouts";
import { buildQap, type QapPayment } from "./ewt";

function mmYyyy(isoDate: string): string {
  return `${isoDate.slice(5, 7)}/${isoDate.slice(0, 4)}`;
}

/**
 * The rate the QAP reports must be the rate that was ACTUALLY applied —
 * withheld ÷ base — not the ATC's table rate. The two diverge legitimately
 * (WC011's over-₱720k 15% band shares the ATC family with the 10% band),
 * and the BIR validation module cross-foots rate × base against the
 * withheld column. Falls back to the table rate only when the base is zero.
 */
function taxRate(atc: string, incomePayment: string, taxWithheld: string): string {
  const incomeCents = moneyToCents(incomePayment, "QAP income payment");
  if (incomeCents !== 0) {
    const withheldCents = moneyToCents(taxWithheld, "QAP tax withheld");
    return ((withheldCents / incomeCents) * 100).toFixed(2);
  }
  const bps = ATC_EXPECTED_RATE_BPS[atc];
  return bps == null ? "0" : (bps / 100).toFixed(2);
}

export function issueQapDat(input: {
  payorTin: string;
  payorBranchCode: string;
  payorRegisteredName: string;
  rdoCode?: string | null;
  periodStart: string;
  periodEnd: string;
  payments: QapPayment[];
}): { fileName: string; content: string; blockingIssues: string[]; warnings: string[] } {
  const qap = buildQap({
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    payments: input.payments,
  });
  const tin = input.payorTin.replace(/\D/g, "").slice(0, 9);
  const branch = (input.payorBranchCode || "0000").slice(0, 4);
  const retrnPeriod = mmYyyy(input.periodEnd);
  const header = encodeDat(QAP_1601EQ_HEADER, [
    {
      tinWa: tin,
      branchCodeWa: branch,
      registeredNameWa: input.payorRegisteredName,
      retrnPeriod,
      rdoCodeWa: (input.rdoCode ?? "").slice(0, 3),
    },
  ]);
  const details = encodeDat(
    QAP_1601EQ_SCHEDULE_1_DETAIL,
    qap.lines.map((line, index) => ({
      seqNum: String(index + 1),
      tinPayee: line.payeeTin.replace(/\D/g, "").slice(0, 9),
      branchCodePayee:
        line.payeeTin.replace(/\D/g, "").slice(9, 13).padEnd(4, "0").slice(0, 4) || "0000",
      registeredNamePayee: line.payeeRegisteredName,
      lastNamePayee: "",
      firstNamePayee: "",
      middleNamePayee: "",
      retrnPeriod,
      atcCode: line.atc.slice(0, 5),
      taxRate: taxRate(line.atc, line.incomePayment, line.taxWithheld),
      incomePayment: line.incomePayment,
      actualAmtWthld: line.taxWithheld,
    })),
  );
  const control = encodeDat(QAP_1601EQ_SCHEDULE_1_CONTROL, [
    {
      tinWa: tin,
      branchCodeWa: branch,
      retrnPeriod,
      incomePayment: qap.totalIncomePayment,
      actualAmtWthld: qap.totalTaxWithheld,
    },
  ]);
  // The QAP is an alphalist too: the same RMC rules (real TINs, no lumped
  // "VARIOUS" payees, no zero-amount rows) apply to Schedule 1 payees.
  const findings = preflightAlphalist(
    qap.lines.map((line) => ({
      tin: line.payeeTin.replace(/\D/g, "").slice(0, 9) || null,
      branchCode: null,
      lastName: null,
      firstName: null,
      registeredName: line.payeeRegisteredName,
      amount: line.incomePayment,
    })),
  );

  return {
    fileName: `1601EQ-QAP-${tin}-${input.periodEnd.slice(0, 7)}.dat`,
    content: header.content + details.content + control.content,
    blockingIssues: [
      ...qap.blockingIssues,
      ...findings.filter((f) => f.severity === "fatal").map((f) => `${f.code}: ${f.message}`),
    ],
    warnings: findings
      .filter((f) => f.severity === "warning")
      .map((f) => `${f.code}: ${f.message}`),
  };
}
