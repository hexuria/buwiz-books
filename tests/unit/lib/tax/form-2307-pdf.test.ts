import { describe, expect, it } from "vitest";
import { form2307PdfBuffer, generateForm2307Pdf } from "@/lib/tax/form-2307-pdf";

function body(doc: ReturnType<typeof generateForm2307Pdf>): string {
  return new TextDecoder("latin1").decode(new Uint8Array(doc.output("arraybuffer")));
}

const base = {
  payorTin: "123456789",
  payorRegisteredName: "ACME CORP",
  payeeTin: "987654321000",
  payeeRegisteredName: "SUPPLIER INC",
  periodStart: "2026-01-01",
  periodEnd: "2026-03-31",
  atc: "WC010",
  incomePayment: "100000",
  taxWithheld: "10000",
};

describe("form-2307-pdf", () => {
  it("renders a substitute certificate as a PDF buffer", () => {
    const pdf = form2307PdfBuffer(base);
    expect(pdf.length).toBeGreaterThan(100);
    expect(generateForm2307Pdf(base).getNumberOfPages()).toBe(1);
  });

  it("watermarks blocking issues instead of swallowing them", () => {
    const doc = generateForm2307Pdf({
      ...base,
      blockingIssues: [
        "Employer TIN and registered name are required before a 2307 can be issued.",
      ],
    });
    expect(doc.getNumberOfPages()).toBe(1);
    expect(body(doc)).toContain("NOT FOR ISSUE");
  });
});
