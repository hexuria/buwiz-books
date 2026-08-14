import type { VerificationContext } from "../engine";
import { relationHasColumn, type CatalogExpectation, type CatalogSnapshot } from "./catalog";
import {
  check,
  column,
  exactTable,
  foreignKey,
  idColumn,
  index,
  permissiveLocalTenantExpression,
  primaryKey,
  schemaSyncBaselineChecks,
  semanticForeignKeyName,
  transitionPolicy,
  verifier,
} from "./expectations";

const expectation0021Base: CatalogExpectation = {
  relations: [
    {
      name: "journal_headers",
      columns: [column("duplicate_of_header_id", "uuid", false)],
    },
    exactTable(
      "journal_duplicate_merges",
      [
        idColumn,
        column("organization_id", "text", true),
        column("canonical_header_id", "uuid", true),
        column("duplicate_header_id", "uuid", true),
        column("duplicate_case_id", "uuid", false),
        column("pair_key", "character varying(73)", true),
        column("state", "character varying(24)", true, "'active'::character varying"),
        column("reason", "text", true),
        column("evidence", "jsonb", true, "'{}'::jsonb"),
        column("idempotency_key", "character varying(255)", true),
        column("matched_at", "timestamp with time zone", true, "now()"),
        column("matched_by", "text", true),
        column("reversed_at", "timestamp with time zone", false),
        column("reversed_by", "text", false),
        column("reversal_reason", "text", false),
        column("reversal_idempotency_key", "character varying(255)", false),
      ],
      true,
    ),
  ],
  indexes: [
    index("journal_headers_org_duplicate_of_idx", "journal_headers", [
      "organization_id",
      "duplicate_of_header_id",
    ]),
    index(
      "journal_duplicate_merges_org_idempotency_unique",
      "journal_duplicate_merges",
      ["organization_id", "idempotency_key"],
      { unique: true },
    ),
    index(
      "journal_duplicate_merges_org_reversal_idempotency_unique",
      "journal_duplicate_merges",
      ["organization_id", "reversal_idempotency_key"],
      { unique: true, predicate: "reversal_idempotency_key IS NOT NULL" },
    ),
    index(
      "journal_duplicate_merges_active_pair_unique",
      "journal_duplicate_merges",
      ["organization_id", "pair_key"],
      { unique: true, predicate: "state::text = 'active'::text" },
    ),
    index(
      "journal_duplicate_merges_active_duplicate_unique",
      "journal_duplicate_merges",
      ["organization_id", "duplicate_header_id"],
      { unique: true, predicate: "state::text = 'active'::text" },
    ),
    index("journal_duplicate_merges_org_canonical_idx", "journal_duplicate_merges", [
      "organization_id",
      "canonical_header_id",
      "state",
    ]),
    index("journal_duplicate_merges_case_idx", "journal_duplicate_merges", ["duplicate_case_id"]),
  ],
  constraints: [
    primaryKey("journal_duplicate_merges", ["id"]),
    foreignKey(
      "journal_headers",
      "journal_headers_duplicate_of_header_id_fk",
      ["duplicate_of_header_id"],
      "journal_headers",
      ["id"],
      "restrict",
    ),
    check(
      "journal_headers",
      "journal_headers_not_own_duplicate_check",
      "CHECK (((duplicate_of_header_id IS NULL) OR (duplicate_of_header_id <> id)))",
    ),
    foreignKey(
      "journal_duplicate_merges",
      "journal_duplicate_merges_canonical_header_id_journal_headers_id_fk",
      ["canonical_header_id"],
      "journal_headers",
      ["id"],
      "restrict",
    ),
    foreignKey(
      "journal_duplicate_merges",
      "journal_duplicate_merges_duplicate_header_id_journal_headers_id_fk",
      ["duplicate_header_id"],
      "journal_headers",
      ["id"],
      "restrict",
    ),
    check(
      "journal_duplicate_merges",
      "journal_duplicate_merges_distinct_headers_check",
      "CHECK ((canonical_header_id <> duplicate_header_id))",
    ),
    check(
      "journal_duplicate_merges",
      "journal_duplicate_merges_pair_key_check",
      "CHECK (((pair_key)::text = ((LEAST((canonical_header_id)::text, (duplicate_header_id)::text) || ':'::text) || GREATEST((canonical_header_id)::text, (duplicate_header_id)::text))))",
    ),
    check(
      "journal_duplicate_merges",
      "journal_duplicate_merges_state_check",
      "CHECK (((state)::text = ANY ((ARRAY['active'::character varying, 'reversed'::character varying, 'quarantined'::character varying])::text[])))",
    ),
    check(
      "journal_duplicate_merges",
      "journal_duplicate_merges_reversal_check",
      "CHECK (((state = 'active' AND reversed_at IS NULL AND reversed_by IS NULL) OR (state <> 'active' AND reversed_at IS NOT NULL)))",
    ),
  ],
};

function expectation0021(
  snapshot: CatalogSnapshot,
  context: VerificationContext,
): CatalogExpectation {
  const constraints = [...(expectation0021Base.constraints ?? [])];
  if (context.target.includes("0024")) {
    const duplicateCaseConstraint = semanticForeignKeyName(
      snapshot,
      "journal_duplicate_merges",
      [
        "journal_duplicate_merges_duplicate_case_id_fk",
        "journal_duplicate_merges_duplicate_case_id_source_match_candidates_id_fk",
        "journal_duplicate_merges_duplicate_case_id_fkey",
      ],
      ["duplicate_case_id"],
      "source_match_candidates",
      ["id"],
      "set_null",
    );
    constraints.push(
      foreignKey(
        "journal_duplicate_merges",
        duplicateCaseConstraint,
        ["duplicate_case_id"],
        "source_match_candidates",
        ["id"],
        "set_null",
      ),
    );
  }
  return {
    ...expectation0021Base,
    constraints,
    policies: [
      transitionPolicy(
        snapshot,
        "journal_duplicate_merges",
        "org_isolation_journal_duplicate_merges",
        context,
        permissiveLocalTenantExpression,
      ),
    ],
  };
}

export const verifier0021 = verifier(
  "0021",
  expectation0021,
  (snapshot) =>
    snapshot.relations.has("journal_duplicate_merges") ||
    relationHasColumn(snapshot.relations.get("journal_headers"), "duplicate_of_header_id") ||
    (expectation0021Base.indexes ?? []).some((item) => snapshot.indexes.has(item.name)),
  undefined,
  async (_query, snapshot, context) =>
    schemaSyncBaselineChecks(snapshot, expectation0021(snapshot, context), {
      key: "0021",
    }),
);
