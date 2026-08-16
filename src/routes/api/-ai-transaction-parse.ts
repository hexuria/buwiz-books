// ============================================================================
// AI Transaction Parse — Server Function
// Parses natural language prompts into structured transaction data.
// Model access goes through the aiComplete façade (prompt registry +
// schema-validated output + telemetry).
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { GeminiRateLimitError } from "../../lib/gemini-client";
import { aiComplete } from "../../lib/ai/facade";
import { escapeLikePattern } from "../../lib/sql-escape";
import type { DbExecutor } from "../../db";
import { parties } from "../../db/schema/parties";
import { accounts } from "../../db/schema/accounts";
import { partyTypeMappings } from "../../db/schema/party-type-mappings";
import { eq, and, or, ilike, asc } from "drizzle-orm";
import { getReadPartyTypes } from "../../lib/party-scoping";
import type { PartyType, PartyMappingOverride } from "../../lib/party-scoping";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { assertRolePermission } from "../../lib/auth-middleware";
import { z } from "zod";

// ============================================================================
// Types
// ============================================================================

export interface TransactionParseInput {
  prompt: string;
  currentDate: string;
  accounts: { id: string; name: string; accountNumber?: string | null; accountType: string }[];
  parties: { id: string; name: string }[];
  departments: { id: string; name: string }[];
  locations: { id: string; name: string }[];
}

export interface ParsedTransactionLine {
  description: string;
  categoryId: string;
  categoryName: string;
  amount: string;
  debit: string;
  credit: string;
  departmentId: string;
  departmentName: string;
  locationId: string;
  locationName: string;
}

/** Entity detected from document OCR (bank, employee, vendor, etc.) */
export interface ExtractedEntity {
  /** Entity type matching party types */
  entityType: "bank" | "employee" | "vendor" | "customer" | "government" | "shareholder" | "lender";
  /** Entity name as extracted from the document */
  name: string;
  /** Optional identifier (e.g. account last-4 "****4521", employee ID "EMP-2024-019") */
  identifier: string;
  /** For bank entities: "checking", "savings", "credit_card". Empty for others. */
  accountType: string;
  /** If matched to an existing party, the party ID. Empty string if new. */
  matchedPartyId: string;
}

export interface ParsedTransactionResult {
  transactionType: "journal" | "pay_in" | "pay_out" | "transfer";
  date: string;
  memo: string;
  partyId: string;
  partyName: string;
  referenceNumber: string;
  categoryId: string;
  categoryName: string;
  departmentId: string;
  departmentName: string;
  locationId: string;
  locationName: string;
  transferFromCategoryId: string;
  transferFromCategoryName: string;
  transferToCategoryId: string;
  transferToCategoryName: string;
  amount: string;
  lines: ParsedTransactionLine[];
  confidence: number;
  interpretation: string;
  /** Entities detected in the document (banks, employees, vendors, etc.) */
  extractedEntities?: ExtractedEntity[];
  /** Document subtype classification */
  documentSubtype?: "receipt" | "invoice" | "payslip" | "bill" | "statement" | "other";
}

const contextAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  accountNumber: z.string().nullable().optional(),
  accountType: z.string().min(1),
});

const contextEntitySchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

const transactionParseInputSchema = z.object({
  prompt: z.string().min(1),
  currentDate: z.string().min(1),
  accounts: z.array(contextAccountSchema).default([]),
  parties: z.array(contextEntitySchema).default([]),
  departments: z.array(contextEntitySchema).default([]),
  locations: z.array(contextEntitySchema).default([]),
});

// ============================================================================
// Server Function
// ============================================================================

export const parseTransactionPrompt = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof transactionParseInputSchema>) =>
    transactionParseInputSchema.parse(data),
  )
  .handler(async ({ data: rawData }: { data: unknown }) => {
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:transaction-parse", limit: 30, windowMs: 300_000 },
      async ({ orgId, db, role }) => {
        // Two-key model: the parse pre-fills a journal form, so the caller
        // must also be able to create journals.
        assertRolePermission(role, "journal", "create");
        const input = transactionParseInputSchema.parse(rawData);

        if (!input.prompt?.trim()) {
          throw new Error("Prompt is required");
        }

        try {
          const result = await aiComplete<ParsedTransactionResult>({
            task: "transaction_parse",
            input,
            ctx: { orgId },
          });
          if (!result.ok) {
            throw new Error("AI returned an invalid response — please try again.");
          }
          const parsed: ParsedTransactionResult = result.data;

          if (parsed.partyName && !parsed.partyId) {
            const resolved = await resolvePartyFromMappings(
              db,
              orgId,
              parsed.partyName,
              parsed.lines,
              parsed.transactionType,
            );
            if (resolved) {
              parsed.partyId = resolved.id;
              parsed.partyName = resolved.name;
            }
          }

          return parsed;
        } catch (err) {
          if (err instanceof GeminiRateLimitError) {
            throw new Error(err.message);
          }
          throw err;
        }
      },
    ) as any;
  });

