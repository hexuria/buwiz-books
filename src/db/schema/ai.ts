/**
 * AI Schema — telemetry, proposals, and feedback.
 *
 * ai_invocations: one row per model call — the provenance floor for cost
 * tracking, eval curation, and regression attribution (AI_NATIVE_ARCHITECTURE
 * §8). Append-only; written on the raw pool connection (NOT ctx.db) so a row
 * survives the caller's transaction rollback — a failed statement upload is
 * exactly the telemetry you want to keep.
 *
 * ai_action_proposals: THE single approval primitive. Model output that wants
 * to become a write lands here as a typed payload; deterministic appliers plus
 * humans (or, from Phase 5, an earned auto-apply policy) apply it. Nothing AI
 * ever writes to master data or the ledger except through an applier.
 *
 * ai_run_feedback: ground-truth labels for the self-improvement flywheel —
 * one row per human verdict on a proposal, schema-uniform across features.
 *
 * ai_autonomy_lanes: earned autonomy per LANE rather than per proposal kind —
 * one vendor and one kind of paper (Inbox v2 spec §8). A lane's feedback rows
 * carry its id, so its eligibility, calibration, and demotion are computed
 * over that lane alone.
 */
import { sql } from "drizzle-orm";
import {
  pgTable,
  uuid,
  text,
  varchar,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  boolean,
  check,
} from "drizzle-orm/pg-core";
import { organization, user } from "./auth";
import { parties } from "./parties";

export const aiInvocations = pgTable(
  "ai_invocations",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    // Fine-grained task name, e.g. "statement_ocr", "transaction_parse"
    task: text("task").notNull(),

    // Prompt registry provenance (populated from Phase 1's registry onward)
    promptName: text("prompt_name"),
    promptVersion: text("prompt_version"),
    schemaHash: text("schema_hash"),

    // Model provenance — the RESOLVED pinned model string, never an alias
    provider: text("provider").notNull().default("gemini"),
    model: text("model"),
    chainPosition: integer("chain_position"),
    escalationReason: text("escalation_reason"),
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>(),

    // Usage + cost (costUsd populated once the pricing table lands, Phase 5)
    tokensIn: integer("tokens_in"),
    tokensOut: integer("tokens_out"),
    imageTokens: integer("image_tokens"),
    costUsd: numeric("cost_usd"),
    latencyMs: integer("latency_ms"),

    // Outcome — "repaired" is used from the Phase-5 repair loop onward
    validationOutcome: text("validation_outcome").$type<"valid" | "repaired" | "failed">(),
    errorMessage: text("error_message"),

    // Pipeline linkage (Phase 2's agent_run_steps) + request correlation
    agentRunStepId: uuid("agent_run_step_id"),
    requestId: text("request_id"),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_invocations_org_created_idx").on(table.organizationId, table.createdAt),
    index("ai_invocations_org_task_idx").on(table.organizationId, table.task),
  ],
);

export type AiProposalKind =
  | "match"
  | "categorize"
  | "create_txn"
  | "create_party"
  | "date_fix"
  | "split"
  | "document_type"
  | "prefill"
  // One BATCH proposal per scaffold run, not one per account: drafted accounts
  // reference each other as parents, and per-account rows would let a single
  // onboarding click emit 60 "accepted" feedback labels — inflating the
  // earned-autonomy denominator that computeAutonomyEligibility counts.
  | "coa_accounts"
  | "category_mapping";

export type AiProposalStatus =
  | "pending"
  | "approved"
  | "corrected"
  | "rejected"
  | "auto_applied"
  | "expired";

export const aiActionProposals = pgTable(
  "ai_action_proposals",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    kind: text("kind").$type<AiProposalKind>().notNull(),

    // Typed payload — validated against the proposal-types.ts discriminated
    // union on create AND re-validated by the applier before any write.
    proposal: jsonb("proposal").$type<Record<string, unknown>>().notNull(),

    // Which model call produced this (nullable: some proposals derive from
    // deterministic passes over model output)
    invocationId: uuid("invocation_id").references(() => aiInvocations.id),

    // 0–1. Match kinds are additionally structurally capped below the
    // auto-link threshold at their persistence choke point.
    confidence: numeric("confidence"),

    // UI anchoring: where this proposal surfaces (e.g. a document, a
    // statement line). { entityType: string, entityId: string }
    sourceRef: jsonb("source_ref").$type<{ entityType: string; entityId: string }>(),

    status: text("status").$type<AiProposalStatus>().notNull().default("pending"),

    createdBy: text("created_by"),
    approvedBy: text("approved_by"),
    appliedAt: timestamp("applied_at", { withTimezone: true }),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_action_proposals_org_status_idx").on(
      table.organizationId,
      table.status,
      table.createdAt,
    ),
    index("ai_action_proposals_org_kind_idx").on(table.organizationId, table.kind),
    index("ai_action_proposals_source_idx").on(table.organizationId, table.sourceRef),
  ],
);

