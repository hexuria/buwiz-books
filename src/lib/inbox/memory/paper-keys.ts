// ============================================================================
// Loading the facts memory keys are derived from (Inbox v2 §7).
//
// One loader serves inbox stage 2 (one paper), "Remember this?" (one paper)
// and the scope preview (a capped batch), so a key is derived the same way
// wherever it is computed. Only the handful of JSON fields a key reads are
// selected — never a document's OCR text.
//
// Every query filters organization_id explicitly AND runs on the caller's
// org-context executor, so RLS scopes it a second time.
// ============================================================================

import { and, asc, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { documentAttachments, documents } from "@/db/schema/documents";
import { sourceRecordDocuments, sourceRecords } from "@/db/schema/inbox";
import {
  derivePaperKeys,
  paperDocumentFacts,
  partyKey,
  type PaperDocumentFacts,
  type PaperKeyInput,
  type PaperKeys,
} from "./keys";

export interface PaperSubject {
  /** The transaction candidate. */
  id: string;
  sourceRecordId: string | null;
  partyId: string | null;
}

const extractionColumns = {
  documentId: documents.id,
  contentHash: documents.contentHash,
  inboxDescription: sql<
    string | null
  >`${documents.metadata} -> 'inboxExtraction' -> 'result' ->> 'description'`,
  transactionMemo: sql<string | null>`${documents.aiTransactionCache} -> 'result' ->> 'memo'`,
  billNotes: sql<
    string | null
  >`${documents.metadata} -> 'billOcr' -> 'result' -> 'invoice' ->> 'notes'`,
  inboxPartyTaxId: sql<
    string | null
  >`${documents.metadata} -> 'inboxExtraction' -> 'result' ->> 'partyTaxId'`,
  inboxPartyEmail: sql<
    string | null
  >`${documents.metadata} -> 'inboxExtraction' -> 'result' ->> 'partyEmail'`,
  billVendorEmail: sql<
    string | null
  >`${documents.metadata} -> 'billOcr' -> 'result' -> 'vendor' ->> 'email'`,
};

type ExtractionRow = {
  documentId: string;
  contentHash: string | null;
  inboxDescription: string | null;
  transactionMemo: string | null;
  billNotes: string | null;
  inboxPartyTaxId: string | null;
  inboxPartyEmail: string | null;
  billVendorEmail: string | null;
};

function pushDocument(
  bucket: Map<string, ExtractionRow[]>,
  owner: string,
  row: ExtractionRow,
): void {
  const list = bucket.get(owner) ?? [];
  list.push(row);
  bucket.set(owner, list);
}

/**
 * The key inputs of each paper, read live: its source's documents (in the
 * order they were attached), then documents attached to the candidate itself;
 * the From header of its source or of the email that source came in.
 */
export async function loadPaperKeyInputs(
  db: DbExecutor,
  orgId: string,
  subjects: readonly PaperSubject[],
): Promise<Map<string, PaperKeyInput>> {
  const result = new Map<string, PaperKeyInput>();
  if (subjects.length === 0) return result;
  const candidateIds = [...new Set(subjects.map((subject) => subject.id))];
  const sourceIds = [
    ...new Set(
      subjects.flatMap((subject) => (subject.sourceRecordId ? [subject.sourceRecordId] : [])),
    ),
  ];

  const sources =
    sourceIds.length > 0
      ? await db
          .select({
            id: sourceRecords.id,
            from: sql<string | null>`${sourceRecords.rawData} ->> 'from'`,
            parentSourceRecordId: sourceRecords.parentSourceRecordId,
            description: sourceRecords.description,
          })
          .from(sourceRecords)
          .where(and(eq(sourceRecords.organizationId, orgId), inArray(sourceRecords.id, sourceIds)))
      : [];
  const parentIds = [
    ...new Set(
      sources.flatMap((source) =>
        !source.from?.trim() && source.parentSourceRecordId ? [source.parentSourceRecordId] : [],
      ),
    ),
  ];
  const parents =
    parentIds.length > 0
      ? await db
          .select({
            id: sourceRecords.id,
            from: sql<string | null>`${sourceRecords.rawData} ->> 'from'`,
          })
          .from(sourceRecords)
          .where(and(eq(sourceRecords.organizationId, orgId), inArray(sourceRecords.id, parentIds)))
      : [];
  const parentFrom = new Map(parents.map((parent) => [parent.id, parent.from]));
  const sourceById = new Map(sources.map((source) => [source.id, source]));

  const bySource = new Map<string, ExtractionRow[]>();
  if (sourceIds.length > 0) {
    const rows = await db
      .select({ ...extractionColumns, owner: sourceRecordDocuments.sourceRecordId })
      .from(sourceRecordDocuments)
      .innerJoin(documents, eq(sourceRecordDocuments.documentId, documents.id))
      .where(
        and(
          eq(sourceRecordDocuments.organizationId, orgId),
          eq(documents.organizationId, orgId),
          inArray(sourceRecordDocuments.sourceRecordId, sourceIds),
        ),
      )
      .orderBy(asc(sourceRecordDocuments.createdAt), asc(documents.id));
    for (const { owner, ...row } of rows) pushDocument(bySource, owner, row);
  }
  const byCandidate = new Map<string, ExtractionRow[]>();
  const attached = await db
    .select({ ...extractionColumns, owner: documentAttachments.linkableId })
    .from(documentAttachments)
    .innerJoin(documents, eq(documentAttachments.documentId, documents.id))
    .where(
      and(
        eq(documentAttachments.organizationId, orgId),
        eq(documents.organizationId, orgId),
        eq(documentAttachments.linkableType, "transaction_candidate"),
        inArray(documentAttachments.linkableId, candidateIds),
      ),
    )
    .orderBy(asc(documentAttachments.createdAt), asc(documents.id));
  for (const { owner, ...row } of attached) pushDocument(byCandidate, owner, row);

  for (const subject of subjects) {
    const source = subject.sourceRecordId ? sourceById.get(subject.sourceRecordId) : undefined;
    const rows = [
      ...(subject.sourceRecordId ? (bySource.get(subject.sourceRecordId) ?? []) : []),
      ...(byCandidate.get(subject.id) ?? []),
    ];
    const seen = new Set<string>();
    const documentsForPaper: PaperDocumentFacts[] = [];
    for (const row of rows) {
      if (seen.has(row.documentId)) continue;
      seen.add(row.documentId);
      documentsForPaper.push(paperDocumentFacts(row));
    }
    const ownFrom = source?.from?.trim() ? source.from : null;
    result.set(subject.id, {
      documents: documentsForPaper,
      from:
        ownFrom ??
        (source?.parentSourceRecordId
          ? (parentFrom.get(source.parentSourceRecordId) ?? null)
          : null),
      fallbackDescription: source?.description ?? null,
      partyId: subject.partyId,
    });
  }
  return result;
}

/**
 * Keys for papers a person is looking at now, derived exactly as inbox
 * stage 2 derives them when it looks a paper up (lookupMemoryForDraft in
 * ./store.ts): the same loader and the same derivation, from the paper as it
 * is NOW. A memory saved from these keys is found by the next paper that
 * produces them. The party is the one the paper is settled on now, because
 * "this party" means the one a person chose.
 *
 * Remember used to prefer the keys stage 2 recorded when it classified the
 * paper. Those went stale when extraction changed without a reclassify, and
 * two events in the same millisecond tied on random ids.
 */
export async function resolvePaperKeys(
  db: DbExecutor,
  orgId: string,
  subjects: readonly PaperSubject[],
): Promise<Map<string, PaperKeys>> {
  const live = await loadPaperKeyInputs(db, orgId, subjects);
  const keys = new Map<string, PaperKeys>();
  for (const subject of subjects) {
    const base = derivePaperKeys(
      live.get(subject.id) ?? {
        documents: [],
        from: null,
        fallbackDescription: null,
        partyId: null,
      },
    );
    const party = partyKey(subject.partyId);
    keys.set(subject.id, { ...base, party: party ? [party] : [] });
  }
  return keys;
}
