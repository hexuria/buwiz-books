import { describe, expect, it } from "vitest";
import { verifier0036 } from "@/lib/migrations/verifiers/0036";
import { addPolicy, addPrivilege, context, createEmptyCatalogSnapshot, queryFor } from "./support";
import { addComplete0036, addSchema0036 } from "./fixtures/0036";

describe("Migration 0036 verifier", () => {
  it("treats a 0036-specific ACL row as a partial migration footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addSchema0036(snapshot);
    addPrivilege(snapshot, "table", "enterprise_billing_checkout_sessions", "PUBLIC", "SELECT");

    await expect(
      verifier0036.verify(queryFor(snapshot).query, context("0036")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("verifies 0036 checkout reservations as RLS-protected and server-only", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0036(snapshot);
    const complete0036 = await verifier0036.verify(queryFor(snapshot).query, context("0036"));
    expect(
      complete0036.evidence
        .filter((item) => item.status === "fail")
        .map((item) => `${item.key}: ${item.expected}`)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(complete0036).toMatchObject({ state: "complete" });
  });

  it("rejects 0036 predicate, foreign-key, rogue-policy, and ACL drift", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0036(snapshot);
    snapshot.indexes.get("enterprise_billing_checkout_sessions_active_account_unique")!.predicate =
      "status::text = 'open'::text";
    const createdByForeignKey = [...snapshot.constraints.values()].find(
      (item) =>
        item.tableName === "enterprise_billing_checkout_sessions" &&
        item.type === "foreign_key" &&
        item.columns[0] === "created_by",
    )!;
    createdByForeignKey.onDelete = "cascade";
    addPolicy(snapshot, "enterprise_billing_checkout_sessions", "rogue_runtime_access", {
      command: "all",
      using: "true",
      withCheck: "true",
    });
    addPrivilege(
      snapshot,
      "table",
      "enterprise_billing_checkout_sessions",
      "app_runtime",
      "SELECT",
    );

    await expect(
      verifier0036.verify(queryFor(snapshot).query, context("0036")),
    ).resolves.toMatchObject({ state: "partial" });
  });
});
