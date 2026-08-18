import { describe, expect, it } from "vitest";
import {
  CHECKSUM_ALGORITHM,
  canonicalize,
  diffSnapshots,
  InvalidSnapshotError,
  reportsSameFigures,
  takeSnapshot,
  verifySnapshot,
  type FilingSnapshotInput,
} from "@/lib/tax/filing-snapshot";

/**
 * `filing-period.ts` refuses to move a period to `filed` without a checksummed
 * snapshot, and refuses an amendment without its own — but nothing took one.
 * The state machine was gated on a component that did not exist.
 */
const base: FilingSnapshotInput = {
  formCode: "1604C",
  periodStart: "2026-01-01",
  periodEnd: "2026-12-31",
  amendmentSequence: 0,
  referenceDatasetVersion: "2026-08-16",
  totals: { grossCompensation: "1200000.00", taxWithheld: "84000.00", employeeCount: 3 },
  lines: [
    { key: "123-456-789-000", values: { gross: "500000.00", withheld: "40000.00" } },
    { key: "987-654-321-000", values: { gross: "400000.00", withheld: "26000.00" } },
    { key: "555-666-777-000", values: { gross: "300000.00", withheld: "18000.00" } },
  ],
};

describe("takeSnapshot", () => {
  it("is deterministic for identical figures", () => {
    expect(takeSnapshot(base).checksum).toBe(takeSnapshot(base).checksum);
  });

  it("stamps the algorithm so a future change stays legible", () => {
    expect(takeSnapshot(base).checksumAlgorithm).toBe(CHECKSUM_ALGORITHM);
  });

  it("records the reference dataset version the figures came from", () => {
    // Brackets and ceilings are effective-dated; a later correction silently
    // changes what a recomputation produces. Without this the figure cannot be
    // explained years later.
    expect(takeSnapshot(base).referenceDatasetVersion).toBe("2026-08-16");
  });

  it("refuses a snapshot that cannot name its inputs", () => {
    expect(() => takeSnapshot({ ...base, referenceDatasetVersion: "" })).toThrow(
      InvalidSnapshotError,
    );
  });

  it("refuses a negative or fractional amendment sequence", () => {
    expect(() => takeSnapshot({ ...base, amendmentSequence: -1 })).toThrow(InvalidSnapshotError);
    expect(() => takeSnapshot({ ...base, amendmentSequence: 1.5 })).toThrow(InvalidSnapshotError);
  });

  it("refuses duplicate line keys", () => {
    // Two rows for one payee mean the detail cannot be reconciled back to the
    // total — the one property the snapshot exists to preserve.
    expect(() =>
      takeSnapshot({
        ...base,
        lines: [...base.lines, { key: "123-456-789-000", values: { gross: "1.00" } }],
      }),
    ).toThrow(/Duplicate snapshot line key/);
  });
});

describe("canonicalization", () => {
  it("ignores the order rows come out of a query", () => {
    const reordered = { ...base, lines: [...base.lines].reverse() };
    expect(takeSnapshot(reordered).checksum).toBe(takeSnapshot(base).checksum);
  });

  it("ignores object key insertion order", () => {
    const reordered = {
      ...base,
      totals: { employeeCount: 3, taxWithheld: "84000.00", grossCompensation: "1200000.00" },
    };
    expect(takeSnapshot(reordered).checksum).toBe(takeSnapshot(base).checksum);
  });

  it("treats trailing-zero money forms as the same figure", () => {
    // "1000", "1000.00" and "1000.00000000" are one reported amount. Three
    // checksums for one figure would make every recomputation look like a
    // change.
    const a = takeSnapshot({ ...base, totals: { ...base.totals, taxWithheld: "84000" } });
    const b = takeSnapshot({ ...base, totals: { ...base.totals, taxWithheld: "84000.00000000" } });
    expect(a.checksum).toBe(b.checksum);
  });

  it("treats -0 and 0 as the same figure", () => {
    const a = takeSnapshot({ ...base, totals: { ...base.totals, adjustment: "-0.00" } });
    const b = takeSnapshot({ ...base, totals: { ...base.totals, adjustment: "0" } });
    expect(a.checksum).toBe(b.checksum);
  });

  it("distinguishes null from zero", () => {
    // "not reported" and "reported as nil" are different statements to the BIR.
    const a = takeSnapshot({ ...base, totals: { ...base.totals, adjustment: null } });
    const b = takeSnapshot({ ...base, totals: { ...base.totals, adjustment: "0" } });
    expect(a.checksum).not.toBe(b.checksum);
  });

  it("changes when any reported figure changes", () => {
    const changed = takeSnapshot({
      ...base,
      lines: [
        { key: "123-456-789-000", values: { gross: "500000.00", withheld: "40000.01" } },
        ...base.lines.slice(1),
      ],
    });
    expect(changed.checksum).not.toBe(takeSnapshot(base).checksum);
  });

  it("cannot be fooled by shifting a value between adjacent keys", () => {
    // A naive concatenation makes {a:"1", b:"23"} and {a:"12", b:"3"} identical.
    const a = takeSnapshot({ ...base, totals: { x: "1", y: "23" } });
    const b = takeSnapshot({ ...base, totals: { x: "12", y: "3" } });
    expect(a.checksum).not.toBe(b.checksum);
  });

  it("distinguishes the period and the form", () => {
    const other = takeSnapshot({ ...base, formCode: "1601C" });
    const later = takeSnapshot({ ...base, periodEnd: "2026-11-30" });
    expect(other.checksum).not.toBe(takeSnapshot(base).checksum);
    expect(later.checksum).not.toBe(takeSnapshot(base).checksum);
  });

  it("exposes the canonical form for diagnosing a mismatch", () => {
    // Comparing two hashes tells you nothing; diffing two canonical forms does.
    // Fields are separated by ASCII control codes so that a delimiter can never
    // occur inside a TIN, a name or an amount.
    const canonical = canonicalize(base);
    expect(canonical).toContain("form\u00011604C");
    expect(canonical).toContain("dataset\u00012026-08-16");
    // And the separators are real, not incidental.
    expect(canonical).toContain("\u0005");
  });
});

