import { describe, expect, it } from "vitest";
import { buildDeadlineCalendar } from "@/lib/tax/deadlines";

describe("buildDeadlineCalendar", () => {
  it("uses the earliest eFPS date when the group is unknown", () => {
    const june = buildDeadlineCalendar({ year: 2026, filingChannel: "efps" }).find(
      (entry) => entry.formCode === "1601C" && entry.periodStart === "2026-06-01",
    );
    expect(june?.dueDate).toBe("2026-07-11");
    expect(june?.note).toMatch(/group unset/);
  });

  it("keeps the December 1601-C exception regardless of channel", () => {
    const dec = buildDeadlineCalendar({
      year: 2026,
      filingChannel: "efps",
      efpsGroup: "A",
    }).find((entry) => entry.formCode === "1601C" && entry.periodStart === "2026-12-01");
    expect(dec?.dueDate).toBe("2027-01-15");
  });

  it("does not emit a 0619-E for the third month of a quarter", () => {
    const march = buildDeadlineCalendar({ year: 2026, filingChannel: "ebirforms" }).filter(
      (entry) => entry.periodStart === "2026-03-01" || entry.periodStart === "2026-01-01",
    );
    expect(
      march.some((entry) => entry.formCode === "0619E" && entry.periodStart === "2026-03-01"),
    ).toBe(false);
    expect(march.some((entry) => entry.formCode === "1601EQ")).toBe(true);
  });

  it("applies an official override without inventing a later date", () => {
    const calendar = buildDeadlineCalendar({
      year: 2026,
      filingChannel: "ebirforms",
      overrides: { "1604C": "2026-05-15" },
    });
    const alphalist = calendar.find((entry) => entry.formCode === "1604C");
    expect(alphalist?.dueDate).toBe("2026-05-15");
    expect(alphalist?.overridden).toBe(true);
  });
});
