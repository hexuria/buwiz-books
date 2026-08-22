/**
 * `.DAT` record layouts, transcribed from RMC 25-2024 Annex A.
 *
 * Annex A is the published field-level specification, and RMC 25-2024 makes it
 * binding: taxpayers using their own extract program "shall strictly observe
 * the revised file structures and standard naming conventions".
 *
 * Every alphalist file is three record types — exactly one Header, N Details,
 * one Control per schedule — and the first field of every record is a
 * discriminator. The discriminator SCHEME differs by form family, which is one
 * of several reasons a per-form hand-written serializer goes wrong:
 *
 *   QAP (1601EQ/1601FQ)  header carries ALPHA_TYPE='HQAP', but details and
 *                        controls use SCHEDULE_NUM (D1/D2/D3, C1/C2/C3) instead
 *   annual (1604C/E/F)   the header has NO ALPHA_TYPE at all — it begins with
 *                        FTYPE_CODE
 *
 * ── THREE TRAPS THAT A "REASONABLE" IMPLEMENTATION WOULD FALL INTO ───────────
 *
 *   FIELD ORDER DIFFERS BETWEEN FORMS FOR IDENTICAL FIELDS. 1601EQ Schedule 1
 *   puts SEQ_NUM at position 3; 1601FQ Schedule 1 puts it at position 10. Same
 *   name, same meaning, different slot. Sharing one serializer across the two
 *   silently shifts every field between.
 *
 *   DATE FORMATS DIFFER BY FAMILY. QAP and MAP use MM/YYYY; the annual
 *   alphalists use MM/DD/YYYY. A shared date formatter writes the wrong width.
 *
 *   DECIMALS DIFFER BETWEEN SCHEDULES OF THE SAME FORM. 1604-C Schedule 1
 *   pictures money as 9(11).99, but Schedule 2 — the minimum wage earners —
 *   pictures it 9(11).00, with ZERO decimals. The same employee's pay is
 *   written differently depending on which schedule they land in.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 * Where a layout is not transcribed here, it is because the source page was not
 * retrieved — NOT because it is unnecessary. Inventing a field order for a
 * 59-field record is exactly the silent corruption this module exists to
 * prevent, so those are declared absent and named in `UNTRANSCRIBED_LAYOUTS`.
 */
import type { DatField, DatLayout } from "./dat-encoder";

const text = (pos: number, name: string, width: number): DatField => ({
  pos,
  name,
  type: "text",
  width,
});
const num = (pos: number, name: string, width: number): DatField => ({
  pos,
  name,
  type: "numeric",
  width,
});
const date = (pos: number, name: string, width: number): DatField => ({
  pos,
  name,
  type: "date",
  width,
});
const lit = (pos: number, name: string, value: string): DatField => ({
  pos,
  name,
  type: "literal",
  value,
});

/** Money is NUMBER 14, pictured 9(11).99 — eleven digits and two decimals. */
const money = (pos: number, name: string): DatField => num(pos, name, 14);

// ─── QAP for 1601-EQ ─────────────────────────────────────────────────────────

export const QAP_1601EQ_HEADER: DatLayout = {
  formCode: "1601EQ",
  scheduleNumber: 0,
  recordType: "header",
  fields: [
    lit(1, "alphaType", "HQAP"),
    lit(2, "ftypeCode", "H1601EQ"),
    text(3, "tinWa", 9),
    text(4, "branchCodeWa", 4),
    text(5, "registeredNameWa", 50),
    date(6, "retrnPeriod", 7), // MM/YYYY
    text(7, "rdoCodeWa", 3),
  ],
};

export const QAP_1601EQ_SCHEDULE_1_DETAIL: DatLayout = {
  formCode: "1601EQ",
  scheduleNumber: 1,
  recordType: "detail",
  fields: [
    lit(1, "scheduleNum", "D1"),
    lit(2, "ftypeCode", "1601EQ"),
    // Position 3 here, but position 10 on 1601FQ — the trap.
    num(3, "seqNum", 8),
    text(4, "tinPayee", 9),
    text(5, "branchCodePayee", 4),
    text(6, "registeredNamePayee", 50),
    text(7, "lastNamePayee", 30),
    text(8, "firstNamePayee", 30),
    text(9, "middleNamePayee", 30),
    date(10, "retrnPeriod", 7),
    text(11, "atcCode", 5),
    num(12, "taxRate", 5), // 9(2).99
    money(13, "incomePayment"),
    money(14, "actualAmtWthld"),
  ],
};

