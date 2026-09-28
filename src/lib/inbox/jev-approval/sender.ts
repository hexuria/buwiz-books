// ============================================================================
// Who sent an emailed paper, for the Jev approval predicate (./predicate.ts).
//
// A paper is EMAILED when inbound email is anywhere in its lineage: the
// candidate came out of the email pipeline (`email_transaction`), or a source
// it is built from is an inbound message, a part of one (attachment, body), or
// arrived on an email channel. Its MESSAGES are the inbound email source
// records — a source itself, or the email the source was split from.
//
// Every message must carry the verdict the email job recorded at ingest
// (../sender-authentication.ts) and have passed, and its From must be one the
// paper's party already uses: the party's stored email, or the From of one of
// that party's papers a PERSON approved (Jev's own approvals vouch for
// nothing). An emailed paper with no message on record — or no verdict — is
// not verified. Any other paper (an upload, a bank line, an HMAC-signed
// webhook routine) has no sender to check, and gets null.
//
// Reads run on the caller's org-context executor and filter the organization
// explicitly, so RLS scopes them a second time.
// ============================================================================

import { and, eq, inArray, isNotNull, ne, or, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import type { DbExecutor } from "@/db";
import {
  inboxItems,
  integrationSources,
  sourceRecords,
  transactionCandidateSources,
  transactionCandidates,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import {
  judgeEmailSenders,
  readSenderAuthentication,
  senderAddressesIn,
  senderAddressOf,
  type EmailSenderJudgement,
  type SenderAddress,
} from "../sender-authentication";

/** The record type the Resend webhook gives an inbound message. */
export const EMAIL_MESSAGE_RECORD_TYPE = "email";
const EMAIL_RECORD_TYPES: ReadonlySet<string> = new Set([
  EMAIL_MESSAGE_RECORD_TYPE,
  "email_attachment",
  "email_body",
  "email_transaction",
]);
const EMAIL_CANDIDATE_TYPE = "email_transaction";
const EMAIL_CHANNEL = "email";

/** How many of the party's approved emailed papers are read for its senders. */
const KNOWN_SENDER_SAMPLE = 500;

type SourceFact = {
  id: string;
  recordType: string;
  parentSourceRecordId: string | null;
  channel: string | null;
  senderAuthentication: unknown;
};

function sourceFacts(db: DbExecutor, orgId: string, ids: readonly string[]) {
  return db
    .select({
      id: sourceRecords.id,
      recordType: sourceRecords.recordType,
      parentSourceRecordId: sourceRecords.parentSourceRecordId,
      channel: integrationSources.channel,
      // Only the verdict: an email's raw data also holds its whole body.
      senderAuthentication: sql<unknown>`${sourceRecords.rawData} -> 'senderAuthentication'`,
    })
    .from(sourceRecords)
    .leftJoin(
      integrationSources,
      and(
        eq(integrationSources.id, sourceRecords.sourceId),
        eq(integrationSources.organizationId, orgId),
      ),
    )
    .where(and(eq(sourceRecords.organizationId, orgId), inArray(sourceRecords.id, [...ids])));
}

/**
 * Senders the party already uses: its stored email, and the From of each of its
 * papers a person approved that came in by email.
 */
async function knownSenders(
  db: DbExecutor,
  orgId: string,
  input: { partyId: string; candidateId: string },
): Promise<SenderAddress[]> {
  const [party] = await db
    .select({ email: parties.email })
    .from(parties)
    .where(and(eq(parties.organizationId, orgId), eq(parties.id, input.partyId)))
    .limit(1);
  const message = alias(sourceRecords, "message");
  const approved = await db
    .selectDistinct({
      verified: sql<string | null>`${message.rawData} -> 'senderAuthentication' ->> 'fromAddress'`,
      from: sql<string | null>`${message.rawData} ->> 'from'`,
    })
    .from(transactionCandidates)
    .innerJoin(
      inboxItems,
      and(
        eq(inboxItems.organizationId, orgId),
        eq(inboxItems.candidateId, transactionCandidates.id),
      ),
    )
    .innerJoin(
      transactionCandidateSources,
      and(
        eq(transactionCandidateSources.organizationId, orgId),
        eq(transactionCandidateSources.candidateId, transactionCandidates.id),
      ),
    )
    .innerJoin(
      sourceRecords,
      and(
        eq(sourceRecords.organizationId, orgId),
        eq(sourceRecords.id, transactionCandidateSources.sourceRecordId),
      ),
    )
    .innerJoin(
      message,
      and(
        eq(message.organizationId, orgId),
        eq(message.recordType, EMAIL_MESSAGE_RECORD_TYPE),
        or(eq(message.id, sourceRecords.id), eq(message.id, sourceRecords.parentSourceRecordId)),
      ),
    )
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.partyId, input.partyId),
        ne(transactionCandidates.id, input.candidateId),
        eq(inboxItems.state, "approved"),
        // A person's approval; Jev's leaves resolved_by empty.
        isNotNull(inboxItems.resolvedBy),
      ),
    )
    .limit(KNOWN_SENDER_SAMPLE);
  return [
    ...senderAddressesIn(party?.email),
    ...approved.flatMap((row) => {
      const sender = senderAddressOf(row.verified ?? row.from);
      return sender ? [sender] : [];
    }),
  ];
}

/** Null when the paper did not come in by email; otherwise whether its sender is verified. */
export async function loadJevSender(
  db: DbExecutor,
  orgId: string,
  input: {
    candidate: { id: string; candidateType: string; partyId: string | null };
    sourceIds: readonly string[];
  },
): Promise<EmailSenderJudgement | null> {
  const linked: SourceFact[] =
    input.sourceIds.length > 0 ? await sourceFacts(db, orgId, input.sourceIds) : [];
  const seen = new Set(linked.map((source) => source.id));
  const parentIds = [
    ...new Set(
      linked.flatMap((source) =>
        source.parentSourceRecordId && !seen.has(source.parentSourceRecordId)
          ? [source.parentSourceRecordId]
          : [],
      ),
    ),
  ];
  const sources = [
    ...linked,
    ...(parentIds.length > 0 ? await sourceFacts(db, orgId, parentIds) : []),
  ];
  const emailed =
    input.candidate.candidateType === EMAIL_CANDIDATE_TYPE ||
    sources.some(
      (source) => EMAIL_RECORD_TYPES.has(source.recordType) || source.channel === EMAIL_CHANNEL,
    );
  if (!emailed) return null;

  const verdicts = sources
    .filter((source) => source.recordType === EMAIL_MESSAGE_RECORD_TYPE)
    .map((source) => source.senderAuthentication);
  const partyId = input.candidate.partyId;
  // The party's senders are read only when a verdict could still pass on them.
  const known =
    partyId === null
      ? null
      : verdicts.some((stored) => readSenderAuthentication(stored)?.passed)
        ? await knownSenders(db, orgId, { partyId, candidateId: input.candidate.id })
        : [];
  return judgeEmailSenders({ verdicts, known });
}
