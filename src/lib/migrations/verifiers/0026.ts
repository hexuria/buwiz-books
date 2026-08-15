import type { VerificationContext } from "../engine";
import type {
  CatalogExpectation,
  CatalogSnapshot,
  ConstraintExpectation,
  IndexExpectation,
  RelationExpectation,
} from "./catalog";
import {
  column,
  createdAt,
  exactTable,
  foreignKey,
  idColumn,
  index,
  knownConstraintName,
  primaryKey,
  updatedAt,
  verifier,
} from "./expectations";

const relations0026: RelationExpectation[] = [
  exactTable("ai_invocations", [
    idColumn,
    column("organization_id", "text", true),
    column("task", "text", true),
    column("prompt_name", "text", false),
    column("prompt_version", "text", false),
    column("schema_hash", "text", false),
    column("provider", "text", true, "'gemini'::text"),
    column("model", "text", false),
    column("chain_position", "integer", false),
    column("escalation_reason", "text", false),
    column("config_snapshot", "jsonb", false),
    column("tokens_in", "integer", false),
    column("tokens_out", "integer", false),
    column("image_tokens", "integer", false),
    column("cost_usd", "numeric", false),
    column("latency_ms", "integer", false),
    column("validation_outcome", "text", false),
    column("error_message", "text", false),
    column("agent_run_step_id", "uuid", false),
    column("request_id", "text", false),
    createdAt,
  ]),
  exactTable("ai_action_proposals", [
    idColumn,
    column("organization_id", "text", true),
    column("kind", "text", true),
    column("proposal", "jsonb", true),
    column("invocation_id", "uuid", false),
    column("confidence", "numeric", false),
    column("source_ref", "jsonb", false),
    column("status", "text", true, "'pending'::text"),
    column("created_by", "text", false),
    column("approved_by", "text", false),
    column("applied_at", "timestamp with time zone", false),
    column("expires_at", "timestamp with time zone", false),
    createdAt,
  ]),
  exactTable("ai_run_feedback", [
    idColumn,
    column("organization_id", "text", true),
    column("proposal_id", "uuid", false),
    column("invocation_id", "uuid", false),
    column("verdict", "text", true),
    column("correction", "jsonb", false),
    column("user_id", "text", false),
    createdAt,
  ]),
  exactTable("agent_runs", [
    idColumn,
    column("organization_id", "text", true),
    column("kind", "text", true),
    column("status", "text", true, "'running'::text"),
    column("config_snapshot", "jsonb", false),
    column("blocked_reason", "jsonb", false),
    column("started_at", "timestamp with time zone", true, "now()"),
    column("finished_at", "timestamp with time zone", false),
  ]),
  exactTable("agent_run_steps", [
    idColumn,
    column("organization_id", "text", true),
    column("run_id", "uuid", true),
    column("step", "text", true),
    column("status", "text", true, "'running'::text"),
    column("input_ref", "jsonb", false),
    column("output_ref", "jsonb", false),
    column("processing_job_id", "uuid", false),
    column("error", "jsonb", false),
    column("started_at", "timestamp with time zone", true, "now()"),
    column("finished_at", "timestamp with time zone", false),
  ]),
  exactTable("ai_provider_health", [
    idColumn,
    column("organization_id", "text", true),
    column("credential_fingerprint", "text", true),
    column("consecutive_failures", "integer", true, "0"),
    column("lockout_level", "integer", true, "0"),
    column("cooldown_until", "timestamp with time zone", false),
    column("invalid", "boolean", true, "false"),
    column("last_error_class", "text", false),
    column("last_used_at", "timestamp with time zone", false),
    updatedAt,
  ]),
  exactTable("organization_ai_credentials", [
    idColumn,
    column("organization_id", "text", true),
    column("provider", "text", true),
    column("encrypted_key", "text", true),
    column("base_url", "text", false),
    column("label", "text", false),
    column("last_used_at", "timestamp with time zone", false),
    column("revoked_at", "timestamp with time zone", false),
    createdAt,
    updatedAt,
  ]),
  exactTable("organization_ai_settings", [
    column("organization_id", "text", true),
    column("task_chains", "jsonb", false),
    column("confidence_thresholds", "jsonb", false),
    column("autonomy", "jsonb", false),
    column("task_allowlist", "jsonb", false),
    column("provider_allowlist", "jsonb", false),
    column("monthly_spend_cap_usd", "numeric", false),
    column("kill_switch", "boolean", true, "false"),
    column("eval_data_sharing", "text", true, "'none'::text"),
    column("eval_consent_by", "text", false),
    column("eval_consent_at", "timestamp with time zone", false),
    column("updated_by", "text", false),
    updatedAt,
  ]),
  exactTable("ai_lessons", [
    idColumn,
    column("organization_id", "text", true),
    column("task", "text", true),
    column("lesson", "text", true),
    column("source_feedback_ids", "jsonb", false),
    column("status", "text", true, "'proposed'::text"),
    column("approved_by", "text", false),
    column("expires_at", "timestamp with time zone", false),
    createdAt,
  ]),
  exactTable("ai_eval_cases", [
    idColumn,
    column("organization_id", "text", false),
    column("task", "text", true),
    column("input_ref", "jsonb", true),
    column("expected", "jsonb", true),
    column("provenance", "text", true),
    column("pii_redacted", "boolean", true, "false"),
    column("org_consent_at", "timestamp with time zone", false),
    column("prompt_version_at_capture", "text", false),
    createdAt,
  ]),
  exactTable("statement_line_matches", [
    idColumn,
    column("organization_id", "text", true),
    column("statement_line_id", "uuid", true),
    column("journal_line_id", "uuid", true),
    column("allocated_amount", "numeric(15,2)", true),
    column("created_at", "timestamp without time zone", true, "now()"),
  ]),
];

