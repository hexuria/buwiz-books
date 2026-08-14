import { describe, expect, it } from "vitest";
import { verifier0024 } from "@/lib/migrations/verifiers/0024";
import { createEmptyCatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import { addForeignKey, addIndex, addRelation, queryFor, withContext } from "./fixtures";

function schemaBaseline0024() {
  const snapshot = createEmptyCatalogSnapshot();
  for (const tableName of [
    "source_records",
    "documents",
    "transaction_candidates",
    "journal_headers",
    "source_match_candidates",
    "source_record_versions",
    "source_record_documents",
    "transaction_candidate_sources",
    "ledger_source_links",
    "journal_duplicate_merges",
  ]) {
    addRelation(snapshot, tableName, []);
  }
  addIndex(snapshot, "source_records_org_id_unique", "source_records", ["organization_id", "id"], {
    unique: true,
  });
  addIndex(snapshot, "documents_org_id_unique", "documents", ["organization_id", "id"], {
    unique: true,
  });
  addIndex(
    snapshot,
    "transaction_candidates_org_id_unique",
    "transaction_candidates",
    ["organization_id", "id"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "journal_headers_org_id_unique",
    "journal_headers",
    ["organization_id", "id"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "source_match_candidates_org_id_unique",
    "source_match_candidates",
    ["organization_id", "id"],
    { unique: true },
  );
  addForeignKey(
    snapshot,
    "journal_duplicate_merges",
    "journal_duplicate_merges_duplicate_case_id_source_match_candidates_id_fk",
    ["duplicate_case_id"],
    "source_match_candidates",
    ["id"],
    "set_null",
    { validated: true },
  );
  return snapshot;
}

describe("migration verifier 0024", () => {
  it("classifies an empty catalog as absent", async () => {
    const result = await verifier0024.verify(
      queryFor(createEmptyCatalogSnapshot()),
      withContext("post_apply", ["0024"]),
    );

    expect(result.state).toBe("absent");
  });

  it("accepts both raw NOT VALID constraints and stronger validated successors", async () => {
    for (const validated of [false, true]) {
      const snapshot = createEmptyCatalogSnapshot();
      addForeignKey(
        snapshot,
        "source_records",
        "source_records_org_parent_source_fk",
        ["organization_id", "parent_source_record_id"],
        "source_records",
        ["organization_id", "id"],
        "no_action",
        { validated, deferrable: true, initiallyDeferred: true },
      );

      const result = await verifier0024.verify(
        queryFor(snapshot),
        withContext("post_apply", ["0024"]),
      );

      expect(
        result.evidence.filter((item) =>
          item.key.startsWith("constraint:source_records.source_records_org_parent_source_fk"),
        ),
      ).toEqual(expect.not.arrayContaining([expect.objectContaining({ status: "fail" })]));
    }
  });

  it("accepts the schema-generated duplicate-case foreign-key name", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "journal_duplicate_merges", [], true);
    addForeignKey(
      snapshot,
      "journal_duplicate_merges",
      "journal_duplicate_merges_duplicate_case_id_source_match_candidates_id_fk",
      ["duplicate_case_id"],
      "source_match_candidates",
      ["id"],
      "set_null",
    );

    const result = await verifier0024.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0021", "0024"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "constraint:journal_duplicate_merges.journal_duplicate_merges_duplicate_case_id_source_match_candidates_id_fk",
          status: "pass",
        }),
      ]),
    );
  });

  it("accepts any exact duplicate-case foreign-key name and rejects semantic drift", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "journal_duplicate_merges", [], true);
    addForeignKey(
      snapshot,
      "journal_duplicate_merges",
      "preexisting_duplicate_case_guard",
      ["duplicate_case_id"],
      "source_match_candidates",
      ["id"],
      "set_null",
    );
    const context0024 = withContext("final", ["0021", "0024"]);
    const expectedKey =
      "constraint:journal_duplicate_merges.preexisting_duplicate_case_guard:on-delete";

    const exact = await verifier0024.verify(queryFor(snapshot), context0024);
    expect(exact.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: expectedKey, status: "pass" })]),
    );

    const constraint = snapshot.constraints.get(
      "journal_duplicate_merges.preexisting_duplicate_case_guard",
    )!;
    constraint.onDelete = "restrict";
    const wrongDelete = await verifier0024.verify(queryFor(snapshot), context0024);
    expect(wrongDelete.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: expectedKey, status: "fail" })]),
    );

    constraint.onDelete = "set_null";
    constraint.columns = ["other_case_id"];
    const wrongColumn = await verifier0024.verify(queryFor(snapshot), context0024);
    expect(wrongColumn.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "constraint:journal_duplicate_merges.preexisting_duplicate_case_guard:columns",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects lineage foreign keys with the wrong delete behavior", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addForeignKey(
      snapshot,
      "transaction_candidate_sources",
      "transaction_candidate_sources_org_source_fk",
      ["organization_id", "source_record_id"],
      "source_records",
      ["organization_id", "id"],
      "cascade",
    );

    const result = await verifier0024.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0024"]),
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "constraint:transaction_candidate_sources.transaction_candidate_sources_org_source_fk:on-delete",
          status: "fail",
        }),
      ]),
    );
  });

  it("recognizes the exact post-schema baseline before immutable SQL", async () => {
    const result = await verifier0024.verify(
      queryFor(schemaBaseline0024()),
      withContext("pre_execution", ["0024"]),
    );

    expect(result.state).toBe("absent");
    expect(result.shape).toBe("schema_sync_baseline");
  });

  it("rejects drifted and mixed post-schema baselines", async () => {
    const drifted = schemaBaseline0024();
    drifted.indexes.delete("documents_org_id_unique");
    expect(
      (await verifier0024.verify(queryFor(drifted), withContext("pre_execution", ["0024"]))).state,
    ).toBe("partial");

    const mixed = schemaBaseline0024();
    addForeignKey(
      mixed,
      "source_records",
      "source_records_org_parent_source_fk",
      ["organization_id", "parent_source_record_id"],
      "source_records",
      ["organization_id", "id"],
      "no_action",
      { validated: false, deferrable: true, initiallyDeferred: true },
    );
    expect(
      (await verifier0024.verify(queryFor(mixed), withContext("pre_execution", ["0024"]))).state,
    ).toBe("partial");
  });

  it("requires migration ownership for a managed relation", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_records", []);
    addIndex(
      snapshot,
      "source_records_org_id_unique",
      "source_records",
      ["organization_id", "id"],
      {
        unique: true,
      },
    );
    snapshot.relations.get("source_records")!.owner = "app_runtime";

    const result = await verifier0024.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0024"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:source_records",
          status: "fail",
        }),
      ]),
    );
  });
});
