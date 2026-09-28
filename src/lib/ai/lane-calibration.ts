// ============================================================================
// Lane calibration (Inbox v2 spec §4 "Calibration, not raw confidence", §8).
//
// A model's confidence is only a number until the organization's own history
// says what it is worth. A lane's RELIABILITY TABLE buckets every labeled
// proposal by the confidence Jev gave it and records how often a person
// accepted it unchanged. The threshold an admin sets when promoting a lane to
// `auto` must be one that table supports: no lower than the lowest bucket from
// which every observed bucket up has acceptance at or above the target
// (CALIBRATION_TARGET_ACCEPTANCE), each on enough labels to mean something. So
// a confidence at or above the threshold is one this lane's history has shown
// to be right at least 98% of the time — that is the "calibrated" part.
//
// Walking down from the top bucket:
//   - an EMPTY bucket is skipped: no evidence either way, so it neither
//     supports nor stops the walk (a model that never says 0.99 must still
//     be promotable on what it does say);
//   - a bucket with too FEW labels, or BELOW the target, stops the walk: a
//     threshold may not reach past it.
// A lane whose top observed bucket already fails has no supported threshold
// and cannot be promoted to auto.
//
// Pure: the database loader in src/lib/ai/autonomy-lanes.ts hands the samples
// over, and this turns them into buckets.
// ============================================================================

import { AUTONOMY_CRITERIA } from "./autonomy";

/** Bucket edges on the model's 0..1 confidence. The last bucket includes 1. */
export const CALIBRATION_BUCKET_EDGES = [0, 0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 0.98, 1] as const;

/** Observed acceptance a bucket needs to support a threshold: the promotion bar. */
export const CALIBRATION_TARGET_ACCEPTANCE = AUTONOMY_CRITERIA.minAcceptanceRate;

/** Labels a non-empty bucket needs before its acceptance counts as evidence. */
export const MIN_CALIBRATION_BUCKET_SAMPLES = 30;

export interface CalibrationSample {
  confidence: number;
  accepted: boolean;
}

export interface CalibrationBucket {
  lower: number;
  upper: number;
  /** Only the top bucket includes its upper edge (a confidence of exactly 1). */
  includesUpper: boolean;
  reviewed: number;
  accepted: number;
  /** accepted / reviewed; null for an empty bucket. */
  acceptance: number | null;
}

export interface ReliabilityTable {
  buckets: CalibrationBucket[];
  /** Labeled proposals that carried a usable confidence. */
  reviewed: number;
  /** The lowest threshold the table supports, or null when it supports none. */
  minimumThreshold: number | null;
  /** Why, in one sentence, for the Settings screen and refusals. */
  reason: string;
}

/** The bucket a confidence falls in, or -1 when it is not a 0..1 number. */
export function calibrationBucketIndex(confidence: number): number {
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return -1;
  const last = CALIBRATION_BUCKET_EDGES.length - 2;
  for (let index = 0; index <= last; index += 1) {
    const upper = CALIBRATION_BUCKET_EDGES[index + 1];
    if (confidence < upper || (index === last && confidence <= upper)) return index;
  }
  return -1;
}

function percent(value: number): string {
  return `${Math.round(value * 1000) / 10}%`;
}

/**
 * The lowest supported threshold for a set of buckets (see the header), or
 * null with the reason the table supports none.
 */
export function minimumSupportedThreshold(
  buckets: readonly CalibrationBucket[],
  options: { target?: number; minSamples?: number } = {},
): { threshold: number | null; reason: string } {
  const target = options.target ?? CALIBRATION_TARGET_ACCEPTANCE;
  const minSamples = options.minSamples ?? MIN_CALIBRATION_BUCKET_SAMPLES;
  let supported: number | null = null;
  let stoppedBy: string | null = null;
  for (let index = buckets.length - 1; index >= 0; index -= 1) {
    const bucket = buckets[index];
    if (bucket.reviewed === 0) continue;
    const range = `${bucket.lower}–${bucket.upper}`;
    if (bucket.reviewed < minSamples) {
      stoppedBy = `the ${range} bucket has only ${bucket.reviewed} of the ${minSamples} labels it needs`;
      break;
    }
    if ((bucket.acceptance ?? 0) < target) {
      stoppedBy = `the ${range} bucket was accepted ${percent(bucket.acceptance ?? 0)}, below ${percent(target)}`;
      break;
    }
    supported = bucket.lower;
  }
  if (supported === null) {
    return {
      threshold: null,
      reason: stoppedBy
        ? `No threshold is supported yet: ${stoppedBy}.`
        : "No threshold is supported yet: no labeled proposal carries a confidence.",
    };
  }
  return {
    threshold: supported,
    reason: stoppedBy
      ? `Confidence ${supported} or higher has been accepted at least ${percent(target)} of the time; below it, ${stoppedBy}.`
      : `Confidence ${supported} or higher has been accepted at least ${percent(target)} of the time.`,
  };
}

/** Bucket labeled proposals by confidence and find the lowest supported threshold. */
export function buildReliabilityTable(
  samples: readonly CalibrationSample[],
  options: { target?: number; minSamples?: number } = {},
): ReliabilityTable {
  const last = CALIBRATION_BUCKET_EDGES.length - 2;
  const buckets: CalibrationBucket[] = CALIBRATION_BUCKET_EDGES.slice(0, -1).map(
    (lower, index) => ({
      lower,
      upper: CALIBRATION_BUCKET_EDGES[index + 1],
      includesUpper: index === last,
      reviewed: 0,
      accepted: 0,
      acceptance: null,
    }),
  );
  let reviewed = 0;
  for (const sample of samples) {
    const index = calibrationBucketIndex(sample.confidence);
    if (index < 0) continue;
    reviewed += 1;
    buckets[index].reviewed += 1;
    if (sample.accepted) buckets[index].accepted += 1;
  }
  for (const bucket of buckets) {
    bucket.acceptance = bucket.reviewed > 0 ? bucket.accepted / bucket.reviewed : null;
  }
  const { threshold, reason } = minimumSupportedThreshold(buckets, options);
  return { buckets, reviewed, minimumThreshold: threshold, reason };
}

/** Four decimals, matching ai_autonomy_lanes.confidence_threshold. */
const THRESHOLD_SHAPE = /^(?:0(?:\.\d{1,4})?|1(?:\.0{1,4})?)$/;

/**
 * Whether a lane may use this threshold: a 0..1 decimal of at most four
 * places, above zero, and at or above what the lane's reliability table
 * supports. A threshold the data does not support is refused, never rounded up.
 */
export function validateLaneThreshold(
  threshold: string,
  table: Pick<ReliabilityTable, "minimumThreshold" | "reason">,
): { ok: true; value: number } | { ok: false; reason: string } {
  const trimmed = threshold.trim();
  if (!THRESHOLD_SHAPE.test(trimmed) || Number(trimmed) <= 0) {
    return {
      ok: false,
      reason: "The confidence threshold must be a number above 0 and at most 1, to four places.",
    };
  }
  const value = Number(trimmed);
  if (table.minimumThreshold === null) return { ok: false, reason: table.reason };
  if (value < table.minimumThreshold) {
    return {
      ok: false,
      reason: `This lane's history does not support a threshold below ${table.minimumThreshold}. ${table.reason}`,
    };
  }
  return { ok: true, value };
}
