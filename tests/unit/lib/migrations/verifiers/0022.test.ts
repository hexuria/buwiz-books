import { describe, expect, it } from "vitest";
import { verifier0022 } from "@/lib/migrations/verifiers/0022";
import { createEmptyCatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import {
  addCheck,
  addForeignKey,
  addIndex,
  addPolicy,
  addPrimaryKey,
  addRelation,
  column,
  queryFor,
  withContext,
} from "./fixtures";

const permissiveLocalTenantPolicy =
  "current_setting('app.current_organization_id', true) = '' OR current_setting('app.current_organization_id', true) IS NULL OR organization_id = current_setting('app.current_organization_id', true)";
const finalTenantPolicy =
  "current_organization_id() IS NULL OR organization_id = current_organization_id()";

function complete0022(policyExpression: string) {
  const snapshot = createEmptyCatalogSnapshot();
  addRelation(
    snapshot,
    "legacy_match_conversion_records",
    [
      column("id", "uuid", true, "gen_random_uuid()", 1),
      column("organization_id", "text", true, null, 2),
      column("legacy_match_history_id", "uuid", true, null, 3),
      column("status", "character varying(24)", true, null, 4),
      column("journal_duplicate_merge_id", "uuid", false, null, 5),
      column("snapshot_duplicate_header_id", "uuid", false, null, 6),
      column("snapshot_digest", "character varying(64)", true, null, 7),
      column("validator_version", "character varying(64)", true, null, 8),
      column("reason_codes", "jsonb", true, "'[]'::jsonb", 9),
      column("details", "jsonb", true, "'{}'::jsonb", 10),
      column("processed_at", "timestamp with time zone", true, "now()", 11),
      column("processed_by", "text", true, null, 12),
      column("reviewed_at", "timestamp with time zone", false, null, 13),
      column("reviewed_by", "text", false, null, 14),
      column("review_note", "text", false, null, 15),
    ],
    true,
  );
  addPrimaryKey(snapshot, "legacy_match_conversion_records", ["id"]);
  addForeignKey(
    snapshot,
    "legacy_match_conversion_records",
    "legacy_match_conversion_records_legacy_match_history_id_match_history_id_fk",
    ["legacy_match_history_id"],
    "match_history",
    ["id"],
    "restrict",
  );
  addForeignKey(
    snapshot,
    "legacy_match_conversion_records",
    "legacy_match_conversion_records_journal_duplicate_merge_id_journal_duplicate_merges_id_fk",
    ["journal_duplicate_merge_id"],
    "journal_duplicate_merges",
    ["id"],
    "restrict",
  );
  addCheck(
    snapshot,
    "legacy_match_conversion_records",
    "legacy_match_conversion_records_status_check",
    "CHECK (((status)::text = ANY ((ARRAY['converted'::character varying, 'quarantined'::character varying])::text[])))",
  );
  addCheck(
    snapshot,
    "legacy_match_conversion_records",
    "legacy_match_conversion_records_digest_check",
    "CHECK (((snapshot_digest)::text ~ '^[0-9a-f]{64}$'::text))",
  );
  addCheck(
    snapshot,
    "legacy_match_conversion_records",
    "legacy_match_conversion_records_disposition_check",
    "CHECK (((((status)::text = 'converted'::text) AND (journal_duplicate_merge_id IS NOT NULL) AND (jsonb_array_length(reason_codes) = 0)) OR (((status)::text = 'quarantined'::text) AND (journal_duplicate_merge_id IS NULL) AND (jsonb_array_length(reason_codes) > 0))))",
  );
  addIndex(
    snapshot,
    "legacy_match_conversion_records_history_unique",
    "legacy_match_conversion_records",
    ["legacy_match_history_id"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "legacy_match_conversion_records_org_status_idx",
    "legacy_match_conversion_records",
    ["organization_id", "status", "processed_at"],
  );
  addPolicy(
    snapshot,
    "legacy_match_conversion_records",
    "org_isolation_legacy_match_conversion_records",
    policyExpression,
  );
  return snapshot;
}

describe("migration verifier 0022", () => {
  it("classifies an empty catalog as absent", async () => {
    const result = await verifier0022.verify(
      queryFor(createEmptyCatalogSnapshot()),
      withContext("post_apply", ["0022"]),
    );

    expect(result.state).toBe("absent");
  });

  it("verifies complete, partial, and lifecycle states", async () => {
    const local = complete0022(permissiveLocalTenantPolicy);
    const final = complete0022(finalTenantPolicy);
    const partial = complete0022(permissiveLocalTenantPolicy);
    partial.indexes.get("legacy_match_conversion_records_history_unique")!.unique = false;

    expect(
      (await verifier0022.verify(queryFor(local), withContext("post_apply", ["0022"]))).state,
    ).toBe("complete");
    expect((await verifier0022.verify(queryFor(final), withContext("final", ["0022"]))).state).toBe(
      "complete",
    );
    expect((await verifier0022.verify(queryFor(local), withContext("final", ["0022"]))).state).toBe(
      "partial",
    );
    expect(
      (await verifier0022.verify(queryFor(partial), withContext("post_apply", ["0022"]))).state,
    ).toBe("partial");
  });

  it("requires ordinary checks to be validated", async () => {
    const snapshot = complete0022(permissiveLocalTenantPolicy);
    snapshot.constraints.get(
      "legacy_match_conversion_records.legacy_match_conversion_records_status_check",
    )!.validated = false;

    expect(
      (await verifier0022.verify(queryFor(snapshot), withContext("post_apply", ["0022"]))).state,
    ).toBe("partial");
  });

  it("recognizes the exact post-schema baseline before immutable SQL", async () => {
    const snapshot = complete0022(permissiveLocalTenantPolicy);
    snapshot.relations.get("legacy_match_conversion_records")!.rls = false;
    snapshot.policies.clear();

    const result = await verifier0022.verify(
      queryFor(snapshot),
      withContext("pre_execution", ["0022"]),
    );

    expect(result.state).toBe("absent");
    expect(result.shape).toBe("schema_sync_baseline");
  });

  it("rejects a mixed post-schema baseline", async () => {
    const snapshot = complete0022(permissiveLocalTenantPolicy);
    snapshot.relations.get("legacy_match_conversion_records")!.rls = false;

    const result = await verifier0022.verify(
      queryFor(snapshot),
      withContext("pre_execution", ["0022"]),
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0022:migration-policies-absent",
          status: "fail",
        }),
      ]),
    );
  });

  it("keeps an independently complete raw post-schema state adoptable", async () => {
    const result = await verifier0022.verify(
      queryFor(complete0022(permissiveLocalTenantPolicy)),
      withContext("pre_execution", ["0022"]),
    );

    expect(result.state).toBe("complete");
  });

  it("requires migration ownership for its managed relation", async () => {
    const snapshot = complete0022(permissiveLocalTenantPolicy);
    snapshot.relations.get("legacy_match_conversion_records")!.owner = "app_runtime";

    const result = await verifier0022.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0022"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:legacy_match_conversion_records",
          status: "fail",
        }),
      ]),
    );
  });

  it("accepts only the exact migration policy identity", async () => {
    const snapshot = complete0022(permissiveLocalTenantPolicy);
    const exact = await verifier0022.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0022"]),
    );
    expect(exact.evidence.find((item) => item.key === "0022:exact-policy-identities")?.status).toBe(
      "pass",
    );

    addPolicy(snapshot, "legacy_match_conversion_records", "unexpected_permissive_policy", "true");
    const extra = await verifier0022.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0022"]),
    );
    expect(extra.evidence.find((item) => item.key === "0022:exact-policy-identities")).toEqual(
      expect.objectContaining({
        status: "fail",
        observed: expect.stringContaining(
          "legacy_match_conversion_records.unexpected_permissive_policy",
        ),
      }),
    );
  });

  it("rejects unrelated policy identities in a schema-sync baseline", async () => {
    const snapshot = complete0022(permissiveLocalTenantPolicy);
    snapshot.relations.get("legacy_match_conversion_records")!.rls = false;
    snapshot.policies.clear();
    addPolicy(snapshot, "legacy_match_conversion_records", "unexpected_permissive_policy", "true");

    const result = await verifier0022.verify(
      queryFor(snapshot),
      withContext("pre_execution", ["0022"]),
    );

    expect(result.state).toBe("partial");
    expect(
      result.evidence.find(
        (item) => item.key === "0022:schema-sync-baseline:exact-policy-identities",
      ),
    ).toEqual(expect.objectContaining({ status: "fail" }));
  });
});
