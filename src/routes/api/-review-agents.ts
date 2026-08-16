import { createServerFn } from "@tanstack/react-start";
import { and, asc, desc, eq, lt, or, sql } from "drizzle-orm";
import { z } from "zod";
import { accounts } from "@/db/schema/accounts";
import {
  reviewFindings,
  reviewRuleConfigs,
  reviewRuleDefinitions,
  reviewRuleRuns,
  workflowEvents,
} from "@/db/schema/inbox";
import { journalHeaders } from "@/db/schema/journals";
import { runConfiguredReviewRules } from "@/lib/inbox/review-engine";
import { REVIEW_RULE_BY_KEY } from "@/lib/inbox/review-rule-catalog";
import type { InboxServiceContext } from "@/lib/inbox/types";
import { toSerializableRecord } from "@/lib/serializable-json";
import { withMutationPermissionOrgContext, withPermissionOrgContext } from "@/lib/server-context";

export const listReviewAgents = createServerFn({ method: "GET" }).handler(async () =>
  withPermissionOrgContext("agentRule", "view", async ({ orgId, db }) => {
    const rows = await db
      .select({
        definitionId: reviewRuleDefinitions.id,
        key: reviewRuleDefinitions.key,
        name: reviewRuleDefinitions.name,
        group: reviewRuleDefinitions.group,
        formulaVersion: reviewRuleDefinitions.formulaVersion,
        defaultConfig: reviewRuleDefinitions.defaultConfig,
        configId: reviewRuleConfigs.id,
        enabled: reviewRuleConfigs.enabled,
        impact: reviewRuleConfigs.impact,
        lookbackMonths: reviewRuleConfigs.lookbackMonths,
        config: reviewRuleConfigs.config,
        version: reviewRuleConfigs.version,
        updatedAt: reviewRuleConfigs.updatedAt,
        openFindingCount: sql<number>`(
          select count(*)::int
          from review_findings rf
          where rf.organization_id = ${orgId}
            and rf.rule_key = ${reviewRuleDefinitions.key}
            and rf.state = 'open'
        )`,
        lastRunAt: sql<Date | null>`(
          select max(rr.started_at)
          from review_rule_runs rr
          where rr.organization_id = ${orgId}
            and rr.rule_config_id = ${reviewRuleConfigs.id}
        )`,
      })
      .from(reviewRuleDefinitions)
      .leftJoin(
        reviewRuleConfigs,
        and(
          eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id),
          eq(reviewRuleConfigs.organizationId, orgId),
        ),
      )
      .orderBy(asc(reviewRuleDefinitions.group), asc(reviewRuleDefinitions.name));

    return rows.map((row) => ({
      definitionId: row.definitionId,
      key: row.key,
      name: row.name,
      group: row.group,
      // Served from the catalog rather than a column: the seeder is ON CONFLICT DO NOTHING, so
      // a stored copy would be written once and then drift as the catalog changed.
      description: REVIEW_RULE_BY_KEY.get(row.key)?.description ?? null,
      // System rules are raised by background handlers with a hardcoded impact and read no
      // config, so their settings are shown read-only.
      configurable: row.group !== "system",
      formulaVersion: row.formulaVersion,
      configId: row.configId,
      enabled: row.enabled ?? true,
      // Only the review group defaults to advisory. Book findings gate approval, and system
      // findings are always inserted blocking — defaulting those to "warning" misreported them.
      impact: row.impact ?? (row.group === "review" ? "warning" : "blocking"),
      lookbackMonths: row.lookbackMonths ?? 3,
      configJson: JSON.stringify(row.config ?? row.defaultConfig),
      version: row.version ?? 0,
      updatedAt: row.updatedAt,
      openFindingCount: row.openFindingCount,
      lastRunAt: row.lastRunAt,
    }));
  }),
);

