import { describe, it, expect } from "vitest";
import {
  preflightAlphalist,
  summarizePreflight,
  type AlphalistRow,
} from "@/lib/tax/alphalist-preflight";

const row = (over: Partial<AlphalistRow> = {}): AlphalistRow => ({
  tin: "234567890",
  branchCode: "00000",
  lastName: "SANTOS",
  firstName: "JUAN",
  registeredName: null,
  amount: "50000.00",
  ...over,
});

const codes = (rows: AlphalistRow[]) => preflightAlphalist(rows).map((f) => f.code);

describe("preflightAlphalist", () => {
  it("passes a clean row", () => {
    expect(preflightAlphalist([row()])).toEqual([]);
  });

  it("blocks a missing TIN", () => {
    // RMC 5-2014 bans submission without a BIR-issued TIN. Catching it here
    // beats a rejection after the deadline was relied on.
    expect(codes([row({ tin: null })])).toContain("ALPHA-001");
  });

  it("blocks a formatted or branch-suffixed TIN", () => {
    // "123-456-789-0000" in a nine-character field shifts every field after it.
    expect(codes([row({ tin: "234-567-890" })])).toContain("ALPHA-002");
    expect(codes([row({ tin: "2345678900000" })])).toContain("ALPHA-002");
  });

  it("blocks placeholder TINs", () => {
    // These pass a digit check and identify nobody — the shape a bookkeeper
    // reaches for when a field must be filled.
    for (const tin of ["000000000", "123456789", "999999999"]) {
      expect(codes([row({ tin })]), tin).toContain("ALPHA-003");
    }
  });

  it("warns rather than blocks on a repeated TIN", () => {
    // Two rows for one payee is legitimate when they carry different ATCs, so
    // this cannot be fatal — but it is usually a duplicated import.
    const findings = preflightAlphalist([row(), row()]);
    const duplicate = findings.find((f) => f.code === "ALPHA-004");
    expect(duplicate?.severity).toBe("warning");
    expect(duplicate?.message).toMatch(/row 1/);
  });

  it("blocks lumped entries", () => {
    // Banned outright by RMC 5-2014 — and on the SLSP, reporting a
    // counterparty as "various" forfeits the EOPT output-VAT credit on that
    // receivable, so the cost is more than a rejection.
    for (const name of ["VARIOUS", "Various Employees", "OTHERS", "various payees", "N/A"]) {
      expect(
        codes([row({ lastName: null, firstName: null, registeredName: name })]),
        name,
      ).toContain("ALPHA-007");
    }
  });

  it("does not mistake a real name for a lumped one", () => {
    // Guards the substring trap: "OTHERO" and "NAVARRO" contain banned words.
    for (const name of ["OTHERO", "NAVARRO", "VARIOUS ENTERPRISES INC"]) {
      const found = codes([row({ lastName: null, firstName: null, registeredName: name })]);
      expect(found, name).not.toContain("ALPHA-007");
    }
  });

  it("blocks a row with no name at all", () => {
    expect(codes([row({ lastName: null, firstName: null, registeredName: null })])).toContain(
      "ALPHA-006",
    );
  });

  it("blocks a name that is entirely banned characters", () => {
    // The encoder transliterates ñ → n, but a name of nothing but banned
    // characters transliterates to nothing at all.
    expect(codes([row({ lastName: null, firstName: null, registeredName: "&&&" })])).toContain(
      "ALPHA-008",
    );
  });

  it("allows a name merely CONTAINING a banned character", () => {
    // PEÑA is a real and common surname; the encoder handles it and logs the
    // substitution. Blocking it here would be wrong.
    expect(codes([row({ lastName: "PEÑA" })])).not.toContain("ALPHA-008");
  });

  it("blocks a malformed branch code", () => {
    expect(codes([row({ branchCode: "0" })])).toContain("ALPHA-005");
    // Four and five are both accepted: the layouts specify four while
    // eBIRForms moved to five, and we store the wider value.
    expect(codes([row({ branchCode: "0000" })])).not.toContain("ALPHA-005");
    expect(codes([row({ branchCode: "00000" })])).not.toContain("ALPHA-005");
  });

  it("blocks a negative amount", () => {
    expect(codes([row({ amount: "-100" })])).toContain("ALPHA-009");
  });

  it("reports the row index so a large alphalist is actionable", () => {
    const findings = preflightAlphalist([row(), row({ tin: null }), row()]);
    expect(findings[0].rowIndex).toBe(1);
  });
});

describe("summarizePreflight", () => {
  it("refuses generation while any fatal finding stands", () => {
    const result = summarizePreflight(preflightAlphalist([row({ tin: null })]));
    expect(result.canGenerate).toBe(false);
    expect(result.fatal).toHaveLength(1);
  });

  it("allows generation with warnings only", () => {
    const result = summarizePreflight(preflightAlphalist([row(), row()]));
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.fatal).toEqual([]);
    expect(result.canGenerate).toBe(true);
  });

  it("allows generation on a clean list", () => {
    const result = summarizePreflight(
      preflightAlphalist([row(), row({ tin: "345678901", lastName: "REYES" })]),
    );
    expect(result.canGenerate).toBe(true);
    expect(result.findings).toEqual([]);
  });
});
