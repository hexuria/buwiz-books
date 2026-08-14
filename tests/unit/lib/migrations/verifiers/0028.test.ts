import { describe, expect, it } from "vitest";
import { verifier0028 } from "@/lib/migrations/verifiers/0028";
import {
  addPolicy,
  addPrivilege,
  addRole,
  context,
  createEmptyCatalogSnapshot,
  queryFor,
} from "./support";
import { addComplete0028, addRuntimeGrants0028, addSchema0028 } from "./fixtures/0028-0031";

describe("Migration 0028 verifier", () => {
  it("treats exact schema-synchronized 0028 tables as absent but mixed migration-only state as partial", async () => {
    const { snapshot, query } = queryFor();
    addSchema0028(snapshot);

    await expect(
      verifier0028.verify(queryFor(snapshot).query, context("0028")),
    ).resolves.toMatchObject({
      state: "absent",
      shape: "schema-sync-compatible",
    });

    snapshot.functions.set("is_enterprise_account_member(uuid)", {
      identity: "is_enterprise_account_member(uuid)",
      resultType: "boolean",
      language: "sql",
      volatility: "stable",
      strict: false,
      securityDefiner: true,
      parallel: "unsafe",
      body: "wrong body",
      definition: "wrong definition",
      config: ["search_path=public"],
      owner: "migration_owner",
    });

    await expect(verifier0028.verify(query, context("0028"))).resolves.toMatchObject({
      state: "partial",
    });
  });

  it("verifies the historical 0028 parent-entity prefix rather than the latest schema layout", async () => {
    const { snapshot, query } = queryFor();
    addComplete0028(snapshot, "0028");

    const complete0028 = await verifier0028.verify(query, context("0028"));
    expect(
      complete0028.evidence
        .filter((item) => item.status === "fail")
        .map((item) => item.key)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(complete0028).toMatchObject({ state: "complete" });

    snapshot.indexes.get("organization_group_entities_group_parent_idx")!.predicate =
      "parent_entity_id IS NOT NULL";
    await expect(
      verifier0028.verify(queryFor(snapshot).query, context("0028")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("requires exact 0028 policies and grants only for runtime roles that exist", async () => {
    const policyDrift = createEmptyCatalogSnapshot();
    addComplete0028(policyDrift, "0028");
    policyDrift.policies.get("organization_groups.organization_groups_member_select")!.using =
      "true";
    await expect(
      verifier0028.verify(queryFor(policyDrift).query, context("0028")),
    ).resolves.toMatchObject({ state: "partial" });

    const missingRoleGrant = createEmptyCatalogSnapshot();
    addComplete0028(missingRoleGrant, "0028");
    addRole(missingRoleGrant, "app_runtime");
    await expect(
      verifier0028.verify(queryFor(missingRoleGrant).query, context("0028")),
    ).resolves.toMatchObject({ state: "partial" });

    const roleWithGrants = createEmptyCatalogSnapshot();
    addComplete0028(roleWithGrants, "0028");
    addRole(roleWithGrants, "app_runtime");
    addRuntimeGrants0028(roleWithGrants, "app_runtime");
    await expect(
      verifier0028.verify(queryFor(roleWithGrants).query, context("0028")),
    ).resolves.toMatchObject({ state: "complete" });

    const noRuntimeRoles = createEmptyCatalogSnapshot();
    addComplete0028(noRuntimeRoles, "0028");
    await expect(
      verifier0028.verify(queryFor(noRuntimeRoles).query, context("0028")),
    ).resolves.toMatchObject({ state: "complete" });
  });

  it("rejects an unexpected 0028 policy on any enterprise table", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0028(snapshot, "0028");
    addPolicy(snapshot, "entitlement_events", "rogue_entitlement_access", {
      command: "all",
      using: "true",
      withCheck: "true",
    });

    await expect(
      verifier0028.verify(queryFor(snapshot).query, context("0028")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("treats a 0028 runtime ACL row as partial migration footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addSchema0028(snapshot);
    addRole(snapshot, "app_runtime");
    addPrivilege(snapshot, "table", "enterprise_accounts", "app_runtime", "SELECT");

    await expect(
      verifier0028.verify(queryFor(snapshot).query, context("0028")),
    ).resolves.toMatchObject({ state: "partial" });
  });
});
