import { describe, expect, it } from "vitest";
import { verifier0032 } from "@/lib/migrations/verifiers/0032";
import {
  addPolicy,
  addPrivilege,
  addRole,
  addSchemaTable,
  context,
  createEmptyCatalogSnapshot,
  queryFor,
} from "./support";
import {
  addComplete0032,
  addSchema0032,
  complete0032Seed,
  pending0032Lifecycle,
} from "./fixtures/0032";

describe("Migration 0032 verifier", () => {
  it("verifies the exact 0032 reporting catalog and durable backfill invariant", async () => {
    const { snapshot, query } = queryFor(createEmptyCatalogSnapshot(), [pending0032Lifecycle]);
    addComplete0032(snapshot);

    const complete0032 = await verifier0032.verify(query, context("0032"));
    expect(
      complete0032.evidence
        .filter((item) => item.status === "fail")
        .map((item) => `${item.key}: ${item.expected}`)
        .join("\n") || undefined,
    ).toBeUndefined();
    expect(complete0032).toMatchObject({ state: "complete" });
  });

  it("accepts lifecycle-conformant 0032 in-progress, retry, and terminal states", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0032(snapshot);
    const validStates = [
      pending0032Lifecycle,
      {
        ...pending0032Lifecycle,
        status: "building",
        full_rebuild_requested: false,
      },
      {
        ...pending0032Lifecycle,
        status: "failed",
        full_rebuild_requested: false,
        last_error: "retryable projection failure",
      },
      {
        ...pending0032Lifecycle,
        status: "ready",
        requested_version: 4,
        applied_version: 4,
        full_rebuild_requested: false,
        initial_backfill_completed_at: "2026-08-14T00:00:00.000Z",
        valid_active_refresh_jobs: 0,
      },
    ] as const;

    for (const state of validStates) {
      await expect(
        verifier0032.verify(queryFor(snapshot, [state]).query, context("0032", "final")),
      ).resolves.toMatchObject({ state: "complete" });
    }
  });

  it("rejects impossible 0032 lifecycle and refresh-job combinations", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0032(snapshot);
    const invalidStates = [
      { ...pending0032Lifecycle, requested_version: 0, applied_version: 0 },
      {
        ...pending0032Lifecycle,
        status: "building",
        valid_active_refresh_jobs: 0,
      },
      {
        ...pending0032Lifecycle,
        status: "failed",
        valid_active_refresh_jobs: 0,
      },
      {
        ...pending0032Lifecycle,
        status: "ready",
        requested_version: 1,
        applied_version: 1,
        full_rebuild_requested: false,
        valid_active_refresh_jobs: 0,
      },
      { ...pending0032Lifecycle, invalid_active_refresh_jobs: 1 },
    ] as const;

    for (const state of invalidStates) {
      await expect(
        verifier0032.verify(queryFor(snapshot, [state]).query, context("0032", "final")),
      ).resolves.toMatchObject({ state: "partial" });
    }
  });

  it("requires exact pending seed state and one deduplicated 0032 refresh job after apply", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0032(snapshot);
    const cases = [
      ["non_pending_projection_states", "0032:pending-projection-state"],
      ["non_advanced_projection_versions", "0032:advanced-projection-version"],
      ["missing_full_rebuild_requests", "0032:full-rebuild-requested"],
      ["invalid_refresh_jobs", "0032:deduplicated-refresh-job"],
    ] as const;

    for (const [columnName, evidenceKey] of cases) {
      const result = await verifier0032.verify(
        queryFor(snapshot, [{ ...complete0032Seed, [columnName]: 1 }]).query,
        context("0032", "post_apply"),
      );
      expect(result).toMatchObject({ state: "partial" });
      expect(result.evidence).toEqual(
        expect.arrayContaining([expect.objectContaining({ key: evidenceKey, status: "fail" })]),
      );
    }
  });

  it("requires 0032 runtime grants only when the runtime role exists", async () => {
    const withoutRoles = createEmptyCatalogSnapshot();
    addComplete0032(withoutRoles);
    withoutRoles.privileges.length = 0;
    await expect(
      verifier0032.verify(queryFor(withoutRoles, [pending0032Lifecycle]).query, context("0032")),
    ).resolves.toMatchObject({ state: "complete" });

    addRole(withoutRoles, "app_runtime");
    await expect(
      verifier0032.verify(queryFor(withoutRoles, [pending0032Lifecycle]).query, context("0032")),
    ).resolves.toMatchObject({ state: "partial" });

    addPrivilege(withoutRoles, "table", "organization_reporting_accounts", "PUBLIC", "SELECT");
    withoutRoles.roles.clear();
    await expect(
      verifier0032.verify(queryFor(withoutRoles, [pending0032Lifecycle]).query, context("0032")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("treats a 0032-specific ACL row as a partial migration footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addSchema0032(snapshot);
    addPrivilege(snapshot, "table", "organization_reporting_accounts", "PUBLIC", "SELECT");

    await expect(
      verifier0032.verify(queryFor(snapshot, [pending0032Lifecycle]).query, context("0032")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("requires migration ownership for every relation managed by 0032", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0032(snapshot);
    for (const tableName of [
      "accounts",
      "organization_group_entities",
      "journal_headers",
      "journal_lines",
    ]) {
      addSchemaTable(snapshot, tableName, []);
    }
    snapshot.relations.get("accounts")!.owner = "app_runtime";

    const result = await verifier0032.verify(
      queryFor(snapshot, [pending0032Lifecycle]).query,
      context("0032"),
    );

    expect(result).toMatchObject({ state: "partial" });
    expect(
      result.evidence
        .filter((item) => item.key.startsWith("migration-owner:relation:"))
        .map((item) => item.key)
        .sort(),
    ).toEqual([
      "migration-owner:relation:accounts",
      "migration-owner:relation:journal_headers",
      "migration-owner:relation:journal_lines",
      "migration-owner:relation:organization_daily_account_activity",
      "migration-owner:relation:organization_group_entities",
      "migration-owner:relation:organization_reporting_accounts",
      "migration-owner:relation:organization_reporting_dirty_dates",
      "migration-owner:relation:organization_reporting_projection_state",
    ]);
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:accounts",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects 0032 function, transition-table, policy, foreign-key, and ACL drift", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0032(snapshot);
    snapshot.functions.get("mark_reporting_from_updated_headers()")!.body =
      "BEGIN RETURN NULL; END;";
    snapshot.triggers.get("journal_headers.journal_headers_reporting_update")!.newTable =
      "wrong_headers";
    snapshot.policies.get(
      "organization_reporting_accounts.organization_reporting_accounts_select",
    )!.using = "true";
    const organizationForeignKey = [...snapshot.constraints.values()].find(
      (item) =>
        item.tableName === "organization_reporting_accounts" &&
        item.type === "foreign_key" &&
        item.columns[0] === "organization_id",
    )!;
    organizationForeignKey.onDelete = "set_null";
    addPrivilege(snapshot, "table", "organization_reporting_accounts", "PUBLIC", "SELECT");

    await expect(
      verifier0032.verify(queryFor(snapshot, [pending0032Lifecycle]).query, context("0032")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("rejects an unexpected permissive 0032 reporting policy", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0032(snapshot);
    addPolicy(snapshot, "organization_reporting_accounts", "rogue_reporting_access", {
      command: "select",
      using: "true",
    });

    await expect(
      verifier0032.verify(queryFor(snapshot, [pending0032Lifecycle]).query, context("0032")),
    ).resolves.toMatchObject({ state: "partial" });
  });

  it("requires SECURITY DEFINER functions to match the active migration principal", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addComplete0032(snapshot);
    snapshot.functions.get("mark_organization_reporting_dirty(text, date)")!.owner =
      "different_owner";

    await expect(
      verifier0032.verify(queryFor(snapshot, [pending0032Lifecycle]).query, context("0032")),
    ).resolves.toMatchObject({ state: "partial" });
  });
});
