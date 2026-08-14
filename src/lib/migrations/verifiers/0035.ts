import {
  readCatalogSnapshot,
  verifyCatalog,
  type CatalogExpectation,
  type CatalogSnapshot,
  type ColumnExpectation,
  type PolicyExpectation,
  type PrivilegeExpectation,
} from "./catalog";
import { runtimeRoleNames, verifyExactPolicyIdentities, verifyMigrationSecurity } from "./security";
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
  privilegesForExistingRuntimeRoles,
  requireNonGrantable,
  type PrivilegeFootprintScope,
} from "./acl-expectations";
import { classifyVerification, type MigrationVerifier } from "./types";

function exactTable(name: string, columns: readonly ColumnExpectation[], rls = false) {
  return sharedExactTable(name, columns, rls);
}

const schema0035: CatalogExpectation = {
  relations: [
    exactTable("enterprise_billing_subscriptions", [
      idColumn,
      column("enterprise_account_id", "uuid", true),
      column("provider", "character varying(24)", true, "'stripe'::character varying"),
      column("external_customer_id", "character varying(255)", true),
      column("external_subscription_id", "character varying(255)", true),
      column("external_price_id", "character varying(255)", true),
      column("quantity", "integer", true),
      column("provider_status", "character varying(32)", true),
      column("current_period_start", "timestamp with time zone", true),
      column("current_period_end", "timestamp with time zone", true),
      column("cancel_at_period_end", "boolean", true, "false"),
      column("last_provider_event_created_at", "timestamp with time zone", true),
      column("last_provider_event_id", "character varying(255)", true),
      createdAt,
      updatedAt,
    ]),
    exactTable("enterprise_billing_webhook_events", [
      idColumn,
      column("provider_event_id", "character varying(255)", true),
      column("event_type", "character varying(96)", true),
      column("provider_created_at", "timestamp with time zone", true),
      column("enterprise_account_id", "uuid", false),
      column("status", "character varying(24)", true, "'received'::character varying"),
      column("failure_code", "character varying(64)", false),
      column("received_at", "timestamp with time zone", true, "now()"),
      column("processed_at", "timestamp with time zone", false),
    ]),
  ],
  indexes: [
    index(
      "enterprise_billing_subscriptions_account_unique",
      "enterprise_billing_subscriptions",
      ["enterprise_account_id"],
      { unique: true },
    ),
    index(
      "enterprise_billing_subscriptions_customer_unique",
      "enterprise_billing_subscriptions",
      ["external_customer_id"],
      { unique: true },
    ),
    index(
      "enterprise_billing_subscriptions_subscription_unique",
      "enterprise_billing_subscriptions",
      ["external_subscription_id"],
      { unique: true },
    ),
    index(
      "enterprise_billing_webhook_events_provider_event_unique",
      "enterprise_billing_webhook_events",
      ["provider_event_id"],
      { unique: true },
    ),
    index(
      "enterprise_billing_webhook_events_account_received_idx",
      "enterprise_billing_webhook_events",
      ["enterprise_account_id", "received_at"],
    ),
  ],
  constraints: [
    primaryKey("enterprise_billing_subscriptions", ["id"]),
    check(
      "enterprise_billing_subscriptions",
      "enterprise_billing_subscriptions_provider_check",
      "CHECK (((provider)::text = 'stripe'::text))",
    ),
    check(
      "enterprise_billing_subscriptions",
      "enterprise_billing_subscriptions_quantity_check",
      "CHECK ((quantity > 0))",
    ),
    check(
      "enterprise_billing_subscriptions",
      "enterprise_billing_subscriptions_period_check",
      "CHECK ((current_period_end > current_period_start))",
    ),
    primaryKey("enterprise_billing_webhook_events", ["id"]),
    check(
      "enterprise_billing_webhook_events",
      "enterprise_billing_webhook_events_status_check",
      "CHECK (((status)::text = ANY ((ARRAY['received'::character varying, 'processed'::character varying, 'ignored'::character varying, 'failed'::character varying])::text[])))",
    ),
  ],
};

const foreignKeys0035: readonly ForeignKeyInvariant[] = [
  {
    key: "billing-subscription-account",
    tableName: "enterprise_billing_subscriptions",
    columns: ["enterprise_account_id"],
    referencedTable: "enterprise_accounts",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
  {
    key: "billing-webhook-account",
    tableName: "enterprise_billing_webhook_events",
    columns: ["enterprise_account_id"],
    referencedTable: "enterprise_accounts",
    referencedColumns: ["id"],
    onDelete: "set_null",
  },
];

const privilegeFootprintScopes0035: readonly PrivilegeFootprintScope[] = [
  {
    objectType: "table",
    objectIdentities: ["enterprise_billing_subscriptions", "enterprise_billing_webhook_events"],
    grantees: ["PUBLIC", ...runtimeRoleNames],
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"],
  },
];

function privileges0035(snapshot: CatalogSnapshot): PrivilegeExpectation[] {
  return requireNonGrantable([
    ...["enterprise_billing_subscriptions", "enterprise_billing_webhook_events"].flatMap(
      (objectIdentity) =>
        ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
          objectType: "table" as const,
          objectIdentity,
          grantee: "PUBLIC",
          privilege,
          present: false,
        })),
    ),
    ...privilegesForExistingRuntimeRoles(snapshot, (grantee) => [
      {
        objectType: "table" as const,
        objectIdentity: "enterprise_billing_subscriptions",
        grantee,
        privilege: "SELECT",
      },
      ...["INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
        objectType: "table" as const,
        objectIdentity: "enterprise_billing_subscriptions",
        grantee,
        privilege,
        present: false,
      })),
      ...["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
        objectType: "table" as const,
        objectIdentity: "enterprise_billing_webhook_events",
        grantee,
        privilege,
        present: false,
      })),
    ]),
  ]);
}

const policyTables0035 = [
  "enterprise_billing_subscriptions",
  "enterprise_billing_webhook_events",
] as const;

const policyExpectations0035: readonly PolicyExpectation[] = [
  {
    tableName: "enterprise_billing_subscriptions",
    name: "enterprise_billing_subscriptions_member_select",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: "is_enterprise_account_member(enterprise_account_id)",
    withCheck: null,
  },
];

export const verifier0035: MigrationVerifier = {
  id: "0035",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const policy =
      "enterprise_billing_subscriptions.enterprise_billing_subscriptions_member_select";
    const footprint =
      snapshot.policies.has(policy) ||
      catalogHasPrivilegeFootprint(snapshot, privilegeFootprintScopes0035);
    const foreignKeyChecks = verifyForeignKeyInvariants(snapshot, foreignKeys0035);
    if (!footprint) {
      return schemaSynchronizedAbsence(snapshot, schema0035, context, foreignKeyChecks);
    }
    const securityChecks = await verifyMigrationSecurity(query, snapshot, policyTables0035);
    return classifyVerification(
      true,
      [
        ...verifyCatalog(snapshot, {
          ...schema0035,
          relations: schema0035.relations?.map((relation) => ({
            ...relation,
            rls: true,
          })),
          policies: policyExpectations0035,
          privileges: privileges0035(snapshot),
        }),
        ...verifyExactPolicyIdentities(snapshot, "0035", policyTables0035, policyExpectations0035),
        ...securityChecks,
        ...foreignKeyChecks,
      ],
      "enterprise-stripe-billing",
    );
  },
};
