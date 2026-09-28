// ============================================================================
// Inbox stage 2 — classify one enriched candidate (inbox v2 §4 and §5).
//
// Stage 1 (ingest_triage, the extraction's economic event) already decided
// what kind of paper this is. This pass fills the draft the extraction left
// with two unselected placeholder lines:
//
//   • the CATEGORY line (the debit of a purchase/bill/payroll, the credit of
//     a sale/invoice) gets an account from categorize_lines — a closed enum of
//     the org's own leaf accounts, Jev first for opted-in orgs. No fit, low
//     confidence, or any model failure resolves it to the mapped uncategorized
//     account, so the blocking `uncategorized` rule fires;
//   • the counterparty is matched: tax id, sender/printed email, vendor alias,
//     exact name, then pg_trgm look-alikes judged by match_party. "new"
//     drafts a create_party proposal — creating a party stays human;
//   • a document whose payee bank details differ from the matched party's
//     stored ones raises the blocking `party_payment_details_changed` finding.
//
// The payment side (which bank, card, cash, AP, or AR account) stays
// unselected: nothing on a receipt proves it, so a reviewer picks it, and the
// `uncategorized` rule keeps blocking until they do.
//
// Three phases, so no transaction is held across a model call: read (one
// org-context transaction), models (none), apply (one transaction that
// re-locks the lifecycle, re-validates the revision and the placeholders, and
// then writes). Background code: the org comes from the job row, and every
// phase runs in withOrgContext for that org.
// ============================================================================

import { and, eq, inArray } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "@/db";
import { accounts } from "@/db/schema/accounts";
import {
  inboxItems,
  organizationAccountingSettings,
  reviewFindings,
  sourceRecords,
  transactionCandidateLines,
  transactionCandidates,
  workflowEvents,
} from "@/db/schema/inbox";
import { parties } from "@/db/schema/parties";
import { aiComplete } from "@/lib/ai/facade";
import type { CategorizeLinesPromptInput } from "@/lib/ai/prompts/categorize-lines";
import { createProposal, listProposals } from "@/lib/ai/proposals";
import {
  buildCategorizeLinesSchema,
  NO_FIT_CODE,
  type CategorizeLinesOutput,
} from "@/lib/ai/schemas/categorize-lines";
import { pickPartyWithModel, type AiCompleteFn } from "@/lib/party-match/model-pick";
import { extractEmailAddress } from "@/lib/party-match/normalize";
import {
  decidePartyMatch,
  findPartyCandidates,
  type PartyCandidateSearch,
  type PartyMatchOutcome,
  type PartyMatchQuery,
  type PartyPickResult,
} from "@/lib/party-match/pipeline";
import { partyLookups } from "@/lib/party-match/queries";
import { CANDIDATE_CLASSIFICATION_VERSION } from "./candidate-classification-job";
import {
  collectDocumentFacts,
  loadCandidateDocuments,
  record,
  text,
  type DocumentFacts,
} from "./candidate-document-facts";
import {
  PAYEE_ROLES,
  isPlaceholderLine,
  planCandidateClassification,
  type ClassificationPlan,
} from "./classification-plan";
import { lockInboxCandidateLifecycle } from "./lifecycle-lock";
import {
  CATEGORY_ACCOUNT_TYPES,
  buildAccountCodeList,
  failedDecisions,
  mapCategorizeLinesOutput,
  resolveCategoryLine,
  resolveNoFitAccount,
  type AccountCodeList,
  type ChartAccount,
  type LineCategoryDecision,
} from "./line-categorization";
import {
  DEFAULT_LOW_CONFIDENCE_THRESHOLD,
  lowConfidenceThresholdOf,
} from "./low-confidence-threshold";
import { raisePaymentDetailsFindingIfChanged } from "./payment-details-check";
import {
  evaluateCandidateRules,
  withRuleSetProvenance,
  type CandidateRuleInput,
  type RuleSetProvenance,
} from "./rule-set";
import {
  loadRuleFallbacks,
  recordShadowRuleEvaluation,
  resolveCandidateRuleSets,
} from "./rule-snapshots";
import { BOOK_RULE_KEYS, type BookRuleAccount } from "./rules";
import { INBOX_OPEN_STATES, type CandidateLineInput } from "./types";

