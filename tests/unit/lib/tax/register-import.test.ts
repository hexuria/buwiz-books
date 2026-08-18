import { describe, it, expect } from "vitest";
import {
  BUWIZ_TEMPLATE,
  importRegister,
  normalizeTin,
  parseMoneyCell,
} from "@/lib/tax/register-import";

describe("parseMoneyCell", () => {
  it.each([
    ["1234.56", "1234.56"],
    ["1,234.56", "1234.56"],
    ["₱1,234.56", "1234.56"],
    ["P 1,234.56", "1234.56"],
    ["  1234  ", "1234.00"],
  ])("normalizes %s", (raw, expected) => {
    expect(parseMoneyCell(raw).value).toBe(expected);
  });

  it("reads parenthesised amounts as negative", () => {
    // Accounting notation, common in exported registers.
    expect(parseMoneyCell("(1,234.56)").value).toBe("-1234.56");
  });

  it("distinguishes an empty cell from zero", () => {
    // An absent contribution column must not read as "contributed nothing" —
    // the contribution check depends on telling those apart.
    expect(parseMoneyCell("").value).toBeNull();
    expect(parseMoneyCell("  ").value).toBeNull();
    expect(parseMoneyCell("-").value).toBeNull();
    expect(parseMoneyCell("0").value).toBe("0.00");
  });

  it("rejects a cell that is not an amount", () => {
    expect(parseMoneyCell("N/A").error).toMatch(/not a monetary amount/);
    expect(parseMoneyCell("see note").error).toMatch(/not a monetary amount/);
  });
});

describe("normalizeTin", () => {
  it("strips whatever formatting the register used", () => {
    expect(normalizeTin("234-567-890").value).toBe("234567890");
    expect(normalizeTin("234 567 890").value).toBe("234567890");
    expect(normalizeTin("234567890").value).toBe("234567890");
  });

  it("drops a trailing branch code", () => {
    // Registers commonly carry TIN plus branch. The branch belongs on the tax
    // profile, not on the payroll line.
    expect(normalizeTin("234-567-890-0000").value).toBe("234567890");
    expect(normalizeTin("234-567-890-00000").value).toBe("234567890");
  });

  it("rejects a TIN of the wrong length", () => {
    expect(normalizeTin("12345").error).toMatch(/nine-digit/);
  });

  it("treats a blank as absent rather than invalid", () => {
    expect(normalizeTin("")).toEqual({ value: null, error: null });
  });
});

describe("importRegister", () => {
  const headers = ["employeeTin", "basicSalary", "overtimePay", "sssEmployeeShare"];

  it("imports a register in the published template", () => {
    const result = importRegister({
      headers,
      rows: [["234-567-890", "30,000.00", "1,500.00", "1350"]],
      columnMap: BUWIZ_TEMPLATE,
    });

    expect(result.canProceed).toBe(true);
    expect(result.rows[0].values).toEqual({
      employeeTin: "234567890",
      basicSalary: "30000.00",
      overtimePay: "1500.00",
      sssEmployeeShare: "1350.00",
    });
  });

  it("maps a vendor register through an explicit column map", () => {
    // Never fuzzy-matched. One vendor's "Gross Pay" includes non-taxable
    // allowances and another's does not — guessing is how a de minimis benefit
    // lands in taxable regular compensation and raises someone's tax.
    const result = importRegister({
      headers: ["TIN No.", "Basic Pay", "OT Pay"],
      rows: [["234567890", "30000", "1500"]],
      columnMap: {
        "TIN No.": "employeeTin",
        "Basic Pay": "basicSalary",
        "OT Pay": "overtimePay",
      },
    });

    expect(result.canProceed).toBe(true);
    expect(result.rows[0].values.basicSalary).toBe("30000.00");
  });

  it("reports unmapped columns instead of guessing at them", () => {
    const result = importRegister({
      headers: ["employeeTin", "basicSalary", "Mystery Allowance"],
      rows: [["234567890", "30000", "500"]],
      columnMap: BUWIZ_TEMPLATE,
    });

    expect(result.unmappedColumns).toEqual(["Mystery Allowance"]);
    // Unmapped is not fatal — it may genuinely be a column we do not need. But
    // it is always reported, so nobody discovers it at filing time.
    expect(result.canProceed).toBe(true);
    expect(result.rows[0].values).not.toHaveProperty("Mystery Allowance");
  });

  it("blocks when the map omits a field a row cannot be verified without", () => {
    const result = importRegister({
      headers: ["basicSalary"],
      rows: [["30000"]],
      columnMap: { basicSalary: "basicSalary" },
    });

    expect(result.canProceed).toBe(false);
    expect(result.missingFields).toContain("employeeTin");
  });

  it("blocks a row whose required cell is empty", () => {
    const result = importRegister({
      headers,
      rows: [["", "30000", "0", "0"]],
      columnMap: BUWIZ_TEMPLATE,
    });
    expect(result.canProceed).toBe(false);
    expect(result.issues.some((i) => i.message.includes("employeeTin"))).toBe(true);
  });

  it("flags a negative rather than silently flipping its sign", () => {
    // Many registers write deductions as negatives. Flipping the sign here
    // would guess at a convention, and guessing wrong changes the taxable base.
    const result = importRegister({
      headers,
      rows: [["234567890", "30000", "0", "(1350)"]],
      columnMap: BUWIZ_TEMPLATE,
    });

    const warning = result.issues.find((i) => i.severity === "warning");
    expect(warning?.message).toMatch(/negative/);
    // Still imported, with its sign intact, so the human decides.
    expect(result.rows[0].values.sssEmployeeShare).toBe("-1350.00");
    expect(result.canProceed).toBe(true);
  });

  it("reports the row index so a large register is actionable", () => {
    const result = importRegister({
      headers,
      rows: [
        ["234567890", "30000", "0", "0"],
        ["345678901", "not a number", "0", "0"],
      ],
      columnMap: BUWIZ_TEMPLATE,
    });
    const fatal = result.issues.find((i) => i.severity === "fatal");
    expect(fatal?.rowIndex).toBe(1);
    expect(fatal?.column).toBe("basicSalary");
  });

  it("publishes a template whose headers are the field names", () => {
    // The template removes the mapping problem entirely, which is why it is the
    // primary intake path.
    for (const [header, field] of Object.entries(BUWIZ_TEMPLATE)) {
      expect(header).toBe(field);
    }
  });
});
