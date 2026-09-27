/**
 * The Inbox v2 list: everything that needs a human, and why (spec §10).
 *
 * Open states plus `failed`, never approved / rejected / dismissed — there is no Done folder. The
 * sidebar badge is this list's length, so both read the same query.
 */
import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { inboxItems, sourceRecords, transactionCandidates } from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { loadDuplicateEngineConfig } from "../duplicate-engine";
import { DUPLICATE_MATCHER_VERSION } from "../duplicate-matcher";
import { INBOX_OPEN_STATES } from "../types";
import {
  deriveInboxV2Kind,
  deriveInboxV2Reason,
  deriveInboxV2SourceBadge,
  describeInboxV2Reason,
  REMEMBERED_EVIDENCE_SOURCE,
  type InboxV2Kind,
  type InboxV2OpenFinding,
  type InboxV2Reason,
  type InboxV2ReasonDetail,
  type InboxV2SourceBadge,
  type ModelUnsureSignal,
} from "./triage";

export const INBOX_V2_LISTED_STATES = [...INBOX_OPEN_STATES, "failed"] as const;

/** Same ceiling as the classic list. Past it the badge reads "250+". */
export const INBOX_V2_LIST_LIMIT = 250;

export interface InboxV2ListItem {
  id: string;
  title: string;
  state: string;
  createdAt: Date;
  candidateRevision: number;
  lockVersion: number;
  /** The counterparty when one is set, otherwise the item's title. */
  who: string;
  kind: InboxV2Kind;
  transactionDate: string;
  originalTotal: string | null;
  originalCurrency: string;
  reason: InboxV2Reason;
  reasonDetail: InboxV2ReasonDetail;
  reasonText: string;
  sourceBadge: InboxV2SourceBadge;
}

export interface InboxV2List {
  items: InboxV2ListItem[];
  /** More items need a human than the list returned. */
  truncated: boolean;
}

/**
 * STEP 7 HOOK. The category and entity checks will record when the model is unsure; read them
 * here. Until they exist nothing produces a signal, and "Jev unsure" comes from the
 * low_confidence_category finding (or the not-yet-autonomous fallback) alone.
 */
function modelUnsureSignalsFor(_itemId: string): ModelUnsureSignal[] {
  return [];
}

/** STEP 11 HOOK. Autonomy lanes will hold back a sample of would-be approvals as spot checks. */
function isSpotCheckSample(_itemId: string): boolean {
  return false;
}

function openFindingsFrom(raw: unknown): InboxV2OpenFinding[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const { ruleKey, blocking, message } = entry as Record<string, unknown>;
    if (typeof ruleKey !== "string") return [];
    return [
      {
        ruleKey,
        blocking: blocking === true,
        message: typeof message === "string" ? message : null,
      },
    ];
  });
}

