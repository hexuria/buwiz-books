// ============================================================================
// Inbox stage 2 — classify one enriched candidate (inbox v2 §4, §5 and §7).
//
// Stage 1 (ingest_triage, the extraction's economic event) already decided
// what kind of paper this is. This pass fills the draft the extraction left
// with two unselected placeholder lines.
//
// MEMORY FIRST (§7). Before any model, the paper's keys — its files' hashes,
// its sender and printed tax id, its party when that is known without a
// model, its description — are looked up in the organization's classification
// memories, most specific kind first (src/lib/inbox/memory/select.ts):
//
//   • a hit replays the remembered answer (kind of paper, party, and every
//     line's account) with NO model call at all. The memory's accounts and
//     party pass the same server-side checks a model's pick does; one that
//     fails is a miss, and is reported;
//   • two memories of the same specificity that disagree apply nothing and
//     ask no model: the blocking `memory_conflict` finding sends the paper to
//     a person;
//   • otherwise the models below run as before.
//
// Either way the result is still a draft: the book rules and the
// payment-details check run on it, and blocking findings still block.
//
// Without a memory:
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
// unselected unless a person's memory says otherwise: nothing on a receipt
// proves it, so a reviewer picks it, and the `uncategorized` rule keeps
// blocking until they do.
//
// Three phases, so no transaction is held across a model call: read (one
// org-context transaction), models (none), apply (one transaction that
// re-locks the lifecycle, re-validates the revision and the placeholders,
// re-decides the memory lookup under lock, and then writes). Background code:
// the org comes from the job row, and every phase runs in withOrgContext for
// that org.
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
  counterpartyRoleFor,
  isPlaceholderLine,
  planCandidateClassification,
  type ClassificationPlan,
} from "./classification-plan";
import { runDuplicateMatchingForSource } from "./duplicate-engine";
import { DUPLICATE_MATCHER_VERSION, normalizeDuplicateMatchInput } from "./duplicate-matcher";
import { directionForEconomicEventClass } from "./economic-event";
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
import { memoryDirection, type MemoryApplication, type MemoryDraft } from "./memory/answer";
import { raiseMemoryConflictFinding, resolveMemoryConflictFindings } from "./memory/conflict";
import { sameMemoryDecision, type RejectedMemory } from "./memory/select";
import { chartForMemory, lookupMemoryForDraft, type MemoryLookup } from "./memory/store";
import { recordMemoryApplied, supersedeMemoryApplication } from "./memory/tracking";
import { parseMoneyToScaled, scaledToMoney } from "./money";
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

interface PaperSource {
  economicEventClass: string | null;
  recordType: string | null;
}

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
  source: PaperSource;
  /** The party known without a model: already on the draft, or an exact match. */
  knownPartyId: string | null;
  /** What the memory layer said, before any model ran. */
  memory: MemoryLookup;
  memoryDraft: MemoryDraft | null;
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

/**
 * The draft a memory replays onto: the paper's direction, and the amount the
 * two placeholder lines carry. Null when the paper has no direction.
 */
function memoryDraftFor(
  event: string,
  lines: readonly LineRow[],
  currency: string,
): MemoryDraft | null {
  const direction = memoryDirection(event);
  const total = lines.find((line) => line.originalDebit !== null)?.originalDebit;
  if (!direction || !total) return null;
  return {
    direction,
    total: scaledToMoney(parseMoneyToScaled(total)),
    currency: currency.trim().toUpperCase(),
  };
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
          recordType: sourceRecords.recordType,
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
  const chart = await loadChart(db, orgId);
  const codes =
    plan.direction && plan.categoryLines.length > 0
      ? buildAccountCodeList(chart, CATEGORY_ACCOUNT_TYPES[plan.direction])
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

  const paperSource: PaperSource = {
    economicEventClass: source?.economicEventClass ?? null,
    recordType: source?.recordType ?? null,
  };
  const knownPartyId =
    row.candidate.partyId ?? (partySearch?.kind === "exact" ? partySearch.party.id : null);
  const memoryDraft = memoryDraftFor(plan.event, lines, row.candidate.originalCurrency);
  const memory = await lookupMemoryForDraft(db, {
    orgId,
    candidateId: row.candidate.id,
    sourceRecordId: row.candidate.sourceRecordId,
    partyId: knownPartyId,
    paperEventClass: paperSource.economicEventClass,
    paperRecordType: paperSource.recordType,
    draft: memoryDraft,
    chart: chartForMemory(chart),
  });

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
      source: paperSource,
      knownPartyId,
      memory,
      memoryDraft,
    },
  };
}

