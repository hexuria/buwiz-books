/**
 * The filing workspace — Stage 4.
 *
 * Everything before this stage produced a correct engine that nothing could
 * reach. This is the connective tissue: it takes a period, gathers what every
 * separate check has to say about it, and answers the only question a filer
 * actually has — **can I file this, and if not, what do I fix first?**
 *
 * WHY ASSEMBLE RATHER THAN RE-DERIVE. Each engine already knows its own
 * blockers: `canTransition` knows the state machine's, `summarizePreflight`
 * knows the alphalist's, `buildForm1601C` knows the reconciliation's, and the
 * variance verifier knows D-N7's. Re-implementing any of that here would
 * create a second opinion that can disagree with the first, and the one a user
 * sees would be whichever happened to be wired to the screen. So this module
 * collects and ORDERS; it does not judge.
 *
 * ORDERING IS THE ACTUAL PRODUCT. A filer facing nine blockers needs to know
 * which one to fix first, and the order is not arbitrary — some blockers make
 * others unresolvable. Opening balances gate the computation; the computation
 * gates the variance review; the review gates posting; posting gates the
 * reconciliation; the reconciliation gates the snapshot; the snapshot gates
 * filing. Presenting them as an unordered list makes a filer fix a symptom and
 * watch three more appear.
 */
import {
  canTransition,
  type FilingPeriod,
  type FilingPeriodState,
  type TaxFormCode,
  type TransitionContext,
} from "@/lib/tax/filing-period";
import type { PreflightFinding } from "@/lib/tax/alphalist-preflight";

/**
 * What must be true before a step can be attempted.
 *
 * Ordered by dependency, not by severity. A blocker in an earlier stage makes
 * every later one unresolvable, so this is the sequence a filer works through.
 */
export type FilingStage =
  | "opening_balances"
  | "computation"
  | "variance_review"
  | "posting"
  | "reconciliation"
  | "preflight"
  | "snapshot"
  | "submission";

export const FILING_STAGE_ORDER: readonly FilingStage[] = [
  "opening_balances",
  "computation",
  "variance_review",
  "posting",
  "reconciliation",
  "preflight",
  "snapshot",
  "submission",
];

const STAGE_LABEL: Record<FilingStage, string> = {
  opening_balances: "Opening balances",
  computation: "Computation",
  variance_review: "Variance review",
  posting: "Ledger posting",
  reconciliation: "Reconciliation",
  preflight: "File pre-flight",
  snapshot: "As-filed snapshot",
  submission: "Submission",
};

export interface FilingBlocker {
  stage: FilingStage;
  stageLabel: string;
  message: string;
  /**
   * Whether this blocker can be cleared by the user in the product, or needs
   * something from outside it — a client's acknowledgement, a missing
   * certificate, a BIR reference. The distinction is what makes a checklist
   * actionable instead of merely accurate.
   */
  resolvableInProduct: boolean;
}

export interface FilingWorkspaceInput {
  period: FilingPeriod;
  /** Where the period is trying to get to. */
  targetState: FilingPeriodState;
  context: TransitionContext;

  /** Alphalist findings, when the form carries one. */
  preflightFindings?: readonly PreflightFinding[];
  /** Reconciliation blockers from the form builder, already phrased. */
  reconciliationIssues?: readonly string[];
  /** Whether the period's ledger posting has happened. */
  posted?: boolean;
}

export interface FilingWorkspace {
  formCode: TaxFormCode;
  periodStart: string;
  periodEnd: string;
  currentState: FilingPeriodState;
  targetState: FilingPeriodState;

  canFile: boolean;
  /** Every blocker, ordered by the stage that must be cleared first. */
  blockers: FilingBlocker[];
  /** The one to work on now, or null when nothing is blocking. */
  nextAction: FilingBlocker | null;

  /** Per-stage status, for a progress view. */
  stages: Array<{
    stage: FilingStage;
    label: string;
    status: "clear" | "blocked" | "not_applicable";
    blockerCount: number;
  }>;
}

/**
 * Assemble everything blocking a period from being filed.
 *
 * Deliberately takes already-computed results rather than doing its own
 * queries: the same assembly then works for a preview, a scheduled check and
 * the screen, and a test can drive it without a database.
 */
