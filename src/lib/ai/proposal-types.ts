// ============================================================================
// Typed proposal payloads — the Zod discriminated contract for
// ai_action_proposals.proposal. Validated on create AND re-validated by the
// applier before any write (payloads are data at rest between the two).
//
// Kinds land phase by phase: create_party / document_type / prefill ship in
// Phase 1; match / split / create_txn / categorize / date_fix get payloads
// and appliers with the reconciliation work (Phases 2–3).
// ============================================================================

import { z } from "zod";
import type { AiProposalKind } from "../../db/schema/ai";
import { ACCOUNT_TYPES } from "../../db/schema/account-constants";
import { MAPPING_TYPES } from "../coa/mapping-types";
import { MAX_ACCOUNT_NAME_CHARS, MAX_DRAFT_ACCOUNTS } from "../coa/validate-draft";

/** Mirrors ExtractedEntityInput in src/lib/entity-creation.ts. */
export const extractedEntityPayloadSchema = z.object({
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
  identifier: z.string().default(""),
  accountType: z.string().default(""),
  matchedPartyId: z.string().default(""),
});

export const createPartyProposalSchema = z.object({
  entity: extractedEntityPayloadSchema,
});
export type CreatePartyProposal = z.infer<typeof createPartyProposalSchema>;

export const documentTypeProposalSchema = z.object({
  documentId: z.string().uuid(),
  documentType: z.enum([
    "statement",
    "bill",
    "invoice",
    "receipt",
    "payslip",
    "contract",
    "tax_form",
  ]),
  /** 0–1 */
  confidence: z.number().min(0).max(1),
  reasoning: z.string().optional(),
});
export type DocumentTypeProposal = z.infer<typeof documentTypeProposalSchema>;

/**
 * Acknowledge-only kind: the AI pre-filled something a human then submits
 * through an existing permissioned route (bill preview, transaction form).
 * The proposal exists for review provenance + feedback capture; approving it
 * writes nothing — the human-driven route is the write path.
 */
export const prefillProposalSchema = z.object({
  target: z.enum(["bill", "transaction"]),
  /** Snapshot of what was pre-filled, for feedback/eval curation. */
  summary: z.record(z.string(), z.unknown()),
});
export type PrefillProposal = z.infer<typeof prefillProposalSchema>;

/**
 * A transaction pre-filled from an unmatched statement line.
 *
 * Acknowledge-only, like `prefill`: approving/correcting captures the
 * ground-truth label, but the WRITE still happens through the normal
 * permissioned transaction route the human submits. Reproducing journal
 * balancing, period-lock, and numbering inside an applier would duplicate
 * the ledger's most safety-critical code for no user-visible gain.
 */
export const createTxnProposalSchema = z.object({
  statementLineId: z.string().uuid(),
  reconciliationId: z.string().uuid(),
  /** The prefilled ParsedTransactionResult-shaped payload (IDs grounded). */
  transaction: z.record(z.string(), z.unknown()),
});
export type CreateTxnProposal = z.infer<typeof createTxnProposalSchema>;

// ============================================================================
// Chart-of-accounts scaffolding
// ============================================================================

const draftAdjustmentSchema = z.object({
  code: z.string(),
  message: z.string(),
});

const draftRejectionSchema = z.object({
  key: z.string().default(""),
  name: z.string().default(""),
  code: z.string(),
  message: z.string(),
});

/**
 * One drafted account.
 *
 * `isSystem` is UNREPRESENTABLE, not merely unset: a plain `z.object` strips
 * unknown keys, so a payload carrying one loses it on parse, and the applier
 * hard-codes `false` when it synthesizes the preset. Only preset roots are
 * system accounts, and a system account cannot be deleted.
 *
 * `accountNumber` is a PREVIEW. The applier re-runs validation against live
 * state and re-allocates, because a number free when the proposal was written
 * may be taken by the time it is approved.
 */
