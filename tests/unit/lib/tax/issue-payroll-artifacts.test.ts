import { describe, expect, it } from "vitest";
import { ALPHALIST_1604C_HEADER, ALPHALIST_1604C_SCHEDULE_1_DETAIL } from "@/lib/tax/dat-layouts";
import { encodeDat } from "@/lib/tax/dat-encoder";

describe("1604-C artifact shape", () => {
  it("encodes a header plus one Schedule 1 row without inventing Schedule 2", () => {
    const header = encodeDat(ALPHALIST_1604C_HEADER, [
      { tin: "123456780", branchCode: "0000", retrnPeriod: "12/31/2026" },
    ]);
    const details = encodeDat(ALPHALIST_1604C_SCHEDULE_1_DETAIL, [
      {
        tinEmpyr: "123456780",
        branchCodeEmplyr: "0000",
        retrnPeriod: "12/31/2026",
        seqNum: "1",
        tin: "987654321",
        branchCode: "0000",
        lastName: "DELA CRUZ",
        firstName: "JUAN",
        middleName: "",
        regionNum: "",
        prevNontaxGrossCompIncome: "0",
        prevNontaxBasicSmw: "0",
        prevNontax13thMonth: "0",
        prevNontaxDeMinimis: "0",
        prevNontaxSssEtc: "0",
        prevNontaxSalaries: "0",
        prevTotalNontaxCompIncome: "0",
        prevTaxableBasicSalary: "0",
        prevTaxable13thMonth: "0",
        prevTaxableSalaries: "0",
        prevTotalTaxable: "0",
        employmentFrom: "01/01/2026",
        employmentTo: "12/31/2026",
        presNontaxGrossCompIncome: "0",
        presNontaxBasicSmw: "0",
        presNontax13thMonth: "0",
        presNontaxDeMinimis: "0",
        presNontaxSssEtc: "0",
        presNontaxSalaries: "0",
        presTotalNontaxCompIncome: "0",
        presTaxableBasicSalary: "30000",
        presTaxable13thMonth: "0",
        presTaxableSalaries: "30000",
        presTotalTaxable: "30000",
        grossCompIncome: "30000",
        netTaxableCompIncome: "30000",
        taxDue: "1375.05",
        prevTaxWthld: "0",
        presTaxWthld: "1375.05",
        amtWthldDec: "0",
        overWthld: "0",
        actualAmtWthld: "1375.05",
        nationality: "FILIPINO",
        employmentStatus: "RE",
        reasonSeparation: "",
        subsFiling: "N",
        taxCreditPera: "0",
      },
    ]);
    const content = header.content + details.content;
    const lines = content.trim().split(/\r?\n/);
    expect(lines[0].startsWith("H1604C")).toBe(true);
    expect(lines[1].startsWith("D1,1604C")).toBe(true);
    expect(lines[1].split(",").length).toBe(49);
    expect(content.includes("D2")).toBe(false);
  });
});
