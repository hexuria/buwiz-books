import type { VerificationEvidence } from "../engine";
import type {
  CatalogExpectation,
  CatalogSnapshot,
  ColumnExpectation,
  PolicyExpectation,
  PrivilegeExpectation,
} from "./catalog";
import {
  check,
  column,
  constraint,
  createdAt,
  exactTable as sharedExactTable,
  foreignKey,
  idColumn,
  index,
  primaryKey,
  updatedAt,
} from "./expectations";
import { privilegesForExistingRuntimeRoles, requireNonGrantable } from "./acl-expectations";
import { functionContract, type FunctionContract } from "./function-contracts";
import { evidence } from "./types";

function exactTable(name: string, columns: readonly ColumnExpectation[], rls = false) {
  return sharedExactTable(name, columns, rls);
}

const schema0028: CatalogExpectation = {
  relations: [
    exactTable("enterprise_accounts", [
      idColumn,
      column("name", "character varying(255)", true),
      column("status", "character varying(24)", true, "'active'::character varying"),
      column("billing_contact_email", "character varying(320)", false),
      column("external_customer_id", "character varying(255)", false),
      column("created_by", "text", false),
      createdAt,
      updatedAt,
    ]),
    exactTable("enterprise_account_members", [
      idColumn,
      column("enterprise_account_id", "uuid", true),
      column("user_id", "text", true),
      column("role", "character varying(32)", true),
      createdAt,
      updatedAt,
    ]),
    exactTable("account_entitlements", [
      idColumn,
      column("enterprise_account_id", "uuid", true),
      column("feature_key", "character varying(64)", true),
      column("status", "character varying(24)", true),
      column("included_entity_limit", "integer", true),
      column("provisioning_source", "character varying(32)", true, "'contract'::character varying"),
      column("starts_at", "timestamp with time zone", true),
      column("ends_at", "timestamp with time zone", false),
      column("grace_ends_at", "timestamp with time zone", false),
      column("version", "integer", true, "1"),
      createdAt,
      updatedAt,
    ]),
    exactTable("entitlement_events", [
      idColumn,
      column("enterprise_account_id", "uuid", true),
      column("entitlement_id", "uuid", true),
      column("actor_user_id", "text", false),
      column("event_type", "character varying(64)", true),
      column("reason", "text", false),
      column("previous_state", "jsonb", false),
      column("next_state", "jsonb", true),
      createdAt,
    ]),
    exactTable("organization_groups", [
      idColumn,
      column("enterprise_account_id", "uuid", true),
      column("name", "character varying(255)", true),
      column("status", "character varying(24)", true, "'active'::character varying"),
      column("reporting_timezone", "character varying(64)", true, "'UTC'::character varying"),
      column(
        "default_reporting_currency",
        "character varying(3)",
        true,
        "'USD'::character varying",
      ),
      column("created_by", "text", true),
      createdAt,
      updatedAt,
    ]),
    exactTable("organization_group_members", [
      idColumn,
      column("group_id", "uuid", true),
      column("user_id", "text", true),
      column("role", "character varying(24)", true),
      createdAt,
      updatedAt,
    ]),
    exactTable("organization_group_entities", [
      idColumn,
      column("enterprise_account_id", "uuid", true),
      column("group_id", "uuid", true),
      column("organization_id", "text", true),
      column("status", "character varying(24)", true, "'enabled'::character varying"),
      column("created_by", "text", true),
      createdAt,
      updatedAt,
    ]),
    exactTable("organization_group_audit_events", [
      idColumn,
      column("enterprise_account_id", "uuid", true),
      column("group_id", "uuid", true),
      column("actor_user_id", "text", false),
      column("event_type", "character varying(64)", true),
      column("subject_type", "character varying(32)", true),
      column("subject_id", "text", false),
      column("details", "jsonb", true, "'{}'::jsonb"),
      createdAt,
    ]),
  ],
  indexes: [
    index(
      "enterprise_accounts_external_customer_unique",
      "enterprise_accounts",
      ["external_customer_id"],
      { unique: true, predicate: "external_customer_id IS NOT NULL" },
    ),
    index(
      "enterprise_account_members_account_user_unique",
      "enterprise_account_members",
      ["enterprise_account_id", "user_id"],
      { unique: true },
    ),
    index("enterprise_account_members_user_idx", "enterprise_account_members", [
      "user_id",
      "enterprise_account_id",
    ]),
    index(
      "account_entitlements_account_feature_unique",
      "account_entitlements",
      ["enterprise_account_id", "feature_key"],
      { unique: true },
    ),
    index("account_entitlements_state_idx", "account_entitlements", [
      "feature_key",
      "status",
      "ends_at",
    ]),
    index("entitlement_events_account_created_idx", "entitlement_events", [
      "enterprise_account_id",
      "created_at",
    ]),
    index("organization_groups_account_idx", "organization_groups", [
      "enterprise_account_id",
      "status",
    ]),
    index(
      "organization_group_members_group_user_unique",
      "organization_group_members",
      ["group_id", "user_id"],
      { unique: true },
    ),
    index("organization_group_members_user_idx", "organization_group_members", [
      "user_id",
      "group_id",
    ]),
    index(
      "organization_group_entities_group_org_unique",
      "organization_group_entities",
      ["group_id", "organization_id"],
      { unique: true },
    ),
    index(
      "organization_group_entities_account_org_enabled_unique",
      "organization_group_entities",
      ["enterprise_account_id", "organization_id"],
      { unique: true, predicate: "status::text = 'enabled'::text" },
    ),
    index("organization_group_entities_org_idx", "organization_group_entities", [
      "organization_id",
    ]),
    index("organization_group_audit_group_created_idx", "organization_group_audit_events", [
      "group_id",
      "created_at",
    ]),
    index("organization_group_audit_account_created_idx", "organization_group_audit_events", [
      "enterprise_account_id",
      "created_at",
    ]),
  ],
  constraints: [
    primaryKey("enterprise_accounts", ["id"]),
    foreignKey(
      "enterprise_accounts",
      "enterprise_accounts_created_by_auth_users_id_fk",
      ["created_by"],
      "auth_users",
      ["id"],
      "set_null",
    ),
    check(
      "enterprise_accounts",
      "enterprise_accounts_status_check",
      "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[])))",
    ),
    primaryKey("enterprise_account_members", ["id"]),
    foreignKey(
      "enterprise_account_members",
      "enterprise_account_members_enterprise_account_id_enterprise_accounts_id_fk",
      ["enterprise_account_id"],
      "enterprise_accounts",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "enterprise_account_members",
      "enterprise_account_members_user_id_auth_users_id_fk",
      ["user_id"],
      "auth_users",
      ["id"],
      "cascade",
    ),
    check(
      "enterprise_account_members",
      "enterprise_account_members_role_check",
      "CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'billing_admin'::character varying, 'group_admin'::character varying])::text[])))",
    ),
    primaryKey("account_entitlements", ["id"]),
    foreignKey(
      "account_entitlements",
      "account_entitlements_enterprise_account_id_enterprise_accounts_id_fk",
      ["enterprise_account_id"],
      "enterprise_accounts",
      ["id"],
      "cascade",
    ),
    check(
      "account_entitlements",
      "account_entitlements_status_check",
      "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying, 'grace'::character varying, 'locked'::character varying, 'cancelled'::character varying])::text[])))",
    ),
    check(
      "account_entitlements",
      "account_entitlements_limit_check",
      "CHECK ((included_entity_limit > 0))",
    ),
    check("account_entitlements", "account_entitlements_version_check", "CHECK ((version > 0))"),
    check(
      "account_entitlements",
      "account_entitlements_grace_dates_check",
      "CHECK (((grace_ends_at IS NULL) OR (ends_at IS NULL) OR (grace_ends_at >= ends_at)))",
    ),
    primaryKey("entitlement_events", ["id"]),
    foreignKey(
      "entitlement_events",
      "entitlement_events_enterprise_account_id_enterprise_accounts_id_fk",
      ["enterprise_account_id"],
      "enterprise_accounts",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "entitlement_events",
      "entitlement_events_entitlement_id_account_entitlements_id_fk",
      ["entitlement_id"],
      "account_entitlements",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "entitlement_events",
      "entitlement_events_actor_user_id_auth_users_id_fk",
      ["actor_user_id"],
      "auth_users",
      ["id"],
      "set_null",
    ),
    primaryKey("organization_groups", ["id"]),
    foreignKey(
      "organization_groups",
      "organization_groups_enterprise_account_id_enterprise_accounts_id_fk",
      ["enterprise_account_id"],
      "enterprise_accounts",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "organization_groups",
      "organization_groups_created_by_auth_users_id_fk",
      ["created_by"],
      "auth_users",
      ["id"],
      "restrict",
    ),
    constraint(
      "organization_groups",
      "organization_groups_account_id_unique",
      "unique",
      ["enterprise_account_id", "id"],
      { validated: true },
    ),
    check(
      "organization_groups",
      "organization_groups_name_check",
      "CHECK ((((name)::text = btrim((name)::text)) AND (char_length((name)::text) >= 2) AND (char_length((name)::text) <= 255)))",
    ),
    check(
      "organization_groups",
      "organization_groups_status_check",
      "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))",
    ),
    check(
      "organization_groups",
      "organization_groups_currency_check",
      "CHECK ((((default_reporting_currency)::text = upper((default_reporting_currency)::text)) AND (length((default_reporting_currency)::text) = 3)))",
    ),
    primaryKey("organization_group_members", ["id"]),
    foreignKey(
      "organization_group_members",
      "organization_group_members_group_id_organization_groups_id_fk",
      ["group_id"],
      "organization_groups",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "organization_group_members",
      "organization_group_members_user_id_auth_users_id_fk",
      ["user_id"],
      "auth_users",
      ["id"],
      "cascade",
    ),
    check(
      "organization_group_members",
      "organization_group_members_role_check",
      "CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'analyst'::character varying, 'viewer'::character varying])::text[])))",
    ),
    primaryKey("organization_group_entities", ["id"]),
    foreignKey(
      "organization_group_entities",
      "organization_group_entities_account_group_fk",
      ["enterprise_account_id", "group_id"],
      "organization_groups",
      ["enterprise_account_id", "id"],
      "cascade",
    ),
    foreignKey(
      "organization_group_entities",
      "organization_group_entities_group_id_organization_groups_id_fk",
      ["group_id"],
      "organization_groups",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "organization_group_entities",
      "organization_group_entities_organization_id_auth_organizations_id_fk",
      ["organization_id"],
      "auth_organizations",
      ["id"],
      "restrict",
    ),
    foreignKey(
      "organization_group_entities",
      "organization_group_entities_created_by_auth_users_id_fk",
      ["created_by"],
      "auth_users",
      ["id"],
      "restrict",
    ),
    check(
      "organization_group_entities",
      "organization_group_entities_status_check",
      "CHECK (((status)::text = ANY ((ARRAY['enabled'::character varying, 'disabled'::character varying])::text[])))",
    ),
    primaryKey("organization_group_audit_events", ["id"]),
    foreignKey(
      "organization_group_audit_events",
      "organization_group_audit_events_enterprise_account_id_enterprise_accounts_id_fk",
      ["enterprise_account_id"],
      "enterprise_accounts",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "organization_group_audit_events",
      "organization_group_audit_events_group_id_organization_groups_id_fk",
      ["group_id"],
      "organization_groups",
      ["id"],
      "cascade",
    ),
    foreignKey(
      "organization_group_audit_events",
      "organization_group_audit_events_actor_user_id_auth_users_id_fk",
      ["actor_user_id"],
      "auth_users",
      ["id"],
      "set_null",
    ),
  ],
};