export const aiRunFeedback = pgTable(
  "ai_run_feedback",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    proposalId: uuid("proposal_id").references(() => aiActionProposals.id),
    invocationId: uuid("invocation_id").references(() => aiInvocations.id),

    verdict: text("verdict").$type<"accepted" | "corrected" | "rejected">().notNull(),

    // The user's actual value when corrected — a field-level diff against the
    // proposed payload. This is the ground-truth label for evals.
    correction: jsonb("correction").$type<Record<string, unknown>>(),

    userId: text("user_id"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),

    // Earned autonomy per lane (migration 0060). A label on a paper Jev (or a
    // remembered answer) proposed names the lane it counts toward.
    laneId: uuid("lane_id").references(() => aiAutonomyLanes.id, { onDelete: "set null" }),
    // What the lane knew when the paper was proposed — confidence, whether Jev
    // would have approved it and why not, spot check — so agreement and
    // calibration can be computed per lane. Never read by the reflection job.
    laneEvidence: jsonb("lane_evidence").$type<Record<string, unknown>>(),
    // One label per proposal: a second human action on the same proposal (an
    // approval after a correction already labeled it) inserts nothing.
    labelKey: text("label_key"),
  },
  (table) => [
    index("ai_run_feedback_org_created_idx").on(table.organizationId, table.createdAt),
    index("ai_run_feedback_proposal_idx").on(table.proposalId),
    index("ai_run_feedback_org_lane_created_idx").on(
      table.organizationId,
      table.laneId,
      table.createdAt,
    ),
    uniqueIndex("ai_run_feedback_org_label_key_unique")
      .on(table.organizationId, table.labelKey)
      .where(sql`${table.labelKey} is not null`),
  ],
);

/**
 * ai_provider_health: cross-replica credential health. Replaces the
 * process-local healthMap in gemini-client (ai_findings #21) and keys on a
 * FINGERPRINT of the key material, not an array index — so removing a key
 * can't shift another key's cooldown onto it. Written on the raw pool so a
 * cooldown survives caller-transaction rollback.
 */
export const aiProviderHealth = pgTable(
  "ai_provider_health",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    /** sha256(key).slice(0,32) — never the key itself. */
    credentialFingerprint: text("credential_fingerprint").notNull(),

    consecutiveFailures: integer("consecutive_failures").default(0).notNull(),
    lockoutLevel: integer("lockout_level").default(0).notNull(),
    cooldownUntil: timestamp("cooldown_until", { withTimezone: true }),
    invalid: boolean("invalid").default(false).notNull(),
    lastErrorClass: text("last_error_class"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ai_provider_health_org_fingerprint_unique").on(
      table.organizationId,
      table.credentialFingerprint,
    ),
  ],
);

/**
 * organization_ai_credentials: per-provider BYOK credentials, generalizing
 * the Gemini-shaped organization_secrets.geminiApiKeys column. Rows (not
 * array positions) give each credential a stable identity for health
 * tracking, revocation, and masking. Gemini keys keep working from the
 * legacy column until backfilled — see src/lib/ai/credentials.ts.
 */
export const organizationAiCredentials = pgTable(
  "organization_ai_credentials",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    provider: text("provider")
      .$type<"gemini" | "anthropic" | "openai" | "openai_compatible" | "jev">()
      .notNull(),
    /** crypto.ts AES-256-GCM envelope: enc:v1:<iv>:<tag>:<ct>. Never plaintext. */
    encryptedKey: text("encrypted_key").notNull(),
    /**
     * openai_compatible only (vLLM/Ollama/OpenRouter/…). Jev's endpoint is
     * operator config (JEV_BASE_URL), never a tenant-supplied row value.
     */
    baseUrl: text("base_url"),
    label: text("label"),
    lastUsedAt: timestamp("last_used_at", { withTimezone: true }),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("organization_ai_credentials_org_provider_idx").on(table.organizationId, table.provider),
  ],
);