describe("verifySnapshot", () => {
  it("accepts an untouched snapshot", () => {
    expect(verifySnapshot(takeSnapshot(base)).valid).toBe(true);
  });

  it("detects an edited payload", () => {
    const snapshot = takeSnapshot(base);
    const tampered = {
      ...snapshot,
      totals: { ...snapshot.totals, taxWithheld: "1.00" },
    };
    const result = verifySnapshot(tampered);
    expect(result.valid).toBe(false);
    expect(result.actual).not.toBe(result.expected);
  });

  it("reports an unknown algorithm as unverifiable, not as tampering", () => {
    // Conflating "cannot verify" with "was altered" would accuse a user of
    // something the evidence does not support.
    const snapshot = { ...takeSnapshot(base), checksumAlgorithm: "sha1/legacy" };
    const result = verifySnapshot(snapshot);
    expect(result.algorithmMismatch).toBe(true);
    expect(result.valid).toBe(false);
  });
});

describe("diffSnapshots", () => {
  const original = takeSnapshot(base);

  it("reports nothing for a re-take of the same figures", () => {
    expect(reportsSameFigures(original, takeSnapshot(base))).toBe(true);
  });

  it("does not report a formatting difference as a change", () => {
    const reformatted = takeSnapshot({
      ...base,
      totals: { ...base.totals, taxWithheld: "84000" },
    });
    expect(reportsSameFigures(original, reformatted)).toBe(true);
  });

  it("says the figures are the same when only the amendment sequence moved", () => {
    // The checksums differ — the sequence is part of the identity — but telling
    // a user their amendment changed a figure when it did not is a real failure.
    const amended = takeSnapshot({ ...base, amendmentSequence: 1 });
    expect(amended.checksum).not.toBe(original.checksum);
    expect(reportsSameFigures(original, amended)).toBe(true);
  });

  it("names the totals that moved", () => {
    const amended = takeSnapshot({
      ...base,
      amendmentSequence: 1,
      totals: { ...base.totals, taxWithheld: "85000.00" },
    });
    const diff = diffSnapshots(original, amended);
    expect(diff.totalsChanged).toEqual([
      { field: "taxWithheld", from: "84000.00", to: "85000.00" },
    ]);
  });

  it("names added, removed and changed payees", () => {
    const amended = takeSnapshot({
      ...base,
      amendmentSequence: 1,
      lines: [
        { key: "123-456-789-000", values: { gross: "500000.00", withheld: "41000.00" } },
        { key: "987-654-321-000", values: { gross: "400000.00", withheld: "26000.00" } },
        { key: "111-222-333-000", values: { gross: "100000.00", withheld: "2000.00" } },
      ],
    });
    const diff = diffSnapshots(original, amended);

    expect(diff.linesAdded).toEqual(["111-222-333-000"]);
    expect(diff.linesRemoved).toEqual(["555-666-777-000"]);
    expect(diff.linesChanged).toEqual([
      { key: "123-456-789-000", fields: [{ field: "withheld", from: "40000.00", to: "41000.00" }] },
    ]);
  });
});