function schema0028AtTarget(options: {
  exclusivity: boolean;
  flatEntities: boolean;
  adminGuards: boolean;
}): CatalogExpectation {
  const entityColumns = [
    idColumn,
    column("group_id", "uuid", true),
    column("organization_id", "text", true),
    ...(options.flatEntities ? [] : [column("parent_entity_id", "uuid", false)]),
    column("status", "character varying(24)", true, "'enabled'::character varying"),
    column("created_by", "text", true),
    createdAt,
    updatedAt,
    ...(options.exclusivity ? [column("enterprise_account_id", "uuid", true)] : []),
  ];
  const conditionalConstraints = new Set([
    ...(!options.exclusivity
      ? [
          "organization_groups.organization_groups_account_id_unique",
          "organization_group_entities.organization_group_entities_account_group_fk",
        ]
      : []),
    ...(!options.adminGuards ? ["organization_groups.organization_groups_name_check"] : []),
  ]);
  const constraints = (schema0028.constraints ?? []).filter(
    (item) => !conditionalConstraints.has(`${item.tableName}.${item.name}`),
  );
  if (!options.flatEntities) {
    constraints.push(
      constraint(
        "organization_group_entities",
        "organization_group_entities_group_id_id_unique",
        "unique",
        ["group_id", "id"],
        { validated: true },
      ),
      check(
        "organization_group_entities",
        "organization_group_entities_not_own_parent_check",
        "CHECK (((parent_entity_id IS NULL) OR (parent_entity_id <> id)))",
      ),
      foreignKey(
        "organization_group_entities",
        "organization_group_entities_same_group_parent_fk",
        ["group_id", "parent_entity_id"],
        "organization_group_entities",
        ["group_id", "id"],
        "restrict",
      ),
    );
  }

  const indexes = (schema0028.indexes ?? []).filter(
    (item) =>
      options.exclusivity || item.name !== "organization_group_entities_account_org_enabled_unique",
  );
  if (!options.flatEntities) {
    indexes.push(
      index("organization_group_entities_group_parent_idx", "organization_group_entities", [
        "group_id",
        "parent_entity_id",
      ]),
    );
  }

  return {
    ...schema0028,
    relations: schema0028.relations?.map((relation) =>
      relation.name === "organization_group_entities"
        ? exactTable("organization_group_entities", entityColumns)
        : relation,
    ),
    indexes,
    constraints,
  };
}

