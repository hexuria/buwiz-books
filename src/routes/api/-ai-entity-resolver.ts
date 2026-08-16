// ============================================================================
// AI Entity Resolver — Server Function (MATCH-ONLY)
//
// Takes extractedEntities from OCR and MATCHES them against existing
// parties/financial accounts. This endpoint never writes: entities that would
// need creation become ai_action_proposals (kind "create_party"), and the
// permitted human's approval — through the proposal applier, which re-checks
// party/account/financialAccount create permissions — is what materializes
// them (closes ai_findings #4/#7: no writes before review, no privilege
// escalation through an AI endpoint).
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import type { DbExecutor } from "../../db";
import { parties } from "../../db/schema/parties";
import { financialAccounts } from "../../db/schema/financial-accounts";
import { and, eq, ilike } from "drizzle-orm";
import { createLogger } from "../../lib/logger";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { escapeLikePattern } from "../../lib/sql-escape";
import { bankAccountLabel, type ExtractedEntityInput } from "../../lib/entity-creation";
import { createProposal } from "../../lib/ai/proposals";
import type { ExtractedEntity } from "./-ai-transaction-parse";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

export interface ResolvedEntity {
  /** Original entity from OCR */
  source: ExtractedEntity;
  /** Resolved party ID (existing match — this endpoint never creates) */
  partyId: string;
  /** Party name (confirmed) */
  partyName: string;
  /** Always false now — creation happens through proposal approval */
  wasCreated: boolean;
  /** For bank entities: the COA account ID, when infrastructure already exists */
  accountId?: string;
  /** For bank entities: the financial account ID, when it already exists */
  financialAccountId?: string;
}

/** An entity that needs creation — surfaced to the user as a proposal card. */
export interface EntityCreationProposal {
  proposalId: string;
  entity: ExtractedEntity;
  /** Human-readable summary for the card, e.g. `Create vendor "Staples"`. */
  summary: string;
}

export interface EntityResolutionResult {
  /** Entities matched to existing records */
  entities: ResolvedEntity[];
  /** Pending create_party proposals for unmatched entities */
  proposals: EntityCreationProposal[];
  /** Primary party ID for the transaction (first vendor/customer/employee match) */
  primaryPartyId?: string;
  /** Suggested pay category (bank account) for pay_in/pay_out pre-fill */
  suggestedPayCategoryId?: string;
  /** Display name for the suggested pay category */
  suggestedPayCategoryName?: string;
}

const logger = createLogger("api.ai-entity-resolver");

const extractedEntitySchema = z.object({
  entityType: z.enum([
    "bank",
    "employee",
    "vendor",
    "customer",
    "government",
    "shareholder",
    "lender",
  ]),
  name: z.string().min(1),
  identifier: z.string().optional().default(""),
  accountType: z.string().optional().default(""),
  matchedPartyId: z.string().optional().default(""),
});

const resolveExtractedEntitiesSchema = z.object({
  entities: z.array(extractedEntitySchema).default([]),
  /** Anchor proposals to a source document when known (UI grouping). */
  sourceDocumentId: z.string().uuid().optional(),
});

// ============================================================================
// Server Function
// ============================================================================