export function buildFilingWorkspace(input: FilingWorkspaceInput): FilingWorkspace {
  const blockers: FilingBlocker[] = [];

  const add = (stage: FilingStage, message: string, resolvableInProduct = true) => {
    blockers.push({ stage, stageLabel: STAGE_LABEL[stage], message, resolvableInProduct });
  };

  // ── Opening balances ────────────────────────────────────────────────────
  if (!input.context.openingBalancesComplete) {
    // Gates everything: a year-to-date figure computed without opening
    // balances is wrong in a way no later step can detect.
    add(
      "opening_balances",
      "Opening balances for the taxable year are incomplete. Every year-to-date figure computed " +
        "without them is wrong, and no later check can tell.",
      false,
    );
  }

  // ── Variance review (D-N7) ──────────────────────────────────────────────
  if (input.context.unacknowledgedVariances > 0) {
    add(
      "variance_review",
      `${input.context.unacknowledgedVariances} variance(s) are unacknowledged. The product files ` +
        `the client's figure, but not until someone has said so on the record.`,
      false,
    );
  }

  // ── Posting ─────────────────────────────────────────────────────────────
  if (input.posted === false) {
    add(
      "posting",
      "The period has not been posted to the ledger, so nothing can be reconciled against the " +
        "control account.",
    );
  }

  // ── Reconciliation ──────────────────────────────────────────────────────
  for (const issue of input.reconciliationIssues ?? []) {
    add("reconciliation", issue);
  }

  // ── Pre-flight ──────────────────────────────────────────────────────────
  const fatalFindings = (input.preflightFindings ?? []).filter((f) => f.severity === "fatal");
  for (const finding of fatalFindings) {
    add(
      "preflight",
      `${finding.code}: ${finding.message}`,
      // A missing TIN needs the employee; banned characters we can transliterate.
      !finding.code.includes("TIN"),
    );
  }

  // ── Snapshot ────────────────────────────────────────────────────────────
  if (!input.context.hasSnapshot) {
    add(
      "snapshot",
      "No as-filed snapshot has been taken. It is the only record of the figures as reported and " +
        "of the reference dataset they were computed against.",
    );
  }

  // ── Submission ──────────────────────────────────────────────────────────
  if (!input.context.filingReference) {
    add(
      "submission",
      "No filing reference recorded. Submit the return and enter the BIR reference.",
      false,
    );
  }

  // The state machine gets the last word, but its context-based refusals
  // duplicate the checks above — it looks at the same five context fields.
  // Matching its wording against ours to deduplicate was fragile and produced
  // the same problem twice under trivial phrasing differences.
  //
  // Instead: ask it again with a DELIBERATELY CLEAN context. Anything it still
  // refuses cannot be about the context, so it is a transition-legality
  // objection — "a filed period cannot go back to computed" — which none of
  // the checks above would ever produce and which must still reach the user.
  const transition = canTransition(input.period, input.targetState, input.context);
  const legalityOnly = canTransition(input.period, input.targetState, {
    unacknowledgedVariances: 0,
    fatalPreflightFindings: 0,
    hasSnapshot: true,
    filingReference: "—",
    openingBalancesComplete: true,
  });
  for (const reason of legalityOnly.blockers) {
    add("submission", reason, false);
  }

  blockers.sort(
    (a, b) => FILING_STAGE_ORDER.indexOf(a.stage) - FILING_STAGE_ORDER.indexOf(b.stage),
  );

  const stages = FILING_STAGE_ORDER.map((stage) => {
    const count = blockers.filter((b) => b.stage === stage).length;
    const applicable =
      stage !== "preflight" || input.preflightFindings !== undefined ? true : false;
    return {
      stage,
      label: STAGE_LABEL[stage],
      status: (!applicable ? "not_applicable" : count > 0 ? "blocked" : "clear") as
        | "clear"
        | "blocked"
        | "not_applicable",
      blockerCount: count,
    };
  });

  return {
    formCode: input.period.formCode,
    periodStart: input.period.periodStart,
    periodEnd: input.period.periodEnd,
    currentState: input.period.state,
    targetState: input.targetState,
    canFile: blockers.length === 0 && transition.allowed,
    blockers,
    nextAction: blockers[0] ?? null,
    stages,
  };
}