const functions0028 = [
  "is_enterprise_account_member(uuid)",
  "can_access_organization_group(uuid)",
  "can_manage_enterprise_account(uuid)",
  "can_manage_organization_group(uuid)",
  "can_bootstrap_organization_group(uuid, text)",
] as const;

function contracts0028(hardened: boolean): FunctionContract[] {
  const searchPath = hardened
    ? (["pg_catalog", "public", "pg_temp"] as const)
    : (["public"] as const);
  return [
    functionContract(
      "current_user_id()",
      "1ddf96af2b767d6d206e8871cfd2a47b772323e7fd281935b7553ce968acb9f1",
      {
        resultType: "text",
        language: "sql",
        volatility: "stable",
        securityDefiner: false,
      },
    ),
    functionContract(
      "is_enterprise_account_member(uuid)",
      "41f4c2a5fd7eb36abbc1ad12645288d735a1ab5f7902e22ed6b5f568fdbf2fed",
      {
        resultType: "boolean",
        language: "sql",
        volatility: "stable",
        securityDefiner: true,
        searchPath,
      },
    ),
    functionContract(
      "can_access_organization_group(uuid)",
      "859eaa47fec236bb9f0d4e93b3a80fa85876998db45861707153f5ca1cddc4a8",
      {
        resultType: "boolean",
        language: "sql",
        volatility: "stable",
        securityDefiner: true,
        searchPath,
      },
    ),
    functionContract(
      "can_manage_enterprise_account(uuid)",
      "c78d59af120bb0591888500722c2231711667ba2544d26998f43446afcf168b2",
      {
        resultType: "boolean",
        language: "sql",
        volatility: "stable",
        securityDefiner: true,
        searchPath,
      },
    ),
    functionContract(
      "can_manage_organization_group(uuid)",
      hardened
        ? "5c80dbabfaf5f783b6b15fb98dd894c98e3c09ca8c638151792ca4f00f5d4956"
        : "481eaf50270ba7b1c9984df0af9056234221921d511586cf520be83ae118fe22",
      {
        resultType: "boolean",
        language: "sql",
        volatility: "stable",
        securityDefiner: true,
        searchPath,
      },
    ),
    functionContract(
      "can_bootstrap_organization_group(uuid, text)",
      hardened
        ? "fec3dfbaa2cfde6f88fc14108dd7a55f415836b38e32edf6e90d9861163f4b85"
        : "7bbab22d3eaa516c10204572b0ac15060b6c2991589271b0f6628f2b05696c0b",
      {
        resultType: "boolean",
        language: "sql",
        volatility: "stable",
        securityDefiner: true,
        searchPath,
      },
    ),
  ];
}

