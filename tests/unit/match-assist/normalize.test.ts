import { describe, expect, it } from "vitest";
import { normalizeDescriptor } from "../../../src/lib/match-assist/normalize";

describe("normalizeDescriptor", () => {
  it.each([
    ["AMZN Mktp US*2K3AB817", "AMZN MKTP US"],
    ["AMZN Mktp US*9Z1CC002", "AMZN MKTP US"],
    ["SQ *COFFEE SHOP 0042", "SQ COFFEE SHOP"],
    ["POS DEBIT STARBUCKS #1234 SEATTLE", "STARBUCKS SEATTLE"],
    ["CHECKCARD 0105 UBER TRIP 8005928996 CA", "UBER TRIP CA"],
    ["ACH PAYMENT VERIZON WIRELESS 01/05", "VERIZON WIRELESS"],
    ["Payment to Chase card ending XXXX4521", "TO CHASE ENDING"],
  ])("%s → %s", (input, expected) => {
    expect(normalizeDescriptor(input)).toBe(expected);
  });

  it("collapses recurring variants of the same vendor to one key", () => {
    expect(normalizeDescriptor("AMZN Mktp US*2K3AB817")).toBe(
      normalizeDescriptor("AMZN MKTP US*QQ12345"),
    );
  });

  it("keeps ampersands and apostrophes (vendor names)", () => {
    expect(normalizeDescriptor("AT&T BILL PAYMENT")).toBe("AT&T BILL");
    expect(normalizeDescriptor("MCDONALD'S #3281")).toBe("MCDONALD'S");
  });
});
