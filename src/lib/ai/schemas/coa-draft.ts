// ============================================================================
// Zod output schema for the chart-of-accounts drafting task.
//
// Three deliberate shape decisions, all forced by how the rest of the stack
// behaves:
//
//  1. THE TREE IS FLAT. `zodToGeminiSchema` throws on recursion, so a nested
//     `children` array cannot be expressed. Each entry instead carries two
//     parent fields: `parentKey` (an EXISTING account, from the caller's
//     grounded key set) and `parentDraftKey` (another entry in this same
//     response, resolved in TypeScript). Only the first is grounded — the
//     second names something that does not exist yet, so there is no allowed
//     set to check it against.
//
//  2. `accountType` IS STRICT, `subtype` IS NOT. `parseModelJson` is
//     all-or-nothing: one illegal enum value discards a whole 70-account
//     response. Account type has 8 members a model gets right; subtype has 70
//     and is repaired deterministically by `validate-draft.ts` instead.
//
//  3. NO IDs AND NO ACCOUNT NUMBERS. Numbering is arithmetic behind a unique
//     index; letting a model pick numbers only creates collisions to resolve.
//     Every remaining string carries `.catch("")` so a single malformed entry
//     degrades to one rejected row rather than a discarded batch.
// ============================================================================
import { z } from "zod";
import { ACCOUNT_TYPES } from "../../../db/schema/account-constants";

export const draftedAccountSchema = z.object({
  key: z
    .string()
    .catch("")
    .describe('Short unique identifier for this entry within this response, e.g. "D1"'),
  name: z.string().catch("").describe("Account name as it should appear in the chart"),
  accountType: z
    .enum(ACCOUNT_TYPES)
    .describe("One of the 8 root account types; must match the parent account's type"),
  subtype: z
    .string()
    .catch("")
    .describe("Classification label; must be one of the subtypes listed for this accountType"),
  parentKey: z
    .string()
    .catch("")
    .describe(
      "Key of an EXISTING account from the supplied chart, or empty when this entry is parented by parentDraftKey",
    ),
  parentDraftKey: z
    .string()
    .catch("")
    .describe(
      "Key of ANOTHER entry in this response, when this account belongs under a new account you are also proposing",
    ),
  description: z.string().catch("").describe("One short sentence describing what posts here"),
});

export const coaDraftOutputSchema = z.object({
  accounts: z.array(draftedAccountSchema).describe("The accounts to add to the existing chart"),
  summary: z
    .string()
    .catch("")
    .describe("One or two sentences explaining the shape of what you proposed"),
});

export type DraftedAccount = z.infer<typeof draftedAccountSchema>;
export type CoaDraftOutput = z.infer<typeof coaDraftOutputSchema>;
