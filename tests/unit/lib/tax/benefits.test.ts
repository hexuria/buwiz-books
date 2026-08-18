import { describe, it, expect } from "vitest";
import { asOf, isInForce } from "@/lib/tax/as-of";
import {
  computeBenefits,
  evaluateDeMinimisItem,
  CorruptCeilingError,
  MissingCeilingError,
  MissingCeilingContextError,
  type ResolvedCeiling,
} from "@/lib/tax/benefits";
import { toPesoString } from "@/lib/tax/money";
import { DE_MINIMIS_CEILINGS } from "@/lib/tax/reference-catalog";

/** Resolve ceilings the way production will: from the catalog, by as-of date. */
function ceilingsAt(at: string): ResolvedCeiling[] {
  return DE_MINIMIS_CEILINGS.filter((c) => isInForce(c, asOf(at))).map((c) => ({
    benefitType: c.benefitType,
    limitKind: c.limitKind,
    limitAmount: c.limitAmount,
    permittedForms: c.permittedForms,
    qualifyingConditions: c.qualifyingConditions,
    citation: c.citation,
  }));
}

const RR_29_2025 = "2026-06-30";
const RR_11_2018 = "2024-06-30";

const find = (at: string, type: string) => ceilingsAt(at).find((c) => c.benefitType === type)!;

