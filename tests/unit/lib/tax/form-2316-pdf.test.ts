import { describe, expect, it } from "vitest";
import { generateForm2316Pdf } from "@/lib/tax/form-2316-pdf";
import type { Form2316 } from "@/lib/tax/form-2316";

/**
 * `form-2316.ts` computed the certificate and nothing rendered it, so Stage 5a's
 * "2316 PDF per employee" had no output.
 *
 * The assertions read the PDF's own uncompressed content stream, so they check
 * what actually reaches the page rather than what was passed in.
 */
function body(doc: ReturnType<typeof generateForm2316Pdf>): string {
  return new TextDecoder("latin1").decode(new Uint8Array(doc.output("arraybuffer")));
}

const clean: Form2316 = {
  taxableYear: 2026,
  employer: {
    tin: "005-123-456",
    branchCode: "00000",
    registeredName: "BUWIZ SOLUTIONS INC",
    address: "12 Ayala Ave, Makati City",
    isMainEmployer: true,
  },
  employee: {
    tin: "123-456-789-000",
    lastName: "SANTOS",
    firstName: "MARIA",
    middleName: "CRUZ",
    address: "45 Rizal St, Quezon City",
    birthDate: "1992-04-11",
    dateHired: "2024-02-01",
    dateSeparated: null,
    isMinimumWageEarner: false,
    substitutedFilingEligible: true,
  },
  previousEmployer: null,
  totalNonTaxable: "120000.00",
  totalTaxableRegular: "540000.00",
  totalTaxableSupplementary: "60000.00",
  totalTaxableFromPresentEmployer: "600000.00",
  grossTaxableIncome: "600000.00",
  taxDue: "82500.00",
  taxWithheldByPresentEmployer: "82500.00",
  taxWithheldByPreviousEmployer: "0.00",
  totalTaxWithheld: "82500.00",
  refundOrDeficiency: "0.00",
  furnishBy: "2027-01-31",
  birCopyRequired: false,
  birCopyDueBy: null,
  blockingIssues: [],
};

describe("generateForm2316Pdf", () => {
  it("renders a document", () => {
    const doc = generateForm2316Pdf(clean);
    expect(doc.getNumberOfPages()).toBeGreaterThanOrEqual(1);
    expect(doc.output("arraybuffer").byteLength).toBeGreaterThan(0);
  });

  it("carries the identifying figures onto the page", () => {
    const text = body(generateForm2316Pdf(clean));
    expect(text).toContain("BIR FORM 2316");
    expect(text).toContain("123-456-789-000");
    expect(text).toContain("SANTOS, MARIA, CRUZ");
    expect(text).toContain("BUWIZ SOLUTIONS INC");
  });

  it("formats amounts with thousands separators and two decimals", () => {
    const text = body(generateForm2316Pdf(clean));
    expect(text).toContain("600,000.00");
    expect(text).toContain("82,500.00");
  });

  it("does not claim to be the BIR's printed template", () => {
    // Describing a substitute as the official form is a claim a client could
    // rely on. The document says what it is.
    const text = body(generateForm2316Pdf(clean));
    expect(text).toMatch(/Substitute certificate/);
    expect(text).toMatch(/not the BIR's printed template/);
  });

  it("states outright that there was no previous employer", () => {
    // A blank section reads as "not filled in", which is a different claim
    // from "there was none".
    expect(body(generateForm2316Pdf(clean))).toContain("None declared for this taxable year");
  });

  it("prints substituted-filing status as its own field", () => {
    // Never inferred from a zero balance: an employee can end with tax due
    // exactly equal to tax withheld and still be disqualified.
    expect(body(generateForm2316Pdf(clean))).toContain("Qualified for substituted filing");
  });

  describe("blocking issues", () => {
    const blocked: Form2316 = {
      ...clean,
      employee: { ...clean.employee, tin: "" },
      blockingIssues: [
        "Employee has no TIN on file",
        "Previous employer 2316 not provided for a mid-year hire",
      ],
    };

    it("watermarks the certificate NOT FOR ISSUE", () => {
      // Issuing a certificate that silently omits its problems puts a wrong
      // figure in an employee's hands under the employer's name.
      expect(body(generateForm2316Pdf(blocked))).toContain("NOT FOR ISSUE");
    });

    it("lists every issue rather than only the count", () => {
      const text = body(generateForm2316Pdf(blocked));
      expect(text).toContain("Employee has no TIN on file");
      expect(text).toContain("Previous employer 2316 not provided");
    });

    it("leaves a clean certificate unmarked", () => {
      expect(body(generateForm2316Pdf(clean))).not.toContain("NOT FOR ISSUE");
    });
  });

  describe("refund and deficiency", () => {
    it("labels a refund as an amount refunded", () => {
      const text = body(
        generateForm2316Pdf({ ...clean, refundOrDeficiency: "1500.00", taxDue: "81000.00" }),
      );
      expect(text).toContain("AMOUNT REFUNDED TO EMPLOYEE");
    });

    it("labels a deficiency as tax still due, in parentheses", () => {
      // A negative sign is easy to miss on a printed certificate; accounting
      // parentheses are not.
      const text = body(
        generateForm2316Pdf({ ...clean, refundOrDeficiency: "-2300.50", taxDue: "84800.50" }),
      );
      expect(text).toContain("TAX STILL DUE FROM EMPLOYEE");
      // PDF escapes parentheses inside a text string, so the content stream
      // carries `\(2,300.50\)` — the rendered page shows plain parentheses.
      expect(text).toContain("\\(2,300.50\\)");
    });
  });

  describe("previous employer", () => {
    it("renders the previous employer block when there is one", () => {
      const text = body(
        generateForm2316Pdf({
          ...clean,
          previousEmployer: {
            tin: "009-888-777",
            registeredName: "PRIOR EMPLOYER CORP",
            taxableCompensation: "180000.00",
            taxWithheld: "12000.00",
          },
          taxWithheldByPreviousEmployer: "12000.00",
        }),
      );
      expect(text).toContain("PRIOR EMPLOYER CORP");
      expect(text).toContain("180,000.00");
      expect(text).not.toContain("None declared for this taxable year");
    });
  });

  describe("BIR copy", () => {
    it("prints the deadline when a BIR copy is required", () => {
      const text = body(
        generateForm2316Pdf({ ...clean, birCopyRequired: true, birCopyDueBy: "2027-02-28" }),
      );
      expect(text).toContain("2027-02-28");
    });
  });

  it("renders an optional itemisation when supplied", () => {
    const text = body(
      generateForm2316Pdf(clean, {
        itemization: {
          nonTaxable: [
            { label: "13th month pay and other benefits", box: "26", amount: "90000.00" },
            { label: "De minimis benefits", box: "27", amount: "30000.00" },
          ],
          taxableRegular: [{ label: "Basic salary", box: "31", amount: "540000.00" }],
          taxableSupplementary: [{ label: "Commission", box: "38", amount: "60000.00" }],
        },
      }),
    );
    expect(text).toContain("De minimis benefits");
    expect(text).toContain("90,000.00");
  });
});
