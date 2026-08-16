// ============================================================================
// AI Date Parse — Server Function
// Parses natural language date queries into structured dates.
// Model access goes through the aiComplete façade (prompt registry +
// schema-validated output + telemetry).
// ============================================================================

import { createServerFn } from "@tanstack/react-start";
import { GeminiRateLimitError } from "../../lib/gemini-client";
import { aiComplete } from "../../lib/ai/facade";
import { dateParseOutputSchema } from "../../lib/ai/schemas/date-parse";
import { withMutationPermissionOrgContext } from "../../lib/server-context";
import { z } from "zod";

const parseDateInputSchema = z.object({
  query: z.string().min(1),
  currentDate: z.string().min(1),
});

/**
 * Parse a natural language date query using Gemini AI.
 * Called server-side only — keeps API key secure.
 */
export const parseNaturalDate = createServerFn({ method: "POST" })
  .inputValidator((data: z.input<typeof parseDateInputSchema>) => parseDateInputSchema.parse(data))
  .handler(async ({ data: rawData }: { data: unknown }) => {
    // Read-only AI task: aiTask:run alone suffices (no underlying resource
    // is written). This is the ai_findings #16 fix — clientApprover can now
    // use the date filter without holding document:upload.
    return withMutationPermissionOrgContext(
      "aiTask",
      "run",
      { routeKey: "ai:date-parse", limit: 60, windowMs: 300_000 },
      async ({ orgId }) => {
        const { query, currentDate } = parseDateInputSchema.parse(rawData);

        try {
          const result = await aiComplete<z.infer<typeof dateParseOutputSchema>>({
            task: "date_parse",
            input: { query, currentDate },
            ctx: { orgId },
          });
          if (!result.ok) {
            throw new Error("AI returned an invalid response — please try again.");
          }
          return result.data;
        } catch (err) {
          if (err instanceof GeminiRateLimitError) {
            throw new Error(err.message);
          }
          throw err;
        }
      },
    ) as any;
  });
