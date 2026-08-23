import { and, eq, gte, inArray, lte, ne, or, sql, desc } from "drizzle-orm";
import { createLogger } from "@/lib/logger";
import type { DbExecutor } from "@/db";
import { documents } from "@/db/schema/documents";
import {
  inboxItems,
  integrationSources,
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  sourceMatchCandidates,
  sourceRecordDocuments,
  sourceRecords,
  transactionCandidates,
  transactionCandidateSources,
  workflowEvents,
} from "@/db/schema/inbox";
import {
  canonicalizeSourcePair,
  currencyDecimalPlaces,
  DUPLICATE_MATCHER_VERSION,
  normalizeDuplicateMatchInput,
  scoreDuplicatePair,
  type DuplicateDisposition,
  type DuplicateMatcherConfig,
  type DuplicateMatcherInput,
  type DuplicateMatchResult,
  type EconomicEventClass,
  type SourceRecordMatchState,
  type TransactionDirection,
} from "./duplicate-matcher";
import type { InboxServiceContext } from "./types";

const logger = createLogger("inbox.duplicate-engine");

export interface DuplicateEngineConfig extends DuplicateMatcherConfig {
  mode: "off" | "shadow" | "enforce";
  enabled: boolean;
  impact: "blocking" | "warning";
}

export interface RunDuplicateMatchingResult {
  sourceRecordId: string;
  evaluated: number;
  blockingCases: string[];
  shadowCases: string[];
  staleCases: string[];
  skipped: boolean;
  mode: DuplicateEngineConfig["mode"];
}

type MatchableSource = DuplicateMatcherInput & {
  sourceRecordId: string;
  organizationId: string;
  rawRecord: typeof sourceRecords.$inferSelect;
};

function isContainerEvidence(source: MatchableSource): boolean {
  return source.rawRecord.recordType === "email";
}

