import { describe, it, expect } from "vitest";
import { firstOpenDateAfter, orgDateOf } from "../../../src/lib/org-calendar";

describe("orgDateOf", () => {
  // 2026-08-31 23:00 UTC is already 1 September in Manila (UTC+8). This exact
  // shape — payment keyed in the Manila morning, journaled on the UTC day —
  // put payments into the prior month, the prior VAT period, and potentially
  // a closed period.
  it("gives the org's calendar day, not UTC's", () => {
    const at = new Date("2026-08-31T23:00:00.000Z");
    expect(orgDateOf(at, "Asia/Manila")).toBe("2026-09-01");
    expect(orgDateOf(at, "UTC")).toBe("2026-08-31");
  });

  it("handles the other direction of the date line", () => {
    const at = new Date("2026-09-01T05:00:00.000Z");
    expect(orgDateOf(at, "America/Los_Angeles")).toBe("2026-08-31");
  });

  it("falls back to UTC on an invalid timezone rather than throwing", () => {
    const at = new Date("2026-08-31T23:00:00.000Z");
    // A typo'd setting must not make every payment in the org unpostable.
    expect(orgDateOf(at, "Not/AZone")).toBe("2026-08-31");
  });
});

describe("firstOpenDateAfter", () => {
  it("advances one day", () => {
    expect(firstOpenDateAfter("2026-07-15")).toBe("2026-07-16");
  });

  it("rolls month and year ends", () => {
    expect(firstOpenDateAfter("2026-07-31")).toBe("2026-08-01");
    expect(firstOpenDateAfter("2026-12-31")).toBe("2027-01-01");
    expect(firstOpenDateAfter("2028-02-28")).toBe("2028-02-29"); // leap year
  });

  it("refuses garbage", () => {
    expect(() => firstOpenDateAfter("not-a-date")).toThrow(/not a date/);
  });
});
