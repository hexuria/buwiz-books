import { describe, it, expect } from "vitest";
import { asOf, asOfNow, isInForce, pickInForce, InvalidAsOfDateError } from "@/lib/tax/as-of";
import { DE_MINIMIS_CEILINGS, WITHHOLDING_BRACKETS } from "@/lib/tax/reference-catalog";

describe("asOf", () => {
  it("accepts an ISO date and a Date", () => {
    expect(asOf("2026-01-06")).toBe("2026-01-06");
    expect(asOf(new Date("2026-01-06T13:45:00Z"))).toBe("2026-01-06");
  });

  it.each(["2026-1-6", "06-01-2026", "2026/01/06", "", "today", "2026-01-06T00:00:00Z"])(
    "rejects %o",
    (bad) => {
      expect(() => asOf(bad)).toThrow(InvalidAsOfDateError);
    },
  );

  it("rejects a well-formed but non-existent date", () => {
    // Postgres would reject these too, and a silently shifted date could
    // select the wrong effective-dated row — the failure this whole module
    // exists to prevent.
    expect(() => asOf("2026-02-31")).toThrow(InvalidAsOfDateError);
    expect(() => asOf("2025-02-29")).toThrow(InvalidAsOfDateError);
  });

  it("accepts a real leap day", () => {
    expect(asOf("2028-02-29")).toBe("2028-02-29");
  });

  it("rejects an invalid Date object", () => {
    expect(() => asOf(new Date("nonsense"))).toThrow(InvalidAsOfDateError);
  });

  it("asOfNow returns a usable as-of date", () => {
    expect(asOfNow()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("isInForce", () => {
  const row = { effectiveFrom: "2025-02-14", effectiveTo: "2026-01-05" };

  it("includes both boundary days", () => {
    // BIR issuances read "effective 14 February 2025" / "until 31 December
    // 2022" — both bounds inclusive.
    expect(isInForce(row, asOf("2025-02-14"))).toBe(true);
    expect(isInForce(row, asOf("2026-01-05"))).toBe(true);
  });

  it("excludes the day before and the day after", () => {
    expect(isInForce(row, asOf("2025-02-13"))).toBe(false);
    expect(isInForce(row, asOf("2026-01-06"))).toBe(false);
  });

  it("treats a null effectiveTo as still current", () => {
    const open = { effectiveFrom: "2026-01-06", effectiveTo: null };
    expect(isInForce(open, asOf("2099-12-31"))).toBe(true);
    expect(isInForce(open, asOf("2026-01-05"))).toBe(false);
  });
});

describe("pickInForce", () => {
  it("returns null when nothing is in force", () => {
    expect(
      pickInForce([{ effectiveFrom: "2030-01-01", effectiveTo: null }], asOf("2026-01-01")),
    ).toBeNull();
  });

  it("picks the latest-starting row when ranges overlap", () => {
    // Overlapping rows are a data bug, but "the most recent issuance wins" is
    // the least surprising resolution.
    const rows = [
      { effectiveFrom: "2018-01-01", effectiveTo: null, tag: "old" },
      { effectiveFrom: "2026-01-06", effectiveTo: null, tag: "new" },
    ];
    expect(pickInForce(rows, asOf("2026-06-01"))?.tag).toBe("new");
  });
});

describe("the catalog resolves correctly through asOf", () => {
  const bracketsFor = (period: string, at: string) =>
    WITHHOLDING_BRACKETS.filter((b) => b.payrollPeriod === period && isInForce(b, asOf(at)));

  it("selects Annex D inside 2018-2022 and Annex E from 2023", () => {
    // The distinction blocker B3 turns on: RR 11-2018's own Illustrations
    // compute under Annex D, so a 2019 payroll date must not resolve to the
    // 2023 table.
    expect(new Set(bracketsFor("monthly", "2019-06-30").map((b) => b.annex))).toEqual(
      new Set(["D"]),
    );
    expect(new Set(bracketsFor("monthly", "2026-06-30").map((b) => b.annex))).toEqual(
      new Set(["E"]),
    );
  });

  it("switches annexes exactly at the 2022/2023 boundary", () => {
    expect(bracketsFor("monthly", "2022-12-31")[0].annex).toBe("D");
    expect(bracketsFor("monthly", "2023-01-01")[0].annex).toBe("E");
  });

  it("resolves exactly one bracket set per period per date", () => {
    for (const period of ["daily", "weekly", "semi_monthly", "monthly", "annual"]) {
      for (const at of ["2019-06-30", "2026-06-30"]) {
        // Six brackets from exactly one annex — overlapping generations would
        // silently double the candidate set.
        expect(bracketsFor(period, at), `${period} @ ${at}`).toHaveLength(6);
      }
    }
  });

  it("resolves the three de minimis generations to the right ceilings", () => {
    const uniformAt = (at: string) =>
      pickInForce(
        DE_MINIMIS_CEILINGS.filter((c) => c.benefitType === "uniform_clothing_allowance"),
        asOf(at),
      )?.limitAmount;

    expect(uniformAt("2024-06-30")).toBe("6000"); // RR 11-2018
    expect(uniformAt("2025-06-30")).toBe("7000"); // RR 4-2025
    expect(uniformAt("2026-06-30")).toBe("8000"); // RR 29-2025
  });

  it("resolves the RR 29-2025 boundary exactly", () => {
    const riceAt = (at: string) =>
      pickInForce(
        DE_MINIMIS_CEILINGS.filter((c) => c.benefitType === "rice_subsidy"),
        asOf(at),
      )?.limitAmount;

    // DECISIONS U6: 2026-01-06 is derived, not sourced from a publication
    // page. If that date moves, this test is where it surfaces.
    expect(riceAt("2026-01-05")).toBe("2000");
    expect(riceAt("2026-01-06")).toBe("2500");
  });

  it("keeps the uncapped government leave benefit uncapped in every generation", () => {
    const rows = DE_MINIMIS_CEILINGS.filter((c) => c.benefitType === "monetized_vl_sl_government");
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.limitKind).toBe("uncapped");
      expect(row.limitAmount).toBeNull();
    }
  });

  it("leaves no gap in de minimis coverage across the generations", () => {
    for (const benefitType of new Set(DE_MINIMIS_CEILINGS.map((c) => c.benefitType))) {
      const rows = DE_MINIMIS_CEILINGS.filter((c) => c.benefitType === benefitType);
      for (const at of ["2018-01-01", "2025-02-13", "2025-02-14", "2026-01-05", "2026-01-06"]) {
        expect(pickInForce(rows, asOf(at)), `${benefitType} @ ${at}`).not.toBeNull();
      }
    }
  });
});
