// ============================================================================
// Proposal appliers — the ONLY code that turns an approved ai_action_proposal
// into a write.
//
// Two-key model: reaching an applier already required aiTask:run (endpoint
// gate); each applier declares the UNDERLYING resource permissions the
// approving user must also hold — approval authority is the permission to do
// the thing manually. aiTask:run alone never launders a write.
// ============================================================================

import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "../../../db";
import { documents } from "../../../db/schema/documents";
import type { AiProposalKind } from "../../../db/schema/ai";
import type { Resource, Action } from "../../permissions";
import { createPartyFromEntity } from "../../entity-creation";
import {
  createPartyProposalSchema,
  createTxnProposalSchema,
  documentTypeProposalSchema,
  prefillProposalSchema,
} from "../proposal-types";
import { categoryMappingApplier, coaAccountsApplier } from "./coa";

/** Minimal context an applier needs (structural subset of OrgServerContext). */
export interface ApplierContext {
  orgId: string;
  userId: string;
  role: string;
  db: DbExecutor;
}

export type RequiredPermission = { [R in Resource]: { resource: R; action: Action<R> } }[Resource];

export interface ProposalApplier {
  /** Underlying ABAC permissions the approver must hold, given the payload. */
  requiredPermissions(payload: unknown): RequiredPermission[];
  /**
   * Validate the payload and perform the write. Returns an applied-result
   * object for the caller/UI, or null for acknowledge-only kinds.
   */
  apply(ctx: ApplierContext, payload: unknown): Promise<Record<string, unknown> | null>;
}

const createPartyApplier: ProposalApplier = {
  requiredPermissions(payload) {
    const parsed = createPartyProposalSchema.safeParse(payload);
    const isBank = parsed.success && parsed.data.entity.entityType === "bank";
    const base: RequiredPermission[] = [{ resource: "party", action: "create" }];
    if (isBank) {
      base.push(
        { resource: "account", action: "create" },
        { resource: "financialAccount", action: "create" },
      );
    }
    return base;
  },
  async apply(ctx, payload) {
    const { entity } = createPartyProposalSchema.parse(payload);
    const result = await createPartyFromEntity(ctx.db, ctx.orgId, entity);
    return { ...result };
  },
};

const documentTypeApplier: ProposalApplier = {
  requiredPermissions() {
    return [{ resource: "document", action: "upload" }];
  },
  async apply(ctx, payload) {
    const { documentId, documentType } = documentTypeProposalSchema.parse(payload);
    // Same race guard as the classify route always had: never overwrite a
    // type a human (or another flow) has already set.
    const updated = await ctx.db
      .update(documents)
      .set({ documentType })
      .where(
        and(
          eq(documents.id, documentId),
          eq(documents.organizationId, ctx.orgId),
          eq(documents.documentType, "other"),
        ),
      )
      .returning({ id: documents.id });
    return { documentId, documentType, applied: updated.length > 0 };
  },
};

const prefillApplier: ProposalApplier = {
  requiredPermissions() {
    // Acknowledge-only: the actual write flows through an existing
    // permissioned route the human drives (bill create, transaction form).
    return [];
  },
  async apply(_ctx, payload) {
    prefillProposalSchema.parse(payload);
    return null;
  },
};

const createTxnApplier: ProposalApplier = {
  requiredPermissions() {
    // Acknowledge-only, but still gated: only someone who could create the
    // journal manually may confirm the prefill as correct.
    return [{ resource: "journal", action: "create" }];
  },
  async apply(_ctx, payload) {
    const parsed = createTxnProposalSchema.parse(payload);
    // The transaction itself is written by the normal transaction route the
    // human submits — reproducing journal balancing, period-lock, and
    // numbering here would duplicate the ledger's most safety-critical code.
    // Approving records the ground-truth label for the flywheel.
    return { statementLineId: parsed.statementLineId, acknowledged: true };
  },
};

export const PROPOSAL_APPLIERS: Partial<Record<AiProposalKind, ProposalApplier>> = {
  create_party: createPartyApplier,
  document_type: documentTypeApplier,
  prefill: prefillApplier,
  create_txn: createTxnApplier,
  coa_accounts: coaAccountsApplier,
  category_mapping: categoryMappingApplier,
};
