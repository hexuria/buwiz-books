// ============================================================================
// AI Entity Resolver — Server Function (MATCH-ONLY)
//
// Takes extractedEntities from OCR and MATCHES them against existing
// parties/financial accounts. This endpoint never writes to master data:
// entities that would need creation become ai_action_proposals (kind
// "create_party"), and the permitted human's approval — through the proposal
// applier, which re-checks party/account/financialAccount create permissions —
// is what materializes them (closes ai_findings #4/#7: no writes before
// review, no privilege escalation through an AI endpoint).
//
// Matching is the shared entity pipeline (src/lib/party-match, inbox v2 §5):
//   1. exact, strongest first: tax id → email → vendor alias → case-insensitive
//      name, only among active parties of a type the entity can be;
//   2. pg_trgm look-alikes (top five), plus the party OCR suggested, if any;
//   3. match_party picks one of them or says "new" (closed enum; Jev first
//      for opted-in orgs), applied only at or above the org's low-confidence
//      threshold;
//   4. anything not matched becomes a create_party proposal draft carrying
//      name, type, tax id, and email.
// A matched payee whose stored bank details differ from ones the caller
// passes is flagged (`paymentDetailsChanged`) — never written.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import type { DbExecutor } from "../../db";
import { financialAccounts } from "../../db/schema/financial-accounts";
import { and, eq, ilike } from "drizzle-orm";
import { createLogger } from "../../lib/logger";
import { assertRolePermission } from "../../lib/auth-middleware";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { escapeLikePattern } from "../../lib/sql-escape";
import { bankAccountLabel, type ExtractedEntityInput } from "../../lib/entity-creation";
import { createProposal } from "../../lib/ai/proposals";
import { aiComplete } from "../../lib/ai/facade";
import { loadLowConfidenceThreshold } from "../../lib/inbox/low-confidence-threshold";
import { pickPartyWithModel } from "../../lib/party-match/model-pick";
import {
  detectPaymentDetailsChange,
  extractEmailAddress,
  normalizeTaxId,
} from "../../lib/party-match/normalize";
import {
  matchParty,
  type ExactTier,
  type PartyMatchOutcome,
  type PartyMatchQuery,
} from "../../lib/party-match/pipeline";
import { loadPartyPaymentDetails, partyLookups } from "../../lib/party-match/queries";
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
  /** How the party was matched: an exact tier, or the model among look-alikes. */
  matchedBy: ExactTier | "model";
  /** 0..1, for model matches only. */
  matchConfidence?: number;
  /**
   * The caller passed bank details that differ from the party's stored ones.
   * Informational here — nothing is written — and blocking in the Inbox.
   */
  paymentDetailsChanged?: boolean;
}

/** An entity that needs creation — surfaced to the user as a proposal card. */
export interface EntityCreationProposal {
  proposalId: string;
  entity: ExtractedEntity;
  /** Human-readable summary for the card, e.g. `Create vendor "Staples"`. */
  summary: string;
  /** Existing look-alikes the matcher considered, most similar first. */
  lookalikes?: Array<{ partyId: string; name: string }>;
  /** The model's below-threshold pick among them, if it made one. */
  suggestedPartyId?: string;
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
  /** Entities that FAILED to resolve — surfaced, never silently dropped (P8). */
  errors: Array<{ entityName: string; entityType: string; message: string }>;
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
  /** Printed tax id, when the caller extracted one. */
  taxId: z.string().max(50).optional().default(""),
  /** Printed or sender email address. */
  email: z.string().max(255).optional().default(""),
  /** Payee bank details printed on the document, for the change check only. */
  bankAccountNumber: z.string().max(64).optional().default(""),
  bankRoutingNumber: z.string().max(64).optional().default(""),
});

type ResolverEntity = z.infer<typeof extractedEntitySchema>;

const resolveExtractedEntitiesSchema = z.object({
  entities: z.array(extractedEntitySchema).default([]),
  /** Anchor proposals to a source document when known (UI grouping). */
  sourceDocumentId: z.string().uuid().optional(),
});