function dateOffset(value: string, days: number): string {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function numberConfig(config: Record<string, unknown>, key: string, fallback: number): number {
  const value = config[key];
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

export async function loadDuplicateEngineConfig(
  db: DbExecutor,
  orgId: string,
): Promise<DuplicateEngineConfig> {
  const [row] = await db
    .select({
      defaultConfig: reviewRuleDefinitions.defaultConfig,
      enabled: reviewRuleConfigs.enabled,
      impact: reviewRuleConfigs.impact,
      config: reviewRuleConfigs.config,
      configVersion: reviewRuleConfigs.version,
      formulaVersion: reviewRuleDefinitions.formulaVersion,
    })
    .from(reviewRuleDefinitions)
    .leftJoin(
      reviewRuleConfigs,
      and(
        eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id),
        eq(reviewRuleConfigs.organizationId, orgId),
      ),
    )
    .where(eq(reviewRuleDefinitions.key, "possible_duplicate"))
    .limit(1);

  const defaultConfig = (row?.defaultConfig ?? {}) as Record<string, unknown>;
  const configured = (row?.config ?? {}) as Record<string, unknown>;
  const merged = { ...defaultConfig, ...configured };
  const rawMode = merged.mode;
  const mode: DuplicateEngineConfig["mode"] =
    rawMode === "off" || rawMode === "shadow" || rawMode === "enforce" ? rawMode : "enforce";
  return {
    mode,
    enabled: row?.enabled !== false,
    impact: row?.impact === "warning" ? "warning" : "blocking",
    matchWindowDays: numberConfig(merged, "matchWindowDays", 3),
    blockingScore: numberConfig(merged, "blockingScore", 70),
    shadowScore: numberConfig(merged, "shadowScore", 50),
    relatedAmountToleranceBps: numberConfig(merged, "relatedAmountToleranceBps", 200),
    // Scoring version only. reviewRuleConfigs.version increments on EVERY
    // config edit — including non-scoring settings — and it used to feed
    // this max, so any settings save invalidated every open finding and
    // tripped the approval gate's version comparison (checkpoint C8: the
    // blocking threshold itself stays 70; retunes are deliberate via the
    // explicit algorithmVersion config or the definition's formulaVersion).
    algorithmVersion: Math.max(
      numberConfig(merged, "algorithmVersion", DUPLICATE_MATCHER_VERSION),
      row?.formulaVersion ?? 1,
      DUPLICATE_MATCHER_VERSION,
    ),
  };
}

async function documentHashesForSources(db: DbExecutor, orgId: string, sourceRecordIds: string[]) {
  if (sourceRecordIds.length === 0) return new Map<string, string[]>();
  const [rows, children] = await Promise.all([
    db
      .select({
        sourceRecordId: sourceRecordDocuments.sourceRecordId,
        contentHash: documents.contentHash,
      })
      .from(sourceRecordDocuments)
      .innerJoin(documents, eq(sourceRecordDocuments.documentId, documents.id))
      .where(
        and(
          eq(sourceRecordDocuments.organizationId, orgId),
          inArray(sourceRecordDocuments.sourceRecordId, sourceRecordIds),
        ),
      ),
    db
      .select({
        id: sourceRecords.id,
        parentSourceRecordId: sourceRecords.parentSourceRecordId,
      })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, orgId),
          inArray(sourceRecords.parentSourceRecordId, sourceRecordIds),
        ),
      ),
  ]);
  const bySource = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.contentHash) continue;
    const hashes = bySource.get(row.sourceRecordId) ?? [];
    hashes.push(row.contentHash);
    bySource.set(row.sourceRecordId, hashes);
  }

  // Parent sources such as an email envelope may retain the attachment link for
  // provenance. Once a normalized child owns that same document, only the child
  // contributes the hash to matching. This prevents one email from generating both
  // parent-vs-upload and child-vs-upload cases for the same attachment.
  if (children.length > 0) {
    const childDocuments = await db
      .select({
        sourceRecordId: sourceRecordDocuments.sourceRecordId,
        contentHash: documents.contentHash,
      })
      .from(sourceRecordDocuments)
      .innerJoin(documents, eq(sourceRecordDocuments.documentId, documents.id))
      .where(
        and(
          eq(sourceRecordDocuments.organizationId, orgId),
          inArray(
            sourceRecordDocuments.sourceRecordId,
            children.map(({ id }) => id),
          ),
        ),
      );
    const childParent = new Map(
      children.map(({ id, parentSourceRecordId }) => [id, parentSourceRecordId]),
    );
    for (const childDocument of childDocuments) {
      if (!childDocument.contentHash) continue;
      const parentSourceRecordId = childParent.get(childDocument.sourceRecordId);
      if (!parentSourceRecordId) continue;
      const parentHashes = bySource.get(parentSourceRecordId);
      if (!parentHashes) continue;
      bySource.set(
        parentSourceRecordId,
        parentHashes.filter((hash) => hash !== childDocument.contentHash),
      );
    }
  }
  return bySource;
}

function sourceToMatcherInput(
  source: typeof sourceRecords.$inferSelect,
  provider: string | null,
  documentHashes: string[],
): MatchableSource {
  return {
    sourceRecordId: source.id,
    organizationId: source.organizationId,
    economicEventClass: source.economicEventClass as EconomicEventClass,
    direction: source.direction as TransactionDirection,
    originalAmount: source.originalAmount ?? source.amount,
    originalCurrency: source.originalCurrency ?? source.currency,
    effectiveDate: source.effectiveDate ?? source.transactionDate,
    normalizedParty: source.normalizedParty,
    normalizedReference: source.normalizedReference,
    description: source.description,
    provider,
    sourceAccountRef: source.sourceAccountRef,
    documentHashes,
    recordState: source.recordState as SourceRecordMatchState,
    rawRecord: source,
  };
}

