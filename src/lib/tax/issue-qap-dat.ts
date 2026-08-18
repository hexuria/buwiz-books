/** Encode a QAP .DAT from stored withholding payments. Schedule 1 only. */
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

function taxRate(atc: string): string {
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
}): { fileName: string; content: string; blockingIssues: string[] } {
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
      taxRate: taxRate(line.atc),
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
  return {
    fileName: `1601EQ-QAP-${tin}-${input.periodEnd.slice(0, 7)}.dat`,
    content: header.content + details.content + control.content,
    blockingIssues: qap.blockingIssues,
  };
}