const indexes0026: IndexExpectation[] = [
  index("ai_invocations_org_created_idx", "ai_invocations", ["organization_id", "created_at"]),
  index("ai_invocations_org_task_idx", "ai_invocations", ["organization_id", "task"]),
  index("ai_action_proposals_org_status_idx", "ai_action_proposals", [
    "organization_id",
    "status",
    "created_at",
  ]),
  index("ai_action_proposals_org_kind_idx", "ai_action_proposals", ["organization_id", "kind"]),
  index("ai_action_proposals_source_idx", "ai_action_proposals", ["organization_id", "source_ref"]),
  index("ai_run_feedback_org_created_idx", "ai_run_feedback", ["organization_id", "created_at"]),
  index("ai_run_feedback_proposal_idx", "ai_run_feedback", ["proposal_id"]),
  index("agent_runs_org_kind_idx", "agent_runs", ["organization_id", "kind"]),
  index("agent_run_steps_run_idx", "agent_run_steps", ["run_id", "started_at"]),
  index(
    "ai_provider_health_org_fingerprint_unique",
    "ai_provider_health",
    ["organization_id", "credential_fingerprint"],
    { unique: true },
  ),
  index("organization_ai_credentials_org_provider_idx", "organization_ai_credentials", [
    "organization_id",
    "provider",
  ]),
  index("ai_lessons_org_task_status_idx", "ai_lessons", ["organization_id", "task", "status"]),
  index("ai_eval_cases_task_idx", "ai_eval_cases", ["task"]),
  index("statement_line_matches_line_idx", "statement_line_matches", ["statement_line_id"]),
  index(
    "statement_line_matches_journal_line_unique",
    "statement_line_matches",
    ["journal_line_id"],
    { unique: true },
  ),
  index(
    "statement_line_matches_pair_unique",
    "statement_line_matches",
    ["statement_line_id", "journal_line_id"],
    { unique: true },
  ),
];

const constraints0026: ConstraintExpectation[] = [
  ...relations0026.map((relation) =>
    primaryKey(relation.name, [
      relation.name === "organization_ai_settings" ? "organization_id" : "id",
    ]),
  ),
  foreignKey(
    "ai_action_proposals",
    "ai_action_proposals_invocation_id_ai_invocations_id_fk",
    ["invocation_id"],
    "ai_invocations",
    ["id"],
  ),
  foreignKey(
    "ai_run_feedback",
    "ai_run_feedback_proposal_id_ai_action_proposals_id_fk",
    ["proposal_id"],
    "ai_action_proposals",
    ["id"],
  ),
  foreignKey(
    "ai_run_feedback",
    "ai_run_feedback_invocation_id_ai_invocations_id_fk",
    ["invocation_id"],
    "ai_invocations",
    ["id"],
  ),
  foreignKey(
    "agent_run_steps",
    "agent_run_steps_run_id_agent_runs_id_fk",
    ["run_id"],
    "agent_runs",
    ["id"],
  ),
  foreignKey(
    "statement_line_matches",
    "statement_line_matches_statement_line_id_statement_lines_id_fk",
    ["statement_line_id"],
    "statement_lines",
    ["id"],
    "cascade",
  ),
  foreignKey(
    "statement_line_matches",
    "statement_line_matches_journal_line_id_journal_lines_id_fk",
    ["journal_line_id"],
    "journal_lines",
    ["id"],
  ),
];

const rawConstraintNames0026: Readonly<Record<string, string>> = {
  ai_action_proposals_invocation_id_ai_invocations_id_fk: "ai_action_proposals_invocation_id_fkey",
  ai_run_feedback_proposal_id_ai_action_proposals_id_fk: "ai_run_feedback_proposal_id_fkey",
  ai_run_feedback_invocation_id_ai_invocations_id_fk: "ai_run_feedback_invocation_id_fkey",
  agent_run_steps_run_id_agent_runs_id_fk: "agent_run_steps_run_id_fkey",
  statement_line_matches_statement_line_id_statement_lines_id_fk:
    "statement_line_matches_statement_line_id_fkey",
  statement_line_matches_journal_line_id_journal_lines_id_fk:
    "statement_line_matches_journal_line_id_fkey",
};

function expectation0026(
  snapshot: CatalogSnapshot,
  _context: VerificationContext,
): CatalogExpectation {
  return {
    relations: relations0026,
    indexes: indexes0026,
    constraints: constraints0026.map((item) => {
      const rawName = rawConstraintNames0026[item.name];
      if (!rawName) return item;
      // Both names are legitimate evidence of the same foreign key. 0026 writes
      // its references inline, so PostgreSQL generates `<table>_<column>_fkey`,
      // while a database synchronized from src/db/schema/ai.ts carries Drizzle's
      // explicit `<table>_<column>_<target>_<col>_fk`. Demanding the generated
      // name before execution made a pushed database look like it was missing six
      // foreign keys that it actually has under the other spelling, which left
      // 0026 partial and therefore neither executable nor adoptable.
      //
      // Only the label is allowed to vary: columns, referenced table, match type,
      // on-update/on-delete and validation are all still compared, and a
      // constraint under neither name is still absent.
      return {
        ...item,
        name: knownConstraintName(snapshot, item.tableName, [item.name, rawName]),
      };
    }),
  };
}

export const verifier0026 = verifier(
  "0026",
  expectation0026,
  (snapshot) =>
    relations0026.some((relation) => snapshot.relations.has(relation.name)) ||
    indexes0026.some((item) => snapshot.indexes.has(item.name)),
);