const DEFAULT_MISSING_RECEIPT_THRESHOLD = "75";
const DEFAULT_MISSING_RECEIPT_CURRENCY = "USD";

type CandidateRow = typeof transactionCandidates.$inferSelect;
type LineRow = typeof transactionCandidateLines.$inferSelect;

// ── Phase 1: read ───────────────────────────────────────────────────────────

interface ClassificationContext {
  orgId: string;
  candidate: CandidateRow;
  inboxItemId: string;
  lines: LineRow[];
  facts: DocumentFacts;
  plan: ClassificationPlan;
  codes: AccountCodeList | null;
  minConfidence: number;
  partySearch: PartyCandidateSearch | null;
  currency: string;
}

export type ClassifySkipReason =
  | "not_found"
  | "not_current"
  | "stale_revision"
  | "inbox_item_closed"
  | "lines_not_placeholders";

type LoadResult =
  | { kind: "skip"; reason: ClassifySkipReason }
  | { kind: "ready"; context: ClassificationContext };

async function loadChart(db: DbExecutor, orgId: string): Promise<ChartAccount[]> {
  return db
    .select({
      id: accounts.id,
      accountNumber: accounts.accountNumber,
      name: accounts.name,
      accountType: accounts.accountType,
      subtype: accounts.subtype,
      parentId: accounts.parentId,
      isActive: accounts.isActive,
    })
    .from(accounts)
    .where(eq(accounts.organizationId, orgId));
}

async function loadSender(
  db: DbExecutor,
  orgId: string,
  source: { rawData: unknown; parentSourceRecordId: string | null } | null,
): Promise<string | null> {
  const own = text(record(source?.rawData)?.from);
  if (own || !source?.parentSourceRecordId) return own;
  const [parent] = await db
    .select({ rawData: sourceRecords.rawData })
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.organizationId, orgId),
        eq(sourceRecords.id, source.parentSourceRecordId),
      ),
    )
    .limit(1);
  return text(record(parent?.rawData)?.from);
}

async function loadCandidateLines(db: DbExecutor, orgId: string, candidateId: string) {
  return db
    .select()
    .from(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        eq(transactionCandidateLines.candidateId, candidateId),
      ),
    )
    .orderBy(transactionCandidateLines.sortOrder);
}

function placeholdersIntact(lines: readonly LineRow[]): boolean {
  return lines.length === 2 && lines.every(isPlaceholderLine);
}

