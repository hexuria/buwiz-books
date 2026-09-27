/**
 * The New transaction editor's state as one value, so a caller can seed the editor (the Inbox
 * prefills it from a candidate) and read back what the user entered.
 *
 * Every tab's fields are present at once, exactly as the editor holds them: switching tabs
 * converts between them, and amounts stay the strings the inputs hold.
 */
import type { JournalLine, PayForLine, TabType } from "../shared/types";
import { emptyJournalLine, emptyPayForLine, todayISO } from "../shared/helpers";

export interface TransactionDraft {
  type: TabType;
  date: string;
  referenceNumber: string;
  memo: string;
  /** Journal tab. */
  journalLines: JournalLine[];
  /** Pay In / Pay Out: the counterparty, the bank-side category, and what was paid for. */
  payPartyId: string;
  payCategoryId: string;
  payForLines: PayForLine[];
  /** Transfer tab. */
  transferFromParty: string;
  transferFromCategory: string;
  transferToParty: string;
  transferToCategory: string;
  transferAmount: string;
}

/** What /transactions/new opens with: an empty journal dated today. */
export function newTransactionDraft(): TransactionDraft {
  return {
    type: "journal",
    date: todayISO(),
    referenceNumber: "",
    memo: "",
    journalLines: [emptyJournalLine(), emptyJournalLine()],
    payPartyId: "",
    payCategoryId: "",
    payForLines: [emptyPayForLine()],
    transferFromParty: "",
    transferFromCategory: "",
    transferToParty: "",
    transferToCategory: "",
    transferAmount: "",
  };
}
