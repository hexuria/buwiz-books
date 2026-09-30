/**
 * When the Inbox v2 pane offers "Remember this?" (Inbox v2 spec §7).
 *
 * Only after a saved correction changed the answer the draft had: the accounts on either side,
 * the counterparty, or the kind of paper. Re-saving what was there — or editing only the memo, a
 * date, or an amount — has nothing new to remember, so nothing is offered.
 *
 * Pure and client-safe: it compares the draft the pane loaded with the correction it saved.
 */
import type { CandidateCorrection } from "./candidate-draft";

/** The answer a draft states, as the pane loaded it. */
export interface DraftAnswer {
  lines: ReadonlyArray<{ accountId: string | null; originalDebit: string | null }>;
  partyId: string | null;
  economicEventClass: string | null;
}

/** A correction the reviewer may remember: the candidate and the revision their save produced. */
export interface RememberOffer {
  candidateId: string;
  candidateRevision: number;
}

function signature(lines: ReadonlyArray<{ side: "debit" | "credit"; accountId: string | null }>) {
  return lines
    .map((line) => `${line.side}:${line.accountId ?? "-"}`)
    .sort()
    .join(",");
}

export function correctionChangesAnswer(
  before: DraftAnswer,
  saved: Pick<CandidateCorrection, "lines" | "partyId" | "economicEventClass">,
): boolean {
  const beforeLines = before.lines.map((line) => ({
    side: line.originalDebit !== null ? ("debit" as const) : ("credit" as const),
    accountId: line.accountId,
  }));
  const savedLines = saved.lines.map((line) => ({
    side: line.debit !== null && line.debit !== "" ? ("debit" as const) : ("credit" as const),
    accountId: line.accountId,
  }));
  if (signature(beforeLines) !== signature(savedLines)) return true;
  if ((saved.partyId ?? null) !== before.partyId) return true;
  return (
    saved.economicEventClass !== undefined && saved.economicEventClass !== before.economicEventClass
  );
}
