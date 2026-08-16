// ============================================================================
// Alias learning — turn a confirmed statement-line ↔ ledger-line match into
// vendor-alias memory.
//
// Only HUMAN-confirmed matches teach the memory (accepting a suggestion,
// matching manually, or approving an AI suggestion). The model's own guesses
// never write here, so the memory stays a record of decisions rather than of
// predictions.
//
// Best-effort by construction: a learning failure must never fail the match
// the user just made.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { statementLines } from "../../db/schema/reconciliations";
import { journalHeaders, journalLines } from "../../db/schema/journals";
import { upsertVendorAlias, type AliasSource } from "./aliases";
import { createLogger } from "../logger";

const logger = createLogger("match-assist.learn");

/**
 * Learn the descriptor → party mapping implied by a confirmed match.
 * No-ops silently when either side lacks the data (no party on the journal,
 * no descriptor on the line).
 */
export async function learnAliasFromMatch(
  db: DbExecutor,
  input: {
    orgId: string;
    statementLineId: string;
    journalLineId: string;
    source: AliasSource;
  },
): Promise<void> {
  try {
    const [line] = await db
      .select({ description: statementLines.description })
      .from(statementLines)
      .where(eq(statementLines.id, input.statementLineId))
      .limit(1);
    if (!line?.description) return;

    // Line-level party wins (it is the more specific attribution); the
    // header party is the fallback for single-party transactions.
    const [journal] = await db
      .select({
        linePartyId: journalLines.partyId,
        headerPartyId: journalHeaders.partyId,
      })
      .from(journalLines)
      .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
      .where(
        and(
          eq(journalLines.id, input.journalLineId),
          eq(journalHeaders.organizationId, input.orgId),
        ),
      )
      .limit(1);
    const partyId = journal?.linePartyId ?? journal?.headerPartyId;
    if (!partyId) return;

    await upsertVendorAlias(db, {
      orgId: input.orgId,
      descriptor: line.description,
      partyId,
      source: input.source,
    });
  } catch (err) {
    logger.warn("Alias learning failed (non-fatal)", {
      orgId: input.orgId,
      statementLineId: input.statementLineId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
