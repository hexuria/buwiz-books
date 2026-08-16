import { describe, expect, it } from "vitest";
import { verifier0035 } from "@/lib/migrations/verifiers/0035";
import {
  addPolicy,
  addPrivilege,
  addRole,
  context,
  createEmptyCatalogSnapshot,
  queryFor,
} from "./support";
import { addComplete0035, addSchema0035 } from "./fixtures/0035";

describe("Migration 0035 verifier", () => {
  it("verifies 0035 billing tables with restrictive webhook evidence access", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0035(snapshot);
    const complete0035 = await verifier0035.verify(queryFor(snapshot).query, context("0035"));
    expect(
      complete0035.evidence
        .filter((item) => item.status === "fail")
        .map((item) => `${item.key}: ${item.expected}`)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(complete0035).toMatchObject({ state: "complete" });
  });

  it("requires 0035 runtime grants only when the runtime role exists", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0035(snapshot);
    snapshot.privileges.length = 0;

    await expect(
      verifier0035.verify(queryFor(snapshot).query, context("0035")),
    ).resolves.toMatchObject({ state: "complete" });

    addRole(snapshot, "app_runtime");
    await expect(
      verifier0035.verify(queryFor(snapshot).query, context("0035")),
    ).resolves.toMatchObject({ state: "partial" });

    snapshot.roles.clear();
    addPrivilege(snapshot, "table", "enterprise_billing_subscriptions", "PUBLIC", "SELECT");
    await expect(
      verifier0035.verify(queryFor(snapshot).query, context("0035")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("treats a 0035-specific ACL row as a partial migration footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addSchema0035(snapshot);
    addPrivilege(snapshot, "table", "enterprise_billing_subscriptions", "PUBLIC", "SELECT");

    await expect(
      verifier0035.verify(queryFor(snapshot).query, context("0035")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects 0035 column, foreign-key, index, policy, and ACL drift", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0035(snapshot);
    snapshot.relations
      .get("enterprise_billing_subscriptions")!
      .columns.find((item) => item.name === "quantity")!.type = "bigint";
    snapshot.indexes.get("enterprise_billing_subscriptions_account_unique")!.unique = false;
    snapshot.policies.get(
      "enterprise_billing_subscriptions.enterprise_billing_subscriptions_member_select",
    )!.using = "true";
    const webhookForeignKey = [...snapshot.constraints.values()].find(
      (item) =>
        item.tableName === "enterprise_billing_webhook_events" && item.type === "foreign_key",
    )!;
    webhookForeignKey.onDelete = "cascade";
    addPrivilege(snapshot, "table", "enterprise_billing_webhook_events", "app_runtime", "SELECT");

    await expect(
      verifier0035.verify(queryFor(snapshot).query, context("0035")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("allows one 0035 subscription policy and no webhook policies", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0035(snapshot);
    addPolicy(snapshot, "enterprise_billing_webhook_events", "rogue_webhook_event_select", {
      command: "select",
      using: "true",
    });

    await expect(
      verifier0035.verify(queryFor(snapshot).query, context("0035")),
    ).resolves.toMatchObject({ state: "partial" });
  });
});
