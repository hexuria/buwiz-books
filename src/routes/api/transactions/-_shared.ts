/**
 * Transactions API — Shared schemas, types, and helpers
 */
import type { DbExecutor } from "../../../db";
import { journalLines } from "../../../db/schema/journals";
import { accounts } from "../../../db/schema/accounts";
import { parties } from "../../../db/schema/parties";
import { dimensions } from "../../../db/schema/dimensions";
import { eq, asc, inArray } from "drizzle-orm";
import { z } from "zod";
import { TRANSACTION_TYPES, JOURNAL_STATUSES } from "../../../db/validation/journals";

// ============================================================================
// Schemas
// ============================================================================

export const listTransactionsSchema = z.object({
  types: z.array(z.enum(TRANSACTION_TYPES)).optional().default([]),
  statuses: z.array(z.enum(JOURNAL_STATUSES)).optional().default([]),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  partyId: z.string().uuid().optional(),
  partyIds: z.array(z.string().uuid()).optional(),
  accountId: z.string().uuid().optional(),
  departmentIds: z.array(z.string().uuid()).optional(),
  locationIds: z.array(z.string().uuid()).optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(250).optional().default(50),
  offset: z.number().int().min(0).optional().default(0),
});

export const groupedTransactionsSchema = z.object({
  types: z.array(z.enum(TRANSACTION_TYPES)).optional().default([]),
  statuses: z.array(z.enum(JOURNAL_STATUSES)).optional().default([]),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  partyIds: z.array(z.string().uuid()).optional(),
  departmentIds: z.array(z.string().uuid()).optional(),
  locationIds: z.array(z.string().uuid()).optional(),
  search: z.string().optional(),
  perAccountLimit: z.number().int().min(1).max(50).optional().default(20),
});

export const loadMoreSchema = z.object({
  accountId: z.string().uuid(),
  types: z.array(z.enum(TRANSACTION_TYPES)).optional().default([]),
  statuses: z.array(z.enum(JOURNAL_STATUSES)).optional().default([]),
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  partyIds: z.array(z.string().uuid()).optional(),
  departmentIds: z.array(z.string().uuid()).optional(),
  locationIds: z.array(z.string().uuid()).optional(),
  search: z.string().optional(),
  limit: z.number().int().min(1).max(100).optional().default(20),
  offset: z.number().int().min(0).optional().default(0),
});

export const accountBalancesSchema = z.object({
  dateFrom: z.string().optional(),
  dateTo: z.string().optional(),
  statuses: z.array(z.enum(JOURNAL_STATUSES)).optional().default([]),
});

export const getTransactionSchema = z.object({
  id: z.string().uuid(),
});

export const voidTransactionSchema = z.object({
  id: z.string().uuid(),
});

export const setClosedThroughSchema = z.object({
  closedThrough: z.string().nullable(),
});

// ============================================================================
// Types
// ============================================================================

export type TransactionListItem =
  typeof import("../../../db/schema/journals").journalHeaders.$inferSelect & {
    partyName?: string | null;
    lineCount: number;
  };

export type TransactionDetail =
  typeof import("../../../db/schema/journals").journalHeaders.$inferSelect & {
    partyName?: string | null;
    lines: Array<
      typeof import("../../../db/schema/journals").journalLines.$inferSelect & {
        accountName: string;
        accountNumber?: string | null;
      }
    >;
  };

/** Shape returned by fetchLinesWithNames queries */
export interface LineWithNames {
  id: string;
  sortOrder: number | null;
  lineDescription: string | null;
  debit: string | null;
  credit: string | null;
  accountId: string;
  accountName: string;
  accountNumber: string;
  partyId: string | null;
  partyName: string | null;
  departmentId: string | null;
  locationId: string | null;
  departmentName: string | null;
  locationName: string | null;
}

// ============================================================================
// Helpers
// ============================================================================

