import {
  readCatalogSnapshot,
  relationHasColumn,
  verifyCatalog,
  type CatalogExpectation,
  type CatalogSnapshot,
} from "./catalog";
import {
  column,
  createdAt,
  exactTable,
  foreignKey,
  index,
  knownConstraintName,
  primaryKey,
  updatedAt,
} from "./expectations";
import { verifyMigrationSecurity } from "./security";
import { classifyVerification, evidence, type MigrationVerifier } from "./types";

const expectation0018Base: CatalogExpectation = {
  relations: [
    exactTable(
      "organization_secrets",
      [
        column("organization_id", "text", true),
        column("gemini_api_keys", "jsonb", true, "'[]'::jsonb"),
        column("resend_api_key", "text", false),
        column("stripe_secret_key", "text", false),
        column("stripe_webhook_secret", "text", false),
        column("paypal_client_secret", "text", false),
        createdAt,
        updatedAt,
      ],
      false,
    ),
    {
      name: "journal_headers",
      columns: [column("idempotency_key", "character varying(255)", false)],
    },
  ],
  indexes: [
    index(
      "journal_headers_org_idempotency_key_unique",
      "journal_headers",
      ["organization_id", "idempotency_key"],
      { unique: true, predicate: "idempotency_key IS NOT NULL" },
    ),
    index("journal_headers_org_source_document_idx", "journal_headers", [
      "organization_id",
      "source_document_type",
      "source_document_id",
    ]),
    index(
      "reconciliations_org_account_period_unique",
      "reconciliations",
      ["organization_id", "bank_account_id", "period_start", "period_end"],
      { unique: true },
    ),
    index("reconciliations_org_status_idx", "reconciliations", ["organization_id", "status"]),
    index("statement_lines_reconciliation_idx", "statement_lines", ["reconciliation_id"]),
    index(
      "statement_lines_matched_journal_line_unique",
      "statement_lines",
      ["matched_journal_line_id"],
      { unique: true, predicate: "matched_journal_line_id IS NOT NULL" },
    ),
  ],
  constraints: [
    primaryKey("organization_secrets", ["organization_id"]),
    foreignKey(
      "organization_secrets",
      "organization_secrets_organization_id_auth_organizations_id_fk",
      ["organization_id"],
      "auth_organizations",
      ["id"],
      "cascade",
    ),
  ],
};

