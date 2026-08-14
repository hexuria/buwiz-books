import { describe, expect, it } from "vitest";
import { verifier0027 } from "@/lib/migrations/verifiers/0027";
import { createEmptyCatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  addIndex,
  addPrimaryKey,
  addRelation,
  column,
  context,
  queryFor,
  withContext,
} from "./fixtures";

function complete0027(vectorAvailable: boolean) {
  const snapshot = createEmptyCatalogSnapshot();
  addRelation(snapshot, "vendor_aliases", [
    column("id", "uuid", true, "gen_random_uuid()", 1),
    column("organization_id", "text", true, null, 2),
    column("normalized_descriptor", "text", true, null, 3),
    column("party_id", "uuid", true, null, 4),
    column("source", "text", true, null, 5),
    column("created_at", "timestamp with time zone", true, "now()", 6),
    ...(vectorAvailable ? [column("embedding", "halfvec(768)", false, null, 7)] : []),
  ]);
  addPrimaryKey(snapshot, "vendor_aliases", ["id"]);
  addIndex(
    snapshot,
    "vendor_aliases_org_descriptor_unique",
    "vendor_aliases",
    ["organization_id", "normalized_descriptor"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "vendor_aliases_descriptor_trgm_idx",
    "vendor_aliases",
    ["normalized_descriptor gin_trgm_ops"],
    { accessMethod: "gin" },
  );
  snapshot.extensions.add("pg_trgm");
  if (vectorAvailable) snapshot.extensions.add("vector");
  return snapshot;
}

describe("migration verifier 0027", () => {
  it("keeps the pre-schema execution barrier fail closed", async () => {
    const preExecution = withContext("pre_execution", ["0027"]);
    expect(
      (await verifier0027.verify(queryFor(createEmptyCatalogSnapshot()), preExecution)).state,
    ).toBe("absent");
    expect((await verifier0027.verify(queryFor(complete0027(false)), preExecution)).state).toBe(
      "complete",
    );

    const schemaStyle = complete0027(false);
    schemaStyle.indexes.delete("vendor_aliases_descriptor_trgm_idx");
    schemaStyle.extensions.delete("pg_trgm");
    expect((await verifier0027.verify(queryFor(schemaStyle), preExecution)).state).toBe("partial");
  });

  it("treats pg_trgm without vendor aliases as no 0027 footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    snapshot.extensions.add("pg_trgm");

    expect((await verifier0027.verify(queryFor(snapshot), context)).state).toBe("absent");
  });

  it("accepts the exact trgm-only 0027 shape when vector is unavailable", async () => {
    const result = await verifier0027.verify(
      queryFor(complete0027(false), { vector_available: false }),
      context,
    );

    expect(result.state).toBe("complete");
  });

  it("accepts historical trgm-only state despite current vector availability", async () => {
    const trgmOnly = await verifier0027.verify(
      queryFor(complete0027(false), { vector_available: true }),
      context,
    );
    const vectorInstalledWithoutColumn = complete0027(false);
    vectorInstalledWithoutColumn.extensions.add("vector");
    const partialVector = await verifier0027.verify(
      queryFor(vectorInstalledWithoutColumn, { vector_available: true }),
      context,
    );
    const completeVector = await verifier0027.verify(
      queryFor(complete0027(true), { vector_available: true }),
      context,
    );

    expect(trgmOnly.state).toBe("complete");
    expect(partialVector.state).toBe("partial");
    expect(completeVector.state).toBe("complete");
  });

  it("rejects the same-named 0027 trgm index with the wrong access method or opclass", async () => {
    const snapshot = complete0027(false);
    const index = snapshot.indexes.get("vendor_aliases_descriptor_trgm_idx")!;
    index.accessMethod = "btree";
    index.keyExpressions = ["normalized_descriptor text_ops"];

    expect(
      (await verifier0027.verify(queryFor(snapshot, { vector_available: false }), context)).state,
    ).toBe("partial");
  });

  it("requires the migration principal to own its relation", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "vendor_aliases", []);
    snapshot.relations.get("vendor_aliases")!.owner = "unexpected_owner";

    const result = await verifier0027.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0027"]),
    );
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:vendor_aliases",
          status: "fail",
        }),
      ]),
    );
  });
});
