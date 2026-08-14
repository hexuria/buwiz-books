import { describe, expect, it } from "vitest";
import { verifier0020 } from "@/lib/migrations/verifiers/0020";
import {
  createEmptyCatalogSnapshot,
  type CatalogSnapshot,
} from "@/lib/migrations/verifiers/catalog";
import type { VerificationQuery } from "@/lib/migrations/verifiers/types";
import {
  addCheck,
  addForeignKey,
  addIndex,
  addPolicy,
  addRelation,
  context,
  queryFor,
  withContext,
} from "./fixtures";

interface DuplicateRuleDefinitionBoundary {
  formulaVersion: number | null;
  defaultConfig: {
    mode?: string;
    matchWindowDays?: string;
    blockingScore?: string;
    shadowScore?: string;
    algorithmVersion?: string;
  };
}

const correctDuplicateRuleDefinition: DuplicateRuleDefinitionBoundary = {
  formulaVersion: 2,
  defaultConfig: {
    mode: "enforce",
    matchWindowDays: "3",
    blockingScore: "70",
    shadowScore: "50",
    algorithmVersion: "1",
  },
};

function duplicateRuleDefinitionIsCorrect(definition: DuplicateRuleDefinitionBoundary): boolean {
  return (
    definition.formulaVersion !== null &&
    definition.formulaVersion >= 2 &&
    definition.defaultConfig.mode === "enforce" &&
    definition.defaultConfig.matchWindowDays === "3" &&
    definition.defaultConfig.blockingScore === "70" &&
    definition.defaultConfig.shadowScore === "50" &&
    definition.defaultConfig.algorithmVersion === "1"
  );
}

/**
 * Emulates only the relevant PostgreSQL query boundaries. In particular,
 * ordinary `<>` returns UNKNOWN when either operand is NULL, while
 * `IS DISTINCT FROM` is null-safe. Definition cardinality is exact only when
 * the verifier SQL explicitly requires one row.
 */
function queryFor0020Boundary(
  snapshot: CatalogSnapshot,
  options: {
    documentHashes?: Array<string | null>;
    duplicateRuleDefinitions?: DuplicateRuleDefinitionBoundary[];
  },
): VerificationQuery {
  const catalogQuery = queryFor(snapshot);
  const documentHashes = options.documentHashes ?? [];
  const duplicateRuleDefinitions = options.duplicateRuleDefinitions ?? [
    correctDuplicateRuleDefinition,
  ];

  return {
    async unsafe<T>(sql: string): Promise<T[]> {
      if (sql.includes("pg_attribute") && sql.includes("pg_constraint")) {
        return catalogQuery.unsafe<T>(sql);
      }
      if (sql.includes("SELECT current_user AS current_user")) {
        return [{ current_user: "migration_owner" }] as T[];
      }

      const usesNullSafeHashComparison =
        /content_hash\s+IS DISTINCT FROM\s+NULLIF\(lower\(btrim\(content_hash\)\), ''\)/.test(sql);
      const invalidDocumentHashes = documentHashes.filter((contentHash) => {
        const trimmed = contentHash?.trim().toLowerCase() ?? null;
        const normalized = trimmed === "" ? null : trimmed;
        return usesNullSafeHashComparison
          ? contentHash !== normalized
          : contentHash !== null && normalized !== null && contentHash !== normalized;
      }).length;

      const enforcesExactDefinitionCardinality = /count\(\*\)\s*=\s*1/.test(sql);
      const invalidDuplicateRule = enforcesExactDefinitionCardinality
        ? duplicateRuleDefinitions.length === 1 &&
          duplicateRuleDefinitionIsCorrect(duplicateRuleDefinitions[0]!)
          ? 0
          : 1
        : duplicateRuleDefinitions.filter(
            (definition) => !duplicateRuleDefinitionIsCorrect(definition),
          ).length;

      return [
        {
          invalid_document_hashes: invalidDocumentHashes,
          missing_source_backfills: 0,
          missing_version_backfills: 0,
          missing_candidate_sources: 0,
          invalid_duplicate_rule: invalidDuplicateRule,
          invalid_duplicate_rule_configs: 0,
        },
      ] as T[];
    },
  };
}

const zeroData0020 = {
  invalid_document_hashes: 0,
  missing_source_backfills: 0,
  missing_version_backfills: 0,
  missing_candidate_sources: 0,
  invalid_duplicate_rule: 0,
  invalid_duplicate_rule_configs: 0,
};