function managedRelationNames(expected: CatalogExpectation): string[] {
  return [
    ...(expected.relations ?? []).map((relation) => relation.name),
    ...(expected.indexes ?? []).map((item) => item.tableName),
    ...(expected.constraints ?? []).map((item) => item.tableName),
    ...(expected.policies ?? []).map((policy) => policy.tableName),
    ...(expected.triggers ?? []).map((item) => item.tableName),
  ]
    .filter((name): name is string => name !== undefined)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function expectation0018(snapshot: CatalogSnapshot): CatalogExpectation {
  const organizationForeignKey = knownConstraintName(snapshot, "organization_secrets", [
    "organization_secrets_organization_id_auth_organizations_id_fk",
    "organization_secrets_organization_id_fkey",
  ]);
  return {
    ...expectation0018Base,
    constraints: (expectation0018Base.constraints ?? []).map((item) =>
      item.tableName === "organization_secrets" &&
      item.name === "organization_secrets_organization_id_auth_organizations_id_fk"
        ? { ...item, name: organizationForeignKey }
        : item,
    ),
  };
}

interface Migration0018Provenance {
  leaked_secrets: number;
  invalid_source_gemini_shapes: number;
  invalid_key_arrays: number;
  conflicting_destination_rows: number;
  destination_secret_rows: number;
  organization_rows: number;
}

type Migration0018SourceProvenance = Pick<
  Migration0018Provenance,
  "organization_rows" | "leaked_secrets" | "invalid_source_gemini_shapes"
>;

type Migration0018DestinationProvenance = Pick<
  Migration0018Provenance,
  "invalid_key_arrays" | "destination_secret_rows"
>;

export const verifier0018: MigrationVerifier = {
  id: "0018",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const expected = expectation0018(snapshot);
    const hasFootprint =
      snapshot.relations.has("organization_secrets") ||
      relationHasColumn(snapshot.relations.get("journal_headers"), "idempotency_key") ||
      (expectation0018Base.indexes ?? []).some((item) => snapshot.indexes.has(item.name));
    const hasOrganizationSource = snapshot.relations.has("auth_organizations");
    const hasSecretDestination = snapshot.relations.has("organization_secrets");
    const catalogChecks = verifyCatalog(snapshot, expected);
    if (!hasFootprint && !hasOrganizationSource) {
      return classifyVerification(false, catalogChecks, "0018");
    }
    const securityChecks = hasFootprint
      ? await verifyMigrationSecurity(query, snapshot, managedRelationNames(expected))
      : [];
    const catalogAndSecurityChecks = [...catalogChecks, ...securityChecks];

    let row: Migration0018Provenance | undefined;
    if (hasOrganizationSource && hasSecretDestination) {
      [row] = await query.unsafe<Migration0018Provenance>(`
      SELECT
        count(*)::integer AS organization_rows,
        count(*) FILTER (
          WHERE COALESCE(metadata, '{}')::jsonb ?| ARRAY[
            'geminiApiKeys', 'resendApiKey', 'stripeSecretKey',
            'stripeWebhookSecret', 'paypalClientSecret'
          ]
        )::integer AS leaked_secrets,
        count(*) FILTER (
          WHERE COALESCE(metadata, '{}')::jsonb ? 'geminiApiKeys'
            AND jsonb_typeof(
              COALESCE(metadata, '{}')::jsonb -> 'geminiApiKeys'
            ) IS DISTINCT FROM 'array'
        )::integer AS invalid_source_gemini_shapes,
        (SELECT count(*)::integer FROM organization_secrets
          WHERE jsonb_typeof(gemini_api_keys) IS DISTINCT FROM 'array') AS invalid_key_arrays,
        (SELECT count(*)::integer FROM organization_secrets) AS destination_secret_rows,
        (
          SELECT count(*)::integer
          FROM auth_organizations AS source
          INNER JOIN organization_secrets AS destination
            ON destination.organization_id = source.id
          WHERE (
              COALESCE(source.metadata, '{}')::jsonb ? 'geminiApiKeys'
              AND jsonb_typeof(
                COALESCE(source.metadata, '{}')::jsonb -> 'geminiApiKeys'
              ) = 'array'
              AND destination.gemini_api_keys IS DISTINCT FROM '[]'::jsonb
              AND destination.gemini_api_keys IS DISTINCT FROM
                COALESCE(source.metadata, '{}')::jsonb -> 'geminiApiKeys'
            )
            OR (
              COALESCE(source.metadata, '{}')::jsonb ? 'resendApiKey'
              AND destination.resend_api_key IS NOT NULL
              AND destination.resend_api_key <> ''
              AND destination.resend_api_key IS DISTINCT FROM
                COALESCE(source.metadata, '{}')::jsonb ->> 'resendApiKey'
            )
            OR (
              COALESCE(source.metadata, '{}')::jsonb ? 'stripeSecretKey'
              AND destination.stripe_secret_key IS NOT NULL
              AND destination.stripe_secret_key <> ''
              AND destination.stripe_secret_key IS DISTINCT FROM
                COALESCE(source.metadata, '{}')::jsonb ->> 'stripeSecretKey'
            )
            OR (
              COALESCE(source.metadata, '{}')::jsonb ? 'stripeWebhookSecret'
              AND destination.stripe_webhook_secret IS NOT NULL
              AND destination.stripe_webhook_secret <> ''
              AND destination.stripe_webhook_secret IS DISTINCT FROM
                COALESCE(source.metadata, '{}')::jsonb ->> 'stripeWebhookSecret'
            )
            OR (
              COALESCE(source.metadata, '{}')::jsonb ? 'paypalClientSecret'
              AND destination.paypal_client_secret IS NOT NULL
              AND destination.paypal_client_secret <> ''
              AND destination.paypal_client_secret IS DISTINCT FROM
                COALESCE(source.metadata, '{}')::jsonb ->> 'paypalClientSecret'
            )
        ) AS conflicting_destination_rows
      FROM auth_organizations
    `);
    } else {
      let source: Migration0018SourceProvenance | undefined;
      if (hasOrganizationSource) {
        [source] = await query.unsafe<Migration0018SourceProvenance>(`
          SELECT
            count(*)::integer AS organization_rows,
            count(*) FILTER (
              WHERE COALESCE(metadata, '{}')::jsonb ?| ARRAY[
                'geminiApiKeys', 'resendApiKey', 'stripeSecretKey',
                'stripeWebhookSecret', 'paypalClientSecret'
              ]
            )::integer AS leaked_secrets,
            count(*) FILTER (
              WHERE COALESCE(metadata, '{}')::jsonb ? 'geminiApiKeys'
                AND jsonb_typeof(
                  COALESCE(metadata, '{}')::jsonb -> 'geminiApiKeys'
                ) IS DISTINCT FROM 'array'
            )::integer AS invalid_source_gemini_shapes
          FROM auth_organizations
        `);
      }

      let destination: Migration0018DestinationProvenance | undefined;
      if (hasSecretDestination) {
        [destination] = await query.unsafe<Migration0018DestinationProvenance>(`
          SELECT
            count(*) FILTER (
              WHERE jsonb_typeof(gemini_api_keys) IS DISTINCT FROM 'array'
            )::integer AS invalid_key_arrays,
            count(*)::integer AS destination_secret_rows
          FROM organization_secrets
        `);
      }

      row = {
        organization_rows: source?.organization_rows ?? 0,
        leaked_secrets: source?.leaked_secrets ?? 0,
        invalid_source_gemini_shapes: source?.invalid_source_gemini_shapes ?? 0,
        invalid_key_arrays: destination?.invalid_key_arrays ?? 0,
        destination_secret_rows: destination?.destination_secret_rows ?? 0,
        conflicting_destination_rows: 0,
      };
    }

    if (!hasFootprint && row.organization_rows === 0) {
      return classifyVerification(false, catalogChecks, "0018");
    }

    const catalogComplete = catalogAndSecurityChecks.every((item) => item.status !== "fail");
    const repairableMetadataPreState =
      (context.mode === "discovery" || context.mode === "pre_execution") &&
      (catalogComplete || (!hasFootprint && hasOrganizationSource && !hasSecretDestination)) &&
      (row?.leaked_secrets ?? 0) > 0 &&
      row?.invalid_source_gemini_shapes === 0 &&
      row?.invalid_key_arrays === 0 &&
      row?.conflicting_destination_rows === 0;
    if (repairableMetadataPreState) {
      return {
        state: "absent",
        shape: "repairable_metadata_secret_pre_state",
        evidence: [
          ...catalogAndSecurityChecks,
          evidence(
            "0018:metadata-secret-pre-state",
            true,
            "metadata secrets ready for transactional copy and scrub",
            String(row?.leaked_secrets),
          ),
          evidence(
            "0018:source-gemini-key-array",
            true,
            "all source Gemini key values are arrays",
            String(row?.invalid_source_gemini_shapes),
          ),
          evidence(
            "0018:gemini-key-array",
            true,
            "all existing Gemini key values are arrays",
            String(row?.invalid_key_arrays),
          ),
          evidence(
            "0018:destination-secret-conflicts",
            true,
            "no nonempty destination secret conflicts with source metadata",
            String(row?.conflicting_destination_rows),
          ),
        ],
      };
    }

    const schemaSyncBaseline =
      context.mode === "pre_execution" &&
      catalogComplete &&
      row?.leaked_secrets === 0 &&
      row?.invalid_source_gemini_shapes === 0 &&
      row?.invalid_key_arrays === 0 &&
      row?.conflicting_destination_rows === 0 &&
      row?.destination_secret_rows === 0;
    if (schemaSyncBaseline) {
      return {
        state: "absent",
        shape: "schema_sync_baseline",
        evidence: [
          ...catalogAndSecurityChecks,
          evidence(
            "0018:schema-sync-baseline",
            true,
            "exact schema catalog with no migration-owned destination rows",
            "exact",
          ),
        ],
      };
    }

    const dataChecks = [
      evidence(
        "0018:metadata-secret-scrub",
        row?.leaked_secrets === 0,
        "0 leaked metadata secrets",
        String(row?.leaked_secrets ?? "missing"),
      ),
      evidence(
        "0018:source-gemini-key-array",
        row?.invalid_source_gemini_shapes === 0,
        "all source Gemini key values are arrays",
        String(row?.invalid_source_gemini_shapes ?? "missing"),
      ),
      evidence(
        "0018:gemini-key-array",
        row?.invalid_key_arrays === 0,
        "all Gemini key values are arrays",
        String(row?.invalid_key_arrays ?? "missing"),
      ),
      evidence(
        "0018:destination-secret-conflicts",
        row?.conflicting_destination_rows === 0,
        "no nonempty destination secret conflicts with source metadata",
        String(row?.conflicting_destination_rows ?? "missing"),
      ),
      evidence(
        "0018:destination-secret-adoption-evidence",
        context.mode === "discovery"
          ? row?.organization_rows === 0
          : context.mode === "pre_execution"
            ? false
            : true,
        context.mode === "discovery"
          ? "a genuinely empty organization population"
          : context.mode === "pre_execution"
            ? "an exact schema-sync baseline with no migration-owned destination rows"
            : "post-apply execution is authoritative",
        `${String(row?.destination_secret_rows ?? "missing")} destinations for ${String(
          row?.organization_rows ?? "missing",
        )} organizations`,
      ),
    ];
    return classifyVerification(true, [...catalogAndSecurityChecks, ...dataChecks], "0018");
  },
};
