import { describe, expect, it } from "vitest";
import { verifier0023 } from "@/lib/migrations/verifiers/0023";
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

const nullifLocalTenantPolicy =
  "NULLIF(current_setting('app.current_organization_id', true), '') IS NULL OR organization_id = NULLIF(current_setting('app.current_organization_id', true), '')";
const finalTenantPolicy =
  "current_organization_id() IS NULL OR organization_id = current_organization_id()";

function complete0023(policyExpression: string) {
  const snapshot = createEmptyCatalogSnapshot();
  addRelation(
    snapshot,
    "accounting_operation_idempotency",
    [
      column("id", "uuid", true, "gen_random_uuid()", 1),
      column("organization_id", "text", true, null, 2),
      column("operation_type", "character varying(64)", true, null, 3),
      column("entity_type", "character varying(32)", true, null, 4),
      column("entity_id", "uuid", true, null, 5),
      column("idempotency_key", "character varying(255)", true, null, 6),
      column("payload_hash", "character varying(64)", true, null, 7),
      column("state", "character varying(16)", true, "'pending'::character varying", 8),
      column("journal_header_id", "uuid", false, null, 9),
      column("source_record_id", "uuid", false, null, 10),
      column("result", "jsonb", true, "'{}'::jsonb", 11),
      column("actor_id", "text", false, null, 12),
      column("completed_at", "timestamp with time zone", false, null, 13),
      column("created_at", "timestamp with time zone", true, "now()", 14),
      column("updated_at", "timestamp with time zone", true, "now()", 15),
    ],
    true,
  );
  addPrimaryKey(snapshot, "accounting_operation_idempotency", ["id"]);
  addForeignKey(
    snapshot,
    "accounting_operation_idempotency",
    "accounting_operation_idempotency_organization_id_auth_organizations_id_fk",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  );
  addForeignKey(
    snapshot,
    "accounting_operation_idempotency",
    "accounting_operation_idempotency_journal_header_id_journal_headers_id_fk",
    ["journal_header_id"],
    "journal_headers",
    ["id"],
    "restrict",
  );
  addForeignKey(
    snapshot,
    "accounting_operation_idempotency",
    "accounting_operation_idempotency_source_record_id_source_records_id_fk",
    ["source_record_id"],
    "source_records",
    ["id"],
    "restrict",
  );
  addForeignKey(
    snapshot,
    "accounting_operation_idempotency",
    "accounting_operation_idempotency_actor_id_auth_users_id_fk",
    ["actor_id"],
    "auth_users",
    ["id"],
    "set_null",
  );
  addCheck(
    snapshot,
    "accounting_operation_idempotency",
    "accounting_operation_idempotency_state_check",
    "CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying])::text[])))",
  );
  addIndex(
    snapshot,
    "accounting_operation_idempotency_org_key_unique",
    "accounting_operation_idempotency",
    ["organization_id", "idempotency_key"],
    { unique: true },
  );
  addIndex(
    snapshot,
    "accounting_operation_idempotency_entity_idx",
    "accounting_operation_idempotency",
    ["organization_id", "entity_type", "entity_id", "created_at"],
  );
  addPolicy(
    snapshot,
    "accounting_operation_idempotency",
    "org_isolation_accounting_operation_idempotency",
    policyExpression,
  );
  return snapshot;
}

describe("migration verifier 0023", () => {
  it("classifies an empty catalog as absent", async () => {
    const result = await verifier0023.verify(
      queryFor(createEmptyCatalogSnapshot()),
      withContext("post_apply", ["0023"]),
    );

    expect(result.state).toBe("absent");
  });

  it("verifies complete, partial, and lifecycle states", async () => {
    const local = complete0023(nullifLocalTenantPolicy);
    const final = complete0023(finalTenantPolicy);
    const partial = complete0023(nullifLocalTenantPolicy);
    partial.constraints.get(
      "accounting_operation_idempotency.accounting_operation_idempotency_actor_id_auth_users_id_fk",
    )!.onDelete = "no_action";

    expect(
      (await verifier0023.verify(queryFor(local), withContext("post_apply", ["0023"]))).state,
    ).toBe("complete");
    expect((await verifier0023.verify(queryFor(final), withContext("final", ["0023"]))).state).toBe(
      "complete",
    );
    expect((await verifier0023.verify(queryFor(local), withContext("final", ["0023"]))).state).toBe(
      "partial",
    );
    expect(
      (await verifier0023.verify(queryFor(partial), withContext("post_apply", ["0023"]))).state,
    ).toBe("partial");
  });

  it("recognizes the exact post-schema baseline before immutable SQL", async () => {
    const snapshot = complete0023(nullifLocalTenantPolicy);
    snapshot.relations.get("accounting_operation_idempotency")!.rls = false;
    snapshot.policies.clear();

    const result = await verifier0023.verify(
      queryFor(snapshot),
      withContext("pre_execution", ["0023"]),
    );

    expect(result.state).toBe("absent");
    expect(result.shape).toBe("schema_sync_baseline");
  });

  it("keeps an independently complete raw post-schema state adoptable", async () => {
    const result = await verifier0023.verify(
      queryFor(complete0023(nullifLocalTenantPolicy)),
      withContext("pre_execution", ["0023"]),
    );

    expect(result.state).toBe("complete");
  });

  it("requires migration ownership for its managed relation", async () => {
    const snapshot = complete0023(nullifLocalTenantPolicy);
    snapshot.relations.get("accounting_operation_idempotency")!.owner = "app_runtime";

    const result = await verifier0023.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0023"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:accounting_operation_idempotency",
          status: "fail",
        }),
      ]),
    );
  });

  it("accepts only the exact migration policy identity", async () => {
    const snapshot = complete0023(nullifLocalTenantPolicy);
    const exact = await verifier0023.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0023"]),
    );
    expect(exact.evidence.find((item) => item.key === "0023:exact-policy-identities")?.status).toBe(
      "pass",
    );

    addPolicy(snapshot, "accounting_operation_idempotency", "unexpected_permissive_policy", "true");
    const extra = await verifier0023.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0023"]),
    );
    expect(extra.evidence.find((item) => item.key === "0023:exact-policy-identities")).toEqual(
      expect.objectContaining({
        status: "fail",
        observed: expect.stringContaining(
          "accounting_operation_idempotency.unexpected_permissive_policy",
        ),
      }),
    );
  });
});
