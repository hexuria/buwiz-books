// ============================================================================
// Zod output schemas for inbox stage-2 line categorization (categorize_lines).
//
// The account list is CLOSED and built per request: the org's own active leaf
// accounts, each under a compact code (its account number where that renders
// safely, a minted "A<n>" otherwise — never a uuid). buildCategorizeLinesSchema
// turns that list into a z.enum, and the façade sends the per-request schema to
// every provider as the response schema, so Gemini and Jev both decode against
// the enum. The registry keeps a static twin with a plain string so the Gemini
// schema precompute, the schema hash, and the mock fixtures have one fixed
// shape; the server re-checks every returned code against the request either
// way (src/lib/inbox/line-categorization.ts).
//
// Confidence is pinned to 0..1 (inbox v2 review finding 9): readers pass
// normalizeConfidence's unit hint, so a bare 1 means certain.
// ============================================================================
import { z } from "zod";

/** The one answer that is always in the enum: nothing in the list fits. */
export const NO_FIT_CODE = "none";

const ACCOUNT_CODE_DESCRIPTION =
  'The code of the chosen account from the supplied chart, or "none" when no account fits';

function lineSchema(accountCode: z.ZodType<string>) {
  return z.object({
    lineIndex: z.number().int().describe("The lineIndex of the line being answered, copied"),
    accountCode,
    confidence: z
      .number()
      .describe(
        "Confidence from 0.0 to 1.0 that the chosen account is right (a probability, never a percentage)",
      ),
    reason: z.string().catch("").describe("One short sentence explaining the choice"),
    suggestedNewCategory: z
      .string()
      .catch("")
      .describe(
        'Only when accountCode is "none": a short name for the category the chart is missing. Otherwise an empty string.',
      ),
  });
}

export const categorizeLinesOutputSchema = z.object({
  lines: z
    .array(lineSchema(z.string().describe(ACCOUNT_CODE_DESCRIPTION)))
    .describe("Exactly one entry per input line"),
});

export type CategorizeLinesOutput = z.infer<typeof categorizeLinesOutputSchema>;

/**
 * The per-request schema: `accountCode` is an enum of exactly the codes the
 * prompt listed, plus NO_FIT_CODE.
 */
export function buildCategorizeLinesSchema(
  codes: readonly string[],
): z.ZodType<CategorizeLinesOutput> {
  const values = [...new Set([...codes, NO_FIT_CODE])] as [string, ...string[]];
  return z.object({
    lines: z
      .array(lineSchema(z.enum(values).describe(ACCOUNT_CODE_DESCRIPTION)))
      .describe("Exactly one entry per input line"),
  });
}
