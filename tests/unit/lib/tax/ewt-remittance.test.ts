import { describe, expect, it } from "vitest";
import { summarizeEwtRemittance } from "@/lib/tax/ewt-remittance";

describe("summarizeEwtRemittance", () => {
  it("remits January on 0619-E", () => {
    const summary = summarizeEwtRemittance({ month: 1, year: 2026, amounts: ["10000", "5000"] });
    expect(summary.formCode).toBe("0619E");
    expect(summary.periodStart).toBe("2026-01-01");
    expect(summary.periodEnd).toBe("2026-01-31");
    expect(summary.dueDate).toBe("2026-02-10");
    expect(summary.taxWithheld).toBe("15000");
    expect(summary.shouldPost).toBe(true);
  });

  it("does not invent a 0619-E for March — the quarter goes on 1601-EQ", () => {
    const summary = summarizeEwtRemittance({ month: 3, year: 2026, amounts: ["8000"] });
    expect(summary.formCode).toBe("1601EQ");
    expect(summary.periodStart).toBe("2026-01-01");
    expect(summary.periodEnd).toBe("2026-03-31");
  });

  it("does not post a nil remittance", () => {
    expect(summarizeEwtRemittance({ month: 2, year: 2026, amounts: [] }).shouldPost).toBe(false);
  });
});
