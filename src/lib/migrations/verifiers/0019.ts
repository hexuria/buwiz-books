import type { VerificationContext } from "../engine";
import {
  relationHasColumn,
  type CatalogExpectation,
  type CatalogSnapshot,
  type ConstraintExpectation,
  type IndexExpectation,
  type RelationExpectation,
} from "./catalog";
import {
  column,
  constraint,
  createdAt,
  exactTable,
  foreignKey,
  idColumn,
  index,
  localTenantExpression,
  primaryKey,
  schemaSyncBaselineChecks,
  tenantPolicy,
  updatedAt,
  verifier,
} from "./expectations";
import { relations0019ForTarget } from "./schema-sync-0019-0020";
import { evidence } from "./types";

const migration0019Tables = [
  "organization_accounting_settings",
  "firms",
  "firm_members",
  "firm_clients",
  "firm_member_client_access",
  "fx_rates",
  "integration_connections",
  "integration_sources",
  "integration_sync_runs",
  "ingestion_events",
  "processing_jobs",
  "source_records",
  "source_record_documents",
  "transaction_candidates",
  "transaction_candidate_lines",
  "inbox_items",
  "inbox_watchers",
  "review_rule_definitions",
  "review_rule_configs",
  "review_rule_runs",
  "review_findings",
  "review_decisions",
  "workflow_events",
  "source_match_candidates",
  "ledger_source_links",
] as const;

const tenant0019Tables = [
  "organization_accounting_settings",
  "firm_clients",
  "firm_member_client_access",
  "fx_rates",
  "integration_connections",
  "integration_sources",
  "integration_sync_runs",
  "ingestion_events",
  "processing_jobs",
  "source_records",
  "source_record_documents",
  "transaction_candidates",
  "transaction_candidate_lines",
  "inbox_items",
  "inbox_watchers",
  "review_rule_configs",
  "review_rule_runs",
  "review_findings",
  "review_decisions",
  "workflow_events",
  "source_match_candidates",
  "ledger_source_links",
] as const;