const policies0028 = [
  "enterprise_accounts.enterprise_accounts_member_access",
  "enterprise_account_members.enterprise_account_members_member_access",
  "account_entitlements.account_entitlements_member_access",
  "entitlement_events.entitlement_events_member_access",
  "organization_groups.organization_groups_member_select",
  "organization_groups.organization_groups_account_insert",
  "organization_groups.organization_groups_member_update",
  "organization_group_members.organization_group_members_group_select",
  "organization_group_members.organization_group_members_group_insert",
  "organization_group_members.organization_group_members_group_update",
  "organization_group_members.organization_group_members_group_delete",
  "organization_group_entities.organization_group_entities_group_select",
  "organization_group_entities.organization_group_entities_group_insert",
  "organization_group_entities.organization_group_entities_group_update",
  "organization_group_entities.organization_group_entities_group_delete",
  "organization_group_audit_events.organization_group_audit_events_group_select",
  "organization_group_audit_events.organization_group_audit_events_group_insert",
] as const;

const policyExpectations0028Base: readonly PolicyExpectation[] = [
  {
    tableName: "enterprise_accounts",
    name: "enterprise_accounts_member_access",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: "is_enterprise_account_member(id)",
    withCheck: null,
  },
  {
    tableName: "enterprise_account_members",
    name: "enterprise_account_members_member_access",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: "is_enterprise_account_member(enterprise_account_id)",
    withCheck: null,
  },
  {
    tableName: "account_entitlements",
    name: "account_entitlements_member_access",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: "is_enterprise_account_member(enterprise_account_id)",
    withCheck: null,
  },
  {
    tableName: "entitlement_events",
    name: "entitlement_events_member_access",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: "is_enterprise_account_member(enterprise_account_id)",
    withCheck: null,
  },
  {
    tableName: "organization_groups",
    name: "organization_groups_member_select",
    permissive: true,
    roles: ["public"],
    command: "select",
    using:
      "can_access_organization_group(id) OR is_enterprise_account_member(enterprise_account_id)",
    withCheck: null,
  },
  {
    tableName: "organization_groups",
    name: "organization_groups_account_insert",
    permissive: true,
    roles: ["public"],
    command: "insert",
    using: null,
    withCheck: "can_manage_enterprise_account(enterprise_account_id)",
  },
  {
    tableName: "organization_groups",
    name: "organization_groups_member_update",
    permissive: true,
    roles: ["public"],
    command: "update",
    using: "can_manage_organization_group(id)",
    withCheck: "can_manage_organization_group(id)",
  },
  {
    tableName: "organization_group_members",
    name: "organization_group_members_group_select",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: "can_access_organization_group(group_id)",
    withCheck: null,
  },
  {
    tableName: "organization_group_members",
    name: "organization_group_members_group_insert",
    permissive: true,
    roles: ["public"],
    command: "insert",
    using: null,
    withCheck:
      "can_manage_organization_group(group_id) OR (role = 'owner' AND can_bootstrap_organization_group(group_id, user_id))",
  },
  {
    tableName: "organization_group_members",
    name: "organization_group_members_group_update",
    permissive: true,
    roles: ["public"],
    command: "update",
    using: "can_manage_organization_group(group_id)",
    withCheck: "can_manage_organization_group(group_id)",
  },
  {
    tableName: "organization_group_members",
    name: "organization_group_members_group_delete",
    permissive: true,
    roles: ["public"],
    command: "delete",
    using: "can_manage_organization_group(group_id)",
    withCheck: null,
  },
  {
    tableName: "organization_group_entities",
    name: "organization_group_entities_group_select",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: "can_access_organization_group(group_id)",
    withCheck: null,
  },
  {
    tableName: "organization_group_entities",
    name: "organization_group_entities_group_insert",
    permissive: true,
    roles: ["public"],
    command: "insert",
    using: null,
    withCheck: "can_manage_organization_group(group_id)",
  },
  {
    tableName: "organization_group_entities",
    name: "organization_group_entities_group_update",
    permissive: true,
    roles: ["public"],
    command: "update",
    using: "can_manage_organization_group(group_id)",
    withCheck: "can_manage_organization_group(group_id)",
  },
  {
    tableName: "organization_group_entities",
    name: "organization_group_entities_group_delete",
    permissive: true,
    roles: ["public"],
    command: "delete",
    using: "can_manage_organization_group(group_id)",
    withCheck: null,
  },
  {
    tableName: "organization_group_audit_events",
    name: "organization_group_audit_events_group_select",
    permissive: true,
    roles: ["public"],
    command: "select",
    using: "can_access_organization_group(group_id)",
    withCheck: null,
  },
  {
    tableName: "organization_group_audit_events",
    name: "organization_group_audit_events_group_insert",
    permissive: true,
    roles: ["public"],
    command: "insert",
    using: null,
    withCheck: "can_manage_organization_group(group_id)",
  },
];

