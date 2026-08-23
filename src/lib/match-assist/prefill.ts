// ============================================================================
// create_txn prefill — for statement lines that matched nothing, pre-fill a
// transaction so recording it is one review-and-save instead of manual entry.
//
// Org context (chart of accounts, parties) is read SERVER-SIDE here — unlike
// the interactive transaction-parse endpoint, nothing is client-supplied, so
// the grounding set is authoritative. Output lands as a create_txn proposal;
// the human-submitted form remains the write gate.
// ============================================================================

import { and, eq } from "drizzle-orm";
import { withOrgContext, type DbExecutor } from "../../db";
import { accounts } from "../../db/schema/accounts";
import { parties } from "../../db/schema/parties";
import { aiComplete } from "../ai/facade";
import type { TransactionParseOutput } from "../ai/schemas/transaction-parse";
import { createProposal, listProposals } from "../ai/proposals";
import { normalizeConfidence } from "../ai/confidence";
import { lookupVendorAliases } from "./aliases";
import { normalizeDescriptor } from "./normalize";
import { createLogger } from "../logger";

const logger = createLogger("match-assist.prefill");

/** Cap per run — prefill is a convenience, not a bulk job. */
const MAX_LINES_PER_RUN = 25;

export interface PrefillLine {
  id: string;
  transactionDate: string;
  description: string;
  amount: number;
}

export interface RunTxnPrefillInput {
  orgId: string;
  reconciliationId: string;
  /** Statement lines still unmatched after matching + match-assist. */
  lines: PrefillLine[];
  /** The reconciliation's bank ledger account (header category). */
  bankAccount?: { id: string; name: string };
  userId?: string;
}

export interface RunTxnPrefillResult {
  proposalsCreated: number;
  skipped: number;
  degraded: boolean;
}

/**
 * Create create_txn proposals for unmatched lines. Best-effort per line:
 * one bad model response never aborts the batch.
 */
export async function runTxnPrefill(input: RunTxnPrefillInput): Promise<RunTxnPrefillResult> {
  // Same P9 contract as runMatchAssist: short org-context transactions per
  // query; model calls outside.
  const scoped = <R>(op: (tx: DbExecutor) => Promise<R>): Promise<R> =>
    withOrgContext(input.orgId, "system", "admin", op);
  const result: RunTxnPrefillResult = { proposalsCreated: 0, skipped: 0, degraded: false };
  const lines = input.lines.slice(0, MAX_LINES_PER_RUN);
  if (lines.length === 0) return result;

  // Server-side org context — the authoritative grounding set.
  const [orgAccounts, orgParties] = await scoped((tx) =>
    Promise.all([
      tx
        .select({
          id: accounts.id,
          name: accounts.name,
          accountNumber: accounts.accountNumber,
          accountType: accounts.accountType,
        })
        .from(accounts)
        .where(and(eq(accounts.organizationId, input.orgId), eq(accounts.isActive, true))),
      tx
        .select({ id: parties.id, name: parties.name })
        .from(parties)
        .where(and(eq(parties.organizationId, input.orgId), eq(parties.isActive, true))),
    ]),
  );

  const accountIds = new Set(orgAccounts.map((a) => a.id));
  const partyIds = new Set(orgParties.map((p) => p.id));
  const partyNameById = new Map(orgParties.map((p) => [p.id, p.name]));

  const aliasByDescriptor = await scoped((tx) =>
    lookupVendorAliases(
      tx,
      input.orgId,
      lines.map((l) => l.description),
    ),
  );

  for (const line of lines) {
    try {
      // Don't stack duplicates for the same statement line.
      const existing = await scoped((tx) =>
        listProposals(tx, input.orgId, {
          status: "pending",
          kind: "create_txn",
          sourceRef: { entityType: "statement_line", entityId: line.id },
          limit: 1,
        }),
      );
      if (existing.length > 0) {
        result.skipped++;
        continue;
      }

      const aliasPartyId = aliasByDescriptor.get(normalizeDescriptor(line.description));
      const aliasParty =
        aliasPartyId && partyNameById.has(aliasPartyId)
          ? { id: aliasPartyId, name: partyNameById.get(aliasPartyId)! }
          : undefined;

      const response = await aiComplete<TransactionParseOutput>({
        task: "txn_prefill",
        input: {
          line: {
            date: line.transactionDate,
            description: line.description,
            amount: line.amount,
          },
          accounts: orgAccounts,
          parties: orgParties,
          bankAccount: input.bankAccount,
          aliasParty,
        },
        ctx: { orgId: input.orgId, userId: input.userId },
      });

      if (!response.ok) {
        result.degraded = true;
        result.skipped++;
        continue;
      }

      // Grounding: blank any ID the model invented. Names survive so the
      // human still sees what it meant.
      const parsed = { ...response.data };
      if (parsed.categoryId && !accountIds.has(parsed.categoryId)) parsed.categoryId = "";
      if (parsed.partyId && !partyIds.has(parsed.partyId)) parsed.partyId = "";
      parsed.lines = parsed.lines.map((l) =>
        l.categoryId && !accountIds.has(l.categoryId) ? { ...l, categoryId: "" } : l,
      );

      await scoped((tx) =>
        createProposal(tx, {
          orgId: input.orgId,
          kind: "create_txn",
          payload: {
            statementLineId: line.id,
            reconciliationId: input.reconciliationId,
            transaction: parsed as unknown as Record<string, unknown>,
          },
          invocationId: response.invocationId,
          confidence: normalizeConfidence(parsed.confidence, { scaleHint: "unit" }),
          sourceRef: { entityType: "statement_line", entityId: line.id },
          createdBy: input.userId,
        }),
      );
      result.proposalsCreated++;
    } catch (err) {
      result.skipped++;
      logger.warn("Prefill failed for statement line (non-fatal)", {
        orgId: input.orgId,
        statementLineId: line.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
