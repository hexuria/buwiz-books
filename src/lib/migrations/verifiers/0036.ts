import {
  readCatalogSnapshot,
  verifyCatalog,
  type CatalogExpectation,
  type ColumnExpectation,
} from "./catalog";
import { runtimeRoleNames, verifyMigrationSecurity } from "./security";
import {
  check,
  column,
  createdAt,
  exactTable as sharedExactTable,
  foreignKey,
  idColumn,
  index,
  primaryKey,
  schemaSynchronizedAbsence,
  updatedAt,
  verifyForeignKeyInvariants,
  type ForeignKeyInvariant,
} from "./expectations";
import {
  catalogHasPrivilegeFootprint,
  requireNonGrantable,
  type PrivilegeFootprintScope,
} from "./acl-expectations";
import { classifyVerification, evidence, type MigrationVerifier } from "./types";

function exactTable(name: string, columns: readonly ColumnExpectation[], rls = false) {
  return sharedExactTable(name, columns, rls);
}

const schema0036: CatalogExpectation = {
  relations: [
    exactTable("enterprise_billing_checkout_sessions", [
      idColumn,
      column("enterprise_account_id", "uuid", true),
      column("created_by", "text", true),
      column("requested_quantity", "integer", true),
      column("external_price_id", "character varying(255)", true),
      column("external_customer_id", "character varying(255)", false),
      column("customer_email", "character varying(320)", false),
      column("success_url", "text", true),
      column("cancel_url", "text", true),
      column("status", "character varying(24)", true, "'creating'::character varying"),
      column("provider_session_id", "character varying(255)", false),
      column("provider_session_url", "text", false),
      column("expires_at", "timestamp with time zone", true),
      column("completed_at", "timestamp with time zone", false),
      createdAt,
      updatedAt,
    ]),
  ],
  indexes: [
    index(
      "enterprise_billing_checkout_sessions_provider_unique",
      "enterprise_billing_checkout_sessions",
      ["provider_session_id"],
      { unique: true, predicate: "provider_session_id IS NOT NULL" },
    ),
    index(
      "enterprise_billing_checkout_sessions_active_account_unique",
      "enterprise_billing_checkout_sessions",
      ["enterprise_account_id"],
      {
        unique: true,
        predicate:
          "status::text = ANY (ARRAY['creating'::character varying, 'open'::character varying, 'completed'::character varying]::text[])",
      },
    ),
    index(
      "enterprise_billing_checkout_sessions_account_created_idx",
      "enterprise_billing_checkout_sessions",
      ["enterprise_account_id", "created_at"],
    ),
  ],
  constraints: [
    primaryKey("enterprise_billing_checkout_sessions", ["id"]),
    check(
      "enterprise_billing_checkout_sessions",
      "enterprise_billing_checkout_sessions_status_check",
      "CHECK (((status)::text = ANY ((ARRAY['creating'::character varying, 'open'::character varying, 'completed'::character varying, 'consumed'::character varying, 'expired'::character varying])::text[])))",
    ),
    check(
      "enterprise_billing_checkout_sessions",
      "enterprise_billing_checkout_sessions_quantity_check",
      "CHECK ((requested_quantity > 0))",
    ),
  ],
};

const foreignKeys0036: readonly ForeignKeyInvariant[] = [
  {
    key: "checkout-enterprise-account",
    tableName: "enterprise_billing_checkout_sessions",
    columns: ["enterprise_account_id"],
    referencedTable: "enterprise_accounts",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
  {
    key: "checkout-created-by",
    tableName: "enterprise_billing_checkout_sessions",
    columns: ["created_by"],
    referencedTable: "auth_users",
    referencedColumns: ["id"],
    onDelete: "restrict",
  },
];

const privileges0036 = requireNonGrantable(
  ["PUBLIC", "app_runtime", "buwiz_app"].flatMap((grantee) =>
    ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
      objectType: "table" as const,
      objectIdentity: "enterprise_billing_checkout_sessions",
      grantee,
      privilege,
      present: false,
    })),
  ),
);

const privilegeFootprintScopes0036: readonly PrivilegeFootprintScope[] = [
  {
    objectType: "table",
    objectIdentities: ["enterprise_billing_checkout_sessions"],
    grantees: ["PUBLIC", ...runtimeRoleNames],
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"],
  },
];

export const verifier0036: MigrationVerifier = {
  id: "0036",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const footprint =
      snapshot.relations.get("enterprise_billing_checkout_sessions")?.rls === true ||
      catalogHasPrivilegeFootprint(snapshot, privilegeFootprintScopes0036);
    const foreignKeyChecks = verifyForeignKeyInvariants(snapshot, foreignKeys0036);
    if (!footprint) {
      return schemaSynchronizedAbsence(snapshot, schema0036, context, foreignKeyChecks);
    }
    const securityChecks = await verifyMigrationSecurity(query, snapshot, [
      "enterprise_billing_checkout_sessions",
    ]);
    const checkoutPolicies = [...snapshot.policies.values()].filter(
      (policy) => policy.tableName === "enterprise_billing_checkout_sessions",
    );
    return classifyVerification(
      true,
      [
        ...verifyCatalog(snapshot, {
          ...schema0036,
          relations: schema0036.relations?.map((relation) => ({
            ...relation,
            rls: true,
          })),
          privileges: privileges0036,
        }),
        ...securityChecks,
        ...foreignKeyChecks,
        evidence(
          "0036:checkout-policies-absent",
          checkoutPolicies.length === 0,
          "no policies",
          checkoutPolicies.map((policy) => policy.name).join(", ") || "none",
        ),
      ],
      "enterprise-checkout",
    );
  },
};
