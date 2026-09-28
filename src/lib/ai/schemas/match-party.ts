// ============================================================================
// Zod output schemas for entity matching (match_party).
//
// The model sees up to five look-alike parties under server-minted refs
// ("P1".."P5", never uuids) and answers one ref or "new". Like
// categorize_lines, the per-request schema makes `choice` an enum of exactly
// those refs, and the static registry twin keeps a plain string. Confidence is
// pinned to 0..1 and read with the unit hint.
// ============================================================================
import { z } from "zod";

/** The answer that is always in the enum: none of the candidates is this party. */
export const NEW_PARTY_CHOICE = "new";

const CHOICE_DESCRIPTION =
  'The ref of the candidate that is the same counterparty, or "new" when none of them is';

function outputSchema(choice: z.ZodType<string>) {
  return z.object({
    choice,
    confidence: z
      .number()
      .describe("Confidence from 0.0 to 1.0 in the choice (a probability, never a percentage)"),
    reason: z.string().catch("").describe("One short sentence explaining the choice"),
  });
}

export const matchPartyOutputSchema = outputSchema(z.string().describe(CHOICE_DESCRIPTION));

export type MatchPartyOutput = z.infer<typeof matchPartyOutputSchema>;

/** The per-request schema: `choice` is an enum of the supplied refs plus "new". */
export function buildMatchPartySchema(refs: readonly string[]): z.ZodType<MatchPartyOutput> {
  const values = [...new Set([...refs, NEW_PARTY_CHOICE])] as [string, ...string[]];
  return outputSchema(z.enum(values).describe(CHOICE_DESCRIPTION));
}
