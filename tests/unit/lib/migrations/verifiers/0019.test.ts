import { describe, expect, it } from "vitest";
import { verifier0019 } from "@/lib/migrations/verifiers/0019";
import { createEmptyCatalogSnapshot } from "@/lib/migrations/verifiers/catalog";
import { addPolicy, addRelation, column, context, queryFor, withContext } from "./fixtures";

const zeroData0019 = { rule_count: 14, invalid_rule_rows: 0 };

describe("migration verifier 0019", () => {
  it("does not treat the pre-existing journal source enum as a 0019 footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    snapshot.enums.set("journal_source", ["manual", "document", "email", "integration", "payment"]);

    expect((await verifier0019.verify(queryFor(snapshot), context)).state).toBe("absent");
  });

  it("rejects a same-named 0019 tenant policy whose body broadens access", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_records", [], true);
    addPolicy(snapshot, "source_records", "tenant_isolation", "true");

    const result = await verifier0019.verify(queryFor(snapshot, { rule_count: 14 }), context);

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "policy:source_records.tenant_isolation:using",
          status: "fail",
        }),
      ]),
    );
  });

  it("verifies 0019-created column defaults instead of table names alone", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(
      snapshot,
      "organization_accounting_settings",
      [
        column("organization_id", "text", true, null, 1),
        column("base_currency", "character varying(3)", true, "'EUR'::character varying", 2),
      ],
      true,
    );

    const result = await verifier0019.verify(
      queryFor(snapshot, { rule_count: 14 }),
      withContext("post_apply", ["0019"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "column:organization_accounting_settings.base_currency:default-expression",
          status: "fail",
        }),
      ]),
    );
  });

  it("verifies immutable 0019 firm columns and constraints", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(
      snapshot,
      "firms",
      [
        column("id", "uuid", true, "gen_random_uuid()", 1),
        column("name", "character varying(255)", true, null, 2),
        column("slug", "text", true, null, 3),
        column("created_by", "text", false, null, 4),
        column("created_at", "timestamp with time zone", true, "now()", 5),
        column("updated_at", "timestamp with time zone", true, "now()", 6),
      ],
      true,
    );

    const result = await verifier0019.verify(
      queryFor(snapshot, { rule_count: 14 }),
      withContext("post_apply", ["0019"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "column:firms.slug:type",
          status: "fail",
        }),
        expect.objectContaining({
          key: "constraint:firms.firms_pkey",
          status: "fail",
        }),
        expect.objectContaining({
          key: "constraint:firms.firms_slug_key",
          status: "fail",
        }),
        expect.objectContaining({
          key: "constraint:firms.firms_created_by_fkey",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects 0019 when all seeded rule keys exist but a row has drifted", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "firms", [], true);

    const result = await verifier0019.verify(
      queryFor(snapshot, { rule_count: 14, invalid_rule_rows: 1 }),
      withContext("post_apply", ["0019"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0019:review-rule-definitions",
          status: "fail",
        }),
      ]),
    );
  });

  it("uses prefix-aware exact column shapes for 0019 tables extended by 0020", async () => {
    const cases = [
      ["source_records", "parent_source_record_id"],
      ["transaction_candidates", "request_idempotency_key"],
      ["source_match_candidates", "match_class"],
    ] as const;

    for (const [tableName, addedIn0020] of cases) {
      const snapshot = createEmptyCatalogSnapshot();
      addRelation(snapshot, tableName, [column("unexpected_column", "text", false)], true);

      const before0020 = await verifier0019.verify(
        queryFor(snapshot, { rule_count: 14, invalid_rule_rows: 0 }),
        withContext("post_apply", ["0019"]),
      );
      const through0020 = await verifier0019.verify(
        queryFor(snapshot, { rule_count: 14, invalid_rule_rows: 0 }),
        withContext("post_apply", ["0019", "0020"]),
      );
      const beforeOrder = before0020.evidence.find(
        (item) => item.key === `relation:${tableName}:column-order`,
      );
      const throughOrder = through0020.evidence.find(
        (item) => item.key === `relation:${tableName}:column-order`,
      );

      expect(beforeOrder?.status).toBe("fail");
      expect(beforeOrder?.expected).not.toContain(addedIn0020);
      expect(throughOrder?.status).toBe("fail");
      expect(throughOrder?.expected).toContain(addedIn0020);
    }
  });

  it("rejects migration policies and seed rows in the pre-execution baseline", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_records", [], false);
    addPolicy(snapshot, "source_records", "tenant_isolation", "organization_id");

    const result = await verifier0019.verify(
      queryFor(snapshot, { rule_count: 1, invalid_rule_rows: 0 }),
      withContext("pre_execution", ["0019"]),
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0019:migration-policies-absent",
          status: "fail",
        }),
        expect.objectContaining({
          key: "0019:seed-rows-absent",
          status: "fail",
        }),
      ]),
    );
  });

  it("requires the migration principal to own a managed relation", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "firms", []);
    snapshot.relations.get("firms")!.owner = "unexpected_owner";

    const result = await verifier0019.verify(
      queryFor(snapshot, zeroData0019),
      withContext("post_apply", ["0019"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:firms",
          status: "fail",
        }),
      ]),
    );
  });

  it("enforces the exact 0019 policy identities", async () => {
    const tenantTables = [
      "organization_accounting_settings",
      "firm_clients",
      "firm_member_client_access",
      "fx_rates",
      "integration_connections",
      "integration_sources",
      "integration_sync_runs",
      "ingestion_events",
      "processing_jobs",
      "source_records",
      "source_record_documents",
      "transaction_candidates",
      "transaction_candidate_lines",
      "inbox_items",
      "inbox_watchers",
      "review_rule_configs",
      "review_rule_runs",
      "review_findings",
      "review_decisions",
      "workflow_events",
      "source_match_candidates",
      "ledger_source_links",
    ];
    const snapshot = createEmptyCatalogSnapshot();
    for (const tableName of tenantTables) {
      addRelation(snapshot, tableName, [], true);
      addPolicy(snapshot, tableName, "tenant_isolation", "organization_id");
    }
    addRelation(snapshot, "firms", [], true);
    addPolicy(snapshot, "firms", "firm_member_access", "organization_id");
    addRelation(snapshot, "firm_members", [], true);
    addPolicy(snapshot, "firm_members", "own_firm_membership", "organization_id");

    const exact = await verifier0019.verify(
      queryFor(snapshot, zeroData0019),
      withContext("post_apply", ["0019"]),
    );
    expect(exact.evidence.find((item) => item.key === "0019:exact-policy-identities")?.status).toBe(
      "pass",
    );

    addPolicy(snapshot, "source_records", "unexpected_permissive_policy", "true");
    const extra = await verifier0019.verify(
      queryFor(snapshot, zeroData0019),
      withContext("post_apply", ["0019"]),
    );
    expect(extra.evidence.find((item) => item.key === "0019:exact-policy-identities")).toEqual(
      expect.objectContaining({
        status: "fail",
        observed: expect.stringContaining("source_records.unexpected_permissive_policy"),
      }),
    );
  });
});
