import { describe, expect, it } from "vitest";
import { verifier0031 } from "@/lib/migrations/verifiers/0031";
import { column, context, queryFor } from "./support";
import { assignmentFunction4Body } from "./fixtures/0028-0031";

describe("Migration 0031 verifier", () => {
  it("requires the 0031 historical anchor and all parent objects to be removed", async () => {
    const { snapshot, query } = queryFor();
    snapshot.relations.set("organization_group_entities", {
      name: "organization_group_entities",
      kind: "table",
      owner: "migration_owner",
      rls: true,
      forceRls: false,
      columns: [column("enterprise_account_id", 1, "uuid")],
    });

    await expect(verifier0031.verify(query, context("0031"))).resolves.toMatchObject({
      state: "absent",
      shape: "schema-sync-compatible",
    });

    snapshot.functions.set("is_organization_assigned_to_business_group(uuid, text, uuid, text)", {
      identity: "is_organization_assigned_to_business_group(uuid, text, uuid, text)",
      resultType: "boolean",
      language: "sql",
      volatility: "stable",
      strict: false,
      securityDefiner: true,
      parallel: "unsafe",
      body: assignmentFunction4Body,
      definition: "CREATE FUNCTION is_organization_assigned_to_business_group(...) ",
      config: ["search_path=public"],
      owner: "migration_owner",
    });

    const complete0031 = await verifier0031.verify(queryFor(snapshot).query, context("0031"));
    expect(complete0031.evidence.filter((item) => item.status === "fail")).toEqual([]);
    expect(complete0031).toMatchObject({
      state: "complete",
      shape: "flat-entities",
    });

    snapshot.constraints.set(
      "organization_group_entities.organization_group_entities_not_own_parent_check",
      {
        tableName: "organization_group_entities",
        name: "organization_group_entities_not_own_parent_check",
        type: "check",
        columns: ["parent_entity_id", "id"],
        referencedSchema: null,
        referencedTable: null,
        referencedColumns: [],
        matchType: null,
        onUpdate: null,
        onDelete: null,
        deferrable: false,
        initiallyDeferred: false,
        validated: true,
        definition: "CHECK (parent_entity_id IS NULL OR parent_entity_id <> id)",
      },
    );

    await expect(
      verifier0031.verify(queryFor(snapshot).query, context("0031")),
    ).resolves.toMatchObject({
      state: "partial",
    });
  });
});