const adminPolicyExpectations = [
  {
    tableName: "organization_group_members",
    name: "organization_group_members_group_insert",
    permissive: true,
    roles: ["public"],
    command: "insert",
    using: null,
    withCheck:
      "(role <> 'owner' AND is_enterprise_organization_group_member(group_id, user_id) AND can_manage_organization_group(group_id)) OR (role = 'owner' AND is_eligible_organization_group_owner(group_id, user_id) AND (can_manage_organization_group_owners(group_id) OR can_bootstrap_organization_group(group_id, user_id)))",
  },
  {
    tableName: "organization_group_members",
    name: "organization_group_members_group_update",
    permissive: true,
    roles: ["public"],
    command: "update",
    using:
      "(role <> 'owner' AND can_manage_organization_group(group_id)) OR (role = 'owner' AND can_manage_organization_group_owners(group_id))",
    withCheck:
      "(role <> 'owner' AND is_enterprise_organization_group_member(group_id, user_id) AND can_manage_organization_group(group_id)) OR (role = 'owner' AND can_manage_organization_group_owners(group_id) AND is_eligible_organization_group_owner(group_id, user_id))",
  },
  {
    tableName: "organization_group_members",
    name: "organization_group_members_group_delete",
    permissive: true,
    roles: ["public"],
    command: "delete",
    using:
      "(role <> 'owner' AND can_manage_organization_group(group_id)) OR (role = 'owner' AND can_manage_organization_group_owners(group_id))",
    withCheck: null,
  },
];