/** Fetch all lines for a header with joined account, party, department, location names */
export async function fetchLinesWithNames(
  db: DbExecutor,
  headerId: string,
): Promise<LineWithNames[]> {
  const rows = await db
    .select({
      id: journalLines.id,
      sortOrder: journalLines.sortOrder,
      lineDescription: journalLines.lineDescription,
      debit: journalLines.debit,
      credit: journalLines.credit,
      accountId: journalLines.accountId,
      accountName: accounts.name,
      accountNumber: accounts.accountNumber,
      partyId: journalLines.partyId,
      partyName: parties.name,
      departmentId: journalLines.departmentId,
      locationId: journalLines.locationId,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .leftJoin(parties, eq(journalLines.partyId, parties.id))
    .where(eq(journalLines.journalHeaderId, headerId))
    .orderBy(asc(journalLines.sortOrder));

  // Gather unique dimension IDs for a single batch query
  const deptIds = [...new Set(rows.map((r) => r.departmentId).filter(Boolean))] as string[];
  const locIds = [...new Set(rows.map((r) => r.locationId).filter(Boolean))] as string[];
  const dimIds = [...deptIds, ...locIds];

  let dimMap: Record<string, string> = {};
  if (dimIds.length > 0) {
    const dims = await db
      .select({ id: dimensions.id, name: dimensions.name })
      .from(dimensions)
      .where(inArray(dimensions.id, dimIds));
    dimMap = Object.fromEntries(dims.map((d) => [d.id, d.name]));
  }

  return rows.map((r) => ({
    id: r.id,
    sortOrder: r.sortOrder,
    lineDescription: r.lineDescription,
    debit: r.debit,
    credit: r.credit,
    accountId: r.accountId,
    accountName: r.accountName,
    accountNumber: r.accountNumber ?? "",
    partyId: r.partyId,
    partyName: r.partyName ?? null,
    departmentId: r.departmentId,
    locationId: r.locationId,
    departmentName: r.departmentId ? (dimMap[r.departmentId] ?? null) : null,
    locationName: r.locationId ? (dimMap[r.locationId] ?? null) : null,
  }));
}

/** Resolve a party ID to its display name, returning null if not found */
export async function resolvePartyName(
  db: DbExecutor,
  partyId: string | null,
): Promise<string | null> {
  if (!partyId) return null;
  const [row] = await db
    .select({ name: parties.name })
    .from(parties)
    .where(eq(parties.id, partyId))
    .limit(1);
  return row?.name ?? null;
}

/** Build a snapshot object for a single line (for create logs or diff) */
export function lineSnapshot(line: LineWithNames) {
  const snap: Record<string, string | null> = {};
  snap.description = line.lineDescription || null;
  snap.debit = line.debit || null;
  snap.credit = line.credit || null;
  snap.category = line.accountName ? `${line.accountNumber} · ${line.accountName}` : null;
  snap.party = line.partyName || null;
  snap.department = line.departmentName || null;
  snap.location = line.locationName || null;
  return snap;
}

/** Build per-line diffs comparing old lines to new lines */
export function buildLineDiffs(
  oldLines: LineWithNames[],
  newLines: LineWithNames[],
): Record<string, any> {
  const changes: Record<string, any> = {};
  const maxLen = Math.max(oldLines.length, newLines.length);

  for (let i = 0; i < maxLen; i++) {
    const oldLine = i < oldLines.length ? lineSnapshot(oldLines[i]) : null;
    const newLine = i < newLines.length ? lineSnapshot(newLines[i]) : null;
    const lineKey = `line_${i + 1}`;

    if (!oldLine && newLine) {
      // Line added
      changes[lineKey] = { added: newLine };
    } else if (oldLine && !newLine) {
      // Line removed
      changes[lineKey] = { removed: oldLine };
    } else if (oldLine && newLine) {
      // Compare fields
      const lineDiff: Record<string, { old: string | null; new: string | null }> = {};
      for (const field of [
        "description",
        "debit",
        "credit",
        "category",
        "party",
        "department",
        "location",
      ] as const) {
        const oldVal = oldLine[field] ?? null;
        const newVal = newLine[field] ?? null;
        if (oldVal !== newVal) {
          lineDiff[field] = { old: oldVal, new: newVal };
        }
      }
      if (Object.keys(lineDiff).length > 0) {
        changes[lineKey] = lineDiff;
      }
    }
  }
  return changes;
}
