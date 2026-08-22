import type { VerificationQuery } from "./types";
import {
  readCatalogSnapshot,
  verifyCatalog,
  type CatalogExpectation,
  type CatalogSnapshot,
  type ColumnExpectation,
  type PrivilegeExpectation,
} from "./catalog";
import { runtimeRoleNames, verifyExactPolicyIdentities, verifyMigrationSecurity } from "./security";
import { check, column, exactTable as sharedExactTable, primaryKey } from "./expectations";
import {
  catalogHasPrivilegeFootprint,
  requireNonGrantable,
  type PrivilegeFootprintScope,
} from "./acl-expectations";
import {
  adminPolicyExpectations,
  assignmentFunctionContract,
  contracts0028,
  policyExpectations0028Base,
} from "./business-group-compatibility";
import {
  functionContract,
  verifyFunctionContracts,
  type FunctionContract,
} from "./function-contracts";
import { classifyVerification, evidence, type MigrationVerifier } from "./types";

function exactTable(name: string, columns: readonly ColumnExpectation[], rls = false) {
  return sharedExactTable(name, columns, rls);
}

const adminFunctionContracts: readonly FunctionContract[] = [
  functionContract(
    "lock_business_group_user_rows(text[])",
    "4888f676d169f07859a74b44834cc33e1e00e76b7297a120ba24e4ba859129fb",
    {
      resultType: "integer",
      language: "plpgsql",
      volatility: "volatile",
      securityDefiner: true,
      searchPath: ["pg_catalog", "public", "pg_temp"],
    },
  ),
  ...[
    [
      "is_enterprise_organization_group_member(uuid, text)",
      "2b32a148a6420f0ee4c78490bbbca2283fc6e0295c6ca5a1b130081b8254c527",
    ],
    [
      "has_active_business_groups_entitlement(uuid)",
      "87f001f85c146938ee73686727cd43db79fba9176758669e06925d29291686fe",
    ],
    [
      "is_eligible_organization_group_owner(uuid, text)",
      "25b597147f78ce1a7e6d7eb49cd0283f9a6b808b452f1eafecb4ccde8fa2c3cd",
    ],
    [
      "can_manage_organization_group(uuid)",
      "5c80dbabfaf5f783b6b15fb98dd894c98e3c09ca8c638151792ca4f00f5d4956",
    ],
    [
      "can_manage_organization_group_owners(uuid)",
      "df70c305f284770ea0122f7c4917e43a6b336b94af2becb14895649cdd81c675",
    ],
    [
      "can_bootstrap_organization_group(uuid, text)",
      "fec3dfbaa2cfde6f88fc14108dd7a55f415836b38e32edf6e90d9861163f4b85",
    ],
  ].map(([identity, bodySha256]) =>
    functionContract(identity, bodySha256, {
      resultType: "boolean",
      language: "sql",
      volatility: "stable",
      securityDefiner: true,
      searchPath: ["pg_catalog", "public", "pg_temp"],
    }),
  ),
  ...[
    [
      "audit_organization_group_creation()",
      "c886fa51c4cc99d4ec03cdced662f676c858aad267ac2bd632ca21fbc801b8f4",
    ],
    [
      "enforce_organization_group_creation_entitlement()",
      "ff0c60f97269854908360859473b175911ef680db40aa46ff65de00f494fa797",
    ],
    [
      "enforce_organization_group_lifecycle()",
      "542d97c826812ea7543dffd9c6ef3d02cdaac0e93e06b8cc794fe89db2d42e78",
    ],
    [
      "ensure_organization_group_has_eligible_owner()",
      "552a3aae02870b1060d2e02aaacf775668573db390746c84cc156e36ee98d64a",
    ],
    [
      "enforce_active_organization_group_entity()",
      "756a46f8de3603c686e8d29afb8dfa568941be35dea02ac4c562b40fb8b3cff0",
    ],
    [
      "audit_organization_group_entity_change()",
      "87ea14c6859b217f2663c1ce5ae036fac2fb156ae9f9e83495beeee41675c77b",
    ],
    [
      "enforce_organization_group_member_invariants()",
      "85a5f111e089362540235512e67adad42f797f3b5aad902ebf15dec35bc5235c",
    ],
    [
      "audit_organization_group_member_change()",
      "84a926e856c2351ee7ada3db2b2de665c774e7687f6568d479092324703983bd",
    ],
    [
      "guard_enterprise_membership_owned_groups()",
      "d0c7ee6c5f19b836f09ce64ac09cdbf22f05d7adfe53423ef0fa8ad90b71997f",
    ],
    [
      "guard_user_owned_business_groups()",
      "0c56a3c3a70193fb9fafff0264793df6ed126117e2de906839696a4a14dadf4a",
    ],
  ].map(([identity, bodySha256]) =>
    functionContract(identity, bodySha256, {
      resultType: "trigger",
      language: "plpgsql",
      volatility: "volatile",
      securityDefiner: true,
      searchPath: ["pg_catalog", "public", "pg_temp"],
    }),
  ),
  functionContract(
    "transfer_organization_group_ownership(uuid, text, text)",
    "af6453f398f4d3e940e3f8eb6a273e094d0ca22b25474015dde0ad7158e2af69",
    {
      resultType: "void",
      language: "plpgsql",
      volatility: "volatile",
      securityDefiner: true,
      searchPath: ["pg_catalog", "public", "pg_temp"],
    },
  ),
];

