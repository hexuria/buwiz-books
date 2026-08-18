import { describe, expect, it } from "vitest";
import { summarizeCwtReceivable } from "@/lib/tax/cwt-receivable";

describe("summarizeCwtReceivable", () => {
  it("posts a withheld amount", () => {
    expect(summarizeCwtReceivable("10000")).toEqual({ taxWithheld: "10000", shouldPost: true });
  });

  it("does not invent a receivable when the certificate withheld nothing", () => {
    expect(summarizeCwtReceivable("0").shouldPost).toBe(false);
  });

  it("refuses a negative withheld amount", () => {
    expect(() => summarizeCwtReceivable("-1")).toThrow(/cannot be negative/);
  });

  it("treats a sub-centavo withheld figure as something to post", () => {
    expect(summarizeCwtReceivable("0.00000001").shouldPost).toBe(true);
  });
});
