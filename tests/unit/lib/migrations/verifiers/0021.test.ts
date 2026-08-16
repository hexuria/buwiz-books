import { describe, expect, it } from "vitest";
import { verifier0021 } from "@/lib/migrations/verifiers/0021";
import { createEmptyCatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import { addCheck, addForeignKey, addPolicy, addRelation, queryFor, withContext } from "./fixtures";

const permissiveLocalTenantPolicy =
  "current_setting('app.current_organization_id', true) = '' OR current_setting('app.current_organization_id', true) IS NULL OR organization_id = current_setting('app.current_organization_id', true)";
const finalTenantPolicy =
  "current_organization_id() IS NULL OR organization_id = current_organization_id()";

describe("migration verifier 0021", () => {
  it("classifies an empty catalog as absent", async () => {
    const result = await verifier0021.verify(
      queryFor(createEmptyCatalogSnapshot()),
      withContext("post_apply", ["0021"]),
    );

    expect(result.state).toBe("absent");
  });

  it("accepts local and final policy shapes only in their lifecycle phase", async () => {
    const local = createEmptyCatalogSnapshot();
    addRelation(local, "journal_duplicate_merges", [], true);
    addPolicy(
      local,
      "journal_duplicate_merges",
      "org_isolation_journal_duplicate_merges",
      permissiveLocalTenantPolicy,
    );

    const final = createEmptyCatalogSnapshot();
    addRelation(final, "journal_duplicate_merges", [], true);
    addPolicy(
      final,
      "journal_duplicate_merges",
      "org_isolation_journal_duplicate_merges",
      finalTenantPolicy,
    );

    const localResult = await verifier0021.verify(
      queryFor(local),
      withContext("post_apply", ["0021"]),
    );
    const finalResult = await verifier0021.verify(queryFor(final), withContext("final", ["0021"]));
    const wrongPhase = await verifier0021.verify(queryFor(local), withContext("final", ["0021"]));

    expect(localResult.evidence.find((item) => item.key.endsWith(":using"))?.status).toBe("pass");
    expect(finalResult.evidence.find((item) => item.key.endsWith(":using"))?.status).toBe("pass");
    expect(wrongPhase.evidence.find((item) => item.key.endsWith(":using"))?.status).toBe("fail");
  });

  it("requires the immutable reversal constraint name and active-state semantics", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "journal_duplicate_merges", [], true);
    addCheck(
      snapshot,
      "journal_duplicate_merges",
      "journal_duplicate_merges_reversal_check",
      "CHECK (((state = 'active' AND reversed_at IS NULL AND reversed_by IS NULL) OR (state <> 'active' AND reversed_at IS NOT NULL)))",
    );

    const result = await verifier0021.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0021"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "constraint:journal_duplicate_merges.journal_duplicate_merges_reversal_check",
          status: "pass",
        }),
      ]),
    );
  });

  it("requires the duplicate-case foreign key only when the target includes 0024", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "journal_duplicate_merges", [], true);

    const before0024 = await verifier0021.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0021"]),
    );
    const through0024 = await verifier0021.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0021", "0024"]),
    );

    expect(
      before0024.evidence.some((item) =>
        item.key.includes("journal_duplicate_merges_duplicate_case_id_fk"),
      ),
    ).toBe(false);
    expect(through0024.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "constraint:journal_duplicate_merges.journal_duplicate_merges_duplicate_case_id_fk",
          status: "fail",
        }),
      ]),
    );
  });

  it("accepts the schema-generated 0024 duplicate-case foreign-key name", async () => {
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

    const result = await verifier0021.verify(
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

  it("accepts any semantically exact 0024 duplicate-case foreign key and rejects drift", async () => {
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

    const exact = await verifier0021.verify(queryFor(snapshot), context0024);
    expect(exact.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: expectedKey, status: "pass" })]),
    );

    snapshot.constraints.get(
      "journal_duplicate_merges.preexisting_duplicate_case_guard",
    )!.onDelete = "restrict";
    const drifted = await verifier0021.verify(queryFor(snapshot), context0024);
    expect(drifted.evidence).toEqual(
      expect.arrayContaining([expect.objectContaining({ key: expectedKey, status: "fail" })]),
    );
  });

  it("fails a pre-execution schema baseline that already has a migration policy", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "journal_duplicate_merges", [], false);
    addPolicy(
      snapshot,
      "journal_duplicate_merges",
      "org_isolation_journal_duplicate_merges",
      "organization_id",
    );

    const result = await verifier0021.verify(
      queryFor(snapshot),
      withContext("pre_execution", ["0021"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0021:migration-policies-absent",
          status: "fail",
        }),
      ]),
    );
  });

  it("requires migration ownership for its managed relation", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "journal_duplicate_merges", [], true);
    snapshot.relations.get("journal_duplicate_merges")!.owner = "app_runtime";

    const result = await verifier0021.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0021"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:journal_duplicate_merges",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects an unexpected policy identity", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "journal_duplicate_merges", [], true);
    addPolicy(
      snapshot,
      "journal_duplicate_merges",
      "org_isolation_journal_duplicate_merges",
      permissiveLocalTenantPolicy,
    );
    addPolicy(snapshot, "journal_duplicate_merges", "unexpected_permissive_policy", "true");

    const result = await verifier0021.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0021"]),
    );

    expect(result.evidence.find((item) => item.key === "0021:exact-policy-identities")).toEqual(
      expect.objectContaining({
        status: "fail",
        observed: expect.stringContaining("journal_duplicate_merges.unexpected_permissive_policy"),
      }),
    );
  });
});
