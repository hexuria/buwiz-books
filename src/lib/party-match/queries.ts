// ============================================================================
// Database lookups behind the entity matching pipeline.
//
// Every query filters organization_id explicitly AND runs on the caller's
// org-context executor, so RLS scopes it a second time. Only active parties of
// a type compatible with the extracted role are ever returned.
//
// Look-alikes use pg_trgm's `%` operator, which the GIN trigram index on
// parties.name (drizzle/0058_party_name_trigram.sql) can serve; the threshold
// is pg_trgm.similarity_threshold (0.3 by default).
// ============================================================================

import { and, asc, desc, eq, inArray, notInArray, or, sql } from "drizzle-orm";
import type { DbExecutor } from "../../db";
import { parties } from "../../db/schema/parties";
import { partyTaxProfiles } from "../../db/schema/party-tax";
import { lookupVendorAliases } from "../match-assist/aliases";
import { normalizeDescriptor } from "../match-assist/normalize";
import {
  PARTY_TYPES_FOR_ENTITY,
  extractEmailAddress,
  normalizeTaxId,
  taxIdBase,
  taxIdsMatch,
} from "./normalize";
import {
  MAX_LOOKALIKE_CANDIDATES,
  type ExactTier,
  type PartyCandidate,
  type PartyLookups,
  type PartyMatchQuery,
} from "./pipeline";

const MAX_QUERY_CHARS = 255;

type PartyType = (typeof parties.partyType.enumValues)[number];

function partyTypesFor(query: PartyMatchQuery): PartyType[] {
  return [...PARTY_TYPES_FOR_ENTITY[query.entityType]] as PartyType[];
}

const candidateColumns = {
  id: parties.id,
  name: parties.name,
  partyType: parties.partyType,
};

function scopedParties(orgId: string, query: PartyMatchQuery) {
  return and(
    eq(parties.organizationId, orgId),
    eq(parties.isActive, true),
    inArray(parties.partyType, partyTypesFor(query)),
  );
}

async function byTaxId(
  db: DbExecutor,
  orgId: string,
  query: PartyMatchQuery,
): Promise<PartyCandidate[]> {
  const normalized = normalizeTaxId(query.taxId);
  if (!normalized) return [];
  const keys = [normalized, taxIdBase(normalized)].filter((key): key is string => Boolean(key));
  const storedTaxId = sql<string>`upper(regexp_replace(coalesce(${parties.taxId}, ''), '[^0-9A-Za-z]', '', 'g'))`;
  const rows = await db
    .select({ ...candidateColumns, taxId: storedTaxId, tin: partyTaxProfiles.tin })
    .from(parties)
    .leftJoin(
      partyTaxProfiles,
      and(eq(partyTaxProfiles.partyId, parties.id), eq(partyTaxProfiles.organizationId, orgId)),
    )
    .where(
      and(
        scopedParties(orgId, query),
        or(
          inArray(storedTaxId, keys),
          inArray(partyTaxProfiles.tin, keys),
          // A stored 12-14 digit TIN whose nine-digit base was printed alone.
          sql`left(${storedTaxId}, 9) = ${normalized}`,
        ),
      ),
    )
    .limit(MAX_LOOKALIKE_CANDIDATES + 1);
  return rows
    .filter(
      (row) =>
        taxIdsMatch(normalizeTaxId(row.taxId), normalized) ||
        taxIdsMatch(normalizeTaxId(row.tin), normalized),
    )
    .map(({ id, name, partyType }) => ({ id, name, partyType }));
}

async function byEmail(
  db: DbExecutor,
  orgId: string,
  query: PartyMatchQuery,
): Promise<PartyCandidate[]> {
  const emails = [
    ...new Set(
      (query.emails ?? [])
        .map((email) => extractEmailAddress(email))
        .filter((email): email is string => Boolean(email)),
    ),
  ];
  if (emails.length === 0) return [];
  return db
    .select(candidateColumns)
    .from(parties)
    .where(and(scopedParties(orgId, query), inArray(sql`lower(btrim(${parties.email}))`, emails)))
    .limit(MAX_LOOKALIKE_CANDIDATES + 1);
}

