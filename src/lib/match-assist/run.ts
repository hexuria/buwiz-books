// ============================================================================
// Match-assist orchestration: residual unmatched lines → candidate blocks →
// one batched model call → capped, grounded suggestions.
//
// Runs ONLY over the residual set the deterministic matcher could not settle
// (AI_NATIVE_ARCHITECTURE §7), so token cost stays small and the matcher
// remains the primary authority. Everything the model returns flows through
// persistLlmMatchSuggestions — the 84-cap choke point.
// ============================================================================

import { withOrgContext, type DbExecutor } from "../../db";
import type { LedgerTransactionForMatching } from "../auto-matcher";
import { aiComplete } from "../ai/facade";
import type { MatchAssistOutput } from "../ai/schemas/match-assist";
import { buildMatchBlocks, type BlockableStatementLine } from "./blocking";
import { lookupVendorAliases } from "./aliases";
import { normalizeDescriptor } from "./normalize";
import { persistLlmMatchSuggestions } from "./persist";
import { createLogger } from "../logger";

const logger = createLogger("match-assist.run");

/** Statement lines per model call — keeps prompts bounded. */
const LINES_PER_BATCH = 20;

export interface RunMatchAssistInput {
  orgId: string;
  reconciliationId: string;
  /** Residual unmatched statement lines only. */
  statementLines: BlockableStatementLine[];
  /** Available (unmatched) ledger transactions for the period. */
  ledgerTxns: LedgerTransactionForMatching[];
  /** Party id → display name, for alias hinting. */
  partyNameById?: Map<string, string>;
}

export interface RunMatchAssistResult {
  blocksBuilt: number;
  suggestionsInserted: number;
  rejected: Array<{ statementLineId: string; reason: string }>;
  invocationIds: string[];
  /** True when the model call failed validation — run continues, no writes. */
  degraded: boolean;
}

/**
 * Generate AI match suggestions for a reconciliation's residual set.
 * Never throws on model failure: match-assist is an enhancement over the
 * deterministic matcher, so a bad model response degrades to "no extra
 * suggestions" rather than failing the pipeline.
 */
export async function runMatchAssist(input: RunMatchAssistInput): Promise<RunMatchAssistResult> {
  // Org context is this facade's OWN responsibility (P9, completing the
  // PR-12 discipline): each short query runs in its own withOrgContext
  // transaction; the model calls between them never hold a connection.
  const scoped = <R>(op: (tx: DbExecutor) => Promise<R>): Promise<R> =>
    withOrgContext(input.orgId, "system", "admin", op);
  const result: RunMatchAssistResult = {
    blocksBuilt: 0,
    suggestionsInserted: 0,
    rejected: [],
    invocationIds: [],
    degraded: false,
  };

  if (input.statementLines.length === 0 || input.ledgerTxns.length === 0) return result;

  // Alias hints: normalizedDescriptor → partyName (blocking compares names).
  const aliasPartyIds = await scoped((tx) =>
    lookupVendorAliases(
      tx,
      input.orgId,
      input.statementLines.map((l) => l.description),
    ),
  );
  const aliasPartyByDescriptor = new Map<string, string>();
  for (const [descriptor, partyId] of aliasPartyIds) {
    const name = input.partyNameById?.get(partyId);
    if (name) aliasPartyByDescriptor.set(descriptor, name);
  }

  const blocks = buildMatchBlocks(input.statementLines, input.ledgerTxns, {
    aliasPartyByDescriptor,
  });
  result.blocksBuilt = blocks.length;
  if (blocks.length === 0) return result;

  const lineById = new Map(
    input.statementLines.map((l) => [
      l.id,
      { id: l.id, amount: l.amount, description: l.description },
    ]),
  );

  for (let i = 0; i < blocks.length; i += LINES_PER_BATCH) {
    const batch = blocks.slice(i, i + LINES_PER_BATCH);

    const response = await aiComplete<MatchAssistOutput>({
      task: "match_assist",
      input: { blocks: batch },
      ctx: { orgId: input.orgId },
    });
    if (response.invocationId) result.invocationIds.push(response.invocationId);

    if (!response.ok) {
      logger.warn("Match-assist output failed validation — skipping batch", {
        orgId: input.orgId,
        reconciliationId: input.reconciliationId,
        issues: response.issues,
      });
      result.degraded = true;
      continue;
    }

    // Grounding sets: exactly the candidates this batch offered.
    const candidatesByLine = new Map(
      batch.map((block) => [
        block.statementLine.statementLineId,
        new Set(block.candidates.map((c) => c.journalLineId)),
      ]),
    );

    const persisted = await scoped((tx) =>
      persistLlmMatchSuggestions(tx, {
        orgId: input.orgId,
        reconciliationId: input.reconciliationId,
        decisions: response.data.decisions,
        statementLines: lineById,
        candidatesByLine,
      }),
    );
    result.suggestionsInserted += persisted.inserted;
    result.rejected.push(...persisted.rejected);
  }

  if (result.rejected.length > 0) {
    logger.info("Match-assist rejected some decisions", {
      orgId: input.orgId,
      reconciliationId: input.reconciliationId,
      rejectedCount: result.rejected.length,
    });
  }

  return result;
}

/** Exposed for callers that need the same normalization as alias lookup. */
export { normalizeDescriptor };
