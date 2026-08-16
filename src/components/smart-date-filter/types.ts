// ============================================================================
// Smart Date Filter — Types
// ============================================================================

/** Preset date range identifiers */
export type DatePreset =
  | "today"
  | "yesterday"
  | "last_7_days"
  | "last_30_days"
  | "this_month"
  | "last_month"
  | "this_quarter"
  | "last_quarter"
  | "this_year"
  | "last_year"
  | "year_to_date"
  | "custom";

/** Granularity for the custom picker tabs */
export type DateGranularity = "day" | "month" | "quarter" | "year";

/** Result from applying a preset or AI parse */
export interface DateFilterResult {
  type: "single" | "range" | "multiple";
  startDate: string; // YYYY-MM-DD
  endDate?: string; // YYYY-MM-DD
  dates?: string[]; // YYYY-MM-DD[] for multiple
  label: string;
}

/** Response shape from Gemini AI date parsing */
export interface AIDateParseResult {
  type: "single" | "range" | "multiple";
  start_date: string;
  end_date?: string;
  dates?: string[];
  interpretation: string;
  confidence: number;
}

/** Preset option for the combo box list */
export interface PresetOption {
  value: DatePreset;
  label: string;
  shortcut?: string;
}