const indexes0019: IndexExpectation[] = [
  index(
    "organization_accounting_settings_inbound_email_unique",
    "organization_accounting_settings",
    ["inbound_email_address"],
    { unique: true, predicate: "inbound_email_address IS NOT NULL" },
  ),
  index("firm_members_firm_user_unique", "firm_members", ["firm_id", "user_id"], {
    unique: true,
  }),
  index("firm_members_user_idx", "firm_members", ["user_id"]),
  index("firm_clients_firm_org_unique", "firm_clients", ["firm_id", "organization_id"], {
    unique: true,
  }),
  index("firm_clients_org_idx", "firm_clients", ["organization_id"]),
  index("firm_member_client_access_org_idx", "firm_member_client_access", ["organization_id"]),
  index(
    "fx_rates_org_pair_date_source_unique",
    "fx_rates",
    ["organization_id", "base_currency", "quote_currency", "effective_date", "source"],
    { unique: true },
  ),
  index("fx_rates_org_pair_date_idx", "fx_rates", [
    "organization_id",
    "base_currency",
    "quote_currency",
    "effective_date",
  ]),
  index(
    "integration_connections_org_provider_tenant_unique",
    "integration_connections",
    ["organization_id", "provider", "external_tenant_id"],
    { unique: true, predicate: "external_tenant_id IS NOT NULL" },
  ),
  index("integration_connections_org_status_idx", "integration_connections", [
    "organization_id",
    "status",
  ]),
  index(
    "integration_sources_org_provider_external_unique",
    "integration_sources",
    ["organization_id", "provider", "external_source_id"],
    { unique: true, predicate: "external_source_id IS NOT NULL" },
  ),
  index("integration_sources_org_channel_idx", "integration_sources", [
    "organization_id",
    "channel",
  ]),
  index("integration_sync_runs_connection_started_idx", "integration_sync_runs", [
    "connection_id",
    "started_at",
  ]),
  index(
    "ingestion_events_org_provider_event_unique",
    "ingestion_events",
    ["organization_id", "provider", "provider_event_id"],
    { unique: true, predicate: "provider_event_id IS NOT NULL" },
  ),
  index("ingestion_events_org_status_received_idx", "ingestion_events", [
    "organization_id",
    "status",
    "received_at",
  ]),
  index("processing_jobs_org_dedupe_unique", "processing_jobs", ["organization_id", "dedupe_key"], {
    unique: true,
    predicate:
      "dedupe_key IS NOT NULL AND status::text = ANY (ARRAY['queued'::character varying, 'running'::character varying]::text[])",
  }),
  index("processing_jobs_claim_idx", "processing_jobs", ["status", "run_at", "locked_until"]),
  index("processing_jobs_org_status_idx", "processing_jobs", ["organization_id", "status"]),
  index(
    "source_records_org_source_external_version_unique",
    "source_records",
    ["organization_id", "source_id", "external_id", "external_version"],
    { unique: true, predicate: "external_id IS NOT NULL" },
  ),
  index("source_records_org_date_idx", "source_records", ["organization_id", "transaction_date"]),
  index("source_record_documents_org_idx", "source_record_documents", ["organization_id"]),
  index("transaction_candidates_org_status_idx", "transaction_candidates", [
    "organization_id",
    "status",
  ]),
  index("transaction_candidates_source_record_idx", "transaction_candidates", ["source_record_id"]),
  index("transaction_candidate_lines_candidate_idx", "transaction_candidate_lines", [
    "candidate_id",
    "sort_order",
  ]),
  index("transaction_candidate_lines_org_account_idx", "transaction_candidate_lines", [
    "organization_id",
    "account_id",
  ]),
  index("inbox_items_candidate_unique", "inbox_items", ["candidate_id"], {
    unique: true,
    predicate: "candidate_id IS NOT NULL",
  }),
  index("inbox_items_org_state_created_idx", "inbox_items", [
    "organization_id",
    "state",
    "created_at",
  ]),
  index("inbox_items_assignee_state_idx", "inbox_items", ["assignee_id", "state"]),
  index("inbox_watchers_user_idx", "inbox_watchers", ["user_id"]),
  index(
    "review_rule_configs_org_definition_unique",
    "review_rule_configs",
    ["organization_id", "definition_id"],
    { unique: true },
  ),
  index("review_rule_runs_org_started_idx", "review_rule_runs", ["organization_id", "started_at"]),
  index(
    "review_findings_org_fingerprint_unique",
    "review_findings",
    ["organization_id", "fingerprint"],
    { unique: true },
  ),
  index("review_findings_inbox_state_idx", "review_findings", ["inbox_item_id", "state"]),
  index("review_findings_org_rule_state_idx", "review_findings", [
    "organization_id",
    "rule_key",
    "state",
  ]),
  index("review_decisions_inbox_created_idx", "review_decisions", ["inbox_item_id", "created_at"]),
  index(
    "workflow_events_org_idempotency_unique",
    "workflow_events",
    ["organization_id", "idempotency_key"],
    { unique: true, predicate: "idempotency_key IS NOT NULL" },
  ),
  index("workflow_events_entity_created_idx", "workflow_events", [
    "organization_id",
    "entity_type",
    "entity_id",
    "created_at",
  ]),
  index(
    "source_match_candidates_pair_unique",
    "source_match_candidates",
    ["organization_id", "left_source_record_id", "right_source_record_id"],
    { unique: true },
  ),
  index("source_match_candidates_org_state_idx", "source_match_candidates", [
    "organization_id",
    "state",
  ]),
  index("ledger_source_links_org_source_idx", "ledger_source_links", [
    "organization_id",
    "source_record_id",
  ]),
];

