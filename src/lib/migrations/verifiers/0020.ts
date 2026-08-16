import type { VerificationContext } from "../engine";
import {
  relationHasColumn,
  type CatalogExpectation,
  type CatalogSnapshot,
  type ConstraintExpectation,
} from "./catalog";
import {
  check,
  foreignKey,
  index,
  installedNotValidConstraint,
  knownConstraintName,
  localTenantExpression,
  primaryKey,
  schemaSyncBaselineChecks,
  tenantPolicy,
  verifier,
} from "./expectations";
import { relations0020 } from "./schema-sync-0019-0020";
import { evidence } from "./types";

const indexes0020 = [
  index("idx_documents_org_content_hash", "documents", ["organization_id", "content_hash"], {
    unique: true,
    predicate: "content_hash IS NOT NULL",
  }),
  index("source_records_parent_idx", "source_records", ["parent_source_record_id"]),
  index(
    "source_records_duplicate_lookup_idx",
    "source_records",
    ["organization_id", "original_currency", "original_amount", "direction", "effective_date"],
    { predicate: "record_state::text = 'active'::text" },
  ),
  index(
    "source_record_versions_source_version_unique",
    "source_record_versions",
    ["source_record_id", "external_version"],
    { unique: true },
  ),
  index("source_record_versions_org_created_idx", "source_record_versions", [
    "organization_id",
    "created_at",
  ]),
  index("source_record_versions_ingestion_event_idx", "source_record_versions", [
    "ingestion_event_id",
  ]),
  index(
    "source_records_org_source_external_unique",
    "source_records",
    ["organization_id", "source_id", "external_id"],
    {
      unique: true,
      predicate:
        "source_id IS NOT NULL AND external_id IS NOT NULL AND record_state::text <> 'superseded'::text",
    },
  ),
  index(
    "transaction_candidates_org_request_idempotency_unique",
    "transaction_candidates",
    ["organization_id", "request_idempotency_key"],
    { unique: true, predicate: "request_idempotency_key IS NOT NULL" },
  ),
  index(
    "transaction_candidate_sources_primary_unique",
    "transaction_candidate_sources",
    ["candidate_id"],
    { unique: true, predicate: "is_primary = true" },
  ),
  index("transaction_candidate_sources_org_source_idx", "transaction_candidate_sources", [
    "organization_id",
    "source_record_id",
  ]),
  index(
    "source_match_candidates_org_resolution_idempotency_unique",
    "source_match_candidates",
    ["organization_id", "resolution_idempotency_key"],
    { unique: true, predicate: "resolution_idempotency_key IS NOT NULL" },
  ),
  index("source_match_candidates_left_source_idx", "source_match_candidates", [
    "left_source_record_id",
  ]),
  index("source_match_candidates_right_source_idx", "source_match_candidates", [
    "right_source_record_id",
  ]),
  index(
    "ledger_source_links_origin_source_unique",
    "ledger_source_links",
    ["organization_id", "source_record_id"],
    { unique: true, predicate: "relationship::text = 'origin'::text" },
  ),
];

const deliberatelyNotValid0020 = new Set([
  "source_records_record_state_check",
  "source_records_direction_check",
  "source_records_economic_event_class_check",
  "source_match_candidates_canonical_pair_check",
  "source_match_candidates_score_range_check",
  "source_match_candidates_match_class_check",
  "source_match_candidates_disposition_check",
  "source_match_candidates_resolution_action_check",
]);

