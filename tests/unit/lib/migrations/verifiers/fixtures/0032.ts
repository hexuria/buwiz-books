import type { CatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  addCheck,
  addForeignKey,
  addFunction,
  addIndex,
  addPolicy,
  addPrimaryKey,
  addPrivilege,
  addSchemaTable,
  addTrigger,
  column,
  migrationFunctionBody,
  migrationSql,
} from "../support";

function addSchema0032(snapshot: CatalogSnapshot) {
  const tables = {
    organization_reporting_accounts: [
      column("organization_id", 1),
      column("account_id", 2, "uuid"),
      column("account_name", 3, "character varying(255)"),
      column("account_number", 4, "character varying(10)", false),
      column("account_type", 5, "character varying(50)"),
      column("subtype", 6, "character varying(100)", false),
      column("parent_id", 7, "uuid", false),
      column("synced_at", 8, "timestamp with time zone", true, "now()"),
    ],
    organization_daily_account_activity: [
      column("organization_id", 1),
      column("activity_date", 2, "date"),
      column("account_id", 3, "uuid"),
      // As pg_get_expr renders it, not as the migration spells it.
      column("total_debit", 4, "numeric(20,8)", true, "'0'::numeric"),
      column("total_credit", 5, "numeric(20,8)", true, "'0'::numeric"),
      column("computed_at", 6, "timestamp with time zone", true, "now()"),
    ],
    organization_reporting_dirty_dates: [
      column("organization_id", 1),
      column("activity_date", 2, "date"),
      column("version", 3, "integer"),
      column("marked_at", 4, "timestamp with time zone", true, "now()"),
    ],
    organization_reporting_projection_state: [
      column("organization_id", 1),
      column("status", 2, "character varying(24)", true, "'pending'::character varying"),
      column("requested_version", 3, "integer", true, "0"),
      column("applied_version", 4, "integer", true, "0"),
      column("full_rebuild_requested", 5, "boolean", true, "false"),
      column("last_ledger_event_at", 6, "timestamp with time zone", false),
      column("last_projected_at", 7, "timestamp with time zone", false),
      column("initial_backfill_completed_at", 8, "timestamp with time zone", false),
      column("last_error", 9, "text", false),
      column("updated_at", 10, "timestamp with time zone", true, "now()"),
    ],
  } as const;
  for (const [name, columns] of Object.entries(tables)) addSchemaTable(snapshot, name, columns);
  addPrimaryKey(snapshot, "organization_reporting_accounts", ["organization_id", "account_id"]);
  addForeignKey(
    snapshot,
    "organization_reporting_accounts",
    "organization_reporting_accounts_organization_id_fkey",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "organization_reporting_accounts",
    "organization_reporting_accounts_account_id_fkey",
    ["account_id"],
    "accounts",
    ["id"],
    "cascade",
  );
  addIndex(
    snapshot,
    "organization_reporting_accounts_org_number_idx",
    "organization_reporting_accounts",
    ["organization_id", "account_number"],
  );
  addPrimaryKey(snapshot, "organization_daily_account_activity", [
    "organization_id",
    "activity_date",
    "account_id",
  ]);
  addForeignKey(
    snapshot,
    "organization_daily_account_activity",
    "organization_daily_account_activity_organization_id_fkey",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "organization_daily_account_activity",
    "organization_daily_account_activity_account_id_fkey",
    ["account_id"],
    "accounts",
    ["id"],
    "cascade",
  );
  addIndex(
    snapshot,
    "organization_daily_account_activity_org_account_date_idx",
    "organization_daily_account_activity",
    ["organization_id", "account_id", "activity_date"],
  );
  addPrimaryKey(snapshot, "organization_reporting_dirty_dates", [
    "organization_id",
    "activity_date",
  ]);
  addForeignKey(
    snapshot,
    "organization_reporting_dirty_dates",
    "organization_reporting_dirty_dates_organization_id_fkey",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  );
  addCheck(
    snapshot,
    "organization_reporting_dirty_dates",
    "organization_reporting_dirty_dates_version_check",
    "CHECK ((version > 0))",
  );
  addIndex(
    snapshot,
    "organization_reporting_dirty_dates_marked_idx",
    "organization_reporting_dirty_dates",
    ["marked_at"],
  );
  addPrimaryKey(snapshot, "organization_reporting_projection_state", ["organization_id"]);
  addForeignKey(
    snapshot,
    "organization_reporting_projection_state",
    "organization_reporting_projection_state_organization_id_fkey",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  );
  addCheck(
    snapshot,
    "organization_reporting_projection_state",
    "organization_reporting_projection_state_status_check",
    "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'building'::character varying, 'ready'::character varying, 'failed'::character varying])::text[])))",
  );
  addCheck(
    snapshot,
    "organization_reporting_projection_state",
    "organization_reporting_projection_state_versions_check",
    "CHECK (((requested_version >= 0) AND (applied_version >= 0) AND (applied_version <= requested_version)))",
  );
  addIndex(
    snapshot,
    "organization_reporting_projection_state_status_idx",
    "organization_reporting_projection_state",
    ["status", "updated_at"],
  );
}

