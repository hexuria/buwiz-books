import type { DbExecutor } from "@/db";

export const INBOX_OPEN_STATES = [
  "received",
  "processing",
  "needs_information",
  "ready_for_review",
] as const;

export type InboxOpenState = (typeof INBOX_OPEN_STATES)[number];
export type InboxItemState = InboxOpenState | "approved" | "rejected" | "dismissed" | "failed";

export type CandidateSourceChannel =
  | "manual"
  | "csv"
  | "upload"
  | "email"
  | "bank"
  | "card"
  | "bills_expenses"
  | "payroll"
  | "revenue";

export interface CandidateLineInput {
  accountId?: string | null;
  debit?: string | null;
  credit?: string | null;
  originalDebit?: string | null;
  originalCredit?: string | null;
  originalCurrency?: string;
  exchangeRate?: string;
  lineDescription?: string | null;
  partyId?: string | null;
  departmentId?: string | null;
  locationId?: string | null;
  categoryConfidence?: string | null;
  predictionEvidence?: Record<string, unknown> | null;
  sortOrder?: number;
}

export interface CreateCandidateInput {
  transactionDate: string;
  transactionType: "pay_in" | "pay_out" | "journal" | "transfer";
  memo?: string | null;
  partyId?: string | null;
  referenceNumber?: string | null;
  originalCurrency?: string;
  functionalCurrency?: string;
  exchangeRate?: string;
  exchangeRateId?: string | null;
  sourceChannel?: CandidateSourceChannel;
  sourceProvider?: string;
  /**
   * Identifies one client submission attempt independently of provider identity.
   * Reusing this key must return the original candidate instead of creating another.
   */
  requestIdempotencyKey?: string;
  /**
   * Optional caller-owned digest when a higher-level workflow (for example a
   * bill plus its Inbox candidate) must bind both records to the same request.
   * Ordinary transaction callers let the Inbox service calculate this value.
   */
  requestPayloadHash?: string;
  externalId?: string | null;
  externalVersion?: string;
  candidateType?: string;
  documentIds?: string[];
  lines: CandidateLineInput[];
}

export interface InboxServiceContext {
  db: DbExecutor;
  orgId: string;
  userId: string;
  role: string;
}

export interface ReviewFindingDraft {
  ruleKey: string;
  impact: "blocking" | "warning";
  message: string;
  evidence: Record<string, unknown>;
}
