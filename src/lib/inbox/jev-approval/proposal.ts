// ============================================================================
// Jev's proposal on one paper, read from the database, and its record.
//
// A PROPOSAL is a draft the system answered: at least one line whose account
// stage 2 picked at or above the org's threshold (prediction evidence source
// `inbox_classification`, outcome `picked`), or a remembered answer (source
// `memory`, build step 10). Everything else — a draft a person typed, one
// stage 2 could not answer — is not Jev's, and no lane learns from it.
//
// recordJevProposal runs where a proposal is produced (after stage 2, from
// the classify job's apply transaction; step 10's memory will call it too).
// It finds or creates the paper's lane at `watch`, evaluates the approval
// predicate as the paper stands, and records both as one workflow event per
// candidate revision (`jev_proposal_recorded`): the snapshot a person's later
// decision is compared with, and the "would approve" log the lane's agreement
// is computed from. Background code: it runs in the caller's withOrgContext
// for the organization that owns the candidate.
// ============================================================================

import { and, desc, eq, inArray, ne, or, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { aiActionProposals } from "@/db/schema/ai";
import {
  inboxItems,
  organizationAccountingSettings,
  reviewFindings,
  sourceMatchCandidates,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidateSources,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { laneWalledKinds } from "@/lib/ai/autonomy";
import { ensureAutonomyLane, type AutonomyLaneRow } from "@/lib/ai/autonomy-lanes";
import { isDateInLockedPeriod } from "@/lib/period-close";
import type { RuleSetProvenance } from "../rule-set";
import { CANDIDATE_CLASSIFIED_ACTION, CLASSIFICATION_EVIDENCE_SOURCE } from "../v2/model-doubt";
import { deriveInboxV2Kind, REMEMBERED_EVIDENCE_SOURCE, type InboxV2Kind } from "../v2/triage";
import {
  evaluateJevApproval,
  PAYMENT_DETAILS_RULE_KEY,
  type JevApprovalDecision,
  type JevApprovalInput,
} from "./predicate";
import type { EmailSenderJudgement } from "../sender-authentication";
import { loadJevSender } from "./sender";
import { loadJevApprovalSettings, type JevApprovalSettings } from "./settings";
import { isSpotCheckSampled } from "./spot-check";

export const JEV_PROPOSAL_RECORDED_ACTION = "jev_proposal_recorded";
export const JEV_LANE_KEY = "inbox_approve" as const;

type CandidateRow = typeof transactionCandidates.$inferSelect;
type ItemRow = typeof inboxItems.$inferSelect;
type LineRow = typeof transactionCandidateLines.$inferSelect;

export type JevAnswerSource = "jev" | "memory";

/** The entry as proposed: what a person's decision is compared with. Original amounts. */
export interface JevEntrySnapshot {
  transactionDate: string;
  currency: string;
  partyId: string | null;
  lines: Array<{ accountId: string | null; debit: string | null; credit: string | null }>;
}

export interface JevPaperFacts {
  candidate: CandidateRow;
  item: ItemRow;
  lines: LineRow[];
  kind: InboxV2Kind;
  /** Who answered the draft, and its weakest confidence; null when nobody did. */
  answer: { source: JevAnswerSource; confidence: number | null } | null;
  newPartyPending: boolean;
  openFindings: Array<{ ruleKey: string; impact: string }>;
  paymentDetailsFlagged: boolean;
  /** An emailed paper's sender (./sender.ts); null for a paper that did not come by email. */
  sender: EmailSenderJudgement | null;
  duplicateCaseOpen: boolean;
  periodLocked: boolean;
  requireDifferentApprover: boolean;
  /** The rules the paper was checked against, from its classification. */
  ruleSet: RuleSetProvenance | null;
}

/** What the proposal event records. */
export interface JevProposalRecord {
  candidateRevision: number;
  laneId: string;
  laneLevel: string;
  source: JevAnswerSource;
  confidence: number | null;
  kind: InboxV2Kind;
  partyId: string | null;
  snapshot: JevEntrySnapshot;
  evaluation: JevEvaluationRecord;
  ruleSet: RuleSetProvenance | null;
}

export interface JevEvaluationRecord extends JevApprovalDecision {
  sampled: boolean;
  laneLevel: string;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function unitConfidence(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

/**
 * Who answered the draft and how sure it was: the weakest of its answers — each
 * category Jev picked, a remembered line (certain unless it says otherwise),
 * and the counterparty when the model rather than an exact match picked it.
 * A Jev answer with no readable confidence makes the whole proposal's null.
 */
export function proposalAnswerOf(
  lines: ReadonlyArray<Pick<LineRow, "accountId" | "predictionEvidence">>,
  partyPick: { modelConfidence: number | null } | null,
): { source: JevAnswerSource; confidence: number | null } | null {
  let jev = 0;
  let memory = 0;
  let confidence: number | null = 1;
  for (const line of lines) {
    const evidence = record(line.predictionEvidence);
    if (!line.accountId || !evidence) continue;
    if (evidence.source === CLASSIFICATION_EVIDENCE_SOURCE && evidence.outcome === "picked") {
      jev += 1;
      const value = unitConfidence(evidence.confidence);
      confidence = value === null || confidence === null ? null : Math.min(confidence, value);
    } else if (evidence.source === REMEMBERED_EVIDENCE_SOURCE) {
      memory += 1;
      const value = unitConfidence(evidence.confidence) ?? 1;
      confidence = confidence === null ? null : Math.min(confidence, value);
    }
  }
  if (jev === 0 && memory === 0) return null;
  if (partyPick && partyPick.modelConfidence !== null && confidence !== null) {
    confidence = Math.min(confidence, partyPick.modelConfidence);
  }
  return { source: jev > 0 ? "jev" : "memory", confidence };
}

export function entrySnapshotOf(
  candidate: Pick<CandidateRow, "transactionDate" | "originalCurrency" | "partyId">,
  lines: ReadonlyArray<Pick<LineRow, "accountId" | "originalDebit" | "originalCredit">>,
): JevEntrySnapshot {
  return {
    transactionDate: candidate.transactionDate,
    currency: candidate.originalCurrency,
    partyId: candidate.partyId,
    lines: lines.map((line) => ({
      accountId: line.accountId,
      debit: line.originalDebit,
      credit: line.originalCredit,
    })),
  };
}

async function loadClassifiedEvent(db: DbExecutor, orgId: string, candidate: CandidateRow) {
  const [event] = await db
    .select({ data: workflowEvents.data })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.organizationId, orgId),
        eq(workflowEvents.entityType, "transaction_candidate"),
        eq(workflowEvents.entityId, candidate.id),
        eq(workflowEvents.action, CANDIDATE_CLASSIFIED_ACTION),
        sql`${workflowEvents.data}->>'candidateRevision' = ${String(candidate.revision)}`,
      ),
    )
    .orderBy(desc(workflowEvents.createdAt), desc(workflowEvents.id))
    .limit(1);
  return event?.data ?? null;
}

/** The accounting source's economic event, the way the Inbox v2 list reads it. */
async function originEconomicEventClass(
  db: DbExecutor,
  orgId: string,
  candidate: CandidateRow,
  item: ItemRow,
): Promise<string | null> {
  const [origin] = await db
    .select({ economicEventClass: sourceRecords.economicEventClass })
    .from(transactionCandidateSources)
    .innerJoin(
      sourceRecords,
      and(
        eq(sourceRecords.id, transactionCandidateSources.sourceRecordId),
        eq(sourceRecords.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(transactionCandidateSources.organizationId, orgId),
        eq(transactionCandidateSources.candidateId, candidate.id),
        ne(sourceRecords.recordType, "email"),
      ),
    )
    .orderBy(
      sql`(${transactionCandidateSources.relationship} = 'origin' and ${transactionCandidateSources.isPrimary}) desc`,
      sql`(${transactionCandidateSources.relationship} = 'origin') desc`,
    )
    .limit(1);
  if (origin) return origin.economicEventClass;
  if (!item.sourceRecordId) return null;
  const [itemSource] = await db
    .select({ economicEventClass: sourceRecords.economicEventClass })
    .from(sourceRecords)
    .where(and(eq(sourceRecords.organizationId, orgId), eq(sourceRecords.id, item.sourceRecordId)))
    .limit(1);
  return itemSource?.economicEventClass ?? null;
}

async function candidateSourceIds(
  db: DbExecutor,
  orgId: string,
  candidate: CandidateRow,
  item: ItemRow,
): Promise<string[]> {
  const linked = await db
    .select({ sourceRecordId: transactionCandidateSources.sourceRecordId })
    .from(transactionCandidateSources)
    .where(
      and(
        eq(transactionCandidateSources.organizationId, orgId),
        eq(transactionCandidateSources.candidateId, candidate.id),
      ),
    );
  return [
    ...new Set(
      [
        candidate.sourceRecordId,
        item.sourceRecordId,
        ...linked.map((row) => row.sourceRecordId),
      ].filter((id): id is string => Boolean(id)),
    ),
  ];
}

/** Everything the predicate needs about one paper, read in the caller's transaction. */
export async function loadJevPaperFacts(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
): Promise<JevPaperFacts | null> {
  const [row] = await db
    .select({ candidate: transactionCandidates, item: inboxItems })
    .from(transactionCandidates)
    .innerJoin(
      inboxItems,
      and(
        eq(inboxItems.candidateId, transactionCandidates.id),
        eq(inboxItems.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.id, candidateId),
      ),
    )
    .limit(1);
  if (!row) return null;
  const { candidate, item } = row;

  const lines = await db
    .select()
    .from(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        eq(transactionCandidateLines.candidateId, candidate.id),
      ),
    )
    .orderBy(transactionCandidateLines.sortOrder, transactionCandidateLines.id);

  const classified = record(await loadClassifiedEvent(db, orgId, candidate));
  const party = record(classified?.party);
  const modelPickedParty =
    party?.outcome === "model" &&
    candidate.partyId !== null &&
    party.linkedPartyId === candidate.partyId;
  const answer = proposalAnswerOf(
    lines,
    modelPickedParty ? { modelConfidence: unitConfidence(party?.confidence) } : null,
  );

  const kind = deriveInboxV2Kind({
    candidateType: candidate.candidateType,
    originEconomicEventClass: await originEconomicEventClass(db, orgId, candidate, item),
    transactionType: candidate.transactionType,
  });

  const [pendingParty] = await db
    .select({ id: aiActionProposals.id })
    .from(aiActionProposals)
    .where(
      and(
        eq(aiActionProposals.organizationId, orgId),
        eq(aiActionProposals.kind, "create_party"),
        eq(aiActionProposals.status, "pending"),
        sql`${aiActionProposals.sourceRef} @> ${JSON.stringify({
          entityType: "transaction_candidate",
          entityId: candidate.id,
        })}::jsonb`,
      ),
    )
    .limit(1);

  const openFindings = await db
    .select({ ruleKey: reviewFindings.ruleKey, impact: reviewFindings.impact })
    .from(reviewFindings)
    .where(
      and(
        eq(reviewFindings.organizationId, orgId),
        eq(reviewFindings.inboxItemId, item.id),
        eq(reviewFindings.state, "open"),
      ),
    );
  // Open or resolved: a bank-detail change always needs a person (spec §5).
  const [paymentDetails] = await db
    .select({ id: reviewFindings.id })
    .from(reviewFindings)
    .where(
      and(
        eq(reviewFindings.organizationId, orgId),
        eq(reviewFindings.ruleKey, PAYMENT_DETAILS_RULE_KEY),
        or(eq(reviewFindings.inboxItemId, item.id), eq(reviewFindings.candidateId, candidate.id)),
      ),
    )
    .limit(1);

  const sourceIds = await candidateSourceIds(db, orgId, candidate, item);
  const [duplicate] =
    sourceIds.length > 0
      ? await db
          .select({ id: sourceMatchCandidates.id })
          .from(sourceMatchCandidates)
          .where(
            and(
              eq(sourceMatchCandidates.organizationId, orgId),
              eq(sourceMatchCandidates.state, "open"),
              eq(sourceMatchCandidates.matchClass, "duplicate"),
              or(
                inArray(sourceMatchCandidates.leftSourceRecordId, sourceIds),
                inArray(sourceMatchCandidates.rightSourceRecordId, sourceIds),
              ),
            ),
          )
          .limit(1)
      : [];

  const sender = await loadJevSender(db, orgId, { candidate, sourceIds });
  const period = await isDateInLockedPeriod(orgId, candidate.transactionDate, db);
  const [accounting] = await db
    .select({ requireDifferentApprover: organizationAccountingSettings.requireDifferentApprover })
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);

  const ruleSet = record(classified?.ruleSet);
  return {
    candidate,
    item,
    lines,
    kind,
    answer,
    newPartyPending: Boolean(pendingParty),
    openFindings,
    paymentDetailsFlagged: Boolean(paymentDetails),
    sender,
    duplicateCaseOpen: Boolean(duplicate),
    periodLocked: period.locked,
    // The column defaults to true: an org with no settings row requires it.
    requireDifferentApprover: accounting?.requireDifferentApprover ?? true,
    ruleSet: ruleSet
      ? {
          source: ruleSet.source === "snapshot" ? "snapshot" : "live",
          snapshotId: typeof ruleSet.snapshotId === "string" ? ruleSet.snapshotId : null,
          routineId: typeof ruleSet.routineId === "string" ? ruleSet.routineId : null,
        }
      : null,
  };
}