async function loadClassificationContext(
  db: DbExecutor,
  input: { orgId: string; candidateId: string; candidateRevision: number },
): Promise<LoadResult> {
  const { orgId } = input;
  const [row] = await db
    .select({ candidate: transactionCandidates, item: inboxItems })
    .from(transactionCandidates)
    .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.id, input.candidateId),
      ),
    )
    .limit(1);
  if (!row) return { kind: "skip", reason: "not_found" };
  if (row.candidate.status !== "current") return { kind: "skip", reason: "not_current" };
  if (row.candidate.revision !== input.candidateRevision) {
    return { kind: "skip", reason: "stale_revision" };
  }
  if (!(INBOX_OPEN_STATES as readonly string[]).includes(row.item.state)) {
    return { kind: "skip", reason: "inbox_item_closed" };
  }
  const lines = await loadCandidateLines(db, orgId, row.candidate.id);
  if (!placeholdersIntact(lines)) return { kind: "skip", reason: "lines_not_placeholders" };

  const [source] = row.candidate.sourceRecordId
    ? await db
        .select({
          economicEventClass: sourceRecords.economicEventClass,
          rawData: sourceRecords.rawData,
          parentSourceRecordId: sourceRecords.parentSourceRecordId,
        })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, orgId),
            eq(sourceRecords.id, row.candidate.sourceRecordId),
          ),
        )
        .limit(1)
    : [];
  const documentRows = await loadCandidateDocuments(
    db,
    orgId,
    row.candidate.id,
    row.candidate.sourceRecordId,
  );
  const facts = collectDocumentFacts(documentRows, {
    from: await loadSender(db, orgId, source ?? null),
  });
  const plan = planCandidateClassification({
    candidate: row.candidate,
    lines,
    economicEventClass: source?.economicEventClass ?? null,
    facts,
  });
  const codes =
    plan.direction && plan.categoryLines.length > 0
      ? buildAccountCodeList(await loadChart(db, orgId), CATEGORY_ACCOUNT_TYPES[plan.direction])
      : null;
  // The threshold a model pick must reach is the low-confidence rule's own, so
  // it comes from the rules this paper is evaluated against: the snapshot its
  // routine pins, or the live configs.
  const ruleSets = await resolveCandidateRuleSets(
    db,
    orgId,
    row.candidate.id,
    await loadRuleFallbacks(db, orgId),
  );
  const minConfidence = lowConfidenceThresholdOf(ruleSets.active);
  const partySearch =
    plan.partyQuery && row.candidate.partyId === null
      ? await findPartyCandidates(plan.partyQuery, partyLookups(db, orgId))
      : null;

  return {
    kind: "ready",
    context: {
      orgId,
      candidate: row.candidate,
      inboxItemId: row.item.id,
      lines,
      facts,
      plan,
      codes,
      minConfidence,
      partySearch,
      currency: row.candidate.originalCurrency,
    },
  };
}

// ── Phase 2: models (no transaction) ────────────────────────────────────────

interface ModelResults {
  decisions: LineCategoryDecision[];
  categorizeInvocationId: string | null;
  pick: PartyPickResult | null;
}

async function categorizeLines(
  context: ClassificationContext,
  complete: AiCompleteFn,
): Promise<{ decisions: LineCategoryDecision[]; invocationId: string | null }> {
  const { plan, codes } = context;
  if (plan.categoryLines.length === 0) return { decisions: [], invocationId: null };
  if (!codes || codes.entries.length === 0) {
    return {
      decisions: failedDecisions(plan.categoryLines, "no_eligible_accounts"),
      invocationId: null,
    };
  }
  const allowedTypes = [...CATEGORY_ACCOUNT_TYPES[plan.direction!]];
  const input: CategorizeLinesPromptInput = {
    document: {
      kind: context.facts.kind ?? "unknown",
      event: plan.event,
      counterparty: context.facts.partyName ?? "",
      description: context.candidate.memo ?? "",
      currency: context.currency,
    },
    lines: plan.categoryLines.map((line) => ({
      lineIndex: line.lineIndex,
      side: line.side,
      description: line.description,
      amount: line.amount,
      allowedTypes,
    })),
    lineItems: context.facts.lineItems,
    accounts: codes.entries.map(({ code, name, type, group }) => ({ code, name, type, group })),
  };
  const codeList = codes.entries.map((entry) => entry.code);
  try {
    const result = await complete<CategorizeLinesOutput>({
      task: "categorize_lines",
      input,
      schema: buildCategorizeLinesSchema(codeList),
      allowedIds: { accountCodes: new Set([...codeList, NO_FIT_CODE]) },
      ctx: { orgId: context.orgId },
    });
    if (!result.ok) {
      return {
        decisions: failedDecisions(plan.categoryLines, "needs_review"),
        invocationId: result.invocationId,
      };
    }
    return {
      decisions: mapCategorizeLinesOutput(result.data, {
        lines: plan.categoryLines,
        codes,
        minConfidence: context.minConfidence,
      }),
      invocationId: result.invocationId,
    };
  } catch (error) {
    // Kill switch, spend cap, no credentials, task not allowed: every one of
    // them degrades to "Needs you", never to a guess.
    return {
      decisions: failedDecisions(
        plan.categoryLines,
        error instanceof Error ? error.name : "ai_error",
      ),
      invocationId: null,
    };
  }
}