describe("evaluateDeMinimisItem", () => {
  it("exempts an amount within its ceiling", () => {
    const result = evaluateDeMinimisItem(
      { benefitType: "rice_subsidy", amountInWindow: "2500" },
      find(RR_29_2025, "rice_subsidy"),
    );
    expect(toPesoString(result.exempt)).toBe("2500.00");
    expect(toPesoString(result.excess)).toBe("0.00");
  });

  it("splits an amount over its ceiling", () => {
    const result = evaluateDeMinimisItem(
      { benefitType: "rice_subsidy", amountInWindow: "3000" },
      find(RR_29_2025, "rice_subsidy"),
    );
    expect(toPesoString(result.exempt)).toBe("2500.00");
    expect(toPesoString(result.excess)).toBe("500.00");
  });

  it("applies the generation in force, not the newest", () => {
    // Rice subsidy: ₱2,000/month under RR 11-2018, ₱2,500 under RR 29-2025.
    const old = evaluateDeMinimisItem(
      { benefitType: "rice_subsidy", amountInWindow: "2500" },
      find(RR_11_2018, "rice_subsidy"),
    );
    expect(toPesoString(old.exempt)).toBe("2000.00");
    expect(toPesoString(old.excess)).toBe("500.00");
  });

  it("never produces an excess for an uncapped benefit", () => {
    // Government VL/SL monetization has no ceiling at all — a shape an
    // amount-only model cannot express.
    const result = evaluateDeMinimisItem(
      { benefitType: "monetized_vl_sl_government", amountInWindow: "999999" },
      find(RR_29_2025, "monetized_vl_sl_government"),
    );
    expect(toPesoString(result.exempt)).toBe("999999.00");
    expect(toPesoString(result.excess)).toBe("0.00");
  });

  it("measures a day-count ceiling in days and values the excess", () => {
    // RR 29-2025 raised private monetized VL from 10 to 12 days. 15 days taken
    // at ₱1,000/day → 3 days excess → ₱3,000.
    const result = evaluateDeMinimisItem(
      {
        benefitType: "monetized_unused_vacation_leave_private",
        amountInWindow: "15000",
        daysInWindow: 15,
        dailyRate: "1000",
      },
      find(RR_29_2025, "monetized_unused_vacation_leave_private"),
    );
    expect(toPesoString(result.excess)).toBe("3000.00");
    expect(toPesoString(result.exempt)).toBe("12000.00");
  });

  it("computes a percentage-of-minimum-wage ceiling from the regional rate", () => {
    // RR 29-2025 raised the OT / night-shift meal allowance to 30% of the
    // regional basic minimum wage. A stale wage table silently corrupts this.
    const result = evaluateDeMinimisItem(
      {
        benefitType: "daily_meal_allowance_ot_nightshift",
        amountInWindow: "250",
        regionalDailyMinimumWage: "645",
      },
      find(RR_29_2025, "daily_meal_allowance_ot_nightshift"),
    );
    expect(toPesoString(result.exempt)).toBe("193.50"); // 30% of 645
    expect(toPesoString(result.excess)).toBe("56.50");
  });

  it("taxes the whole amount when the form is not permitted", () => {
    // RR 4-2025 added cash and gift certificates as permitted forms of an
    // achievement award. Before it, a cash award was fully taxable however
    // small — a distinction an amount-only table cannot represent.
    const before = evaluateDeMinimisItem(
      {
        benefitType: "employee_achievement_award",
        amountInWindow: "5000",
        form: "cash",
        conditionsAttested: true,
      },
      find(RR_11_2018, "employee_achievement_award"),
    );
    expect(toPesoString(before.excess)).toBe("5000.00");
    expect(before.disqualifiedReason).toBe("form_not_permitted");

    const after = evaluateDeMinimisItem(
      {
        benefitType: "employee_achievement_award",
        amountInWindow: "5000",
        form: "cash",
        conditionsAttested: true,
      },
      find(RR_29_2025, "employee_achievement_award"),
    );
    expect(toPesoString(after.exempt)).toBe("5000.00");
    expect(after.disqualifiedReason).toBeUndefined();
  });

  it("fails CLOSED when the form is not stated at all", () => {
    // The regulation is exclusionary on its face — an award "must be in the
    // form of a tangible personal property other than cash or gift
    // certificate". An unstated form is therefore not a permitted one. Failing
    // open here silently exempts a cash award.
    const result = evaluateDeMinimisItem(
      { benefitType: "employee_achievement_award", amountInWindow: "5000" },
      find(RR_29_2025, "employee_achievement_award"),
    );
    expect(result.disqualifiedReason).toBe("form_not_stated");
    expect(toPesoString(result.excess)).toBe("5000.00");
  });

  it("requires the written-plan and non-discrimination conditions to be attested", () => {
    // The exemption turns on THREE cumulative conditions, not one: the form,
    // the occasion, and receipt under an established written plan that does not
    // discriminate in favour of highly paid employees. RR 4-2025 relaxed only
    // the form limb. Modelling forms alone over-exempts.
    const unattested = evaluateDeMinimisItem(
      {
        benefitType: "employee_achievement_award",
        amountInWindow: "5000",
        form: "tangible_personal_property",
      },
      find(RR_29_2025, "employee_achievement_award"),
    );
    expect(unattested.disqualifiedReason).toBe("conditions_not_attested");
    expect(toPesoString(unattested.excess)).toBe("5000.00");

    const attested = evaluateDeMinimisItem(
      {
        benefitType: "employee_achievement_award",
        amountInWindow: "5000",
        form: "tangible_personal_property",
        conditionsAttested: true,
      },
      find(RR_29_2025, "employee_achievement_award"),
    );
    expect(toPesoString(attested.exempt)).toBe("5000.00");
  });

  it("rejects a capped ceiling whose catalog row carries no amount", () => {
    // Treating the null as zero would make the whole benefit an excess and tax
    // it in full — a failure that reads as a rule rather than corrupt data.
    expect(() =>
      evaluateDeMinimisItem(
        { benefitType: "rice_subsidy", amountInWindow: "1000" },
        { ...find(RR_29_2025, "rice_subsidy"), limitAmount: null },
      ),
    ).toThrow(CorruptCeilingError);
  });

  it("demands the context a shaped ceiling needs instead of guessing", () => {
    expect(() =>
      evaluateDeMinimisItem(
        { benefitType: "daily_meal_allowance_ot_nightshift", amountInWindow: "250" },
        find(RR_29_2025, "daily_meal_allowance_ot_nightshift"),
      ),
    ).toThrow(MissingCeilingContextError);
  });
});