const adminTriggerExpectations = [
  {
    tableName: "organization_groups",
    name: "organization_groups_creation_entitlement_guard",
    enabled: "origin" as const,
    level: "row" as const,
    timing: "before" as const,
    events: ["insert" as const],
    functionSchema: "public",
    functionIdentity: "enforce_organization_group_creation_entitlement()",
    when: null,
    oldTable: null,
    newTable: null,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
  },
  {
    tableName: "organization_groups",
    name: "organization_groups_creation_audit",
    enabled: "origin" as const,
    level: "row" as const,
    timing: "after" as const,
    events: ["insert" as const],
    functionSchema: "public",
    functionIdentity: "audit_organization_group_creation()",
    when: null,
    oldTable: null,
    newTable: null,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
  },
  {
    tableName: "organization_groups",
    name: "organization_groups_lifecycle_guard",
    enabled: "origin" as const,
    level: "row" as const,
    timing: "before" as const,
    events: ["update" as const],
    functionSchema: "public",
    functionIdentity: "enforce_organization_group_lifecycle()",
    when: null,
    oldTable: null,
    newTable: null,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
  },
  {
    tableName: "organization_groups",
    name: "organization_groups_eligible_owner_constraint",
    enabled: "origin" as const,
    level: "row" as const,
    timing: "after" as const,
    events: ["insert" as const],
    functionSchema: "public",
    functionIdentity: "ensure_organization_group_has_eligible_owner()",
    when: null,
    oldTable: null,
    newTable: null,
    constraint: true,
    deferrable: true,
    initiallyDeferred: true,
  },
  ...[
    [
      "organization_group_entities",
      "organization_group_entities_active_group_guard",
      "before",
      "enforce_active_organization_group_entity()",
    ],
    [
      "organization_group_entities",
      "organization_group_entities_audit",
      "after",
      "audit_organization_group_entity_change()",
    ],
    [
      "organization_group_members",
      "organization_group_members_admin_guard",
      "before",
      "enforce_organization_group_member_invariants()",
    ],
    [
      "organization_group_members",
      "organization_group_members_audit",
      "after",
      "audit_organization_group_member_change()",
    ],
  ].map(([tableName, name, timing, functionIdentity]) => ({
    tableName,
    name,
    enabled: "origin" as const,
    level: "row" as const,
    timing: timing as "before" | "after",
    events: ["insert" as const, "update" as const, "delete" as const],
    functionSchema: "public",
    functionIdentity,
    when: null,
    oldTable: null,
    newTable: null,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
  })),
  {
    tableName: "enterprise_account_members",
    name: "enterprise_account_members_owned_groups_guard",
    enabled: "origin" as const,
    level: "row" as const,
    timing: "before" as const,
    events: ["update" as const, "delete" as const],
    functionSchema: "public",
    functionIdentity: "guard_enterprise_membership_owned_groups()",
    when: null,
    oldTable: null,
    newTable: null,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
  },
  {
    tableName: "auth_users",
    name: "auth_users_owned_business_groups_guard",
    enabled: "origin" as const,
    level: "row" as const,
    timing: "before" as const,
    events: ["delete" as const],
    functionSchema: "public",
    functionIdentity: "guard_user_owned_business_groups()",
    when: null,
    oldTable: null,
    newTable: null,
    constraint: false,
    deferrable: false,
    initiallyDeferred: false,
  },
];

