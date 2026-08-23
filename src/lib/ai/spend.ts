// ============================================================================
// Monthly AI spend cap.
//
// Checked ONCE per logical aiComplete call (not per hop) against
// month-to-date ai_invocations cost. A 60s per-org cache keeps the aggregate
// off the hot path; with N replicas the worst-case overshoot is one cache
// window of spend, which is the documented trade.
//
// Over-cap is a typed error, not a silent degradation: users should be told
// their budget is exhausted, and worker jobs should park rather than retry
// forever.
// ============================================================================

import { and, eq, gte, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { aiInvocations } from "../../db/schema/ai";
import { createLogger } from "../logger";

const logger = createLogger("ai.spend");

const CACHE_TTL_MS = 60_000;

export class AiSpendCapError extends Error {
  readonly spentUsd: number;
  readonly capUsd: number;
  constructor(spentUsd: number, capUsd: number) {
    super(
      `This organization's monthly AI budget is exhausted ($${spentUsd.toFixed(2)} of $${capUsd.toFixed(2)}). Raise the cap in Settings → AI to continue.`,
    );
    this.name = "AiSpendCapError";
    this.spentUsd = spentUsd;
    this.capUsd = capUsd;
  }
}

const cache = new Map<string, { at: number; spent: number }>();

export function invalidateSpendCache(orgId: string): void {
  cache.delete(orgId);
}

/** Month-to-date spend in USD (0 when nothing is priced yet). */
export async function monthToDateSpendUsd(executor: DbExecutor, orgId: string): Promise<number> {
  const cached = cache.get(orgId);
  if (cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.spent;

  try {
    const monthStart = new Date();
    monthStart.setUTCDate(1);
    monthStart.setUTCHours(0, 0, 0, 0);

    const [row] = await executor
      .select({ total: sql<string>`coalesce(sum(${aiInvocations.costUsd}), 0)` })
      .from(aiInvocations)
      .where(
        and(eq(aiInvocations.organizationId, orgId), gte(aiInvocations.createdAt, monthStart)),
      );

    const spent = Number(row?.total ?? 0);
    cache.set(orgId, { at: Date.now(), spent });
    return spent;
  } catch (err) {
    // Fail OPEN: a metering outage must not take AI features down. The cap
    // is a budget guardrail, not a security boundary.
    logger.error("Failed to compute month-to-date AI spend — allowing the call", {
      orgId: orgId.slice(0, 8),
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
}

/** Throw when the org is over its monthly cap. No cap ⇒ no check. */
export async function assertWithinSpendCap(
  executor: DbExecutor,
  orgId: string,
  capUsd: number | null,
): Promise<void> {
  if (capUsd == null || capUsd <= 0) return;
  const spent = await monthToDateSpendUsd(executor, orgId);
  if (spent >= capUsd) throw new AiSpendCapError(spent, capUsd);
}
