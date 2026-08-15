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

function complete0027(
  vectorAvailable: boolean,
  trigramOperatorClass: string | null = "gin_trgm_ops",
) {
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
    // PostgreSQL's per-column pg_get_indexdef reports the expression only and
    // never the operator class, pretty-printed or not. The fixture previously
    // claimed otherwise, which is why an expectation that could never match a
    // real database passed here for as long as it did.
    ["normalized_descriptor"],
    { accessMethod: "gin" },
  );
  const trigramIndex = snapshot.indexes.get("vendor_aliases_descriptor_trgm_idx");
  if (trigramIndex) {
    // The operator class survives only in the full definition, so the fixture
    // carries a real one rather than the generic stub.
    trigramIndex.definition = trigramOperatorClass
      ? `CREATE INDEX vendor_aliases_descriptor_trgm_idx ON public.vendor_aliases USING gin (normalized_descriptor ${trigramOperatorClass})`
      : "CREATE INDEX vendor_aliases_descriptor_trgm_idx ON public.vendor_aliases USING gin (normalized_descriptor)";
  }
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

    // A database synchronized from src/db/schema/ai.ts has vendor_aliases and its
    // unique index but neither the extension nor the trigram index, because those
    // exist in no schema file. That is not a half-applied 0027, it is a database
    // 0027 has never run on, and it must stay executable: reporting it as partial
    // is what made the engine refuse to either execute or adopt it.
    const schemaStyle = complete0027(false);
    schemaStyle.indexes.delete("vendor_aliases_descriptor_trgm_idx");
    schemaStyle.extensions.delete("pg_trgm");
    expect((await verifier0027.verify(queryFor(schemaStyle), preExecution)).state).toBe("absent");

    // A genuinely half-applied 0027 still reports partial: the trigram index it
    // alone creates is present, but the extension that index depends on is gone.
    const halfApplied = complete0027(false);
    halfApplied.extensions.delete("pg_trgm");
    expect((await verifier0027.verify(queryFor(halfApplied), preExecution)).state).toBe("partial");
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

  it("rejects a gin index that drops the trigram operator class", async () => {
    // Every other check passes for this snapshot: same name, same table, same
    // column, gin access method. Only the operator class differs, and without it
    // the index cannot serve the similarity matching 0027 exists to enable.
    const result = await verifier0027.verify(
      queryFor(complete0027(false, null), { vector_available: false }),
      context,
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "index:vendor_aliases_descriptor_trgm_idx:operator-class",
          status: "fail",
          expected: "gin_trgm_ops",
        }),
      ]),
    );
  });

  it("requires the migration principal to own its relation", async () => {
    // The trigram index is what marks 0027 as having run, so it has to be present
    // for the verifier to get as far as the ownership checks at all.
    const snapshot = complete0027(false);
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
