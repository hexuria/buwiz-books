// Zod output schema for the bounded reflection task — distilling recurring
// user corrections into candidate org lessons. Deliberately small: at most a
// handful of short notes, because everything here is injected back into
// future prompts as untrusted data.
import { z } from "zod";

export const reflectionOutputSchema = z.object({
  lessons: z
    .array(
      z.object({
        text: z
          .string()
          .describe(
            "One short, factual note about this organization's data, under 300 characters. No instructions, no rules about how to behave — just a fact, e.g. 'Invoices from ACME GmbH are billed in EUR'.",
          ),
        sourceFeedbackIds: z
          .array(z.string())
          .catch([])
          .describe("IDs of the corrections that support this note"),
      }),
    )
    .describe("At most 5 candidate notes. Return an empty array when nothing recurs."),
});

export type ReflectionOutput = z.infer<typeof reflectionOutputSchema>;
