/**
 * The tax filing period state machine.
 *
 * A SEPARATE LOCK AXIS from the accounting close, and that separation is the
 * point (DECISIONS D-N4). `auth_organizations.closed_through` is a single
 * global ISO date, but 1601-C closes monthly, 1601-EQ and 1601-FQ quarterly on
 * calendar quarters, 2550Q on the taxpayer's fiscal quarter, and 1604-C
 * annually — all over the same transactions. Overloading one date means either
 * March cannot close for VAT until compensation is done, or it closes and can
 * never be amended.
 *
 * ── THE LADDER, AND WHY EACH RUNG EXISTS ─────────────────────────────────────
 *   open       the period is accumulating. Figures may change freely.
 *   computed   the return has been computed. Recomputation is still allowed —
 *              a corrected import is re-run, not unwound.
 *   filed      submitted to the BIR. The figures are now a matter of record:
 *              an immutable snapshot exists and the period will not recompute.
 *   amended    a superseding return was filed. The original snapshot survives,
 *              because RMC 5-2014 requires a COMPLETE re-file rather than a
 *              delta, and the as-filed figures are the only evidence of what
 *              was originally reported.
 *
 * `filed` is one-way. Reopening is not a transition — an amendment is.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type FilingPeriodState = "open" | "computed" | "filed" | "amended";

/** Every form the January slice and its immediate successors touch. */
export type TaxFormCode =
  | "1601C"
  | "1604C"
  | "2316"
  | "0619E"
  | "1601EQ"
  | "1604E"
  | "2550Q"
  | "2551Q";

/**
 * Whether a form is filed once per entity or once per withholding agent branch.
 *
 * "Returns file per branch" is wrong as a blanket rule and produces OVER-filing
 * — branch applicability is per-form (DECISIONS D5).
 */
export type FilingScope = "consolidated" | "per_withholding_agent";

export const FORM_FILING_SCOPE: Readonly<Record<TaxFormCode, FilingScope>> = {
  "1601C": "per_withholding_agent",
  "1604C": "per_withholding_agent",
  "2316": "per_withholding_agent",
  "0619E": "per_withholding_agent",
  "1601EQ": "per_withholding_agent",
  "1604E": "per_withholding_agent",
  "2550Q": "consolidated",
  "2551Q": "consolidated",
};

export interface FilingPeriod {
  formCode: TaxFormCode;
  periodStart: string;
  periodEnd: string;
  state: FilingPeriodState;
  /** Set on `filed`. Its absence on a filed period is a defect, not a gap. */
  filingReference: string | null;
  /** Checksum of the immutable as-filed snapshot. */
  snapshotChecksum: string | null;
  /** Increments on each amendment; 0 is the original. */
  amendmentSequence: number;
}

export interface TransitionContext {
  /**
   * Unacknowledged blocking variances in the period.
   *
   * D-N7: the product files the CLIENT's figure and records the variance, but
   * it refuses to mark a period filed while a variance stands unacknowledged.
   * The product is the control, not the computer of record.
   */
  unacknowledgedVariances: number;
  /** Fatal alphalist findings. A file that would be rejected must not be filed. */
  fatalPreflightFindings: number;
  /** Whether the as-filed snapshot has been taken and checksummed. */
  hasSnapshot: boolean;
  /** The BIR reference for the submission. */
  filingReference: string | null;
  /** Opening balances for the taxable year are complete (D7 Tier 1). */
  openingBalancesComplete: boolean;
}

export interface TransitionResult {
  allowed: boolean;
  /** Every reason the transition is refused, so one pass gives the whole list. */
  blockers: string[];
  nextState: FilingPeriodState | null;
}

/**
 * Whether a state transition is permitted, and why not when it is not.
 *
 * Returns blockers rather than throwing on the first: a bookkeeper closing a
 * period wants the whole list, not to fix one thing and rediscover the next.
 */