const jsonPrimitive = z.union([z.string(), z.number(), z.boolean(), z.null()]);
const updateRuleSchema = z.object({
  definitionId: z.string().uuid(),
  enabled: z.boolean(),
  impact: z.enum(["blocking", "warning"]),
  lookbackMonths: z.number().int().min(1).max(24),
  config: z.record(z.string(), jsonPrimitive),
  expectedVersion: z.number().int().min(0),
});
const duplicateRuleConfigSchema = z
  .object({
    mode: z.enum(["off", "shadow", "enforce"]).optional(),
    matchWindowDays: z.number().int().min(0).max(31).optional(),
    blockingScore: z.number().min(1).max(100).optional(),
    shadowScore: z.number().min(0).max(99).optional(),
    relatedAmountToleranceBps: z.number().int().min(0).max(10_000).optional(),
    algorithmVersion: z.number().int().positive().optional(),
  })
  .passthrough();

/**
 * Per-rule bounds for the keys the engine actually reads.
 *
 * These stopped being cosmetic the moment `standardDeviations` / `annualizedExpensePercent` /
 * `totalAssetPercent` were wired into the engine. Without bounds, `annualizedExpensePercent: 0`
 * makes every expense material, and since open blocking findings gate `setClosedThrough`, an
 * unprivileged typo becomes a permanent denial of period close. Every schema passes unknown keys
 * through so a config written by a newer release is never silently dropped.
 */
const ruleConfigSchemas: Record<string, z.ZodType> = {
  possible_duplicate: duplicateRuleConfigSchema,
  unusual_spend: z
    .object({ standardDeviations: z.number().gt(0).max(10).optional() })
    .passthrough(),
  material_expense: z
    .object({ annualizedExpensePercent: z.number().gt(0).max(100).optional() })
    .passthrough(),
  material_asset: z
    .object({ totalAssetPercent: z.number().gt(0).max(100).optional() })
    .passthrough(),
  missing_receipt: z
    .object({
      threshold: z.number().min(0).optional(),
      currency: z.string().length(3).optional(),
    })
    .passthrough(),
  low_confidence_category: z
    .object({ threshold: z.number().gt(0).max(1).optional() })
    .passthrough(),
};

export const updateReviewAgent = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => updateRuleSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "agentRule",
      "configure",
      { routeKey: "review-agent:update", limit: 60, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const [definition] = await db
          .select()
          .from(reviewRuleDefinitions)
          .where(eq(reviewRuleDefinitions.id, data.definitionId))
          .limit(1);
        if (!definition) throw new Error("Review agent not found.");
        // Not merely a disabled input: a system rule's enabled/impact row would be a lie,
        // because no code path reads it.
        if (definition.group === "system") {
          throw new Error("System agents are not configurable.");
        }
        const configSchema = ruleConfigSchemas[definition.key];
        if (configSchema) {
          const parsedRuleConfig = configSchema.safeParse(data.config);
          if (!parsedRuleConfig.success) {
            throw new Error(
              parsedRuleConfig.error.issues[0]?.message ??
                `${definition.name} configuration is invalid.`,
            );
          }
        }
        if (definition.key === "possible_duplicate") {
          const parsedConfig = duplicateRuleConfigSchema.safeParse(data.config);
          if (!parsedConfig.success) {
            throw new Error(
              parsedConfig.error.issues[0]?.message ??
                "Possible Duplicate configuration is invalid.",
            );
          }
          const defaults = definition.defaultConfig as Record<string, unknown>;
          const blockingScore = Number(
            parsedConfig.data.blockingScore ?? defaults.blockingScore ?? 70,
          );
          const shadowScore = Number(parsedConfig.data.shadowScore ?? defaults.shadowScore ?? 50);
          if (shadowScore >= blockingScore) {
            throw new Error("Shadow score must be lower than the blocking score.");
          }
        }
        const [existing] = await db
          .select()
          .from(reviewRuleConfigs)
          .where(
            and(
              eq(reviewRuleConfigs.organizationId, orgId),
              eq(reviewRuleConfigs.definitionId, data.definitionId),
            ),
          )
          .for("update")
          .limit(1);
        if (existing && existing.version !== data.expectedVersion) {
          throw new Error("This agent instruction changed after you opened it. Refresh and retry.");
        }
        if (!existing && data.expectedVersion !== 0) {
          throw new Error("This agent instruction changed after you opened it. Refresh and retry.");
        }
        const [saved] = await db
          .insert(reviewRuleConfigs)
          .values({
            organizationId: orgId,
            definitionId: data.definitionId,
            enabled: data.enabled,
            impact: data.impact,
            lookbackMonths: data.lookbackMonths,
            config: data.config,
            version: 1,
            updatedBy: userId,
          })
          .onConflictDoUpdate({
            target: [reviewRuleConfigs.organizationId, reviewRuleConfigs.definitionId],
            set: {
              enabled: data.enabled,
              impact: data.impact,
              lookbackMonths: data.lookbackMonths,
              config: data.config,
              version: (existing?.version ?? 0) + 1,
              updatedBy: userId,
              updatedAt: new Date(),
            },
          })
          .returning();
        return {
          id: saved.id,
          enabled: saved.enabled,
          impact: saved.impact,
          lookbackMonths: saved.lookbackMonths,
          configJson: JSON.stringify(saved.config),
          version: saved.version,
        };
      },
    ),
  );

