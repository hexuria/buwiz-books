import { describe, expect, it } from "vitest";
import { verifier0034 } from "@/lib/migrations/verifiers/0034";
import {
  addFunction,
  addPolicy,
  addPrivilege,
  addRole,
  addSchemaTable,
  context,
  createEmptyCatalogSnapshot,
  queryFor,
} from "./support";
import { addComplete0034 } from "./fixtures/0034";

describe("Migration 0034 verifier", () => {
  it("requires 0034 runtime grants only when the runtime role exists", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0034(snapshot);
    snapshot.privileges.length = 0;
    const preflight = {
      ownerless_groups: 0,
      cross_account_members: 0,
      ineligible_owners: 0,
      archived_enabled_entities: 0,
      invalid_names: 0,
      transfer_context_rows: 0,
    };

    await expect(
      verifier0034.verify(queryFor(snapshot, [preflight]).query, context("0034")),
    ).resolves.toMatchObject({ state: "complete" });

    addRole(snapshot, "app_runtime");
    await expect(
      verifier0034.verify(queryFor(snapshot, [preflight]).query, context("0034")),
    ).resolves.toMatchObject({ state: "partial" });

    snapshot.roles.clear();
    addPrivilege(
      snapshot,
      "function",
      "lock_business_group_user_rows(text[])",
      "PUBLIC",
      "EXECUTE",
    );
    await expect(
      verifier0034.verify(queryFor(snapshot, [preflight]).query, context("0034")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("treats a 0034-specific ACL row as a partial migration footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addPrivilege(
      snapshot,
      "function",
      "lock_business_group_user_rows(text[])",
      "PUBLIC",
      "EXECUTE",
    );
    const preflight = {
      ownerless_groups: 0,
      cross_account_members: 0,
      ineligible_owners: 0,
      archived_enabled_entities: 0,
      invalid_names: 0,
      transfer_context_rows: 0,
    };

    await expect(
      verifier0034.verify(queryFor(snapshot, [preflight]).query, context("0034")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("requires migration ownership for every relation managed by 0034", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0034(snapshot);
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
      addSchemaTable(snapshot, tableName, []);
    }
    snapshot.relations.get("auth_users")!.owner = "app_runtime";

    const result = await verifier0034.verify(
      queryFor(snapshot, [
        {
          ownerless_groups: 0,
          cross_account_members: 0,
          ineligible_owners: 0,
          archived_enabled_entities: 0,
          invalid_names: 0,
          transfer_context_rows: 0,
        },
      ]).query,
      context("0034"),
    );

    expect(result).toMatchObject({ state: "partial" });
    expect(
      result.evidence
        .filter((item) => item.key.startsWith("migration-owner:relation:"))
        .map((item) => item.key)
        .sort(),
    ).toEqual([
      "migration-owner:relation:auth_users",
      "migration-owner:relation:business_group_owner_transfer_context",
      "migration-owner:relation:business_group_projection_reconciliation_events",
      "migration-owner:relation:enterprise_account_members",
      "migration-owner:relation:entitlement_events",
      "migration-owner:relation:organization_group_audit_events",
      "migration-owner:relation:organization_group_entities",
      "migration-owner:relation:organization_group_members",
      "migration-owner:relation:organization_groups",
    ]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:auth_users",
          status: "fail",
        }),
      ]),
    );
  });

  it("treats a hardened 0034 policy delta as a partial migration footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addPolicy(snapshot, "organization_group_members", "organization_group_members_group_delete", {
      command: "delete",
      using:
        "(role <> 'owner' AND can_manage_organization_group(group_id)) OR (role = 'owner' AND can_manage_organization_group_owners(group_id))",
    });

    await expect(
      verifier0034.verify(
        queryFor(snapshot, [
          {
            ownerless_groups: 0,
            cross_account_members: 0,
            ineligible_owners: 0,
            archived_enabled_entities: 0,
            invalid_names: 0,
            transfer_context_rows: 0,
          },
        ]).query,
        context("0034"),
      ),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("emits each hardened 0034 function contract evidence key once", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0034(snapshot);
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
      addSchemaTable(snapshot, tableName, []);
    }

    const result = await verifier0034.verify(
      queryFor(snapshot, [
        {
          ownerless_groups: 0,
          cross_account_members: 0,
          ineligible_owners: 0,
          archived_enabled_entities: 0,
          invalid_names: 0,
          transfer_context_rows: 0,
        },
      ]).query,
      context("0034"),
    );
    const duplicateKeys = result.evidence
      .map((item) => item.key)
      .filter((key, index, keys) => keys.indexOf(key) !== index);

    expect(duplicateKeys).toEqual([]);
  });

  it("ignores public-schema and earlier-migration ACLs as 0034 footprints", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addPrivilege(snapshot, "schema", "public", "PUBLIC", "CREATE");
    addPrivilege(
      snapshot,
      "table",
      "business_group_projection_reconciliation_events",
      "app_runtime",
      "SELECT",
    );
    addPrivilege(snapshot, "function", "can_manage_organization_group(uuid)", "PUBLIC", "EXECUTE");
    addPrivilege(
      snapshot,
      "function",
      "can_bootstrap_organization_group(uuid, text)",
      "PUBLIC",
      "EXECUTE",
    );

    await expect(
      verifier0034.verify(queryFor(snapshot).query, context("0034")),
    ).resolves.toMatchObject({ state: "absent" });
  });

  it("verifies the exact 0034 admin guards, deferred owner check, ACLs, and preflights", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0034(snapshot);
    const zeroPreflights = {
      ownerless_groups: 0,
      cross_account_members: 0,
      ineligible_owners: 0,
      archived_enabled_entities: 0,
      invalid_names: 0,
      transfer_context_rows: 0,
    };

    const complete0034 = await verifier0034.verify(
      queryFor(snapshot, [zeroPreflights]).query,
      context("0034"),
    );
    expect(
      complete0034.evidence
        .filter((item) => item.status === "fail")
        .map((item) => `${item.key}: ${item.expected}`)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(complete0034).toMatchObject({ state: "complete" });
  });

  it("retains only the required 0034 membership and audit policies", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0034(snapshot);
    addPolicy(snapshot, "organization_group_audit_events", "rogue_audit_event_insert", {
      command: "insert",
      withCheck: "true",
    });

    await expect(
      verifier0034.verify(
        queryFor(snapshot, [
          {
            ownerless_groups: 0,
            cross_account_members: 0,
            ineligible_owners: 0,
            archived_enabled_entities: 0,
            invalid_names: 0,
            transfer_context_rows: 0,
          },
        ]).query,
        context("0034"),
      ),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects quoted-literal changes and cross-schema trigger rebinding in 0034", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0034(snapshot);
    const functionRow = snapshot.functions.get("guard_user_owned_business_groups()")!;
    expect(functionRow.body).toContain("User deletion would leave Business Group");
    functionRow.body = functionRow.body.replace(
      "User deletion would leave Business Group",
      "User deletion would leave Business  Group",
    );
    snapshot.triggers.get("auth_users.auth_users_owned_business_groups_guard")!.functionSchema =
      "shadow";

    const result = await verifier0034.verify(
      queryFor(snapshot, [
        {
          ownerless_groups: 0,
          cross_account_members: 0,
          ineligible_owners: 0,
          archived_enabled_entities: 0,
          invalid_names: 0,
          transfer_context_rows: 0,
        },
      ]).query,
      context("0034"),
    );

    expect(result).toMatchObject({ state: "partial" });
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "function:guard_user_owned_business_groups():body-sha256",
          status: "fail",
        }),
        expect.objectContaining({
          key: "trigger:auth_users.auth_users_owned_business_groups_guard:function-schema",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects 0034 body, search-path, deferred-trigger, policy, ACL, and data drift", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0034(snapshot);
    snapshot.functions.get("guard_user_owned_business_groups()")!.body = "BEGIN RETURN OLD; END;";
    snapshot.functions.get("is_enterprise_account_member(uuid)")!.config = [
      "search_path=public, pg_temp",
    ];
    snapshot.triggers.get(
      "organization_groups.organization_groups_eligible_owner_constraint",
    )!.initiallyDeferred = false;
    snapshot.policies.get(
      "organization_group_members.organization_group_members_group_insert",
    )!.withCheck = "true";
    addPrivilege(
      snapshot,
      "table",
      "business_group_owner_transfer_context",
      "app_runtime",
      "SELECT",
    );

    await expect(
      verifier0034.verify(
        queryFor(snapshot, [
          {
            ownerless_groups: 1,
            cross_account_members: 0,
            ineligible_owners: 0,
            archived_enabled_entities: 0,
            invalid_names: 0,
            transfer_context_rows: 1,
          },
        ]).query,
        context("0034"),
      ),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("classifies any partial 0034 footprint as partial instead of absent", async () => {
    const { snapshot, query } = queryFor();
    snapshot.relations.set("business_group_owner_transfer_context", {
      name: "business_group_owner_transfer_context",
      kind: "table",
      owner: "migration_owner",
      rls: false,
      forceRls: false,
      columns: [],
    });

    await expect(verifier0034.verify(query, context("0034"))).resolves.toMatchObject({
      state: "partial",
    });

    const functionOnly = createEmptyCatalogSnapshot();
    addFunction(functionOnly, "lock_business_group_user_rows(text[])", "BEGIN RETURN 0; END;", {
      resultType: "integer",
      language: "plpgsql",
      volatility: "volatile",
      config: ["search_path=pg_catalog, public, pg_temp"],
    });
    await expect(
      verifier0034.verify(queryFor(functionOnly).query, context("0034")),
    ).resolves.toMatchObject({ state: "partial" });
  });
});
