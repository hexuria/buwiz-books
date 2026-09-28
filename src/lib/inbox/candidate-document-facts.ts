// ============================================================================
// What inbox stage 2 reads from a candidate's documents and source.
//
// Kept apart from the classifier (and its AI façade import) so the reviewer's
// correction path can run the payment-details check on the same facts.
// Ordering follows deriveDocumentSourceFacts: the inbox extraction beats the
// bill OCR cache, which beats the receipt parse cache, and earlier documents
// win.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { documentAttachments, documents } from "@/db/schema/documents";
import { sourceRecordDocuments } from "@/db/schema/inbox";
import { extractEmailAddress } from "@/lib/party-match/normalize";

export function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function text(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed || null;
}

function amountText(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return "";
}

/** A sender's display name, unless it is a generic mailbox label. */
function senderDisplayName(from: string | null): string | null {
  const displayName = from?.match(/^\s*"?([^"<]+?)"?\s*</u)?.[1]?.trim();
  if (!displayName) return null;
  return /^(?:no[-_. ]?reply|orders?|receipts?|support|billing|invoices?)$/iu.test(displayName)
    ? null
    : displayName;
}

export interface DocumentFacts {
  documentIds: string[];
  documentTypes: Array<{ id: string; documentType: string }>;
  kind: string | null;
  partyName: string | null;
  partyEmails: string[];
  partyTaxId: string | null;
  payeeBankAccountNumber: string | null;
  payeeBankRoutingNumber: string | null;
  lineItems: Array<{ description: string; amount: string }>;
  /** The document whose extraction supplied the payee bank details. */
  paymentDetailsDocumentId: string | null;
}

export interface DocumentRow {
  id: string;
  documentType: string;
  metadata: unknown;
  aiTransactionCache: unknown;
}

/**
 * Collect the facts stage 2 reads from the candidate's documents and source.
 * Pure. Earlier documents win; the inbox extraction beats the bill OCR cache,
 * which beats the receipt parse cache, exactly as deriveDocumentSourceFacts
 * orders them.
 */
export function collectDocumentFacts(
  rows: readonly DocumentRow[],
  sender: { from: string | null },
): DocumentFacts {
  const facts: DocumentFacts = {
    documentIds: rows.map((row) => row.id),
    documentTypes: rows.map((row) => ({ id: row.id, documentType: row.documentType })),
    kind: null,
    partyName: null,
    partyEmails: [],
    partyTaxId: null,
    payeeBankAccountNumber: null,
    payeeBankRoutingNumber: null,
    lineItems: [],
    paymentDetailsDocumentId: null,
  };
  const emails: string[] = [];
  for (const row of rows) {
    const metadata = record(row.metadata);
    const inbox = record(record(metadata?.inboxExtraction)?.result);
    const bill = record(record(metadata?.billOcr)?.result);
    const billVendor = record(bill?.vendor);
    const parsed = record(record(row.aiTransactionCache)?.result);
    const triage = record(metadata?.triage);

    facts.kind ??=
      text(triage?.docKind) ?? (row.documentType !== "other" ? row.documentType : null);
    facts.partyName ??=
      text(inbox?.party) ??
      text(metadata?.extractedVendor) ??
      text(billVendor?.name) ??
      text(parsed?.partyName);
    facts.partyTaxId ??= text(inbox?.partyTaxId);
    for (const email of [text(inbox?.partyEmail), text(billVendor?.email)]) {
      if (email) emails.push(email);
    }
    const payeeAccount = text(inbox?.payeeBankAccountNumber);
    if (!facts.payeeBankAccountNumber && payeeAccount) {
      facts.payeeBankAccountNumber = payeeAccount;
      facts.payeeBankRoutingNumber = text(inbox?.payeeBankRoutingNumber);
      facts.paymentDetailsDocumentId = row.id;
    }
    if (facts.lineItems.length === 0) {
      const items = Array.isArray(bill?.lineItems)
        ? bill.lineItems
        : Array.isArray(parsed?.lines)
          ? parsed.lines
          : [];
      facts.lineItems = items
        .map((item) => record(item))
        .filter((item): item is Record<string, unknown> => item !== null)
        .map((item) => ({
          description: text(item.description) ?? "",
          amount: amountText(item.amount),
        }))
        .filter((item) => item.description);
    }
  }
  facts.partyName ??= senderDisplayName(sender.from);
  const senderEmail = extractEmailAddress(sender.from);
  if (senderEmail) emails.push(senderEmail);
  facts.partyEmails = [
    ...new Set(emails.map((email) => extractEmailAddress(email)).filter((e): e is string => !!e)),
  ];
  return facts;
}

/** The candidate's source documents and attachments, with their cached extractions. */
export async function loadCandidateDocuments(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
  sourceRecordId: string | null,
): Promise<DocumentRow[]> {
  const columns = {
    id: documents.id,
    documentType: documents.documentType,
    metadata: documents.metadata,
    aiTransactionCache: documents.aiTransactionCache,
  };
  const fromSource = sourceRecordId
    ? await db
        .select(columns)
        .from(sourceRecordDocuments)
        .innerJoin(documents, eq(sourceRecordDocuments.documentId, documents.id))
        .where(
          and(
            eq(sourceRecordDocuments.organizationId, orgId),
            eq(documents.organizationId, orgId),
            eq(sourceRecordDocuments.sourceRecordId, sourceRecordId),
          ),
        )
    : [];
  const attached = await db
    .select(columns)
    .from(documentAttachments)
    .innerJoin(documents, eq(documentAttachments.documentId, documents.id))
    .where(
      and(
        eq(documentAttachments.organizationId, orgId),
        eq(documents.organizationId, orgId),
        eq(documentAttachments.linkableType, "transaction_candidate"),
        eq(documentAttachments.linkableId, candidateId),
      ),
    );
  return [...new Map([...fromSource, ...attached].map((row) => [row.id, row])).values()];
}
