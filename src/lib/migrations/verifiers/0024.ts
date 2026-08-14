import {
  catalogHasAnyFootprint,
  type CatalogExpectation,
  type CatalogSnapshot,
  type ConstraintExpectation,
  type IndexExpectation,
} from "./catalog";
import {
  foreignKey,
  index,
  installedNotValidConstraint,
  sameColumns,
  schemaSyncBaselineChecks,
  semanticForeignKeyName,
  verifier,
} from "./expectations";

const indexes0024: IndexExpectation[] = [
  index("source_records_org_id_unique", "source_records", ["organization_id", "id"], {
    unique: true,
  }),
  index("documents_org_id_unique", "documents", ["organization_id", "id"], {
    unique: true,
  }),
  index(
    "transaction_candidates_org_id_unique",
    "transaction_candidates",
    ["organization_id", "id"],
    { unique: true },
  ),
  index("journal_headers_org_id_unique", "journal_headers", ["organization_id", "id"], {
    unique: true,
  }),
  index(
    "source_match_candidates_org_id_unique",
    "source_match_candidates",
    ["organization_id", "id"],
    { unique: true },
  ),
];

const constraints0024: ConstraintExpectation[] = [
  foreignKey(
    "source_records",
    "source_records_org_parent_source_fk",
    ["organization_id", "parent_source_record_id"],
    "source_records",
    ["organization_id", "id"],
    "no_action",
    { deferrable: true, initiallyDeferred: true },
  ),
  foreignKey(
    "source_record_versions",
    "source_record_versions_org_source_fk",
    ["organization_id", "source_record_id"],
    "source_records",
    ["organization_id", "id"],
    "cascade",
  ),
  foreignKey(
    "source_record_documents",
    "source_record_documents_org_source_fk",
    ["organization_id", "source_record_id"],
    "source_records",
    ["organization_id", "id"],
    "cascade",
  ),
  foreignKey(
    "source_record_documents",
    "source_record_documents_org_document_fk",
    ["organization_id", "document_id"],
    "documents",
    ["organization_id", "id"],
    "cascade",
  ),
  foreignKey(
    "transaction_candidates",
    "transaction_candidates_org_source_fk",
    ["organization_id", "source_record_id"],
    "source_records",
    ["organization_id", "id"],
    "no_action",
    { deferrable: true, initiallyDeferred: true },
  ),
  foreignKey(
    "transaction_candidate_sources",
    "transaction_candidate_sources_org_candidate_fk",
    ["organization_id", "candidate_id"],
    "transaction_candidates",
    ["organization_id", "id"],
    "cascade",
  ),
  foreignKey(
    "transaction_candidate_sources",
    "transaction_candidate_sources_org_source_fk",
    ["organization_id", "source_record_id"],
    "source_records",
    ["organization_id", "id"],
    "restrict",
  ),
  foreignKey(
    "source_match_candidates",
    "source_match_candidates_org_left_source_fk",
    ["organization_id", "left_source_record_id"],
    "source_records",
    ["organization_id", "id"],
    "cascade",
  ),
  foreignKey(
    "source_match_candidates",
    "source_match_candidates_org_right_source_fk",
    ["organization_id", "right_source_record_id"],
    "source_records",
    ["organization_id", "id"],
    "cascade",
  ),
  foreignKey(
    "source_match_candidates",
    "source_match_candidates_org_canonical_candidate_fk",
    ["organization_id", "canonical_candidate_id"],
    "transaction_candidates",
    ["organization_id", "id"],
    "no_action",
    { deferrable: true, initiallyDeferred: true },
  ),
  foreignKey(
    "source_match_candidates",
    "source_match_candidates_org_canonical_journal_fk",
    ["organization_id", "canonical_journal_header_id"],
    "journal_headers",
    ["organization_id", "id"],
    "no_action",
    { deferrable: true, initiallyDeferred: true },
  ),
  foreignKey(
    "ledger_source_links",
    "ledger_source_links_org_journal_fk",
    ["organization_id", "journal_header_id"],
    "journal_headers",
    ["organization_id", "id"],
    "cascade",
  ),
  foreignKey(
    "ledger_source_links",
    "ledger_source_links_org_source_fk",
    ["organization_id", "source_record_id"],
    "source_records",
    ["organization_id", "id"],
    "restrict",
  ),
  foreignKey(
    "journal_headers",
    "journal_headers_org_duplicate_of_fk",
    ["organization_id", "duplicate_of_header_id"],
    "journal_headers",
    ["organization_id", "id"],
    "restrict",
  ),
  foreignKey(
    "journal_duplicate_merges",
    "journal_duplicate_merges_org_canonical_fk",
    ["organization_id", "canonical_header_id"],
    "journal_headers",
    ["organization_id", "id"],
    "restrict",
  ),
  foreignKey(
    "journal_duplicate_merges",
    "journal_duplicate_merges_org_duplicate_fk",
    ["organization_id", "duplicate_header_id"],
    "journal_headers",
    ["organization_id", "id"],
    "restrict",
  ),
  foreignKey(
    "journal_duplicate_merges",
    "journal_duplicate_merges_duplicate_case_id_fk",
    ["duplicate_case_id"],
    "source_match_candidates",
    ["id"],
    "set_null",
  ),
  foreignKey(
    "journal_duplicate_merges",
    "journal_duplicate_merges_org_case_fk",
    ["organization_id", "duplicate_case_id"],
    "source_match_candidates",
    ["organization_id", "id"],
    "no_action",
    { deferrable: true, initiallyDeferred: true },
  ),
].map(installedNotValidConstraint);

function expectation0024(snapshot: CatalogSnapshot): CatalogExpectation {
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
  return {
    indexes: indexes0024,
    constraints: constraints0024.map((item) =>
      item.tableName === "journal_duplicate_merges" &&
      item.name === "journal_duplicate_merges_duplicate_case_id_fk"
        ? { ...item, name: duplicateCaseConstraint }
        : item,
    ),
  };
}

export const verifier0024 = verifier(
  "0024",
  (snapshot) => expectation0024(snapshot),
  (snapshot) => catalogHasAnyFootprint(snapshot, expectation0024(snapshot)),
  undefined,
  async (_query, snapshot) => {
    const expected = expectation0024(snapshot);
    const inheritedConstraint = (expected.constraints ?? [])
      .filter(
        (item) =>
          item.tableName === "journal_duplicate_merges" &&
          item.columns !== undefined &&
          sameColumns(item.columns, ["duplicate_case_id"]),
      )
      .map((item) => ({ ...item, validated: true }));
    return schemaSyncBaselineChecks(snapshot, expected, {
      key: "0024",
      constraints: inheritedConstraint,
      forbidden: {
        constraints: constraints0024.filter(
          (item) =>
            item.tableName !== "journal_duplicate_merges" ||
            item.columns === undefined ||
            !sameColumns(item.columns, ["duplicate_case_id"]),
        ),
      },
    });
  },
);
