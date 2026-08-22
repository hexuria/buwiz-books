/**
 * Transactions API — Batch Operations
 * Batch update, batch delete
 */
import { createServerFn } from "@tanstack/react-start";
import { insertActivityLog } from "@/lib/insert-activity-log";
import { journalHeaders, journalLines } from "../../../db/schema/journals";
import { journalDuplicateMerges } from "../../../db/schema/match-history";
import { statementLines, reconciliations } from "../../../db/schema/reconciliations";
import { accounts } from "../../../db/schema/accounts";
import { parties } from "../../../db/schema/parties";
import { dimensions } from "../../../db/schema/dimensions";
import { eq, desc, asc, and, inArray, or } from "drizzle-orm";
import { z } from "zod";
import { withMutationPermissionOrgContext } from "../../../lib/server-context";
import { getClosedThrough, isDateLocked } from "../../../lib/period-close";
import {
  updateTransactionsBatchSchema,
  deleteTransactionsBatchSchema,
} from "../../../db/validation/batch-actions";

import { resolvePartyName } from "./-_shared";

// ============================================================================
// Server Functions — Batch
// ============================================================================

/**
 * Batch update transactions
 * Handles party, memo, account (move to), department, location
 */
export const updateTransactionsBatch = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof updateTransactionsBatchSchema>) =>
    updateTransactionsBatchSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "update",
      { routeKey: "transactions:update-batch", limit: 20, windowMs: 60_000 },
      async ({ orgId, userId, db }) => {
        const parsed = updateTransactionsBatchSchema.parse(rawData);
        const { ids, updates, lineAccountId, transactionType } = parsed;

        if (ids.length === 0) return { count: 0 };

        // Period-lock guard: don't recategorize/modify transactions in a closed period.
        const lockRows = await db
          .select({
            id: journalHeaders.id,
            transactionDate: journalHeaders.transactionDate,
            duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId,
            status: journalHeaders.status,
          })
          .from(journalHeaders)
          .where(and(inArray(journalHeaders.id, ids), eq(journalHeaders.organizationId, orgId)))
          .orderBy(asc(journalHeaders.id))
          .for("update");
        const validIds = lockRows.map((row) => row.id);
        if (validIds.length !== new Set(ids).size) {
          throw new Error("One or more transactions were not found in this organization");
        }
        if (lockRows.some((row) => row.duplicateOfHeaderId !== null)) {
          throw new Error(
            "Suppressed duplicate transactions cannot be modified. Unmatch them first.",
          );
        }

        // Re-pointing `account_id` on a POSTED line moves the amount to a
        // different GL account after the fact — the ledger silently disagrees
        // with anything already filed off it, and only an activity-log row
        // records that it happened. Dimension re-tagging (department/location)
        // moves no money and stays allowed. Trigger 0039 enforces this
        // underneath; this is the message that names the batch.
        if (updates.accountId !== undefined) {
          const posted = lockRows.filter((h) => h.status === "posted");
          if (posted.length > 0) {
            throw new Error(
              `Cannot recategorize ${posted.length} posted transaction(s): a posted entry's account ` +
                `cannot be changed in place. Reverse and replace them instead.`,
            );
          }
        }

        const closedThroughForUpdate = await getClosedThrough(orgId, db);
        if (lockRows.some((h) => isDateLocked(h.transactionDate, closedThroughForUpdate))) {
          throw new Error(
            `Cannot modify: one or more transactions fall in a period locked through ${closedThroughForUpdate}. Open the period first.`,
          );
        }

        // ── Snapshot old values for activity log (before any mutations) ────
        const oldHeaders =
          updates.partyId !== undefined
            ? await db
                .select({
                  id: journalHeaders.id,
                  partyId: journalHeaders.partyId,
                  partyName: parties.name,
                })
                .from(journalHeaders)
                .leftJoin(parties, eq(journalHeaders.partyId, parties.id))
                .where(
                  and(
                    inArray(journalHeaders.id, validIds),
                    eq(journalHeaders.organizationId, orgId),
                  ),
                )
            : null;

        // Snapshot old line dimensions for dept/loc/category changes
        type OldLine = {
          headerId: string;
          departmentId: string | null;
          departmentName: string | null;
          locationId: string | null;
          locationName: string | null;
          accountId: string;
          accountName: string;
          subtype: string | null;
        };
        let oldLines: OldLine[] | null = null;
        if (
          updates.departmentId !== undefined ||
          updates.locationId !== undefined ||
          updates.accountId !== undefined
        ) {
          const deptAlias = dimensions;
          const rows = await db
            .select({
              headerId: journalLines.journalHeaderId,
              departmentId: journalLines.departmentId,
              locationId: journalLines.locationId,
              accountId: journalLines.accountId,
              accountName: accounts.name,
              subtype: accounts.subtype,
            })
            .from(journalLines)
            .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
            .where(inArray(journalLines.journalHeaderId, validIds));

          // Resolve dimension names in batch
          const dimIds = [
            ...new Set(
              rows.flatMap((r) => [r.departmentId, r.locationId]).filter(Boolean) as string[],
            ),
          ];
          let dimMap: Record<string, string> = {};
          if (dimIds.length > 0) {
            const dims = await db
              .select({ id: deptAlias.id, name: deptAlias.name })
              .from(deptAlias)
              .where(inArray(deptAlias.id, dimIds));
            dimMap = Object.fromEntries(dims.map((d) => [d.id, d.name]));
          }

          oldLines = rows.map((r) => ({
            headerId: r.headerId,
            departmentId: r.departmentId,
            departmentName: r.departmentId ? (dimMap[r.departmentId] ?? null) : null,
            locationId: r.locationId,
            locationName: r.locationId ? (dimMap[r.locationId] ?? null) : null,
            accountId: r.accountId,
            accountName: r.accountName,
            subtype: r.subtype,
          }));
        }

        // ── 1. Update Headers (Party, Memo) ──────────────────────────────────
        if (updates.partyId !== undefined || updates.memo !== undefined) {
          const headerUpdates: Record<string, any> = { updatedAt: new Date() };
          if (updates.partyId !== undefined) headerUpdates.partyId = updates.partyId;
          if (updates.memo !== undefined) headerUpdates.memo = updates.memo;

          if (updates.partyId) {
            const [targetParty] = await db
              .select({ id: parties.id })
              .from(parties)
              .where(and(eq(parties.id, updates.partyId), eq(parties.organizationId, orgId)))
              .limit(1);
            if (!targetParty) throw new Error("Party is unavailable for this organization");
          }
          await db
            .update(journalHeaders)
            .set(headerUpdates)
            .where(
              and(inArray(journalHeaders.id, validIds), eq(journalHeaders.organizationId, orgId)),
            );
        }

        // ── 2. Update Lines (Department, Location) ─────────────────────────────
        // Propagation rules (see docs/LEDGER-TYPES-INTERACTION.md):
        //   pay_in / pay_out / transfer → SHARED: update ALL lines
        //   journal → INDIVIDUAL: update ONLY the line matching lineAccountId
        if (updates.departmentId !== undefined || updates.locationId !== undefined) {
          const requestedDimensionIds = [updates.departmentId, updates.locationId].filter(
            Boolean,
          ) as string[];
          if (requestedDimensionIds.length > 0) {
            const validDimensions = await db
              .select({ id: dimensions.id })
              .from(dimensions)
              .where(
                and(
                  inArray(dimensions.id, requestedDimensionIds),
                  eq(dimensions.organizationId, orgId),
                ),
              );
            if (validDimensions.length !== new Set(requestedDimensionIds).size) {
              throw new Error("A selected dimension is unavailable for this organization");
            }
          }
          const lineUpdates: Record<string, any> = {};
          if (updates.departmentId !== undefined) lineUpdates.departmentId = updates.departmentId;
          if (updates.locationId !== undefined) lineUpdates.locationId = updates.locationId;

          if (Object.keys(lineUpdates).length > 0) {
            if (transactionType === "journal" && lineAccountId) {
              // Journal: update only the specific line the user edited
              await db
                .update(journalLines)
                .set(lineUpdates)
                .where(
                  and(
                    inArray(journalLines.journalHeaderId, validIds),
                    eq(journalLines.accountId, lineAccountId),
                  ),
                );
            } else {
              // pay_in / pay_out / transfer (or fallback): update ALL lines
              await db
                .update(journalLines)
                .set(lineUpdates)
                .where(inArray(journalLines.journalHeaderId, validIds));
            }
          }
        }

        // ── 3. Handle Category Change ──────────────────────────────────────────
        // Category is ALWAYS individual — update only the line matching lineAccountId.
        // If lineAccountId is provided, use it to target the exact line.
        // Fallback (no lineAccountId): pick highest-sortOrder line per header (legacy).
        if (updates.accountId) {
          const [targetAccount] = await db
            .select({ id: accounts.id })
            .from(accounts)
            .where(
              and(
                eq(accounts.id, updates.accountId),
                eq(accounts.organizationId, orgId),
                eq(accounts.isActive, true),
              ),
            )
            .limit(1);
          if (!targetAccount) throw new Error("Account is unavailable for this organization");

          if (lineAccountId) {
            // Target the specific journal line whose current accountId matches lineAccountId
            await db
              .update(journalLines)
              .set({ accountId: updates.accountId })
              .where(
                and(
                  inArray(journalLines.journalHeaderId, validIds),
                  eq(journalLines.accountId, lineAccountId),
                ),
              );
          } else {
            // Legacy fallback: pick only the highest-sortOrder line per header
            const lines = await db
              .select({
                id: journalLines.id,
                headerId: journalLines.journalHeaderId,
                sortOrder: journalLines.sortOrder,
              })
              .from(journalLines)
              .where(inArray(journalLines.journalHeaderId, validIds))
              .orderBy(desc(journalLines.sortOrder));

            const linesToUpdate: string[] = [];
            const seenHeaders = new Set<string>();
            for (const line of lines) {
              if (!seenHeaders.has(line.headerId)) {
                seenHeaders.add(line.headerId);
                linesToUpdate.push(line.id);
              }
            }

            if (linesToUpdate.length > 0) {
              await db
                .update(journalLines)
                .set({ accountId: updates.accountId })
                .where(inArray(journalLines.id, linesToUpdate));
            }
          }
        }

        // ── 4. Write activity logs in the same transaction ───────────────────
        await (async () => {
          try {
            // Resolve new party name if changed
            let newPartyName: string | null = null;
            if (updates.partyId) {
              newPartyName = await resolvePartyName(db, updates.partyId);
            }

            // Resolve new dimension names
            let newDeptName: string | null = null;
            let newLocName: string | null = null;
            let newCategoryName: string | null = null;
            if (updates.departmentId || updates.locationId || updates.accountId) {
              const dimIdsToResolve = [updates.departmentId, updates.locationId].filter(
                Boolean,
              ) as string[];
              if (dimIdsToResolve.length > 0) {
                const dims = await db
                  .select({ id: dimensions.id, name: dimensions.name })
                  .from(dimensions)
                  .where(inArray(dimensions.id, dimIdsToResolve));
                for (const d of dims) {
                  if (d.id === updates.departmentId) newDeptName = d.name;
                  if (d.id === updates.locationId) newLocName = d.name;
                }
              }
              if (updates.accountId) {
                const [acct] = await db
                  .select({ name: accounts.name })
                  .from(accounts)
                  .where(eq(accounts.id, updates.accountId))
                  .limit(1);
                newCategoryName = acct?.name ?? null;
              }
            }

            // Build per-transaction changes and log them
            const logEntries = validIds.map((txnId) => {
              const changes: Record<string, any> = {};

              // Party change
              if (updates.partyId !== undefined && oldHeaders) {
                const old = oldHeaders.find((h) => h.id === txnId);
                if (old && old.partyId !== updates.partyId) {
                  changes.party = { old: old.partyName ?? null, new: newPartyName };
                }
              }

              // Department change
              if (updates.departmentId !== undefined && oldLines) {
                const txnLines = oldLines.filter((l) => l.headerId === txnId);
                const oldDept = txnLines[0]?.departmentName ?? null;
                if (oldDept !== newDeptName) {
                  changes.department = { old: oldDept, new: newDeptName };
                }
              }

              // Location change
              if (updates.locationId !== undefined && oldLines) {
                const txnLines = oldLines.filter((l) => l.headerId === txnId);
                const oldLoc = txnLines[0]?.locationName ?? null;
                if (oldLoc !== newLocName) {
                  changes.location = { old: oldLoc, new: newLocName };
                }
              }

              // Category (account) change
              if (updates.accountId !== undefined && oldLines) {
                const txnLines = oldLines.filter((l) => l.headerId === txnId);
                // Find the category line (non-bank)
                const excludedSubtypes = new Set([
                  "bank",
                  "credit_card",
                  "accounts_payable",
                  "accounts_receivable",
                ]);
                const catLine = txnLines.find((l) => !excludedSubtypes.has(l.subtype || ""));
                const oldCat = catLine?.accountName ?? null;
                if (oldCat !== newCategoryName) {
                  changes.category = { old: oldCat, new: newCategoryName };
                }
              }

              return {
                orgId,
                entityType: "transaction" as const,
                entityId: txnId,
                action: "updated" as const,
                actorId: userId,
                changes: Object.keys(changes).length > 0 ? changes : undefined,
              };
            });

            // Filter out entries with no actual changes, then insert
            const entriesWithChanges = logEntries.filter(
              (entry) => entry.changes && Object.keys(entry.changes).length > 0,
            );
            if (entriesWithChanges.length > 0) {
              await Promise.all(entriesWithChanges.map((entry) => insertActivityLog(entry, db)));
            }
          } catch (error) {
            throw new Error("Transaction changes were not saved because audit logging failed", {
              cause: error,
            });
          }
        })();

        return { success: true };
      },
    );
  });

