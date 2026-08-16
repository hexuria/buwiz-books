// Zod output schema for the natural-language date parse task.
// Mirrors the Gemini responseSchema in src/routes/api/-ai-date-parse.ts.
import { z } from "zod";

const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Expected YYYY-MM-DD");

export const dateParseOutputSchema = z.object({
  type: z
    .enum(["single", "range", "multiple"])
    .describe("single for one date, range for start-end, multiple for a list of dates"),
  start_date: ymd.describe("Start date in YYYY-MM-DD format"),
  end_date: ymd.describe("End date in YYYY-MM-DD format (for range type)").optional(),
  dates: z.array(ymd).describe("List of dates in YYYY-MM-DD format (for multiple type)").optional(),
  interpretation: z.string().describe("Brief human-readable interpretation of the query"),
  confidence: z.number().describe("Confidence score from 0.0 to 1.0"),
});

export type DateParseOutput = z.infer<typeof dateParseOutputSchema>;
