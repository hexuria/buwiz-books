import { describe, expect, it } from "vitest";
import { splitBillPaymentWithEwt } from "@/lib/tax/bill-payment-ewt";

describe("splitBillPaymentWithEwt", () => {
  it("settles A/P in cash when nothing was withheld", () => {
    expect(splitBillPaymentWithEwt("112000")).toEqual({
      accountsPayable: "112000",
      cash: "112000",
      ewtPayable: "0",
      withheld: false,
    });
  });

  it("splits cash and EWT payable instead of treating withholding as a discount", () => {
    const split = splitBillPaymentWithEwt("112000", "10000");
    expect(split.accountsPayable).toBe("112000");
    expect(split.cash).toBe("102000");
    expect(split.ewtPayable).toBe("10000");
    expect(split.withheld).toBe(true);
  });

  it("refuses withheld tax that would credit cash as a negative", () => {
    expect(() => splitBillPaymentWithEwt("1000", "2000")).toThrow(/exceeds the payment/);
  });
});