/** The predicate's input for a paper on its lane. */
export function jevApprovalInputOf(
  facts: JevPaperFacts,
  lane: Pick<AutonomyLaneRow, "level" | "amountCap" | "confidenceThreshold" | "partyId"> | null,
  settings: JevApprovalSettings,
): JevApprovalInput {
  return {
    lane: lane
      ? {
          level: lane.level,
          amountCap: lane.amountCap,
          confidenceThreshold: lane.confidenceThreshold,
          partyId: lane.partyId,
        }
      : null,
    org: {
      autoApproveEnabled: settings.autoApproveEnabled,
      aiKillSwitch: settings.aiKillSwitch,
      requireDifferentApprover: facts.requireDifferentApprover,
      makerCheckerOptIn: settings.makerCheckerOptIn,
    },
    walledKinds: laneWalledKinds(JEV_LANE_KEY),
    paper: {
      itemState: facts.item.state,
      candidateStatus: facts.candidate.status,
      confidence: facts.answer?.confidence ?? null,
      partyId: facts.candidate.partyId,
      newPartyPending: facts.newPartyPending,
      openFindings: facts.openFindings,
      paymentDetailsFlagged: facts.paymentDetailsFlagged,
      sender: facts.sender
        ? { verified: facts.sender.verified, detail: facts.sender.detail }
        : null,
      duplicateCaseOpen: facts.duplicateCaseOpen,
      periodLocked: facts.periodLocked,
      functionalTotal: facts.candidate.functionalTotal,
      lines: facts.lines.map((line) => ({
        accountId: line.accountId,
        debit: line.functionalDebit,
        credit: line.functionalCredit,
      })),
    },
    sampled: isSpotCheckSampled({
      candidateId: facts.candidate.id,
      salt: settings.spotCheckSalt,
      rate: settings.spotCheckRate,
    }),
  };
}