async function runModels(
  context: ClassificationContext,
  complete: AiCompleteFn,
): Promise<ModelResults> {
  const { decisions, invocationId } = await categorizeLines(context, complete);
  let pick: PartyPickResult | null = null;
  if (
    context.plan.partyQuery &&
    context.partySearch?.kind === "candidates" &&
    context.partySearch.candidates.length > 0
  ) {
    pick = await pickPartyWithModel(context.plan.partyQuery, context.partySearch.candidates, {
      orgId: context.orgId,
      complete,
    });
  }
  return { decisions, categorizeInvocationId: invocationId, pick };
}

// ── Phase 3: apply ──────────────────────────────────────────────────────────

function partyOutcome(
  context: ClassificationContext,
  pick: PartyPickResult | null,
): PartyMatchOutcome | null {
  const search = context.partySearch;
  if (!search) return null;
  if (search.kind === "exact") return search;
  return decidePartyMatch(search.candidates, pick, context.minConfidence);
}

/**
 * Re-run the book rules on the classified draft, exactly as a correction
 * does: the paper's rule set — its routine's pinned snapshot, else the live
 * per-org configs — decides enabled, impact, and thresholds; a shadow
 * snapshot is evaluated and only logged; findings are fingerprinted by the
 * new revision and record the rule set that raised them.
 */
async function reevaluateBookRules(
  db: DbExecutor,
  input: {
    orgId: string;
    inboxItemId: string;
    candidate: CandidateRow;
    revision: number;
    partyId: string | null;
    lines: LineRow[];
    chart: ChartAccount[];
    documentTypes: DocumentFacts["documentTypes"];
  },
): Promise<{ findingCount: number; ruleSet: RuleSetProvenance }> {
  const { orgId } = input;
  await db
    .update(reviewFindings)
    .set({
      state: "resolved",
      resolvedAt: new Date(),
      resolutionNote: "Re-evaluated after the draft was classified.",
    })
    .where(
      and(
        eq(reviewFindings.organizationId, orgId),
        eq(reviewFindings.inboxItemId, input.inboxItemId),
        eq(reviewFindings.state, "open"),
        inArray(reviewFindings.ruleKey, [...BOOK_RULE_KEYS]),
      ),
    );

  const accountIds = [
    ...new Set(input.lines.flatMap((line) => (line.accountId ? [line.accountId] : []))),
  ];
  const { chart } = input;
  const childCounts = new Map<string, number>();
  for (const account of chart) {
    if (account.parentId)
      childCounts.set(account.parentId, (childCounts.get(account.parentId) ?? 0) + 1);
  }
  const ruleAccounts = new Map<string, BookRuleAccount>();
  for (const account of chart) {
    if (!accountIds.includes(account.id)) continue;
    ruleAccounts.set(account.id, {
      id: account.id,
      accountType: account.accountType,
      subtype: account.subtype,
      childCount: childCounts.get(account.id) ?? 0,
    });
  }
  const [party] = input.partyId
    ? await db
        .select({ id: parties.id, partyType: parties.partyType })
        .from(parties)
        .where(and(eq(parties.organizationId, orgId), eq(parties.id, input.partyId)))
        .limit(1)
    : [];
  const [settings] = await db
    .select()
    .from(organizationAccountingSettings)
    .where(eq(organizationAccountingSettings.organizationId, orgId))
    .limit(1);
  const ruleSets = await resolveCandidateRuleSets(db, orgId, input.candidate.id, {
    lowConfidenceThreshold:
      settings?.lowConfidenceThreshold ?? String(DEFAULT_LOW_CONFIDENCE_THRESHOLD),
    missingReceiptThreshold: settings?.missingReceiptThreshold ?? DEFAULT_MISSING_RECEIPT_THRESHOLD,
    missingReceiptCurrency: settings?.missingReceiptCurrency ?? DEFAULT_MISSING_RECEIPT_CURRENCY,
  });
  const ruleLines: CandidateLineInput[] = input.lines.map((line) => ({
    accountId: line.accountId,
    debit: line.originalDebit,
    credit: line.originalCredit,
    categoryConfidence: line.categoryConfidence,
    departmentId: line.departmentId,
    locationId: line.locationId,
    lineDescription: line.lineDescription,
  }));
  const functionalCurrency = input.candidate.functionalCurrency;
  const ruleInput: CandidateRuleInput = {
    candidate: {
      transactionDate: input.candidate.transactionDate,
      transactionType: input.candidate.transactionType as
        | "pay_in"
        | "pay_out"
        | "journal"
        | "transfer",
      memo: input.candidate.memo,
      partyId: input.partyId,
      referenceNumber: input.candidate.referenceNumber,
      originalCurrency: input.candidate.originalCurrency,
      functionalCurrency,
      exchangeRate: input.candidate.exchangeRate,
      lines: ruleLines,
    },
    lines: ruleLines,
    accounts: ruleAccounts,
    party: party ? { id: party.id, partyType: party.partyType } : null,
    documents: input.documentTypes,
    functionalCurrency,
  };
  const enforcedFindings = evaluateCandidateRules(ruleSets.active, ruleInput);
  const findings = withRuleSetProvenance(enforcedFindings, ruleSets.active.provenance);
  if (findings.length > 0) {
    await db
      .insert(reviewFindings)
      .values(
        findings.map((finding) => ({
          organizationId: orgId,
          inboxItemId: input.inboxItemId,
          candidateId: input.candidate.id,
          ruleKey: finding.ruleKey,
          impact: finding.impact,
          subjectType: "transaction_candidate",
          subjectId: input.candidate.id,
          fingerprint: `${input.candidate.id}:${input.revision}:${finding.ruleKey}`,
          message: finding.message,
          evidence: finding.evidence,
        })),
      )
      .onConflictDoNothing();
  }
  if (ruleSets.shadow) {
    await recordShadowRuleEvaluation(db, {
      orgId,
      inboxItemId: input.inboxItemId,
      candidateId: input.candidate.id,
      candidateRevision: input.revision,
      active: ruleSets.active,
      activeFindings: enforcedFindings,
      shadow: ruleSets.shadow,
      shadowFindings: withRuleSetProvenance(
        evaluateCandidateRules(ruleSets.shadow, ruleInput),
        ruleSets.shadow.provenance,
      ),
    });
  }
  return { findingCount: findings.length, ruleSet: ruleSets.active.provenance };
}

