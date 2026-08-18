/**
 * Reference-data staleness and ownership.
 *
 * The monthly sweep routine exists and fires on schedule. What it does not
 * have is a named human to read what it finds — and that gap cannot be closed
 * from here, because it needs someone to be named.
 *
 * What CAN be closed is the failure mode that gap creates. An unowned dataset
 * does not announce itself; it simply goes unread, and the tables quietly age
 * until a bracket that changed eighteen months ago produces a wrong return.
 * The absence of an owner is therefore treated here as a REPORTABLE CONDITION
 * in its own right, not as a blank field.
 *
 * THE ASYMMETRY THAT SHAPES THE THRESHOLDS. Stale reference data does not fail
 * loudly. Every computation against it succeeds, reconciles, and passes every
 * check in this codebase — because those checks verify internal consistency,
 * and a stale table is perfectly self-consistent. It is wrong only against the
 * outside world. So the staleness signal has to be time-based and
 * unmissable: nothing else in the system will ever raise it.
 */

/** How reference data ages, and what each stage means. */
export type StalenessLevel = "fresh" | "aging" | "stale" | "unverified";

export interface DatasetStatus {
  datasetKey: string;
  /** Null when nobody has ever verified it — different from long-ago. */
  lastVerifiedAt: string | null;
  /** Null when no human is accountable for this dataset. */
  ownerName: string | null;
  level: StalenessLevel;
  daysSinceVerified: number | null;
  /** Every reason this dataset needs attention, most serious first. */
  concerns: string[];
}

/**
 * Thresholds, in days.
 *
 * Chosen against how BIR reference data actually moves: rates change by
 * revenue regulation, usually with weeks of notice and an effective date that
 * may be retroactive. A table unchecked for a quarter has probably missed at
 * least the opportunity to have noticed one.
 */
export const AGING_AFTER_DAYS = 45;
export const STALE_AFTER_DAYS = 90;

export interface StalenessInput {
  datasetKey: string;
  lastVerifiedAt: string | null;
  ownerName: string | null;
  /** Today, injected so the check is testable and deterministic. */
  asOf: string;
}

function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Math.floor((b - a) / 86_400_000);
}

/**
 * Assess one dataset.
 *
 * "Never verified" is deliberately its own level rather than "very stale". A
 * dataset checked eighteen months ago was at least right once; one never
 * checked has no such claim, and the remedy differs — the first needs a
 * re-read, the second needs someone to establish a baseline.
 */
export function assessStaleness(input: StalenessInput): DatasetStatus {
  const concerns: string[] = [];

  const days = input.lastVerifiedAt ? daysBetween(input.lastVerifiedAt, input.asOf) : null;

  let level: StalenessLevel;
  if (days === null) {
    level = "unverified";
    concerns.push(
      "Never verified against the source. Seeded values may be correct, but nothing has " +
        "confirmed it — establish a baseline before relying on this for a filing.",
    );
  } else if (days >= STALE_AFTER_DAYS) {
    level = "stale";
    concerns.push(
      `Not verified for ${days} days. Rates change by revenue regulation, sometimes with a ` +
        `retroactive effective date — a table this old may already have produced wrong returns.`,
    );
  } else if (days >= AGING_AFTER_DAYS) {
    level = "aging";
    concerns.push(`Not verified for ${days} days. Due for its next check.`);
  } else {
    level = "fresh";
  }

  if (!input.ownerName) {
    // The condition that cannot be fixed in code. Reported so it is visible
    // rather than silently absent — an unowned dataset is simply never read.
    concerns.push(
      "No owner assigned. The monthly sweep will keep producing findings that nobody is " +
        "accountable for reading, which is indistinguishable from not running it at all.",
    );
  }

  return {
    datasetKey: input.datasetKey,
    lastVerifiedAt: input.lastVerifiedAt,
    ownerName: input.ownerName,
    level,
    daysSinceVerified: days,
    concerns,
  };
}

export interface StalenessReport {
  asOf: string;
  datasets: DatasetStatus[];
  /** Datasets with no accountable human. */
  unowned: string[];
  /** Datasets stale or never verified. */
  needsAttention: string[];
  /**
   * Whether reference data is fit to file against.
   *
   * False when anything is stale or unverified. It does NOT go false merely
   * for an absent owner: a dataset verified last week is fit to use today even
   * if nobody owns it long-term. Conflating the two would either cry wolf now
   * or hide real staleness later.
   */
  fitToFile: boolean;
  summary: string;
}

export function buildStalenessReport(inputs: StalenessInput[]): StalenessReport {
  const datasets = inputs.map(assessStaleness);
  const unowned = datasets.filter((d) => !d.ownerName).map((d) => d.datasetKey);
  const needsAttention = datasets
    .filter((d) => d.level === "stale" || d.level === "unverified")
    .map((d) => d.datasetKey);

  const asOf = inputs[0]?.asOf ?? "";
  const fitToFile = needsAttention.length === 0;

  const parts: string[] = [];
  if (needsAttention.length > 0) {
    parts.push(
      `${needsAttention.length} dataset(s) stale or unverified: ${needsAttention.join(", ")}.`,
    );
  }
  if (unowned.length > 0) {
    parts.push(
      `${unowned.length} dataset(s) have no owner: ${unowned.join(", ")}. ` +
        `Assign one — the sweep's findings go unread otherwise.`,
    );
  }
  if (parts.length === 0) {
    parts.push("All reference datasets are current and owned.");
  }

  return { asOf, datasets, unowned, needsAttention, fitToFile, summary: parts.join(" ") };
}
