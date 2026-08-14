import { describe, expect, it } from "vitest";
import type { VerificationContext } from "@/lib/migrations/engine";
import { verifier0018 } from "@/lib/migrations/verifiers/0018";
import {
  createEmptyCatalogSnapshot,
  type CatalogSnapshot,
} from "@/lib/migrations/verifiers/catalog";
import type { VerificationQuery } from "@/lib/migrations/verifiers/types";
import {
  addForeignKey,
  addIndex,
  addPrimaryKey,
  addRelation,
  column,
  context,
  queryFor as queryForCatalog,
  withContext,
} from "./fixtures";

function queryFor(
  snapshot: CatalogSnapshot,
  data: Record<string, unknown> = {},
): VerificationQuery {
  const query = queryForCatalog(snapshot, data);
  const relationReferences = ["auth_organizations", "organization_secrets"] as const;

  return {
    async unsafe<T>(sql: string): Promise<T[]> {
      for (const relationName of relationReferences) {
        const directlyReferencesRelation = new RegExp(
          `\\b(?:FROM|JOIN)\\s+${relationName}\\b`,
          "i",
        ).test(sql);
        if (!snapshot.relations.has(relationName) && directlyReferencesRelation) {
          throw new Error(`relation ${relationName} does not exist`);
        }
      }
      if (sql.includes("AS invalid_source_gemini_shapes")) {
        return [
          {
            invalid_source_gemini_shapes: 0,
            conflicting_destination_rows: 0,
            destination_secret_rows: 0,
            organization_rows: 0,
            ...data,
          },
        ] as T[];
      }
      return query.unsafe<T>(sql);
    },
  };
}

function complete0018(): CatalogSnapshot {
  const snapshot = createEmptyCatalogSnapshot();
  addRelation(snapshot, "auth_organizations", [
    column("id", "text", true),
    column("metadata", "text", false),
  ]);
  addRelation(snapshot, "organization_secrets", [
    column("organization_id", "text", true, null, 1),
    column("gemini_api_keys", "jsonb", true, "'[]'::jsonb", 2),
    column("resend_api_key", "text", false, null, 3),
    column("stripe_secret_key", "text", false, null, 4),
    column("stripe_webhook_secret", "text", false, null, 5),
    column("paypal_client_secret", "text", false, null, 6),
    column("created_at", "timestamp with time zone", true, "now()", 7),
    column("updated_at", "timestamp with time zone", true, "now()", 8),
  ]);
  addRelation(snapshot, "journal_headers", [
    column("idempotency_key", "character varying(255)", false),
  ]);
  addRelation(snapshot, "reconciliations", []);
  addRelation(snapshot, "statement_lines", []);
  addPrimaryKey(snapshot, "organization_secrets", ["organization_id"]);
  addForeignKey(
    snapshot,
    "organization_secrets",
    "organization_secrets_organization_id_auth_organizations_id_fk",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  );
  addIndex(
    snapshot,
    "journal_headers_org_idempotency_key_unique",
    "journal_headers",
    ["organization_id", "idempotency_key"],
    { unique: true, predicate: "idempotency_key IS NOT NULL" },
  );
  addIndex(snapshot, "journal_headers_org_source_document_idx", "journal_headers", [
    "organization_id",
    "source_document_type",
    "source_document_id",
  ]);
  addIndex(
    snapshot,
    "reconciliations_org_account_period_unique",
    "reconciliations",
    ["organization_id", "bank_account_id", "period_start", "period_end"],
    { unique: true },
  );
  addIndex(snapshot, "reconciliations_org_status_idx", "reconciliations", [
    "organization_id",
    "status",
  ]);
  addIndex(snapshot, "statement_lines_reconciliation_idx", "statement_lines", [
    "reconciliation_id",
  ]);
  addIndex(
    snapshot,
    "statement_lines_matched_journal_line_unique",
    "statement_lines",
    ["matched_journal_line_id"],
    { unique: true, predicate: "matched_journal_line_id IS NOT NULL" },
  );
  return snapshot;
}