/** Roles whose changed bank details are the invoice-fraud path. */
const PAYEE_ENTITY_TYPES = new Set(["vendor", "employee"]);
/** Roles whose `identifier` may be a tax id (it is a last-4 for banks). */
const TAX_ID_ENTITY_TYPES = new Set(["vendor", "customer", "government", "lender"]);

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
      async ({ orgId, userId, role, db }) => {
        // Two-key: aiTask:run got the caller in the door, but this handler
        // manufactures create_party proposal cards — the caller must also
        // hold the underlying permission the applier will demand, or they
        // could stack proposals they can never legally apply.
        assertRolePermission(role, "party", "create");
        const input = resolveExtractedEntitiesSchema.parse(rawData);
        const minConfidence = await loadLowConfidenceThreshold(db, orgId);

        const result: EntityResolutionResult = {
          entities: [],
          proposals: [],
          primaryPartyId: undefined,
          suggestedPayCategoryId: undefined,
          suggestedPayCategoryName: undefined,
          errors: [],
        };

        for (const entity of input.entities) {
          try {
            const match = await matchOne(db, entity, { orgId, userId, minConfidence });

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
              entity: toExtractedEntity(entity),
              summary:
                entity.entityType === "bank"
                  ? `Create bank account "${bankAccountLabel(entity)}"`
                  : `Create ${entity.entityType} "${entity.name}"`,
              ...(match.lookalikes.length > 0 ? { lookalikes: match.lookalikes } : {}),
              ...(match.suggestedPartyId ? { suggestedPartyId: match.suggestedPartyId } : {}),
            });
          } catch (error) {
            logger.error("Failed to resolve extracted entity", {
              error,
              entityName: entity.name,
              entityType: entity.entityType,
              orgId,
            });
            // A vanished entity read as "the model found nothing" — the
            // caller now sees exactly which entity failed and why (P8).
            result.errors.push({
              entityName: entity.name,
              entityType: entity.entityType,
              message: error instanceof Error ? error.message : String(error),
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
  | {
      status: "needs_creation";
      entity: ExtractedEntityInput;
      lookalikes: Array<{ partyId: string; name: string }>;
      suggestedPartyId?: string;
    };

function toExtractedEntity(entity: ResolverEntity): ExtractedEntity {
  return {
    entityType: entity.entityType,
    name: entity.name,
    identifier: entity.identifier,
    accountType: entity.accountType,
    matchedPartyId: entity.matchedPartyId,
  };
}

/** The explicit tax id, else an unmasked identifier that normalizes to one. */
function taxIdFor(entity: ResolverEntity): string | null {
  if (normalizeTaxId(entity.taxId)) return entity.taxId.trim();
  if (!TAX_ID_ENTITY_TYPES.has(entity.entityType)) return null;
  if (/[*•]|[xX]{2,}/u.test(entity.identifier)) return null;
  return normalizeTaxId(entity.identifier) ? entity.identifier.trim() : null;
}

function creationDraft(
  entity: ResolverEntity,
  query: PartyMatchQuery,
  matchedPartyId = "",
): ExtractedEntityInput {
  return {
    ...toExtractedEntity(entity),
    matchedPartyId,
    taxId: query.taxId?.slice(0, 50) ?? "",
    email: extractEmailAddress(entity.email)?.slice(0, 255) ?? "",
  };
}

async function matchOne(
  db: DbExecutor,
  entity: ResolverEntity,
  options: { orgId: string; userId: string; minConfidence: number },
): Promise<MatchOutcome> {
  const { orgId } = options;
  const query: PartyMatchQuery = {
    name: entity.name,
    entityType: entity.entityType,
    taxId: taxIdFor(entity),
    emails: entity.email ? [entity.email] : [],
    hintPartyId: entity.matchedPartyId || null,
  };
  const outcome: PartyMatchOutcome = await matchParty(
    query,
    {
      ...partyLookups(db, orgId),
      pick: (pickQuery, candidates) =>
        pickPartyWithModel(pickQuery, candidates, {
          orgId,
          userId: options.userId,
          complete: aiComplete,
        }),
    },
    { minConfidence: options.minConfidence },
  );

  if (outcome.kind !== "exact" && outcome.kind !== "model") {
    return {
      status: "needs_creation",
      entity: creationDraft(entity, query),
      lookalikes: outcome.candidates.map((candidate) => ({
        partyId: candidate.id,
        name: candidate.name,
      })),
      ...(outcome.kind === "unresolved" && outcome.suggestion
        ? { suggestedPartyId: outcome.suggestion.id }
        : {}),
    };
  }

  const matchedParty = outcome.party;
  const matchedBy = outcome.kind === "exact" ? outcome.tier : ("model" as const);
  const matchConfidence = outcome.kind === "model" ? outcome.confidence : undefined;
  const paymentDetailsChanged =
    PAYEE_ENTITY_TYPES.has(entity.entityType) &&
    Boolean(entity.bankAccountNumber || entity.bankRoutingNumber)
      ? await hasChangedPaymentDetails(db, orgId, matchedParty.id, entity)
      : undefined;

  if (entity.entityType !== "bank") {
    return {
      status: "matched",
      resolved: {
        source: toExtractedEntity(entity),
        partyId: matchedParty.id,
        partyName: matchedParty.name,
        wasCreated: false,
        matchedBy,
        ...(matchConfidence !== undefined ? { matchConfidence } : {}),
        ...(paymentDetailsChanged !== undefined ? { paymentDetailsChanged } : {}),
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
      entity: creationDraft(entity, query, matchedParty.id),
      lookalikes: [],
    };
  }

  return {
    status: "matched",
    resolved: {
      source: toExtractedEntity(entity),
      partyId: matchedParty.id,
      partyName: matchedParty.name,
      wasCreated: false,
      accountId: existingFA.ledgerAccountId ?? undefined,
      financialAccountId: existingFA.id,
      matchedBy,
      ...(matchConfidence !== undefined ? { matchConfidence } : {}),
    },
  };
}

async function hasChangedPaymentDetails(
  db: DbExecutor,
  orgId: string,
  partyId: string,
  entity: ResolverEntity,
): Promise<boolean> {
  const party = await loadPartyPaymentDetails(db, orgId, partyId);
  if (!party) return false;
  return (
    detectPaymentDetailsChange(party, {
      accountNumber: entity.bankAccountNumber || null,
      routingNumber: entity.bankRoutingNumber || null,
    }) !== null
  );
}