/**
 * Batch delete transactions
 */
export const deleteTransactionsBatch = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof deleteTransactionsBatchSchema>) =>
    deleteTransactionsBatchSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "journal",
      "delete",
      { routeKey: "transactions:delete-batch", limit: 20, windowMs: 60_000 },
      async ({ orgId, db }) => {
        const parsed = deleteTransactionsBatchSchema.parse(rawData);
        const { ids } = parsed;

        if (ids.length === 0) return { count: 0 };

        const headers = await db
          .select({
            id: journalHeaders.id,
            transactionDate: journalHeaders.transactionDate,
            duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId,
          })
          .from(journalHeaders)
          .where(and(inArray(journalHeaders.id, ids), eq(journalHeaders.organizationId, orgId)))
          .orderBy(asc(journalHeaders.id))
          .for("update");

        // Period-lock guard: no transaction dated in a closed period may be deleted.
        const validIds = headers.map((header) => header.id);
        if (validIds.length !== new Set(ids).size) {
          throw new Error("One or more transactions were not found in this organization");
        }
        if (headers.some((header) => header.duplicateOfHeaderId !== null)) {
          throw new Error(
            "Suppressed duplicate transactions cannot be deleted. Unmatch them first.",
          );
        }
        const [activeMerge] = await db
          .select({ id: journalDuplicateMerges.id })
          .from(journalDuplicateMerges)
          .where(
            and(
              eq(journalDuplicateMerges.organizationId, orgId),
              eq(journalDuplicateMerges.state, "active"),
              or(
                inArray(journalDuplicateMerges.canonicalHeaderId, validIds),
                inArray(journalDuplicateMerges.duplicateHeaderId, validIds),
              ),
            ),
          )
          .limit(1);
        if (activeMerge) {
          throw new Error(
            "Transactions in an active duplicate merge cannot be deleted. Unmatch them first.",
          );
        }
        const closedThrough = await getClosedThrough(orgId, db);
        if (headers.some((h) => isDateLocked(h.transactionDate, closedThrough))) {
          throw new Error(
            `Cannot delete: one or more transactions fall in a period locked through ${closedThrough}. Open the period first.`,
          );
        }

        // Reconciliation guard: no transaction cleared by a finalized reconciliation may be deleted.
        const reconciled = await db
          .select({ headerId: journalLines.journalHeaderId })
          .from(statementLines)
          .innerJoin(reconciliations, eq(statementLines.reconciliationId, reconciliations.id))
          .innerJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
          .where(
            and(
              inArray(journalLines.journalHeaderId, validIds),
              eq(reconciliations.status, "finalized"),
            ),
          )
          .limit(1);
        if (reconciled.length > 0) {
          throw new Error(
            "Cannot delete: one or more transactions are locked by a finalized reconciliation.",
          );
        }

        await db.delete(journalLines).where(inArray(journalLines.journalHeaderId, validIds));
        await db
          .delete(journalHeaders)
          .where(
            and(inArray(journalHeaders.id, validIds), eq(journalHeaders.organizationId, orgId)),
          );

        return { success: true };
      },
    );
  });
