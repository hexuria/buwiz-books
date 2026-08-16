import { describe, expect, it } from "vitest";
import {
  calculateInvoiceAmounts,
  calculateLineAmountCents,
  centsToMoney,
  moneyToCents,
} from "../../../src/lib/money";

describe("money helpers", () => {
  it("rounds monetary input to integer cents", () => {
    expect(moneyToCents("10.005")).toBe(1001);
    expect(moneyToCents(12.34)).toBe(1234);
    expect(centsToMoney(1234)).toBe("12.34");
  });

  it("calculates fractional-quantity line amounts without float accumulation", () => {
    expect(calculateLineAmountCents("1.2500", "19.99")).toBe(2499);
  });

  it("derives invoice subtotal and total from its lines", () => {
    expect(
      calculateInvoiceAmounts(
        [
          { quantity: "2", unitPrice: "12.50" },
          { quantity: "1.5", unitPrice: "10.00" },
        ],
        "5.00",
        "2.50",
      ),
    ).toEqual({
      lineAmounts: ["25.00", "15.00"],
      subtotal: "40.00",
      discountAmount: "5.00",
      taxAmount: "2.50",
      total: "37.50",
    });
  });

  it("rejects discounts larger than the subtotal", () => {
    expect(() => calculateInvoiceAmounts([{ quantity: 1, unitPrice: 10 }], 11, 0)).toThrow(
      "Discount",
    );
  });
});
