import { describe, expect, it } from "vitest";
import { buildForm1601C, dueDateFor, type Form1601CInput } from "@/lib/tax/form-1601c";

/**
 * 1601-C's job is a reconciliation, not a computation. A return that merely
 * restates a figure the engine produced proves nothing; it has to agree with
 * the ledger movement AND the per-employee detail.
 */
const base: Form1601CInput = {
  month: 6,
  year: 2026,
  filingChannel: "ebirforms",
  lines: [
    {
      employeePartyId: "emp-1",
      taxWithheld: "1500",
      grossCompensation: "30000",
      nonTaxableCompensation: "2700",
    },
    {
      employeePartyId: "emp-2",
      taxWithheld: "800",
      grossCompensation: "22000",
      nonTaxableCompensation: "2000",
    },
  ],
  controlAccountMovement: "2300",
};

describe("buildForm1601C", () => {
  it("totals the detail and derives the taxable base", () => {
    const form = buildForm1601C(base);
    expect(form.totalCompensation).toBe("52000");
    expect(form.nonTaxableCompensation).toBe("4700");
    expect(form.taxableCompensation).toBe("47300");
    expect(form.taxWithheld).toBe("2300");
    expect(form.employeeCount).toBe(2);
  });

  it("spans the whole calendar month", () => {
    const form = buildForm1601C(base);
    expect(form.periodStart).toBe("2026-06-01");
    expect(form.periodEnd).toBe("2026-06-30");
  });

  it("gets February right in a leap year", () => {
    // Computed in UTC so a timezone west of Greenwich cannot roll the last day
    // back by one.
    expect(buildForm1601C({ ...base, month: 2, year: 2028 }).periodEnd).toBe("2028-02-29");
    expect(buildForm1601C({ ...base, month: 2, year: 2026 }).periodEnd).toBe("2026-02-28");
  });

  describe("the reconciliation", () => {
    it("reconciles when the ledger, the detail and the return agree", () => {
      const form = buildForm1601C(base);
      expect(form.reconciliation.reconciled).toBe(true);
      expect(form.reconciliation.difference).toBe("0");
      expect(form.blockingIssues).toEqual([]);
    });

    it("blocks when the control account disagrees with the detail", () => {
      const form = buildForm1601C({ ...base, controlAccountMovement: "2500" });
      expect(form.reconciliation.reconciled).toBe(false);
      expect(form.reconciliation.difference).toBe("200");
      expect(form.blockingIssues.join(" ")).toMatch(/difference of 200/);
    });

    it("catches a sub-centavo divergence", () => {
      // The whole subsystem's claim is an exact equality; comparing at two
      // decimals would let a rounding leak through every month.
      const form = buildForm1601C({ ...base, controlAccountMovement: "2300.00000001" });
      expect(form.reconciliation.reconciled).toBe(false);
    });

    it("blocks when the period was never posted", () => {
      // Not a pass. An unposted period cannot be reconciled at all, which is a
      // stronger objection than a mismatch.
      const form = buildForm1601C({ ...base, controlAccountMovement: null });
      expect(form.reconciliation.reconciled).toBe(false);
      expect(form.blockingIssues.join(" ")).toMatch(/has not been posted/);
    });
  });

  describe("amounts still due", () => {
    it("nets a previous remittance for the same month", () => {
      const form = buildForm1601C({ ...base, previouslyRemitted: "1000" });
      expect(form.stillDue).toBe("1300");
    });

    it("defaults to the full amount when nothing was remitted", () => {
      expect(buildForm1601C(base).stillDue).toBe("2300");
    });
  });

  describe("blocking issues", () => {
    it("refuses a negative taxable base", () => {
      const form = buildForm1601C({
        ...base,
        lines: [
          {
            employeePartyId: "emp-1",
            taxWithheld: "0",
            grossCompensation: "1000",
            nonTaxableCompensation: "5000",
          },
        ],
        controlAccountMovement: "0",
      });
      expect(form.blockingIssues.join(" ")).toMatch(/taxable base would be negative/);
    });

    it("flags an empty return as needing deliberate confirmation", () => {
      // A nil return is legitimate; an empty one by accident is not.
      const form = buildForm1601C({ ...base, lines: [], controlAccountMovement: "0" });
      expect(form.blockingIssues.join(" ")).toMatch(/nil return is legitimate/);
    });
  });
});

describe("dueDateFor", () => {
  it("uses the 10th of the following month by default", () => {
    expect(dueDateFor(6, 2026, "ebirforms").dueDate).toBe("2026-07-10");
    expect(dueDateFor(6, 2026, "manual").dueDate).toBe("2026-07-10");
  });

  it("uses 15 January for December, not 10 January", () => {
    // The exception that is easy to miss, and being wrong here is a 25%
    // surcharge plus interest.
    const december = dueDateFor(12, 2026, "ebirforms");
    expect(december.dueDate).toBe("2027-01-15");
    expect(december.usesDecemberException).toBe(true);
  });

  it("applies the December exception regardless of channel or group", () => {
    expect(dueDateFor(12, 2026, "efps", "A").dueDate).toBe("2027-01-15");
    expect(dueDateFor(12, 2026, "efps", "E").dueDate).toBe("2027-01-15");
  });

  it("staggers eFPS groups from the 15th down to the 11th", () => {
    expect(dueDateFor(6, 2026, "efps", "A").dueDate).toBe("2026-07-15");
    expect(dueDateFor(6, 2026, "efps", "B").dueDate).toBe("2026-07-14");
    expect(dueDateFor(6, 2026, "efps", "C").dueDate).toBe("2026-07-13");
    expect(dueDateFor(6, 2026, "efps", "D").dueDate).toBe("2026-07-12");
    expect(dueDateFor(6, 2026, "efps", "E").dueDate).toBe("2026-07-11");
  });

  it("takes the EARLIEST group date when the group is unknown", () => {
    // Guessing late risks a surcharge; guessing early costs nothing.
    expect(dueDateFor(6, 2026, "efps").dueDate).toBe("2026-07-11");
  });

  it("warns that a conservative eFPS deadline is being shown", () => {
    const form = buildForm1601C({ ...base, filingChannel: "efps" });
    expect(form.dueDate).toBe("2026-07-11");
    expect(form.blockingIssues.join(" ")).toMatch(/earliest staggered deadline/);
  });

  it("rolls the year over for December", () => {
    expect(dueDateFor(12, 2026, "efps", "A").dueDate.startsWith("2027")).toBe(true);
  });

  it("rejects an impossible month rather than producing a date", () => {
    expect(() => buildForm1601C({ ...base, month: 13 })).toThrow(/Invalid month/);
    expect(() => buildForm1601C({ ...base, month: 0 })).toThrow(/Invalid month/);
  });
});
