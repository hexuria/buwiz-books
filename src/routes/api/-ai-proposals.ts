// ============================================================================
// AI Proposals — Server Functions
// List/approve/correct/reject rows of the single approval primitive.
//
// Gates: list = aiTask:view; mutations = aiTask:run. The applier then
// re-checks the UNDERLYING resource permission for the specific kind
// (two-key model) — aiTask:run alone never launders a write.
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  withPermissionOrgContext,
  withMutationPermissionOrgContext,
} from "../../lib/server-context";
import {
  listProposals,
  approveProposal,
  correctProposal,
  rejectProposal,
  expireStaleProposals,
} from "../../lib/ai/proposals";
import type { AiProposalKind, AiProposalStatus } from "../../db/schema/ai";

const listInputSchema = z.object({
  status: z
    .enum(["pending", "approved", "corrected", "rejected", "auto_applied", "expired"])
    .optional(),
  kind: z
    .enum([
      "match",
      "categorize",
      "create_txn",
      "create_party",
      "date_fix",
      "split",
      "document_type",
      "prefill",
      "coa_accounts",
      "category_mapping",
    ])
    .optional(),
  sourceRef: z.object({ entityType: z.string().min(1), entityId: z.string().min(1) }).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

const proposalIdSchema = z.object({ proposalId: z.string().uuid() });

const correctInputSchema = z.object({
  proposalId: z.string().uuid(),
  correctedPayload: z.record(z.string(), z.unknown()),
});

const rejectInputSchema = z.object({
  proposalId: z.string().uuid(),
  reason: z.string().max(2000).optional(),
});

const MUTATION_GUARD = { routeKey: "ai:proposals", limit: 60, windowMs: 60_000 };

export const listAiProposals = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof listInputSchema>) => listInputSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withPermissionOrgContext("aiTask", "view", async ({ orgId, db }) => {
      const input = listInputSchema.parse(rawData);
      // Opportunistic housekeeping until the Phase-2 worker owns expiry.
      await expireStaleProposals(db, { orgId });
      return listProposals(db, orgId, {
        status: input.status as AiProposalStatus | undefined,
        kind: input.kind as AiProposalKind | undefined,
        sourceRef: input.sourceRef,
        limit: input.limit,
      });
    }) as any;
  });

export const approveAiProposal = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof proposalIdSchema>) => proposalIdSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      MUTATION_GUARD,
      async ({ orgId, userId, role, db }) => {
        const { proposalId } = proposalIdSchema.parse(rawData);
        return approveProposal({ orgId, userId, role, db }, proposalId);
      },
    ) as any;
  });

export const correctAiProposal = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof correctInputSchema>) => correctInputSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      MUTATION_GUARD,
      async ({ orgId, userId, role, db }) => {
        const { proposalId, correctedPayload } = correctInputSchema.parse(rawData);
        return correctProposal({ orgId, userId, role, db }, proposalId, correctedPayload);
      },
    ) as any;
  });

export const rejectAiProposal = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof rejectInputSchema>) => rejectInputSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      MUTATION_GUARD,
      async ({ orgId, userId, role, db }) => {
        const { proposalId, reason } = rejectInputSchema.parse(rawData);
        return rejectProposal({ orgId, userId, role, db }, proposalId, reason);
      },
    ) as any;
  });