function policyExpectations0028(hardened: boolean): readonly PolicyExpectation[] {
  if (!hardened) return policyExpectations0028Base;
  const replacedPolicies = new Set([
    "organization_group_members_group_insert",
    "organization_group_members_group_update",
    "organization_group_members_group_delete",
    "organization_group_audit_events_group_insert",
  ]);
  return [
    ...policyExpectations0028Base.filter((policy) => !replacedPolicies.has(policy.name)),
    ...adminPolicyExpectations,
  ];
}

const assignmentFunction3 = "is_organization_assigned_to_business_group(uuid, text, uuid)";
const assignmentFunction4 = "is_organization_assigned_to_business_group(uuid, text, uuid, text)";

function assignmentFunctionContract(fourArguments: boolean, hardened: boolean): FunctionContract {
  return functionContract(
    fourArguments ? assignmentFunction4 : assignmentFunction3,
    fourArguments
      ? "e6f994df4fbd7389127f5b28418e7f96a274af7e0f42aa5fa73118340e420120"
      : "50a512d3e2ee9fe4c615618d844e655a8b2453360f8c293a5b0c34894ad22812",
    {
      resultType: "boolean",
      language: "sql",
      volatility: "stable",
      securityDefiner: true,
      searchPath: hardened ? ["pg_catalog", "public", "pg_temp"] : ["public"],
    },
  );
}

function assignmentFunctionPrivileges(
  snapshot: CatalogSnapshot,
  objectIdentity: typeof assignmentFunction3 | typeof assignmentFunction4,
): PrivilegeExpectation[] {
  return requireNonGrantable([
    {
      objectType: "function",
      objectIdentity,
      grantee: "PUBLIC",
      privilege: "EXECUTE",
      present: false,
    },
    ...privilegesForExistingRuntimeRoles(snapshot, (grantee) => [
      {
        objectType: "function",
        objectIdentity,
        grantee,
        privilege: "EXECUTE",
      },
    ]),
  ]);
}