const listFindingsSchema = z.object({
  ruleKey: z.string().max(64).optional(),
  state: z.enum(["open", "resolved", "all"]).default("open"),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
});

type FindingsCursor = { lastSeenAt: Date; id: string };

function decodeCursor(cursor: string | undefined): FindingsCursor | null {
  if (!cursor) return null;
  try {
    const [timestamp, id] = Buffer.from(cursor, "base64url").toString("utf8").split("|");
    const lastSeenAt = new Date(timestamp);
    if (!id || Number.isNaN(lastSeenAt.getTime())) return null;
    return { lastSeenAt, id };
  } catch {
    return null;
  }
}

function encodeCursor(row: { lastSeenAt: Date; id: string }): string {
  return Buffer.from(`${row.lastSeenAt.toISOString()}|${row.id}`, "utf8").toString("base64url");
}

/**
 * Findings for the review-agents page, with enough subject context to render a row.
 *
 * Both enrichment joins carry an `organizationId` predicate AND a `subjectType` predicate, and
 * both are load-bearing. `subjectId` is an opaque uuid with no foreign key, so without the org
 * predicate a corrupted or crafted value would surface another tenant's journal memo and amount
 * through this endpoint; without the `subjectType` predicate an `account_month` finding (whose
 * `subjectId` is an account id) could coincidentally match a journal id.
 */