// ── Phase 2: models (no transaction) ────────────────────────────────────────

interface ModelResults {
  decisions: LineCategoryDecision[];
  categorizeInvocationId: string | null;
  pick: PartyPickResult | null;
}

/** A memory answered (or two disagreed): no model is asked anything. */
const NO_MODEL_RESULTS: ModelResults = { decisions: [], categorizeInvocationId: null, pick: null };

function answeredByMemory(context: ClassificationContext): boolean {
  const decision = context.memory.decision;
  return decision?.kind === "hit" || decision?.kind === "conflict";
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
 * The party outcome when no model was asked: an exact match, or "new" when
 * nothing even looked alike. Look-alikes need the model's judgement, so a
 * memory path leaves them to the reviewer rather than guessing.
 */
function deterministicPartyOutcome(context: ClassificationContext): PartyMatchOutcome | null {
  const search = context.partySearch;
  if (!search) return null;
  if (search.kind === "exact") return search;
  if (search.candidates.length === 0) {
    return decidePartyMatch(search.candidates, null, context.minConfidence);
  }
  return null;
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

/**
 * Write a memory's answer onto the two placeholder lines. One remembered line
 * per side updates the placeholders in place; a remembered split replaces
 * them with its lines. Either way both sides sum to the draft's total.
 */
async function writeMemoryLines(
  db: DbExecutor,
  input: {
    orgId: string;
    candidate: CandidateRow;
    lines: LineRow[];
    application: MemoryApplication;
    evidence: Record<string, unknown>;
  },
): Promise<void> {
  const { orgId, candidate, application } = input;
  const description = candidate.memo?.trim() || null;
  const debits = application.lines.filter((line) => line.side === "debit");
  const credits = application.lines.filter((line) => line.side === "credit");
  const placeholders = {
    debit: input.lines.find((line) => line.originalDebit !== null)!,
    credit: input.lines.find((line) => line.originalCredit !== null)!,
  };
  const evidenceFor = (placeholder: LineRow) => ({
    ...input.evidence,
    matcherInputHash: placeholder.predictionEvidence?.matcherInputHash ?? null,
  });
  if (debits.length === 1 && credits.length === 1) {
    for (const answer of [debits[0], credits[0]]) {
      const placeholder = placeholders[answer.side];
      await db
        .update(transactionCandidateLines)
        .set({
          accountId: answer.accountId,
          categoryConfidence: null,
          lineDescription: description ?? placeholder.lineDescription,
          predictionEvidence: evidenceFor(placeholder),
        })
        .where(
          and(
            eq(transactionCandidateLines.organizationId, orgId),
            eq(transactionCandidateLines.id, placeholder.id),
          ),
        );
    }
    return;
  }
  const functional = candidate.originalCurrency === candidate.functionalCurrency;
  await db
    .delete(transactionCandidateLines)
    .where(
      and(
        eq(transactionCandidateLines.organizationId, orgId),
        eq(transactionCandidateLines.candidateId, candidate.id),
      ),
    );
  await db.insert(transactionCandidateLines).values(
    application.lines.map((line, index) => ({
      organizationId: orgId,
      candidateId: candidate.id,
      accountId: line.accountId,
      originalDebit: line.side === "debit" ? line.amount : null,
      originalCredit: line.side === "credit" ? line.amount : null,
      functionalDebit: functional && line.side === "debit" ? line.amount : null,
      functionalCredit: functional && line.side === "credit" ? line.amount : null,
      originalCurrency: candidate.originalCurrency,
      exchangeRate: "1",
      lineDescription: description,
      predictionEvidence: evidenceFor(placeholders[line.side]),
      sortOrder: index,
    })),
  );
}

/**
 * A memory's answer names a different kind of paper than stage 1 read. The
 * memory only gets here when the source is one a reviewer could reclassify
 * and the direction is unchanged (select.ts); the source then takes the kind
 * exactly as a reviewer's correction would set it, and duplicate matching
 * re-runs on it.
 */
async function reclassifySourceForMemory(
  db: DbExecutor,
  input: {
    orgId: string;
    sourceRecordId: string;
    docKind: MemoryApplication["docKind"];
    memoryId: string;
    candidateRevision: number;
  },
): Promise<void> {
  const [source] = await db
    .select()
    .from(sourceRecords)
    .where(
      and(
        eq(sourceRecords.organizationId, input.orgId),
        eq(sourceRecords.id, input.sourceRecordId),
      ),
    )
    .limit(1);
  if (!source || source.economicEventClass === input.docKind) return;
  const direction = directionForEconomicEventClass(input.docKind);
  const normalized = normalizeDuplicateMatchInput({
    economicEventClass: input.docKind,
    direction,
    originalAmount: source.originalAmount ?? source.amount,
    originalCurrency: source.originalCurrency ?? source.currency,
    effectiveDate: source.effectiveDate ?? source.transactionDate,
    normalizedParty: source.normalizedParty,
    normalizedReference: source.normalizedReference,
    description: source.description,
  });
  await db
    .update(sourceRecords)
    .set({
      economicEventClass: input.docKind,
      direction,
      matcherInputHash: normalized.inputHash,
      matcherVersion: DUPLICATE_MATCHER_VERSION,
      rawData: {
        ...source.rawData,
        memoryReclassification: {
          memoryId: input.memoryId,
          candidateRevision: input.candidateRevision,
          economicEventClassBefore: source.economicEventClass,
          economicEventClassAfter: input.docKind,
        },
      },
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(sourceRecords.organizationId, input.orgId),
        eq(sourceRecords.id, input.sourceRecordId),
      ),
    );
}

export interface ClassificationMemorySummary {
  /**
   * hit: a memory answered; conflict: memories disagreed; changed: the memory
   * answer moved while the draft was being written, so nothing was applied;
   * miss: memories matched but none was usable; none: no memory matched.
   */
  outcome: "hit" | "conflict" | "changed" | "miss" | "none";
  matchKind: string | null;
  memoryIds: string[];
  rejected: RejectedMemory[];
}

export type ClassifyCandidateResult =
  | { status: "skipped"; reason: ClassifySkipReason }
  | { status: "lease_lost" }
  | {
      status: "classified";
      candidateRevision: number;
      categoryLines: Array<{ lineIndex: number; outcome: string; accountId: string | null }>;
      party: {
        outcome: PartyMatchOutcome["kind"] | "memory" | "not_attempted";
        /** The party this classification linked, if it linked one. */
        linkedPartyId: string | null;
        proposalId: string | null;
      };
      memory: ClassificationMemorySummary;
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

/** Classify one candidate revision: read, ask the memories then the models, apply. */
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

  // The model calls run OUTSIDE any transaction — and not at all when a
  // memory answered or two memories disagreed.
  const models = answeredByMemory(context) ? NO_MODEL_RESULTS : await runModels(context, complete);

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

      // The pick is re-checked against the chart as it is NOW: an account
      // deactivated or given children while the model ran is no longer postable.
      const chart = await loadChart(tx, input.orgId);

      // A memory decision is re-made under lock against the chart as it is
      // now. If anything moved (a memory turned off, an account deactivated),
      // nothing is applied: no model ran, so the line degrades to no fit.
      let memoryDecision = context.memory.decision;
      let memoryOutcome: ClassificationMemorySummary["outcome"] = memoryDecision
        ? memoryDecision.kind
        : "none";
      if (answeredByMemory(context)) {
        const recheck = await lookupMemoryForDraft(
          tx,
          {
            orgId: input.orgId,
            candidateId: candidate.id,
            sourceRecordId: candidate.sourceRecordId,
            partyId: context.knownPartyId,
            paperEventClass: context.source.economicEventClass,
            paperRecordType: context.source.recordType,
            draft: context.memoryDraft,
            chart: chartForMemory(chart),
          },
          { lock: true },
        );
        if (!sameMemoryDecision(memoryDecision, recheck.decision)) {
          memoryOutcome = "changed";
          memoryDecision = recheck.decision;
        }
      }
      const hit = memoryOutcome === "hit" && memoryDecision?.kind === "hit" ? memoryDecision : null;
      const conflict =
        memoryOutcome === "conflict" && memoryDecision?.kind === "conflict" ? memoryDecision : null;
      const memorySummary: ClassificationMemorySummary = {
        outcome: memoryOutcome,
        matchKind:
          memoryDecision && memoryDecision.kind !== "miss" ? memoryDecision.matchKind : null,
        memoryIds: memoryDecision && memoryDecision.kind !== "miss" ? memoryDecision.memoryIds : [],
        rejected: memoryDecision?.rejected ?? [],
      };
      const memoryEvidence: Record<string, unknown> = {
        outcome: memorySummary.outcome,
        matchKind: memorySummary.matchKind,
        memoryIds: memorySummary.memoryIds,
        ...(memorySummary.rejected.length > 0 ? { rejected: memorySummary.rejected } : {}),
      };

      const categoryLines: Array<{ lineIndex: number; outcome: string; accountId: string | null }> =
        [];
      if (hit) {
        await writeMemoryLines(tx, {
          orgId: input.orgId,
          candidate,
          lines,
          application: hit.application,
          evidence: {
            source: "memory",
            classificationVersion: CANDIDATE_CLASSIFICATION_VERSION,
            selection: "memory",
            memoryId: hit.memoryIds[0],
            memoryIds: hit.memoryIds,
            matchKind: hit.matchKind,
            ...(hit.rejected.length > 0 ? { rejectedMemories: hit.rejected } : {}),
          },
        });
        for (const line of context.plan.categoryLines) {
          categoryLines.push({
            lineIndex: line.lineIndex,
            outcome: "memory",
            accountId:
              hit.application.lines.find((answer) => answer.side === line.side)?.accountId ?? null,
          });
        }
      } else {
        // Category lines: a confident pick, else the mapped uncategorized
        // account. A memory conflict (or a memory that moved) asks no model,
        // so its category line takes no fit.
        const parentIds = new Set(
          chart.flatMap((account) => (account.parentId ? [account.parentId] : [])),
        );
        const postable = new Set(
          chart
            .filter((account) => account.isActive && !parentIds.has(account.id))
            .map((a) => a.id),
        );
        const noFitAccount = context.plan.direction
          ? await resolveNoFitAccount(tx, input.orgId, context.plan.direction)
          : null;
        const memoryBlocked = memoryOutcome === "conflict" || memoryOutcome === "changed";
        const decisions = memoryBlocked
          ? failedDecisions(context.plan.categoryLines, `memory_${memoryOutcome}`)
          : models.decisions;
        for (const answered of decisions) {
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
                ...(memoryBlocked ? { outcome: `memory_${memoryOutcome}` } : {}),
                ...(memoryOutcome !== "none" ? { memory: memoryEvidence } : {}),
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
            outcome: memoryBlocked ? `memory_${memoryOutcome}` : decision.outcome,
            accountId: resolved.accountId,
          });
        }
      }

      // The kind of paper the memory remembered, when stage 1 read another.
      const effectiveEvent = hit ? hit.application.docKind : context.plan.event;
      if (hit && candidate.sourceRecordId && hit.application.docKind !== context.plan.event) {
        await reclassifySourceForMemory(tx, {
          orgId: input.orgId,
          sourceRecordId: candidate.sourceRecordId,
          docKind: hit.application.docKind,
          memoryId: hit.memoryIds[0],
          candidateRevision: candidate.revision + 1,
        });
      }

      // Counterparty: a memory's party, else an exact match or a confident
      // model pick links it; "new" drafts a proposal; anything else stays
      // with the reviewer. A memory path asks no model about the party.
      const outcome = answeredByMemory(context)
        ? deterministicPartyOutcome(context)
        : partyOutcome(context, models.pick);
      let partyId = candidate.partyId;
      let proposalId: string | null = null;
      if (hit?.application.partyId) {
        partyId = hit.application.partyId;
      } else if (outcome && partyId === null) {
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
      const role = counterpartyRoleFor(effectiveEvent);
      const paymentDetailsChanged =
        partyId !== null &&
        role !== null &&
        PAYEE_ROLES.has(role) &&
        (await raisePaymentDetailsFindingIfChanged(tx, {
          orgId: input.orgId,
          inboxItemId: item.id,
          candidateId: candidate.id,
          partyId,
          facts: context.facts,
        }));

      // Every classification decides the memory question afresh.
      await resolveMemoryConflictFindings(tx, { orgId: input.orgId, inboxItemId: item.id });
      if (conflict) {
        await raiseMemoryConflictFinding(tx, {
          orgId: input.orgId,
          inboxItemId: item.id,
          candidateId: candidate.id,
          candidateRevision: nextRevision,
          matchKind: conflict.matchKind,
          answers: conflict.answers,
        });
      }
      if (hit) {
        await recordMemoryApplied(tx, {
          orgId: input.orgId,
          inboxItemId: item.id,
          candidateId: candidate.id,
          candidateRevision: nextRevision,
          matchKind: hit.matchKind,
          memoryIds: hit.memoryIds,
          application: hit.application,
          rejected: hit.rejected,
        });
      } else {
        await supersedeMemoryApplication(tx, {
          orgId: input.orgId,
          candidateId: candidate.id,
          inboxItemId: item.id,
          reason: "reclassified_without_memory",
        });
      }
      // A memory that no longer passes the checks was treated as a miss here;
      // its own history says so, and Settings → Memories shows why.
      for (const rejected of memorySummary.rejected) {
        await tx
          .insert(workflowEvents)
          .values({
            organizationId: input.orgId,
            inboxItemId: item.id,
            entityType: "classification_memory",
            entityId: rejected.memoryId,
            action: "memory_answer_rejected",
            actorType: "system",
            idempotencyKey: `memory:${rejected.memoryId}:rejected:${candidate.id}:${nextRevision}`,
            data: {
              candidateId: candidate.id,
              candidateRevision: nextRevision,
              matchKind: rejected.matchKind,
              reason: rejected.reason,
            },
          })
          .onConflictDoNothing();
      }
      const conflictFinding = conflict ? 1 : 0;

      const partySummary = {
        outcome: hit?.application.partyId
          ? ("memory" as const)
          : (outcome?.kind ?? ("not_attempted" as const)),
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
            economicEvent: effectiveEvent,
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
            memory: { ...memorySummary },
            // The keys this paper was looked up by. "Remember this?" saves a
            // memory under exactly these, so the same paper finds it again.
            memoryKeys: { ...context.memory.keys },
            paymentDetailsChanged,
            findingCount: findingCount + conflictFinding,
            ruleSet,
          },
        })
        .onConflictDoNothing();

      if (hit && candidate.sourceRecordId && hit.application.docKind !== context.plan.event) {
        await runDuplicateMatchingForSource(
          { db: tx, orgId: input.orgId, userId: "system" },
          candidate.sourceRecordId,
          "source_updated",
        );
      }

      if (deps.beforeCommit && !(await deps.beforeCommit(tx))) throw new LeaseLostError();
      return {
        status: "classified",
        candidateRevision: nextRevision,
        categoryLines,
        party: partySummary,
        memory: memorySummary,
        paymentDetailsChanged,
        findingCount: findingCount + conflictFinding,
      } as const;
    });
  } catch (error) {
    if (error instanceof LeaseLostError) return { status: "lease_lost" };
    throw error;
  }
}
