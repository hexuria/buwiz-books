-- ============================================================================
-- 0026 — AI foundation tables (ai_invocations, ai_action_proposals,
-- ai_run_feedback)
--
-- Idempotent, matches src/db/schema/ai.ts exactly. Applied out-of-band via
-- scripts/apply-ai-foundation.ts BEFORE `drizzle-kit push --force` in deploy:
-- push prompts interactively ("created or renamed from another table?") when
-- a NEW schema table appears next to unmanaged tables (app_manual_migrations),
-- which would hang a non-TTY deploy. Pre-creating the tables makes push see
-- no diff. RLS policies live in drizzle/rls_policies.sql as usual.
-- ============================================================================

CREATE TABLE IF NOT EXISTS ai_invocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  task text NOT NULL,
  prompt_name text,
  prompt_version text,
  schema_hash text,
  provider text NOT NULL DEFAULT 'gemini',
  model text,
  chain_position integer,
  escalation_reason text,
  config_snapshot jsonb,
  tokens_in integer,
  tokens_out integer,
  image_tokens integer,
  cost_usd numeric,
  latency_ms integer,
  validation_outcome text,
  error_message text,
  agent_run_step_id uuid,
  request_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_invocations_org_created_idx
  ON ai_invocations (organization_id, created_at);
CREATE INDEX IF NOT EXISTS ai_invocations_org_task_idx
  ON ai_invocations (organization_id, task);

CREATE TABLE IF NOT EXISTS ai_action_proposals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  kind text NOT NULL,
  proposal jsonb NOT NULL,
  invocation_id uuid REFERENCES ai_invocations(id),
  confidence numeric,
  source_ref jsonb,
  status text NOT NULL DEFAULT 'pending',
  created_by text,
  approved_by text,
  applied_at timestamptz,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_action_proposals_org_status_idx
  ON ai_action_proposals (organization_id, status, created_at);
CREATE INDEX IF NOT EXISTS ai_action_proposals_org_kind_idx
  ON ai_action_proposals (organization_id, kind);
CREATE INDEX IF NOT EXISTS ai_action_proposals_source_idx
  ON ai_action_proposals (organization_id, source_ref);

CREATE TABLE IF NOT EXISTS ai_run_feedback (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  proposal_id uuid REFERENCES ai_action_proposals(id),
  invocation_id uuid REFERENCES ai_invocations(id),
  verdict text NOT NULL,
  correction jsonb,
  user_id text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_run_feedback_org_created_idx
  ON ai_run_feedback (organization_id, created_at);
CREATE INDEX IF NOT EXISTS ai_run_feedback_proposal_idx
  ON ai_run_feedback (proposal_id);

CREATE TABLE IF NOT EXISTS agent_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  kind text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  config_snapshot jsonb,
  blocked_reason jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_runs_org_kind_idx ON agent_runs (organization_id, kind);

CREATE TABLE IF NOT EXISTS agent_run_steps (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  run_id uuid NOT NULL REFERENCES agent_runs(id),
  step text NOT NULL,
  status text NOT NULL DEFAULT 'running',
  input_ref jsonb,
  output_ref jsonb,
  processing_job_id uuid,
  error jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz
);
CREATE INDEX IF NOT EXISTS agent_run_steps_run_idx ON agent_run_steps (run_id, started_at);

CREATE TABLE IF NOT EXISTS ai_provider_health (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  credential_fingerprint text NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  lockout_level integer NOT NULL DEFAULT 0,
  cooldown_until timestamptz,
  invalid boolean NOT NULL DEFAULT false,
  last_error_class text,
  last_used_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS ai_provider_health_org_fingerprint_unique
  ON ai_provider_health (organization_id, credential_fingerprint);

CREATE TABLE IF NOT EXISTS organization_ai_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  provider text NOT NULL,
  encrypted_key text NOT NULL,
  base_url text,
  label text,
  last_used_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS organization_ai_credentials_org_provider_idx
  ON organization_ai_credentials (organization_id, provider);

CREATE TABLE IF NOT EXISTS organization_ai_settings (
  organization_id text PRIMARY KEY,
  task_chains jsonb,
  confidence_thresholds jsonb,
  autonomy jsonb,
  task_allowlist jsonb,
  provider_allowlist jsonb,
  monthly_spend_cap_usd numeric,
  kill_switch boolean NOT NULL DEFAULT false,
  eval_data_sharing text NOT NULL DEFAULT 'none',
  eval_consent_by text,
  eval_consent_at timestamptz,
  updated_by text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS ai_lessons (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  task text NOT NULL,
  lesson text NOT NULL,
  source_feedback_ids jsonb,
  status text NOT NULL DEFAULT 'proposed',
  approved_by text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_lessons_org_task_status_idx
  ON ai_lessons (organization_id, task, status);

CREATE TABLE IF NOT EXISTS ai_eval_cases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text,
  task text NOT NULL,
  input_ref jsonb NOT NULL,
  expected jsonb NOT NULL,
  provenance text NOT NULL,
  pii_redacted boolean NOT NULL DEFAULT false,
  org_consent_at timestamptz,
  prompt_version_at_capture text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ai_eval_cases_task_idx ON ai_eval_cases (task);

-- One-to-many statement clearing (split matches). The 1:1 column stays for
-- ordinary matches; split applies write here and leave it null.
CREATE TABLE IF NOT EXISTS statement_line_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id text NOT NULL,
  statement_line_id uuid NOT NULL REFERENCES statement_lines(id) ON DELETE CASCADE,
  journal_line_id uuid NOT NULL REFERENCES journal_lines(id),
  allocated_amount numeric(15,2) NOT NULL,
  created_at timestamp NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS statement_line_matches_line_idx
  ON statement_line_matches (statement_line_id);
-- A ledger line clears exactly once, org-wide — same invariant as the 1:1 column.
CREATE UNIQUE INDEX IF NOT EXISTS statement_line_matches_journal_line_unique
  ON statement_line_matches (journal_line_id);
CREATE UNIQUE INDEX IF NOT EXISTS statement_line_matches_pair_unique
  ON statement_line_matches (statement_line_id, journal_line_id);
