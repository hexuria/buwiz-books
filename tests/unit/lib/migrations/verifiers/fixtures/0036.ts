import type { CatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  addCheck,
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addSchemaTable,
  column,
} from "../support";

function addSchema0036(snapshot: CatalogSnapshot) {
  addSchemaTable(snapshot, "enterprise_billing_checkout_sessions", [
    column("id", 1, "uuid", true, "gen_random_uuid()"),
    column("enterprise_account_id", 2, "uuid"),
    column("created_by", 3),
    column("requested_quantity", 4, "integer"),
    column("external_price_id", 5, "character varying(255)"),
    column("external_customer_id", 6, "character varying(255)", false),
    column("customer_email", 7, "character varying(320)", false),
    column("success_url", 8),
    column("cancel_url", 9),
    column("status", 10, "character varying(24)", true, "'creating'::character varying"),
    column("provider_session_id", 11, "character varying(255)", false),
    column("provider_session_url", 12, "text", false),
    column("expires_at", 13, "timestamp with time zone"),
    column("completed_at", 14, "timestamp with time zone", false),
    column("created_at", 15, "timestamp with time zone", true, "now()"),
    column("updated_at", 16, "timestamp with time zone", true, "now()"),
  ]);
  addPrimaryKey(snapshot, "enterprise_billing_checkout_sessions");
  addForeignKey(
    snapshot,
    "enterprise_billing_checkout_sessions",
    "enterprise_billing_checkout_sessions_enterprise_account_id_fkey",
    ["enterprise_account_id"],
    "enterprise_accounts",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "enterprise_billing_checkout_sessions",
    "enterprise_billing_checkout_sessions_created_by_fkey",
    ["created_by"],
    "auth_users",
    ["id"],
    "restrict",
  );
  addCheck(
    snapshot,
    "enterprise_billing_checkout_sessions",
    "enterprise_billing_checkout_sessions_status_check",
    "CHECK (((status)::text = ANY ((ARRAY['creating'::character varying, 'open'::character varying, 'completed'::character varying, 'consumed'::character varying, 'expired'::character varying])::text[])))",
  );
  addCheck(
    snapshot,
    "enterprise_billing_checkout_sessions",
    "enterprise_billing_checkout_sessions_quantity_check",
    "CHECK ((requested_quantity > 0))",
  );
  addIndex(
    snapshot,
    "enterprise_billing_checkout_sessions_provider_unique",
    "enterprise_billing_checkout_sessions",
    ["provider_session_id"],
    { unique: true, predicate: "provider_session_id IS NOT NULL" },
  );
  addIndex(
    snapshot,
    "enterprise_billing_checkout_sessions_active_account_unique",
    "enterprise_billing_checkout_sessions",
    ["enterprise_account_id"],
    {
      unique: true,
      predicate:
        "status::text = ANY (ARRAY['creating'::character varying, 'open'::character varying, 'completed'::character varying]::text[])",
    },
  );
  addIndex(
    snapshot,
    "enterprise_billing_checkout_sessions_account_created_idx",
    "enterprise_billing_checkout_sessions",
    ["enterprise_account_id", "created_at"],
  );
}

function addComplete0036(snapshot: CatalogSnapshot) {
  addSchema0036(snapshot);
  snapshot.relations.get("enterprise_billing_checkout_sessions")!.rls = true;
}

export { addComplete0036, addSchema0036 };
