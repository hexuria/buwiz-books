/**
 * Declarative UI schema for review-agent configuration.
 *
 * Replaces the raw JSON textarea the page used to ship. Follows the pattern of
 * `src/lib/*-mapping-config.ts` — a typed config object plus a keyed registry, rendered by a
 * generic component — rather than reusing `CategoryMappingSettings`, which is hard-wired to
 * resolving rows to account ids.
 *
 * Lives in `src/lib/` rather than the route so tests and server code can import it without
 * pulling in a `.tsx` module.
 *
 * Bounds here MIRROR the server's `ruleConfigSchemas` in src/routes/api/-review-agents.ts. Keep
 * them in step: the point is that the client never sends a value the server will reject.
 */

export type AgentConfirmCopy = {
  title: string;
  body: string;
  confirmLabel: string;
};

export type AgentConfigEnumOption = {
  value: string;
  label: string;
  description?: string;
  /** Shown before the value is applied. For choices that switch a control off. */
  confirm?: AgentConfirmCopy;
};

export type AgentConfigField = {
  key: string;
  label: string;
  help?: string;
} & (
  | {
      kind: "number";
      min?: number;
      max?: number;
      step?: number;
      unit?: string;
      defaultValue: number;
    }
  | { kind: "percent"; min?: number; max?: number; step?: number; defaultValue: number }
  | { kind: "money"; min?: number; currencyKey?: string; defaultValue: number }
  | { kind: "enum"; options: AgentConfigEnumOption[]; defaultValue: string }
  | { kind: "currency"; defaultValue: string }
);

/**
 * When the agent actually evaluates.
 *
 * Authoritative — do NOT derive this from the definition's `group`. The DB split is only
 * 14/16 true: `transaction_in_parent_category` is in the review group but also runs at ingest
 * (src/lib/inbox/rules.ts), and `low_confidence_category` is a book rule that reads a field
 * which does not survive posting, so the on-demand run can never evaluate it.
 */
export type AgentCadence = "ingest" | "on_demand" | "ingest_and_on_demand" | "system";

export const CADENCE_COPY: Record<AgentCadence, string> = {
  ingest: "Runs automatically on every transaction that enters the Inbox.",
  on_demand: "Runs when you press Run review agents. It does not run on its own.",
  ingest_and_on_demand:
    "Runs automatically at ingest, and again over the posted ledger when you press Run review agents.",
  system: "Raised automatically by inbound processing. There is nothing to configure or run.",
};

export type AgentConfigSchema = {
  key: string;
  /** 2-4 bullets describing how the rule decides. Rendered as the numbered list. */
  method: string[];
  cadence: AgentCadence;
  /** Whether `lookbackMonths` affects this agent at all. */
  usesLookback: boolean;
  fields: AgentConfigField[];
  /** Config keys the editor must preserve verbatim but never show. */
  passthroughKeys?: string[];
  /** Fires when `enabled` is unchecked, for agents whose off switch is destructive. */
  disableConfirm?: AgentConfirmCopy;
  /** Extra caveat rendered under the cadence line. */
  cadenceNote?: string;
};

const INGEST_ONLY_METHOD = "Evaluated once, as the transaction reaches the Inbox.";

/**
 * Turning duplicate detection off is the single most consequential switch on this page, and
 * `duplicate-engine.ts` treats `enabled: false` and `mode: "off"` identically — so both paths
 * get the same confirmation.
 */
const DUPLICATE_OFF_CONFIRM: AgentConfirmCopy = {
  title: "Turn off duplicate detection?",
  body: "While this is off, nothing is checked for duplicates — not imports, not inbound email, not manual entry. Existing duplicate cases stay, but no new ones are created. This is the only agent whose off switch can let the same bill into the ledger twice.",
  confirmLabel: "Turn detection off",
};

