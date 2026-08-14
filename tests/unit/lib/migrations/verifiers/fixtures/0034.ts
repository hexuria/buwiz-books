import type { CatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  addCheck,
  addFunction,
  addPolicy,
  addPrimaryKey,
  addPrivilege,
  addSchemaTable,
  addTrigger,
  column,
  migrationFunctionBody,
  migrationSql,
} from "../support";

function addComplete0034(snapshot: CatalogSnapshot) {
  for (const tableName of [
    "organization_groups",
    "organization_group_entities",
    "organization_group_members",
    "enterprise_account_members",
    "auth_users",
    "organization_group_audit_events",
    "entitlement_events",
    "business_group_projection_reconciliation_events",
  ]) {
    if (!snapshot.relations.has(tableName)) addSchemaTable(snapshot, tableName, []);
  }
  addSchemaTable(snapshot, "business_group_owner_transfer_context", [
    column("transaction_id", 1, "bigint"),
    column("group_id", 2, "uuid"),
    column("actor_user_id", 3),
    column("previous_owner_user_id", 4),
    column("replacement_owner_user_id", 5),
  ]);
  addPrimaryKey(snapshot, "business_group_owner_transfer_context", ["transaction_id", "group_id"]);
  addCheck(
    snapshot,
    "organization_groups",
    "organization_groups_name_check",
    "CHECK ((((name)::text = btrim((name)::text)) AND (char_length((name)::text) >= 2) AND (char_length((name)::text) <= 255)))",
  );

  const sql0028 = migrationSql("0028_enterprise_business_groups.sql");
  const sql0030 = migrationSql("0030_business_group_assignment_probe.sql");
  const sql0034 = migrationSql("0034_business_group_admin_guards.sql");
  for (const [identity, functionName] of [
    ["is_enterprise_account_member(uuid)", "is_enterprise_account_member"],
    ["can_access_organization_group(uuid)", "can_access_organization_group"],
    ["can_manage_enterprise_account(uuid)", "can_manage_enterprise_account"],
  ] as const) {
    addFunction(snapshot, identity, migrationFunctionBody(sql0028, functionName), {
      config: ["search_path=pg_catalog, public, pg_temp"],
    });
  }
  addFunction(
    snapshot,
    "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
    migrationFunctionBody(sql0030, "is_organization_assigned_to_business_group"),
    { config: ["search_path=pg_catalog, public, pg_temp"] },
  );

  for (const [identity, functionName, resultType, language, volatility] of [
    [
      "lock_business_group_user_rows(text[])",
      "lock_business_group_user_rows",
      "integer",
      "plpgsql",
      "volatile",
    ],
    [
      "is_enterprise_organization_group_member(uuid, text)",
      "is_enterprise_organization_group_member",
      "boolean",
      "sql",
      "stable",
    ],
    [
      "has_active_business_groups_entitlement(uuid)",
      "has_active_business_groups_entitlement",
      "boolean",
      "sql",
      "stable",
    ],
    [
      "is_eligible_organization_group_owner(uuid, text)",
      "is_eligible_organization_group_owner",
      "boolean",
      "sql",
      "stable",
    ],
    [
      "can_manage_organization_group(uuid)",
      "can_manage_organization_group",
      "boolean",
      "sql",
      "stable",
    ],
    [
      "can_manage_organization_group_owners(uuid)",
      "can_manage_organization_group_owners",
      "boolean",
      "sql",
      "stable",
    ],
    [
      "can_bootstrap_organization_group(uuid, text)",
      "can_bootstrap_organization_group",
      "boolean",
      "sql",
      "stable",
    ],
    [
      "audit_organization_group_creation()",
      "audit_organization_group_creation",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "enforce_organization_group_creation_entitlement()",
      "enforce_organization_group_creation_entitlement",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "enforce_organization_group_lifecycle()",
      "enforce_organization_group_lifecycle",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "ensure_organization_group_has_eligible_owner()",
      "ensure_organization_group_has_eligible_owner",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "enforce_active_organization_group_entity()",
      "enforce_active_organization_group_entity",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "audit_organization_group_entity_change()",
      "audit_organization_group_entity_change",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "enforce_organization_group_member_invariants()",
      "enforce_organization_group_member_invariants",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "transfer_organization_group_ownership(uuid, text, text)",
      "transfer_organization_group_ownership",
      "void",
      "plpgsql",
      "volatile",
    ],
    [
      "audit_organization_group_member_change()",
      "audit_organization_group_member_change",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "guard_enterprise_membership_owned_groups()",
      "guard_enterprise_membership_owned_groups",
      "trigger",
      "plpgsql",
      "volatile",
    ],
    [
      "guard_user_owned_business_groups()",
      "guard_user_owned_business_groups",
      "trigger",
      "plpgsql",
      "volatile",
    ],
  ] as const) {
    addFunction(snapshot, identity, migrationFunctionBody(sql0034, functionName), {
      resultType,
      language,
      volatility,
      config: ["search_path=pg_catalog, public, pg_temp"],
    });
  }

  for (const [tableName, name, functionIdentity, timing, events, constraintTrigger] of [
    [
      "organization_groups",
      "organization_groups_creation_entitlement_guard",
      "enforce_organization_group_creation_entitlement()",
      "before",
      ["insert"],
      false,
    ],
    [
      "organization_groups",
      "organization_groups_creation_audit",
      "audit_organization_group_creation()",
      "after",
      ["insert"],
      false,
    ],
    [
      "organization_groups",
      "organization_groups_lifecycle_guard",
      "enforce_organization_group_lifecycle()",
      "before",
      ["update"],
      false,
    ],
    [
      "organization_groups",
      "organization_groups_eligible_owner_constraint",
      "ensure_organization_group_has_eligible_owner()",
      "after",
      ["insert"],
      true,
    ],
    [
      "organization_group_entities",
      "organization_group_entities_active_group_guard",
      "enforce_active_organization_group_entity()",
      "before",
      ["insert", "update", "delete"],
      false,
    ],
    [
      "organization_group_entities",
      "organization_group_entities_audit",
      "audit_organization_group_entity_change()",
      "after",
      ["insert", "update", "delete"],
      false,
    ],
    [
      "organization_group_members",
      "organization_group_members_admin_guard",
      "enforce_organization_group_member_invariants()",
      "before",
      ["insert", "update", "delete"],
      false,
    ],
    [
      "organization_group_members",
      "organization_group_members_audit",
      "audit_organization_group_member_change()",
      "after",
      ["insert", "update", "delete"],
      false,
    ],
    [
      "enterprise_account_members",
      "enterprise_account_members_owned_groups_guard",
      "guard_enterprise_membership_owned_groups()",
      "before",
      ["update", "delete"],
      false,
    ],
    [
      "auth_users",
      "auth_users_owned_business_groups_guard",
      "guard_user_owned_business_groups()",
      "before",
      ["delete"],
      false,
    ],
  ] as const) {
    addTrigger(snapshot, tableName, name, functionIdentity, [...events], {
      level: "row",
      timing,
      constraint: constraintTrigger,
      deferrable: constraintTrigger,
      initiallyDeferred: constraintTrigger,
    });
  }

  addPolicy(snapshot, "organization_group_members", "organization_group_members_group_select", {
    command: "select",
    using: "can_access_organization_group(group_id)",
  });
  addPolicy(
    snapshot,
    "organization_group_audit_events",
    "organization_group_audit_events_group_select",
    {
      command: "select",
      using: "can_access_organization_group(group_id)",
    },
  );
  addPolicy(snapshot, "organization_group_members", "organization_group_members_group_insert", {
    command: "insert",
    withCheck:
      "(role <> 'owner' AND is_enterprise_organization_group_member(group_id, user_id) AND can_manage_organization_group(group_id)) OR (role = 'owner' AND is_eligible_organization_group_owner(group_id, user_id) AND (can_manage_organization_group_owners(group_id) OR can_bootstrap_organization_group(group_id, user_id)))",
  });
  addPolicy(snapshot, "organization_group_members", "organization_group_members_group_update", {
    command: "update",
    using:
      "(role <> 'owner' AND can_manage_organization_group(group_id)) OR (role = 'owner' AND can_manage_organization_group_owners(group_id))",
    withCheck:
      "(role <> 'owner' AND is_enterprise_organization_group_member(group_id, user_id) AND can_manage_organization_group(group_id)) OR (role = 'owner' AND can_manage_organization_group_owners(group_id) AND is_eligible_organization_group_owner(group_id, user_id))",
  });
  addPolicy(snapshot, "organization_group_members", "organization_group_members_group_delete", {
    command: "delete",
    using:
      "(role <> 'owner' AND can_manage_organization_group(group_id)) OR (role = 'owner' AND can_manage_organization_group_owners(group_id))",
  });

  for (const role of ["app_runtime", "buwiz_app"]) {
    addPrivilege(snapshot, "table", "organization_group_audit_events", role, "SELECT");
    addPrivilege(snapshot, "table", "entitlement_events", role, "SELECT");
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
    for (const identity of [
      "is_enterprise_organization_group_member(uuid, text)",
      "is_eligible_organization_group_owner(uuid, text)",
      "can_manage_organization_group(uuid)",
      "can_manage_organization_group_owners(uuid)",
      "can_bootstrap_organization_group(uuid, text)",
    ]) {
      addPrivilege(snapshot, "function", identity, role, "EXECUTE");
    }
  }
}

export { addComplete0034 };