async function loadSource(
  db: DbExecutor,
  orgId: string,
  sourceRecordId: string,
): Promise<MatchableSource> {
  const [row] = await db
    .select({
      source: sourceRecords,
      provider: integrationSources.provider,
    })
    .from(sourceRecords)
    .leftJoin(integrationSources, eq(sourceRecords.sourceId, integrationSources.id))
    .where(and(eq(sourceRecords.organizationId, orgId), eq(sourceRecords.id, sourceRecordId)))
    .limit(1);
  if (!row) throw new Error("Source record not found for duplicate matching.");
  const hashes = await documentHashesForSources(db, orgId, [sourceRecordId]);
  return sourceToMatcherInput(row.source, row.provider, hashes.get(sourceRecordId) ?? []);
}

async function findCandidateSourceIds(
  db: DbExecutor,
  orgId: string,
  source: MatchableSource,
  config: DuplicateEngineConfig,
) {
  const exactDocumentIds =
    source.documentHashes && source.documentHashes.length > 0
      ? await db
          .selectDistinct({ sourceRecordId: sourceRecordDocuments.sourceRecordId })
          .from(sourceRecordDocuments)
          .innerJoin(documents, eq(sourceRecordDocuments.documentId, documents.id))
          .where(
            and(
              eq(sourceRecordDocuments.organizationId, orgId),
              inArray(documents.contentHash, [...source.documentHashes]),
              ne(sourceRecordDocuments.sourceRecordId, source.sourceRecordId),
            ),
          )
      : [];

  const normalized = normalizeDuplicateMatchInput(source);
  const amountDecimalPlaces = normalized.originalCurrency
    ? currencyDecimalPlaces(normalized.originalCurrency)
    : null;
  const comparableIds =
    normalized.originalCurrency &&
    normalized.originalAmount &&
    normalized.effectiveDate &&
    amountDecimalPlaces !== null
      ? await db
          .select({ id: sourceRecords.id })
          .from(sourceRecords)
          .where(
            and(
              eq(sourceRecords.organizationId, orgId),
              eq(sourceRecords.recordState, "active"),
              ne(sourceRecords.id, source.sourceRecordId),
              // The matcher normalizes BOTH sides with originalCurrency ??
              // currency and effectiveDate ?? transactionDate — discovery
              // must coalesce the same way (the amount predicate always
              // did), or a candidate whose original_* columns are NULL is
              // never even offered to the matcher.
              sql`coalesce(${sourceRecords.originalCurrency}, ${sourceRecords.currency}) = ${normalized.originalCurrency}`,
              sql`round(abs(coalesce(${sourceRecords.originalAmount}, ${sourceRecords.amount})), ${amountDecimalPlaces}) = ${normalized.originalAmount}::numeric`,
              gte(
                sql`coalesce(${sourceRecords.effectiveDate}, ${sourceRecords.transactionDate})`,
                dateOffset(normalized.effectiveDate, -(config.matchWindowDays ?? 3)),
              ),
              lte(
                sql`coalesce(${sourceRecords.effectiveDate}, ${sourceRecords.transactionDate})`,
                dateOffset(normalized.effectiveDate, config.matchWindowDays ?? 3),
              ),
            ),
          )
          // Deterministic order so the 500-cap trims the OLDEST candidates
          // first instead of whatever the planner returned (audit P8).
          .orderBy(desc(sourceRecords.effectiveDate), desc(sourceRecords.createdAt))
          .limit(500)
      : [];
  if (comparableIds.length === 500) {
    logger.warn("Duplicate candidate discovery hit the 500-row cap — oldest candidates trimmed", {
      orgId,
      sourceRecordId: source.sourceRecordId,
    });
  }
  return [
    ...new Set([
      ...exactDocumentIds.map(({ sourceRecordId }) => sourceRecordId),
      ...comparableIds.map(({ id }) => id),
    ]),
  ];
}

async function loadCandidateSources(
  db: DbExecutor,
  orgId: string,
  sourceRecordIds: string[],
): Promise<MatchableSource[]> {
  if (sourceRecordIds.length === 0) return [];
  const [rows, hashes] = await Promise.all([
    db
      .select({
        source: sourceRecords,
        provider: integrationSources.provider,
      })
      .from(sourceRecords)
      .leftJoin(integrationSources, eq(sourceRecords.sourceId, integrationSources.id))
      .where(
        and(eq(sourceRecords.organizationId, orgId), inArray(sourceRecords.id, sourceRecordIds)),
      ),
    documentHashesForSources(db, orgId, sourceRecordIds),
  ]);
  return rows.map(({ source, provider }) =>
    sourceToMatcherInput(source, provider, hashes.get(source.id) ?? []),
  );
}