export const REVIEW_AGENT_SCHEMAS: Record<string, AgentConfigSchema> = {
  uncategorized: {
    key: "uncategorized",
    cadence: "ingest",
    usesLookback: false,
    method: [INGEST_ONLY_METHOD, "Raises a finding when any posting line has no real category."],
    fields: [],
  },
  low_confidence_category: {
    key: "low_confidence_category",
    cadence: "ingest",
    cadenceNote:
      "This agent is not part of the on-demand run — it reads a confidence score that only exists before the entry is posted.",
    usesLookback: false,
    method: [
      INGEST_ONLY_METHOD,
      "Reads the confidence score the classifier attached to each line.",
      "Raises a finding when the score falls below the threshold below.",
    ],
    fields: [
      {
        key: "threshold",
        kind: "percent",
        label: "Confidence threshold",
        help: "Lines classified below this confidence are flagged. Stored as a fraction, so 0.8 means 80%.",
        min: 0.05,
        max: 1,
        step: 0.05,
        defaultValue: 0.8,
      },
    ],
  },
  missing_vendor: {
    key: "missing_vendor",
    cadence: "ingest",
    usesLookback: false,
    method: [INGEST_ONLY_METHOD, "Raises a finding on expense transactions with no vendor set."],
    fields: [],
  },
  missing_customer: {
    key: "missing_customer",
    cadence: "ingest",
    usesLookback: false,
    method: [INGEST_ONLY_METHOD, "Raises a finding on income transactions with no customer set."],
    fields: [],
  },
  missing_receipt: {
    key: "missing_receipt",
    cadence: "ingest",
    usesLookback: false,
    method: [
      INGEST_ONLY_METHOD,
      "Converts the transaction total into the threshold currency at the entry's exchange rate.",
      "Raises a finding when it exceeds the threshold and no receipt is attached.",
    ],
    fields: [
      {
        key: "threshold",
        kind: "money",
        label: "Receipt required above",
        help: "Expenses at or below this amount don't need a receipt.",
        min: 0,
        currencyKey: "currency",
        defaultValue: 75,
      },
      {
        key: "currency",
        kind: "currency",
        label: "Threshold currency",
        defaultValue: "USD",
      },
    ],
  },
  missing_invoice: {
    key: "missing_invoice",
    cadence: "ingest",
    usesLookback: false,
    method: [
      INGEST_ONLY_METHOD,
      "Looks for a credit to your mapped Accounts Payable account.",
      "Raises a finding when no invoice or bill document is attached.",
    ],
    fields: [],
  },
  missing_department: {
    key: "missing_department",
    cadence: "ingest",
    usesLookback: false,
    method: [INGEST_ONLY_METHOD, "Raises a finding when no line carries a department."],
    fields: [],
  },
  missing_location: {
    key: "missing_location",
    cadence: "ingest",
    usesLookback: false,
    method: [INGEST_ONLY_METHOD, "Raises a finding when no line carries a location."],
    fields: [],
  },
  possible_duplicate: {
    key: "possible_duplicate",
    cadence: "ingest",
    usesLookback: false,
    method: [
      "Compares each arriving transaction against recent ones from every other source.",
      "Scores each candidate pair on amount, date, party, and attached document hashes.",
      "Opens a duplicate case when the score reaches the blocking score below.",
    ],
    // Read by duplicate-engine.ts but not user-facing. It survived the old textarea only because
    // the user could see and retype it; a field-driven editor has to preserve it deliberately.
    passthroughKeys: ["algorithmVersion"],
    disableConfirm: DUPLICATE_OFF_CONFIRM,
    fields: [
      {
        key: "mode",
        kind: "enum",
        label: "Detection mode",
        defaultValue: "enforce",
        options: [
          {
            value: "enforce",
            label: "Enforce — create blocking duplicate cases",
            description:
              "Matched transactions are held and need a structured decision before approval.",
          },
          {
            value: "shadow",
            label: "Shadow — record matches without blocking",
            description: "Matches are recorded for calibration. Approval is not blocked.",
          },
          {
            value: "off",
            label: "Off — do not check for duplicates",
            confirm: DUPLICATE_OFF_CONFIRM,
          },
        ],
      },
      {
        key: "matchWindowDays",
        kind: "number",
        label: "Match window",
        help: "How far apart two transactions can be dated and still be considered the same event.",
        min: 0,
        max: 31,
        step: 1,
        unit: "days",
        defaultValue: 3,
      },
      {
        key: "blockingScore",
        kind: "number",
        label: "Blocking score",
        help: "Match scores at or above this open a duplicate case that blocks approval.",
        min: 1,
        max: 100,
        step: 1,
        defaultValue: 70,
      },
      {
        key: "shadowScore",
        kind: "number",
        label: "Shadow score",
        help: "Match scores at or above this are recorded for review. Must be lower than the blocking score.",
        min: 0,
        max: 99,
        step: 1,
        defaultValue: 50,
      },
      {
        key: "relatedAmountToleranceBps",
        kind: "number",
        label: "Amount tolerance",
        help: "How far two amounts can differ and still match, in basis points. 200 is 2%.",
        min: 0,
        max: 10_000,
        step: 25,
        unit: "bps",
        defaultValue: 200,
      },
    ],
  },
  unusual_spend: {
    key: "unusual_spend",
    cadence: "on_demand",
    usesLookback: true,
    method: [
      "Totals each expense category by month across the lookback window.",
      "Needs at least three months of history before it will flag anything.",
      "Compares the latest month against the mean of the earlier months plus the deviations below.",
      "Raises one finding per category and month.",
    ],
    fields: [
      {
        key: "standardDeviations",
        kind: "number",
        label: "Standard deviations",
        help: "How far above its own baseline a category's month has to be. Lower flags more.",
        min: 0.5,
        max: 10,
        step: 0.5,
        defaultValue: 3,
      },
    ],
  },
  non_zero_clearing: {
    key: "non_zero_clearing",
    cadence: "on_demand",
    usesLookback: true,
    method: [
      "Walks every clearing account's running balance month by month.",
      "Raises a finding for each month inside the window that ended with a non-zero balance.",
    ],
    fields: [],
  },
  material_expense: {
    key: "material_expense",
    cadence: "on_demand",
    usesLookback: true,
    method: [
      "Averages monthly expenses across the lookback window, excluding payroll.",
      "Annualizes that average and takes the share below as the materiality threshold.",
      "Raises a finding for each posted transaction above it.",
    ],
    fields: [
      {
        key: "annualizedExpensePercent",
        kind: "percent",
        label: "Materiality threshold",
        help: "Share of annualized recent expenses above which a single transaction is material.",
        min: 0.1,
        max: 100,
        step: 0.1,
        defaultValue: 1,
      },
    ],
  },
  material_asset: {
    key: "material_asset",
    cadence: "on_demand",
    usesLookback: true,
    method: [
      "Takes the average month-end total assets across the lookback window.",
      "Uses the share below as the materiality threshold.",
      "Raises a finding for each investment asset transaction above it.",
    ],
    fields: [
      {
        key: "totalAssetPercent",
        kind: "percent",
        label: "Materiality threshold",
        help: "Share of average recent total assets above which an asset movement is material.",
        min: 0.1,
        max: 100,
        step: 0.1,
        defaultValue: 0.5,
      },
    ],
  },
  transaction_in_parent_category: {
    key: "transaction_in_parent_category",
    cadence: "ingest_and_on_demand",
    usesLookback: true,
    method: [
      "Finds categories that have children of their own.",
      "Raises a finding for each transaction posted directly to one instead of to a leaf.",
    ],
    fields: [],
  },
  source_processing_failed: {
    key: "source_processing_failed",
    cadence: "system",
    usesLookback: false,
    method: [
      "Raised when inbound processing has failed every retry.",
      "Clear it by retrying the source from the Inbox, or by documenting an exception.",
    ],
    fields: [],
  },
  source_evidence_incomplete: {
    key: "source_evidence_incomplete",
    cadence: "system",
    usesLookback: false,
    method: [
      "Raised when an inbound email arrives without the attachments needed to book it.",
      "Clear it by supplying the missing evidence, or by documenting an exception.",
    ],
    fields: [],
  },
};

