// ============================================================================
// Read-only investigation tools (AI_NATIVE_ARCHITECTURE §7, Phase 7).
//
// Every tool here:
//   • is READ-ONLY — the agent has no way to write anything, ever
//   • is org-scoped in its own WHERE clause, not by convention
//   • returns bounded, JSON-serializable data (never blobs, never raw SQL)
//   • declares the ABAC permission a caller must hold to run the loop
//
// Tool RESULTS are data, never instructions: the loop wraps them in an
// untrusted-content envelope before they re-enter the model's context. This
// is the whole reason we do NOT use a general agent framework here — the
// value would be filesystem/bash tools, which a multi-tenant ledger must
// never grant.
// ============================================================================

import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import type { DbExecutor } from "../../../db";
import {
  reconciliationFlags,
  reconciliationSuggestions,
  reconciliations,
  statementLines,
} from "../../../db/schema/reconciliations";
import {
  effectiveJournalPredicate,
  journalHeaders,
  journalLines,
} from "../../../db/schema/journals";
import { parties } from "../../../db/schema/parties";
import { financialAccounts } from "../../../db/schema/financial-accounts";
import { vendorAliases } from "../../../db/schema/ai";
import { resolveCandidateAccountIds } from "../../resolve-candidate-accounts";
import { escapeLikePattern } from "../../sql-escape";
import type { Resource, Action } from "../../permissions";

/** Rows any single tool may return — keeps context (and cost) bounded. */
const ROW_LIMIT = 50;

export interface ToolContext {
  db: DbExecutor;
  orgId: string;
  reconciliationId: string;
}

export type RequiredToolPermission = {
  [R in Resource]: { resource: R; action: Action<R> };
}[Resource];

export interface InvestigationTool {
  name: string;
  description: string;
  /** JSON Schema for the tool's arguments (provider-neutral). */
  inputSchema: Record<string, unknown>;
  /** ABAC permissions the invoking user must hold. */
  requiredPermissions: RequiredToolPermission[];
  run(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown>;
}

const noArgs = { type: "object", properties: {}, additionalProperties: false };

export const INVESTIGATION_TOOLS: InvestigationTool[] = [
  {
    name: "get_reconciliation_summary",
    description:
      "Overall state of this reconciliation: period, statement balances, and counts of matched/unmatched lines.",
    inputSchema: noArgs,
    requiredPermissions: [{ resource: "reconciliation", action: "view" }],
    async run(ctx) {
      const [recon] = await ctx.db
        .select({
          periodStart: reconciliations.periodStart,
          periodEnd: reconciliations.periodEnd,
          statementBeginningBalance: reconciliations.statementBeginningBalance,
          statementEndingBalance: reconciliations.statementEndingBalance,
          status: reconciliations.status,
          bankAccountId: reconciliations.bankAccountId,
        })
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.id, ctx.reconciliationId),
            eq(reconciliations.organizationId, ctx.orgId),
          ),
        )
        .limit(1);
      if (!recon) return { error: "reconciliation not found" };

      const counts = await ctx.db
        .select({ matchStatus: statementLines.matchStatus, total: sql<number>`count(*)` })
        .from(statementLines)
        .where(eq(statementLines.reconciliationId, ctx.reconciliationId))
        .groupBy(statementLines.matchStatus);

      const [bank] = await ctx.db
        .select({ accountName: financialAccounts.accountName })
        .from(financialAccounts)
        .where(eq(financialAccounts.id, recon.bankAccountId))
        .limit(1);