async function byAlias(
  db: DbExecutor,
  orgId: string,
  query: PartyMatchQuery,
): Promise<PartyCandidate[]> {
  const normalized = normalizeDescriptor(query.name);
  if (!normalized) return [];
  const aliases = await lookupVendorAliases(db, orgId, [query.name]);
  const partyId = aliases.get(normalized);
  if (!partyId) return [];
  return db
    .select(candidateColumns)
    .from(parties)
    .where(and(scopedParties(orgId, query), eq(parties.id, partyId)))
    .limit(1);
}

async function byName(
  db: DbExecutor,
  orgId: string,
  query: PartyMatchQuery,
): Promise<PartyCandidate[]> {
  const name = query.name.trim().slice(0, MAX_QUERY_CHARS);
  if (!name) return [];
  return db
    .select(candidateColumns)
    .from(parties)
    .where(and(scopedParties(orgId, query), sql`lower(btrim(${parties.name})) = lower(${name})`))
    .orderBy(asc(parties.createdAt), asc(parties.id))
    .limit(MAX_LOOKALIKE_CANDIDATES + 1);
}

/**
 * pg_trgm look-alikes: the top `limit` active parties of a compatible type
 * whose name is trigram-similar to the query, most similar first.
 */
export async function findLookalikeParties(
  db: DbExecutor,
  orgId: string,
  query: PartyMatchQuery,
  limit = MAX_LOOKALIKE_CANDIDATES,
  excludeIds: readonly string[] = [],
): Promise<PartyCandidate[]> {
  const name = query.name.trim().slice(0, MAX_QUERY_CHARS);
  if (!name || limit <= 0) return [];
  const score = sql<number>`similarity(${parties.name}, ${name})`;
  const rows = await db
    .select({ ...candidateColumns, score })
    .from(parties)
    .where(
      and(
        scopedParties(orgId, query),
        sql`${parties.name} % ${name}`,
        excludeIds.length > 0 ? notInArray(parties.id, [...excludeIds]) : undefined,
      ),
    )
    .orderBy(desc(score), asc(parties.name), asc(parties.id))
    .limit(Math.min(limit, MAX_LOOKALIKE_CANDIDATES));
  return rows.map((row) => ({ ...row, score: Number(row.score) }));
}

/** The pipeline's lookups, bound to one org-context executor. */
export function partyLookups(db: DbExecutor, orgId: string): PartyLookups {
  return {
    exact(tier: ExactTier, query: PartyMatchQuery) {
      switch (tier) {
        case "tax_id":
          return byTaxId(db, orgId, query);
        case "email":
          return byEmail(db, orgId, query);
        case "alias":
          return byAlias(db, orgId, query);
        case "name":
          return byName(db, orgId, query);
      }
    },
    async hint(query: PartyMatchQuery) {
      if (!query.hintPartyId) return null;
      const [row] = await db
        .select(candidateColumns)
        .from(parties)
        .where(and(scopedParties(orgId, query), eq(parties.id, query.hintPartyId)))
        .limit(1);
      return row ?? null;
    },
    lookalikes(query, limit, excludeIds) {
      return findLookalikeParties(db, orgId, query, limit, excludeIds);
    },
  };
}

/** Stored payment destination and name of one party, for the change check. */
export async function loadPartyPaymentDetails(
  db: DbExecutor,
  orgId: string,
  partyId: string,
): Promise<{
  id: string;
  name: string;
  partyType: string;
  bankAccountNumber: string | null;
  bankRoutingNumber: string | null;
} | null> {
  const [row] = await db
    .select({
      id: parties.id,
      name: parties.name,
      partyType: parties.partyType,
      bankAccountNumber: parties.bankAccountNumber,
      bankRoutingNumber: parties.bankRoutingNumber,
    })
    .from(parties)
    .where(and(eq(parties.organizationId, orgId), eq(parties.id, partyId)))
    .limit(1);
  return row ?? null;
}