export function getAgentSchema(key: string): AgentConfigSchema | undefined {
  return REVIEW_AGENT_SCHEMAS[key];
}

// ============================================================================
// Stored-config <-> form-state conversion
//
// This is where the data-loss risk lives, so it is pure and lives here rather than inside the
// route component: the old JSON textarea preserved unknown keys only because the user could see
// and retype them, and a field-driven editor has to carry them deliberately.
// ============================================================================

export type SplitConfig = {
  /** Form state, one string per visible field. */
  values: Record<string, string>;
  /** Every stored key with no visible field. Carried through a save untouched. */
  passthrough: Record<string, unknown>;
  /**
   * The subset of `passthrough` the schema does not explicitly expect — i.e. written by a newer
   * release. Surfaced read-only so the user knows it is there and is being kept.
   */
  hiddenAdvanced: Array<[string, unknown]>;
};

export function splitStoredConfig(
  schema: AgentConfigSchema | undefined,
  stored: Record<string, unknown>,
): SplitConfig {
  const fields = schema?.fields ?? [];
  const fieldKeys = new Set(fields.map((field) => field.key));
  const passthrough = Object.fromEntries(
    Object.entries(stored).filter(([key]) => !fieldKeys.has(key)),
  );
  const expected = new Set(schema?.passthroughKeys ?? []);
  return {
    values: Object.fromEntries(
      fields.map((field) => [field.key, String(stored[field.key] ?? field.defaultValue)]),
    ),
    passthrough,
    hiddenAdvanced: Object.entries(passthrough).filter(([key]) => !expected.has(key)),
  };
}