export async function listReviewFindingsForOrg(
  ctx: Pick<InboxServiceContext, "db" | "orgId">,
  input: z.infer<typeof listFindingsSchema>,
) {
  const { db, orgId } = ctx;
  const cursor = decodeCursor(input.cursor);
  const rows = await db
    .select({
      id: reviewFindings.id,
      ruleKey: reviewFindings.ruleKey,
      impact: reviewFindings.impact,
      state: reviewFindings.state,
      subjectType: reviewFindings.subjectType,
      subjectId: reviewFindings.subjectId,
      message: reviewFindings.message,
      evidence: reviewFindings.evidence,
      firstSeenAt: reviewFindings.firstSeenAt,
      lastSeenAt: reviewFindings.lastSeenAt,
      resolvedAt: reviewFindings.resolvedAt,
      resolutionNote: reviewFindings.resolutionNote,
      inboxItemId: reviewFindings.inboxItemId,
      journalNumber: journalHeaders.transactionNumber,
      journalMemo: journalHeaders.memo,
      journalDate: journalHeaders.transactionDate,
      journalAmount: journalHeaders.totalAmount,
      journalCurrency: journalHeaders.functionalCurrency,
      accountName: accounts.name,
      accountNumber: accounts.accountNumber,
    })
    .from(reviewFindings)
    // Deliberately no effectiveJournalPredicate(): a finding on a journal later consolidated as
    // a duplicate should still show its context rather than render blank.
    .leftJoin(
      journalHeaders,
      and(
        eq(reviewFindings.subjectType, "journal_header"),
        eq(journalHeaders.id, reviewFindings.subjectId),
        eq(journalHeaders.organizationId, orgId),
      ),
    )
    .leftJoin(
      accounts,
      and(
        eq(reviewFindings.subjectType, "account_month"),
        eq(accounts.id, reviewFindings.subjectId),
        eq(accounts.organizationId, orgId),
      ),
    )
    .where(
      and(
        eq(reviewFindings.organizationId, orgId),
        input.ruleKey ? eq(reviewFindings.ruleKey, input.ruleKey) : undefined,
        input.state === "all" ? undefined : eq(reviewFindings.state, input.state),
        cursor
          ? or(
              lt(reviewFindings.lastSeenAt, cursor.lastSeenAt),
              and(
                eq(reviewFindings.lastSeenAt, cursor.lastSeenAt),
                lt(reviewFindings.id, cursor.id),
              ),
            )
          : undefined,
      ),
    )
    .orderBy(desc(reviewFindings.lastSeenAt), desc(reviewFindings.id))
    .limit(input.limit + 1);

  const page = rows.slice(0, input.limit);
  const findings = page.map((row) => {
    const evidence = toSerializableRecord(row.evidence);
    const evidenceMonth = typeof evidence.month === "string" ? evidence.month : null;
    const isJournal = row.subjectType === "journal_header";
    return {
      id: row.id,
      ruleKey: row.ruleKey,
      impact: row.impact,
      state: row.state,
      subjectType: row.subjectType,
      subjectId: row.subjectId,
      message: row.message,
      evidence,
      firstSeenAt: row.firstSeenAt,
      lastSeenAt: row.lastSeenAt,
      resolvedAt: row.resolvedAt,
      resolutionNote: row.resolutionNote,
      inboxItemId: row.inboxItemId,
      /**
       * Item-linked findings are resolved from the Inbox, which owns the item's lock version.
       * Offering a resolve box here would only surface a server rejection.
       */
      resolvableHere: row.inboxItemId === null,
      subjectLabel: isJournal ? row.journalNumber : row.accountName,
      subjectSublabel: isJournal ? row.journalMemo : row.accountNumber,
      subjectDate: isJournal ? row.journalDate : evidenceMonth,
      // decimal(20,8) arrives as a string. Keep it one — formatting is the client's job.
      subjectAmount: isJournal ? row.journalAmount : null,
      subjectCurrency: isJournal ? row.journalCurrency : null,
    };
  });

  const last = page.at(-1);
  return {
    findings,
    nextCursor: rows.length > input.limit && last ? encodeCursor(last) : null,
  };
}

export const listReviewFindings = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => listFindingsSchema.parse(input ?? {}))
  .handler(async ({ data }) =>
    withPermissionOrgContext("agentRule", "view", (ctx) => listReviewFindingsForOrg(ctx, data)),
  );

const resolveFindingSchema = z.object({
  findingId: z.string().uuid(),
  resolutionNote: z.string().trim().min(3).max(1000),
});

/**
 * Resolve a finding that is not attached to an Inbox item.
 *
 * A separate function from `resolveInboxFinding` rather than a relaxed join, because that one is
 * built entirely around the Inbox item's optimistic lock — it requires an `expectedLockVersion`,
 * compares it, bumps it, and writes an item-keyed workflow event. A finding raised against a
 * posted journal or an account-month has no item and therefore no lock to check. Relaxing the
 * join would make that concurrency guard optional for the case where it already works.
 *
 * The boundary is exclusive in both directions: this handles `inboxItemId IS NULL` only.
 */
