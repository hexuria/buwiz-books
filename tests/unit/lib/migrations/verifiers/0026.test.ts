import { describe, expect, it } from "vitest";
import { verifier0026 } from "@/lib/migrations/verifiers/0026";
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
  queryFor,
  withContext,
} from "./fixtures";

function complete0026(nameStyle: "raw" | "schema") {
  const snapshot = createEmptyCatalogSnapshot();
  const tables: Array<[string, Array<[string, string, boolean, (string | null)?]>]> = [
    [
      "ai_invocations",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["task", "text", true, null],
        ["prompt_name", "text", false, null],
        ["prompt_version", "text", false, null],
        ["schema_hash", "text", false, null],
        ["provider", "text", true, "'gemini'::text"],
        ["model", "text", false, null],
        ["chain_position", "integer", false, null],
        ["escalation_reason", "text", false, null],
        ["config_snapshot", "jsonb", false, null],
        ["tokens_in", "integer", false, null],
        ["tokens_out", "integer", false, null],
        ["image_tokens", "integer", false, null],
        ["cost_usd", "numeric", false, null],
        ["latency_ms", "integer", false, null],
        ["validation_outcome", "text", false, null],
        ["error_message", "text", false, null],
        ["agent_run_step_id", "uuid", false, null],
        ["request_id", "text", false, null],
        ["created_at", "timestamp with time zone", true, "now()"],
      ],
    ],
    [
      "ai_action_proposals",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["kind", "text", true, null],
        ["proposal", "jsonb", true, null],
        ["invocation_id", "uuid", false, null],
        ["confidence", "numeric", false, null],
        ["source_ref", "jsonb", false, null],
        ["status", "text", true, "'pending'::text"],
        ["created_by", "text", false, null],
        ["approved_by", "text", false, null],
        ["applied_at", "timestamp with time zone", false, null],
        ["expires_at", "timestamp with time zone", false, null],
        ["created_at", "timestamp with time zone", true, "now()"],
      ],
    ],
    [
      "ai_run_feedback",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["proposal_id", "uuid", false, null],
        ["invocation_id", "uuid", false, null],
        ["verdict", "text", true, null],
        ["correction", "jsonb", false, null],
        ["user_id", "text", false, null],
        ["created_at", "timestamp with time zone", true, "now()"],
      ],
    ],
    [
      "agent_runs",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["kind", "text", true, null],
        ["status", "text", true, "'running'::text"],
        ["config_snapshot", "jsonb", false, null],
        ["blocked_reason", "jsonb", false, null],
        ["started_at", "timestamp with time zone", true, "now()"],
        ["finished_at", "timestamp with time zone", false, null],
      ],
    ],
    [
      "agent_run_steps",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["run_id", "uuid", true, null],
        ["step", "text", true, null],
        ["status", "text", true, "'running'::text"],
        ["input_ref", "jsonb", false, null],
        ["output_ref", "jsonb", false, null],
        ["processing_job_id", "uuid", false, null],
        ["error", "jsonb", false, null],
        ["started_at", "timestamp with time zone", true, "now()"],
        ["finished_at", "timestamp with time zone", false, null],
      ],
    ],
    [
      "ai_provider_health",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["credential_fingerprint", "text", true, null],
        ["consecutive_failures", "integer", true, "0"],
        ["lockout_level", "integer", true, "0"],
        ["cooldown_until", "timestamp with time zone", false, null],
        ["invalid", "boolean", true, "false"],
        ["last_error_class", "text", false, null],
        ["last_used_at", "timestamp with time zone", false, null],
        ["updated_at", "timestamp with time zone", true, "now()"],
      ],
    ],
    [
      "organization_ai_credentials",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["provider", "text", true, null],
        ["encrypted_key", "text", true, null],
        ["base_url", "text", false, null],
        ["label", "text", false, null],
        ["last_used_at", "timestamp with time zone", false, null],
        ["revoked_at", "timestamp with time zone", false, null],
        ["created_at", "timestamp with time zone", true, "now()"],
        ["updated_at", "timestamp with time zone", true, "now()"],
      ],
    ],
    [
      "organization_ai_settings",
      [
        ["organization_id", "text", true, null],
        ["task_chains", "jsonb", false, null],
        ["confidence_thresholds", "jsonb", false, null],
        ["autonomy", "jsonb", false, null],
        ["task_allowlist", "jsonb", false, null],
        ["provider_allowlist", "jsonb", false, null],
        ["monthly_spend_cap_usd", "numeric", false, null],
        ["kill_switch", "boolean", true, "false"],
        ["eval_data_sharing", "text", true, "'none'::text"],
        ["eval_consent_by", "text", false, null],
        ["eval_consent_at", "timestamp with time zone", false, null],
        ["updated_by", "text", false, null],
        ["updated_at", "timestamp with time zone", true, "now()"],
      ],
    ],
    [
      "ai_lessons",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["task", "text", true, null],
        ["lesson", "text", true, null],
        ["source_feedback_ids", "jsonb", false, null],
        ["status", "text", true, "'proposed'::text"],
        ["approved_by", "text", false, null],
        ["expires_at", "timestamp with time zone", false, null],
        ["created_at", "timestamp with time zone", true, "now()"],
      ],
    ],
    [
      "ai_eval_cases",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", false, null],
        ["task", "text", true, null],
        ["input_ref", "jsonb", true, null],
        ["expected", "jsonb", true, null],
        ["provenance", "text", true, null],
        ["pii_redacted", "boolean", true, "false"],
        ["org_consent_at", "timestamp with time zone", false, null],
        ["prompt_version_at_capture", "text", false, null],
        ["created_at", "timestamp with time zone", true, "now()"],
      ],
    ],
    [
      "statement_line_matches",
      [
        ["id", "uuid", true, "gen_random_uuid()"],
        ["organization_id", "text", true, null],
        ["statement_line_id", "uuid", true, null],
        ["journal_line_id", "uuid", true, null],
        ["allocated_amount", "numeric(15,2)", true, null],
        ["created_at", "timestamp without time zone", true, "now()"],
      ],
    ],
  ];
  for (const [tableName, columns] of tables) {
    addRelation(
      snapshot,
      tableName,
      columns.map(([name, type, notNull, defaultExpression], index) =>
        column(name, type, notNull, defaultExpression ?? null, index + 1),
      ),
    );
    addPrimaryKey(snapshot, tableName, [
      tableName === "organization_ai_settings" ? "organization_id" : "id",
    ]);
  }

  const indexes: Array<[string, string, string[], { unique?: boolean }?]> = [
    ["ai_invocations_org_created_idx", "ai_invocations", ["organization_id", "created_at"]],
    ["ai_invocations_org_task_idx", "ai_invocations", ["organization_id", "task"]],
    [
      "ai_action_proposals_org_status_idx",
      "ai_action_proposals",
      ["organization_id", "status", "created_at"],
    ],
    ["ai_action_proposals_org_kind_idx", "ai_action_proposals", ["organization_id", "kind"]],
    ["ai_action_proposals_source_idx", "ai_action_proposals", ["organization_id", "source_ref"]],
    ["ai_run_feedback_org_created_idx", "ai_run_feedback", ["organization_id", "created_at"]],
    ["ai_run_feedback_proposal_idx", "ai_run_feedback", ["proposal_id"]],
    ["agent_runs_org_kind_idx", "agent_runs", ["organization_id", "kind"]],
    ["agent_run_steps_run_idx", "agent_run_steps", ["run_id", "started_at"]],
    [
      "ai_provider_health_org_fingerprint_unique",
      "ai_provider_health",
      ["organization_id", "credential_fingerprint"],
      { unique: true },
    ],
    [
      "organization_ai_credentials_org_provider_idx",
      "organization_ai_credentials",
      ["organization_id", "provider"],
    ],
    ["ai_lessons_org_task_status_idx", "ai_lessons", ["organization_id", "task", "status"]],
    ["ai_eval_cases_task_idx", "ai_eval_cases", ["task"]],
    ["statement_line_matches_line_idx", "statement_line_matches", ["statement_line_id"]],
    [
      "statement_line_matches_journal_line_unique",
      "statement_line_matches",
      ["journal_line_id"],
      { unique: true },
    ],
    [
      "statement_line_matches_pair_unique",
      "statement_line_matches",
      ["statement_line_id", "journal_line_id"],
      { unique: true },
    ],
  ];
  for (const [name, tableName, keyExpressions, options] of indexes) {
    addIndex(snapshot, name, tableName, keyExpressions, options);
  }

  const foreignKeys: Array<[string, string, string, string, "cascade" | "no_action"]> = [
    ["ai_action_proposals", "invocation_id", "ai_invocations", "id", "no_action"],
    ["ai_run_feedback", "proposal_id", "ai_action_proposals", "id", "no_action"],
    ["ai_run_feedback", "invocation_id", "ai_invocations", "id", "no_action"],
    ["agent_run_steps", "run_id", "agent_runs", "id", "no_action"],
    ["statement_line_matches", "statement_line_id", "statement_lines", "id", "cascade"],
    ["statement_line_matches", "journal_line_id", "journal_lines", "id", "no_action"],
  ];
  for (const [tableName, columnName, referencedTable, referencedColumn, onDelete] of foreignKeys) {
    addForeignKey(
      snapshot,
      tableName,
      nameStyle === "raw"
        ? `${tableName}_${columnName}_fkey`
        : `${tableName}_${columnName}_${referencedTable}_${referencedColumn}_fk`,
      [columnName],
      referencedTable,
      [referencedColumn],
      onDelete,
    );
  }
  return snapshot;
}