const policyTables0034 = ["organization_group_members", "organization_group_audit_events"] as const;

const managedRelations0034 = [
  "business_group_owner_transfer_context",
  "organization_groups",
  "organization_group_entities",
  "organization_group_members",
  "enterprise_account_members",
  "auth_users",
  "organization_group_audit_events",
  "entitlement_events",
  "business_group_projection_reconciliation_events",
] as const;

const policyExpectations0034 = [
  ...policyExpectations0028Base.filter(
    (policy) =>
      (policy.tableName === "organization_group_members" &&
        policy.name === "organization_group_members_group_select") ||
      (policy.tableName === "organization_group_audit_events" &&
        policy.name === "organization_group_audit_events_group_select"),
  ),
  ...adminPolicyExpectations,
];

function hasHardenedPolicyFootprint0034(snapshot: CatalogSnapshot): boolean {
  return adminPolicyExpectations.some((policy) =>
    verifyCatalog(snapshot, { policies: [policy] }).every((item) => item.status !== "fail"),
  );
}

const adminAclExpectations = [
  ...["PUBLIC", "app_runtime", "buwiz_app"].map((grantee) => ({
    objectType: "schema" as const,
    objectIdentity: "public",
    grantee,
    privilege: "CREATE",
    present: false,
  })),
  ...["PUBLIC", "app_runtime", "buwiz_app"].flatMap((grantee) =>
    ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
      objectType: "table" as const,
      objectIdentity: "business_group_owner_transfer_context",
      grantee,
      privilege,
      present: false,
    })),
  ),
  ...["app_runtime", "buwiz_app"].flatMap((grantee) => [
    ...["organization_group_audit_events", "entitlement_events"].flatMap((objectIdentity) => [
      {
        objectType: "table" as const,
        objectIdentity,
        grantee,
        privilege: "SELECT",
      },
      ...["INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
        objectType: "table" as const,
        objectIdentity,
        grantee,
        privilege,
        present: false,
      })),
    ]),
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
  ...[
    "lock_business_group_user_rows(text[])",
    "is_enterprise_organization_group_member(uuid, text)",
    "has_active_business_groups_entitlement(uuid)",
    "is_eligible_organization_group_owner(uuid, text)",
    "can_manage_organization_group(uuid)",
    "can_manage_organization_group_owners(uuid)",
    "can_bootstrap_organization_group(uuid, text)",
    "transfer_organization_group_ownership(uuid, text, text)",
  ].map((objectIdentity) => ({
    objectType: "function" as const,
    objectIdentity,
    grantee: "PUBLIC",
    privilege: "EXECUTE",
    present: false,
  })),
  ...["app_runtime", "buwiz_app"].flatMap((grantee) => [
    ...[
      "is_enterprise_organization_group_member(uuid, text)",
      "is_eligible_organization_group_owner(uuid, text)",
      "can_manage_organization_group(uuid)",
      "can_manage_organization_group_owners(uuid)",
      "can_bootstrap_organization_group(uuid, text)",
    ].map((objectIdentity) => ({
      objectType: "function" as const,
      objectIdentity,
      grantee,
      privilege: "EXECUTE",
    })),
    ...[
      "lock_business_group_user_rows(text[])",
      "has_active_business_groups_entitlement(uuid)",
      "transfer_organization_group_ownership(uuid, text, text)",
    ].map((objectIdentity) => ({
      objectType: "function" as const,
      objectIdentity,
      grantee,
      privilege: "EXECUTE",
      present: false,
    })),
  ]),
];