export type AiAutonomyLevel = "suggest" | "auto_apply_high_confidence";

/**
 * organization_ai_settings: THE home for per-org AI configuration
 * (AI_NATIVE_ARCHITECTURE §1). Created with the full column set; the
 * autonomy/spend/kill-switch columns are inert until Phase 5 wires them, so
 * safe defaults matter: autonomy is empty (⇒ "suggest" everywhere) and the
 * kill switch is off.
 *
 * Orgs parameterize AI behavior here; they never author prompt TEXT — that
 * would put tenant-controlled strings next to instructions.
 */
export const organizationAiSettings = pgTable(
  "organization_ai_settings",
  {
    organizationId: text("organization_id").primaryKey(),
    /** Per-task chain overrides; OCR tasks are policy-filtered to Gemini. */
    taskChains: jsonb("task_chains").$type<Record<string, unknown>>(),
    /** Per-task escalation thresholds, 0–1. */
    confidenceThresholds: jsonb("confidence_thresholds").$type<Record<string, number>>(),
    /** Per-task autonomy; absent ⇒ "suggest". Never applies to match kinds. */
    autonomy: jsonb("autonomy").$type<Record<string, AiAutonomyLevel>>(),
    /** Tasks this org permits at all; absent ⇒ all shipped tasks. */
    taskAllowlist: jsonb("task_allowlist").$type<string[]>(),
    /**
     * Providers this org permits; absent ⇒ Gemini only. "jev" here is also the
     * Jev opt-in: Jev becomes the first hop for the redacted-text
     * classification tasks in JEV_TASKS (src/lib/ai/chains.ts applyJevPolicy).
     */
    providerAllowlist: jsonb("provider_allowlist").$type<string[]>(),
    monthlySpendCapUsd: numeric("monthly_spend_cap_usd"),
    killSwitch: boolean("kill_switch").default(false).notNull(),
    /** Eval-data sharing consent — anonymization alone is not consent (§8). */
    evalDataSharing: text("eval_data_sharing").$type<"none" | "global">().default("none").notNull(),
    evalConsentBy: text("eval_consent_by"),
    evalConsentAt: timestamp("eval_consent_at", { withTimezone: true }),
    updatedBy: text("updated_by"),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),

    // ── Jev approval (Inbox v2 §8, migration 0060). Admin-only, off by default.
    /**
     * The organization's switch for Jev approving Inbox papers on its own. Off
     * means no lane approves anything, whatever its level: lanes keep watching.
     */
    inboxAutoapproveEnabled: boolean("inbox_autoapprove_enabled").default(false).notNull(),
    /**
     * When the org requires a different approver (maker-checker), Jev approval is
     * off unless an admin opts in here explicitly (spec §2).
     */
    inboxAutoapproveWithMakerChecker: boolean("inbox_autoapprove_with_maker_checker")
      .default(false)
      .notNull(),
    /** Share of would-be Jev approvals held back for a person, 0–1. */
    inboxSpotCheckRate: numeric("inbox_spot_check_rate", { precision: 5, scale: 4 })
      .default("0.1000")
      .notNull(),
    /** Per-org salt for the spot-check hash, so samples are not predictable from ids. */
    inboxSpotCheckSalt: uuid("inbox_spot_check_salt").defaultRandom().notNull(),
  },
  (table) => [
    check(
      "organization_ai_settings_spot_check_rate_check",
      sql`${table.inboxSpotCheckRate} >= 0 and ${table.inboxSpotCheckRate} <= 1`,
    ),
  ],
);

export const AUTONOMY_LANE_LEVELS = ["watch", "suggest", "auto"] as const;
export type AutonomyLaneLevel = (typeof AUTONOMY_LANE_LEVELS)[number];

/** Lanes that exist. A new lane key is a reviewed migration (the CHECK below). */
export const AUTONOMY_LANE_KEYS = ["inbox_approve"] as const;
export type AutonomyLaneKey = (typeof AUTONOMY_LANE_KEYS)[number];