describe("migration verifier 0026", () => {
  it("does not treat ubiquitous predecessor tables as a 0026 footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "financial_accounts", []);
    addRelation(snapshot, "statement_lines", []);

    expect((await verifier0026.verify(queryFor(snapshot), context)).state).toBe("absent");
  });

  it("accepts the complete immutable raw-SQL 0026 catalog before schema synchronization", async () => {
    const result = await verifier0026.verify(
      queryFor(complete0026("raw")),
      withContext("post_apply", ["0026"]),
    );

    expect(result.evidence.filter((item) => item.status === "fail")).toEqual([]);
    expect(result.state).toBe("complete");
  });

  it("requires independent 0026 execution evidence only during discovery", async () => {
    const discovery = withContext("discovery", ["0026"]);
    const postApply = withContext("post_apply", ["0026"]);
    const final = withContext("final", ["0026"]);

    expect((await verifier0026.verify(queryFor(complete0026("schema")), discovery)).state).toBe(
      "partial",
    );
    expect((await verifier0026.verify(queryFor(complete0026("raw")), discovery)).state).toBe(
      "complete",
    );
    expect((await verifier0026.verify(queryFor(complete0026("schema")), postApply)).state).toBe(
      "complete",
    );
    expect((await verifier0026.verify(queryFor(complete0026("schema")), final)).state).toBe(
      "complete",
    );
  });

  it("keeps the pre-schema execution barrier fail closed", async () => {
    const preExecution = withContext("pre_execution", ["0026"]);
    expect(
      (await verifier0026.verify(queryFor(createEmptyCatalogSnapshot()), preExecution)).state,
    ).toBe("absent");
    expect((await verifier0026.verify(queryFor(complete0026("raw")), preExecution)).state).toBe(
      "complete",
    );
    expect((await verifier0026.verify(queryFor(complete0026("schema")), preExecution)).state).toBe(
      "partial",
    );
  });

  it("rejects 0026 column, index, and constraint drift through the public verifier seam", async () => {
    const mutations: Array<(snapshot: CatalogSnapshot) => void> = [
      (snapshot) => {
        snapshot.relations.get("ai_run_feedback")!.columns[4].name = "outcome";
      },
      (snapshot) => {
        snapshot.relations
          .get("ai_lessons")!
          .columns.push(column("updated_at", "timestamp with time zone", true, "now()", 10));
      },
      (snapshot) => {
        snapshot.relations.get("ai_eval_cases")!.columns[6].defaultExpression = "true";
      },
      (snapshot) => {
        snapshot.indexes.get("ai_action_proposals_org_status_idx")!.keyExpressions = [
          "organization_id",
          "status",
        ];
      },
      (snapshot) => {
        snapshot.constraints.delete("ai_action_proposals.ai_action_proposals_invocation_id_fkey");
        addForeignKey(
          snapshot,
          "ai_action_proposals",
          "arbitrary_invocation_fk",
          ["invocation_id"],
          "ai_invocations",
          ["id"],
        );
      },
    ];

    for (const mutate of mutations) {
      const snapshot = complete0026("raw");
      mutate(snapshot);
      expect(
        (await verifier0026.verify(queryFor(snapshot), withContext("post_apply", ["0026"]))).state,
      ).toBe("partial");
    }
  });

  it("requires the migration principal to own a managed relation", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    addRelation(snapshot, "ai_invocations", []);
    snapshot.relations.get("ai_invocations")!.owner = "unexpected_owner";

    const result = await verifier0026.verify(
      queryFor(snapshot),
      withContext("post_apply", ["0026"]),
    );
    expect(result.evidence).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: "migration-owner:relation:ai_invocations",
          status: "fail",
        }),
      ]),
    );
  });

  it("does not query the migration principal without a footprint", async () => {
    const snapshot = createEmptyCatalogSnapshot();
    const catalogQuery = queryFor(snapshot);
    let principalQueries = 0;
    const query: VerificationQuery = {
      async unsafe<T>(sql: string): Promise<T[]> {
        if (sql.includes("SELECT current_user AS current_user")) principalQueries += 1;
        return catalogQuery.unsafe<T>(sql);
      },
    };

    expect((await verifier0026.verify(query, withContext("discovery", ["0026"]))).state).toBe(
      "absent",
    );
    expect(principalQueries).toBe(0);
  });
});
