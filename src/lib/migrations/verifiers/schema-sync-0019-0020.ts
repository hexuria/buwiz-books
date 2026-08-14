import type { ColumnExpectation, RelationExpectation } from "./catalog";
import { column, createdAt, idColumn } from "./expectations";

export const relations0020: RelationExpectation[] = [
  {
    name: "source_records",
    columns: [
      column("parent_source_record_id", "uuid", false),
      column("record_state", "character varying(24)", true, "'active'::character varying"),
      column("economic_event_class", "character varying(32)", true, "'other'::character varying"),
      column("direction", "character varying(16)", true, "'unknown'::character varying"),
      column("original_amount", "numeric(20,8)", false),
      column("original_currency", "character varying(3)", false),
      column("functional_amount", "numeric(20,8)", false),
      column("functional_currency", "character varying(3)", false),
      column("effective_date", "date", false),
      column("normalized_party", "character varying(255)", false),
      column("normalized_reference", "character varying(255)", false),
      column("source_account_ref", "character varying(255)", false),
      column("matcher_input_hash", "character varying(64)", false),
      column("matcher_version", "integer", true, "1"),
    ],
  },
  {
    name: "source_record_versions",
    kind: "table",
    rls: true,
    columns: [
      idColumn,
      column("organization_id", "text", true),
      column("source_record_id", "uuid", true),
      column("ingestion_event_id", "uuid", false),
      column("external_version", "character varying(128)", true),
      column("payload_hash", "character varying(64)", false),
      column("provider_status", "character varying(64)", false),
      column("raw_data", "jsonb", true, "'{}'::jsonb"),
      column("occurred_at", "timestamp with time zone", false),
      createdAt,
    ],
  },
  {
    name: "transaction_candidates",
    columns: [column("request_idempotency_key", "character varying(255)", false)],
  },
  {
    name: "transaction_candidate_sources",
    kind: "table",
    rls: true,
    columns: [
      column("organization_id", "text", true),
      column("candidate_id", "uuid", true),
      column("source_record_id", "uuid", true),
      column("relationship", "character varying(24)", true, "'origin'::character varying"),
      column("is_primary", "boolean", true, "false"),
      createdAt,
    ],
  },
  {
    name: "source_match_candidates",
    columns: [
      column("match_class", "character varying(24)", true, "'duplicate'::character varying"),
      column("disposition", "character varying(16)", true, "'blocking'::character varying"),
      column("score", "numeric(5,2)", true, "0"),
      column("signals", "jsonb", true, "'{}'::jsonb"),
      column("algorithm_version", "integer", true, "1"),
      column("left_input_hash", "character varying(64)", false),
      column("right_input_hash", "character varying(64)", false),
      column("lock_version", "integer", true, "1"),
      column("resolution_action", "character varying(32)", false),
      column("canonical_candidate_id", "uuid", false),
      column("canonical_journal_header_id", "uuid", false),
      column("resolution_reason", "text", false),
      column("resolution_idempotency_key", "character varying(255)", false),
      column("updated_at", "timestamp with time zone", true, "now()"),
    ],
  },
];

const evolving0019Tables = new Set([
  "source_records",
  "transaction_candidates",
  "source_match_candidates",
]);

export function relations0019ForTarget(
  base: readonly RelationExpectation[],
  includes0020: boolean,
): RelationExpectation[] {
  return base.map((relation) => {
    if (!evolving0019Tables.has(relation.name)) return relation;
    const addedColumns = includes0020
      ? (relations0020.find((candidate) => candidate.name === relation.name)?.columns ?? [])
      : [];
    return {
      ...relation,
      columns: [
        ...(relation.columns as readonly ColumnExpectation[]),
        ...(addedColumns as readonly ColumnExpectation[]),
      ],
      exactColumns: true,
    };
  });
}