      return {
        period: { start: recon.periodStart, end: recon.periodEnd },
        bankAccount: bank?.accountName ?? null,
        statementBeginningBalance: recon.statementBeginningBalance,
        statementEndingBalance: recon.statementEndingBalance,
        status: recon.status,
        lineCounts: Object.fromEntries(counts.map((c) => [c.matchStatus, Number(c.total)])),
      };
    },
  },
  {
    name: "list_unmatched_statement_lines",
    description: "Statement lines that are still unmatched, with date, description and amount.",
    inputSchema: noArgs,
    requiredPermissions: [{ resource: "reconciliation", action: "view" }],
    async run(ctx) {
      const rows = await ctx.db
        .select({
          id: statementLines.id,
          date: statementLines.transactionDate,
          description: statementLines.description,
          amount: statementLines.amount,
        })
        .from(statementLines)
        .where(
          and(
            eq(statementLines.reconciliationId, ctx.reconciliationId),
            eq(statementLines.matchStatus, "unmatched"),
          ),
        )
        .limit(ROW_LIMIT);
      return { lines: rows, truncated: rows.length === ROW_LIMIT };
    },
  },
  {
    name: "search_ledger_transactions",
    description:
      "Search posted ledger transactions on this reconciliation's bank account by date range, amount range, and/or description text.",
    inputSchema: {
      type: "object",
      properties: {
        dateFrom: { type: "string", description: "YYYY-MM-DD" },
        dateTo: { type: "string", description: "YYYY-MM-DD" },
        amountMin: { type: "number" },
        amountMax: { type: "number" },
        text: { type: "string", description: "Substring of the description or party name" },
      },
      additionalProperties: false,
    },
    requiredPermissions: [
      { resource: "reconciliation", action: "view" },
      { resource: "journal", action: "view" },
    ],
    async run(ctx, args) {
      const [recon] = await ctx.db
        .select({
          bankAccountId: reconciliations.bankAccountId,
          periodStart: reconciliations.periodStart,
          periodEnd: reconciliations.periodEnd,
        })
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.id, ctx.reconciliationId),
            eq(reconciliations.organizationId, ctx.orgId),
          ),
        )
        .limit(1);
      if (!recon) return { error: "reconciliation not found" };

      const [bank] = await ctx.db
        .select({ ledgerAccountId: financialAccounts.ledgerAccountId })
        .from(financialAccounts)
        .where(eq(financialAccounts.id, recon.bankAccountId))
        .limit(1);
      if (!bank?.ledgerAccountId) return { transactions: [] };

      const accountIds = await resolveCandidateAccountIds(ctx.db, bank.ledgerAccountId);
      if (accountIds.length === 0) return { transactions: [] };

      const conditions = [
        inArray(journalLines.accountId, accountIds),
        eq(journalHeaders.organizationId, ctx.orgId),
        eq(journalHeaders.status, "posted"),
        effectiveJournalPredicate(),
        gte(journalHeaders.transactionDate, String(args.dateFrom ?? recon.periodStart)),
        lte(journalHeaders.transactionDate, String(args.dateTo ?? recon.periodEnd)),
      ];
      if (typeof args.text === "string" && args.text.trim()) {
        const pattern = `%${escapeLikePattern(args.text.trim())}%`;
        conditions.push(
          sql`(${journalLines.lineDescription} ILIKE ${pattern} OR ${journalHeaders.memo} ILIKE ${pattern} OR ${parties.name} ILIKE ${pattern})`,
        );
      }

      const rows = await ctx.db
        .select({
          journalLineId: journalLines.id,
          date: journalHeaders.transactionDate,
          debit: journalLines.debit,
          credit: journalLines.credit,
          description: journalLines.lineDescription,
          memo: journalHeaders.memo,
          partyName: parties.name,
        })
        .from(journalLines)
        .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
        .leftJoin(parties, eq(journalLines.partyId, parties.id))
        .where(and(...conditions))
        .limit(ROW_LIMIT);

      const withAmounts = rows.map((r) => ({
        journalLineId: r.journalLineId,
        date: r.date,
        amount: Number(r.debit || 0) - Number(r.credit || 0),
        description: r.description || r.memo || "",
        partyName: r.partyName,
      }));

      const min = typeof args.amountMin === "number" ? args.amountMin : null;
      const max = typeof args.amountMax === "number" ? args.amountMax : null;
      const filtered = withAmounts.filter(
        (t) => (min == null || t.amount >= min) && (max == null || t.amount <= max),
      );
      return { transactions: filtered, truncated: rows.length === ROW_LIMIT };
    },
  },
  {
    name: "list_existing_suggestions",
    description:
      "Match suggestions already recorded for this reconciliation, including ones the user dismissed (so you do not repeat them).",
    inputSchema: noArgs,
    requiredPermissions: [{ resource: "reconciliation", action: "view" }],
    async run(ctx) {
      const rows = await ctx.db
        .select({
          statementLineId: reconciliationSuggestions.statementLineId,
          journalLineId: reconciliationSuggestions.journalLineId,
          suggestionType: reconciliationSuggestions.suggestionType,
          confidence: reconciliationSuggestions.confidence,
          status: reconciliationSuggestions.status,
        })
        .from(reconciliationSuggestions)
        .where(
          and(
            eq(reconciliationSuggestions.reconciliationId, ctx.reconciliationId),
            eq(reconciliationSuggestions.organizationId, ctx.orgId),
          ),
        )
        .limit(ROW_LIMIT);
      return { suggestions: rows };
    },
  },
  {
    name: "list_flags",
    description: "Issues already flagged on this reconciliation.",
    inputSchema: noArgs,
    requiredPermissions: [{ resource: "reconciliation", action: "view" }],
    async run(ctx) {
      const rows = await ctx.db
        .select({
          flagType: reconciliationFlags.flagType,
          description: reconciliationFlags.description,
          resolved: reconciliationFlags.resolved,
        })
        .from(reconciliationFlags)
        .where(eq(reconciliationFlags.reconciliationId, ctx.reconciliationId))
        .limit(ROW_LIMIT);
      return { flags: rows };
    },
  },
  {
    name: "lookup_vendor_alias",
    description:
      "Look up which party a normalized statement descriptor has historically belonged to for this organization.",
    inputSchema: {
      type: "object",
      properties: { descriptor: { type: "string" } },
      required: ["descriptor"],
      additionalProperties: false,
    },
    requiredPermissions: [{ resource: "party", action: "view" }],
    async run(ctx, args) {
      const descriptor = String(args.descriptor ?? "");
      if (!descriptor) return { matches: [] };
      const rows = await ctx.db
        .select({
          normalizedDescriptor: vendorAliases.normalizedDescriptor,
          partyId: vendorAliases.partyId,
          partyName: parties.name,
        })
        .from(vendorAliases)
        .leftJoin(parties, eq(vendorAliases.partyId, parties.id))
        .where(
          and(
            eq(vendorAliases.organizationId, ctx.orgId),
            sql`${vendorAliases.normalizedDescriptor} ILIKE ${`%${escapeLikePattern(descriptor)}%`}`,
          ),
        )
        .limit(10);
      return { matches: rows };
    },
  },
  {
    name: "get_recent_reconciliations",
    description:
      "Recent finalized reconciliations for the same bank account — useful for spotting a recurring timing difference.",
    inputSchema: noArgs,
    requiredPermissions: [{ resource: "reconciliation", action: "view" }],
    async run(ctx) {
      const [recon] = await ctx.db
        .select({ bankAccountId: reconciliations.bankAccountId })
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.id, ctx.reconciliationId),
            eq(reconciliations.organizationId, ctx.orgId),
          ),
        )
        .limit(1);
      if (!recon) return { reconciliations: [] };

      const rows = await ctx.db
        .select({
          id: reconciliations.id,
          periodStart: reconciliations.periodStart,
          periodEnd: reconciliations.periodEnd,
          status: reconciliations.status,
          clearedBalance: reconciliations.clearedBalance,
          unclearedTotal: reconciliations.unclearedTotal,
        })
        .from(reconciliations)
        .where(
          and(
            eq(reconciliations.organizationId, ctx.orgId),
            eq(reconciliations.bankAccountId, recon.bankAccountId),
          ),
        )
        .orderBy(desc(reconciliations.periodEnd))
        .limit(6);
      return { reconciliations: rows };
    },
  },
];

export const TOOLS_BY_NAME = new Map(INVESTIGATION_TOOLS.map((t) => [t.name, t]));

/** Union of every permission any tool needs — checked once, before the loop. */
export function allRequiredPermissions(): RequiredToolPermission[] {
  const seen = new Set<string>();
  const out: RequiredToolPermission[] = [];
  for (const tool of INVESTIGATION_TOOLS) {
    for (const perm of tool.requiredPermissions) {
      const key = `${perm.resource}:${perm.action}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(perm);
    }
  }
  return out;
}
