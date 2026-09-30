import { describe, expect, it } from "vitest";
import {
  buildReliabilityTable,
  CALIBRATION_BUCKET_EDGES,
  calibrationBucketIndex,
  MIN_CALIBRATION_BUCKET_SAMPLES,
  minimumSupportedThreshold,
  validateLaneThreshold,
  type CalibrationSample,
} from "@/lib/ai/lane-calibration";

/** `count` labels at one confidence, of which `accepted` were accepted. */
function labels(confidence: number, count: number, accepted = count): CalibrationSample[] {
  return Array.from({ length: count }, (_, index) => ({ confidence, accepted: index < accepted }));
}

describe("calibrationBucketIndex", () => {
  it("puts each confidence in its half-open bucket, and 1 in the top one", () => {
    expect(calibrationBucketIndex(0)).toBe(0);
    expect(calibrationBucketIndex(0.4999)).toBe(0);
    expect(calibrationBucketIndex(0.5)).toBe(1);
    expect(calibrationBucketIndex(0.9499)).toBe(6);
    expect(calibrationBucketIndex(0.95)).toBe(7);
    expect(calibrationBucketIndex(0.98)).toBe(8);
    expect(calibrationBucketIndex(1)).toBe(CALIBRATION_BUCKET_EDGES.length - 2);
  });

  it("refuses anything that is not a 0..1 confidence", () => {
    for (const value of [-0.01, 1.0001, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(calibrationBucketIndex(value)).toBe(-1);
    }
  });
});

describe("buildReliabilityTable", () => {
  it("counts labels and acceptance per bucket", () => {
    const table = buildReliabilityTable([
      ...labels(0.99, 40),
      ...labels(0.96, 50, 49),
      ...labels(0.91, 10, 7),
      { confidence: 7, accepted: true },
    ]);
    expect(table.reviewed).toBe(100);
    const byLower = new Map(table.buckets.map((bucket) => [bucket.lower, bucket]));
    expect(byLower.get(0.98)).toMatchObject({ reviewed: 40, accepted: 40, acceptance: 1 });
    expect(byLower.get(0.95)).toMatchObject({ reviewed: 50, accepted: 49, acceptance: 0.98 });
    expect(byLower.get(0.9)).toMatchObject({ reviewed: 10, accepted: 7, acceptance: 0.7 });
    expect(byLower.get(0.5)).toMatchObject({ reviewed: 0, acceptance: null });
  });

  it("supports the lowest bucket from which every observed bucket up clears 98%", () => {
    const table = buildReliabilityTable([
      ...labels(0.99, 60),
      ...labels(0.96, 100, 99),
      ...labels(0.92, 100, 98),
      ...labels(0.87, 100, 90),
      ...labels(0.6, 100, 100),
    ]);
    // 0.87 fails at 90%, which stops the walk: 0.6's perfect record below it
    // cannot reach past a failing bucket.
    expect(table.minimumThreshold).toBe(0.9);
    expect(table.reason).toMatch(/^Confidence 0.9 or higher has been accepted at least 98%/);
    expect(table.reason).toContain("0.85–0.9 bucket was accepted 90%");
  });

  it("skips empty buckets, top or middle, without stopping the walk", () => {
    const table = buildReliabilityTable([...labels(0.96, 60), ...labels(0.86, 60)]);
    expect(table.minimumThreshold).toBe(0.85);
  });

  it("stops at a bucket with too few labels to count", () => {
    const table = buildReliabilityTable([
      ...labels(0.99, 60),
      ...labels(0.96, MIN_CALIBRATION_BUCKET_SAMPLES - 1),
      ...labels(0.92, 100),
    ]);
    expect(table.minimumThreshold).toBe(0.98);
    expect(table.reason).toContain(`only ${MIN_CALIBRATION_BUCKET_SAMPLES - 1} of the`);
  });

  it("supports nothing when the top observed bucket already fails, or there is no data", () => {
    expect(buildReliabilityTable([...labels(0.99, 100, 97)]).minimumThreshold).toBeNull();
    expect(buildReliabilityTable([]).minimumThreshold).toBeNull();
    expect(buildReliabilityTable([]).reason).toMatch(/no labeled proposal carries a confidence/);
  });

  it("uses the caller's target and sample floor when given", () => {
    const buckets = buildReliabilityTable([...labels(0.96, 10, 9)]).buckets;
    expect(minimumSupportedThreshold(buckets, { target: 0.9, minSamples: 5 }).threshold).toBe(0.95);
    expect(minimumSupportedThreshold(buckets).threshold).toBeNull();
  });
});

describe("validateLaneThreshold", () => {
  const table = buildReliabilityTable([...labels(0.99, 60), ...labels(0.96, 60)]);

  it("accepts a threshold at or above what the table supports", () => {
    expect(table.minimumThreshold).toBe(0.95);
    expect(validateLaneThreshold("0.95", table)).toEqual({ ok: true, value: 0.95 });
    expect(validateLaneThreshold("0.9750", table)).toEqual({ ok: true, value: 0.975 });
    expect(validateLaneThreshold("1", table)).toEqual({ ok: true, value: 1 });
  });

  it("refuses a threshold the data does not support, rather than rounding it up", () => {
    const refused = validateLaneThreshold("0.9499", table);
    expect(refused.ok).toBe(false);
    expect(!refused.ok && refused.reason).toMatch(/does not support a threshold below 0.95/);
  });

  it("refuses malformed thresholds and tables that support none", () => {
    for (const bad of ["", "0", "1.5", "-0.9", "0.12345", "abc", "0.9.5"]) {
      expect(validateLaneThreshold(bad, table).ok).toBe(false);
    }
    const empty = buildReliabilityTable([]);
    const refused = validateLaneThreshold("0.99", empty);
    expect(!refused.ok && refused.reason).toBe(empty.reason);
  });
});