export function evaluationRecordOf(
  input: JevApprovalInput,
  decision: JevApprovalDecision,
): JevEvaluationRecord {
  return { ...decision, sampled: input.sampled, laneLevel: input.lane?.level ?? "none" };
}

/**
 * Record the proposal on the candidate's current revision, once. Returns null
 * when the draft carries no system answer (nothing to learn from).
 */
export async function recordJevProposal(
  db: DbExecutor,
  input: { orgId: string; candidateId: string },
): Promise<(JevProposalRecord & { eventId: string | null }) | null> {
  const facts = await loadJevPaperFacts(db, input.orgId, input.candidateId);
  if (!facts?.answer) return null;
  const lane = await ensureAutonomyLane(db, input.orgId, {
    laneKey: JEV_LANE_KEY,
    partyId: facts.candidate.partyId,
    docKind: facts.kind,
  });
  const settings = await loadJevApprovalSettings(db, input.orgId);
  const approvalInput = jevApprovalInputOf(facts, lane, settings);
  const evaluation = evaluationRecordOf(approvalInput, evaluateJevApproval(approvalInput));
  const proposal: JevProposalRecord = {
    candidateRevision: facts.candidate.revision,
    laneId: lane.id,
    laneLevel: lane.level,
    source: facts.answer.source,
    confidence: facts.answer.confidence,
    kind: facts.kind,
    partyId: facts.candidate.partyId,
    snapshot: entrySnapshotOf(facts.candidate, facts.lines),
    evaluation,
    ruleSet: facts.ruleSet,
  };
  const [event] = await db
    .insert(workflowEvents)
    .values({
      organizationId: input.orgId,
      inboxItemId: facts.item.id,
      entityType: "transaction_candidate",
      entityId: facts.candidate.id,
      action: JEV_PROPOSAL_RECORDED_ACTION,
      actorType: "system",
      idempotencyKey: `jev-proposal:${facts.candidate.id}:${facts.candidate.revision}`,
      data: { ...proposal },
    })
    .onConflictDoNothing()
    .returning({ id: workflowEvents.id });
  return { ...proposal, eventId: event?.id ?? null };
}

/** The latest recorded proposal for a candidate, whatever revision it is on now. */
export async function latestJevProposal(
  db: DbExecutor,
  orgId: string,
  candidateId: string,
): Promise<JevProposalRecord | null> {
  const [event] = await db
    .select({ data: workflowEvents.data })
    .from(workflowEvents)
    .where(
      and(
        eq(workflowEvents.organizationId, orgId),
        eq(workflowEvents.entityType, "transaction_candidate"),
        eq(workflowEvents.entityId, candidateId),
        eq(workflowEvents.action, JEV_PROPOSAL_RECORDED_ACTION),
      ),
    )
    .orderBy(
      sql`(${workflowEvents.data}->>'candidateRevision')::int desc`,
      desc(workflowEvents.createdAt),
    )
    .limit(1);
  if (!event) return null;
  const data = event.data as unknown as JevProposalRecord;
  return typeof data?.laneId === "string" && typeof data?.candidateRevision === "number"
    ? data
    : null;
}
