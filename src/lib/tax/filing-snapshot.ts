/**
 * The immutable as-filed snapshot.
 *
 * `filing-period.ts` refuses to move a period to `filed` without one, and
 * refuses an amendment without its own — but nothing took one. The state
 * machine was gated on a component that did not exist.
 *
 * WHAT IT IS FOR. A filed return is a statement about what the books said on
 * the day it was filed. Two things can change underneath it afterwards:
 *
 *   1. The REFERENCE DATA. Brackets, ceilings and contribution tables are
 *      effective-dated, and a later correction to a dataset silently changes
 *      what a recomputation produces. The snapshot stamps the dataset version
 *      that was actually used, so a figure can be explained years later.
 *   2. The LEDGER. Posted journals are now immutable in substance (0042), but
 *      they can still be superseded by an amendment, and a period can be
 *      recomputed from a corrected payroll register. Without a snapshot there
 *      is no record of the superseded figures at all.
 *
 * WHY A CHECKSUM RATHER THAN TRUST. The snapshot's own row could be edited.
 * The checksum is computed over a canonical serialisation of the reported
 * figures, so a later edit to the stored payload is detectable rather than
 * merely discouraged. It is an integrity check against accident and drift, not
 * a cryptographic signature against a determined attacker with database write
 * access — `verifySnapshot` states exactly that.
 *
 * CANONICALISATION IS THE WHOLE GAME. Two runs that reported identical figures
 * must produce an identical checksum, and any difference in a reported figure
 * must change it. So keys are sorted, money is normalised to a single
 * representation, and absent values are distinguished from zero.
 */
import { createHash } from "node:crypto";

/**
 * Field/record separators for the canonical form.
 *
 * A delimiter is not decoration. Concatenating `key + value` without one makes
 * `{a: "1", b: "23"}` and `{a: "12", b: "3"}` serialise identically, so two
 * genuinely different returns would share a checksum. These are the ASCII
 * separator control codes, chosen because they cannot occur in a TIN, a name,
 * or a decimal amount — a delimiter that can appear inside a value is not a
 * delimiter.
 */
const SEP_KEY_VALUE = "\u0001";
const SEP_FIELD = "\u0002";
const SEP_LINE_KEY = "\u0003";
const SEP_LINE = "\u0004";
const SEP_SECTION = "\u0005";

/** A single reported figure. Money arrives as a decimal string, never a float. */
export type SnapshotValue = string | number | boolean | null;

export interface SnapshotLine {
  /** Stable identifier for the row — a TIN, an employee id, a schedule key. */
  key: string;
  values: Record<string, SnapshotValue>;
}

export interface FilingSnapshotInput {
  formCode: string;
  periodStart: string;
  periodEnd: string;
  /** 0 for the original return; increments per amendment. */
  amendmentSequence: number;
  /**
   * The reference dataset version every figure was computed against. Required:
   * a snapshot that cannot name its inputs cannot explain its outputs.
   */
  referenceDatasetVersion: string;
  /** Header-level totals as reported. */
  totals: Record<string, SnapshotValue>;
  /** Per-payee / per-employee detail as reported. */
  lines: SnapshotLine[];
}

export interface FilingSnapshot extends FilingSnapshotInput {
  checksum: string;
  /** Algorithm and canonicalisation version, so a future change stays legible. */
  checksumAlgorithm: string;
}

export const CHECKSUM_ALGORITHM = "sha256/canonical-v1";

export class InvalidSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidSnapshotError";
  }
}

/**
 * Normalise a money-ish string to one representation.
 *
 * `"1000"`, `"1000.00"` and `"1000.00000000"` are the same reported figure and
 * must not produce three different checksums. Anything that is not a plain
 * decimal is left alone — it is a text field, not an amount.
 */
