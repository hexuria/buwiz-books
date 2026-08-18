import { describe, it, expect } from "vitest";
import {
  applyTransition,
  blocksAccountingClose,
  canTransition,
  FORM_FILING_SCOPE,
  type FilingPeriod,
  type TransitionContext,
} from "@/lib/tax/filing-period";

const period = (over: Partial<FilingPeriod> = {}): FilingPeriod => ({
  formCode: "1601C",
  periodStart: "2026-01-01",
  periodEnd: "2026-01-31",
  state: "open",
  filingReference: null,
  snapshotChecksum: null,
  amendmentSequence: 0,
  ...over,
});

const ready = (over: Partial<TransitionContext> = {}): TransitionContext => ({
  unacknowledgedVariances: 0,
  fatalPreflightFindings: 0,
  hasSnapshot: true,
  filingReference: "BIR-2026-000123",
  openingBalancesComplete: true,
  ...over,
});

describe("the filing ladder", () => {
  it("moves open → computed → filed", () => {
    expect(canTransition(period(), "computed", ready()).allowed).toBe(true);
    expect(canTransition(period({ state: "computed" }), "filed", ready()).allowed).toBe(true);
  });

  it("allows recomputation, so a corrected import is re-run rather than unwound", () => {
    expect(canTransition(period({ state: "computed" }), "computed", ready()).allowed).toBe(true);
  });

  it("refuses to reopen a filed period, and says why", () => {
    // The as-filed figures are a matter of record. An amendment supersedes
    // them; reopening would erase what was reported.
    const result = canTransition(period({ state: "filed" }), "open", ready());
    expect(result.allowed).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/not reopened, it is amended/);
  });

  it("moves filed → amended", () => {
    expect(canTransition(period({ state: "filed" }), "amended", ready()).allowed).toBe(true);
  });

  it("refuses to skip computation", () => {
    expect(canTransition(period(), "filed", ready()).allowed).toBe(false);
  });
});

describe("gates on filing", () => {
  it("blocks on an unacknowledged variance", () => {
    // D-N7: the client's figure is what gets filed, but the disagreement must
    // be recorded and acknowledged first. The product is the control, not the
    // computer of record.
    const result = canTransition(
      period({ state: "computed" }),
      "filed",
      ready({ unacknowledgedVariances: 3 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/3 variance\(s\) are unacknowledged/);
  });

  it("blocks on a fatal alphalist finding", () => {
    // The file would be rejected at submission — after the deadline was relied
    // on, which is the expensive moment to find out.
    const result = canTransition(
      period({ state: "computed" }),
      "filed",
      ready({ fatalPreflightFindings: 1 }),
    );
    expect(result.allowed).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/would be rejected at submission/);
  });

  it("blocks without an as-filed snapshot", () => {
    // Posted journals stay mutable, so the snapshot is the ONLY evidence of
    // what was actually reported.
    const result = canTransition(
      period({ state: "computed" }),
      "filed",
      ready({ hasSnapshot: false }),
    );
    expect(result.blockers.join(" ")).toMatch(/only evidence of what was reported/);
  });

  it("blocks without a filing reference", () => {
    const result = canTransition(
      period({ state: "computed" }),
      "filed",
      ready({ filingReference: null }),
    );
    expect(result.allowed).toBe(false);
  });

  it("reports every blocker in one pass", () => {
    // A bookkeeper closing a period wants the whole list, not to fix one thing
    // and rediscover the next.
    const result = canTransition(
      period({ state: "computed" }),
      "filed",
      ready({
        unacknowledgedVariances: 2,
        fatalPreflightFindings: 1,
        hasSnapshot: false,
        filingReference: null,
      }),
    );
    expect(result.blockers).toHaveLength(4);
  });

  it("blocks computation while opening balances are incomplete", () => {
    // D7 Tier 1. A mid-year migration without them computes on a short
    // numerator and understates the tax for the rest of the year.
    const result = canTransition(period(), "computed", ready({ openingBalancesComplete: false }));
    expect(result.allowed).toBe(false);
    expect(result.blockers.join(" ")).toMatch(/built on a partial year/);
  });
});

describe("applyTransition", () => {
  it("advances the state", () => {
    const next = applyTransition(period(), "computed", ready());
    expect(next.state).toBe("computed");
  });

  it("increments the amendment sequence only on amendment", () => {
    const filed = applyTransition(period({ state: "computed" }), "filed", ready());
    expect(filed.amendmentSequence).toBe(0);
    const amended = applyTransition(filed, "amended", ready());
    expect(amended.amendmentSequence).toBe(1);
    const again = applyTransition(amended, "amended", ready());
    expect(again.amendmentSequence).toBe(2);
  });

  it("throws rather than silently no-op on an illegal transition", () => {
    expect(() => applyTransition(period({ state: "filed" }), "open", ready())).toThrow(
      /illegal filing-period transition/,
    );
  });
});

describe("filing scope", () => {
  it("files withholding returns per agent and transaction taxes consolidated", () => {
    // "Returns file per branch" as a blanket rule produces OVER-filing —
    // applicability is per form.
    expect(FORM_FILING_SCOPE["1601C"]).toBe("per_withholding_agent");
    expect(FORM_FILING_SCOPE["1601EQ"]).toBe("per_withholding_agent");
    expect(FORM_FILING_SCOPE["2550Q"]).toBe("consolidated");
    expect(FORM_FILING_SCOPE["2551Q"]).toBe("consolidated");
  });
});

describe("blocksAccountingClose", () => {
  it("holds the accounting close behind an unfiled return", () => {
    // The tax lock is the stronger of the two: sweeping closed_through past an
    // open return would make the transactions behind it uneditable before the
    // return is even computed.
    const periods = [
      period({ periodEnd: "2026-01-31", state: "open" }),
      period({ periodEnd: "2026-02-28", state: "filed" }),
    ];
    const blocking = blocksAccountingClose(periods, "2026-02-28");
    expect(blocking).toHaveLength(1);
    expect(blocking[0].periodEnd).toBe("2026-01-31");
  });

  it("does not block on periods after the close date", () => {
    const periods = [period({ periodEnd: "2026-06-30", state: "open" })];
    expect(blocksAccountingClose(periods, "2026-01-31")).toEqual([]);
  });

  it("does not block on filed or amended periods", () => {
    const periods = [
      period({ periodEnd: "2026-01-31", state: "filed" }),
      period({ periodEnd: "2026-01-31", state: "amended" }),
    ];
    expect(blocksAccountingClose(periods, "2026-12-31")).toEqual([]);
  });
});
