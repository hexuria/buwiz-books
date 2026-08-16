/**
 * Party Suggestions API
 * Returns ranked party suggestions based on transaction history, category,
 * and partyable_links associations.
 */
import { createServerFn } from "@tanstack/react-start";
import { parties } from "../../db/schema/parties";
import { effectiveJournalPredicate, journalHeaders, journalLines } from "../../db/schema/journals";
import { partyableLinks } from "../../db/schema/partyable-links";
import { eq, and, sql, desc, isNotNull } from "drizzle-orm";
import { z } from "zod";
import { withSessionOrgContext } from "../../lib/server-context";
import type { PartyType } from "../../lib/party-scoping";

// ============================================================================
// Types
// ============================================================================

export interface PartySuggestion {
  id: string;
  name: string;
  partyType: PartyType;
  score: number;
  reason: "history" | "linked" | "default_account";
}

// ============================================================================
// Suggest Parties
// ============================================================================

const suggestPartiesSchema = z.object({
  categoryId: z.string().uuid().optional(),
  transactionType: z.enum(["pay_in", "pay_out", "journal", "transfer"]).optional(),
  limit: z.number().optional().default(10),
});

export const suggestParties = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof suggestPartiesSchema>) =>
    suggestPartiesSchema.parse(data ?? {}),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const { categoryId, limit } = suggestPartiesSchema.parse(rawData ?? {});

      const suggestions: PartySuggestion[] = [];
      const seenIds = new Set<string>();

      if (categoryId) {
        const linked = await db
          .select({
            id: parties.id,
            name: parties.name,
            partyType: parties.partyType,
          })
          .from(partyableLinks)
          .innerJoin(parties, eq(partyableLinks.partyId, parties.id))
          .where(
            and(
              eq(partyableLinks.organizationId, orgId),
              eq(partyableLinks.partyableType, "account"),
              eq(partyableLinks.partyableId, categoryId),
              eq(parties.isActive, true),
            ),
          )
          .limit(limit);

        for (const party of linked) {
          if (!seenIds.has(party.id)) {
            seenIds.add(party.id);
            suggestions.push({
              id: party.id,
              name: party.name,
              partyType: party.partyType,
              score: 100,
              reason: "linked",
            });
          }
        }
      }

      if (categoryId) {
        const frequentParties = await db
          .select({
            id: parties.id,
            name: parties.name,
            partyType: parties.partyType,
            count: sql<number>`count(*)::int`.as("usage_count"),
          })
          .from(journalLines)
          .innerJoin(journalHeaders, eq(journalLines.journalHeaderId, journalHeaders.id))
          .innerJoin(parties, eq(journalHeaders.partyId, parties.id))
          .where(
            and(
              eq(journalHeaders.organizationId, orgId),
              effectiveJournalPredicate(),
              eq(journalLines.accountId, categoryId),
              isNotNull(journalHeaders.partyId),
              eq(parties.isActive, true),
            ),
          )
          .groupBy(parties.id, parties.name, parties.partyType)
          .orderBy(desc(sql`count(*)`))
          .limit(limit);

        for (const party of frequentParties) {
          if (!seenIds.has(party.id)) {
            seenIds.add(party.id);
            suggestions.push({
              id: party.id,
              name: party.name,
              partyType: party.partyType,
              score: Math.min(party.count * 10, 90),
              reason: "history",
            });
          }
        }
      }

      if (categoryId) {
        const defaultParties = await db
          .select({
            id: parties.id,
            name: parties.name,
            partyType: parties.partyType,
          })
          .from(parties)
          .where(
            and(
              eq(parties.organizationId, orgId),
              eq(parties.defaultAccountId, categoryId),
              eq(parties.isActive, true),
            ),
          )
          .limit(limit);

        for (const party of defaultParties) {
          if (!seenIds.has(party.id)) {
            seenIds.add(party.id);
            suggestions.push({
              id: party.id,
              name: party.name,
              partyType: party.partyType,
              score: 80,
              reason: "default_account",
            });
          }
        }
      }

      suggestions.sort(
        (left, right) => right.score - left.score || left.name.localeCompare(right.name),
      );

      return suggestions.slice(0, limit);
    });
  });