function canonicalizeValue(value: SnapshotValue): string {
  if (value === null) return "\u0000null";
  if (typeof value === "boolean") return value ? "\u0000true" : "\u0000false";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new InvalidSnapshotError(`Non-finite number in snapshot: ${value}`);
    }
    // A float reached a reported figure. That is a defect upstream, but the
    // snapshot must still be deterministic about it.
    return `\u0000num:${value.toString()}`;
  }

  const trimmed = value.trim();
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) {
    const negative = trimmed.startsWith("-");
    const [whole, fraction = ""] = (negative ? trimmed.slice(1) : trimmed).split(".");
    const trimmedFraction = fraction.replace(/0+$/, "");
    const normalizedWhole = whole.replace(/^0+(?=\d)/, "");
    // -0 and 0 are the same figure.
    const isZero = normalizedWhole === "0" && trimmedFraction === "";
    const sign = negative && !isZero ? "-" : "";
    return `${sign}${normalizedWhole}${trimmedFraction ? `.${trimmedFraction}` : ""}`;
  }
  return trimmed;
}

function canonicalizeRecord(record: Record<string, SnapshotValue>): string {
  // Sorted keys: object insertion order must not affect the checksum.
  return Object.keys(record)
    .sort()
    .map((key) => `${key}${SEP_KEY_VALUE}${canonicalizeValue(record[key])}`)
    .join(SEP_FIELD);
}

/**
 * The canonical byte string a checksum is taken over.
 *
 * Exported because a mismatch is much easier to diagnose by diffing two
 * canonical forms than by comparing two hashes.
 */
export function canonicalize(input: FilingSnapshotInput): string {
  if (!input.referenceDatasetVersion) {
    throw new InvalidSnapshotError(
      "A snapshot must record the reference dataset version its figures were computed against.",
    );
  }
  if (!Number.isInteger(input.amendmentSequence) || input.amendmentSequence < 0) {
    throw new InvalidSnapshotError(
      `amendmentSequence must be a non-negative integer, got ${input.amendmentSequence}`,
    );
  }

  const seenKeys = new Set<string>();
  for (const line of input.lines) {
    if (seenKeys.has(line.key)) {
      // Two rows for one payee mean the detail cannot be reconciled back to the
      // total, which is the one property the snapshot exists to preserve.
      throw new InvalidSnapshotError(`Duplicate snapshot line key: ${JSON.stringify(line.key)}`);
    }
    seenKeys.add(line.key);
  }

  // Lines sorted by key: the order rows come out of a query must not change
  // the checksum, but a changed FIGURE must.
  const lines = [...input.lines]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((line) => `${line.key}${SEP_LINE_KEY}${canonicalizeRecord(line.values)}`)
    .join(SEP_LINE);

  return [
    `form${SEP_KEY_VALUE}${input.formCode}`,
    `start${SEP_KEY_VALUE}${input.periodStart}`,
    `end${SEP_KEY_VALUE}${input.periodEnd}`,
    `amendment${SEP_KEY_VALUE}${input.amendmentSequence}`,
    `dataset${SEP_KEY_VALUE}${input.referenceDatasetVersion}`,
    `totals${SEP_KEY_VALUE}${canonicalizeRecord(input.totals)}`,
    `lines${SEP_KEY_VALUE}${lines}`,
  ].join(SEP_SECTION);
}

/** Take the snapshot: canonicalise, hash, and return the sealed record. */
export function takeSnapshot(input: FilingSnapshotInput): FilingSnapshot {
  const checksum = createHash("sha256").update(canonicalize(input), "utf8").digest("hex");
  return { ...input, checksum, checksumAlgorithm: CHECKSUM_ALGORITHM };
}

export interface VerificationResult {
  valid: boolean;
  expected: string;
  actual: string;
  /**
   * True when the algorithm that produced the stored checksum is not the one
   * in use now. A mismatch then means "cannot verify", NOT "tampered with",
   * and the two must never be conflated in a UI.
   */
  algorithmMismatch: boolean;
}

