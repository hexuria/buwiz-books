/**
 * Stage 2's doubts, read back for the Inbox v2 reasons.
 *
 * Stage 2 (src/lib/inbox/candidate-classification.ts) records each category answer on the line
 * it classified — prediction evidence `{ source: "inbox_classification", outcome, confidence }`
 * — and the counterparty outcome on its `candidate_classified` workflow event. An outcome it
 * could not use is a doubt:
 *
 *   category  `low_confidence` (a pick below the threshold, kept only as a hint), or
 *             `model_failed` / `missing` / `rejected` (no usable answer). The line was parked on
 *             the mapped Uncategorized account, or left empty where none is mapped. `no_fit` is
 *             an answer — nothing in the chart fits — so the finding it leaves is a fix.
 *   party     `unresolved`: below the threshold, a choice outside the list, or no answer. The
 *             candidate was left without a counterparty. "new" is an answer, not a doubt.
 *
 * A reviewer's correction rewrites the lines without evidence and moves the revision past the
 * event, so a doubt lasts exactly until a person has settled the entry.
 *
 * Pure: the list query hands over the raw JSON, and this turns it into signals.
 */
import type { InboxV2EntryShape, ModelUnsureSignal } from "./triage";

/** Stage 2's `prediction_evidence.source` on the lines it classified. */
export const CLASSIFICATION_EVIDENCE_SOURCE = "inbox_classification";
/** Stage 2's workflow event, one per classified revision. */
export const CANDIDATE_CLASSIFIED_ACTION = "candidate_classified";
/** The event's party outcome when no counterparty could be linked from the model's answer. */
export const UNRESOLVED_PARTY_OUTCOME = "unresolved";

const CATEGORY_DOUBT_CAUSES: Readonly<Record<string, ModelUnsureSignal["cause"]>> = {
  low_confidence: "low_confidence",
  model_failed: "failed",
  missing: "failed",
  rejected: "failed",
};

/** One candidate line, in line order, as the list query reads it. */
export interface CandidateLineFacts {
  hasAccount: boolean;
  evidenceSource: string | null;
  outcome: string | null;
  confidence: number | null;
}

function confidenceFrom(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function textFrom(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function lineFactsFrom(raw: unknown): CandidateLineFacts[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((entry) => {
    const line = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
    return {
      hasAccount: line.hasAccount === true,
      evidenceSource: textFrom(line.evidenceSource),
      outcome: textFrom(line.outcome),
      confidence: confidenceFrom(line.confidence),
    };
  });
}

export function entryShapeOf(lines: readonly CandidateLineFacts[]): InboxV2EntryShape {
  return {
    lineCount: lines.length,
    linesWithoutAccount: lines.flatMap((line, index) => (line.hasAccount ? [] : [index])),
  };
}

function categoryDoubtsOf(lines: readonly CandidateLineFacts[]): ModelUnsureSignal[] {
  return lines.flatMap((line, lineIndex): ModelUnsureSignal[] => {
    if (line.evidenceSource !== CLASSIFICATION_EVIDENCE_SOURCE || line.outcome === null) return [];
    const cause = CATEGORY_DOUBT_CAUSES[line.outcome];
    if (!cause) return [];
    return [
      {
        subject: "category",
        cause,
        confidence: cause === "low_confidence" ? line.confidence : null,
        lineIndex,
      },
    ];
  });
}

/**
 * The party summary of the classification event that produced the candidate's current
 * revision, when that event left the counterparty unresolved and nothing has linked one since.
 */
function partyDoubtFrom(raw: unknown): ModelUnsureSignal | null {
  if (!raw || typeof raw !== "object") return null;
  const party = raw as Record<string, unknown>;
  if (party.outcome !== UNRESOLVED_PARTY_OUTCOME) return null;
  const lowConfidence = party.reason === "low_confidence";
  return {
    subject: "party",
    cause: lowConfidence ? "low_confidence" : "failed",
    confidence: lowConfidence ? confidenceFrom(party.confidence) : null,
    lineIndex: null,
  };
}

/** Everything stage 2 was unsure of on one item: its category lines, then its counterparty. */
export function modelUnsureSignalsFor(input: {
  lines: readonly CandidateLineFacts[];
  unresolvedParty: unknown;
}): ModelUnsureSignal[] {
  const party = partyDoubtFrom(input.unresolvedParty);
  return [...categoryDoubtsOf(input.lines), ...(party ? [party] : [])];
}