/**
 * Rebuild the config to save. Passthrough goes first so visible fields win on collision and
 * nothing stored is ever dropped.
 */
export function buildAgentConfigPayload(
  schema: AgentConfigSchema | undefined,
  values: Record<string, string>,
  passthrough: Record<string, unknown>,
): Record<string, string | number | boolean | null> {
  const config: Record<string, string | number | boolean | null> = {
    ...(passthrough as Record<string, string | number | boolean | null>),
  };
  for (const field of schema?.fields ?? []) {
    const raw = values[field.key] ?? "";
    config[field.key] = field.kind === "enum" || field.kind === "currency" ? raw : Number(raw);
  }
  return config;
}

/**
 * Bounds are checked client-side so a bad value never reaches the server as a generic Zod toast,
 * and `NaN` never reaches it at all. Mirrors `ruleConfigSchemas` in
 * src/routes/api/-review-agents.ts — keep the two in step.
 */
export function validateAgentConfig(
  fields: AgentConfigField[],
  values: Record<string, string>,
  lookback: string,
  usesLookback: boolean,
): Record<string, string> {
  const errors: Record<string, string> = {};
  for (const field of fields) {
    const raw = (values[field.key] ?? "").trim();
    if (field.kind === "currency") {
      if (!/^[A-Za-z]{3}$/.test(raw)) errors[field.key] = "Enter a 3-letter currency code.";
      continue;
    }
    if (field.kind === "enum") {
      if (!field.options.some((option) => option.value === raw)) {
        errors[field.key] = "Choose one of the listed options.";
      }
      continue;
    }
    const parsed = Number(raw);
    if (raw === "" || !Number.isFinite(parsed)) {
      errors[field.key] = "Enter a number.";
      continue;
    }
    if (field.min !== undefined && parsed < field.min) {
      errors[field.key] = `Must be at least ${field.min}.`;
    }
    if (field.kind !== "money" && field.max !== undefined && parsed > field.max) {
      errors[field.key] = `Must be at most ${field.max}.`;
    }
  }

  // Same rule and the same words as the server, so the two can never disagree.
  const blocking = Number(values.blockingScore);
  const shadow = Number(values.shadowScore);
  if (Number.isFinite(blocking) && Number.isFinite(shadow) && shadow >= blocking) {
    errors.shadowScore = "Shadow score must be lower than the blocking score.";
  }

  if (usesLookback) {
    const months = Number(lookback.trim());
    if (!Number.isInteger(months) || months < 1 || months > 24) {
      errors.lookbackMonths = "Enter a whole number of months between 1 and 24.";
    }
  }
  return errors;
}