describe("computeBenefits — the ₱90,000 ceiling", () => {
  it("aggregates excess de minimis into other benefits, then applies the ceiling", () => {
    // RMC 50-2018 A5: a single aggregation, not an ordered absorption. The BIR
    // calculator's tooltip describes a waterfall; the arithmetic is the same
    // but the framing invites an allocator and a bug.
    const result = computeBenefits({
      deMinimis: [{ benefitType: "rice_subsidy", amountInWindow: "3000" }],
      ceilings: ceilingsAt(RR_29_2025),
      thirteenthMonthAndOtherBenefitsYtd: "89800",
    });

    expect(toPesoString(result.deMinimisExcess)).toBe("500.00");
    expect(toPesoString(result.otherBenefitsPool)).toBe("90300.00");
    expect(toPesoString(result.nonTaxableBenefits)).toBe("90000.00");
    // The excess is taxable SUPPLEMENTARY compensation.
    expect(toPesoString(result.taxableBenefits)).toBe("300.00");
  });

  it("taxes nothing when the pool is within the ceiling", () => {
    const result = computeBenefits({
      deMinimis: [{ benefitType: "rice_subsidy", amountInWindow: "2500" }],
      ceilings: ceilingsAt(RR_29_2025),
      thirteenthMonthAndOtherBenefitsYtd: "50000",
    });
    expect(toPesoString(result.taxableBenefits)).toBe("0.00");
    expect(toPesoString(result.nonTaxableBenefits)).toBe("50000.00");
  });

  it("is year-to-date, so a late crossing is still taxed", () => {
    // The BIR calculator compares ONE input box against ₱90,000 with no YTD
    // awareness at all. An employee crossing the ceiling in November would
    // never be taxed on the excess.
    const result = computeBenefits({
      deMinimis: [],
      ceilings: ceilingsAt(RR_29_2025),
      thirteenthMonthAndOtherBenefitsYtd: "120000",
    });
    expect(toPesoString(result.nonTaxableBenefits)).toBe("90000.00");
    expect(toPesoString(result.taxableBenefits)).toBe("30000.00");
  });

  it("keeps exempt de minimis out of the ₱90,000 pool", () => {
    // Within-ceiling de minimis is non-taxable in its own right and must not
    // consume ₱90,000 headroom that 13th month pay needs.
    const result = computeBenefits({
      deMinimis: [
        { benefitType: "rice_subsidy", amountInWindow: "2500" },
        { benefitType: "laundry_allowance", amountInWindow: "400" },
      ],
      ceilings: ceilingsAt(RR_29_2025),
      thirteenthMonthAndOtherBenefitsYtd: "90000",
    });
    expect(toPesoString(result.deMinimisExempt)).toBe("2900.00");
    expect(toPesoString(result.deMinimisExcess)).toBe("0.00");
    expect(toPesoString(result.taxableBenefits)).toBe("0.00");
  });

  it("sums excesses across several benefit types", () => {
    const result = computeBenefits({
      deMinimis: [
        { benefitType: "rice_subsidy", amountInWindow: "3000" }, // +500
        { benefitType: "laundry_allowance", amountInWindow: "600" }, // +200
        { benefitType: "uniform_clothing_allowance", amountInWindow: "9000" }, // +1000
      ],
      ceilings: ceilingsAt(RR_29_2025),
      thirteenthMonthAndOtherBenefitsYtd: "0",
    });
    expect(toPesoString(result.deMinimisExcess)).toBe("1700.00");
  });

  it("fails loud on an unknown benefit rather than treating it as exempt", () => {
    // Silently exempting an unknown benefit would under-withhold.
    expect(() =>
      computeBenefits({
        deMinimis: [{ benefitType: "not_a_real_benefit", amountInWindow: "1000" }],
        ceilings: ceilingsAt(RR_29_2025),
        thirteenthMonthAndOtherBenefitsYtd: "0",
      }),
    ).toThrow(MissingCeilingError);
  });

  it("covers all eleven benefit types at the current generation", () => {
    const ceilings = ceilingsAt(RR_29_2025);
    expect(ceilings).toHaveLength(11);
    expect(new Set(ceilings.map((c) => c.benefitType)).size).toBe(11);
  });
});
