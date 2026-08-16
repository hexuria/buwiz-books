// ============================================================================
// Entity creation — shared by the create_party proposal applier (Phase 1
// confirm-first flow) and any trusted server path that materializes an
// OCR-extracted entity into master data.
//
// Extracted from -ai-entity-resolver.ts, which is now MATCH-ONLY: the
// resolver never writes; unmatched entities become ai_action_proposals and
// creation happens here when a permitted human approves.
//
// Reuse-or-create semantics throughout, so approving the same proposal twice
// (or two proposals naming the same entity) converges instead of duplicating.
// ============================================================================

import { and, eq, ilike } from "drizzle-orm";
import type { DbExecutor } from "../db";
import { parties } from "../db/schema/parties";
import { accounts } from "../db/schema/accounts";
import { financialAccounts } from "../db/schema/financial-accounts";
import { escapeLikePattern } from "./sql-escape";
import { createLogger } from "./logger";

const logger = createLogger("lib.entity-creation");

export type EntityKind =
  | "bank"
  | "employee"
  | "vendor"
  | "customer"
  | "government"
  | "shareholder"
  | "lender";

/** OCR-extracted entity (structurally matches ExtractedEntity from the parse routes). */
export interface ExtractedEntityInput {
  entityType: EntityKind;
  name: string;
  /** e.g. account last-4 "****4521", employee ID. Empty string if none. */
  identifier: string;
  /** For bank entities: "checking" | "savings" | "credit_card" | …. Empty for others. */
  accountType: string;
  /** Party ID when OCR already matched an existing party. Empty string if new. */
  matchedPartyId: string;
}

export interface CreatedEntityResult {
  partyId: string;
  partyName: string;
  wasCreated: boolean;
  /** For bank entities: the COA account ID */
  accountId?: string;
  /** For bank entities: the financial account ID */
  financialAccountId?: string;
  /** True when a bank entity could not get infrastructure (missing parent COA account). */
  bankInfrastructureSkipped?: boolean;
}

type FinancialAccountType =
  | "checking"
  | "savings"
  | "credit_card"
  | "money_market"
  | "investment"
  | "other";

/**
 * Materialize an extracted entity: reuse the matching party if one exists,
 * otherwise create it; for bank entities also ensure the COA account +
 * financial account infrastructure.
 *
 * Callers own authorization — this function assumes the caller has verified
 * party:create (and account:create + financialAccount:create for banks).
 */
export async function createPartyFromEntity(
  db: DbExecutor,
  orgId: string,
  entity: ExtractedEntityInput,
): Promise<CreatedEntityResult> {
  // Reuse: explicit match from OCR
  if (entity.matchedPartyId) {
    const [existing] = await db
      .select({ id: parties.id, name: parties.name })
      .from(parties)
      .where(and(eq(parties.id, entity.matchedPartyId), eq(parties.organizationId, orgId)))
      .limit(1);
    if (existing) {
      const bankIds =
        entity.entityType === "bank" ? await ensureBankInfrastructure(db, orgId, entity) : {};
      return { partyId: existing.id, partyName: existing.name, wasCreated: false, ...bankIds };
    }
  }

  // Reuse: case-insensitive name match
  const [existingByName] = await db
    .select({ id: parties.id, name: parties.name })
    .from(parties)
    .where(
      and(ilike(parties.name, escapeLikePattern(entity.name)), eq(parties.organizationId, orgId)),
    )
    .limit(1);
  if (existingByName) {
    const bankIds =
      entity.entityType === "bank" ? await ensureBankInfrastructure(db, orgId, entity) : {};
    return {
      partyId: existingByName.id,
      partyName: existingByName.name,
      wasCreated: false,
      ...bankIds,
    };
  }

  // Create
  const [newParty] = await db
    .insert(parties)
    .values({
      organizationId: orgId,
      name: entity.name,
      partyType: entity.entityType,
    })
    .returning({ id: parties.id, name: parties.name });

  const bankIds =
    entity.entityType === "bank" ? await ensureBankInfrastructure(db, orgId, entity) : {};

  return { partyId: newParty.id, partyName: newParty.name, wasCreated: true, ...bankIds };
}

/** Build the display label for a bank entity's accounts: "Chase Checking ****4521". */
export function bankAccountLabel(entity: ExtractedEntityInput): string {
  const isCredit = entity.accountType === "credit_card";
  const lastFour = entity.identifier?.replace(/[^0-9]/g, "").slice(-4) || undefined;
  const kind = isCredit ? "Credit Card" : capitalize(entity.accountType || "Checking");
  return lastFour ? `${entity.name} ${kind} ****${lastFour}` : `${entity.name} ${kind}`;
}

/**
 * Ensure the COA account + financial account exist for a bank entity.
 * Reuses an existing financial account with the same label; otherwise creates
 * the COA child under Assets>Bank Accounts / Liabilities>Credit Cards plus the
 * linked financial account.
 */
export async function ensureBankInfrastructure(
  db: DbExecutor,
  orgId: string,
  entity: ExtractedEntityInput,
): Promise<{
  accountId?: string;
  financialAccountId?: string;
  bankInfrastructureSkipped?: boolean;
}> {
  const isCredit = entity.accountType === "credit_card";
  const lastFour = entity.identifier?.replace(/[^0-9]/g, "").slice(-4) || undefined;
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

  if (existingFA) {
    return {
      accountId: existingFA.ledgerAccountId ?? undefined,
      financialAccountId: existingFA.id,
    };
  }

  // Find the parent COA account: Assets > Bank Accounts or Liabilities > Credit Cards
  const parentSubtype = isCredit ? "credit_cards" : "bank_accounts";
  const parentAccountType = isCredit ? "liability" : "asset";

  const [parentAccount] = await db
    .select({ id: accounts.id })
    .from(accounts)
    .where(
      and(
        eq(accounts.organizationId, orgId),
        eq(accounts.accountType, parentAccountType),
        eq(accounts.subtype, parentSubtype),
        eq(accounts.isActive, true),
      ),
    )
    .limit(1);

  if (!parentAccount) {
    logger.warn("Missing parent account for bank infrastructure creation", {
      orgId,
      parentSubtype,
      parentAccountType,
    });
    return { bankInfrastructureSkipped: true };
  }

  const [newAccount] = await db
    .insert(accounts)
    .values({
      organizationId: orgId,
      name: accountLabel,
      accountType: parentAccountType,
      subtype: parentSubtype,
      parentId: parentAccount.id,
      icon: isCredit ? "CreditCard" : "Landmark",
    })
    .returning({ id: accounts.id });

  const faType = isCredit ? "credit_card" : normalizeFinancialAccountType(entity.accountType);
  const [newFA] = await db
    .insert(financialAccounts)
    .values({
      organizationId: orgId,
      accountName: accountLabel,
      institutionName: entity.name,
      accountType: faType,
      lastFour: lastFour ?? null,
      ledgerAccountId: newAccount.id,
      isManual: true,
      connectionStatus: "pending",
    })
    .returning({ id: financialAccounts.id });

  return {
    accountId: newAccount.id,
    financialAccountId: newFA.id,
  };
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function normalizeFinancialAccountType(accountType: string | undefined): FinancialAccountType {
  switch (accountType) {
    case "checking":
    case "savings":
    case "credit_card":
    case "money_market":
    case "investment":
    case "other":
      return accountType;
    default:
      return "checking";
  }
}
