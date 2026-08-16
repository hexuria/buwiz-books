import type { MigrationId } from "@/lib/migrations/manifest";
import type { CatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  addCheck,
  addConstraint,
  addForeignKey,
  addFunction,
  addIndex,
  addPolicy,
  addPrimaryKey,
  addPrivilege,
  addSchemaTable,
  column,
} from "../support";

const schemaTimestamp = (name: string) =>
  column(name, 1, "timestamp with time zone", true, "now()");

function addSchema0028(snapshot: CatalogSnapshot) {
  const id = column("id", 1, "uuid", true, "gen_random_uuid()");
  const createdAt = schemaTimestamp("created_at");
  const updatedAt = schemaTimestamp("updated_at");
  const tables = {
    enterprise_accounts: [
      id,
      column("name", 2, "character varying(255)"),
      column("status", 3, "character varying(24)", true, "'active'::character varying"),
      column("billing_contact_email", 4, "character varying(320)", false),
      column("external_customer_id", 5, "character varying(255)", false),
      column("created_by", 6, "text", false),
      createdAt,
      updatedAt,
    ],
    enterprise_account_members: [
      id,
      column("enterprise_account_id", 2, "uuid"),
      column("user_id", 3),
      column("role", 4, "character varying(32)"),
      createdAt,
      updatedAt,
    ],
    account_entitlements: [
      id,
      column("enterprise_account_id", 2, "uuid"),
      column("feature_key", 3, "character varying(64)"),
      column("status", 4, "character varying(24)"),
      column("included_entity_limit", 5, "integer"),
      column(
        "provisioning_source",
        6,
        "character varying(32)",
        true,
        "'contract'::character varying",
      ),
      column("starts_at", 7, "timestamp with time zone"),
      column("ends_at", 8, "timestamp with time zone", false),
      column("grace_ends_at", 9, "timestamp with time zone", false),
      column("version", 10, "integer", true, "1"),
      createdAt,
      updatedAt,
    ],
    entitlement_events: [
      id,
      column("enterprise_account_id", 2, "uuid"),
      column("entitlement_id", 3, "uuid"),
      column("actor_user_id", 4, "text", false),
      column("event_type", 5, "character varying(64)"),
      column("reason", 6, "text", false),
      column("previous_state", 7, "jsonb", false),
      column("next_state", 8, "jsonb"),
      createdAt,
    ],
    organization_groups: [
      id,
      column("enterprise_account_id", 2, "uuid"),
      column("name", 3, "character varying(255)"),
      column("status", 4, "character varying(24)", true, "'active'::character varying"),
      column("reporting_timezone", 5, "character varying(64)", true, "'UTC'::character varying"),
      column(
        "default_reporting_currency",
        6,
        "character varying(3)",
        true,
        "'USD'::character varying",
      ),
      column("created_by", 7),
      createdAt,
      updatedAt,
    ],
    organization_group_members: [
      id,
      column("group_id", 2, "uuid"),
      column("user_id", 3),
      column("role", 4, "character varying(24)"),
      createdAt,
      updatedAt,
    ],
    organization_group_entities: [
      id,
      column("enterprise_account_id", 2, "uuid"),
      column("group_id", 3, "uuid"),
      column("organization_id", 4),
      column("status", 5, "character varying(24)", true, "'enabled'::character varying"),
      column("created_by", 6),
      createdAt,
      updatedAt,
    ],
    organization_group_audit_events: [
      id,
      column("enterprise_account_id", 2, "uuid"),
      column("group_id", 3, "uuid"),
      column("actor_user_id", 4, "text", false),
      column("event_type", 5, "character varying(64)"),
      column("subject_type", 6, "character varying(32)"),
      column("subject_id", 7, "text", false),
      column("details", 8, "jsonb", true, "'{}'::jsonb"),
      createdAt,
    ],
  } as const;
  for (const [name, columns] of Object.entries(tables)) {
    addSchemaTable(snapshot, name, columns);
  }

  addIndex(
    snapshot,
    "enterprise_accounts_external_customer_unique",
    "enterprise_accounts",
    ["external_customer_id"],
    { unique: true, predicate: "external_customer_id IS NOT NULL" },
  );
  addIndex(
    snapshot,
    "enterprise_account_members_account_user_unique",
    "enterprise_account_members",
    ["enterprise_account_id", "user_id"],
    { unique: true },
  );
  addIndex(snapshot, "enterprise_account_members_user_idx", "enterprise_account_members", [
    "user_id",
    "enterprise_account_id",
  ]);
  addIndex(
    snapshot,
    "account_entitlements_account_feature_unique",
    "account_entitlements",
    ["enterprise_account_id", "feature_key"],
    { unique: true },
  );
  addIndex(snapshot, "account_entitlements_state_idx", "account_entitlements", [
    "feature_key",
    "status",
    "ends_at",
  ]);
  addIndex(snapshot, "entitlement_events_account_created_idx", "entitlement_events", [
    "enterprise_account_id",
    "created_at",
  ]);
  addIndex(snapshot, "organization_groups_account_idx", "organization_groups", [
    "enterprise_account_id",
    "status",
  ]);
  addIndex(
    snapshot,
    "organization_group_members_group_user_unique",
    "organization_group_members",
    ["group_id", "user_id"],
    { unique: true },
  );
  addIndex(snapshot, "organization_group_members_user_idx", "organization_group_members", [
    "user_id",
    "group_id",
  ]);
  addIndex(
    snapshot,
    "organization_group_entities_group_org_unique",
    "organization_group_entities",
    ["group_id", "organization_id"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "organization_group_entities_account_org_enabled_unique",
    "organization_group_entities",
    ["enterprise_account_id", "organization_id"],
    { unique: true, predicate: "status::text = 'enabled'::text" },
  );
  addIndex(snapshot, "organization_group_entities_org_idx", "organization_group_entities", [
    "organization_id",
  ]);
  addIndex(
    snapshot,
    "organization_group_audit_group_created_idx",
    "organization_group_audit_events",
    ["group_id", "created_at"],
  );
  addIndex(
    snapshot,
    "organization_group_audit_account_created_idx",
    "organization_group_audit_events",
    ["enterprise_account_id", "created_at"],
  );

  addPrimaryKey(snapshot, "enterprise_accounts");
  addForeignKey(
    snapshot,
    "enterprise_accounts",
    "enterprise_accounts_created_by_auth_users_id_fk",
    ["created_by"],
    "auth_users",
    ["id"],
    "set_null",
  );
  addCheck(
    snapshot,
    "enterprise_accounts",
    "enterprise_accounts_status_check",
    "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'suspended'::character varying])::text[])))",
  );
  addPrimaryKey(snapshot, "enterprise_account_members");
  addForeignKey(
    snapshot,
    "enterprise_account_members",
    "enterprise_account_members_enterprise_account_id_enterprise_accounts_id_fk",
    ["enterprise_account_id"],
    "enterprise_accounts",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "enterprise_account_members",
    "enterprise_account_members_user_id_auth_users_id_fk",
    ["user_id"],
    "auth_users",
    ["id"],
    "cascade",
  );
  addCheck(
    snapshot,
    "enterprise_account_members",
    "enterprise_account_members_role_check",
    "CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'billing_admin'::character varying, 'group_admin'::character varying])::text[])))",
  );
  addPrimaryKey(snapshot, "account_entitlements");
  addForeignKey(
    snapshot,
    "account_entitlements",
    "account_entitlements_enterprise_account_id_enterprise_accounts_id_fk",
    ["enterprise_account_id"],
    "enterprise_accounts",
    ["id"],
    "cascade",
  );
  addCheck(
    snapshot,
    "account_entitlements",
    "account_entitlements_status_check",
    "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'active'::character varying, 'grace'::character varying, 'locked'::character varying, 'cancelled'::character varying])::text[])))",
  );
  addCheck(
    snapshot,
    "account_entitlements",
    "account_entitlements_limit_check",
    "CHECK ((included_entity_limit > 0))",
  );
  addCheck(
    snapshot,
    "account_entitlements",
    "account_entitlements_version_check",
    "CHECK ((version > 0))",
  );
  addCheck(
    snapshot,
    "account_entitlements",
    "account_entitlements_grace_dates_check",
    "CHECK (((grace_ends_at IS NULL) OR (ends_at IS NULL) OR (grace_ends_at >= ends_at)))",
  );
  addPrimaryKey(snapshot, "entitlement_events");
  addForeignKey(
    snapshot,
    "entitlement_events",
    "entitlement_events_enterprise_account_id_enterprise_accounts_id_fk",
    ["enterprise_account_id"],
    "enterprise_accounts",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "entitlement_events",
    "entitlement_events_entitlement_id_account_entitlements_id_fk",
    ["entitlement_id"],
    "account_entitlements",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "entitlement_events",
    "entitlement_events_actor_user_id_auth_users_id_fk",
    ["actor_user_id"],
    "auth_users",
    ["id"],
    "set_null",
  );
  addPrimaryKey(snapshot, "organization_groups");
  addForeignKey(
    snapshot,
    "organization_groups",
    "organization_groups_enterprise_account_id_enterprise_accounts_id_fk",
    ["enterprise_account_id"],
    "enterprise_accounts",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "organization_groups",
    "organization_groups_created_by_auth_users_id_fk",
    ["created_by"],
    "auth_users",
    ["id"],
    "restrict",
  );
  addConstraint(
    snapshot,
    "organization_groups",
    "organization_groups_account_id_unique",
    "unique",
    ["enterprise_account_id", "id"],
  );
  addCheck(
    snapshot,
    "organization_groups",
    "organization_groups_name_check",
    "CHECK ((((name)::text = btrim((name)::text)) AND ((char_length((name)::text) >= 2) AND (char_length((name)::text) <= 255))))",
  );
  addCheck(
    snapshot,
    "organization_groups",
    "organization_groups_status_check",
    "CHECK (((status)::text = ANY ((ARRAY['active'::character varying, 'archived'::character varying])::text[])))",
  );
  addCheck(
    snapshot,
    "organization_groups",
    "organization_groups_currency_check",
    "CHECK ((((default_reporting_currency)::text = upper((default_reporting_currency)::text)) AND (length((default_reporting_currency)::text) = 3)))",
  );
  addPrimaryKey(snapshot, "organization_group_members");
  addForeignKey(
    snapshot,
    "organization_group_members",
    "organization_group_members_group_id_organization_groups_id_fk",
    ["group_id"],
    "organization_groups",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "organization_group_members",
    "organization_group_members_user_id_auth_users_id_fk",
    ["user_id"],
    "auth_users",
    ["id"],
    "cascade",
  );
  addCheck(
    snapshot,
    "organization_group_members",
    "organization_group_members_role_check",
    "CHECK (((role)::text = ANY ((ARRAY['owner'::character varying, 'admin'::character varying, 'analyst'::character varying, 'viewer'::character varying])::text[])))",
  );
  addPrimaryKey(snapshot, "organization_group_entities");
  addForeignKey(
    snapshot,
    "organization_group_entities",
    "organization_group_entities_account_group_fk",
    ["enterprise_account_id", "group_id"],
    "organization_groups",
    ["enterprise_account_id", "id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "organization_group_entities",
    "organization_group_entities_group_id_organization_groups_id_fk",
    ["group_id"],
    "organization_groups",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "organization_group_entities",
    "organization_group_entities_organization_id_auth_organizations_id_fk",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "restrict",
  );
  addForeignKey(
    snapshot,
    "organization_group_entities",
    "organization_group_entities_created_by_auth_users_id_fk",
    ["created_by"],
    "auth_users",
    ["id"],
    "restrict",
  );
  addCheck(
    snapshot,
    "organization_group_entities",
    "organization_group_entities_status_check",
    "CHECK (((status)::text = ANY ((ARRAY['enabled'::character varying, 'disabled'::character varying])::text[])))",
  );
  addPrimaryKey(snapshot, "organization_group_audit_events");
  addForeignKey(
    snapshot,
    "organization_group_audit_events",
    "organization_group_audit_events_enterprise_account_id_enterprise_accounts_id_fk",
    ["enterprise_account_id"],
    "enterprise_accounts",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "organization_group_audit_events",
    "organization_group_audit_events_group_id_organization_groups_id_fk",
    ["group_id"],
    "organization_groups",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "organization_group_audit_events",
    "organization_group_audit_events_actor_user_id_auth_users_id_fk",
    ["actor_user_id"],
    "auth_users",
    ["id"],
    "set_null",
  );
}

const assignmentFunction4Body = `SELECT
  (current_user_id() IS NULL OR current_user_id() = target_user_id)
  AND EXISTS (
    SELECT 1
    FROM enterprise_account_members account_membership
    WHERE account_membership.enterprise_account_id = target_account_id
      AND account_membership.user_id = target_user_id
  )
  AND EXISTS (
    SELECT 1
    FROM auth_members membership
    WHERE membership.user_id = target_user_id
      AND membership.organization_id = target_organization_id
  )
  AND EXISTS (
    SELECT 1
    FROM organization_group_entities entity
    WHERE entity.enterprise_account_id = target_account_id
      AND entity.organization_id = target_organization_id
      AND entity.status = 'enabled'
      AND entity.group_id <> excluded_group_id
  );`;

const assignmentFunction3Body = `SELECT is_enterprise_account_member(target_account_id)
  AND EXISTS (
    SELECT 1
    FROM auth_members membership
    WHERE membership.user_id = current_user_id()
      AND membership.organization_id = target_organization_id
  )
  AND EXISTS (
    SELECT 1
    FROM organization_group_entities entity
    WHERE entity.enterprise_account_id = target_account_id
      AND entity.organization_id = target_organization_id
      AND entity.status = 'enabled'
      AND (excluded_group_id IS NULL OR entity.group_id <> excluded_group_id)
  );`;

const functionBodies0028 = {
  "current_user_id()": `SELECT NULLIF(current_setting('app.current_user_id', true), '');`,
  "is_enterprise_account_member(uuid)": `SELECT EXISTS (
    SELECT 1 FROM enterprise_account_members membership
    WHERE membership.enterprise_account_id = target_account_id
      AND membership.user_id = current_user_id()
  );`,
  "can_access_organization_group(uuid)": `SELECT EXISTS (
    SELECT 1
    FROM organization_group_members membership
    INNER JOIN organization_groups groups ON groups.id = membership.group_id
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
      AND account_membership.user_id = membership.user_id
    WHERE membership.group_id = target_group_id
      AND membership.user_id = current_user_id()
  );`,
  "can_manage_enterprise_account(uuid)": `SELECT EXISTS (
    SELECT 1 FROM enterprise_account_members membership
    WHERE membership.enterprise_account_id = target_account_id
      AND membership.user_id = current_user_id()
      AND membership.role IN ('owner', 'group_admin')
  );`,
  "can_manage_organization_group(uuid)": `SELECT EXISTS (
    SELECT 1
    FROM organization_group_members membership
    INNER JOIN organization_groups groups ON groups.id = membership.group_id
    INNER JOIN enterprise_account_members account_membership
      ON account_membership.enterprise_account_id = groups.enterprise_account_id
      AND account_membership.user_id = membership.user_id
    WHERE membership.group_id = target_group_id
      AND membership.user_id = current_user_id()
      AND membership.role IN ('owner', 'admin')
  );`,
  "can_bootstrap_organization_group(uuid, text)": `SELECT target_user_id = current_user_id()
    AND EXISTS (
      SELECT 1
      FROM organization_groups groups
      WHERE groups.id = target_group_id
        AND groups.created_by = current_user_id()
        AND can_manage_enterprise_account(groups.enterprise_account_id)
    )
    AND NOT EXISTS (
      SELECT 1 FROM organization_group_members membership
      WHERE membership.group_id = target_group_id
    );`,
} as const;

const policyRows0028 = [
  [
    "enterprise_accounts",
    "enterprise_accounts_member_access",
    { command: "select", using: "is_enterprise_account_member(id)" },
  ],
  [
    "enterprise_account_members",
    "enterprise_account_members_member_access",
    {
      command: "select",
      using: "is_enterprise_account_member(enterprise_account_id)",
    },
  ],
  [
    "account_entitlements",
    "account_entitlements_member_access",
    {
      command: "select",
      using: "is_enterprise_account_member(enterprise_account_id)",
    },
  ],
  [
    "entitlement_events",
    "entitlement_events_member_access",
    {
      command: "select",
      using: "is_enterprise_account_member(enterprise_account_id)",
    },
  ],
  [
    "organization_groups",
    "organization_groups_member_select",
    {
      command: "select",
      using:
        "can_access_organization_group(id) OR is_enterprise_account_member(enterprise_account_id)",
    },
  ],
  [
    "organization_groups",
    "organization_groups_account_insert",
    {
      command: "insert",
      withCheck: "can_manage_enterprise_account(enterprise_account_id)",
    },
  ],
  [
    "organization_groups",
    "organization_groups_member_update",
    {
      command: "update",
      using: "can_manage_organization_group(id)",
      withCheck: "can_manage_organization_group(id)",
    },
  ],
  [
    "organization_group_members",
    "organization_group_members_group_select",
    { command: "select", using: "can_access_organization_group(group_id)" },
  ],
  [
    "organization_group_members",
    "organization_group_members_group_insert",
    {
      command: "insert",
      withCheck:
        "can_manage_organization_group(group_id) OR (role = 'owner' AND can_bootstrap_organization_group(group_id, user_id))",
    },
  ],
  [
    "organization_group_members",
    "organization_group_members_group_update",
    {
      command: "update",
      using: "can_manage_organization_group(group_id)",
      withCheck: "can_manage_organization_group(group_id)",
    },
  ],
  [
    "organization_group_members",
    "organization_group_members_group_delete",
    { command: "delete", using: "can_manage_organization_group(group_id)" },
  ],
  [
    "organization_group_entities",
    "organization_group_entities_group_select",
    { command: "select", using: "can_access_organization_group(group_id)" },
  ],
  [
    "organization_group_entities",
    "organization_group_entities_group_insert",
    { command: "insert", withCheck: "can_manage_organization_group(group_id)" },
  ],
  [
    "organization_group_entities",
    "organization_group_entities_group_update",
    {
      command: "update",
      using: "can_manage_organization_group(group_id)",
      withCheck: "can_manage_organization_group(group_id)",
    },
  ],
  [
    "organization_group_entities",
    "organization_group_entities_group_delete",
    { command: "delete", using: "can_manage_organization_group(group_id)" },
  ],
  [
    "organization_group_audit_events",
    "organization_group_audit_events_group_select",
    { command: "select", using: "can_access_organization_group(group_id)" },
  ],
  [
    "organization_group_audit_events",
    "organization_group_audit_events_group_insert",
    { command: "insert", withCheck: "can_manage_organization_group(group_id)" },
  ],
] as const;

const runtimeTables0028 = [
  "enterprise_accounts",
  "enterprise_account_members",
  "account_entitlements",
  "entitlement_events",
  "organization_groups",
  "organization_group_members",
  "organization_group_entities",
  "organization_group_audit_events",
] as const;

const runtimeFunctions0028 = [
  "is_enterprise_account_member(uuid)",
  "can_access_organization_group(uuid)",
  "can_manage_enterprise_account(uuid)",
  "can_manage_organization_group(uuid)",
  "can_bootstrap_organization_group(uuid, text)",
] as const;

function addRuntimeGrants0028(snapshot: CatalogSnapshot, role: string) {
  for (const tableName of runtimeTables0028) {
    for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE"]) {
      addPrivilege(snapshot, "table", tableName, role, privilege);
    }
  }
  for (const identity of runtimeFunctions0028) {
    addPrivilege(snapshot, "function", identity, role, "EXECUTE");
  }
}

function addComplete0028(snapshot: CatalogSnapshot, through: MigrationId) {
  addSchema0028(snapshot);
  for (const relation of snapshot.relations.values()) relation.rls = true;

  const has0029 = through >= "0029";
  const has0031 = through >= "0031";
  const entityColumns = [
    column("id", 1, "uuid", true, "gen_random_uuid()"),
    column("group_id", 2, "uuid"),
    column("organization_id", 3),
    ...(has0031 ? [] : [column("parent_entity_id", 4, "uuid", false)]),
    column(
      "status",
      has0031 ? 4 : 5,
      "character varying(24)",
      true,
      "'enabled'::character varying",
    ),
    column("created_by", has0031 ? 5 : 6),
    column("created_at", has0031 ? 6 : 7, "timestamp with time zone", true, "now()"),
    column("updated_at", has0031 ? 7 : 8, "timestamp with time zone", true, "now()"),
    ...(has0029 ? [column("enterprise_account_id", has0031 ? 8 : 9, "uuid")] : []),
  ];
  snapshot.relations.get("organization_group_entities")!.columns = entityColumns;

  if (!has0029) {
    snapshot.indexes.delete("organization_group_entities_account_org_enabled_unique");
    snapshot.constraints.delete("organization_groups.organization_groups_account_id_unique");
    snapshot.constraints.delete(
      "organization_group_entities.organization_group_entities_account_group_fk",
    );
  }
  if (!has0031) {
    addIndex(
      snapshot,
      "organization_group_entities_group_parent_idx",
      "organization_group_entities",
      ["group_id", "parent_entity_id"],
    );
    addConstraint(
      snapshot,
      "organization_group_entities",
      "organization_group_entities_group_id_id_unique",
      "unique",
      ["group_id", "id"],
    );
    addCheck(
      snapshot,
      "organization_group_entities",
      "organization_group_entities_not_own_parent_check",
      "CHECK (((parent_entity_id IS NULL) OR (parent_entity_id <> id)))",
    );
    addForeignKey(
      snapshot,
      "organization_group_entities",
      "organization_group_entities_same_group_parent_fk",
      ["group_id", "parent_entity_id"],
      "organization_group_entities",
      ["group_id", "id"],
      "restrict",
    );
  }
  if (through < "0034") {
    snapshot.constraints.delete("organization_groups.organization_groups_name_check");
  }

  for (const [identity, body] of Object.entries(functionBodies0028)) {
    addFunction(
      snapshot,
      identity,
      body,
      identity === "current_user_id()"
        ? {
            resultType: "text",
            securityDefiner: false,
            config: null,
          }
        : {},
    );
  }
  for (const [tableName, name, options] of policyRows0028) {
    addPolicy(snapshot, tableName, name, options);
  }
}

function addAssignmentSchema(snapshot: CatalogSnapshot, flat: boolean) {
  addSchemaTable(snapshot, "organization_group_entities", [
    column("id", 1, "uuid", true, "gen_random_uuid()"),
    column("group_id", 2, "uuid"),
    column("organization_id", 3),
    ...(flat ? [] : [column("parent_entity_id", 4, "uuid", false)]),
    column("status", flat ? 4 : 5, "character varying(24)", true, "'enabled'::character varying"),
    column("created_by", flat ? 5 : 6),
    column("created_at", flat ? 6 : 7, "timestamp with time zone", true, "now()"),
    column("updated_at", flat ? 7 : 8, "timestamp with time zone", true, "now()"),
    column("enterprise_account_id", flat ? 8 : 9, "uuid"),
  ]);
  addIndex(
    snapshot,
    "organization_group_entities_account_org_enabled_unique",
    "organization_group_entities",
    ["enterprise_account_id", "organization_id"],
    { unique: true, predicate: "status::text = 'enabled'::text" },
  );
  addConstraint(
    snapshot,
    "organization_groups",
    "organization_groups_account_id_unique",
    "unique",
    ["enterprise_account_id", "id"],
  );
  addForeignKey(
    snapshot,
    "organization_group_entities",
    "organization_group_entities_account_group_fk",
    ["enterprise_account_id", "group_id"],
    "organization_groups",
    ["enterprise_account_id", "id"],
    "cascade",
  );
}

export {
  addAssignmentSchema,
  addComplete0028,
  addRuntimeGrants0028,
  addSchema0028,
  assignmentFunction3Body,
  assignmentFunction4Body,
};
