// Zod output schema for the reconciliation match-assist arbitration task.
// The model arbitrates WITHIN caller-supplied candidate blocks only:
// grounding blanks any journalLineId not in the candidate set, and
// allocation sums are re-computed in TypeScript — money math is never
// trusted from the model.
import { z } from "zod";

export const matchDecisionSchema = z.object({
  statementLineId: z.string().describe("The statement line this decision is for (from the block)"),
  decision: z
    .enum(["match", "split", "none"])
    .describe(
      '"match" for a single ledger transaction, "split" when the line settles multiple ledger transactions, "none" when no candidate is a plausible match',
    ),
  journalLineIds: z
    .array(z.string())
    .default([])
    .describe("IDs of the matched ledger candidate(s) FROM THE PROVIDED CANDIDATE LIST ONLY"),
  allocations: z
    .array(
      z.object({
        journalLineId: z.string().describe("Candidate ledger line ID"),
        amount: z
          .number()
          .describe("Portion of the statement line amount allocated to this ledger line"),
      }),
    )
    .optional()
    .describe('For "split" decisions: how the statement amount divides across the matched lines'),
  confidence: z.number().describe("Confidence score from 0.0 to 1.0"),
  reason: z.string().catch("").describe("One short sentence explaining the decision"),
});

export const matchAssistOutputSchema = z.object({
  decisions: z
    .array(matchDecisionSchema)
    .describe("One decision per statement line in the provided blocks, same order"),
});

export type MatchAssistOutput = z.infer<typeof matchAssistOutputSchema>;
export type MatchDecision = z.infer<typeof matchDecisionSchema>;