async function draftCreatePartyProposal(
  db: DbExecutor,
  input: {
    orgId: string;
    candidateId: string;
    query: PartyMatchQuery;
    confidence: number | null;
    invocationId: string | null;
  },
): Promise<string | null> {
  const name = input.query.name.trim();
  if (!name) return null;
  const sourceRef = { entityType: "transaction_candidate", entityId: input.candidateId };
  const [pending] = await listProposals(db, input.orgId, {
    status: "pending",
    kind: "create_party",
    sourceRef,
    limit: 1,
  });
  if (pending) return pending.id;
  const proposal = await createProposal(db, {
    orgId: input.orgId,
    kind: "create_party",
    payload: {
      entity: {
        entityType: input.query.entityType,
        name: name.slice(0, 255),
        identifier: "",
        accountType: "",
        matchedPartyId: "",
        taxId: input.query.taxId?.trim().slice(0, 50) ?? "",
        email: extractEmailAddress(input.query.emails?.[0])?.slice(0, 255) ?? "",
      },
    },
    invocationId: input.invocationId,
    confidence: input.confidence,
    sourceRef,
  });
  return proposal.id;
}

export type ClassifyCandidateResult =
  | { status: "skipped"; reason: ClassifySkipReason }
  | { status: "lease_lost" }
  | {
      status: "classified";
      candidateRevision: number;
      categoryLines: Array<{ lineIndex: number; outcome: string; accountId: string | null }>;
      party: {
        outcome: PartyMatchOutcome["kind"] | "not_attempted";
        /** The party this classification linked, if it linked one. */
        linkedPartyId: string | null;
        proposalId: string | null;
      };
      paymentDetailsChanged: boolean;
      findingCount: number;
    };

class LeaseLostError extends Error {}

