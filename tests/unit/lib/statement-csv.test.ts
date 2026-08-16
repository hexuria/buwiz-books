import { describe, expect, it } from "vitest";
import {
  parseStatementCsv,
  parseCsvAmount,
  parseCsvDate,
  tokenizeCsv,
} from "../../../src/lib/statement-csv";

describe("tokenizeCsv", () => {
  it("handles quoted fields with commas and escaped quotes", () => {
    const rows = tokenizeCsv('a,"b, c","say ""hi"""\n1,2,3');
    expect(rows).toEqual([
      ["a", "b, c", 'say "hi"'],
      ["1", "2", "3"],
    ]);
  });

  it("handles CRLF and skips trailing blank line", () => {
    expect(tokenizeCsv("a,b\r\n1,2\r\n")).toEqual([
      ["a", "b"],
      ["1", "2"],
    ]);
  });
});

describe("parseCsvDate", () => {
  it.each([
    ["2026-01-05", "2026-01-05"],
    ["1/5/2026", "2026-01-05"],
    ["01/05/26", "2026-01-05"],
    ["25/12/2026", "2026-12-25"], // impossible US month → DD/MM
    ["garbage", null],
    ["", null],
  ])("%s → %s", (input, expected) => {
    expect(parseCsvDate(input)).toBe(expected);
  });
});

describe("parseCsvAmount", () => {
  it.each([
    ["1,234.56", 1234.56],
    ["$500.00", 500],
    ["(45.00)", -45],
    ["-45.00", -45],
    ["+10", 10],
    ["", null],
    ["N/A", null],
  ])("%s → %s", (input, expected) => {
    expect(parseCsvAmount(input)).toBe(expected);
  });
});

describe("parseStatementCsv", () => {
  it("parses a single-amount-column export", () => {
    const csv = [
      "Date,Description,Amount,Balance",
      "2026-01-05,ACH DEPOSIT,2500.00,12750.00",
      '01/07/2026,"CHECK 1042, RENT",(1200.25),11549.75',
    ].join("\n");

    const result = parseStatementCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.transactions).toEqual([
      {
        date: "2026-01-05",
        description: "ACH DEPOSIT",
        amount: 2500,
        runningBalance: 12750,
      },
      {
        date: "2026-01-07",
        description: "CHECK 1042, RENT",
        amount: -1200.25,
        runningBalance: 11549.75,
      },
    ]);
    expect(result.detected.amount).toBe("Amount");
  });

  it("parses a debit/credit pair export with a preamble above the header", () => {
    const csv = [
      "Acme Bank Export",
      "Account: ****4521",
      "Posted Date,Payee,Money Out,Money In",
      "2026-02-01,STAPLES,42.50,",
      "2026-02-02,CUSTOMER PAYMENT,,1500.00",
    ].join("\n");

    const result = parseStatementCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.transactions).toEqual([
      { date: "2026-02-01", description: "STAPLES", amount: -42.5 },
      { date: "2026-02-02", description: "CUSTOMER PAYMENT", amount: 1500 },
    ]);
  });

  it("reports unparseable rows as issues instead of guessing", () => {
    const csv = ["Date,Description,Amount", "notadate,X,10.00", "2026-03-01,OK,5.00"].join("\n");
    const result = parseStatementCsv(csv);
    expect(result.ok).toBe(true);
    expect(result.transactions).toHaveLength(1);
    expect(result.issues[0]).toMatch(/unparseable date/i);
  });

  it("fails cleanly when no statement columns are detectable", () => {
    const result = parseStatementCsv("Name,Age\nAlice,30");
    expect(result.ok).toBe(false);
    expect(result.issues[0]).toMatch(/could not detect/i);
  });

  it("fails cleanly on an empty file", () => {
    expect(parseStatementCsv("").ok).toBe(false);
  });
});