function effectiveDisposition(
  result: DuplicateMatchResult,
  config: DuplicateEngineConfig,
): DuplicateDisposition {
  if (result.disposition !== "blocking") return result.disposition;
  // Shadow mode is the org's explicit observe-only switch — it demotes
  // EVERYTHING, exact document hits included (they used to block anyway,
  // which made "shadow" a lie for the strongest signal). Outside shadow,
  // an exact document hit still overrides the warning-impact demotion.
  if (config.mode === "shadow") return "shadow";
  if (result.reason === "exact_document") return "blocking";
  if (config.impact === "warning") return "shadow";
  return "blocking";
}

async function candidateIdsForSources(db: DbExecutor, orgId: string, sourceRecordIds: string[]) {
  const rows = await db
    .select({ candidateId: transactionCandidates.id })
    .from(transactionCandidates)
    .leftJoin(
      transactionCandidateSources,
      eq(transactionCandidateSources.candidateId, transactionCandidates.id),
    )
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.status, "current"),
        or(
          inArray(transactionCandidates.sourceRecordId, sourceRecordIds),
          inArray(transactionCandidateSources.sourceRecordId, sourceRecordIds),
        ),
      ),
    );
  return [...new Set(rows.map(({ candidateId }) => candidateId))];
}

async function sourceIdsInSameEvidenceGroup(
  db: DbExecutor,
  orgId: string,
  source: MatchableSource,
): Promise<Set<string>> {
  const excluded = new Set<string>([source.sourceRecordId]);
  if (source.rawRecord.parentSourceRecordId) {
    excluded.add(source.rawRecord.parentSourceRecordId);
  }

  const [children, candidateIds] = await Promise.all([
    db
      .select({ id: sourceRecords.id })
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, orgId),
          eq(sourceRecords.parentSourceRecordId, source.sourceRecordId),
        ),
      ),
    candidateIdsForSources(db, orgId, [source.sourceRecordId]),
  ]);
  for (const child of children) excluded.add(child.id);

  if (candidateIds.length > 0) {
    const candidateSources = await db
      .select({
        primarySourceRecordId: transactionCandidates.sourceRecordId,
        linkedSourceRecordId: transactionCandidateSources.sourceRecordId,
      })
      .from(transactionCandidates)
      .leftJoin(
        transactionCandidateSources,
        eq(transactionCandidateSources.candidateId, transactionCandidates.id),
      )
      .where(
        and(
          eq(transactionCandidates.organizationId, orgId),
          eq(transactionCandidates.status, "current"),
          inArray(transactionCandidates.id, candidateIds),
        ),
      );
    for (const row of candidateSources) {
      if (row.primarySourceRecordId) excluded.add(row.primarySourceRecordId);
      if (row.linkedSourceRecordId) excluded.add(row.linkedSourceRecordId);
    }
  }
  return excluded;
}

