import type { VerificationContext } from "../engine";
import type { CatalogExpectation, CatalogSnapshot } from "./catalog";
import {
  check,
  column,
  createdAt,
  exactTable,
  foreignKey,
  idColumn,
  index,
  nullifLocalTenantExpression,
  primaryKey,
  schemaSyncBaselineChecks,
  transitionPolicy,
  updatedAt,
  verifier,
} from "./expectations";

const idempotencyColumns = [
  idColumn,
  column("organization_id", "text", true),
  column("operation_type", "character varying(64)", true),
  column("entity_type", "character varying(32)", true),
  column("entity_id", "uuid", true),
  column("idempotency_key", "character varying(255)", true),
  column("payload_hash", "character varying(64)", true),
  column("state", "character varying(16)", true, "'pending'::character varying"),
  column("journal_header_id", "uuid", false),
  column("source_record_id", "uuid", false),
  column("result", "jsonb", true, "'{}'::jsonb"),
  column("actor_id", "text", false),
  column("completed_at", "timestamp with time zone", false),
  createdAt,
  updatedAt,
];

function expectation0023(
  snapshot: CatalogSnapshot,
  context: VerificationContext,
): CatalogExpectation {
  return {
    relations: [exactTable("accounting_operation_idempotency", idempotencyColumns, true)],
    indexes: [
      index(
        "accounting_operation_idempotency_org_key_unique",
        "accounting_operation_idempotency",
        ["organization_id", "idempotency_key"],
        { unique: true },
      ),
      index("accounting_operation_idempotency_entity_idx", "accounting_operation_idempotency", [
        "organization_id",
        "entity_type",
        "entity_id",
        "created_at",
      ]),
    ],
    constraints: [
      primaryKey("accounting_operation_idempotency", ["id"]),
      foreignKey(
        "accounting_operation_idempotency",
        "accounting_operation_idempotency_organization_id_auth_organizations_id_fk",
        ["organization_id"],
        "auth_organizations",
        ["id"],
        "cascade",
      ),
      foreignKey(
        "accounting_operation_idempotency",
        "accounting_operation_idempotency_journal_header_id_journal_headers_id_fk",
        ["journal_header_id"],
        "journal_headers",
        ["id"],
        "restrict",
      ),
      foreignKey(
        "accounting_operation_idempotency",
        "accounting_operation_idempotency_source_record_id_source_records_id_fk",
        ["source_record_id"],
        "source_records",
        ["id"],
        "restrict",
      ),
      foreignKey(
        "accounting_operation_idempotency",
        "accounting_operation_idempotency_actor_id_auth_users_id_fk",
        ["actor_id"],
        "auth_users",
        ["id"],
        "set_null",
      ),
      check(
        "accounting_operation_idempotency",
        "accounting_operation_idempotency_state_check",
        "CHECK (((state)::text = ANY ((ARRAY['pending'::character varying, 'completed'::character varying])::text[])))",
      ),
    ],
    policies: [
      transitionPolicy(
        snapshot,
        "accounting_operation_idempotency",
        "org_isolation_accounting_operation_idempotency",
        context,
        nullifLocalTenantExpression,
      ),
    ],
  };
}

export const verifier0023 = verifier(
  "0023",
  expectation0023,
  (snapshot) => snapshot.relations.has("accounting_operation_idempotency"),
  undefined,
  async (_query, snapshot, context) =>
    schemaSyncBaselineChecks(snapshot, expectation0023(snapshot, context), {
      key: "0023",
    }),
);