describe("migration verifier 0020", () => {
  it("verifies all three 0020 inline lineage foreign keys through the public seam", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_record_versions", [], true);
    addForeignKey(
      snapshot,
      "source_records",
      "source_records_parent_source_record_id_fkey",
      ["parent_source_record_id"],
      "source_records",
      ["id"],
      "set_null",
    );
    addForeignKey(
      snapshot,
      "source_match_candidates",
      "source_match_candidates_canonical_candidate_id_fkey",
      ["canonical_candidate_id"],
      "transaction_candidates",
      ["id"],
      "set_null",
    );
    addForeignKey(
      snapshot,
      "source_match_candidates",
      "source_match_candidates_canonical_journal_header_id_fkey",
      ["canonical_journal_header_id"],
      "journal_headers",
      ["id"],
      "set_null",
    );
    const data = {
      invalid_document_hashes: 0,
      missing_source_backfills: 0,
      missing_version_backfills: 0,
      missing_candidate_sources: 0,
      invalid_duplicate_rule: 0,
      invalid_duplicate_rule_configs: 0,
    };

    const exact = await verifier0020.verify(
      queryFor(snapshot, data),
      withContext("post_apply", ["0019", "0020"]),
    );
    expect(exact.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "constraint:source_records.source_records_parent_source_record_id_fkey:on-delete",
          status: "pass",
        }),
        expect.objectContaining({
          key: "constraint:source_match_candidates.source_match_candidates_canonical_candidate_id_fkey:on-delete",
          status: "pass",
        }),
        expect.objectContaining({
          key: "constraint:source_match_candidates.source_match_candidates_canonical_journal_header_id_fkey:on-delete",
          status: "pass",
        }),
      ]),
    );

    snapshot.constraints.get(
      "source_match_candidates.source_match_candidates_canonical_candidate_id_fkey",
    )!.onDelete = "no_action";
    snapshot.constraints.get(
      "source_records.source_records_parent_source_record_id_fkey",
    )!.columns = ["id"];
    const wrong = await verifier0020.verify(
      queryFor(snapshot, data),
      withContext("post_apply", ["0019", "0020"]),
    );
    expect(wrong.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "constraint:source_match_candidates.source_match_candidates_canonical_candidate_id_fkey:on-delete",
          status: "fail",
        }),
        expect.objectContaining({
          key: "constraint:source_records.source_records_parent_source_record_id_fkey:columns",
          status: "fail",
        }),
      ]),
    );
  });

  it("fails closed when 0020 per-organization duplicate-rule config evidence is missing", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_record_versions", [], true);

    const result = await verifier0020.verify(
      queryFor(snapshot, {
        invalid_document_hashes: 0,
        missing_source_backfills: 0,
        missing_version_backfills: 0,
        missing_candidate_sources: 0,
        invalid_duplicate_rule: 0,
      }),
      withContext("post_apply", ["0019", "0020"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0020:invalid-duplicate-rule-configs",
          status: "fail",
        }),
      ]),
    );
  });

  it("rejects wrong 0020 duplicate-rule configs and accepts complete config evidence", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_record_versions", [], true);
    const baseData = {
      invalid_document_hashes: 0,
      missing_source_backfills: 0,
      missing_version_backfills: 0,
      missing_candidate_sources: 0,
      invalid_duplicate_rule: 0,
    };

    const wrong = await verifier0020.verify(
      queryFor(snapshot, {
        ...baseData,
        invalid_duplicate_rule_configs: 1,
      }),
      withContext("post_apply", ["0019", "0020"]),
    );
    const complete = await verifier0020.verify(
      queryFor(snapshot, {
        ...baseData,
        invalid_duplicate_rule_configs: 0,
      }),
      withContext("post_apply", ["0019", "0020"]),
    );

    expect(
      wrong.evidence.find((item) => item.key === "0020:invalid-duplicate-rule-configs")?.status,
    ).toBe("fail");
    expect(
      complete.evidence.find((item) => item.key === "0020:invalid-duplicate-rule-configs")?.status,
    ).toBe("pass");
  });

  it("uses null-safe normalization across 0020 content-hash boundaries", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_record_versions", [], true);
    const result = await verifier0020.verify(
      queryFor0020Boundary(snapshot, {
        documentHashes: [null, "", "   ", " hash ", "ABC", "abc"],
      }),
      withContext("post_apply", ["0019", "0020"]),
    );

    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "0020:invalid-document-hashes",
          status: "fail",
          observed: "4",
        }),
      ]),
    );
  });

  it("requires exactly one correct global 0020 duplicate-rule definition", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_record_versions", [], true);
    const drifted = {
      ...correctDuplicateRuleDefinition,
      defaultConfig: {
        ...correctDuplicateRuleDefinition.defaultConfig,
        mode: "shadow",
      },
    };
    const cases = [
      { definitions: [], invalidRows: 1 },
      { definitions: [correctDuplicateRuleDefinition], invalidRows: 0 },
      {
        definitions: [correctDuplicateRuleDefinition, correctDuplicateRuleDefinition],
        invalidRows: 1,
      },
      { definitions: [drifted], invalidRows: 1 },
    ];

    for (const { definitions, invalidRows } of cases) {
      const result = await verifier0020.verify(
        queryFor0020Boundary(snapshot, {
          duplicateRuleDefinitions: definitions,
        }),
        withContext("post_apply", ["0019", "0020"]),
      );
      expect(result.evidence.find((item) => item.key === "0020:invalid-duplicate-rule")).toEqual(
        expect.objectContaining({
          status: invalidRows === 0 ? "pass" : "fail",
          observed: String(invalidRows),
        }),
      );
    }
  });

  it("accepts an installed NOT VALID check and its stronger validated successor", async () => {
    for (const validated of [false, true]) {
      const snapshot = createEmptyCatalogSnapshot();
      addRelation(snapshot, "source_records", []);
      addCheck(
        snapshot,
        "source_records",
        "source_records_record_state_check",
        "CHECK (((record_state)::text = ANY ((ARRAY['active'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[])))",
        validated,
      );

      const result = await verifier0020.verify(queryFor(snapshot, zeroData0020), context);
      expect(
        result.evidence.filter(
          (item) =>
            item.key === "constraint:source_records.source_records_record_state_check:validated" &&
            item.status === "fail",
        ),
      ).toEqual([]);
    }
  });

  it("blocks a raw NOT VALID check in the schema-sync pre-execution baseline", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_records", []);
    addCheck(
      snapshot,
      "source_records",
      "source_records_record_state_check",
      "CHECK (((record_state)::text = ANY ((ARRAY['active'::character varying, 'rejected'::character varying, 'superseded'::character varying])::text[])))",
      false,
    );

    const result = await verifier0020.verify(
      queryFor(snapshot, zeroData0020),
      withContext("pre_execution", ["0020"]),
    );
    expect(result.state).toBe("partial");
    expect(
      result.evidence.find(
        (item) =>
          item.key === "constraint:source_records.source_records_record_state_check:validated",
      )?.status,
    ).toBe("fail");
  });

  it("requires the migration principal to own a managed relation", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "source_records", []);
    addIndex(snapshot, "source_records_parent_idx", "source_records", ["parent_source_record_id"]);
    snapshot.relations.get("source_records")!.owner = "unexpected_owner";

    const result = await verifier0020.verify(
      queryFor(snapshot, zeroData0020),
      withContext("post_apply", ["0020"]),
    );
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:source_records",
          status: "fail",
        }),
      ]),
    );
  });

  it("enforces the exact 0020 policy identities", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    for (const tableName of ["source_record_versions", "transaction_candidate_sources"]) {
      addRelation(snapshot, tableName, [], true);
      addPolicy(snapshot, tableName, "tenant_isolation", "organization_id");
    }

    const exact = await verifier0020.verify(
      queryFor(snapshot, zeroData0020),
      withContext("post_apply", ["0020"]),
    );
    expect(exact.evidence.find((item) => item.key === "0020:exact-policy-identities")?.status).toBe(
      "pass",
    );

    addPolicy(snapshot, "source_record_versions", "unexpected_permissive_policy", "true");
    const extra = await verifier0020.verify(
      queryFor(snapshot, zeroData0020),
      withContext("post_apply", ["0020"]),
    );
    expect(extra.evidence.find((item) => item.key === "0020:exact-policy-identities")).toEqual(
      expect.objectContaining({
        status: "fail",
        observed: expect.stringContaining("source_record_versions.unexpected_permissive_policy"),
      }),
    );
  });
});
