import type { CatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  addCheck,
  addForeignKey,
  addIndex,
  addPolicy,
  addPrimaryKey,
  addPrivilege,
  addSchemaTable,
  column,
} from "../support";

function addSchema0033(snapshot: CatalogSnapshot) {
  addSchemaTable(snapshot, "business_group_projection_reconciliation_events", [
    column("id", 1, "uuid", true, "gen_random_uuid()"),
    column("organization_id", 2),
    column("date_from", 3, "date"),
    column("date_to", 4, "date"),
    column("compare_mode", 5, "character varying(24)"),
    column("metric", 6, "character varying(64)"),
    column("live_value", 7, "numeric(20,8)", false),
    column("projected_value", 8, "numeric(20,8)", false),
    column("absolute_difference", 9, "numeric(20,8)", false),
    column("tolerance", 10, "numeric(20,8)"),
    column("projection_version", 11, "integer"),
    column("projection_as_of", 12, "timestamp with time zone", false),
    column("selected_group_ids", 13, "jsonb", true, "'[]'::jsonb"),
    column("observed_at", 14, "timestamp with time zone", true, "now()"),
  ]);
  addPrimaryKey(snapshot, "business_group_projection_reconciliation_events");
  addForeignKey(
    snapshot,
    "business_group_projection_reconciliation_events",
    "business_group_projection_reconciliation_events_organization_id_fkey",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  );
  addCheck(
    snapshot,
    "business_group_projection_reconciliation_events",
    "business_group_projection_reconciliation_compare_check",
    "CHECK (((compare_mode)::text = ANY ((ARRAY['none'::character varying, 'prior_period'::character varying])::text[])))",
  );
  addCheck(
    snapshot,
    "business_group_projection_reconciliation_events",
    "business_group_projection_reconciliation_tolerance_check",
    "CHECK ((tolerance >= (0)::numeric))",
  );
  addCheck(
    snapshot,
    "business_group_projection_reconciliation_events",
    "business_group_projection_reconciliation_difference_check",
    "CHECK (((absolute_difference IS NULL) OR (absolute_difference >= (0)::numeric)))",
  );
  addIndex(
    snapshot,
    "business_group_projection_reconciliation_org_period_idx",
    "business_group_projection_reconciliation_events",
    ["organization_id", "date_from", "date_to"],
  );
  addIndex(
    snapshot,
    "business_group_projection_reconciliation_observed_idx",
    "business_group_projection_reconciliation_events",
    ["observed_at"],
  );
}

function addComplete0033(snapshot: CatalogSnapshot) {
  addSchema0033(snapshot);
  snapshot.relations.get("business_group_projection_reconciliation_events")!.rls = true;
  const memberExpression =
    "EXISTS (SELECT 1 FROM auth_members membership WHERE membership.organization_id = business_group_projection_reconciliation_events.organization_id AND membership.user_id = current_user_id()) OR organization_id = current_organization_id()";
  addPolicy(
    snapshot,
    "business_group_projection_reconciliation_events",
    "business_group_projection_reconciliation_select",
    { command: "select", using: memberExpression },
  );
  addPolicy(
    snapshot,
    "business_group_projection_reconciliation_events",
    "business_group_projection_reconciliation_insert",
    { command: "insert", withCheck: memberExpression },
  );
  for (const role of ["app_runtime", "buwiz_app"]) {
    addPrivilege(
      snapshot,
      "table",
      "business_group_projection_reconciliation_events",
      role,
      "SELECT",
    );
    addPrivilege(
      snapshot,
      "table",
      "business_group_projection_reconciliation_events",
      role,
      "INSERT",
    );
  }
}

export { addComplete0033, addSchema0033 };