function addComplete0032(snapshot: CatalogSnapshot) {
  addSchema0032(snapshot);
  for (const tableName of [
    "accounts",
    "organization_group_entities",
    "journal_headers",
    "journal_lines",
  ]) {
    if (!snapshot.relations.has(tableName)) addSchemaTable(snapshot, tableName, []);
  }
  for (const tableName of [
    "organization_reporting_accounts",
    "organization_daily_account_activity",
    "organization_reporting_dirty_dates",
    "organization_reporting_projection_state",
  ]) {
    snapshot.relations.get(tableName)!.rls = true;
  }

  const sql = migrationSql("0032_reporting_projections.sql");
  addFunction(
    snapshot,
    "current_organization_id()",
    migrationFunctionBody(sql, "current_organization_id"),
    {
      resultType: "text",
      securityDefiner: false,
      config: null,
    },
  );
  for (const [identity, functionName, resultType] of [
    ["mark_organization_reporting_dirty(text, date)", "mark_organization_reporting_dirty", "void"],
    [
      "request_organization_reporting_full_rebuild(text)",
      "request_organization_reporting_full_rebuild",
      "void",
    ],
    [
      "mark_organization_reporting_metadata_dirty(text)",
      "mark_organization_reporting_metadata_dirty",
      "void",
    ],
    ["mark_reporting_from_changed_accounts()", "mark_reporting_from_changed_accounts", "trigger"],
    ["mark_reporting_from_inserted_accounts()", "mark_reporting_from_inserted_accounts", "trigger"],
    ["mark_reporting_from_deleted_accounts()", "mark_reporting_from_deleted_accounts", "trigger"],
    [
      "request_reporting_for_inserted_group_entities()",
      "request_reporting_for_inserted_group_entities",
      "trigger",
    ],
    [
      "request_reporting_for_restored_group_entities()",
      "request_reporting_for_restored_group_entities",
      "trigger",
    ],
    ["mark_reporting_from_inserted_headers()", "mark_reporting_from_inserted_headers", "trigger"],
    ["mark_reporting_from_updated_headers()", "mark_reporting_from_updated_headers", "trigger"],
    ["mark_reporting_from_deleted_headers()", "mark_reporting_from_deleted_headers", "trigger"],
    ["mark_reporting_from_inserted_lines()", "mark_reporting_from_inserted_lines", "trigger"],
    ["mark_reporting_from_updated_lines()", "mark_reporting_from_updated_lines", "trigger"],
    ["mark_reporting_from_deleted_lines()", "mark_reporting_from_deleted_lines", "trigger"],
  ] as const) {
    addFunction(snapshot, identity, migrationFunctionBody(sql, functionName), {
      resultType,
      language: "plpgsql",
      volatility: "volatile",
      config: ["search_path=public, pg_temp"],
    });
  }

  for (const [tableName, name, functionIdentity, event, oldTable, newTable] of [
    [
      "accounts",
      "accounts_reporting_insert",
      "mark_reporting_from_inserted_accounts()",
      "insert",
      null,
      "new_accounts",
    ],
    [
      "accounts",
      "accounts_reporting_update",
      "mark_reporting_from_changed_accounts()",
      "update",
      "old_accounts",
      "new_accounts",
    ],
    [
      "accounts",
      "accounts_reporting_delete",
      "mark_reporting_from_deleted_accounts()",
      "delete",
      "old_accounts",
      null,
    ],
    [
      "organization_group_entities",
      "organization_group_entities_reporting_insert",
      "request_reporting_for_inserted_group_entities()",
      "insert",
      null,
      "new_group_entities",
    ],
    [
      "organization_group_entities",
      "organization_group_entities_reporting_update",
      "request_reporting_for_restored_group_entities()",
      "update",
      "old_group_entities",
      "new_group_entities",
    ],
    [
      "journal_headers",
      "journal_headers_reporting_insert",
      "mark_reporting_from_inserted_headers()",
      "insert",
      null,
      "new_headers",
    ],
    [
      "journal_headers",
      "journal_headers_reporting_update",
      "mark_reporting_from_updated_headers()",
      "update",
      "old_headers",
      "new_headers",
    ],
    [
      "journal_headers",
      "journal_headers_reporting_delete",
      "mark_reporting_from_deleted_headers()",
      "delete",
      "old_headers",
      null,
    ],
    [
      "journal_lines",
      "journal_lines_reporting_insert",
      "mark_reporting_from_inserted_lines()",
      "insert",
      null,
      "new_lines",
    ],
    [
      "journal_lines",
      "journal_lines_reporting_update",
      "mark_reporting_from_updated_lines()",
      "update",
      "old_lines",
      "new_lines",
    ],
    [
      "journal_lines",
      "journal_lines_reporting_delete",
      "mark_reporting_from_deleted_lines()",
      "delete",
      "old_lines",
      null,
    ],
  ] as const) {
    addTrigger(snapshot, tableName, name, functionIdentity, [event], {
      oldTable,
      newTable,
    });
  }

  for (const tableName of [
    "organization_reporting_accounts",
    "organization_daily_account_activity",
    "organization_reporting_dirty_dates",
    "organization_reporting_projection_state",
  ] as const) {
    addPolicy(snapshot, tableName, `${tableName}_select`, {
      command: "select",
      using: `EXISTS (SELECT 1 FROM auth_members membership WHERE membership.organization_id = ${tableName}.organization_id AND membership.user_id = current_user_id()) OR organization_id = current_organization_id()`,
    });
    addPolicy(snapshot, tableName, `${tableName}_worker_write`, {
      command: "all",
      using: "organization_id = current_organization_id()",
      withCheck: "organization_id = current_organization_id()",
    });
    for (const role of ["app_runtime", "buwiz_app"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
        addPrivilege(snapshot, "table", tableName, role, privilege);
      }
    }
  }
}

const complete0032Seed = {
  missing_projection_states: 0,
  non_pending_projection_states: 0,
  non_advanced_projection_versions: 0,
  missing_full_rebuild_requests: 0,
  invalid_refresh_jobs: 0,
} as const;

const pending0032Lifecycle = {
  organization_id: "org_1",
  status: "pending",
  requested_version: 1,
  applied_version: 0,
  full_rebuild_requested: true,
  initial_backfill_completed_at: null,
  last_error: null,
  valid_active_refresh_jobs: 1,
  invalid_active_refresh_jobs: 0,
} as const;

export { addComplete0032, addSchema0032, complete0032Seed, pending0032Lifecycle };