export const resolveExtractedEntities = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof resolveExtractedEntitiesSchema>) =>
    resolveExtractedEntitiesSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:entity-resolve", limit: 30, windowMs: 300_000 },
      async ({ orgId, userId, db }) => {
        const input = resolveExtractedEntitiesSchema.parse(rawData);

        const result: EntityResolutionResult = {
          entities: [],
          proposals: [],
          primaryPartyId: undefined,
          suggestedPayCategoryId: undefined,
          suggestedPayCategoryName: undefined,
        };

        for (const entity of input.entities) {
          try {
            const match = await matchOne(db, entity, orgId);

            if (match.status === "matched") {
              result.entities.push(match.resolved);
              if (
                !result.primaryPartyId &&
                (entity.entityType === "vendor" ||
                  entity.entityType === "customer" ||
                  entity.entityType === "employee")
              ) {
                result.primaryPartyId = match.resolved.partyId;
              }
              if (
                !result.suggestedPayCategoryId &&
                entity.entityType === "bank" &&
                match.resolved.accountId
              ) {
                result.suggestedPayCategoryId = match.resolved.accountId;
                result.suggestedPayCategoryName = bankAccountLabel(entity);
              }
              continue;
            }

            // Needs creation → pending proposal; approval (with the underlying
            // create permissions) is what writes.
            const proposal = await createProposal(db, {
              orgId,
              kind: "create_party",
              payload: { entity: match.entity },
              sourceRef: input.sourceDocumentId
                ? { entityType: "document", entityId: input.sourceDocumentId }
                : undefined,
              createdBy: userId,
            });
            result.proposals.push({
              proposalId: proposal.id,
              entity: match.entity as ExtractedEntity,
              summary:
                entity.entityType === "bank"
                  ? `Create bank account "${bankAccountLabel(entity)}"`
                  : `Create ${entity.entityType} "${entity.name}"`,
            });
          } catch (error) {
            logger.error("Failed to resolve extracted entity", {
              error,
              entityName: entity.name,
              entityType: entity.entityType,
              orgId,
            });
          }
        }

        return result;
      },
    ) as any;
  });

// ============================================================================
// Internal: match a single entity (read-only)
// ============================================================================

type MatchOutcome =
  | { status: "matched"; resolved: ResolvedEntity }
  | { status: "needs_creation"; entity: ExtractedEntityInput };

async function matchOne(
  db: DbExecutor,
  entity: ExtractedEntity,
  orgId: string,
): Promise<MatchOutcome> {
  // Step 1: explicit match from OCR
  let matchedParty: { id: string; name: string } | undefined;
  if (entity.matchedPartyId) {
    const [existing] = await db
      .select({ id: parties.id, name: parties.name })
      .from(parties)
      .where(and(eq(parties.id, entity.matchedPartyId), eq(parties.organizationId, orgId)))
      .limit(1);
    matchedParty = existing;
  }

  // Step 2: fuzzy-match by name (case-insensitive)
  if (!matchedParty) {
    const [existingByName] = await db
      .select({ id: parties.id, name: parties.name })
      .from(parties)
      .where(
        and(ilike(parties.name, escapeLikePattern(entity.name)), eq(parties.organizationId, orgId)),
      )
      .limit(1);
    matchedParty = existingByName;
  }

  if (!matchedParty) {
    return { status: "needs_creation", entity };
  }

  if (entity.entityType !== "bank") {
    return {
      status: "matched",
      resolved: {
        source: entity,
        partyId: matchedParty.id,
        partyName: matchedParty.name,
        wasCreated: false,
      },
    };
  }

  // Bank entity: matched only when its financial infrastructure also exists —
  // otherwise the missing COA/financial account still needs creation, which
  // goes through the proposal (the applier reuses the matched party).
  const accountLabel = bankAccountLabel(entity);
  const [existingFA] = await db
    .select({
      id: financialAccounts.id,
      ledgerAccountId: financialAccounts.ledgerAccountId,
    })
    .from(financialAccounts)
    .where(
      and(
        ilike(financialAccounts.accountName, escapeLikePattern(accountLabel)),
        eq(financialAccounts.organizationId, orgId),
      ),
    )
    .limit(1);

  if (!existingFA) {
    return {
      status: "needs_creation",
      entity: { ...entity, matchedPartyId: matchedParty.id },
    };
  }

  return {
    status: "matched",
    resolved: {
      source: entity,
      partyId: matchedParty.id,
      partyName: matchedParty.name,
      wasCreated: false,
      accountId: existingFA.ledgerAccountId ?? undefined,
      financialAccountId: existingFA.id,
    },
  };
}