export async function listInboxV2Items(
  db: DbExecutor,
  orgId: string,
  options: { limit?: number } = {},
): Promise<InboxV2List> {
  const limit = Math.min(Math.max(options.limit ?? INBOX_V2_LIST_LIMIT, 1), INBOX_V2_LIST_LIMIT);

  // A possible_duplicate finding blocks only while the duplicate engine enforces it (or an exact
  // match is still open) — the same test the classic list's blockingFindingCount applies.
  const duplicateConfig = await loadDuplicateEngineConfig(db, orgId);
  const duplicatesBlockNow =
    duplicateConfig.enabled &&
    duplicateConfig.mode === "enforce" &&
    duplicateConfig.impact === "blocking";
  const exactDuplicatesBlockNow = duplicateConfig.enabled && duplicateConfig.mode !== "off";
  const duplicateAlgorithmVersion = duplicateConfig.algorithmVersion ?? DUPLICATE_MATCHER_VERSION;

  const rows = await db
    .select({
      id: inboxItems.id,
      title: inboxItems.title,
      state: inboxItems.state,
      createdAt: inboxItems.createdAt,
      candidateRevision: inboxItems.candidateRevision,
      lockVersion: inboxItems.lockVersion,
      candidateType: transactionCandidates.candidateType,
      transactionType: transactionCandidates.transactionType,
      transactionDate: transactionCandidates.transactionDate,
      originalTotal: transactionCandidates.originalTotal,
      originalCurrency: transactionCandidates.originalCurrency,
      partyName: parties.name,
      itemSourceEconomicEventClass: sourceRecords.economicEventClass,
      // The accounting source the reading pane edits: primary origin first, then any origin,
      // then any non-email source (getInboxItem's editableEconomicSource, in SQL).
      originEconomicEventClass: sql<string | null>`(
        select sr.economic_event_class
        from transaction_candidate_sources tcs
        join source_records sr
          on sr.id = tcs.source_record_id and sr.organization_id = tcs.organization_id
        where tcs.organization_id = ${transactionCandidates.organizationId}
          and tcs.candidate_id = ${transactionCandidates.id}
          and sr.record_type <> 'email'
        order by (tcs.relationship = 'origin' and tcs.is_primary) desc,
                 (tcs.relationship = 'origin') desc
        limit 1
      )`,
      openFindings: sql<unknown>`coalesce((
        select json_agg(
          json_build_object(
            'ruleKey', rf.rule_key,
            'message', rf.message,
            'blocking', (
              rf.impact = 'blocking'
              and (
                rf.rule_key <> 'possible_duplicate'
                or ${duplicatesBlockNow}
                or (
                  ${exactDuplicatesBlockNow}
                  and exists (
                    select 1
                    from source_match_candidates smc
                    where smc.organization_id = ${inboxItems.organizationId}
                      and smc.id::text = rf.evidence->>'caseId'
                      and smc.state = 'open'
                      and smc.match_type = 'exact'
                      and smc.match_class = 'duplicate'
                      and smc.disposition = 'blocking'
                      and smc.algorithm_version = ${duplicateAlgorithmVersion}
                  )
                )
              )
            )
          )
          order by rf.first_seen_at, rf.id
        )
        from review_findings rf
        where rf.organization_id = ${inboxItems.organizationId}
          and rf.inbox_item_id = ${inboxItems.id}
          and rf.state = 'open'
      ), '[]'::json)`,
      minCategoryConfidence: sql<string | null>`(
        select min(l.category_confidence)::text
        from transaction_candidate_lines l
        where l.organization_id = ${transactionCandidates.organizationId}
          and l.candidate_id = ${transactionCandidates.id}
      )`,
      remembered: sql<boolean>`exists (
        select 1
        from transaction_candidate_lines l
        where l.organization_id = ${transactionCandidates.organizationId}
          and l.candidate_id = ${transactionCandidates.id}
          and l.prediction_evidence->>'source' = ${REMEMBERED_EVIDENCE_SOURCE}
      )`,
    })
    .from(inboxItems)
    .innerJoin(
      transactionCandidates,
      and(
        eq(inboxItems.candidateId, transactionCandidates.id),
        eq(transactionCandidates.organizationId, orgId),
      ),
    )
    .leftJoin(
      sourceRecords,
      and(eq(inboxItems.sourceRecordId, sourceRecords.id), eq(sourceRecords.organizationId, orgId)),
    )
    .leftJoin(
      parties,
      and(eq(transactionCandidates.partyId, parties.id), eq(parties.organizationId, orgId)),
    )
    .where(
      and(
        eq(inboxItems.organizationId, orgId),
        inArray(inboxItems.state, [...INBOX_V2_LISTED_STATES]),
      ),
    )
    .orderBy(desc(inboxItems.createdAt), desc(inboxItems.id))
    .limit(limit + 1);

  const items = rows.slice(0, limit).map((row): InboxV2ListItem => {
    const reason = deriveInboxV2Reason({
      state: row.state,
      openFindings: openFindingsFrom(row.openFindings),
      modelUnsureSignals: modelUnsureSignalsFor(row.id),
      spotCheck: isSpotCheckSample(row.id),
    });
    return {
      id: row.id,
      title: row.title,
      state: row.state,
      createdAt: row.createdAt,
      candidateRevision: row.candidateRevision,
      lockVersion: row.lockVersion,
      who: row.partyName?.trim() || row.title,
      kind: deriveInboxV2Kind({
        candidateType: row.candidateType,
        originEconomicEventClass:
          row.originEconomicEventClass ?? row.itemSourceEconomicEventClass ?? null,
        transactionType: row.transactionType,
      }),
      transactionDate: row.transactionDate,
      originalTotal: row.originalTotal,
      originalCurrency: row.originalCurrency,
      reason: reason.reason,
      reasonDetail: reason.detail,
      reasonText: describeInboxV2Reason(reason),
      sourceBadge: deriveInboxV2SourceBadge({
        remembered: row.remembered === true,
        minCategoryConfidence: row.minCategoryConfidence,
      }),
    };
  });

  return { items, truncated: rows.length > limit };
}