const constraints0020: ConstraintExpectation[] = [
  primaryKey("source_record_versions", ["id"]),
  foreignKey(
    "source_record_versions",
    "source_record_versions_organization_id_auth_organizations_id_fk",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  ),
  foreignKey(
    "source_record_versions",
    "source_record_versions_source_record_id_source_records_id_fk",
    ["source_record_id"],
    "source_records",
    ["id"],
    "cascade",
  ),
  foreignKey(
    "source_record_versions",
    "source_record_versions_ingestion_event_id_ingestion_events_id_fk",
    ["ingestion_event_id"],
    "ingestion_events",
    ["id"],
    "set_null",
  ),
  primaryKey("transaction_candidate_sources", ["candidate_id", "source_record_id"]),
  foreignKey(
    "transaction_candidate_sources",
    "transaction_candidate_sources_organization_id_auth_organizations_id_fk",
    ["organization_id"],
    "auth_organizations",
    ["id"],
    "cascade",
  ),
  foreignKey(
    "transaction_candidate_sources",
    "transaction_candidate_sources_candidate_id_transaction_candidates_id_fk",
    ["candidate_id"],
    "transaction_candidates",
    ["id"],
    "cascade",
  ),
  foreignKey(
    "transaction_candidate_sources",
    "transaction_candidate_sources_source_record_id_source_records_id_fk",
    ["source_record_id"],
    "source_records",
    ["id"],
    "restrict",
  ),
  check(
    "source_records",
    "source_records_record_state_check",
    "CHECK (((record_state)::text = ANY ((ARRAY['active'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[])))",
  ),
  check(
    "source_records",
    "source_records_direction_check",
    "CHECK (((direction)::text = ANY ((ARRAY['inflow'::character varying, 'outflow'::character varying, 'neutral'::character varying, 'unknown'::character varying])::text[])))",
  ),
  check(
    "source_records",
    "source_records_economic_event_class_check",
    "CHECK (((economic_event_class)::text = ANY ((ARRAY['purchase'::character varying, 'sale'::character varying, 'bill_accrual'::character varying, 'bill_payment'::character varying, 'invoice_accrual'::character varying, 'invoice_payment'::character varying, 'transfer'::character varying, 'payroll'::character varying, 'other'::character varying])::text[])))",
  ),
  check(
    "transaction_candidate_sources",
    "transaction_candidate_sources_relationship_check",
    "CHECK (((relationship)::text = ANY ((ARRAY['origin'::character varying, 'supporting'::character varying, 'corroborating'::character varying])::text[])))",
  ),
  check(
    "source_match_candidates",
    "source_match_candidates_canonical_pair_check",
    "CHECK ((left_source_record_id < right_source_record_id))",
  ),
  check(
    "source_match_candidates",
    "source_match_candidates_score_range_check",
    "CHECK (((score >= (0)::numeric) AND (score <= (100)::numeric)))",
  ),
  check(
    "source_match_candidates",
    "source_match_candidates_match_class_check",
    "CHECK (((match_class)::text = ANY ((ARRAY['duplicate'::character varying, 'related'::character varying])::text[])))",
  ),
  check(
    "source_match_candidates",
    "source_match_candidates_disposition_check",
    "CHECK (((disposition)::text = ANY ((ARRAY['blocking'::character varying, 'shadow'::character varying])::text[])))",
  ),
  check(
    "source_match_candidates",
    "source_match_candidates_resolution_action_check",
    "CHECK (((resolution_action IS NULL) OR ((resolution_action)::text = ANY ((ARRAY['consolidate_candidates'::character varying, 'attach_to_posted'::character varying, 'keep_separate'::character varying, 'merge_posted'::character varying, 'reject_source'::character varying])::text[]))))",
  ),
].map((item) =>
  deliberatelyNotValid0020.has(item.name) ? installedNotValidConstraint(item) : item,
);

function inlineForeignKeys0020(snapshot: CatalogSnapshot): ConstraintExpectation[] {
  return [
    foreignKey(
      "source_records",
      knownConstraintName(snapshot, "source_records", [
        "source_records_parent_source_record_id_source_records_id_fk",
        "source_records_parent_source_record_id_fkey",
      ]),
      ["parent_source_record_id"],
      "source_records",
      ["id"],
      "set_null",
    ),
    foreignKey(
      "source_match_candidates",
      knownConstraintName(snapshot, "source_match_candidates", [
        "source_match_candidates_canonical_candidate_id_transaction_candidates_id_fk",
        "source_match_candidates_canonical_candidate_id_fkey",
      ]),
      ["canonical_candidate_id"],
      "transaction_candidates",
      ["id"],
      "set_null",
    ),
    foreignKey(
      "source_match_candidates",
      knownConstraintName(snapshot, "source_match_candidates", [
        "source_match_candidates_canonical_journal_header_id_journal_headers_id_fk",
        "source_match_candidates_canonical_journal_header_id_fkey",
      ]),
      ["canonical_journal_header_id"],
      "journal_headers",
      ["id"],
      "set_null",
    ),
  ];
}

function expectation0020(
  snapshot: CatalogSnapshot,
  _context: VerificationContext,
): CatalogExpectation {
  return {
    relations: relations0020,
    indexes: indexes0020,
    constraints: [...constraints0020, ...inlineForeignKeys0020(snapshot)],
    policies: [
      tenantPolicy("source_record_versions", "tenant_isolation", localTenantExpression),
      tenantPolicy("transaction_candidate_sources", "tenant_isolation", localTenantExpression),
    ],
  };
}