export const QAP_1601EQ_SCHEDULE_1_CONTROL: DatLayout = {
  formCode: "1601EQ",
  scheduleNumber: 1,
  recordType: "control",
  fields: [
    lit(1, "alphaType", "C1"),
    lit(2, "ftypeCode", "1601EQ"),
    text(3, "tinWa", 9),
    text(4, "branchCodeWa", 4),
    date(5, "retrnPeriod", 7),
    money(6, "incomePayment"),
    money(7, "actualAmtWthld"),
  ],
};

/** Schedule 2 is the exempt / zero-rated schedule: no tax rate, no amount withheld. */
export const QAP_1601EQ_SCHEDULE_2_DETAIL: DatLayout = {
  formCode: "1601EQ",
  scheduleNumber: 2,
  recordType: "detail",
  fields: [
    lit(1, "scheduleNum", "D2"),
    lit(2, "ftypeCode", "1601EQ"),
    num(3, "seqNum", 8),
    text(4, "tinPayee", 9),
    text(5, "branchCodePayee", 4),
    text(6, "registeredNamePayee", 50),
    text(7, "lastNamePayee", 30),
    text(8, "firstNamePayee", 30),
    text(9, "middleNamePayee", 30),
    date(10, "retrnPeriod", 7),
    text(11, "atcCode", 5),
    money(12, "incomePayment"),
  ],
};

export const QAP_1601EQ_SCHEDULE_2_CONTROL: DatLayout = {
  formCode: "1601EQ",
  scheduleNumber: 2,
  recordType: "control",
  fields: [
    lit(1, "alphaType", "C2"),
    lit(2, "ftypeCode", "1601EQ"),
    text(3, "tinWa", 9),
    text(4, "branchCodeWa", 4),
    date(5, "retrnPeriod", 7),
    money(6, "incomePayment"),
  ],
};

// ─── 1604-C annual alphalist ─────────────────────────────────────────────────

/** Only four fields — and note the date is MM/DD/YYYY, unlike the QAP's MM/YYYY. */
export const ALPHALIST_1604C_HEADER: DatLayout = {
  formCode: "1604C",
  scheduleNumber: 0,
  recordType: "header",
  fields: [
    // No ALPHA_TYPE: the annual families start straight at FTYPE_CODE.
    lit(1, "ftypeCode", "H1604C"),
    text(2, "tin", 9),
    text(3, "branchCode", 4),
    date(4, "retrnPeriod", 10), // MM/DD/YYYY
  ],
};

/**
 * Schedule 1 — "Alphalist of Employees Declared and Certified using BIR Form
 * No. 2316". 49 fields.
 *
 * The previous-employer block is why a mid-year hire's prior 2316 is a blocking
 * intake requirement rather than a nicety: eleven of these fields have no source
 * other than that certificate.
 */
