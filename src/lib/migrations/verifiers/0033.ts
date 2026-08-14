import {
  readCatalogSnapshot,
  verifyCatalog,
  type CatalogExpectation,
  type CatalogSnapshot,
  type ColumnExpectation,
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

const schema0033: CatalogExpectation = {
  relations: [
    exactTable("business_group_projection_reconciliation_events", [
      idColumn,
      column("organization_id", "text", true),
      column("date_from", "date", true),
      column("date_to", "date", true),
      column("compare_mode", "character varying(24)", true),
      column("metric", "character varying(64)", true),
      column("live_value", "numeric(20,8)", false),
      column("projected_value", "numeric(20,8)", false),
      column("absolute_difference", "numeric(20,8)", false),
      column("tolerance", "numeric(20,8)", true),
      column("projection_version", "integer", true),
      column("projection_as_of", "timestamp with time zone", false),
      column("selected_group_ids", "jsonb", true, "'[]'::jsonb"),
      column("observed_at", "timestamp with time zone", true, "now()"),
    ]),
  ],
  indexes: [
    index(
      "business_group_projection_reconciliation_org_period_idx",
      "business_group_projection_reconciliation_events",
      ["organization_id", "date_from", "date_to"],
    ),
    index(
      "business_group_projection_reconciliation_observed_idx",
      "business_group_projection_reconciliation_events",
      ["observed_at"],
    ),
  ],
  constraints: [
    primaryKey("business_group_projection_reconciliation_events", ["id"]),
    check(
      "business_group_projection_reconciliation_events",
      "business_group_projection_reconciliation_compare_check",
      "CHECK (((compare_mode)::text = ANY ((ARRAY['none'::character varying, 'prior_period'::character varying])::text[])))",
    ),
    check(
      "business_group_projection_reconciliation_events",
      "business_group_projection_reconciliation_tolerance_check",
      "CHECK ((tolerance >= (0)::numeric))",
    ),
    check(
      "business_group_projection_reconciliation_events",
      "business_group_projection_reconciliation_difference_check",
      "CHECK (((absolute_difference IS NULL) OR (absolute_difference >= (0)::numeric)))",
    ),
  ],
};

const foreignKeys0033: readonly ForeignKeyInvariant[] = [
  {
    key: "projection-reconciliation-organization",
    tableName: "business_group_projection_reconciliation_events",
    columns: ["organization_id"],
    referencedTable: "auth_organizations",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
];

const policies0033 = [
  "business_group_projection_reconciliation_events.business_group_projection_reconciliation_select",
  "business_group_projection_reconciliation_events.business_group_projection_reconciliation_insert",
] as const;

const privilegeFootprintScopes0033: readonly PrivilegeFootprintScope[] = [
  {
    objectType: "table",
    objectIdentities: ["business_group_projection_reconciliation_events"],
    grantees: ["PUBLIC", ...runtimeRoleNames],
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"],
  },
];

const projectionReconciliationMemberExpression =
  "EXISTS (SELECT 1 FROM auth_members membership WHERE membership.organization_id = business_group_projection_reconciliation_events.organization_id AND membership.user_id = current_user_id()) OR organization_id = current_organization_id()";

const policyExpectations0033 = [
  {
    tableName: "business_group_projection_reconciliation_events",
    name: "business_group_projection_reconciliation_select",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: projectionReconciliationMemberExpression,
    withCheck: null,
  },
  {
    tableName: "business_group_projection_reconciliation_events",
    name: "business_group_projection_reconciliation_insert",
    permissive: true,
    roles: ["public"],
    command: "insert",
    using: null,
    withCheck: projectionReconciliationMemberExpression,
  },
];

function privileges0033(snapshot: CatalogSnapshot): PrivilegeExpectation[] {
  return requireNonGrantable([
    ...privilegesForExistingRuntimeRoles(snapshot, (grantee) => [
      ...["SELECT", "INSERT"].map((privilege) => ({
        objectType: "table" as const,
        objectIdentity: "business_group_projection_reconciliation_events",
        grantee,
        privilege,
      })),
      ...["UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
        objectType: "table" as const,
        objectIdentity: "business_group_projection_reconciliation_events",
        grantee,
        privilege,
        present: false,
      })),
    ]),
    ...["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
      objectType: "table" as const,
      objectIdentity: "business_group_projection_reconciliation_events",
      grantee: "PUBLIC",
      privilege,
      present: false,
    })),
  ]);
}

export const verifier0033: MigrationVerifier = {
  id: "0033",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const footprint =
      policies0033.some((policy) => snapshot.policies.has(policy)) ||
      catalogHasPrivilegeFootprint(snapshot, privilegeFootprintScopes0033);
    const foreignKeyChecks = verifyForeignKeyInvariants(snapshot, foreignKeys0033);
    if (!footprint) {
      return schemaSynchronizedAbsence(snapshot, schema0033, context, foreignKeyChecks);
    }
    const securityChecks = await verifyMigrationSecurity(query, snapshot, [
      "business_group_projection_reconciliation_events",
    ]);
    return classifyVerification(
      true,
      [
        ...verifyCatalog(snapshot, {
          ...schema0033,
          relations: schema0033.relations?.map((relation) => ({
            ...relation,
            rls: true,
          })),
          policies: policyExpectations0033,
          privileges: privileges0033(snapshot),
        }),
        ...verifyExactPolicyIdentities(
          snapshot,
          "0033",
          ["business_group_projection_reconciliation_events"],
          policyExpectations0033,
        ),
        ...securityChecks,
        ...foreignKeyChecks,
      ],
      "projection-reconciliation",
    );
  },
};