const privilegeFootprintScopes0034: readonly PrivilegeFootprintScope[] = [
  {
    objectType: "table",
    objectIdentities: ["business_group_owner_transfer_context"],
    grantees: ["PUBLIC", ...runtimeRoleNames],
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"],
  },
  {
    objectType: "function",
    objectIdentities: [
      "lock_business_group_user_rows(text[])",
      "is_enterprise_organization_group_member(uuid, text)",
      "has_active_business_groups_entitlement(uuid)",
      "is_eligible_organization_group_owner(uuid, text)",
      "can_manage_organization_group(uuid)",
      "can_manage_organization_group_owners(uuid)",
      "can_bootstrap_organization_group(uuid, text)",
      "transfer_organization_group_ownership(uuid, text, text)",
    ],
    grantees: ["PUBLIC", ...runtimeRoleNames],
    privileges: ["EXECUTE"],
  },
];

function adminAclExpectationsForSnapshot(snapshot: CatalogSnapshot): PrivilegeExpectation[] {
  return requireNonGrantable(
    adminAclExpectations.filter((expectation) => {
      if (expectation.grantee !== "app_runtime" && expectation.grantee !== "buwiz_app") {
        return true;
      }
      return snapshot.roles.has(expectation.grantee);
    }),
  );
}

const schema0034: CatalogExpectation = {
  relations: [
    exactTable("business_group_owner_transfer_context", [
      column("transaction_id", "bigint", true),
      column("group_id", "uuid", true),
      column("actor_user_id", "text", true),
      column("previous_owner_user_id", "text", true),
      column("replacement_owner_user_id", "text", true),
    ]),
  ],
  constraints: [
    primaryKey("business_group_owner_transfer_context", ["transaction_id", "group_id"]),
    check(
      "organization_groups",
      "organization_groups_name_check",
      "CHECK ((((name)::text = btrim((name)::text)) AND (char_length((name)::text) >= 2) AND (char_length((name)::text) <= 255)))",
    ),
  ],
};

export const verifier0034: MigrationVerifier = {
  id: "0034",
  async verify(query) {
    const snapshot = await readCatalogSnapshot(query);
    const inheritedFunctionIdentities = new Set([
      "can_manage_organization_group(uuid)",
      "can_bootstrap_organization_group(uuid, text)",
    ]);
    const inheritedPrivilegeIdentities = new Set([
      "can_manage_organization_group(uuid)",
      "can_bootstrap_organization_group(uuid, text)",
    ]);
    const footprint =
      snapshot.relations.has("business_group_owner_transfer_context") ||
      adminFunctionContracts.some(
        (contract) =>
          !inheritedFunctionIdentities.has(contract.identity) &&
          snapshot.functions.has(contract.identity),
      ) ||
      adminTriggerExpectations.some((trigger) =>
        snapshot.triggers.has(`${trigger.tableName}.${trigger.name}`),
      ) ||
      hasHardenedPolicyFootprint0034(snapshot) ||
      catalogHasPrivilegeFootprint(
        snapshot,
        privilegeFootprintScopes0034.map((scope) =>
          scope.objectType === "function"
            ? {
                ...scope,
                objectIdentities: scope.objectIdentities.filter(
                  (identity) => !inheritedPrivilegeIdentities.has(identity),
                ),
              }
            : scope,
        ),
      );
    const inheritedContracts = [
      ...contracts0028(true).filter(
        (contract) =>
          contract.identity !== "current_user_id()" &&
          !inheritedFunctionIdentities.has(contract.identity),
      ),
      assignmentFunctionContract(true, true),
    ];
    const securityChecks = footprint
      ? await verifyMigrationSecurity(query, snapshot, managedRelations0034, [
          ...adminFunctionContracts,
          ...inheritedContracts,
        ])
      : [];
    const preflight = footprint ? await verifyAdminDataInvariants(query) : [];
    return classifyVerification(
      footprint,
      [
        ...verifyCatalog(snapshot, {
          ...schema0034,
          relations: schema0034.relations?.map((relation) => ({
            ...relation,
            rls: false,
            forceRls: false,
          })),
          triggers: adminTriggerExpectations,
          policies: policyExpectations0034,
          privileges: adminAclExpectationsForSnapshot(snapshot),
        }),
        ...verifyFunctionContracts(snapshot, adminFunctionContracts),
        ...verifyFunctionContracts(snapshot, inheritedContracts),
        ...verifyExactPolicyIdentities(snapshot, "0034", policyTables0034, policyExpectations0034),
        ...securityChecks,
        evidence(
          "0034:legacy-audit-insert-policy-absent",
          !snapshot.policies.has(
            "organization_group_audit_events.organization_group_audit_events_group_insert",
          ),
          "absent",
          snapshot.policies.has(
            "organization_group_audit_events.organization_group_audit_events_group_insert",
          )
            ? "present"
            : "absent",
        ),
        ...preflight,
      ],
      "admin-guards-hardened",
    );
  },
};

