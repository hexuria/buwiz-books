import { describe, expect, it } from "vitest";
import {
  assessStaleness,
  buildStalenessReport,
  AGING_AFTER_DAYS,
  STALE_AFTER_DAYS,
} from "@/lib/tax/reference-data-staleness";

/**
 * Stale reference data does not fail loudly. Every computation against it
 * succeeds, reconciles, and passes every check in this codebase — because
 * those checks verify internal CONSISTENCY, and a stale table is perfectly
 * self-consistent. It is wrong only against the outside world.
 *
 * Nothing else in the system will ever raise this, which is why the signal has
 * to be time-based and unmissable.
 */
const base = {
  datasetKey: "withholding_tables",
  ownerName: "A. Reyes",
  asOf: "2026-08-18",
};

describe("assessStaleness", () => {
  it("calls recently verified data fresh", () => {
    const status = assessStaleness({ ...base, lastVerifiedAt: "2026-08-10" });
    expect(status.level).toBe("fresh");
    expect(status.concerns).toEqual([]);
  });

  it("flags aging data before it is stale", () => {
    const status = assessStaleness({ ...base, lastVerifiedAt: "2026-06-20" });
    expect(status.level).toBe("aging");
    expect(status.daysSinceVerified).toBeGreaterThanOrEqual(AGING_AFTER_DAYS);
  });

  it("calls it stale past the threshold and says why that is dangerous", () => {
    const status = assessStaleness({ ...base, lastVerifiedAt: "2026-01-01" });
    expect(status.level).toBe("stale");
    expect(status.concerns[0]).toMatch(/retroactive effective date/);
    expect(status.concerns[0]).toMatch(/may already have produced wrong returns/);
  });

  it("distinguishes NEVER verified from verified long ago", () => {
    // Different remedies: one needs a re-read, the other needs someone to
    // establish a baseline in the first place.
    const never = assessStaleness({ ...base, lastVerifiedAt: null });
    const old = assessStaleness({ ...base, lastVerifiedAt: "2024-01-01" });

    expect(never.level).toBe("unverified");
    expect(old.level).toBe("stale");
    expect(never.concerns[0]).toMatch(/establish a baseline/);
    expect(never.daysSinceVerified).toBeNull();
  });

  it("reports an absent owner as a condition, not a blank", () => {
    // The part that cannot be fixed in code. An unowned dataset is simply
    // never read, which is indistinguishable from not running the sweep.
    const status = assessStaleness({ ...base, ownerName: null, lastVerifiedAt: "2026-08-10" });
    expect(status.concerns.join(" ")).toMatch(/No owner assigned/);
    expect(status.concerns.join(" ")).toMatch(/indistinguishable from not running it at all/);
  });

  it("reports staleness AND ownership together when both apply", () => {
    const status = assessStaleness({ ...base, ownerName: null, lastVerifiedAt: "2025-01-01" });
    expect(status.concerns).toHaveLength(2);
  });

  it("puts the boundary days on the right side", () => {
    const exactlyStale = assessStaleness({
      ...base,
      lastVerifiedAt: "2026-05-20", // 90 days before 2026-08-18
    });
    expect(exactlyStale.daysSinceVerified).toBe(STALE_AFTER_DAYS);
    expect(exactlyStale.level).toBe("stale");
  });
});

describe("buildStalenessReport", () => {
  const fresh = {
    datasetKey: "a",
    ownerName: "A. Reyes",
    lastVerifiedAt: "2026-08-10",
    asOf: "2026-08-18",
  };

  it("declares data fit to file when everything is current", () => {
    const report = buildStalenessReport([fresh]);
    expect(report.fitToFile).toBe(true);
    expect(report.summary).toMatch(/current and owned/);
  });

  it("is NOT fit to file with anything stale", () => {
    const report = buildStalenessReport([
      fresh,
      { ...fresh, datasetKey: "b", lastVerifiedAt: "2025-01-01" },
    ]);
    expect(report.fitToFile).toBe(false);
    expect(report.needsAttention).toEqual(["b"]);
  });

  it("stays fit to file when data is current but merely unowned", () => {
    // Deliberate. A dataset verified last week is fit to use today even if
    // nobody owns it long-term. Conflating the two would cry wolf now or hide
    // real staleness later.
    const report = buildStalenessReport([{ ...fresh, ownerName: null }]);
    expect(report.fitToFile).toBe(true);
    expect(report.unowned).toEqual(["a"]);
    expect(report.summary).toMatch(/Assign one/);
  });

  it("names both problems separately in the summary", () => {
    const report = buildStalenessReport([
      { ...fresh, datasetKey: "stale_one", lastVerifiedAt: "2024-01-01" },
      { ...fresh, datasetKey: "unowned_one", ownerName: null },
    ]);
    expect(report.summary).toMatch(/stale or unverified: stale_one/);
    expect(report.summary).toMatch(/no owner: unowned_one/);
  });

  it("treats never-verified as needing attention", () => {
    const report = buildStalenessReport([{ ...fresh, lastVerifiedAt: null }]);
    expect(report.needsAttention).toEqual(["a"]);
    expect(report.fitToFile).toBe(false);
  });

  it("handles an empty set without claiming everything is fine or broken", () => {
    const report = buildStalenessReport([]);
    expect(report.datasets).toEqual([]);
    expect(report.fitToFile).toBe(true);
  });
});