export interface ClassifyCandidateDeps {
  /** Defaults to the production façade. Tests inject a stubbed runtime here. */
  complete?: AiCompleteFn;
  /**
   * Runs last inside the apply transaction. Returning false rolls the whole
   * apply back — the job handler completes its lease here, so the draft and
   * the job commit together or not at all.
   */
  beforeCommit?: (tx: DbExecutor) => Promise<boolean>;
}

/** Classify one candidate revision: read, ask the models, apply. */
export async function classifyInboxCandidate(
  input: { orgId: string; candidateId: string; candidateRevision: number },
  deps: ClassifyCandidateDeps = {},
): Promise<ClassifyCandidateResult> {
  const complete = deps.complete ?? aiComplete;
  const orgTx = <T>(fn: (tx: DbExecutor) => Promise<T>) =>
    withOrgContext(input.orgId, "system", "admin", fn);

  const loaded = await orgTx((tx) => loadClassificationContext(tx, input));
  if (loaded.kind === "skip") return { status: "skipped", reason: loaded.reason };
  const { context } = loaded;

  // The model calls run OUTSIDE any transaction.
  const models = await runModels(context, complete);

  try {
    return await orgTx(async (tx) => {
      const lifecycle = await lockInboxCandidateLifecycle(tx, input.orgId, context.inboxItemId);
      if (!lifecycle || lifecycle.candidate.id !== context.candidate.id) {
        return { status: "skipped", reason: "not_found" } as const;
      }
      const { candidate, item } = lifecycle;
      if (candidate.status !== "current")
        return { status: "skipped", reason: "not_current" } as const;
      if (candidate.revision !== input.candidateRevision) {
        return { status: "skipped", reason: "stale_revision" } as const;
      }
      if (!(INBOX_OPEN_STATES as readonly string[]).includes(item.state)) {
        return { status: "skipped", reason: "inbox_item_closed" } as const;
      }
      const lines = await loadCandidateLines(tx, input.orgId, candidate.id);
      if (!placeholdersIntact(lines)) {
        return { status: "skipped", reason: "lines_not_placeholders" } as const;
      }

      // Category lines: a confident pick, else the mapped uncategorized account.
      // The pick is re-checked against the chart as it is NOW: an account
      // deactivated or given children while the model ran is no longer postable.
      const chart = await loadChart(tx, input.orgId);
      const parentIds = new Set(
        chart.flatMap((account) => (account.parentId ? [account.parentId] : [])),
      );
      const postable = new Set(
        chart.filter((account) => account.isActive && !parentIds.has(account.id)).map((a) => a.id),
      );
      const noFitAccount = context.plan.direction
        ? await resolveNoFitAccount(tx, input.orgId, context.plan.direction)
        : null;
      const categoryLines: Array<{ lineIndex: number; outcome: string; accountId: string | null }> =
        [];
      for (const answered of models.decisions) {
        const decision: LineCategoryDecision =
          answered.outcome === "picked" && !postable.has(answered.accountId)
            ? {
                lineIndex: answered.lineIndex,
                outcome: "rejected",
                code: answered.code,
                reason: "account_no_longer_postable",
              }
            : answered;
        const lineId = context.plan.lineIdByIndex.get(decision.lineIndex);
        const line = lines.find((candidateLine) => candidateLine.id === lineId);
        if (!line) continue;
        const resolved = resolveCategoryLine(decision, noFitAccount, context.minConfidence);
        await tx
          .update(transactionCandidateLines)
          .set({
            accountId: resolved.accountId,
            categoryConfidence: resolved.categoryConfidence,
            lineDescription: candidate.memo?.trim() || line.lineDescription,
            predictionEvidence: {
              source: "inbox_classification",
              classificationVersion: CANDIDATE_CLASSIFICATION_VERSION,
              task: "categorize_lines",
              invocationId: models.categorizeInvocationId,
              matcherInputHash: line.predictionEvidence?.matcherInputHash ?? null,
              ...resolved.evidence,
            },
          })
          .where(
            and(
              eq(transactionCandidateLines.organizationId, input.orgId),
              eq(transactionCandidateLines.id, line.id),
            ),
          );
        categoryLines.push({
          lineIndex: decision.lineIndex,
          outcome: decision.outcome,
          accountId: resolved.accountId,
        });
      }

      // Counterparty: exact or a confident model pick links it; "new" drafts
      // a proposal; anything else stays with the reviewer.
      const outcome = partyOutcome(context, models.pick);
      let partyId = candidate.partyId;
      let proposalId: string | null = null;
      if (outcome && partyId === null) {
        if (outcome.kind === "exact" || outcome.kind === "model") {
          partyId = outcome.party.id;
        } else if (outcome.kind === "new" && context.plan.partyQuery) {
          proposalId = await draftCreatePartyProposal(tx, {
            orgId: input.orgId,
            candidateId: candidate.id,
            query: context.plan.partyQuery,
            confidence: outcome.confidence,
            invocationId: outcome.invocationId,
          });
        }
      }

      const nextRevision = candidate.revision + 1;
      await tx
        .update(transactionCandidates)
        .set({ revision: nextRevision, partyId, updatedAt: new Date() })
        .where(
          and(
            eq(transactionCandidates.organizationId, input.orgId),
            eq(transactionCandidates.id, candidate.id),
          ),
        );
      await tx
        .update(inboxItems)
        .set({
          candidateRevision: nextRevision,
          lockVersion: item.lockVersion + 1,
          updatedAt: new Date(),
        })
        .where(and(eq(inboxItems.organizationId, input.orgId), eq(inboxItems.id, item.id)));

      const classifiedLines = await loadCandidateLines(tx, input.orgId, candidate.id);
      const { findingCount, ruleSet } = await reevaluateBookRules(tx, {
        orgId: input.orgId,
        inboxItemId: item.id,
        candidate,
        revision: nextRevision,
        partyId,
        lines: classifiedLines,
        chart,
        documentTypes: context.facts.documentTypes,
      });
      const paymentDetailsChanged =
        partyId !== null &&
        context.plan.role !== null &&
        PAYEE_ROLES.has(context.plan.role) &&
        (await raisePaymentDetailsFindingIfChanged(tx, {
          orgId: input.orgId,
          inboxItemId: item.id,
          candidateId: candidate.id,
          partyId,
          facts: context.facts,
        }));

      const partySummary = {
        outcome: outcome?.kind ?? ("not_attempted" as const),
        linkedPartyId: partyId === candidate.partyId ? null : partyId,
        proposalId,
      };
      await tx
        .insert(workflowEvents)
        .values({
          organizationId: input.orgId,
          inboxItemId: item.id,
          entityType: "transaction_candidate",
          entityId: candidate.id,
          action: "candidate_classified",
          actorType: "system",
          idempotencyKey: `candidate:${candidate.id}:classified:${input.candidateRevision}`,
          data: {
            classificationVersion: CANDIDATE_CLASSIFICATION_VERSION,
            previousRevision: candidate.revision,
            candidateRevision: nextRevision,
            economicEvent: context.plan.event,
            categoryLines,
            codesListed: context.codes?.entries.length ?? 0,
            codesTruncated: context.codes?.truncated ?? false,
            party: {
              ...partySummary,
              tier: outcome?.kind === "exact" ? outcome.tier : null,
              confidence: outcome && "confidence" in outcome ? (outcome.confidence ?? null) : null,
              candidateCount: outcome && "candidates" in outcome ? outcome.candidates.length : 0,
              reason: outcome?.kind === "unresolved" ? outcome.reason : null,
            },
            paymentDetailsChanged,
            findingCount,
            ruleSet,
          },
        })
        .onConflictDoNothing();

      if (deps.beforeCommit && !(await deps.beforeCommit(tx))) throw new LeaseLostError();
      return {
        status: "classified",
        candidateRevision: nextRevision,
        categoryLines,
        party: partySummary,
        paymentDetailsChanged,
        findingCount,
      } as const;
    });
  } catch (error) {
    if (error instanceof LeaseLostError) return { status: "lease_lost" };
    throw error;
  }
}
