import { describe, expect, it } from "vitest";
import { verifier0025 } from "@/lib/migrations/verifiers/0025";
import { createEmptyCatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addRelation,
  column,
  queryFor,
  withContext,
} from "./fixtures";

function complete0025(nameStyle: "raw" | "schema") {
  const snapshot = createEmptyCatalogSnapshot();
  addRelation(snapshot, "financial_account_secrets", [
    column("financial_account_id", "uuid", true, null, 1),
    column("organization_id", "text", true, null, 2),
    column("statement_password_enc", "text", true, null, 3),
    column("created_at", "timestamp with time zone", true, "now()", 4),
    column("updated_at", "timestamp with time zone", true, "now()", 5),
  ]);
  addIndex(snapshot, "financial_account_secrets_org_idx", "financial_account_secrets", [
    "organization_id",
  ]);
  addPrimaryKey(snapshot, "financial_account_secrets", ["financial_account_id"]);
  addForeignKey(
    snapshot,
    "financial_account_secrets",
    nameStyle === "raw"
      ? "financial_account_secrets_financial_account_id_fkey"
      : "financial_account_secrets_financial_account_id_financial_accounts_id_fk",
    ["financial_account_id"],
    "financial_accounts",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "financial_account_secrets",
    nameStyle === "raw"
      ? "financial_account_secrets_organization_id_fkey"
      : "financial_account_secrets_organization_id_auth_organizations_id_fk",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  );
  return snapshot;
}

describe("migration verifier 0025", () => {
  it("classifies an empty catalog as absent", async () => {
    const result = await verifier0025.verify(
      queryFor(createEmptyCatalogSnapshot()),
      withContext("post_apply", ["0025"]),
    );

    expect(result.state).toBe("absent");
  });

  it("does not treat ubiquitous financial base tables as its footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "financial_accounts", []);
    addRelation(snapshot, "statement_lines", []);

    expect(
      (await verifier0025.verify(queryFor(snapshot), withContext("post_apply", ["0025"]))).state,
    ).toBe("absent");
  });

  it("accepts immutable raw PostgreSQL foreign-key names", async () => {
    const result = await verifier0025.verify(
      queryFor(complete0025("raw")),
      withContext("post_apply", ["0025"]),
    );

    expect(result.state).toBe("complete");
  });

  it("uses raw names for discovery and accepts schema names after execution", async () => {
    const discovery = withContext("discovery", ["0025"]);
    const postApply = withContext("post_apply", ["0025"]);
    const final = withContext("final", ["0025"]);

    expect((await verifier0025.verify(queryFor(complete0025("schema")), discovery)).state).toBe(
      "partial",
    );
    expect((await verifier0025.verify(queryFor(complete0025("raw")), discovery)).state).toBe(
      "complete",
    );
    expect((await verifier0025.verify(queryFor(complete0025("schema")), postApply)).state).toBe(
      "complete",
    );
    expect((await verifier0025.verify(queryFor(complete0025("schema")), final)).state).toBe(
      "complete",
    );
  });

  it("recognizes schema-style names as a pre-execution schema baseline", async () => {
    const result = await verifier0025.verify(
      queryFor(complete0025("schema")),
      withContext("pre_execution", ["0025"]),
    );

    expect(result.state).toBe("absent");
    expect(result.shape).toBe("schema_sync_baseline");
  });

  it("keeps an independently complete raw state adoptable before execution", async () => {
    const result = await verifier0025.verify(
      queryFor(complete0025("raw")),
      withContext("pre_execution", ["0025"]),
    );

    expect(result.state).toBe("complete");
  });

  it("requires migration ownership for its managed relation", async () => {
    const snapshot = complete0025("raw");
    snapshot.relations.get("financial_account_secrets")!.owner = "app_runtime";

    const result = await verifier0025.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0025"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:financial_account_secrets",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects a runtime migration principal and runtime BYPASSRLS", async () => {
    const snapshot = complete0025("raw");
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

    const result = await verifier0025.verify(
      queryFor(snapshot, { current_user: "app_runtime" }),
      withContext("post_apply", ["0025"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-principal:privileged-role",
          status: "fail",
        }),
        expect.objectContaining({
          key: "runtime-role:app_runtime:bypass-rls",
          status: "fail",
        }),
      ]),
    );
  });
});
