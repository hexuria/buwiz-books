import { describe, expect, it } from "vitest";
import {
  assertWorkspaceAllowsFile,
  assertWorkspaceAllowsSnapshot,
  filingPeriodStateFromRun,
  FilingWorkspaceBlockedError,
  isNonZeroMoney,
  toFilingPeriod,
  unacknowledgedVarianceCount,
  type PayrollRunRow,
} from "@/lib/tax/assemble-payroll-filing-workspace";
import { buildFilingWorkspace } from "@/lib/tax/filing-workspace";

function run(over: Partial<PayrollRunRow> = {}): PayrollRunRow {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    organizationId: "org",
    taxableYear: 2026,
    payrollPeriod: "monthly",
    periodStart: "2026-03-01",
    periodEnd: "2026-03-31",
    periodIndex: 3,
    status: "computed",
    journalHeaderId: null,
    isAnnualizationRun: false,
    importSource: null,
    importedDocumentId: null,
    referenceDatasetVersion: "2026-08-16",
    computedAt: new Date("2026-03-31T00:00:00Z"),
    acknowledgedAt: null,
    acknowledgedBy: null,
    acknowledgementNote: null,
    snapshotChecksum: null,
    snapshotTakenAt: null,
    filingReference: null,
    filedAt: null,
    lockedAt: null,
    createdAt: new Date("2026-03-01T00:00:00Z"),
    updatedAt: new Date("2026-03-01T00:00:00Z"),
    ...over,
  };
}

describe("isNonZeroMoney", () => {
  it("treats a sub-centavo string as non-zero without Number()", () => {
    expect(isNonZeroMoney("0.00000001")).toBe(true);
    expect(isNonZeroMoney("0")).toBe(false);
    expect(isNonZeroMoney("0.00")).toBe(false);
    expect(isNonZeroMoney(null)).toBe(false);
  });
});

describe("filingPeriodStateFromRun", () => {
  it("derives filed from filedAt, not from a journal header", () => {
    expect(
      filingPeriodStateFromRun(
        run({
          journalHeaderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
          filedAt: new Date("2026-04-01T00:00:00Z"),
          filingReference: "BIR-1",
        }),
      ),
    ).toBe("filed");
  });

  it("stays computed when a journal exists but the period is not filed", () => {
    expect(
      filingPeriodStateFromRun(
        run({ journalHeaderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", computedAt: new Date() }),
      ),
    ).toBe("computed");
  });

  it("stays open when nothing has been computed, even if a dataset version is present", () => {
    expect(
      filingPeriodStateFromRun(
        run({
          status: "imported",
          computedAt: null,
          snapshotChecksum: null,
          referenceDatasetVersion: "2026-08-16",
        }),
      ),
    ).toBe("open");
  });
});

describe("toFilingPeriod", () => {
  it("does not treat a journal header as the period state", () => {
    const period = toFilingPeriod(
      run({
        journalHeaderId: "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
        filedAt: new Date("2026-04-01T00:00:00Z"),
        filingReference: "BIR-9",
        snapshotChecksum: "abc",
      }),
    );
    expect(period.state).toBe("filed");
    expect(period.filingReference).toBe("BIR-9");
  });
});

describe("unacknowledgedVarianceCount", () => {
  it("counts tax and contribution variances with scaled money", () => {
    expect(
      unacknowledgedVarianceCount(run(), [
        { varianceAmount: "0.00000001", contributionVarianceAmount: null },
        { varianceAmount: "0", contributionVarianceAmount: "1.00" },
        { varianceAmount: "0.00", contributionVarianceAmount: null },
      ]),
    ).toBe(2);
  });

  it("is zero once the run is acknowledged", () => {
    expect(
      unacknowledgedVarianceCount(run({ acknowledgedAt: new Date() }), [
        { varianceAmount: "12.00", contributionVarianceAmount: "3.00" },
      ]),
    ).toBe(0);
  });
});

describe("workspace assertions", () => {
  const cleanInput = {
    period: {
      formCode: "1604C" as const,
      periodStart: "2026-01-01",
      periodEnd: "2026-12-31",
      state: "computed" as const,
      filingReference: null,
      snapshotChecksum: "abc",
      amendmentSequence: 0,
    },
    targetState: "filed" as const,
    context: {
      unacknowledgedVariances: 0,
      fatalPreflightFindings: 0,
      hasSnapshot: true,
      filingReference: null,
      openingBalancesComplete: true,
    },
    preflightFindings: [],
    posted: true,
  };
  const clean = buildFilingWorkspace(cleanInput);

  it("lets snapshot proceed when only submission remains", () => {
    expect(() => assertWorkspaceAllowsSnapshot(clean)).not.toThrow();
  });

  it("lets file proceed when only the BIR reference is missing", () => {
    expect(() => assertWorkspaceAllowsFile(clean)).not.toThrow();
  });

  it("refuses snapshot when a prior stage is still blocked", () => {
    const blocked = buildFilingWorkspace({
      ...cleanInput,
      context: { ...cleanInput.context, hasSnapshot: false, openingBalancesComplete: false },
    });
    expect(() => assertWorkspaceAllowsSnapshot(blocked)).toThrow(FilingWorkspaceBlockedError);
  });

  it("refuses file when the snapshot is still missing", () => {
    const blocked = buildFilingWorkspace({
      ...cleanInput,
      period: { ...cleanInput.period, snapshotChecksum: null },
      context: { ...cleanInput.context, hasSnapshot: false },
    });
    expect(() => assertWorkspaceAllowsFile(blocked)).toThrow(/as-filed snapshot/);
  });
});
