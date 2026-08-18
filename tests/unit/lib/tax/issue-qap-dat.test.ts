import { describe, expect, it } from "vitest";
import { issueQapDat } from "@/lib/tax/issue-qap-dat";

describe("issueQapDat", () => {
  it("encodes a header, one Schedule 1 row, and a control record", () => {
    const issued = issueQapDat({
      payorTin: "123456789",
      payorBranchCode: "00000",
      payorRegisteredName: "ACME CORP",
      rdoCode: "044",
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      payments: [
        {
          payeeTin: "987654321000",
          payeeRegisteredName: "SUPPLIER INC",
          atc: "WC010",
          incomePayment: "100000",
          taxWithheld: "10000",
          certificateIssued: true,
        },
      ],
    });
    const lines = issued.content.trim().split(/\r?\n/);
    expect(lines[0]).toContain("HQAP");
    expect(lines[1]).toContain("D1");
    expect(lines[2]).toContain("C1");
    expect(issued.blockingIssues).toEqual([]);
  });

  it("carries unissued-certificate blockers instead of swallowing them", () => {
    const issued = issueQapDat({
      payorTin: "123456789",
      payorBranchCode: "00000",
      payorRegisteredName: "ACME CORP",
      periodStart: "2026-01-01",
      periodEnd: "2026-03-31",
      payments: [
        {
          payeeTin: "987654321000",
          payeeRegisteredName: "SUPPLIER INC",
          atc: "WC010",
          incomePayment: "100000",
          taxWithheld: "10000",
          certificateIssued: false,
        },
      ],
    });
    expect(issued.blockingIssues.join(" ")).toMatch(/cannot claim the credit/);
  });
});
