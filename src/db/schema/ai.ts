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
 */
import {
  pgTable,
  uuid,
  text,
  integer,
  numeric,
  jsonb,
  timestamp,
  index,
  uniqueIndex,
  boolean,
} from "drizzle-orm/pg-core";

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
  },
  (table) => [
    index("ai_run_feedback_org_created_idx").on(table.organizationId, table.createdAt),
    index("ai_run_feedback_proposal_idx").on(table.proposalId),
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
      .$type<"gemini" | "anthropic" | "openai" | "openai_compatible">()
      .notNull(),
    /** crypto.ts AES-256-GCM envelope: enc:v1:<iv>:<tag>:<ct>. Never plaintext. */
    encryptedKey: text("encrypted_key").notNull(),
    /** openai_compatible only (vLLM/Ollama/OpenRouter/…). */
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
export const organizationAiSettings = pgTable("organization_ai_settings", {
  organizationId: text("organization_id").primaryKey(),
  /** Per-task chain overrides; OCR tasks are policy-filtered to Gemini. */
  taskChains: jsonb("task_chains").$type<Record<string, unknown>>(),
  /** Per-task escalation thresholds, 0–1. */
  confidenceThresholds: jsonb("confidence_thresholds").$type<Record<string, number>>(),
  /** Per-task autonomy; absent ⇒ "suggest". Never applies to match kinds. */
  autonomy: jsonb("autonomy").$type<Record<string, AiAutonomyLevel>>(),
  /** Tasks this org permits at all; absent ⇒ all shipped tasks. */
  taskAllowlist: jsonb("task_allowlist").$type<string[]>(),
  /** Providers this org permits; absent ⇒ Gemini only. */
  providerAllowlist: jsonb("provider_allowlist").$type<string[]>(),
  monthlySpendCapUsd: numeric("monthly_spend_cap_usd"),
  killSwitch: boolean("kill_switch").default(false).notNull(),
  /** Eval-data sharing consent — anonymization alone is not consent (§8). */
  evalDataSharing: text("eval_data_sharing").$type<"none" | "global">().default("none").notNull(),
  evalConsentBy: text("eval_consent_by"),
  evalConsentAt: timestamp("eval_consent_at", { withTimezone: true }),
  updatedBy: text("updated_by"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});

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