export const ALPHALIST_1604C_SCHEDULE_1_DETAIL: DatLayout = {
  formCode: "1604C",
  scheduleNumber: 1,
  recordType: "detail",
  fields: [
    lit(1, "scheduleNum", "D1"),
    lit(2, "ftypeCode", "1604C"),
    text(3, "tinEmpyr", 9),
    text(4, "branchCodeEmplyr", 4),
    date(5, "retrnPeriod", 10),
    num(6, "seqNum", 6),
    text(7, "tin", 9),
    text(8, "branchCode", 4),
    text(9, "lastName", 30),
    text(10, "firstName", 30),
    text(11, "middleName", 30),
    text(12, "regionNum", 4),

    // Previous employer, 13-23. Sourced only from the employee's prior 2316.
    money(13, "prevNontaxGrossCompIncome"),
    money(14, "prevNontaxBasicSmw"),
    money(15, "prevNontax13thMonth"),
    money(16, "prevNontaxDeMinimis"),
    money(17, "prevNontaxSssEtc"),
    money(18, "prevNontaxSalaries"),
    money(19, "prevTotalNontaxCompIncome"),
    money(20, "prevTaxableBasicSalary"),
    money(21, "prevTaxable13thMonth"),
    money(22, "prevTaxableSalaries"),
    money(23, "prevTotalTaxable"),

    date(24, "employmentFrom", 10),
    date(25, "employmentTo", 10),

    // Present employer, 26-36 — mirrors the previous-employer block.
    money(26, "presNontaxGrossCompIncome"),
    money(27, "presNontaxBasicSmw"),
    money(28, "presNontax13thMonth"),
    money(29, "presNontaxDeMinimis"),
    money(30, "presNontaxSssEtc"),
    money(31, "presNontaxSalaries"),
    money(32, "presTotalNontaxCompIncome"),
    money(33, "presTaxableBasicSalary"),
    money(34, "presTaxable13thMonth"),
    money(35, "presTaxableSalaries"),
    money(36, "presTotalTaxable"),

    money(37, "grossCompIncome"),
    money(38, "netTaxableCompIncome"),
    money(39, "taxDue"),
    money(40, "prevTaxWthld"),
    money(41, "presTaxWthld"),
    money(42, "amtWthldDec"),
    money(43, "overWthld"),
    money(44, "actualAmtWthld"),

    text(45, "nationality", 30),
    text(46, "employmentStatus", 2),
    text(47, "reasonSeparation", 2),
    text(48, "subsFiling", 2), // Y/N — never inferred from the arithmetic
    money(49, "taxCreditPera"),
  ],
};

/**
 * Layouts that are NOT transcribed, and must not be improvised.
 *
 * Each needs its page of RMC 25-2024 Annex A read. A 59-field record whose
 * order is guessed produces a file that parses cleanly into wrong columns —
 * the exact failure that stays invisible until an assessment.
 */
export const UNTRANSCRIBED_LAYOUTS = [
  {
    formCode: "1604C",
    schedule: 2,
    fieldCount: 59,
    note:
      "Minimum wage earners. Adds holiday/overtime/night-differential/hazard pay for BOTH " +
      "employers, PRES_NONTAX_BASIC_SMW_DAY/_MONTH/_YEAR, FACTOR_USED and a trailing " +
      "NONTAX_BASIC_SAL — and pictures ALL money 9(11).00, with ZERO decimals, unlike " +
      "Schedule 1. The exact field ORDER was not retrieved.",
  },
  {
    formCode: "1604C",
    schedule: 1,
    fieldCount: null,
    note: "Control record (C1). Field list not retrieved.",
  },
  {
    formCode: "1601FQ",
    schedule: 1,
    fieldCount: 14,
    note:
      "Same fields as 1601EQ Schedule 1 but SEQ_NUM moves from position 3 to position 10. " +
      "Transcribed only when 1601-FQ ships; final withholding is deferred.",
  },
  {
    formCode: "SAWT",
    schedule: 1,
    fieldCount: 15,
    note:
      "Header 10 fields, detail 15. Mirror image of the QAP: the filer is the PAYEE and each " +
      "detail row's EMPLOYER_TIN is the withholding agent who withheld from them.",
  },
] as const;

/**
 * Expected field counts, asserted independently of the layout definitions.
 *
 * A count that drifts from the published spec means a field was added, dropped
 * or merged — and every field after it shifts. The counts come from Annex A,
 * not from counting our own arrays, so this catches a transcription error
 * rather than restating it.
 */
export const EXPECTED_FIELD_COUNTS: Readonly<Record<string, number>> = {
  "1601EQ:0:header": 7,
  "1601EQ:1:detail": 14,
  "1601EQ:1:control": 7,
  "1601EQ:2:detail": 12,
  "1601EQ:2:control": 6,
  "1604C:0:header": 4,
  "1604C:1:detail": 49,
};

export const ALL_LAYOUTS: readonly DatLayout[] = [
  QAP_1601EQ_HEADER,
  QAP_1601EQ_SCHEDULE_1_DETAIL,
  QAP_1601EQ_SCHEDULE_1_CONTROL,
  QAP_1601EQ_SCHEDULE_2_DETAIL,
  QAP_1601EQ_SCHEDULE_2_CONTROL,
  ALPHALIST_1604C_HEADER,
  ALPHALIST_1604C_SCHEDULE_1_DETAIL,
];

export function layoutKey(layout: DatLayout): string {
  return `${layout.formCode}:${layout.scheduleNumber}:${layout.recordType}`;
}