async function verifyAdminDataInvariants(query: VerificationQuery) {
  const [row] = await query.unsafe<{
    ownerless_groups: number;
    cross_account_members: number;
    ineligible_owners: number;
    archived_enabled_entities: number;
    invalid_names: number;
    transfer_context_rows: number;
  }>(`
    SELECT
      (SELECT count(*)::integer FROM organization_groups AS groups
       WHERE NOT EXISTS (
         SELECT 1 FROM organization_group_members AS group_member
         INNER JOIN enterprise_account_members AS account_member
           ON account_member.enterprise_account_id = groups.enterprise_account_id
          AND account_member.user_id = group_member.user_id
          AND account_member.role IN ('owner', 'group_admin')
         WHERE group_member.group_id = groups.id AND group_member.role = 'owner'
       )) AS ownerless_groups,
      (SELECT count(*)::integer FROM organization_group_members AS group_member
       INNER JOIN organization_groups AS groups ON groups.id = group_member.group_id
       LEFT JOIN enterprise_account_members AS account_member
         ON account_member.enterprise_account_id = groups.enterprise_account_id
        AND account_member.user_id = group_member.user_id
       WHERE account_member.id IS NULL) AS cross_account_members,
      (SELECT count(*)::integer FROM organization_group_members AS group_member
       INNER JOIN organization_groups AS groups ON groups.id = group_member.group_id
       LEFT JOIN enterprise_account_members AS account_member
         ON account_member.enterprise_account_id = groups.enterprise_account_id
        AND account_member.user_id = group_member.user_id
        AND account_member.role IN ('owner', 'group_admin')
       WHERE group_member.role = 'owner' AND account_member.id IS NULL) AS ineligible_owners,
      (SELECT count(*)::integer FROM organization_group_entities AS entity
       INNER JOIN organization_groups AS groups ON groups.id = entity.group_id
       WHERE groups.status = 'archived' AND entity.status = 'enabled') AS archived_enabled_entities,
      (SELECT count(*)::integer FROM organization_groups
       WHERE length(btrim(name)) NOT BETWEEN 2 AND 255) AS invalid_names,
      (SELECT count(*)::integer FROM business_group_owner_transfer_context)
        AS transfer_context_rows
  `);
  const checks = [
    ["eligible-owner", row?.ownerless_groups],
    ["enterprise-membership", row?.cross_account_members],
    ["owner-role", row?.ineligible_owners],
    ["archived-entities", row?.archived_enabled_entities],
    ["trimmed-name", row?.invalid_names],
    ["empty-transfer-context", row?.transfer_context_rows],
  ] as const;
  return checks.map(([key, count]) =>
    evidence(`0034:${key}`, count === 0, "0 invalid rows", String(count ?? "missing")),
  );
}