/**
 * ai_autonomy_lanes: earned Jev approval, one vendor and one kind of paper at
 * a time (Inbox v2 spec §8). Per-kind autonomy (organization_ai_settings
 * .autonomy) cannot express "Jev may approve this vendor's bills but not that
 * one's", so each lane earns its own authority from its own feedback:
 *
 *   watch    created at first sight; Jev's answers are labeled and "would
 *            approve" is logged, nothing else changes.
 *   suggest  promoted by an admin; the Inbox says when Jev would approve.
 *   auto     promoted by an admin; Jev approves papers that pass every check
 *            (src/lib/inbox/jev-approval/predicate.ts), minus a spot-check
 *            sample. Demoted to suggest automatically when quality slips.
 *
 * An `auto` lane must name its vendor, its amount cap and its calibrated
 * confidence threshold — the database refuses one that does not.
 *
 * Export/import: org configuration that joins the version-5 bump (spec build
 * step 12). Deliberately NOT exported yet.
 */
export const aiAutonomyLanes = pgTable(
  "ai_autonomy_lanes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id")
      .references(() => organization.id, { onDelete: "cascade" })
      .notNull(),
    laneKey: varchar("lane_key", { length: 64 }).$type<AutonomyLaneKey>().notNull(),
    /** The vendor or customer. Null is the lane for papers with no known party. */
    partyId: uuid("party_id").references(() => parties.id, { onDelete: "cascade" }),
    /** The kind of paper (src/lib/inbox/v2/triage.ts INBOX_V2_KINDS). */
    docKind: varchar("doc_kind", { length: 32 }),
    level: varchar("level", { length: 16 }).$type<AutonomyLaneLevel>().default("watch").notNull(),
    /** Largest functional-currency total Jev may approve on this lane. */
    amountCap: numeric("amount_cap", { precision: 20, scale: 8 }),
    /** Chosen at promotion; the lane's reliability table must support it. */
    confidenceThreshold: numeric("confidence_threshold", { precision: 5, scale: 4 }),
    promotedBy: text("promoted_by").references(() => user.id),
    promotedAt: timestamp("promoted_at", { withTimezone: true }),
    demotedAt: timestamp("demoted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("ai_autonomy_lanes_identity_unique").on(
      table.organizationId,
      table.laneKey,
      table.partyId,
      table.docKind,
    ),
    // NULLs are distinct in a unique index (and NULLS NOT DISTINCT needs
    // Postgres 15), so the no-party lane gets its own guard.
    uniqueIndex("ai_autonomy_lanes_partyless_unique")
      .on(table.organizationId, table.laneKey, table.docKind)
      .where(sql`${table.partyId} is null`),
    index("ai_autonomy_lanes_org_level_idx").on(table.organizationId, table.laneKey, table.level),
    check("ai_autonomy_lanes_level_check", sql`${table.level} in ('watch', 'suggest', 'auto')`),
    check("ai_autonomy_lanes_lane_key_check", sql`${table.laneKey} in ('inbox_approve')`),
    check(
      "ai_autonomy_lanes_threshold_range_check",
      sql`${table.confidenceThreshold} is null or (${table.confidenceThreshold} > 0 and ${table.confidenceThreshold} <= 1)`,
    ),
    check(
      "ai_autonomy_lanes_amount_cap_check",
      sql`${table.amountCap} is null or ${table.amountCap} > 0`,
    ),
    check(
      "ai_autonomy_lanes_auto_limits_check",
      sql`${table.level} <> 'auto' or (${table.partyId} is not null and ${table.amountCap} is not null and ${table.confidenceThreshold} is not null)`,
    ),
  ],
);

/**
 * ai_lessons: per-org memory distilled from recurring corrections.
 *
 * Deliberately constrained (SELF_IMPROVING threat model): human-approved,
 * size-capped, expiring, and injected into prompts as JSON *data* behind an
 * untrusted-content preamble — never as instruction text, and never able to
 * touch schemas, graders, or permissions.
 */
export const aiLessons = pgTable(
  "ai_lessons",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    organizationId: text("organization_id").notNull(),
    task: text("task").notNull(),
    /** Short factual note, e.g. "Invoices from ACME bill in EUR". */
    lesson: text("lesson").notNull(),
    sourceFeedbackIds: jsonb("source_feedback_ids").$type<string[]>(),
    status: text("status").$type<"proposed" | "active" | "retired">().notNull().default("proposed"),
    approvedBy: text("approved_by"),
    expiresAt: timestamp("expires_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("ai_lessons_org_task_status_idx").on(table.organizationId, table.task, table.status),
  ],
);

