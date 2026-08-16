// ============================================================================
// Zod output schema for category-mapping suggestions.
//
// A mapping row says "bills with no category post HERE". Pointing one at an
// account of the wrong ledger type unbalances every journal that reads it, so
// nothing in this schema is trusted: `targetKey` is grounded against the
// caller's account key set, and `validate-draft.ts` re-checks the row against
// `isMappingTargetCompatible` before a proposal is created AND again in the
// applier.
//
// `mappingType` is a plain string rather than an enum on purpose. The strict
// enum belongs in the validator (where an unknown value becomes one recorded
// rejection); in the schema it would make one bad row discard every good one,
// because `parseModelJson` is all-or-nothing.
// ============================================================================
import { z } from "zod";

export const mappingSuggestionSchema = z.object({
  mappingType: z.string().catch("").describe('One of "bank", "bill", "invoice"'),
  sourceKey: z
    .string()
    .catch("")
    .describe('The mapping row being assigned, e.g. "default_expense"'),
  targetKey: z
    .string()
    .catch("")
    .describe("Key of the account this row should post to, from the supplied account list only"),
  reason: z.string().catch("").describe("One short sentence explaining the choice"),
});

export const categoryMappingSuggestOutputSchema = z.object({
  assignments: z
    .array(mappingSuggestionSchema)
    .describe("Only the rows you would CHANGE; omit rows whose current target is already right"),
  summary: z.string().catch("").describe("One or two sentences summarising the changes"),
});

export type MappingSuggestion = z.infer<typeof mappingSuggestionSchema>;
export type CategoryMappingSuggestOutput = z.infer<typeof categoryMappingSuggestOutputSchema>;