async function syncFindingsForCase(
  ctx: Pick<InboxServiceContext, "db" | "orgId">,
  caseId: string,
  sourceRecordIds: [string, string],
  disposition: DuplicateDisposition,
  score: number,
  signals: DuplicateMatchResult["signals"],
) {
  const { db, orgId } = ctx;
  const candidateIds = await candidateIdsForSources(db, orgId, sourceRecordIds);
  if (candidateIds.length === 0) return;
  const candidateRows = await db
    .select({
      candidate: transactionCandidates,
      inboxItem: inboxItems,
    })
    .from(transactionCandidates)
    .innerJoin(inboxItems, eq(inboxItems.candidateId, transactionCandidates.id))
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        inArray(transactionCandidates.id, candidateIds),
      ),
    );

  for (const row of candidateRows) {
    const fingerprint = `${row.candidate.id}:${row.candidate.revision}:possible_duplicate:${caseId}`;
    if (disposition !== "blocking") {
      await db
        .update(reviewFindings)
        .set({
          state: "resolved",
          resolvedAt: new Date(),
          resolutionNote: "Duplicate matcher is running in shadow mode.",
          lastSeenAt: new Date(),
        })
        .where(
          and(
            eq(reviewFindings.organizationId, orgId),
            eq(reviewFindings.fingerprint, fingerprint),
            eq(reviewFindings.state, "open"),
          ),
        );
      continue;
    }
    await db
      .insert(reviewFindings)
      .values({
        organizationId: orgId,
        inboxItemId: row.inboxItem.id,
        candidateId: row.candidate.id,
        ruleKey: "possible_duplicate",
        impact: "blocking",
        subjectType: "transaction_candidate",
        subjectId: row.candidate.id,
        fingerprint,
        message: `A ${score}% duplicate match must be resolved before this transaction can post.`,
        evidence: { caseId, sourceRecordIds, score, signals },
        formulaVersion: DUPLICATE_MATCHER_VERSION,
      })
      .onConflictDoUpdate({
        target: [reviewFindings.organizationId, reviewFindings.fingerprint],
        set: {
          state: "open",
          message: `A ${score}% duplicate match must be resolved before this transaction can post.`,
          evidence: { caseId, sourceRecordIds, score, signals },
          lastSeenAt: new Date(),
          resolvedBy: null,
          resolvedAt: null,
          resolutionNote: null,
        },
      });
  }
}

async function persistMatch(
  ctx: Pick<InboxServiceContext, "db" | "orgId">,
  source: MatchableSource,
  candidate: MatchableSource,
  result: DuplicateMatchResult,
  config: DuplicateEngineConfig,
) {
  const { db, orgId } = ctx;
  const pair = canonicalizeSourcePair(source.sourceRecordId, candidate.sourceRecordId);
  const leftInputHash =
    pair.leftSourceRecordId === source.sourceRecordId
      ? result.leftInputHash
      : result.rightInputHash;
  const rightInputHash =
    pair.rightSourceRecordId === candidate.sourceRecordId
      ? result.rightInputHash
      : result.leftInputHash;
  const disposition = effectiveDisposition(result, config);
  const [existing] = await db
    .select()
    .from(sourceMatchCandidates)
    .where(
      and(
        eq(sourceMatchCandidates.organizationId, orgId),
        eq(sourceMatchCandidates.leftSourceRecordId, pair.leftSourceRecordId),
        eq(sourceMatchCandidates.rightSourceRecordId, pair.rightSourceRecordId),
      ),
    )
    .limit(1);

  if (existing?.state === "resolved") {
    const unchanged =
      existing.algorithmVersion === result.algorithmVersion &&
      existing.leftInputHash === leftInputHash &&
      existing.rightInputHash === rightInputHash;
    if (existing.resolutionAction !== "keep_separate" || unchanged) {
      return { caseId: existing.id, disposition: "none" as const, preservedResolution: true };
    }
  }

  const values = {
    matchType:
      result.matchClass === "related"
        ? "related"
        : result.reason === "exact_document"
          ? "exact"
          : "fuzzy",
    confidence: (result.score / 100).toFixed(4),
    matchClass: result.matchClass === "related" ? "related" : "duplicate",
    disposition,
    score: result.score.toFixed(2),
    signals: { ...result.signals } as Record<string, unknown>,
    evidence: {
      reason: result.reason,
      matcherMode: config.mode,
      sourceRecordIds: [pair.leftSourceRecordId, pair.rightSourceRecordId],
    },
    algorithmVersion: result.algorithmVersion,
    leftInputHash,
    rightInputHash,
    state: "open",
    resolutionAction: null,
    canonicalCandidateId: null,
    canonicalJournalHeaderId: null,
    resolutionReason: null,
    resolutionIdempotencyKey: null,
    resolvedBy: null,
    resolvedAt: null,
    updatedAt: new Date(),
  } as const;

  const [saved] = existing
    ? await db
        .update(sourceMatchCandidates)
        .set({ ...values, lockVersion: existing.lockVersion + 1 })
        .where(
          and(
            eq(sourceMatchCandidates.organizationId, orgId),
            eq(sourceMatchCandidates.id, existing.id),
            eq(sourceMatchCandidates.lockVersion, existing.lockVersion),
          ),
        )
        .returning()
    : await db
        .insert(sourceMatchCandidates)
        .values({
          organizationId: orgId,
          leftSourceRecordId: pair.leftSourceRecordId,
          rightSourceRecordId: pair.rightSourceRecordId,
          ...values,
        })
        .onConflictDoNothing()
        .returning();
  const [current] = saved
    ? [saved]
    : await db
        .select()
        .from(sourceMatchCandidates)
        .where(
          and(
            eq(sourceMatchCandidates.organizationId, orgId),
            eq(sourceMatchCandidates.leftSourceRecordId, pair.leftSourceRecordId),
            eq(sourceMatchCandidates.rightSourceRecordId, pair.rightSourceRecordId),
          ),
        )
        .limit(1);
  if (!current) {
    return { caseId: null, disposition: "none" as const, preservedResolution: false };
  }
  if (!saved && current.state !== "open") {
    return {
      caseId: current.id,
      disposition: "none" as const,
      preservedResolution: current.state === "resolved",
    };
  }
  const caseId = current.id;

  await syncFindingsForCase(
    ctx,
    caseId,
    [pair.leftSourceRecordId, pair.rightSourceRecordId],
    disposition,
    result.score,
    result.signals,
  );
  return { caseId, disposition, preservedResolution: false };
}