// ============================================================================
// Server-side Party Resolution
// ============================================================================

/**
 * Resolve a party ID from a name extracted by the AI, using the party type
 * mapping system to determine which entity types to search.
 *
 * Flow:
 * 1. Collect category IDs from parsed lines
 * 2. Look up their subtypes from the accounts table
 * 3. Load org-level party mapping overrides
 * 4. Use getReadPartyTypes() to determine relevant party types
 * 5. Query parties table with type filter + fuzzy name match
 * 6. Return the best match (exact > fuzzy)
 */
async function resolvePartyFromMappings(
  db: DbExecutor,
  orgId: string,
  partyName: string,
  lines: ParsedTransactionLine[],
  transactionType: string,
): Promise<{ id: string; name: string } | null> {
  if (!partyName.trim()) return null;

  // Step 1: Collect category IDs from parsed lines
  const categoryIds = lines.map((l) => l.categoryId).filter(Boolean);

  // Step 2: Look up subtypes from account records
  const subtypes = new Set<string>();
  if (categoryIds.length > 0) {
    const acctRows = await db
      .select({ id: accounts.id, subtype: accounts.subtype, parentId: accounts.parentId })
      .from(accounts)
      .where(
        and(
          eq(accounts.organizationId, orgId),
          or(...categoryIds.map((cid) => eq(accounts.id, cid))),
        ),
      );

    // If an account doesn't have a subtype directly, try walking up
    // to the parent (one level) to resolve it
    const parentIdsToFetch = acctRows
      .filter((a) => !a.subtype && a.parentId)
      .map((a) => a.parentId!);

    let parentRows: { id: string; subtype: string | null }[] = [];
    if (parentIdsToFetch.length > 0) {
      parentRows = await db
        .select({ id: accounts.id, subtype: accounts.subtype })
        .from(accounts)
        .where(
          and(
            eq(accounts.organizationId, orgId),
            or(...parentIdsToFetch.map((pid) => eq(accounts.id, pid))),
          ),
        );
    }

    for (const acct of acctRows) {
      if (acct.subtype) {
        subtypes.add(acct.subtype);
      } else if (acct.parentId) {
        const parent = parentRows.find((p) => p.id === acct.parentId);
        if (parent?.subtype) subtypes.add(parent.subtype);
      }
    }
  }

  // Step 3: Load org-level party mapping overrides
  const overrideRows = await db
    .select({
      subtype: partyTypeMappings.subtype,
      readTypes: partyTypeMappings.readTypes,
      mutateTypes: partyTypeMappings.mutateTypes,
    })
    .from(partyTypeMappings)
    .where(eq(partyTypeMappings.organizationId, orgId));

  const overrides: Record<string, PartyMappingOverride> = {};
  for (const row of overrideRows) {
    overrides[row.subtype] = {
      readTypes: row.readTypes as PartyType[],
      mutateTypes: row.mutateTypes as PartyType[],
    };
  }

  // Step 4: Determine preferred party types from subtypes
  const allPartyTypes = new Set<PartyType>();
  const txType = transactionType as "pay_in" | "pay_out" | "journal" | "transfer" | undefined;

  for (const subtype of subtypes) {
    const types = getReadPartyTypes(subtype, txType, overrides);
    for (const t of types) allPartyTypes.add(t);
  }

  // If no subtypes found, fall back to transaction-type defaults
  if (allPartyTypes.size === 0) {
    const fallback = getReadPartyTypes(undefined, txType, overrides);
    for (const t of fallback) allPartyTypes.add(t);
  }

  // Step 5: Query parties with type filter + fuzzy name match
  const typeConditions: ReturnType<typeof eq>[] = [];
  for (const pt of allPartyTypes) {
    if (pt === "vendor") {
      typeConditions.push(eq(parties.partyType, "vendor"), eq(parties.partyType, "both"));
    } else if (pt === "customer") {
      typeConditions.push(eq(parties.partyType, "customer"), eq(parties.partyType, "both"));
    } else {
      typeConditions.push(eq(parties.partyType, pt));
    }
  }

  const conditions = [
    eq(parties.organizationId, orgId),
    eq(parties.isActive, true),
    ilike(parties.name, `%${escapeLikePattern(partyName)}%`),
  ];

  if (typeConditions.length > 0) {
    conditions.push(or(...typeConditions)!);
  }

  const matches = await db
    .select({ id: parties.id, name: parties.name })
    .from(parties)
    .where(and(...conditions))
    .orderBy(asc(parties.name))
    .limit(10);

  if (matches.length === 0) return null;

  // Step 6: Prefer exact match, otherwise return the first fuzzy match
  const exactMatch = matches.find((m) => m.name.toLowerCase() === partyName.toLowerCase());
  return exactMatch ?? matches[0];
}
