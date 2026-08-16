// ============================================================================
// Prompt: date_parse — natural language date query → structured dates.
// Moved VERBATIM from src/routes/api/-ai-date-parse.ts (version 1.0.0 is
// byte-identical to the pre-registry prompt).
// ============================================================================

export interface DateParsePromptInput {
  query: string;
  currentDate: string;
}

export const dateParsePrompt = {
  id: "date-parse",
  version: "1.0.0",
  build(input: DateParsePromptInput): string {
    const dayOfWeek = new Date(input.currentDate + "T00:00:00").toLocaleDateString("en-US", {
      weekday: "long",
    });

    return `TODAY: ${dayOfWeek}, ${input.currentDate}
QUERY: "${input.query}"

Parse this date query into the required JSON format. For "multiple" type queries (e.g. "all Wednesdays in January"), compute and list each individual date. For range queries, provide start_date and end_date. For single date queries, provide just start_date. Always use YYYY-MM-DD format.`;
  },
};
