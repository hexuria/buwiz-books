import type { VerificationContext } from "../engine";
import type { CatalogExpectation, CatalogSnapshot } from "./catalog";
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
  transitionPolicy,
  verifier,
} from "./expectations";

const legacyColumns = [
  idColumn,
  column("organization_id", "text", true),
  column("legacy_match_history_id", "uuid", true),
  column("status", "character varying(24)", true),
  column("journal_duplicate_merge_id", "uuid", false),
  column("snapshot_duplicate_header_id", "uuid", false),
  column("snapshot_digest", "character varying(64)", true),
  column("validator_version", "character varying(64)", true),
  column("reason_codes", "jsonb", true, "'[]'::jsonb"),
  column("details", "jsonb", true, "'{}'::jsonb"),
  column("processed_at", "timestamp with time zone", true, "now()"),
  column("processed_by", "text", true),
  column("reviewed_at", "timestamp with time zone", false),
  column("reviewed_by", "text", false),
  column("review_note", "text", false),
];

function expectation0022(
  snapshot: CatalogSnapshot,
  context: VerificationContext,
): CatalogExpectation {
  return {
    relations: [exactTable("legacy_match_conversion_records", legacyColumns, true)],
    indexes: [
      index(
        "legacy_match_conversion_records_history_unique",
        "legacy_match_conversion_records",
        ["legacy_match_history_id"],
        { unique: true },
      ),
      index("legacy_match_conversion_records_org_status_idx", "legacy_match_conversion_records", [
        "organization_id",
        "status",
        "processed_at",
      ]),
    ],
    constraints: [
      primaryKey("legacy_match_conversion_records", ["id"]),
      foreignKey(
        "legacy_match_conversion_records",
        "legacy_match_conversion_records_legacy_match_history_id_match_history_id_fk",
        ["legacy_match_history_id"],
        "match_history",
        ["id"],
        "restrict",
      ),
      foreignKey(
        "legacy_match_conversion_records",
        "legacy_match_conversion_records_journal_duplicate_merge_id_journal_duplicate_merges_id_fk",
        ["journal_duplicate_merge_id"],
        "journal_duplicate_merges",
        ["id"],
        "restrict",
      ),
      check(
        "legacy_match_conversion_records",
        "legacy_match_conversion_records_status_check",
        "CHECK (((status)::text = ANY ((ARRAY['converted'::character varying, 'quarantined'::character varying])::text[])))",
      ),
      check(
        "legacy_match_conversion_records",
        "legacy_match_conversion_records_digest_check",
        "CHECK (((snapshot_digest)::text ~ '^[0-9a-f]{64}$'::text))",
      ),
      check(
        "legacy_match_conversion_records",
        "legacy_match_conversion_records_disposition_check",
        "CHECK (((((status)::text = 'converted'::text) AND (journal_duplicate_merge_id IS NOT NULL) AND (jsonb_array_length(reason_codes) = 0)) OR (((status)::text = 'quarantined'::text) AND (journal_duplicate_merge_id IS NULL) AND (jsonb_array_length(reason_codes) > 0))))",
      ),
    ],
    policies: [
      transitionPolicy(
        snapshot,
        "legacy_match_conversion_records",
        "org_isolation_legacy_match_conversion_records",
        context,
        permissiveLocalTenantExpression,
      ),
    ],
  };
}

export const verifier0022 = verifier(
  "0022",
  expectation0022,
  (snapshot) => snapshot.relations.has("legacy_match_conversion_records"),
  undefined,
  async (_query, snapshot, context) =>
    schemaSyncBaselineChecks(snapshot, expectation0022(snapshot, context), {
      key: "0022",
    }),
);
