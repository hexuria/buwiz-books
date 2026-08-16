import { and, eq, inArray, or } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { documentAttachments, documents } from "@/db/schema/documents";
import { journalDuplicateMerges } from "@/db/schema/match-history";

export interface ListEntityAttachmentsInput {
  linkableType: string;
  linkableId: string;
}

/**
 * Return the evidence visible from an entity detail page.
 *
 * A canonical journal represents its complete active duplicate group, so its
 * detail view includes evidence linked to every suppressed journal. The
 * original attachment rows stay in place and the canonical link wins when the
 * same document is linked on both sides. Reading a duplicate journal directly
 * remains an exact, non-aggregated audit view.
 */
export async function listEntityDocumentAttachments(
  db: DbExecutor,
  organizationId: string,
  input: ListEntityAttachmentsInput,
) {
  const activeMergeMemberships =
    input.linkableType === "journal_header"
      ? await db
          .select({
            canonicalHeaderId: journalDuplicateMerges.canonicalHeaderId,
            duplicateHeaderId: journalDuplicateMerges.duplicateHeaderId,
          })
          .from(journalDuplicateMerges)
          .where(
            and(
              eq(journalDuplicateMerges.organizationId, organizationId),
              eq(journalDuplicateMerges.state, "active"),
              or(
                eq(journalDuplicateMerges.canonicalHeaderId, input.linkableId),
                eq(journalDuplicateMerges.duplicateHeaderId, input.linkableId),
              ),
            ),
          )
      : [];
  const requestedJournalIsDuplicate = activeMergeMemberships.some(
    (merge) => merge.duplicateHeaderId === input.linkableId,
  );
  const mergedJournalIds = requestedJournalIsDuplicate
    ? []
    : activeMergeMemberships.filter((merge) => merge.canonicalHeaderId === input.linkableId);

  const linkableIds = [
    input.linkableId,
    ...mergedJournalIds.map((merge) => merge.duplicateHeaderId),
  ];
  const rawAttachments = await db
    .select()
    .from(documentAttachments)
    .where(
      and(
        eq(documentAttachments.organizationId, organizationId),
        eq(documentAttachments.linkableType, input.linkableType),
        linkableIds.length === 1
          ? eq(documentAttachments.linkableId, input.linkableId)
          : inArray(documentAttachments.linkableId, linkableIds),
      ),
    );

  const attachments =
    mergedJournalIds.length === 0
      ? rawAttachments
      : [
          ...rawAttachments.filter((attachment) => attachment.linkableId === input.linkableId),
          ...rawAttachments.filter((attachment) => attachment.linkableId !== input.linkableId),
        ].filter(
          (attachment, index, ordered) =>
            ordered.findIndex((candidate) => candidate.documentId === attachment.documentId) ===
            index,
        );

  const documentIds = [...new Set(attachments.map((attachment) => attachment.documentId))];
  const documentRows =
    documentIds.length > 0
      ? await db
          .select()
          .from(documents)
          .where(
            and(eq(documents.organizationId, organizationId), inArray(documents.id, documentIds)),
          )
      : [];
  const documentsById = new Map(documentRows.map((document) => [document.id, document]));

  return attachments.map((attachment) => ({
    ...attachment,
    inheritedFromMergedJournal: attachment.linkableId !== input.linkableId,
    document: documentsById.get(attachment.documentId),
  }));
}