/**
 * ai_eval_cases: curated regression cases.
 *
 * organizationId NULL = the cross-org golden set, which a case may only join
 * with EXPLICIT org consent (§8: anonymization is necessary but not
 * sufficient). piiRedacted records that the input went through redact.ts.
 */
export const aiEvalCases = pgTable(
  "ai_eval_cases",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** NULL ⇒ global golden set (opt-in only). */
    organizationId: text("organization_id"),
    task: text("task").notNull(),
    inputRef: jsonb("input_ref").$type<Record<string, unknown>>().notNull(),
    expected: jsonb("expected").$type<Record<string, unknown>>().notNull(),
    provenance: text("provenance").$type<"curated_from_feedback" | "authored">().notNull(),
    piiRedacted: boolean("pii_redacted").default(false).notNull(),
    orgConsentAt: timestamp("org_consent_at", { withTimezone: true }),
    promptVersionAtCapture: text("prompt_version_at_capture"),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [index("ai_eval_cases_task_idx").on(table.task)],
);

export type AgentRunKind =
  | "statement_pipeline"
  | "bbox_scan"
  | "match_assist"
  | "eval_run"
  | "coa_scaffold";
export type AgentRunStatus = "running" | "blocked" | "completed" | "failed";
export type AgentRunStepStatus = "running" | "completed" | "failed";

/**
 * agent_runs / agent_run_steps: the pipeline run ledger — code-owned routing
 * with typed state and per-step provenance (the durable "graph engineering"
 * primitives, without a graph executor). A crash resumes from the last
 * completed step; an auditor can replay every edge taken.
 */
export const agentRuns = pgTable(
  "agent_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    kind: text("kind").$type<AgentRunKind>().notNull(),
    status: text("status").$type<AgentRunStatus>().notNull().default("running"),

    // Prompt versions, chains, thresholds active for THIS run — regression
    // attribution and historical replay depend on it.
    configSnapshot: jsonb("config_snapshot").$type<Record<string, unknown>>(),

    // Why the run blocked (e.g. validation gate) — surfaced to the client.
    blockedReason: jsonb("blocked_reason").$type<Record<string, unknown>>(),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("agent_runs_org_kind_idx").on(table.organizationId, table.kind)],
);

export const agentRunSteps = pgTable(
  "agent_run_steps",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    runId: uuid("run_id")
      .references(() => agentRuns.id)
      .notNull(),

    step: text("step").notNull(),
    status: text("status").$type<AgentRunStepStatus>().notNull().default("running"),

    // IDs/refs only — never blobs.
    inputRef: jsonb("input_ref").$type<Record<string, unknown>>(),
    outputRef: jsonb("output_ref").$type<Record<string, unknown>>(),

    processingJobId: uuid("processing_job_id"),
    error: jsonb("error").$type<Record<string, unknown>>(),

    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    finishedAt: timestamp("finished_at", { withTimezone: true }),
  },
  (table) => [index("agent_run_steps_run_idx").on(table.runId, table.startedAt)],
);

/**
 * vendor_aliases: per-org memory mapping raw statement descriptors
 * ("AMZN Mktp US*2K3AB") to parties — populated from accepted matches,
 * consumed by match-assist blocking. Matching is normalized-descriptor exact
 * plus pg_trgm similarity; an embedding column arrives via a
 * pgvector-guarded migration on environments that have the extension
 * (local dev may not — see drizzle/0027_vendor_aliases.sql).
 */
export const vendorAliases = pgTable(
  "vendor_aliases",
  {
    id: uuid("id").primaryKey().defaultRandom(),

    // Tenant scoping
    organizationId: text("organization_id").notNull(),

    normalizedDescriptor: text("normalized_descriptor").notNull(),
    partyId: uuid("party_id").notNull(),

    source: text("source").$type<"user_match" | "llm_suggestion_accepted">().notNull(),

    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("vendor_aliases_org_descriptor_unique").on(
      table.organizationId,
      table.normalizedDescriptor,
    ),
  ],
);
