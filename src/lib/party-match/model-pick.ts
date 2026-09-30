// ============================================================================
// Entity matching step 3: ask match_party which look-alike, if any, is the
// document's counterparty.
//
// Candidates reach the model under server-minted refs ("P1".."P5"), never as
// uuids, and the per-request response schema is an enum of exactly those refs
// plus "new" — on every provider, Jev included. The ref is mapped back to a
// party id here; anything else is a failed pick, never a guess.
// ============================================================================

import type { AiCompleteArgs, AiCompleteResult } from "../ai/facade-core";
import { normalizeConfidence } from "../ai/confidence";
import {
  buildMatchPartySchema,
  NEW_PARTY_CHOICE,
  type MatchPartyOutput,
} from "../ai/schemas/match-party";
import type { PartyCandidate, PartyMatchQuery, PartyPickResult } from "./pipeline";

/** The façade's signature, injected so pure callers and tests need no runtime. */
export type AiCompleteFn = <TOut>(args: AiCompleteArgs<TOut>) => Promise<AiCompleteResult<TOut>>;

export function partyRef(index: number): string {
  return `P${index + 1}`;
}

export async function pickPartyWithModel(
  query: PartyMatchQuery,
  candidates: PartyCandidate[],
  options: { orgId: string; userId?: string; complete: AiCompleteFn },
): Promise<PartyPickResult> {
  const refs = candidates.map((_, index) => partyRef(index));
  const idByRef = new Map(refs.map((ref, index) => [ref, candidates[index].id]));

  let result: AiCompleteResult<MatchPartyOutput>;
  try {
    result = await options.complete<MatchPartyOutput>({
      task: "match_party",
      input: {
        counterparty: {
          name: query.name,
          role: query.entityType,
          description: query.description ?? "",
        },
        candidates: candidates.map((candidate, index) => ({
          ref: refs[index],
          name: candidate.name,
          partyType: candidate.partyType,
        })),
      },
      schema: buildMatchPartySchema(refs),
      allowedIds: { partyRefs: new Set([...refs, NEW_PARTY_CHOICE]) },
      ctx: { orgId: options.orgId, userId: options.userId },
    });
  } catch (error) {
    // Kill switch, missing credentials, spend cap, task not allowed: the
    // match simply stays with a human.
    return {
      kind: "failed",
      reason: error instanceof Error ? error.name : "ai_error",
      invocationId: null,
    };
  }
  if (!result.ok) {
    return { kind: "failed", reason: "needs_review", invocationId: result.invocationId };
  }

  // The schema pins confidence to 0..1, so a bare 1 means certain.
  const confidence = normalizeConfidence(result.data.confidence, { scaleHint: "unit" });
  if (result.data.choice === NEW_PARTY_CHOICE) {
    return { kind: "new", confidence, invocationId: result.invocationId };
  }
  const partyId = idByRef.get(result.data.choice);
  if (!partyId) {
    return { kind: "failed", reason: "unknown_choice", invocationId: result.invocationId };
  }
  return { kind: "picked", partyId, confidence, invocationId: result.invocationId };
}