async function duplicateCasesForReevaluation(
  db: DbExecutor,
  orgId: string,
  sourceRecordId: string,
) {
  return db
    .select()
    .from(sourceMatchCandidates)
    .where(
      and(
        eq(sourceMatchCandidates.organizationId, orgId),
        inArray(sourceMatchCandidates.state, ["open", "stale"]),
        or(
          eq(sourceMatchCandidates.leftSourceRecordId, sourceRecordId),
          eq(sourceMatchCandidates.rightSourceRecordId, sourceRecordId),
        ),
      ),
    );
}

async function markDuplicateCaseStale(
  ctx: Pick<InboxServiceContext, "db" | "orgId" | "userId">,
  duplicateCase: typeof sourceMatchCandidates.$inferSelect,
  source: MatchableSource,
  reason: string,
  algorithmVersion: number,
): Promise<boolean> {
  const staleAt = new Date();
  const [staleCase] = await ctx.db
    .update(sourceMatchCandidates)
    .set({
      state: "stale",
      evidence: {
        ...duplicateCase.evidence,
        stale: {
          reason,
          sourceRecordId: source.sourceRecordId,
          inputHash: normalizeDuplicateMatchInput(source).inputHash,
          algorithmVersion,
          at: staleAt.toISOString(),
        },
      },
      lockVersion: duplicateCase.lockVersion + 1,
      updatedAt: staleAt,
    })
    .where(
      and(
        eq(sourceMatchCandidates.organizationId, ctx.orgId),
        eq(sourceMatchCandidates.id, duplicateCase.id),
        eq(sourceMatchCandidates.state, "open"),
        eq(sourceMatchCandidates.lockVersion, duplicateCase.lockVersion),
      ),
    )
    .returning({ id: sourceMatchCandidates.id });
  if (!staleCase) return false;

  await ctx.db
    .update(reviewFindings)
    .set({
      state: "resolved",
      resolvedAt: staleAt,
      resolutionNote: "The source pair no longer meets the duplicate matcher threshold.",
      lastSeenAt: staleAt,
    })
    .where(
      and(
        eq(reviewFindings.organizationId, ctx.orgId),
        eq(reviewFindings.ruleKey, "possible_duplicate"),
        eq(reviewFindings.state, "open"),
        or(
          sql`${reviewFindings.evidence}->>'caseId' = ${duplicateCase.id}`,
          sql`${reviewFindings.fingerprint} like ${"%:possible_duplicate:" + duplicateCase.id}`,
        ),
      ),
    );
  const inputHash = normalizeDuplicateMatchInput(source).inputHash;
  await ctx.db
    .insert(workflowEvents)
    .values({
      organizationId: ctx.orgId,
      entityType: "duplicate_case",
      entityId: duplicateCase.id,
      action: "duplicate_case_stale",
      actorType: "system",
      actorId: ctx.userId,
      idempotencyKey: `duplicate-stale:${duplicateCase.id}:${source.sourceRecordId}:${inputHash}:${algorithmVersion}`,
      data: {
        reason,
        sourceRecordId: source.sourceRecordId,
        inputHash,
        algorithmVersion,
      },
    })
    .onConflictDoNothing();
  return true;
}

