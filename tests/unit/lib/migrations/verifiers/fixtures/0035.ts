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

function addSchema0035(snapshot: CatalogSnapshot) {
  addSchemaTable(snapshot, "enterprise_billing_subscriptions", [
    column("id", 1, "uuid", true, "gen_random_uuid()"),
    column("enterprise_account_id", 2, "uuid"),
    column("provider", 3, "character varying(24)", true, "'stripe'::character varying"),
    column("external_customer_id", 4, "character varying(255)"),
    column("external_subscription_id", 5, "character varying(255)"),
    column("external_price_id", 6, "character varying(255)"),
    column("quantity", 7, "integer"),
    column("provider_status", 8, "character varying(32)"),
    column("current_period_start", 9, "timestamp with time zone"),
    column("current_period_end", 10, "timestamp with time zone"),
    column("cancel_at_period_end", 11, "boolean", true, "false"),
    column("last_provider_event_created_at", 12, "timestamp with time zone"),
    column("last_provider_event_id", 13, "character varying(255)"),
    column("created_at", 14, "timestamp with time zone", true, "now()"),
    column("updated_at", 15, "timestamp with time zone", true, "now()"),
  ]);
  addSchemaTable(snapshot, "enterprise_billing_webhook_events", [
    column("id", 1, "uuid", true, "gen_random_uuid()"),
    column("provider_event_id", 2, "character varying(255)"),
    column("event_type", 3, "character varying(96)"),
    column("provider_created_at", 4, "timestamp with time zone"),
    column("enterprise_account_id", 5, "uuid", false),
    column("status", 6, "character varying(24)", true, "'received'::character varying"),
    column("failure_code", 7, "character varying(64)", false),
    column("received_at", 8, "timestamp with time zone", true, "now()"),
    column("processed_at", 9, "timestamp with time zone", false),
  ]);
  addPrimaryKey(snapshot, "enterprise_billing_subscriptions");
  addForeignKey(
    snapshot,
    "enterprise_billing_subscriptions",
    "enterprise_billing_subscriptions_enterprise_account_id_fkey",
    ["enterprise_account_id"],
    "enterprise_accounts",
    ["id"],
    "cascade",
  );
  addCheck(
    snapshot,
    "enterprise_billing_subscriptions",
    "enterprise_billing_subscriptions_provider_check",
    "CHECK (((provider)::text = 'stripe'::text))",
  );
  addCheck(
    snapshot,
    "enterprise_billing_subscriptions",
    "enterprise_billing_subscriptions_quantity_check",
    "CHECK ((quantity > 0))",
  );
  addCheck(
    snapshot,
    "enterprise_billing_subscriptions",
    "enterprise_billing_subscriptions_period_check",
    "CHECK ((current_period_end > current_period_start))",
  );
  addIndex(
    snapshot,
    "enterprise_billing_subscriptions_account_unique",
    "enterprise_billing_subscriptions",
    ["enterprise_account_id"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "enterprise_billing_subscriptions_customer_unique",
    "enterprise_billing_subscriptions",
    ["external_customer_id"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "enterprise_billing_subscriptions_subscription_unique",
    "enterprise_billing_subscriptions",
    ["external_subscription_id"],
    { unique: true },
  );
  addPrimaryKey(snapshot, "enterprise_billing_webhook_events");
  addForeignKey(
    snapshot,
    "enterprise_billing_webhook_events",
    "enterprise_billing_webhook_events_enterprise_account_id_fkey",
    ["enterprise_account_id"],
    "enterprise_accounts",
    ["id"],
    "set_null",
  );
  addCheck(
    snapshot,
    "enterprise_billing_webhook_events",
    "enterprise_billing_webhook_events_status_check",
    "CHECK (((status)::text = ANY ((ARRAY['received'::character varying, 'processed'::character varying, 'ignored'::character varying, 'failed'::character varying])::text[])))",
  );
  addIndex(
    snapshot,
    "enterprise_billing_webhook_events_provider_event_unique",
    "enterprise_billing_webhook_events",
    ["provider_event_id"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "enterprise_billing_webhook_events_account_received_idx",
    "enterprise_billing_webhook_events",
    ["enterprise_account_id", "received_at"],
  );
}

function addComplete0035(snapshot: CatalogSnapshot) {
  addSchema0035(snapshot);
  snapshot.relations.get("enterprise_billing_subscriptions")!.rls = true;
  snapshot.relations.get("enterprise_billing_webhook_events")!.rls = true;
  addPolicy(
    snapshot,
    "enterprise_billing_subscriptions",
    "enterprise_billing_subscriptions_member_select",
    {
      command: "select",
      using: "is_enterprise_account_member(enterprise_account_id)",
    },
  );
  for (const role of ["app_runtime", "buwiz_app"]) {
    addPrivilege(snapshot, "table", "enterprise_billing_subscriptions", role, "SELECT");
  }
}

export { addComplete0035, addSchema0035 };
