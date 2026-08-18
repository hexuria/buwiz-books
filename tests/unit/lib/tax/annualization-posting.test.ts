import { describe, expect, it } from "vitest";
import { summarizeAnnualizationPosting } from "@/lib/tax/annualization-posting-summary";

/**
 * The three annualization outcomes are NOT symmetric, which is the reason this
 * is its own module rather than a sign flip.
 *
 * The asymmetry that matters: a deficiency the employer cannot collect is an
 * EXPENSE the employer bears — the obligation to remit does not disappear
 * because the employee did. Booking it as a receivable carries a balance
 * nobody will ever pay and overstates assets indefinitely.
 */
describe("summarizeAnnualizationPosting", () => {
  it("reports exact when everyone came out even", () => {
    const summary = summarizeAnnualizationPosting([
      { employeePartyId: "a", refundOrDeficiency: "0" },
      { employeePartyId: "b", refundOrDeficiency: "0" },
    ]);
    expect(summary.outcome).toBe("exact");
    expect(summary.totalRefund).toBe("0");
    expect(summary.employeesRefunded).toBe(0);
    expect(summary.employeesWithDeficiency).toBe(0);
  });

  it("totals refunds for over-withheld employees", () => {
    const summary = summarizeAnnualizationPosting([
      { employeePartyId: "a", refundOrDeficiency: "1500" },
      { employeePartyId: "b", refundOrDeficiency: "500.50" },
    ]);
    expect(summary.totalRefund).toBe("2000.5");
    expect(summary.employeesRefunded).toBe(2);
    expect(summary.outcome).toBe("excess");
  });

  it("separates collectible from uncollectible deficiencies", () => {
    // The distinction decides whether the debit is an asset or an expense.
    const summary = summarizeAnnualizationPosting([
      { employeePartyId: "a", refundOrDeficiency: "-800" },
      { employeePartyId: "b", refundOrDeficiency: "-1200", uncollectibleDeficiency: true },
    ]);
    expect(summary.totalCollectibleDeficiency).toBe("800");
    expect(summary.totalUncollectibleDeficiency).toBe("1200");
    expect(summary.employeesWithDeficiency).toBe(2);
  });

  it("treats an unflagged deficiency as collectible", () => {
    // Never inferred the other way: writing off a debt that could have been
    // collected is as wrong as inventing an asset.
    const summary = summarizeAnnualizationPosting([
      { employeePartyId: "a", refundOrDeficiency: "-300" },
    ]);
    expect(summary.totalCollectibleDeficiency).toBe("300");
    expect(summary.totalUncollectibleDeficiency).toBe("0");
  });

  it("moves the payable DOWN for refunds and UP for deficiencies", () => {
    // Refunds debit the withholding payable; deficiencies credit it. The net
    // movement is what 1601-C's reconciliation will have to explain.
    expect(
      summarizeAnnualizationPosting([{ employeePartyId: "a", refundOrDeficiency: "1000" }])
        .netWithholdingMovement,
    ).toBe("-1000");
    expect(
      summarizeAnnualizationPosting([{ employeePartyId: "a", refundOrDeficiency: "-1000" }])
        .netWithholdingMovement,
    ).toBe("1000");
  });

  it("nets refunds against deficiencies across a workforce", () => {
    const summary = summarizeAnnualizationPosting([
      { employeePartyId: "a", refundOrDeficiency: "2000" },
      { employeePartyId: "b", refundOrDeficiency: "-500" },
      { employeePartyId: "c", refundOrDeficiency: "-300", uncollectibleDeficiency: true },
      { employeePartyId: "d", refundOrDeficiency: "0" },
    ]);
    expect(summary.totalRefund).toBe("2000");
    expect(summary.totalCollectibleDeficiency).toBe("500");
    expect(summary.totalUncollectibleDeficiency).toBe("300");
    // 800 of deficiency less 2000 of refund.
    expect(summary.netWithholdingMovement).toBe("-1200");
    expect(summary.outcome).toBe("excess");
    expect(summary.employeesRefunded).toBe(1);
    expect(summary.employeesWithDeficiency).toBe(2);
  });

  it("calls the outcome a deficiency when shortfalls exceed refunds", () => {
    const summary = summarizeAnnualizationPosting([
      { employeePartyId: "a", refundOrDeficiency: "100" },
      { employeePartyId: "b", refundOrDeficiency: "-900" },
    ]);
    expect(summary.outcome).toBe("deficiency");
  });

  it("keeps sub-centavo precision", () => {
    const summary = summarizeAnnualizationPosting([
      { employeePartyId: "a", refundOrDeficiency: "0.00000001" },
    ]);
    expect(summary.totalRefund).toBe("0.00000001");
    expect(summary.outcome).toBe("excess");
  });

  it("handles an empty workforce without inventing an outcome", () => {
    const summary = summarizeAnnualizationPosting([]);
    expect(summary.outcome).toBe("exact");
    expect(summary.netWithholdingMovement).toBe("0");
  });

  it("keeps the payable movement explicable from the parts", () => {
    // The real invariant. The withholding payable is DEBITED by refunds and
    // CREDITED by both kinds of deficiency, so its net movement must equal
    // deficiencies less refunds — that identity is what 1601-C's
    // reconciliation checks the control account against.
    //
    // (An earlier version of this test added the same three terms on both
    // sides and could not fail. This one can: change any single component and
    // the equality breaks.)
    const summary = summarizeAnnualizationPosting([
      { employeePartyId: "a", refundOrDeficiency: "2000" },
      { employeePartyId: "b", refundOrDeficiency: "-500" },
      { employeePartyId: "c", refundOrDeficiency: "-300", uncollectibleDeficiency: true },
    ]);

    const creditedToPayable =
      Number(summary.totalCollectibleDeficiency) + Number(summary.totalUncollectibleDeficiency);
    const debitedToPayable = Number(summary.totalRefund);

    expect(Number(summary.netWithholdingMovement)).toBe(creditedToPayable - debitedToPayable);
    expect(Number(summary.netWithholdingMovement)).toBe(-1200);
  });
});
