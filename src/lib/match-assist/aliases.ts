// ============================================================================
// Vendor alias memory — per-org descriptor → party mapping, learned from
// accepted matches and consumed by candidate blocking.
//
// Population is a side effect of humans accepting matches (or approving AI
// suggestions), so the memory reflects real decisions rather than model
// guesses. Lookup is exact on the normalized descriptor; the pgvector
// embedding column (added only where the extension exists) is reserved for
// the fuzzy path and is deliberately not required by this code.
// ============================================================================

import { and, eq, inArray } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { vendorAliases } from "../../db/schema/ai";
import { normalizeDescriptor } from "./normalize";

export type AliasSource = "user_match" | "llm_suggestion_accepted";

/**
 * Record that a statement descriptor belongs to a party. Idempotent: the
 * unique (org, normalized_descriptor) index converges repeat learnings; a
 * later human decision overwrites an earlier one.
 */
export async function upsertVendorAlias(
  db: DbExecutor,
  input: { orgId: string; descriptor: string; partyId: string; source: AliasSource },
): Promise<void> {
  const normalized = normalizeDescriptor(input.descriptor);
  if (!normalized) return;

  await db
    .insert(vendorAliases)
    .values({
      organizationId: input.orgId,
      normalizedDescriptor: normalized,
      partyId: input.partyId,
      source: input.source,
    })
    .onConflictDoUpdate({
      target: [vendorAliases.organizationId, vendorAliases.normalizedDescriptor],
      set: { partyId: input.partyId, source: input.source },
    });
}

/**
 * Look up aliases for a batch of raw descriptors.
 * Returns normalizedDescriptor → partyId for those that are known.
 */
export async function lookupVendorAliases(
  db: DbExecutor,
  orgId: string,
  descriptors: string[],
): Promise<Map<string, string>> {
  const normalized = [...new Set(descriptors.map(normalizeDescriptor).filter(Boolean))];
  if (normalized.length === 0) return new Map();

  const rows = await db
    .select({
      normalizedDescriptor: vendorAliases.normalizedDescriptor,
      partyId: vendorAliases.partyId,
    })
    .from(vendorAliases)
    .where(
      and(
        eq(vendorAliases.organizationId, orgId),
        inArray(vendorAliases.normalizedDescriptor, normalized),
      ),
    );

  return new Map(rows.map((r) => [r.normalizedDescriptor, r.partyId]));
}