export async function resolveReviewFindingForOrg(
  ctx: Pick<InboxServiceContext, "db" | "orgId" | "userId">,
  input: z.infer<typeof resolveFindingSchema>,
) {
  const { db, orgId, userId } = ctx;
  const [finding] = await db
    .select()
    .from(reviewFindings)
    // Explicit org predicate alongside RLS: this is the tenant boundary.
    .where(and(eq(reviewFindings.id, input.findingId), eq(reviewFindings.organizationId, orgId)))
    .for("update")
    .limit(1);
  // Same message for wrong-org and genuinely missing, so this is not a cross-tenant
  // existence oracle.
  if (!finding) throw new Error("Review finding not found.");
  if (finding.inboxItemId !== null) {
    throw new Error(
      "This finding belongs to an Inbox item — resolve it from the Inbox so the item's review state stays consistent.",
    );
  }
  // Defensive: duplicate findings always carry an inboxItemId, so the check above already
  // catches them. Kept so the invariant is stated where it is relied on.
  if (finding.ruleKey === "possible_duplicate") {
    throw new Error(
      "Possible duplicates require a structured decision. Compare both transactions and choose consolidate, attach, keep separate, merge, or reject.",
    );
  }
  if (finding.state !== "open") return { alreadyResolved: true as const };

  // Compare-and-set. With the FOR UPDATE above this is what the item path gets from lockVersion.
  const [resolved] = await db
    .update(reviewFindings)
    .set({
      state: "resolved",
      resolvedBy: userId,
      resolvedAt: new Date(),
      resolutionNote: input.resolutionNote,
    })
    .where(
      and(
        eq(reviewFindings.id, finding.id),
        eq(reviewFindings.organizationId, orgId),
        eq(reviewFindings.state, "open"),
      ),
    )
    .returning({ id: reviewFindings.id });
  if (!resolved) return { alreadyResolved: true as const };

  await db.insert(workflowEvents).values({
    organizationId: orgId,
    inboxItemId: null,
    entityType: "review_finding",
    entityId: finding.id,
    action: "resolved",
    actorType: "user",
    actorId: userId,
    data: {
      ruleKey: finding.ruleKey,
      subjectType: finding.subjectType,
      subjectId: finding.subjectId,
      resolutionNote: input.resolutionNote,
    },
  });

  return { alreadyResolved: false as const };
}

export const resolveReviewFinding = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => resolveFindingSchema.parse(input))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "review",
      "resolve",
      { routeKey: "review-agent:resolve-finding", limit: 60, windowMs: 60_000 },
      (ctx) => resolveReviewFindingForOrg(ctx, data),
    ),
  );

const listRunsSchema = z.object({
  ruleKey: z.string().max(64).optional(),
  limit: z.number().int().min(1).max(20).default(5),
});

/**
 * Recent runs for an agent. `review_rule_runs` has stored status, per-run counts, the window and
 * the last error since it was created; none of it was ever rendered.
 */
export const listReviewRuns = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => listRunsSchema.parse(input ?? {}))
  .handler(async ({ data }) =>
    withPermissionOrgContext("agentRule", "view", async ({ orgId, db }) => {
      const rows = await db
        .select({
          id: reviewRuleRuns.id,
          status: reviewRuleRuns.status,
          trigger: reviewRuleRuns.trigger,
          windowStart: reviewRuleRuns.windowStart,
          windowEnd: reviewRuleRuns.windowEnd,
          asOfDate: reviewRuleRuns.asOfDate,
          counts: reviewRuleRuns.counts,
          lastError: reviewRuleRuns.lastError,
          startedAt: reviewRuleRuns.startedAt,
          completedAt: reviewRuleRuns.completedAt,
        })
        .from(reviewRuleRuns)
        .innerJoin(reviewRuleConfigs, eq(reviewRuleRuns.ruleConfigId, reviewRuleConfigs.id))
        .innerJoin(
          reviewRuleDefinitions,
          eq(reviewRuleConfigs.definitionId, reviewRuleDefinitions.id),
        )
        .where(
          and(
            eq(reviewRuleRuns.organizationId, orgId),
            eq(reviewRuleConfigs.organizationId, orgId),
            data.ruleKey ? eq(reviewRuleDefinitions.key, data.ruleKey) : undefined,
          ),
        )
        .orderBy(desc(reviewRuleRuns.startedAt))
        .limit(data.limit);
      return rows.map((row) => ({
        ...row,
        counts: {
          scanned: Number((row.counts as Record<string, number>)?.scanned ?? 0),
          findings: Number((row.counts as Record<string, number>)?.findings ?? 0),
        },
      }));
    }),
  );

const runAgentsSchema = z.object({
  asOfDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** Restrict the run to specific agents. Omit to run every enabled review agent. */
  ruleKeys: z.array(z.string().max(64)).max(20).optional(),
});

export const runReviewAgents = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => runAgentsSchema.parse(input ?? {}))
  .handler(async ({ data }) =>
    withMutationPermissionOrgContext(
      "agentRule",
      "run",
      { routeKey: "review-agent:run", limit: 10, windowMs: 60_000 },
      (ctx) => runConfiguredReviewRules(ctx, data.asOfDate, data.ruleKeys),
    ),
  );