function schema0029(flat: boolean, synchronized = false): CatalogExpectation {
  const historicalColumns = [
    idColumn,
    column("group_id", "uuid", true),
    column("organization_id", "text", true),
    ...(flat ? [] : [column("parent_entity_id", "uuid", false)]),
    column("status", "character varying(24)", true, "'enabled'::character varying"),
    column("created_by", "text", true),
    createdAt,
    updatedAt,
    column("enterprise_account_id", "uuid", true),
  ];
  const synchronizedColumns = [
    idColumn,
    column("enterprise_account_id", "uuid", true),
    column("group_id", "uuid", true),
    column("organization_id", "text", true),
    column("status", "character varying(24)", true, "'enabled'::character varying"),
    column("created_by", "text", true),
    createdAt,
    updatedAt,
  ];
  return {
    relations: [
      {
        name: "organization_group_entities",
        kind: "table",
        columns: synchronized ? synchronizedColumns : historicalColumns,
        exactColumns: true,
      },
    ],
    indexes: [
      index(
        "organization_group_entities_account_org_enabled_unique",
        "organization_group_entities",
        ["enterprise_account_id", "organization_id"],
        {
          unique: true,
          predicate: "status::text = 'enabled'::text",
        },
      ),
    ],
    constraints: [
      constraint(
        "organization_groups",
        "organization_groups_account_id_unique",
        "unique",
        ["enterprise_account_id", "id"],
        { validated: true },
      ),
      foreignKey(
        "organization_group_entities",
        "organization_group_entities_account_group_fk",
        ["enterprise_account_id", "group_id"],
        "organization_groups",
        ["enterprise_account_id", "id"],
        "cascade",
      ),
    ],
  };
}

function predecessorSchema0029(): CatalogExpectation {
  const predecessor = schema0028AtTarget({
    exclusivity: false,
    flatEntities: false,
    adminGuards: false,
  });
  return {
    relations: predecessor.relations
      ?.filter((relation) => relation.name === "organization_group_entities")
      .map((relation) => ({ ...relation, rls: true })),
    indexes: predecessor.indexes?.filter(
      (candidate) => candidate.tableName === "organization_group_entities",
    ),
    constraints: predecessor.constraints?.filter(
      (candidate) => candidate.tableName === "organization_group_entities",
    ),
  };
}

function predecessorSchema0031(): CatalogExpectation {
  const predecessor = schema0028AtTarget({
    exclusivity: true,
    flatEntities: false,
    adminGuards: false,
  });
  return {
    relations: predecessor.relations
      ?.filter((relation) => relation.name === "organization_group_entities")
      .map((relation) => ({ ...relation, rls: true })),
    indexes: predecessor.indexes?.filter(
      (candidate) => candidate.tableName === "organization_group_entities",
    ),
    constraints: predecessor.constraints?.filter(
      (candidate) =>
        candidate.tableName === "organization_group_entities" ||
        (candidate.tableName === "organization_groups" &&
          candidate.name === "organization_groups_account_id_unique"),
    ),
  };
}

function classifyPredecessor(checks: readonly VerificationEvidence[]) {
  if (checks.every((item) => item.status !== "fail")) {
    return {
      state: "absent" as const,
      shape: "predecessor-compatible",
      evidence: checks,
    };
  }
  return {
    state: "partial" as const,
    shape: "predecessor-drift",
    evidence: checks,
  };
}

function absentFunctionEvidence(identity: string, snapshot: CatalogSnapshot) {
  return evidence(
    `function:${identity}:absent`,
    !snapshot.functions.has(identity),
    "absent",
    snapshot.functions.has(identity) ? "present" : "absent",
  );
}

export {
  adminPolicyExpectations,
  assignmentFunction3,
  assignmentFunction4,
  assignmentFunctionContract,
  assignmentFunctionPrivileges,
  absentFunctionEvidence,
  classifyPredecessor,
  contracts0028,
  functions0028,
  policies0028,
  policyExpectations0028,
  policyExpectations0028Base,
  predecessorSchema0029,
  predecessorSchema0031,
  schema0028,
  schema0028AtTarget,
  schema0029,
};