/**
 * Re-derive the checksum and compare.
 *
 * This detects accidental mutation and drift. It is not proof against someone
 * with database write access, who could recompute the checksum after editing
 * the payload — for that the snapshot would need to be signed or written to
 * storage the application cannot rewrite.
 */
export function verifySnapshot(snapshot: FilingSnapshot): VerificationResult {
  const algorithmMismatch = snapshot.checksumAlgorithm !== CHECKSUM_ALGORITHM;
  if (algorithmMismatch) {
    return {
      valid: false,
      expected: snapshot.checksum,
      actual: "",
      algorithmMismatch: true,
    };
  }
  const actual = createHash("sha256").update(canonicalize(snapshot), "utf8").digest("hex");
  return {
    valid: actual === snapshot.checksum,
    expected: snapshot.checksum,
    actual,
    algorithmMismatch: false,
  };
}

/**
 * Compare two snapshots of the same period — an original and its amendment.
 *
 * Returns the reported figures that actually moved, which is what an amendment
 * has to explain and what a reviewer needs to see.
 */
export interface SnapshotDiff {
  totalsChanged: Array<{ field: string; from: SnapshotValue; to: SnapshotValue }>;
  linesAdded: string[];
  linesRemoved: string[];
  linesChanged: Array<{
    key: string;
    fields: Array<{ field: string; from: SnapshotValue; to: SnapshotValue }>;
  }>;
}

export function diffSnapshots(before: FilingSnapshot, after: FilingSnapshot): SnapshotDiff {
  const totalsChanged: SnapshotDiff["totalsChanged"] = [];
  for (const field of new Set([...Object.keys(before.totals), ...Object.keys(after.totals)])) {
    const from = before.totals[field] ?? null;
    const to = after.totals[field] ?? null;
    // Compared canonically: "1000" and "1000.00" are not a change.
    if (canonicalizeValue(from) !== canonicalizeValue(to)) {
      totalsChanged.push({ field, from, to });
    }
  }

  const beforeLines = new Map(before.lines.map((l) => [l.key, l.values]));
  const afterLines = new Map(after.lines.map((l) => [l.key, l.values]));

  const linesAdded = [...afterLines.keys()].filter((k) => !beforeLines.has(k)).sort();
  const linesRemoved = [...beforeLines.keys()].filter((k) => !afterLines.has(k)).sort();

  const linesChanged: SnapshotDiff["linesChanged"] = [];
  for (const [key, beforeValues] of beforeLines) {
    const afterValues = afterLines.get(key);
    if (!afterValues) continue;
    const fields: Array<{ field: string; from: SnapshotValue; to: SnapshotValue }> = [];
    for (const field of new Set([...Object.keys(beforeValues), ...Object.keys(afterValues)])) {
      const from = beforeValues[field] ?? null;
      const to = afterValues[field] ?? null;
      if (canonicalizeValue(from) !== canonicalizeValue(to)) fields.push({ field, from, to });
    }
    if (fields.length > 0) {
      fields.sort((a, b) => (a.field < b.field ? -1 : 1));
      linesChanged.push({ key, fields });
    }
  }
  linesChanged.sort((a, b) => (a.key < b.key ? -1 : 1));

  return { totalsChanged, linesAdded, linesRemoved, linesChanged };
}

/**
 * Whether two snapshots report the same figures.
 *
 * Not the same as equal checksums: an amendment that changes nothing but the
 * sequence number has a different checksum and identical figures, and telling
 * a user their amendment changed something when it did not is a real failure.
 */
export function reportsSameFigures(before: FilingSnapshot, after: FilingSnapshot): boolean {
  const diff = diffSnapshots(before, after);
  return (
    diff.totalsChanged.length === 0 &&
    diff.linesAdded.length === 0 &&
    diff.linesRemoved.length === 0 &&
    diff.linesChanged.length === 0
  );
}
