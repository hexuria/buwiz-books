import { describe, expect, it } from "vitest";
import { createEmptyCatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  runtimeRoleNames,
  verifyExactPolicyIdentities,
  verifyMigrationSecurity,
} from "@/lib/migrations/verifiers/security";
import type { VerificationQuery } from "@/lib/migrations/verifiers/types";

describe("migration verifier security", () => {
  it("reports a missing policy identity for the protected table set", () => {
    const snapshot = createEmptyCatalogSnapshot();
    snapshot.policies.set("protected_records.protected_records_select", {
      tableName: "protected_records",
      name: "protected_records_select",
      permissive: true,
      roles: ["public"],
      command: "select",
      using: "true",
      withCheck: null,
    });

    expect(
      verifyExactPolicyIdentities(
        snapshot,
        "security",
        ["protected_records"],
        [
          { tableName: "protected_records", name: "protected_records_select" },
          { tableName: "protected_records", name: "protected_records_insert" },
        ],
      ),
    ).toEqual([
      {
        key: "security:exact-policy-identities",
        status: "fail",
        expected:
          "protected_records.protected_records_insert, protected_records.protected_records_select",
        observed: "protected_records.protected_records_select",
      },
    ]);
  });

  it("reports an extra policy identity only inside the protected table set", () => {
    const snapshot = createEmptyCatalogSnapshot();
    for (const [tableName, name] of [
      ["protected_records", "protected_records_select"],
      ["protected_records", "unexpected_policy"],
      ["unrelated_records", "unrelated_policy"],
    ] as const) {
      snapshot.policies.set(`${tableName}.${name}`, {
        tableName,
        name,
        permissive: true,
        roles: ["public"],
        command: "select",
        using: "true",
        withCheck: null,
      });
    }

    expect(
      verifyExactPolicyIdentities(
        snapshot,
        "security",
        ["protected_records"],
        [{ tableName: "protected_records", name: "protected_records_select" }],
      ),
    ).toEqual([
      {
        key: "security:exact-policy-identities",
        status: "fail",
        expected: "protected_records.protected_records_select",
        observed: "protected_records.protected_records_select, protected_records.unexpected_policy",
      },
    ]);
  });

  it("rejects an active runtime role as the migration principal", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    const query: VerificationQuery = {
      async unsafe<T>() {
        return [{ current_user: " app_runtime " }] as T[];
      },
    };

    expect(runtimeRoleNames).toEqual(["app_runtime", "buwiz_app"]);
    expect(await verifyMigrationSecurity(query, snapshot, [])).toEqual([
      {
        key: "migration-principal:privileged-role",
        status: "fail",
        expected: "a non-runtime migration principal",
        observed: "app_runtime",
      },
    ]);
  });

  it("requires protected relations and SECURITY DEFINER functions to share the active owner", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    snapshot.relations.set("protected_records", {
      name: "protected_records",
      kind: "table",
      owner: "other_owner",
      rls: true,
      forceRls: false,
      columns: [],
    });
    snapshot.functions.set("secure_read()", {
      identity: "secure_read()",
      resultType: "boolean",
      language: "sql",
      volatility: "stable",
      strict: false,
      securityDefiner: true,
      parallel: "unsafe",
      body: "SELECT true",
      definition: "CREATE FUNCTION secure_read()",
      config: ["search_path=public"],
      owner: "function_owner",
    });
    const query: VerificationQuery = {
      async unsafe<T>() {
        return [{ current_user: "migration_owner" }] as T[];
      },
    };

    expect(
      await verifyMigrationSecurity(
        query,
        snapshot,
        ["protected_records", "missing_records"],
        [
          { identity: "secure_read()", securityDefiner: true },
          { identity: "caller_read()", securityDefiner: false },
        ],
      ),
    ).toEqual([
      {
        key: "migration-principal:privileged-role",
        status: "pass",
        expected: "a non-runtime migration principal",
        observed: "migration_owner",
      },
      {
        key: "migration-owner:relation:protected_records",
        status: "fail",
        expected: "migration_owner",
        observed: "other_owner",
      },
      {
        key: "migration-owner:relation:missing_records",
        status: "fail",
        expected: "migration_owner",
        observed: "missing",
      },
      {
        key: "migration-owner:function:secure_read()",
        status: "fail",
        expected: "migration_owner",
        observed: "function_owner",
      },
    ]);
  });

  it("rejects BYPASSRLS on an existing runtime role while keeping runtime roles optional", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    snapshot.roles.set("app_runtime", {
      name: "app_runtime",
      superuser: false,
      inherit: true,
      createRole: false,
      createDb: false,
      canLogin: true,
      replication: false,
      bypassRls: true,
    });
    const query: VerificationQuery = {
      async unsafe<T>() {
        return [{ current_user: "migration_owner" }] as T[];
      },
    };

    expect(await verifyMigrationSecurity(query, snapshot, [])).toEqual([
      {
        key: "migration-principal:privileged-role",
        status: "pass",
        expected: "a non-runtime migration principal",
        observed: "migration_owner",
      },
      {
        key: "runtime-role:app_runtime:bypass-rls",
        status: "fail",
        expected: "false",
        observed: "true",
      },
    ]);
  });

  it("composes principal, ownership, and runtime-role evidence", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    snapshot.relations.set("protected_records", {
      name: "protected_records",
      kind: "table",
      owner: "migration_owner",
      rls: true,
      forceRls: false,
      columns: [],
    });
    snapshot.functions.set("secure_read()", {
      identity: "secure_read()",
      resultType: "boolean",
      language: "sql",
      volatility: "stable",
      strict: false,
      securityDefiner: true,
      parallel: "unsafe",
      body: "SELECT true",
      definition: "CREATE FUNCTION secure_read()",
      config: ["search_path=public"],
      owner: "migration_owner",
    });
    snapshot.roles.set("buwiz_app", {
      name: "buwiz_app",
      superuser: false,
      inherit: true,
      createRole: false,
      createDb: false,
      canLogin: true,
      replication: false,
      bypassRls: false,
    });
    const query: VerificationQuery = {
      async unsafe<T>() {
        return [{ current_user: "migration_owner" }] as T[];
      },
    };

    expect(
      await verifyMigrationSecurity(
        query,
        snapshot,
        ["protected_records"],
        [{ identity: "secure_read()", securityDefiner: true }],
      ),
    ).toEqual([
      {
        key: "migration-principal:privileged-role",
        status: "pass",
        expected: "a non-runtime migration principal",
        observed: "migration_owner",
      },
      {
        key: "migration-owner:relation:protected_records",
        status: "pass",
        expected: "migration_owner",
        observed: "migration_owner",
      },
      {
        key: "migration-owner:function:secure_read()",
        status: "pass",
        expected: "migration_owner",
        observed: "migration_owner",
      },
      {
        key: "runtime-role:buwiz_app:bypass-rls",
        status: "pass",
        expected: "false",
        observed: "false",
      },
    ]);
  });
});
