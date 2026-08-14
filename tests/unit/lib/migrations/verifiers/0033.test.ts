import { describe, expect, it } from "vitest";
import { verifier0033 } from "@/lib/migrations/verifiers/0033";
import {
  addPolicy,
  addPrivilege,
  addRole,
  context,
  createEmptyCatalogSnapshot,
  queryFor,
} from "./support";
import { addComplete0033, addSchema0033 } from "./fixtures/0033";

describe("Migration 0033 verifier", () => {
  it("verifies 0033 reconciliation as append-only with exact policies", async () => {
    const { snapshot, query } = queryFor();
    addComplete0033(snapshot);

    const complete0033 = await verifier0033.verify(query, context("0033"));
    expect(
      complete0033.evidence
        .filter((item) => item.status === "fail")
        .map((item) => `${item.key}: ${item.expected}`)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(complete0033).toMatchObject({ state: "complete" });
  });

  it("requires 0033 runtime grants only when the runtime role exists", async () => {
    const withoutRoles = createEmptyCatalogSnapshot();
    addComplete0033(withoutRoles);
    withoutRoles.privileges.length = 0;
    await expect(
      verifier0033.verify(queryFor(withoutRoles).query, context("0033")),
    ).resolves.toMatchObject({ state: "complete" });

    addRole(withoutRoles, "buwiz_app");
    await expect(
      verifier0033.verify(queryFor(withoutRoles).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });

    addPrivilege(
      withoutRoles,
      "table",
      "business_group_projection_reconciliation_events",
      "PUBLIC",
      "SELECT",
    );
    withoutRoles.roles.clear();
    await expect(
      verifier0033.verify(queryFor(withoutRoles).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("treats a 0033-specific ACL row as a partial migration footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addSchema0033(snapshot);
    addPrivilege(
      snapshot,
      "table",
      "business_group_projection_reconciliation_events",
      "PUBLIC",
      "SELECT",
    );

    await expect(
      verifier0033.verify(queryFor(snapshot).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects 0033 policy, foreign-key, index, and append-only ACL drift", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0033(snapshot);
    snapshot.policies.get(
      "business_group_projection_reconciliation_events.business_group_projection_reconciliation_insert",
    )!.withCheck = "true";
    snapshot.indexes.get(
      "business_group_projection_reconciliation_org_period_idx",
    )!.keyExpressions = ["organization_id", "date_to", "date_from"];
    const foreignKey = [...snapshot.constraints.values()].find(
      (item) => item.type === "foreign_key",
    )!;
    foreignKey.onDelete = "restrict";
    addPrivilege(
      snapshot,
      "table",
      "business_group_projection_reconciliation_events",
      "app_runtime",
      "UPDATE",
    );

    await expect(
      verifier0033.verify(queryFor(snapshot).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects an unexpected 0033 reconciliation policy", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0033(snapshot);
    addPolicy(
      snapshot,
      "business_group_projection_reconciliation_events",
      "rogue_reconciliation_access",
      { command: "select", using: "true" },
    );

    await expect(
      verifier0033.verify(queryFor(snapshot).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects a runtime serving role as the active migration principal", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0033(snapshot);

    await expect(
      verifier0033.verify(queryFor(snapshot, [], "app_runtime").query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("requires migration-owned relations to match the active principal", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0033(snapshot);
    snapshot.relations.get("business_group_projection_reconciliation_events")!.owner =
      "different_owner";

    await expect(
      verifier0033.verify(queryFor(snapshot).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects an existing runtime role that can bypass RLS", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0033(snapshot);
    addRole(snapshot, "app_runtime");
    snapshot.roles.get("app_runtime")!.bypassRls = true;

    await expect(
      verifier0033.verify(queryFor(snapshot).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects grant options on required positive runtime grants", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0033(snapshot);
    addRole(snapshot, "app_runtime");
    const selectGrant = snapshot.privileges.find(
      (row) =>
        row.objectType === "table" &&
        row.objectIdentity === "business_group_projection_reconciliation_events" &&
        row.grantee === "app_runtime" &&
        row.privilege === "SELECT",
    )!;
    selectGrant.grantable = true;

    await expect(
      verifier0033.verify(queryFor(snapshot).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects a duplicate grantable ACL row behind a non-grantable required grant", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0033(snapshot);
    addRole(snapshot, "app_runtime");
    snapshot.privileges.push({
      objectType: "table",
      objectIdentity: "business_group_projection_reconciliation_events",
      grantor: "delegated_owner",
      grantee: "app_runtime",
      privilege: "SELECT",
      grantable: true,
    });

    await expect(
      verifier0033.verify(queryFor(snapshot).query, context("0033")),
    ).resolves.toMatchObject({ state: "partial" });
  });
});