/**
 * Deterministically re-evaluate one source after extraction, correction,
 * provider update, or evidence attachment. This never selects a canonical
 * accounting record and never mutates a journal.
 */
export async function runDuplicateMatchingForSource(
  ctx: Pick<InboxServiceContext, "db" | "orgId" | "userId">,
  sourceRecordId: string,
  trigger:
    | "candidate_created"
    | "source_updated"
    | "document_attached"
    | "provider_updated"
    | "backfill" = "source_updated",
): Promise<RunDuplicateMatchingResult> {
  const startedAt = performance.now();
  const config = await loadDuplicateEngineConfig(ctx.db, ctx.orgId);
  const source = await loadSource(ctx.db, ctx.orgId, sourceRecordId);
  if (isContainerEvidence(source)) {
    const existingCases = await duplicateCasesForReevaluation(ctx.db, ctx.orgId, sourceRecordId);
    const staleCases: string[] = [];
    for (const duplicateCase of existingCases) {
      if (duplicateCase.state !== "open") continue;
      if (
        await markDuplicateCaseStale(
          ctx,
          duplicateCase,
          source,
          "container_evidence",
          config.algorithmVersion ?? DUPLICATE_MATCHER_VERSION,
        )
      ) {
        staleCases.push(duplicateCase.id);
      }
    }
    return {
      sourceRecordId,
      evaluated: 0,
      blockingCases: [],
      shadowCases: [],
      staleCases,
      skipped: true,
      mode: config.mode,
    };
  }
  if (!config.enabled || config.mode === "off") {
    // Turning the rule off must not leave yesterday's OPEN blocking cases
    // pinning approvals forever — stale them the same way container
    // evidence does, resolving their findings.
    const existingCases = await duplicateCasesForReevaluation(ctx.db, ctx.orgId, sourceRecordId);
    const staleCases: string[] = [];
    for (const duplicateCase of existingCases) {
      if (duplicateCase.state !== "open") continue;
      if (
        await markDuplicateCaseStale(
          ctx,
          duplicateCase,
          source,
          "rule_disabled",
          config.algorithmVersion ?? DUPLICATE_MATCHER_VERSION,
        )
      ) {
        staleCases.push(duplicateCase.id);
      }
    }
    return {
      sourceRecordId,
      evaluated: 0,
      blockingCases: [],
      shadowCases: [],
      staleCases,
      skipped: true,
      mode: config.mode,
    };
  }

  const [discoveredCandidateSourceIds, sameEvidenceGroup, existingCases] = await Promise.all([
    findCandidateSourceIds(ctx.db, ctx.orgId, source, config),
    sourceIdsInSameEvidenceGroup(ctx.db, ctx.orgId, source),
    duplicateCasesForReevaluation(ctx.db, ctx.orgId, sourceRecordId),
  ]);
  const existingCounterpartIds = existingCases.map((duplicateCase) =>
    duplicateCase.leftSourceRecordId === sourceRecordId
      ? duplicateCase.rightSourceRecordId
      : duplicateCase.leftSourceRecordId,
  );
  const candidateSourceIds = [
    ...new Set([...discoveredCandidateSourceIds, ...existingCounterpartIds]),
  ];
  const eligibleCandidateSourceIds = candidateSourceIds.filter(
    (candidateSourceId) => !sameEvidenceGroup.has(candidateSourceId),
  );
  const loadedCandidates = await loadCandidateSources(
    ctx.db,
    ctx.orgId,
    eligibleCandidateSourceIds,
  );
  const containerCandidateIds = new Set(
    loadedCandidates
      .filter((candidate) => isContainerEvidence(candidate))
      .map((candidate) => candidate.sourceRecordId),
  );
  const candidates = loadedCandidates.filter((candidate) => !isContainerEvidence(candidate));
  const evaluations = candidates.map((candidate) => ({
    candidate,
    result: scoreDuplicatePair(source, candidate, config),
  }));
  const matches = evaluations.filter(({ result }) => result.matchClass !== "none");
  const qualifyingCandidateIds = new Set(matches.map(({ candidate }) => candidate.sourceRecordId));
  const evaluationByCandidateId = new Map(
    evaluations.map(({ candidate, result }) => [candidate.sourceRecordId, result]),
  );
  const blockingCases: string[] = [];
  const shadowCases: string[] = [];
  const staleCases: string[] = [];

  for (const match of matches) {
    const persisted = await persistMatch(ctx, source, match.candidate, match.result, config);
    if (!persisted.caseId) continue;
    if (persisted.disposition === "blocking") blockingCases.push(persisted.caseId);
    if (persisted.disposition === "shadow") shadowCases.push(persisted.caseId);
  }

  for (const duplicateCase of existingCases) {
    if (duplicateCase.state !== "open") continue;
    const counterpartId =
      duplicateCase.leftSourceRecordId === sourceRecordId
        ? duplicateCase.rightSourceRecordId
        : duplicateCase.leftSourceRecordId;
    if (qualifyingCandidateIds.has(counterpartId)) continue;
    const result = evaluationByCandidateId.get(counterpartId);
    const reason = containerCandidateIds.has(counterpartId)
      ? "container_evidence"
      : sameEvidenceGroup.has(counterpartId)
        ? "same_evidence_group"
        : (result?.reason ?? "outside_candidate_lookup");
    if (
      await markDuplicateCaseStale(
        ctx,
        duplicateCase,
        source,
        reason,
        config.algorithmVersion ?? DUPLICATE_MATCHER_VERSION,
      )
    ) {
      staleCases.push(duplicateCase.id);
    }
  }

  if (blockingCases.length > 0 || shadowCases.length > 0) {
    await ctx.db
      .insert(workflowEvents)
      .values({
        organizationId: ctx.orgId,
        entityType: "source_record",
        entityId: sourceRecordId,
        action: "duplicate_detection",
        actorType: "system",
        actorId: ctx.userId,
        idempotencyKey: `duplicate-detection:${sourceRecordId}:${normalizeDuplicateMatchInput(source).inputHash}:${config.algorithmVersion}`,
        data: {
          trigger,
          mode: config.mode,
          evaluated: candidates.length,
          blockingCases,
          shadowCases,
        },
      })
      .onConflictDoNothing();
  }

  const matcherInputHash = normalizeDuplicateMatchInput(source).inputHash;
  await ctx.db
    .insert(workflowEvents)
    .values({
      organizationId: ctx.orgId,
      entityType: "source_record",
      entityId: sourceRecordId,
      action: "duplicate_matcher_run",
      actorType: "system",
      actorId: ctx.userId,
      idempotencyKey: `duplicate-matcher-run:${sourceRecordId}:${matcherInputHash}:${config.algorithmVersion}`,
      data: {
        trigger,
        mode: config.mode,
        algorithmVersion: config.algorithmVersion,
        evaluated: candidates.length,
        blockingCaseCount: blockingCases.length,
        shadowCaseCount: shadowCases.length,
        staleCaseCount: staleCases.length,
        durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
      },
    })
    .onConflictDoNothing();

  return {
    sourceRecordId,
    evaluated: candidates.length,
    blockingCases,
    shadowCases,
    staleCases,
    skipped: false,
    mode: config.mode,
  };
}