export const draftedAccountPayloadSchema = z.object({
  key: z.string().min(1),
  name: z.string().min(1).max(MAX_ACCOUNT_NAME_CHARS),
  accountType: z.enum(ACCOUNT_TYPES),
  subtype: z.string().min(1),
  description: z.string().default(""),
  accountNumber: z.string().default(""),
  /** Existing parent account; null exactly when parentDraftKey is set. */
  parentAccountId: z.string().uuid().nullable().default(null),
  parentDraftKey: z.string().default(""),
  adjustments: z.array(draftAdjustmentSchema).default([]),
});

/**
 * The batch of accounts one scaffold run proposes.
 *
 * A reviewer never edits the `accounts` array. Exclusions and edits are
 * recorded SEPARATELY, because `fieldDiff` is a top-level key diff: mutating
 * the array in place would record the correction as one 60-object-versus-47-
 * object blob, which is useless as an eval label. `excludedKeys` and
 * `overrides` diff into something a human — and a grader — can read.
 */
export const coaAccountsProposalSchema = z.object({
  accounts: z.array(draftedAccountPayloadSchema).max(MAX_DRAFT_ACCOUNTS),
  /** Keys the reviewer unchecked. */
  excludedKeys: z.array(z.string()).default([]),
  /** Per-account reviewer edits. */
  overrides: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string().min(1).max(MAX_ACCOUNT_NAME_CHARS).optional(),
        subtype: z.string().min(1).optional(),
        parentAccountId: z.string().uuid().nullable().optional(),
      }),
    )
    .default([]),
  /** What the validator threw away, kept so a reviewer can see it happened. */
  rejected: z.array(draftRejectionSchema).default([]),
  /** True when the model returned more accounts than the cap allows. */
  truncated: z.boolean().default(false),
  notes: z.string().default(""),
});
export type CoaAccountsProposal = z.infer<typeof coaAccountsProposalSchema>;

/**
 * Re-pointing posting defaults.
 *
 * Targets are stored as account IDs rather than the run's ephemeral "E0".."En"
 * keys: the payload outlives the run. Every assignment is re-checked against
 * `isMappingTargetCompatible` in the applier, so a stale or hostile row is
 * inert rather than fatal.
 */
export const categoryMappingProposalSchema = z.object({
  assignments: z.array(
    z.object({
      mappingType: z.enum(MAPPING_TYPES),
      sourceKey: z.string().min(1),
      targetAccountId: z.string().uuid(),
      targetName: z.string().default(""),
      targetAccountType: z.string().default(""),
      label: z.string().default(""),
      reason: z.string().default(""),
    }),
  ),
  /** `${mappingType}:${sourceKey}` entries the reviewer unchecked. */
  excludedKeys: z.array(z.string()).default([]),
  rejected: z
    .array(z.object({ key: z.string().default(""), code: z.string(), message: z.string() }))
    .default([]),
  notes: z.string().default(""),
});
export type CategoryMappingProposal = z.infer<typeof categoryMappingProposalSchema>;

/**
 * Match / split / date_fix live in reconciliation_suggestions, not here:
 * they are produced by the matcher + match-assist and reviewed in the
 * reconciliation UI, where the 84-confidence cap and apply semantics already
 * exist (src/lib/match-assist/persist.ts). Routing them through proposals
 * too would create two competing review surfaces for the same decision.
 */
const handledElsewhere = (kind: string, where: string) =>
  z.never({ error: `Proposal kind "${kind}" is handled by ${where}, not ai_action_proposals` });

export const proposalPayloadSchemas: Record<AiProposalKind, z.ZodType> = {
  create_party: createPartyProposalSchema,
  document_type: documentTypeProposalSchema,
  prefill: prefillProposalSchema,
  create_txn: createTxnProposalSchema,
  coa_accounts: coaAccountsProposalSchema,
  category_mapping: categoryMappingProposalSchema,
  match: handledElsewhere("match", "reconciliation_suggestions"),
  split: handledElsewhere("split", "reconciliation_suggestions"),
  date_fix: handledElsewhere("date_fix", "reconciliation_suggestions"),
  categorize: z.never({ error: 'Proposal kind "categorize" is not implemented yet' }),
};