export const verifier0020 = verifier(
  "0020",
  expectation0020,
  (snapshot) =>
    snapshot.relations.has("source_record_versions") ||
    snapshot.relations.has("transaction_candidate_sources") ||
    relationHasColumn(snapshot.relations.get("source_records"), "record_state") ||
    relationHasColumn(
      snapshot.relations.get("transaction_candidates"),
      "request_idempotency_key",
    ) ||
    indexes0020.some((item) => snapshot.indexes.has(item.name)),
  async (query) => {
    const [row] = await query.unsafe<{
      invalid_document_hashes: number;
      missing_source_backfills: number;
      missing_version_backfills: number;
      missing_candidate_sources: number;
      invalid_duplicate_rule: number;
      invalid_duplicate_rule_configs: number;
    }>(`
      SELECT
        (SELECT count(*)::integer FROM documents
          WHERE content_hash IS NOT NULL
            AND content_hash IS DISTINCT FROM
              NULLIF(lower(btrim(content_hash)), '')) AS invalid_document_hashes,
        (SELECT count(*)::integer FROM source_records
          WHERE (amount IS NOT NULL AND original_amount IS NULL)
             OR (currency IS NOT NULL AND original_currency IS NULL)
             OR (transaction_date IS NOT NULL AND effective_date IS NULL)) AS missing_source_backfills,
        (SELECT count(*)::integer FROM source_records AS source
          WHERE NOT EXISTS (
            SELECT 1 FROM source_record_versions AS version
            WHERE version.source_record_id = source.id
              AND version.external_version = source.external_version
          )) AS missing_version_backfills,
        (SELECT count(*)::integer FROM transaction_candidates AS candidate
          WHERE candidate.source_record_id IS NOT NULL
            AND NOT EXISTS (
              SELECT 1 FROM transaction_candidate_sources AS link
              WHERE link.candidate_id = candidate.id
                AND link.source_record_id = candidate.source_record_id
            )) AS missing_candidate_sources,
        (SELECT (CASE
          WHEN count(*) = 1
            AND count(*) FILTER (WHERE
              formula_version >= 2
              AND default_config ->> 'mode' IS NOT DISTINCT FROM 'enforce'
              AND default_config ->> 'matchWindowDays' IS NOT DISTINCT FROM '3'
              AND default_config ->> 'blockingScore' IS NOT DISTINCT FROM '70'
              AND default_config ->> 'shadowScore' IS NOT DISTINCT FROM '50'
              AND default_config ->> 'algorithmVersion' IS NOT DISTINCT FROM '1'
            ) = 1
          THEN 0
          ELSE 1
        END)::integer
        FROM review_rule_definitions
        WHERE key = 'possible_duplicate') AS invalid_duplicate_rule,
      (SELECT count(*)::integer
       FROM auth_organizations AS organization
       LEFT JOIN review_rule_definitions AS definition
         ON definition.key = 'possible_duplicate'
       LEFT JOIN review_rule_configs AS config
         ON config.organization_id = organization.id
        AND config.definition_id = definition.id
       WHERE definition.id IS NULL
         OR config.id IS NULL
         OR (config.config ? 'mode') IS DISTINCT FROM true
         OR config.config ->> 'mode' IS DISTINCT FROM 'shadow'
         OR (config.config ? 'matchWindowDays') IS DISTINCT FROM true
         OR (config.config ? 'blockingScore') IS DISTINCT FROM true
         OR (config.config ? 'shadowScore') IS DISTINCT FROM true
         OR (config.config ? 'algorithmVersion') IS DISTINCT FROM true
         OR config.lookback_months < 12
         OR config.version < 2) AS invalid_duplicate_rule_configs
    `);
    return [
      ...Object.entries(row ?? {})
        .filter(([key]) => key !== "invalid_duplicate_rule_configs")
        .map(([key, count]) =>
          evidence(
            `0020:${key.replaceAll("_", "-")}`,
            count === 0,
            "0 invalid rows",
            String(count ?? "missing"),
          ),
        ),
      evidence(
        "0020:invalid-duplicate-rule-configs",
        row?.invalid_duplicate_rule_configs === 0,
        "every organization has a complete possible-duplicate shadow config",
        String(row?.invalid_duplicate_rule_configs ?? "missing"),
      ),
    ];
  },
  async (_query, snapshot, context) => {
    const expected = expectation0020(snapshot, context);
    const baselineConstraints = (expected.constraints ?? []).map((item) =>
      deliberatelyNotValid0020.has(item.name) ? { ...item, validated: true } : item,
    );
    const rawInlineNames = new Set([
      "source_records_parent_source_record_id_fkey",
      "source_match_candidates_canonical_candidate_id_fkey",
      "source_match_candidates_canonical_journal_header_id_fkey",
    ]);
    return schemaSyncBaselineChecks(snapshot, expected, {
      key: "0020",
      constraints: baselineConstraints,
      forbidden: {
        constraints: [...snapshot.constraints.values()].filter((item) =>
          rawInlineNames.has(item.name),
        ),
      },
    });
  },
);