function contextFor(mode: VerificationContext["mode"]): VerificationContext {
  return withContext(mode, ["0018"]);
}

describe("migration verifier 0018", () => {
  it("classifies an empty catalog and unrelated base tables as absent", async () => {
    const empty = createEmptyCatalogSnapshot();
    expect((await verifier0018.verify(queryFor(empty), context)).state).toBe("absent");

    addRelation(empty, "journal_headers", [column("id", "uuid", true)]);
    expect((await verifier0018.verify(queryFor(empty), context)).state).toBe("absent");
  });

  it("blocks a populated scrubbed organization source with no destination history", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "auth_organizations", [
      column("id", "text", true),
      column("metadata", "text", false),
    ]);

    const result = await verifier0018.verify(
      queryFor(snapshot, {
        organization_rows: 1,
        leaked_secrets: 0,
        invalid_source_gemini_shapes: 0,
      }),
      contextFor("discovery"),
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0018:destination-secret-adoption-evidence",
          status: "fail",
        }),
      ]),
    );
  });

  it("keeps a populated unscrubbed source pending without querying a missing destination", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "auth_organizations", [
      column("id", "text", true),
      column("metadata", "text", false),
    ]);

    const result = await verifier0018.verify(
      queryFor(snapshot, {
        organization_rows: 1,
        leaked_secrets: 1,
        invalid_source_gemini_shapes: 0,
      }),
      contextFor("discovery"),
    );

    expect(result).toMatchObject({
      state: "absent",
      shape: "repairable_metadata_secret_pre_state",
    });
  });

  it("classifies one distinctive destination anchor as partial without querying a missing source", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "organization_secrets", []);

    expect((await verifier0018.verify(queryFor(snapshot), context)).state).toBe("partial");
  });

  it("accepts the exact schema with stable data invariants", async () => {
    const result = await verifier0018.verify(
      queryFor(complete0018(), { leaked_secrets: 0, invalid_key_arrays: 0 }),
      context,
    );

    expect(result.state).toBe("complete");
  });

  it("accepts the exact raw-PostgreSQL organization foreign-key name", async () => {
    const snapshot = complete0018();
    snapshot.constraints.delete(
      "organization_secrets.organization_secrets_organization_id_auth_organizations_id_fk",
    );
    addForeignKey(
      snapshot,
      "organization_secrets",
      "organization_secrets_organization_id_fkey",
      ["organization_id"],
      "auth_organizations",
      ["id"],
      "cascade",
    );

    const result = await verifier0018.verify(
      queryFor(snapshot, { leaked_secrets: 0, invalid_key_arrays: 0 }),
      context,
    );

    expect(result.state).toBe("complete");
  });

  it("rejects the obsolete reconciliation uniqueness shape", async () => {
    const snapshot = complete0018();
    snapshot.indexes.get("reconciliations_org_account_period_unique")!.keyExpressions = [
      "organization_id",
      "financial_account_id",
      "period_end",
    ];

    const result = await verifier0018.verify(
      queryFor(snapshot, { leaked_secrets: 0, invalid_key_arrays: 0 }),
      context,
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "index:reconciliations_org_account_period_unique:keys",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects an incomplete journal source-document index", async () => {
    const snapshot = complete0018();
    snapshot.indexes.get("journal_headers_org_source_document_idx")!.keyExpressions = [
      "organization_id",
      "source_document_id",
    ];

    const result = await verifier0018.verify(
      queryFor(snapshot, { leaked_secrets: 0, invalid_key_arrays: 0 }),
      context,
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "index:journal_headers_org_source_document_idx:keys",
          status: "fail",
        }),
      ]),
    );
  });

  it("fails closed in discovery when scrubbed metadata lacks destination evidence", async () => {
    const result = await verifier0018.verify(
      queryFor(complete0018(), {
        leaked_secrets: 0,
        invalid_key_arrays: 0,
        destination_secret_rows: 0,
        organization_rows: 1,
      }),
      contextFor("discovery"),
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0018:destination-secret-adoption-evidence",
          status: "fail",
        }),
      ]),
    );
  });

  it("does not infer scrubbed secret history from destination row counts", async () => {
    for (const destinationSecretRows of [1, 2]) {
      const result = await verifier0018.verify(
        queryFor(complete0018(), {
          leaked_secrets: 0,
          invalid_source_gemini_shapes: 0,
          invalid_key_arrays: 0,
          conflicting_destination_rows: 0,
          destination_secret_rows: destinationSecretRows,
          organization_rows: 2,
        }),
        contextFor("discovery"),
      );

      expect(result.state).toBe("partial");
      expect(result.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "0018:destination-secret-adoption-evidence",
            status: "fail",
          }),
        ]),
      );
    }
  });

  it("classifies an exact metadata-secret pre-state as pending during discovery", async () => {
    const result = await verifier0018.verify(
      queryFor(complete0018(), {
        leaked_secrets: 1,
        invalid_key_arrays: 0,
        destination_secret_rows: 0,
        organization_rows: 1,
      }),
      contextFor("discovery"),
    );

    expect(result.state).toBe("absent");
    expect(result.shape).toBe("repairable_metadata_secret_pre_state");
  });

  it("blocks invalid or conflicting metadata-secret pre-states", async () => {
    const cases = [
      { invalid_source_gemini_shapes: 1, conflicting_destination_rows: 0 },
      { invalid_source_gemini_shapes: 0, conflicting_destination_rows: 1 },
    ];

    for (const data of cases) {
      const result = await verifier0018.verify(
        queryFor(complete0018(), {
          leaked_secrets: 1,
          invalid_key_arrays: 0,
          destination_secret_rows: 1,
          organization_rows: 1,
          ...data,
        }),
        contextFor("discovery"),
      );

      expect(result.state).toBe("partial");
    }
  });

  it("keeps an identical nonconflicting destination repairable", async () => {
    const result = await verifier0018.verify(
      queryFor(complete0018(), {
        leaked_secrets: 1,
        invalid_source_gemini_shapes: 0,
        invalid_key_arrays: 0,
        conflicting_destination_rows: 0,
        destination_secret_rows: 1,
        organization_rows: 1,
      }),
      contextFor("discovery"),
    );

    expect(result.state).toBe("absent");
    expect(result.shape).toBe("repairable_metadata_secret_pre_state");
  });

  it("accepts an empty organization population during discovery", async () => {
    const result = await verifier0018.verify(
      queryFor(complete0018(), {
        leaked_secrets: 0,
        invalid_key_arrays: 0,
        destination_secret_rows: 0,
        organization_rows: 0,
      }),
      contextFor("discovery"),
    );

    expect(result.state).toBe("complete");
  });

  it("accepts legitimate post-apply and final empty-secret states", async () => {
    for (const mode of ["post_apply", "final"] as const) {
      const result = await verifier0018.verify(
        queryFor(complete0018(), {
          leaked_secrets: 0,
          invalid_key_arrays: 0,
          destination_secret_rows: 0,
          organization_rows: 1,
        }),
        contextFor(mode),
      );

      expect(result.state).toBe("complete");
    }
  });

  it("rejects same-named columns, indexes, and foreign keys with wrong semantics", async () => {
    const cases = [
      (snapshot: CatalogSnapshot) => {
        snapshot.relations.get("organization_secrets")!.columns[1]!.defaultExpression =
          "'{}'::jsonb";
      },
      (snapshot: CatalogSnapshot) => {
        snapshot.indexes.get("journal_headers_org_idempotency_key_unique")!.predicate = null;
      },
      (snapshot: CatalogSnapshot) => {
        snapshot.constraints.get(
          "organization_secrets.organization_secrets_organization_id_auth_organizations_id_fk",
        )!.onDelete = "restrict";
      },
    ];

    for (const mutate of cases) {
      const snapshot = complete0018();
      mutate(snapshot);
      expect(
        (
          await verifier0018.verify(
            queryFor(snapshot, { leaked_secrets: 0, invalid_key_arrays: 0 }),
            context,
          )
        ).state,
      ).toBe("partial");
    }
  });

  it("requires the organization foreign key to be validated", async () => {
    const snapshot = complete0018();
    snapshot.constraints.get(
      "organization_secrets.organization_secrets_organization_id_auth_organizations_id_fk",
    )!.validated = false;

    expect(
      (
        await verifier0018.verify(
          queryFor(snapshot, {
            leaked_secrets: 0,
            invalid_key_arrays: 0,
            destination_secret_rows: 0,
            organization_rows: 0,
          }),
          context,
        )
      ).state,
    ).toBe("partial");
  });

  it("rejects browser-visible secret data that survives post-apply", async () => {
    const result = await verifier0018.verify(
      queryFor(complete0018(), { leaked_secrets: 1, invalid_key_arrays: 0 }),
      context,
    );

    expect(result.state).toBe("partial");
  });

  it("recognizes an exact pre-execution schema-sync baseline", async () => {
    const result = await verifier0018.verify(
      queryFor(complete0018(), {
        leaked_secrets: 0,
        invalid_source_gemini_shapes: 0,
        invalid_key_arrays: 0,
        conflicting_destination_rows: 0,
        destination_secret_rows: 0,
        organization_rows: 2,
      }),
      contextFor("pre_execution"),
    );

    expect(result).toMatchObject({ state: "absent", shape: "schema_sync_baseline" });
  });

  it("requires the active migration principal to own every managed relation", async () => {
    for (const owner of ["other_owner", ""]) {
      const snapshot = complete0018();
      snapshot.relations.get("organization_secrets")!.owner = owner;

      const result = await verifier0018.verify(
        queryFor(snapshot, {
          leaked_secrets: 0,
          invalid_key_arrays: 0,
          destination_secret_rows: 0,
          organization_rows: 0,
        }),
        context,
      );

      expect(result.state).toBe("partial");
      expect(result.evidence).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            key: "migration-owner:relation:organization_secrets",
            status: "fail",
            observed: owner,
          }),
        ]),
      );
    }
  });

  it("does not accept owner drift as a pre-execution schema-sync baseline", async () => {
    const snapshot = complete0018();
    snapshot.relations.get("organization_secrets")!.owner = "other_owner";

    const result = await verifier0018.verify(
      queryFor(snapshot, {
        leaked_secrets: 0,
        invalid_source_gemini_shapes: 0,
        invalid_key_arrays: 0,
        conflicting_destination_rows: 0,
        destination_secret_rows: 0,
        organization_rows: 2,
      }),
      contextFor("pre_execution"),
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:organization_secrets",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects a runtime migration principal and a runtime role with BYPASSRLS", async () => {
    const snapshot = complete0018();
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

    const result = await verifier0018.verify(
      queryFor(snapshot, {
        current_user: "app_runtime",
        leaked_secrets: 0,
        invalid_key_arrays: 0,
      }),
      context,
    );

    expect(result.state).toBe("partial");
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: "migration-principal:privileged-role", status: "fail" }),
        expect.objectContaining({ key: "runtime-role:app_runtime:bypass-rls", status: "fail" }),
      ]),
    );
  });

  it("does not query the migration principal during discovery without a footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    const catalogQuery = queryFor(snapshot);
    let principalQueries = 0;
    const query: VerificationQuery = {
      async unsafe<T>(sql: string): Promise<T[]> {
        if (sql.includes("SELECT current_user AS current_user")) {
          principalQueries += 1;
          return [{}] as T[];
        }
        return catalogQuery.unsafe<T>(sql);
      },
    };

    expect((await verifier0018.verify(query, contextFor("discovery"))).state).toBe("absent");
    expect(principalQueries).toBe(0);
  });
});
