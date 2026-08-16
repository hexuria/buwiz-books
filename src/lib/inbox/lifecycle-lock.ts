import { and, eq } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { inboxItems, transactionCandidates } from "@/db/schema/inbox";

/**
 * Locks an Inbox lifecycle in the canonical candidate -> Inbox order.
 *
 * The unlocked identity lookup is only used to discover the immutable
 * candidate relationship. Both rows are then revalidated while locked.
 * Keeping every lifecycle mutation on this order prevents approval,
 * correction, rejection, and duplicate resolution from deadlocking.
 */
export async function lockInboxCandidateLifecycle(
  db: DbExecutor,
  orgId: string,
  inboxItemId: string,
) {
  const [identity] = await db
    .select({ candidateId: inboxItems.candidateId })
    .from(inboxItems)
    .where(and(eq(inboxItems.organizationId, orgId), eq(inboxItems.id, inboxItemId)))
    .limit(1);
  if (!identity?.candidateId) return null;

  const [candidate] = await db
    .select()
    .from(transactionCandidates)
    .where(
      and(
        eq(transactionCandidates.organizationId, orgId),
        eq(transactionCandidates.id, identity.candidateId),
      ),
    )
    .for("update")
    .limit(1);
  if (!candidate) return null;

  const [item] = await db
    .select()
    .from(inboxItems)
    .where(
      and(
        eq(inboxItems.organizationId, orgId),
        eq(inboxItems.id, inboxItemId),
        eq(inboxItems.candidateId, candidate.id),
      ),
    )
    .for("update")
    .limit(1);
  if (!item) return null;

  return { item, candidate };
}