const relations0019: RelationExpectation[] = [
  {
    name: "journal_headers",
    columns: [
      // Nullable, because nothing ever made it otherwise. No numbered migration
      // creates total_amount at all -- it appears nowhere under drizzle/ except
      // 0019's ALTER COLUMN ... TYPE, which does not touch nullability -- so the
      // column exists only because src/db/schema/journals.ts declares it, and
      // that declaration carries no .notNull(). Asserting NOT NULL here described
      // no database, migrated or pushed.
      column("total_amount", "numeric(20,8)", false),
      column("functional_currency", "character varying(3)", true, "'USD'::character varying"),
      column("transaction_currency", "character varying(3)", false),
      column("exchange_rate_id", "uuid", false),
    ],
  },
  {
    name: "journal_lines",
    columns: [
      // These two, unlike total_amount, really are created by 0000 -- as plain
      // numeric(15,2) with no NOT NULL -- and 0019 only retypes them.
      column("debit", "numeric(20,8)", false),
      column("credit", "numeric(20,8)", false),
      column("original_debit", "numeric(20,8)", false),
      column("original_credit", "numeric(20,8)", false),
      column("original_currency", "character varying(3)", false),
      column("exchange_rate", "numeric(20,10)", false),
      column("exchange_rate_id", "uuid", false),
    ],
  },
  exactTable(
    "organization_accounting_settings",
    [
      column("organization_id", "text", true),
      column("base_currency", "character varying(3)", true, "'USD'::character varying"),
      column("timezone", "character varying(64)", true, "'UTC'::character varying"),
      column("inbound_email_address", "character varying(320)", false),
      column("review_policy", "character varying(32)", true, "'always_review'::character varying"),
      column("require_different_approver", "boolean", true, "true"),
      column("allow_owner_override", "boolean", true, "true"),
      column("low_confidence_threshold", "numeric(5,4)", true, "0.8000"),
      column("missing_receipt_threshold", "numeric(20,8)", true, "75"),
      column("missing_receipt_currency", "character varying(3)", true, "'USD'::character varying"),
      column("fx_gain_account_id", "uuid", false),
      column("fx_loss_account_id", "uuid", false),
      column("fx_rounding_account_id", "uuid", false),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  exactTable(
    "firms",
    [
      idColumn,
      column("name", "character varying(255)", true),
      column("slug", "character varying(120)", true),
      column("created_by", "text", false),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  exactTable(
    "firm_members",
    [
      idColumn,
      column("firm_id", "uuid", true),
      column("user_id", "text", true),
      column("role", "character varying(32)", true, "'preparer'::character varying"),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  exactTable(
    "firm_clients",
    [
      idColumn,
      column("firm_id", "uuid", true),
      column("organization_id", "text", true),
      column("status", "character varying(24)", true, "'active'::character varying"),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  exactTable(
    "firm_member_client_access",
    [column("firm_member_id", "uuid", true), column("organization_id", "text", true), createdAt],
    true,
  ),
  exactTable(
    "fx_rates",
    [
      idColumn,
      column("organization_id", "text", true),
      column("base_currency", "character varying(3)", true),
      column("quote_currency", "character varying(3)", true),
      column("effective_date", "date", true),
      column("rate", "numeric(20,10)", true),
      column("source", "character varying(32)", true),
      column("provider_reference", "character varying(255)", false),
      column("is_manual_override", "boolean", true, "false"),
      column("override_reason", "text", false),
      column("created_by", "text", false),
      column("retrieved_at", "timestamp with time zone", true, "now()"),
      createdAt,
    ],
    true,
  ),
  exactTable(
    "integration_connections",
    [
      idColumn,
      column("organization_id", "text", true),
      column("provider", "character varying(64)", true),
      column("domain", "character varying(32)", true),
      column("status", "character varying(32)", true, "'pending'::character varying"),
      column("external_tenant_id", "character varying(255)", false),
      column("secret_ref", "text", false),
      column("scopes", "jsonb", true, "'[]'::jsonb"),
      column("config", "jsonb", true, "'{}'::jsonb"),
      column("sync_cursor", "text", false),
      column("last_synced_at", "timestamp with time zone", false),
      column("next_sync_at", "timestamp with time zone", false),
      column("last_error", "text", false),
      column("created_by", "text", false),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  exactTable(
    "integration_sources",
    [
      idColumn,
      column("organization_id", "text", true),
      column("connection_id", "uuid", false),
      column("provider", "character varying(64)", true),
      column("channel", "character varying(32)", true),
      column("external_source_id", "character varying(255)", false),
      column("name", "character varying(255)", true),
      column("currency", "character varying(3)", false),
      column("ledger_account_id", "uuid", false),
      column("import_start_date", "date", false),
      column("status", "character varying(32)", true, "'active'::character varying"),
      column("config", "jsonb", true, "'{}'::jsonb"),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  exactTable(
    "integration_sync_runs",
    [
      idColumn,
      column("organization_id", "text", true),
      column("connection_id", "uuid", true),
      column("run_type", "character varying(24)", true),
      column("status", "character varying(24)", true, "'running'::character varying"),
      column("cursor_before", "text", false),
      column("cursor_after", "text", false),
      column("counts", "jsonb", true, "'{}'::jsonb"),
      column("last_error", "text", false),
      column("started_at", "timestamp with time zone", true, "now()"),
      column("completed_at", "timestamp with time zone", false),
    ],
    true,
  ),
  exactTable(
    "ingestion_events",
    [
      idColumn,
      column("organization_id", "text", true),
      column("connection_id", "uuid", false),
      column("source_id", "uuid", false),
      column("channel", "character varying(32)", true),
      column("provider", "character varying(64)", true),
      column("provider_event_id", "character varying(255)", false),
      column("external_object_id", "character varying(255)", false),
      column("external_version", "character varying(128)", false),
      column("payload_hash", "character varying(64)", false),
      column("payload", "jsonb", false),
      column("headers", "jsonb", false),
      column("raw_object_key", "text", false),
      column("status", "character varying(32)", true, "'received'::character varying"),
      column("correlation_id", "uuid", true, "gen_random_uuid()"),
      column("attempts", "integer", true, "0"),
      column("last_error", "text", false),
      column("occurred_at", "timestamp with time zone", false),
      column("received_at", "timestamp with time zone", true, "now()"),
      column("processed_at", "timestamp with time zone", false),
    ],
    true,
  ),
  exactTable(
    "processing_jobs",
    [
      idColumn,
      column("organization_id", "text", true),
      column("ingestion_event_id", "uuid", false),
      column("job_type", "character varying(64)", true),
      column("status", "character varying(24)", true, "'queued'::character varying"),
      column("payload", "jsonb", true, "'{}'::jsonb"),
      column("dedupe_key", "character varying(255)", false),
      column("correlation_id", "uuid", true, "gen_random_uuid()"),
      column("attempts", "integer", true, "0"),
      column("max_attempts", "integer", true, "8"),
      column("run_at", "timestamp with time zone", true, "now()"),
      column("locked_by", "character varying(128)", false),
      column("locked_until", "timestamp with time zone", false),
      column("last_error", "text", false),
      column("completed_at", "timestamp with time zone", false),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  {
    name: "source_records",
    kind: "table",
    rls: true,
    columns: [
      idColumn,
      column("organization_id", "text", true),
      column("source_id", "uuid", false),
      column("ingestion_event_id", "uuid", false),
      column("record_type", "character varying(32)", true),
      column("external_id", "character varying(255)", false),
      column("external_version", "character varying(128)", true, "'1'::character varying"),
      column("provider_status", "character varying(64)", false),
      column("transaction_date", "date", false),
      column("description", "text", false),
      column("amount", "numeric(20,8)", false),
      column("currency", "character varying(3)", false),
      column("raw_data", "jsonb", true, "'{}'::jsonb"),
      createdAt,
      updatedAt,
    ],
  },
  exactTable(
    "source_record_documents",
    [
      column("source_record_id", "uuid", true),
      column("document_id", "uuid", true),
      column("organization_id", "text", true),
      column("relationship", "character varying(32)", true, "'evidence'::character varying"),
      createdAt,
    ],
    true,
  ),
  {
    name: "transaction_candidates",
    kind: "table",
    rls: true,
    columns: [
      idColumn,
      column("organization_id", "text", true),
      column("source_record_id", "uuid", false),
      column("revision", "integer", true, "1"),
      column("status", "character varying(24)", true, "'current'::character varying"),
      column("candidate_type", "character varying(32)", true, "'transaction'::character varying"),
      column("transaction_date", "date", true),
      column("transaction_type", "character varying(24)", true),
      column("memo", "text", false),
      column("reference_number", "character varying(100)", false),
      column("party_id", "uuid", false),
      column("original_currency", "character varying(3)", true),
      column("functional_currency", "character varying(3)", true),
      column("exchange_rate_id", "uuid", false),
      column("exchange_rate", "numeric(20,10)", true, "1"),
      column("original_total", "numeric(20,8)", false),
      column("functional_total", "numeric(20,8)", false),
      column("submitted_by", "text", false),
      column("submitted_at", "timestamp with time zone", true, "now()"),
      column("superseded_by_id", "uuid", false),
      column("posted_journal_header_id", "uuid", false),
      createdAt,
      updatedAt,
    ],
  },
  exactTable(
    "transaction_candidate_lines",
    [
      idColumn,
      column("organization_id", "text", true),
      column("candidate_id", "uuid", true),
      column("account_id", "uuid", false),
      column("original_debit", "numeric(20,8)", false),
      column("original_credit", "numeric(20,8)", false),
      column("functional_debit", "numeric(20,8)", false),
      column("functional_credit", "numeric(20,8)", false),
      column("original_currency", "character varying(3)", true),
      column("exchange_rate", "numeric(20,10)", true, "1"),
      column("line_description", "text", false),
      column("party_id", "uuid", false),
      column("department_id", "uuid", false),
      column("location_id", "uuid", false),
      column("category_confidence", "numeric(5,4)", false),
      column("prediction_evidence", "jsonb", false),
      column("sort_order", "integer", true, "0"),
      createdAt,
    ],
    true,
  ),
  exactTable(
    "inbox_items",
    [
      idColumn,
      column("organization_id", "text", true),
      column("candidate_id", "uuid", false),
      column("source_record_id", "uuid", false),
      column(
        "item_type",
        "character varying(48)",
        true,
        "'approve_transaction'::character varying",
      ),
      column("state", "character varying(32)", true, "'ready_for_review'::character varying"),
      column("priority", "character varying(16)", true, "'normal'::character varying"),
      column("title", "character varying(255)", true),
      column("assignee_id", "text", false),
      column("submitted_by", "text", false),
      column("candidate_revision", "integer", true, "1"),
      column("due_at", "timestamp with time zone", false),
      column("resolved_by", "text", false),
      column("resolved_at", "timestamp with time zone", false),
      column("resolution_note", "text", false),
      column("lock_version", "integer", true, "1"),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  exactTable(
    "inbox_watchers",
    [
      column("inbox_item_id", "uuid", true),
      column("user_id", "text", true),
      column("organization_id", "text", true),
      createdAt,
    ],
    true,
  ),
  exactTable(
    "review_rule_definitions",
    [
      idColumn,
      column("key", "character varying(64)", true),
      column("name", "character varying(120)", true),
      column("group_name", "character varying(16)", true),
      column("evaluator_key", "character varying(64)", true),
      column("default_config", "jsonb", true, "'{}'::jsonb"),
      column("formula_version", "integer", true, "1"),
      createdAt,
    ],
    false,
  ),
  exactTable(
    "review_rule_configs",
    [
      idColumn,
      column("organization_id", "text", true),
      column("definition_id", "uuid", true),
      column("enabled", "boolean", true, "true"),
      column("impact", "character varying(16)", true),
      column("lookback_months", "integer", true, "3"),
      column("config", "jsonb", true, "'{}'::jsonb"),
      column("version", "integer", true, "1"),
      column("updated_by", "text", false),
      createdAt,
      updatedAt,
    ],
    true,
  ),
  exactTable(
    "review_rule_runs",
    [
      idColumn,
      column("organization_id", "text", true),
      column("rule_config_id", "uuid", false),
      column("trigger", "character varying(24)", true),
      column("status", "character varying(24)", true, "'running'::character varying"),
      column("window_start", "date", true),
      column("window_end", "date", true),
      column("as_of_date", "date", true),
      column("config_snapshot", "jsonb", true, "'{}'::jsonb"),
      column("counts", "jsonb", true, "'{}'::jsonb"),
      column("last_error", "text", false),
      column("started_at", "timestamp with time zone", true, "now()"),
      column("completed_at", "timestamp with time zone", false),
    ],
    true,
  ),
  exactTable(
    "review_findings",
    [
      idColumn,
      column("organization_id", "text", true),
      column("inbox_item_id", "uuid", false),
      column("candidate_id", "uuid", false),
      column("rule_config_id", "uuid", false),
      column("rule_run_id", "uuid", false),
      column("rule_key", "character varying(64)", true),
      column("impact", "character varying(16)", true),
      column("state", "character varying(24)", true, "'open'::character varying"),
      column("subject_type", "character varying(32)", true),
      column("subject_id", "uuid", false),
      column("fingerprint", "character varying(255)", true),
      column("message", "text", true),
      column("evidence", "jsonb", true, "'{}'::jsonb"),
      column("formula_version", "integer", true, "1"),
      column("first_seen_at", "timestamp with time zone", true, "now()"),
      column("last_seen_at", "timestamp with time zone", true, "now()"),
      column("resolved_by", "text", false),
      column("resolved_at", "timestamp with time zone", false),
      column("resolution_note", "text", false),
    ],
    true,
  ),
  exactTable(
    "review_decisions",
    [
      idColumn,
      column("organization_id", "text", true),
      column("inbox_item_id", "uuid", true),
      column("decision", "character varying(32)", true),
      column("actor_id", "text", true),
      column("candidate_revision", "integer", true),
      column("reason", "text", false),
      column("before_state", "character varying(32)", true),
      column("after_state", "character varying(32)", true),
      column("journal_header_id", "uuid", false),
      createdAt,
    ],
    true,
  ),
  exactTable(
    "workflow_events",
    [
      idColumn,
      column("organization_id", "text", true),
      column("inbox_item_id", "uuid", false),
      column("entity_type", "character varying(48)", true),
      column("entity_id", "uuid", true),
      column("action", "character varying(48)", true),
      column("actor_type", "character varying(16)", true),
      column("actor_id", "text", false),
      column("correlation_id", "uuid", true, "gen_random_uuid()"),
      column("idempotency_key", "character varying(255)", false),
      column("data", "jsonb", true, "'{}'::jsonb"),
      createdAt,
    ],
    true,
  ),
  {
    name: "source_match_candidates",
    kind: "table",
    rls: true,
    columns: [
      idColumn,
      column("organization_id", "text", true),
      column("left_source_record_id", "uuid", true),
      column("right_source_record_id", "uuid", true),
      column("match_type", "character varying(16)", true),
      column("confidence", "numeric(5,4)", false),
      column("state", "character varying(24)", true, "'open'::character varying"),
      column("evidence", "jsonb", true, "'{}'::jsonb"),
      column("resolved_by", "text", false),
      column("resolved_at", "timestamp with time zone", false),
      createdAt,
    ],
  },
  exactTable(
    "ledger_source_links",
    [
      column("organization_id", "text", true),
      column("journal_header_id", "uuid", true),
      column("source_record_id", "uuid", true),
      column("relationship", "character varying(24)", true, "'origin'::character varying"),
      createdAt,
    ],
    true,
  ),
];

function primaryKeyColumns0019(tableName: (typeof migration0019Tables)[number]): readonly string[] {
  switch (tableName) {
    case "organization_accounting_settings":
      return ["organization_id"];
    case "firm_member_client_access":
      return ["firm_member_id", "organization_id"];
    case "source_record_documents":
      return ["source_record_id", "document_id"];
    case "inbox_watchers":
      return ["inbox_item_id", "user_id"];
    case "ledger_source_links":
      return ["journal_header_id", "source_record_id"];
    default:
      return ["id"];
  }
}

const foreignKeys0019 = (
  [
    ["organization_accounting_settings", "organization_id", "auth_organizations", "cascade"],
    ["organization_accounting_settings", "fx_gain_account_id", "accounts", "no_action"],
    ["organization_accounting_settings", "fx_loss_account_id", "accounts", "no_action"],
    ["organization_accounting_settings", "fx_rounding_account_id", "accounts", "no_action"],
    ["firms", "created_by", "auth_users", "no_action"],
    ["firm_members", "firm_id", "firms", "cascade"],
    ["firm_members", "user_id", "auth_users", "cascade"],
    ["firm_clients", "firm_id", "firms", "cascade"],
    ["firm_clients", "organization_id", "auth_organizations", "cascade"],
    ["firm_member_client_access", "firm_member_id", "firm_members", "cascade"],
    ["firm_member_client_access", "organization_id", "auth_organizations", "cascade"],
    ["fx_rates", "organization_id", "auth_organizations", "cascade"],
    ["fx_rates", "created_by", "auth_users", "no_action"],
    ["integration_connections", "organization_id", "auth_organizations", "cascade"],
    ["integration_connections", "created_by", "auth_users", "no_action"],
    ["integration_sources", "organization_id", "auth_organizations", "cascade"],
    ["integration_sources", "connection_id", "integration_connections", "cascade"],
    ["integration_sources", "ledger_account_id", "accounts", "no_action"],
    ["integration_sync_runs", "organization_id", "auth_organizations", "cascade"],
    ["integration_sync_runs", "connection_id", "integration_connections", "cascade"],
    ["ingestion_events", "organization_id", "auth_organizations", "cascade"],
    ["ingestion_events", "connection_id", "integration_connections", "set_null"],
    ["ingestion_events", "source_id", "integration_sources", "set_null"],
    ["processing_jobs", "organization_id", "auth_organizations", "cascade"],
    ["processing_jobs", "ingestion_event_id", "ingestion_events", "cascade"],
    ["source_records", "organization_id", "auth_organizations", "cascade"],
    ["source_records", "source_id", "integration_sources", "set_null"],
    ["source_records", "ingestion_event_id", "ingestion_events", "set_null"],
    ["source_record_documents", "source_record_id", "source_records", "cascade"],
    ["source_record_documents", "document_id", "documents", "cascade"],
    ["source_record_documents", "organization_id", "auth_organizations", "cascade"],
    ["transaction_candidates", "organization_id", "auth_organizations", "cascade"],
    ["transaction_candidates", "source_record_id", "source_records", "set_null"],
    ["transaction_candidates", "party_id", "parties", "no_action"],
    ["transaction_candidates", "exchange_rate_id", "fx_rates", "no_action"],
    ["transaction_candidates", "submitted_by", "auth_users", "no_action"],
    ["transaction_candidates", "posted_journal_header_id", "journal_headers", "no_action"],
    ["transaction_candidate_lines", "organization_id", "auth_organizations", "cascade"],
    ["transaction_candidate_lines", "candidate_id", "transaction_candidates", "cascade"],
    ["transaction_candidate_lines", "account_id", "accounts", "no_action"],
    ["transaction_candidate_lines", "party_id", "parties", "no_action"],
    ["transaction_candidate_lines", "department_id", "dimensions", "no_action"],
    ["transaction_candidate_lines", "location_id", "dimensions", "no_action"],
    ["inbox_items", "organization_id", "auth_organizations", "cascade"],
    ["inbox_items", "candidate_id", "transaction_candidates", "cascade"],
    ["inbox_items", "source_record_id", "source_records", "set_null"],
    ["inbox_items", "assignee_id", "auth_users", "no_action"],
    ["inbox_items", "submitted_by", "auth_users", "no_action"],
    ["inbox_items", "resolved_by", "auth_users", "no_action"],
    ["inbox_watchers", "inbox_item_id", "inbox_items", "cascade"],
    ["inbox_watchers", "user_id", "auth_users", "cascade"],
    ["inbox_watchers", "organization_id", "auth_organizations", "cascade"],
    ["review_rule_configs", "organization_id", "auth_organizations", "cascade"],
    ["review_rule_configs", "definition_id", "review_rule_definitions", "cascade"],
    ["review_rule_configs", "updated_by", "auth_users", "no_action"],
    ["review_rule_runs", "organization_id", "auth_organizations", "cascade"],
    ["review_rule_runs", "rule_config_id", "review_rule_configs", "set_null"],
    ["review_findings", "organization_id", "auth_organizations", "cascade"],
    ["review_findings", "inbox_item_id", "inbox_items", "cascade"],
    ["review_findings", "candidate_id", "transaction_candidates", "cascade"],
    ["review_findings", "rule_config_id", "review_rule_configs", "set_null"],
    ["review_findings", "rule_run_id", "review_rule_runs", "set_null"],
    ["review_findings", "resolved_by", "auth_users", "no_action"],
    ["review_decisions", "organization_id", "auth_organizations", "cascade"],
    ["review_decisions", "inbox_item_id", "inbox_items", "cascade"],
    ["review_decisions", "actor_id", "auth_users", "no_action"],
    ["review_decisions", "journal_header_id", "journal_headers", "no_action"],
    ["workflow_events", "organization_id", "auth_organizations", "cascade"],
    ["workflow_events", "inbox_item_id", "inbox_items", "cascade"],
    ["source_match_candidates", "organization_id", "auth_organizations", "cascade"],
    ["source_match_candidates", "left_source_record_id", "source_records", "cascade"],
    ["source_match_candidates", "right_source_record_id", "source_records", "cascade"],
    ["source_match_candidates", "resolved_by", "auth_users", "no_action"],
    ["ledger_source_links", "organization_id", "auth_organizations", "cascade"],
    ["ledger_source_links", "journal_header_id", "journal_headers", "cascade"],
    ["ledger_source_links", "source_record_id", "source_records", "restrict"],
  ] as const
).map(([tableName, columnName, referencedTable, onDelete]) =>
  foreignKey(
    tableName,
    `${tableName}_${columnName}_fkey`,
    [columnName],
    referencedTable,
    ["id"],
    onDelete,
  ),
);

const constraints0019: ConstraintExpectation[] = [
  ...migration0019Tables.map((tableName) =>
    primaryKey(tableName, primaryKeyColumns0019(tableName)),
  ),
  constraint("firms", "firms_slug_key", "unique", ["slug"], {
    validated: true,
  }),
  constraint("review_rule_definitions", "review_rule_definitions_key_key", "unique", ["key"], {
    validated: true,
  }),
  ...foreignKeys0019,
];

function expectation0019(
  _snapshot: CatalogSnapshot,
  context: VerificationContext,
): CatalogExpectation {
  const relations = relations0019ForTarget(relations0019, context.target.includes("0020"));
  return {
    relations,
    indexes: indexes0019,
    constraints: constraints0019,
    enums: [
      {
        name: "journal_source",
        values: ["document", "email", "integration", "payment"],
      },
    ],
    policies: [
      ...tenant0019Tables.map((tableName) =>
        tenantPolicy(tableName, "tenant_isolation", localTenantExpression),
      ),
      {
        tableName: "firms",
        name: "firm_member_access",
        permissive: true,
        roles: ["public"],
        command: "all",
        using:
          "EXISTS (SELECT 1 FROM firm_members WHERE firm_members.firm_id = firms.id AND firm_members.user_id = current_setting('app.current_user_id', true))",
        withCheck: null,
      },
      {
        tableName: "firm_members",
        name: "own_firm_membership",
        permissive: true,
        roles: ["public"],
        command: "all",
        using: "user_id = current_setting('app.current_user_id', true)",
        withCheck: null,
      },
    ],
  };
}

export const verifier0019 = verifier(
  "0019",
  expectation0019,
  (snapshot) =>
    migration0019Tables.some((tableName) => snapshot.relations.has(tableName)) ||
    relationHasColumn(snapshot.relations.get("journal_headers"), "functional_currency") ||
    relationHasColumn(snapshot.relations.get("journal_lines"), "original_debit") ||
    indexes0019.some((item) => snapshot.indexes.has(item.name)),
  async (query, _snapshot, context) => {
    const [row] = await query.unsafe<{ rule_count: number }>(`
      SELECT count(*)::integer AS rule_count
      FROM review_rule_definitions
      WHERE key = ANY(ARRAY[
        'uncategorized', 'low_confidence_category', 'missing_vendor',
        'missing_customer', 'missing_receipt', 'missing_invoice',
        'missing_department', 'missing_location', 'possible_duplicate',
        'unusual_spend', 'non_zero_clearing', 'material_expense',
        'material_asset', 'transaction_in_parent_category'
      ])
    `);
    const possibleDuplicate = context.target.includes("0020")
      ? `('possible_duplicate', 'Possible Duplicate', 'book', 'possible_duplicate', '{"mode":"enforce","matchWindowDays":3,"blockingScore":70,"shadowScore":50,"algorithmVersion":1}'::jsonb, 2)`
      : `('possible_duplicate', 'Possible Duplicate', 'book', 'possible_duplicate', '{"matchWindowDays":3}'::jsonb, 1)`;
    const [definitions] = await query.unsafe<{ invalid_rule_rows: number }>(`
      WITH expected(
        key,
        name,
        group_name,
        evaluator_key,
        default_config,
        formula_version
      ) AS (
        VALUES
          ('uncategorized', 'Uncategorized', 'book', 'uncategorized', '{}'::jsonb, 1),
          ('low_confidence_category', 'Low Confidence Category', 'book', 'low_confidence_category', '{"threshold":0.8}'::jsonb, 1),
          ('missing_vendor', 'Missing Vendor', 'book', 'missing_vendor', '{}'::jsonb, 1),
          ('missing_customer', 'Missing Customer', 'book', 'missing_customer', '{}'::jsonb, 1),
          ('missing_receipt', 'Missing Receipt', 'book', 'missing_receipt', '{"threshold":75,"currency":"USD"}'::jsonb, 1),
          ('missing_invoice', 'Missing Invoice', 'book', 'missing_invoice', '{}'::jsonb, 1),
          ('missing_department', 'Missing Department', 'book', 'missing_department', '{}'::jsonb, 1),
          ('missing_location', 'Missing Location', 'book', 'missing_location', '{}'::jsonb, 1),
          ${possibleDuplicate},
          ('unusual_spend', 'Unusual Spend', 'review', 'unusual_spend', '{"standardDeviations":3}'::jsonb, 1),
          ('non_zero_clearing', 'Non Zero Clearing', 'review', 'non_zero_clearing', '{}'::jsonb, 1),
          ('material_expense', 'Material Expense', 'review', 'material_expense', '{"annualizedExpensePercent":1}'::jsonb, 1),
          ('material_asset', 'Material Asset', 'review', 'material_asset', '{"totalAssetPercent":0.5}'::jsonb, 1),
          ('transaction_in_parent_category', 'Transaction In Parent Category', 'review', 'transaction_in_parent_category', '{}'::jsonb, 1)
      )
      SELECT count(*) FILTER (
        WHERE definition.id IS NULL
          OR definition.name IS DISTINCT FROM expected.name
          OR definition.group_name IS DISTINCT FROM expected.group_name
          OR definition.evaluator_key IS DISTINCT FROM expected.evaluator_key
          OR definition.default_config IS DISTINCT FROM expected.default_config
          OR definition.formula_version IS DISTINCT FROM expected.formula_version
      )::integer AS invalid_rule_rows
      FROM expected
      LEFT JOIN review_rule_definitions AS definition
        ON definition.key = expected.key
    `);
    return [
      evidence(
        "0019:review-rule-catalog",
        row?.rule_count === 14,
        "14 required review rules",
        String(row?.rule_count ?? "missing"),
      ),
      evidence(
        "0019:review-rule-definitions",
        definitions?.invalid_rule_rows === 0,
        "all 14 required review-rule rows match the managed definitions",
        String(definitions?.invalid_rule_rows ?? "missing"),
      ),
    ];
  },
  async (query, snapshot, context) => {
    const expected = expectation0019(snapshot, context);
    const [row] = await query.unsafe<{ rule_count: number }>(`
      SELECT count(*)::integer AS rule_count
      FROM review_rule_definitions
      WHERE key = ANY(ARRAY[
        'uncategorized', 'low_confidence_category', 'missing_vendor',
        'missing_customer', 'missing_receipt', 'missing_invoice',
        'missing_department', 'missing_location', 'possible_duplicate',
        'unusual_spend', 'non_zero_clearing', 'material_expense',
        'material_asset', 'transaction_in_parent_category'
      ])
    `);
    return [
      ...schemaSyncBaselineChecks(snapshot, expected, {
        key: "0019",
        forbidden: {
          constraints: (expected.constraints ?? []).filter(
            (item) => item.type === "foreign_key" && item.name.endsWith("_fkey"),
          ),
        },
      }),
      evidence(
        "0019:seed-rows-absent",
        row?.rule_count === 0,
        "0 managed review-rule seed rows before immutable SQL execution",
        String(row?.rule_count ?? "missing"),
      ),
    ];
  },
);
