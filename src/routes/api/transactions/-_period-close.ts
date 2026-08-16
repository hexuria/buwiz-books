/**
 * Transactions API — Period Close
 * Get/set the organization's closedThrough date
 */
import { createServerFn } from "@tanstack/react-start";
import { organization } from "../../../db/schema/auth";
import { and, eq, inArray, sql } from "drizzle-orm";
import { inboxItems, reviewFindings } from "../../../db/schema/inbox";
import { journalHeaders } from "../../../db/schema/journals";
import { z } from "zod";
import {
  withSessionOrgContext,
  withMutationPermissionOrgContext,
} from "../../../lib/server-context";

import { setClosedThroughSchema } from "./-_shared";

// ============================================================================
// Server Functions — Period Close
// ============================================================================

/**
 * Get the organization's closedThrough date
 */
const getClosedThroughSchema = z.object({});

export const getClosedThroughServerFn = createServerFn({ method: "GET" })
  .inputValidator((data: z.input<typeof getClosedThroughSchema>) =>
    getClosedThroughSchema.parse(data ?? {}),
  )
  .handler(async () => {
    return withSessionOrgContext(async ({ orgId, db }) => {
      const [org] = await db
        .select({ closedThrough: organization.closedThrough })
        .from(organization)
        .where(eq(organization.id, orgId))
        .limit(1);

      return { closedThrough: org?.closedThrough ?? null };
    });
  });

/**
 * Set or clear the organization's closedThrough date
 */
export const setClosedThrough = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof setClosedThroughSchema>) =>
    setClosedThroughSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "post",
      {
        routeKey: "transactions:set-closed-through",
        limit: 10,
        windowMs: 60_000,
      },
      async ({ orgId, db }) => {
        const parsed = setClosedThroughSchema.parse(rawData);
        const [current] = await db
          .select({ closedThrough: organization.closedThrough })
          .from(organization)
          .where(eq(organization.id, orgId))
          .limit(1);
        const advancingClose =
          parsed.closedThrough != null &&
          (current?.closedThrough == null || parsed.closedThrough > current.closedThrough);
        if (advancingClose) {
          const closedThrough = parsed.closedThrough!;
          const [[reviewReadiness], [inboxReadiness]] = await Promise.all([
            // Scoped on two axes, failing closed on anything it cannot date.
            //
            // 1. Blocking only. A warning is by definition non-blocking — counting warnings here
            //    contradicts the impact selector the org just set, and since approval never
            //    resolves warning findings (only rejection does), they accumulate forever and
            //    the books could never be closed at all.
            //
            // 2. In-period, by exclusion. A finding counts UNLESS it can be proved to fall after
            //    the new closedThrough. Closing March asserts March is final and says nothing
            //    about July, so a blocking finding on a July transaction must not block it.
            //    Everything that cannot be dated — transaction_candidate, source_record,
            //    processing_job, a null subjectId, an unrecognised subjectType — still counts,
            //    and is separately covered by the inboxItems half below, so this can never lose
            //    a block that exists today.
            db
              .select({ count: sql<number>`count(*)::int` })
              .from(reviewFindings)
              .leftJoin(
                journalHeaders,
                and(
                  eq(reviewFindings.subjectType, "journal_header"),
                  eq(journalHeaders.id, reviewFindings.subjectId),
                  eq(journalHeaders.organizationId, orgId),
                ),
              )
              .where(
                and(
                  eq(reviewFindings.organizationId, orgId),
                  eq(reviewFindings.state, "open"),
                  eq(reviewFindings.impact, "blocking"),
                  sql`NOT (
                    (${reviewFindings.subjectType} = 'journal_header'
                      AND ${journalHeaders.transactionDate} > ${closedThrough}::date)
                    OR (${reviewFindings.subjectType} = 'account_month'
                      AND ${reviewFindings.evidence}->>'month' > to_char(${closedThrough}::date, 'YYYY-MM'))
                  )`,
                ),
              ),
            db
              .select({ count: sql<number>`count(*)::int` })
              .from(inboxItems)
              .where(
                and(
                  eq(inboxItems.organizationId, orgId),
                  inArray(inboxItems.state, [
                    "received",
                    "processing",
                    "needs_information",
                    "ready_for_review",
                  ]),
                ),
              ),
          ]);
          const openReviews = reviewReadiness?.count ?? 0;
          const openInboxItems = inboxReadiness?.count ?? 0;
          if (openReviews > 0 || openInboxItems > 0) {
            throw new Error(
              `Close is incomplete: resolve ${openInboxItems} open Inbox item(s) and ${openReviews} blocking review finding(s) dated on or before ${closedThrough} first.`,
            );
          }
        }

        const [updated] = await db
          .update(organization)
          .set({
            closedThrough: parsed.closedThrough,
            updatedAt: new Date(),
          })
          .where(eq(organization.id, orgId))
          .returning({ closedThrough: organization.closedThrough });

        return { closedThrough: updated?.closedThrough ?? null };
      },
    );
  });
