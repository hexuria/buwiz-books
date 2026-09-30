// ============================================================================
// Inbox stage 2 plan: what one enriched draft needs, decided without a model.
//
// Pure. The economic event from stage 1 decides which placeholder line is the
// category (the debit of a purchase, bill, or payroll; the credit of a sale or
// invoice) and what role the counterparty plays. Payments and transfers have
// no category line: their two sides are balance-sheet accounts a reviewer
// picks. Only the two unselected placeholder lines enrichment writes are ever
// planned for.
// ============================================================================

import type { transactionCandidateLines, transactionCandidates } from "@/db/schema/inbox";
import type { MatchableEntityType } from "@/lib/party-match/normalize";
import type { PartyMatchQuery } from "@/lib/party-match/pipeline";
import type { DocumentFacts } from "./candidate-document-facts";
import type { CategoryDirection, CategoryLineRequest } from "./line-categorization";
import { parseMoneyToScaled, scaledToMoney } from "./money";

type CandidateRow = typeof transactionCandidates.$inferSelect;
type LineRow = typeof transactionCandidateLines.$inferSelect;

export type EconomicEvent =
  | "purchase"
  | "sale"
  | "bill_accrual"
  | "bill_payment"
  | "invoice_accrual"
  | "invoice_payment"
  | "transfer"
  | "payroll"
  | "other";

/** Which side of a two-line draft is the category, by economic event. */
const CATEGORY_SIDE: Partial<Record<EconomicEvent, CategoryDirection>> = {
  purchase: "outflow",
  bill_accrual: "outflow",
  payroll: "outflow",
  sale: "inflow",
  invoice_accrual: "inflow",
};

/** The counterparty's role, by economic event. Transfers have none. */
const COUNTERPARTY_ROLE: Partial<Record<EconomicEvent, MatchableEntityType>> = {
  purchase: "vendor",
  bill_accrual: "vendor",
  bill_payment: "vendor",
  payroll: "employee",
  sale: "customer",
  invoice_accrual: "customer",
  invoice_payment: "customer",
};

/** The counterparty's role for an economic event, or null when it has none. */
export function counterpartyRoleFor(event: string | null | undefined): MatchableEntityType | null {
  if (!event || !Object.hasOwn(COUNTERPARTY_ROLE, event)) return null;
  return COUNTERPARTY_ROLE[event as EconomicEvent] ?? null;
}

/** Roles we pay, so a changed payee bank account is the fraud path. */
export const PAYEE_ROLES: ReadonlySet<MatchableEntityType> = new Set(["vendor", "employee"]);

export interface ClassificationPlan {
  event: EconomicEvent;
  direction: CategoryDirection | null;
  categoryLines: CategoryLineRequest[];
  /** Line id per requested lineIndex. */
  lineIdByIndex: Map<number, string>;
  role: MatchableEntityType | null;
  partyQuery: PartyMatchQuery | null;
}

function economicEvent(value: string | null | undefined, transactionType: string): EconomicEvent {
  const known: EconomicEvent[] = [
    "purchase",
    "sale",
    "bill_accrual",
    "bill_payment",
    "invoice_accrual",
    "invoice_payment",
    "transfer",
    "payroll",
    "other",
  ];
  if (value && (known as string[]).includes(value)) return value as EconomicEvent;
  if (transactionType === "pay_out") return "purchase";
  if (transactionType === "pay_in") return "sale";
  return "other";
}

export function isPlaceholderLine(
  line: Pick<LineRow, "accountId" | "predictionEvidence">,
): boolean {
  return line.accountId === null && line.predictionEvidence?.accountSelection === "not_inferred";
}

/**
 * Decide what stage 2 does for this draft. Pure. Only the two unselected
 * placeholder lines the extraction writes are ever classified.
 */
export function planCandidateClassification(input: {
  candidate: Pick<CandidateRow, "memo" | "transactionType">;
  lines: ReadonlyArray<
    Pick<LineRow, "id" | "accountId" | "predictionEvidence" | "originalDebit" | "originalCredit">
  >;
  economicEventClass: string | null;
  facts: DocumentFacts;
}): ClassificationPlan {
  const event = economicEvent(input.economicEventClass, input.candidate.transactionType);
  const direction = CATEGORY_SIDE[event] ?? null;
  const role = COUNTERPARTY_ROLE[event] ?? null;
  const description = input.candidate.memo?.trim() ?? "";
  const categoryLines: CategoryLineRequest[] = [];
  const lineIdByIndex = new Map<number, string>();
  if (direction) {
    const side = direction === "outflow" ? "debit" : "credit";
    const index = input.lines.findIndex(
      (line) =>
        isPlaceholderLine(line) &&
        (side === "debit" ? line.originalDebit !== null : line.originalCredit !== null),
    );
    if (index >= 0) {
      const line = input.lines[index];
      const amount = side === "debit" ? line.originalDebit : line.originalCredit;
      categoryLines.push({
        lineIndex: index,
        side,
        direction,
        description,
        amount: scaledToMoney(parseMoneyToScaled(amount)),
      });
      lineIdByIndex.set(index, line.id);
    }
  }
  const partyName = input.facts.partyName?.trim() ?? "";
  const partyQuery: PartyMatchQuery | null =
    role && (partyName || input.facts.partyTaxId || input.facts.partyEmails.length > 0)
      ? {
          name: partyName,
          entityType: role,
          taxId: input.facts.partyTaxId,
          emails: input.facts.partyEmails,
          description,
        }
      : null;
  return { event, direction, categoryLines, lineIdByIndex, role, partyQuery };
}