export function canTransition(
  period: FilingPeriod,
  to: FilingPeriodState,
  context: TransitionContext,
): TransitionResult {
  const blockers: string[] = [];
  const refuse = (reason: string) => blockers.push(reason);

  const legal: Record<FilingPeriodState, FilingPeriodState[]> = {
    open: ["computed"],
    // Recomputation is deliberate: a corrected import is re-run rather than
    // unwound, so `computed` loops to itself.
    computed: ["computed", "filed"],
    filed: ["amended"],
    amended: ["amended"],
  };

  if (!legal[period.state].includes(to)) {
    refuse(
      `cannot move a ${period.state} period to ${to}` +
        (period.state === "filed" && to === "open"
          ? " — a filed period is not reopened, it is amended, because the as-filed figures are a matter of record"
          : ""),
    );
    return { allowed: false, blockers, nextState: null };
  }

  if (to === "computed" && !context.openingBalancesComplete) {
    // D7 Tier 1. Without opening balances a mid-year migration computes on a
    // short numerator and understates the tax for the rest of the year.
    refuse(
      "opening balances for the taxable year are incomplete — computing now would produce a " +
        "figure built on a partial year",
    );
  }

  if (to === "filed") {
    if (context.unacknowledgedVariances > 0) {
      refuse(
        `${context.unacknowledgedVariances} variance(s) are unacknowledged — the client's figure is ` +
          `what gets filed, but the disagreement has to be recorded and acknowledged first`,
      );
    }
    if (context.fatalPreflightFindings > 0) {
      refuse(
        `${context.fatalPreflightFindings} fatal alphalist finding(s) — the file would be rejected ` +
          `at submission, after the deadline was relied on`,
      );
    }
    if (!context.hasSnapshot) {
      // Posted journals are immutable in substance now (0039), but that is not
      // a substitute: a period can still be recomputed from a corrected
      // register, and an amendment supersedes the original. The snapshot is the
      // only record of the FIGURES as reported, and the only thing that names
      // the reference-dataset version they were computed against.
      refuse("no as-filed snapshot has been taken — it is the only evidence of what was reported");
    }
    if (!context.filingReference) {
      refuse("no filing reference recorded");
    }
  }

  if (to === "amended") {
    if (!context.filingReference) refuse("an amendment needs its own filing reference");
    if (!context.hasSnapshot) refuse("an amendment needs its own as-filed snapshot");
  }

  return { allowed: blockers.length === 0, blockers, nextState: blockers.length === 0 ? to : null };
}

/** Apply a transition. Callers must have checked `canTransition` first. */
export function applyTransition(
  period: FilingPeriod,
  to: FilingPeriodState,
  context: TransitionContext,
): FilingPeriod {
  const result = canTransition(period, to, context);
  if (!result.allowed) {
    throw new Error(
      `illegal filing-period transition ${period.state} → ${to}: ${result.blockers.join("; ")}`,
    );
  }
  return {
    ...period,
    state: to,
    filingReference: to === "open" ? null : (context.filingReference ?? period.filingReference),
    snapshotChecksum: period.snapshotChecksum,
    // An amendment supersedes; the original snapshot is retained separately
    // because RMC 5-2014 requires a complete re-file and the prior figures are
    // the record of what was originally reported.
    amendmentSequence: to === "amended" ? period.amendmentSequence + 1 : period.amendmentSequence,
  };
}

/**
 * Whether the accounting close may advance past a date.
 *
 * The tax lock is the stronger of the two: `closed_through` must not sweep past
 * a period whose return is still open, or the transactions behind an unfiled
 * return become uneditable before the return is even computed.
 */
export function blocksAccountingClose(
  periods: readonly FilingPeriod[],
  throughDate: string,
): FilingPeriod[] {
  return periods.filter(
    (p) => p.periodEnd <= throughDate && (p.state === "open" || p.state === "computed"),
  );
}
