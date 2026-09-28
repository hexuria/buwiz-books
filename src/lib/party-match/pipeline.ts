// ============================================================================
// Entity matching pipeline (inbox v2 §5). Pure orchestration; the database
// lookups and the model call are injected, so ordering is unit-tested without
// either.
//
//   1. Exact, strongest first: tax id → sender/party email → vendor alias →
//      case-insensitive name. The first tier with exactly one hit wins.
//   2. Look-alikes: pg_trgm top five parties of the right party type.
//   3. The model (match_party, Jev first for opted-in orgs) picks one of those
//      five from a closed enum, or says "new".
//   4. "new" becomes a create_party proposal draft; creation stays human.
//
// An exact tier with several hits is ambiguous, not a match: its parties join
// the look-alike pool so the model (and ultimately a human) decides. A later,
// weaker tier cannot overrule an earlier ambiguous one with a party outside
// that set — its hit joins the pool instead.
// ============================================================================

import type { MatchableEntityType } from "./normalize";

export type ExactTier = "tax_id" | "email" | "alias" | "name";

/** Strongest evidence first. The order IS the policy. */
export const EXACT_TIER_ORDER: readonly ExactTier[] = ["tax_id", "email", "alias", "name"];

export const MAX_LOOKALIKE_CANDIDATES = 5;

export interface PartyMatchQuery {
  name: string;
  entityType: MatchableEntityType;
  taxId?: string | null;
  /** Sender and printed addresses; any one of them may match. */
  emails?: readonly string[];
  /** Free-text context for the model (the document description). */
  description?: string | null;
  /** A party another step already suggested (e.g. receipt OCR); joins the pool. */
  hintPartyId?: string | null;
}

export interface PartyCandidate {
  id: string;
  name: string;
  partyType: string;
  /** pg_trgm similarity, for look-alikes. */
  score?: number;
}

export interface PartyLookups {
  exact(tier: ExactTier, query: PartyMatchQuery): Promise<PartyCandidate[]>;
  /** A hinted party, only if it exists in this org with a compatible type. */
  hint?(query: PartyMatchQuery): Promise<PartyCandidate | null>;
  lookalikes(
    query: PartyMatchQuery,
    limit: number,
    excludeIds: readonly string[],
  ): Promise<PartyCandidate[]>;
}

export type PartyCandidateSearch =
  | { kind: "exact"; tier: ExactTier; party: PartyCandidate }
  | { kind: "candidates"; candidates: PartyCandidate[] };

export type PartyPickResult =
  | { kind: "picked"; partyId: string; confidence: number; invocationId: string | null }
  | { kind: "new"; confidence: number; invocationId: string | null }
  | { kind: "failed"; reason: string; invocationId: string | null };

export type PartyMatchOutcome =
  | { kind: "exact"; tier: ExactTier; party: PartyCandidate }
  | {
      kind: "model";
      party: PartyCandidate;
      confidence: number;
      candidates: PartyCandidate[];
      invocationId: string | null;
    }
  | {
      kind: "new";
      /** Empty when nothing looked alike, so no model was asked. */
      candidates: PartyCandidate[];
      confidence: number | null;
      invocationId: string | null;
    }
  | {
      kind: "unresolved";
      reason: "model_failed" | "unknown_choice" | "low_confidence";
      candidates: PartyCandidate[];
      /** The model's below-threshold pick, kept as a non-binding hint. */
      suggestion: PartyCandidate | null;
      confidence: number | null;
      invocationId: string | null;
    };

function hasInput(tier: ExactTier, query: PartyMatchQuery): boolean {
  if (tier === "tax_id") return Boolean(query.taxId?.trim());
  if (tier === "email") return (query.emails ?? []).some((email) => email.trim());
  return Boolean(query.name.trim());
}

/** Steps 1 and 2: every database lookup, no model. */
export async function findPartyCandidates(
  query: PartyMatchQuery,
  lookups: PartyLookups,
  max = MAX_LOOKALIKE_CANDIDATES,
): Promise<PartyCandidateSearch> {
  const pool = new Map<string, PartyCandidate>();
  const addToPool = (candidate: PartyCandidate) => {
    if (!pool.has(candidate.id) && pool.size < max) pool.set(candidate.id, candidate);
  };

  for (const tier of EXACT_TIER_ORDER) {
    if (!hasInput(tier, query)) continue;
    const hits = [
      ...new Map((await lookups.exact(tier, query)).map((hit) => [hit.id, hit])).values(),
    ];
    if (hits.length === 1 && (pool.size === 0 || pool.has(hits[0].id))) {
      return { kind: "exact", tier, party: hits[0] };
    }
    for (const hit of hits) addToPool(hit);
  }

  if (query.hintPartyId && lookups.hint) {
    const hinted = await lookups.hint(query);
    if (hinted) addToPool(hinted);
  }
  if (pool.size < max && query.name.trim()) {
    const lookalikes = await lookups.lookalikes(query, max - pool.size, [...pool.keys()]);
    for (const candidate of lookalikes) addToPool(candidate);
  }
  return { kind: "candidates", candidates: [...pool.values()] };
}

/**
 * Steps 3 and 4, given what the model said (null when there was nothing to
 * ask it about). A pick below `minConfidence` is not applied.
 */
export function decidePartyMatch(
  candidates: PartyCandidate[],
  pick: PartyPickResult | null,
  minConfidence: number,
): PartyMatchOutcome {
  if (candidates.length === 0 || pick === null) {
    return { kind: "new", candidates, confidence: null, invocationId: null };
  }
  if (pick.kind === "failed") {
    return {
      kind: "unresolved",
      reason: "model_failed",
      candidates,
      suggestion: null,
      confidence: null,
      invocationId: pick.invocationId,
    };
  }
  if (pick.kind === "new") {
    return {
      kind: "new",
      candidates,
      confidence: pick.confidence,
      invocationId: pick.invocationId,
    };
  }
  const party = candidates.find((candidate) => candidate.id === pick.partyId);
  if (!party) {
    return {
      kind: "unresolved",
      reason: "unknown_choice",
      candidates,
      suggestion: null,
      confidence: pick.confidence,
      invocationId: pick.invocationId,
    };
  }
  if (pick.confidence < minConfidence) {
    return {
      kind: "unresolved",
      reason: "low_confidence",
      candidates,
      suggestion: party,
      confidence: pick.confidence,
      invocationId: pick.invocationId,
    };
  }
  return {
    kind: "model",
    party,
    confidence: pick.confidence,
    candidates,
    invocationId: pick.invocationId,
  };
}

/** The whole pipeline, for callers that may hold one transaction across the model call. */
export async function matchParty(
  query: PartyMatchQuery,
  deps: PartyLookups & {
    pick(query: PartyMatchQuery, candidates: PartyCandidate[]): Promise<PartyPickResult>;
  },
  options: { minConfidence: number },
): Promise<PartyMatchOutcome> {
  const search = await findPartyCandidates(query, deps);
  if (search.kind === "exact") return search;
  const pick = search.candidates.length > 0 ? await deps.pick(query, search.candidates) : null;
  return outcomeForSearch(search, pick, options.minConfidence);
}

/**
 * The match a finished search and (optional) model pick add up to — the second
 * half of matchParty, for callers that must run the pick outside the
 * transaction the search ran in (src/routes/api/-ai-entity-resolver.ts).
 */
export function outcomeForSearch(
  search: Awaited<ReturnType<typeof findPartyCandidates>>,
  pick: PartyPickResult | null,
  minConfidence: number,
): PartyMatchOutcome {
  if (search.kind === "exact") return search;
  return decidePartyMatch(search.candidates, pick, minConfidence);
}
