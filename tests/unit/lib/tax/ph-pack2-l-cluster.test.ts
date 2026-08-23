// Program 2 P14 — the pack-2 L cluster, pinned:
//   • SSS bracket edges are exclusive at MSC+250 (the (249.99, 250) sliver
//     stays in its own bracket);
//   • impliedRateBps rounds half-up instead of truncating;
//   • a filed period without its as-filed evidence is a corrupted record —
//     nothing transitions off it;
//   • five-digit branch codes warn about .DAT truncation;
//   • VAT quarters follow the taxpayer's fiscal year-end;
//   • the threshold ratio never runs float division on money;
//   • the certificate peso() formatter rounds to centavos.
import { describe, expect, it } from "vitest";
import { selectSssBracket } from "../../../../src/lib/tax/contributions";
import { impliedRateBps } from "../../../../src/lib/tax/certificate-2307";
import { canTransition, type FilingPeriod } from "../../../../src/lib/tax/filing-period";
import { preflightAlphalist } from "../../../../src/lib/tax/alphalist-preflight";
import { buildDeadlineCalendar } from "../../../../src/lib/tax/deadlines";
import { monitorThreshold } from "../../../../src/lib/tax/percentage-tax";
import { remittanceObligationsFor } from "../../../../src/lib/tax/ewt";
import { toScaled } from "../../../../src/lib/tax/money";

describe("SSS bracket boundary", () => {
  it("keeps the (249.99, 250) sliver in its own bracket", () => {
    // 5,000 bracket runs to just under 5,250.
    expect(selectSssBracket(toScaled("5249.99"))[0]).toBe("5000.00");
    expect(selectSssBracket(toScaled("5249.995"))[0]).toBe("5000.00");
    expect(selectSssBracket(toScaled("5250"))[0]).toBe("5500.00");
  });
});

describe("impliedRateBps rounding", () => {
  it("rounds half-up instead of truncating", () => {
    // 9.9999% — truncation said 999 bps; the certificate means 10%.
    expect(impliedRateBps("100000", "9999.99")).toBe(1000);
    // Exact 2% stays 200.
    expect(impliedRateBps("100000", "2000")).toBe(200);
    // .5 bps rounds up.
    expect(impliedRateBps("200000", "1001")).toBe(50);
  });
});

describe("filed-period integrity", () => {
  const context = {
    unacknowledgedVariances: 0,
    fatalPreflightFindings: 0,
    hasSnapshot: true,
    filingReference: "REF-1",
    openingBalancesComplete: true,
  };

  it("refuses every transition off a filed period with no checksum", () => {
    const period: FilingPeriod = {
      formCode: "1601C" as never,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      state: "filed",
      filingReference: "REF-1",
      snapshotChecksum: null,
      amendmentSequence: 0,
    };
    const result = canTransition(period, "amended", context);
    expect(result.allowed).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/NO as-filed snapshot checksum/);
  });

  it("a complete filed period still amends normally", () => {
    const period: FilingPeriod = {
      formCode: "1601C" as never,
      periodStart: "2026-01-01",
      periodEnd: "2026-01-31",
      state: "filed",
      filingReference: "REF-1",
      snapshotChecksum: "abc123",
      amendmentSequence: 0,
    };
    expect(canTransition(period, "amended", context).allowed).toBe(true);
  });
});

describe("branch-code truncation warning", () => {
  it("warns that a five-digit branch code loses a digit in .DAT output", () => {
    const findings = preflightAlphalist([
      {
        tin: "123456789",
        branchCode: "12345",
        lastName: "DELA CRUZ",
        firstName: "JUAN",
        registeredName: null,
        amount: "100",
      },
    ]);
    const warning = findings.find((f) => f.code === "ALPHA-008");
    expect(warning?.severity).toBe("warning");
    expect(warning?.message).toMatch(/truncates it to "1234"/);
  });
});

describe("fiscal-year VAT quarters", () => {
  it("calendar filers keep Mar/Jun/Sep/Dec ends", () => {
    const calendar = buildDeadlineCalendar({ year: 2026, filingChannel: "ebirforms" });
    const vatEnds = calendar.filter((e) => e.formCode === "2550Q").map((e) => e.periodEnd);
    expect(vatEnds.sort()).toEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
  });

  it("a June year-end shifts the quarters to Sep/Dec/Mar/Jun", () => {
    const calendar = buildDeadlineCalendar({
      year: 2026,
      filingChannel: "ebirforms",
      fiscalYearEndMonth: 6,
    });
    const vat = calendar.filter((e) => e.formCode === "2550Q");
    const ends = vat.map((e) => e.periodEnd).sort();
    expect(ends).toEqual(["2026-03-31", "2026-06-30", "2026-09-30", "2026-12-31"]);
    // The quarter ENDING in March starts in January of the same year; the one
    // ending in September starts in July — each spans exactly three months.
    for (const entry of vat) {
      const startMonth = Number(entry.periodStart.slice(5, 7));
      const endMonth = Number(entry.periodEnd.slice(5, 7));
      expect(((endMonth - startMonth + 12) % 12) + 1).toBe(3);
    }
  });
});

describe("threshold utilization", () => {
  it("computes the ratio without float money division", () => {
    const status = monitorThreshold("1500000");
    expect(status.utilization).toBeCloseTo(0.5, 4);
    expect(status.breached).toBe(false);
  });
});

describe("remittance obligations (December dead branch removed)", () => {
  it("months 1 and 2 of a quarter keep their 0619-E dates", () => {
    const [jan] = remittanceObligationsFor(1, 2026);
    expect(jan.formCode).toBe("0619E");
    expect(jan.dueDate).toBe("2026-02-10");
    const [nov] = remittanceObligationsFor(11, 2026);
    expect(nov.dueDate).toBe("2026-12-10");
  });

  it("December is the quarter's third month — 1601-EQ due end of January", () => {
    const [dec] = remittanceObligationsFor(12, 2026);
    expect(dec.formCode).toBe("1601EQ");
    expect(dec.dueDate).toBe("2027-01-31");
  });
});
