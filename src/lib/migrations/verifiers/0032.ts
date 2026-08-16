import type { VerificationQuery } from "./types";
import {
  readCatalogSnapshot,
  verifyCatalog,
  type CatalogExpectation,
  type CatalogSnapshot,
  type ColumnExpectation,
  type PrivilegeExpectation,
} from "./catalog";
import { runtimeRoleNames, verifyExactPolicyIdentities, verifyMigrationSecurity } from "./security";
import {
  check,
  column,
  createdAt,
  exactTable as sharedExactTable,
  foreignKey,
  idColumn,
  index,
  primaryKey,
  schemaSynchronizedAbsence,
  trigger,
  updatedAt,
  verifyForeignKeyInvariants,
  type ForeignKeyInvariant,
} from "./expectations";
import {
  catalogHasPrivilegeFootprint,
  privilegesForExistingRuntimeRoles,
  requireNonGrantable,
  type PrivilegeFootprintScope,
} from "./acl-expectations";
import {
  functionContract,
  verifyFunctionContracts,
  type FunctionContract,
} from "./function-contracts";
import { classifyVerification, evidence, type MigrationVerifier } from "./types";

function exactTable(name: string, columns: readonly ColumnExpectation[], rls = false) {
  return sharedExactTable(name, columns, rls);
}

const reportingFunctions = [
  "current_organization_id()",
  "mark_organization_reporting_dirty(text, date)",
  "request_organization_reporting_full_rebuild(text)",
  "mark_organization_reporting_metadata_dirty(text)",
  "mark_reporting_from_changed_accounts()",
  "mark_reporting_from_inserted_accounts()",
  "mark_reporting_from_deleted_accounts()",
  "request_reporting_for_inserted_group_entities()",
  "request_reporting_for_restored_group_entities()",
  "mark_reporting_from_inserted_headers()",
  "mark_reporting_from_updated_headers()",
  "mark_reporting_from_deleted_headers()",
  "mark_reporting_from_inserted_lines()",
  "mark_reporting_from_updated_lines()",
  "mark_reporting_from_deleted_lines()",
] as const;

const reportingMigrationFunctions = reportingFunctions.filter(
  (identity) => identity !== "current_organization_id()",
);

const reportingTriggers = [
  "accounts.accounts_reporting_insert",
  "accounts.accounts_reporting_update",
  "accounts.accounts_reporting_delete",
  "organization_group_entities.organization_group_entities_reporting_insert",
  "organization_group_entities.organization_group_entities_reporting_update",
  "journal_headers.journal_headers_reporting_insert",
  "journal_headers.journal_headers_reporting_update",
  "journal_headers.journal_headers_reporting_delete",
  "journal_lines.journal_lines_reporting_insert",
  "journal_lines.journal_lines_reporting_update",
  "journal_lines.journal_lines_reporting_delete",
] as const;

const schema0032: CatalogExpectation = {
  relations: [
    exactTable("organization_reporting_accounts", [
      column("organization_id", "text", true),
      column("account_id", "uuid", true),
      column("account_name", "character varying(255)", true),
      column("account_number", "character varying(10)", false),
      column("account_type", "character varying(50)", true),
      column("subtype", "character varying(100)", false),
      column("parent_id", "uuid", false),
      column("synced_at", "timestamp with time zone", true, "now()"),
    ]),
    exactTable("organization_daily_account_activity", [
      column("organization_id", "text", true),
      column("activity_date", "date", true),
      column("account_id", "uuid", true),
      // pg_get_expr renders a numeric default as a typed literal, never as the
      // bare token the migration was written with, so "0" matched no database.
      column("total_debit", "numeric(20,8)", true, "'0'::numeric"),
      column("total_credit", "numeric(20,8)", true, "'0'::numeric"),
      column("computed_at", "timestamp with time zone", true, "now()"),
    ]),
    exactTable("organization_reporting_dirty_dates", [
      column("organization_id", "text", true),
      column("activity_date", "date", true),
      column("version", "integer", true),
      column("marked_at", "timestamp with time zone", true, "now()"),
    ]),
    exactTable("organization_reporting_projection_state", [
      column("organization_id", "text", true),
      column("status", "character varying(24)", true, "'pending'::character varying"),
      column("requested_version", "integer", true, "0"),
      column("applied_version", "integer", true, "0"),
      column("full_rebuild_requested", "boolean", true, "false"),
      column("last_ledger_event_at", "timestamp with time zone", false),
      column("last_projected_at", "timestamp with time zone", false),
      column("initial_backfill_completed_at", "timestamp with time zone", false),
      column("last_error", "text", false),
      column("updated_at", "timestamp with time zone", true, "now()"),
    ]),
  ],
  indexes: [
    index("organization_reporting_accounts_org_number_idx", "organization_reporting_accounts", [
      "organization_id",
      "account_number",
    ]),
    index(
      "organization_daily_account_activity_org_account_date_idx",
      "organization_daily_account_activity",
      ["organization_id", "account_id", "activity_date"],
    ),
    index("organization_reporting_dirty_dates_marked_idx", "organization_reporting_dirty_dates", [
      "marked_at",
    ]),
    index(
      "organization_reporting_projection_state_status_idx",
      "organization_reporting_projection_state",
      ["status", "updated_at"],
    ),
  ],
  constraints: [
    primaryKey("organization_reporting_accounts", ["organization_id", "account_id"]),
    primaryKey("organization_daily_account_activity", [
      "organization_id",
      "activity_date",
      "account_id",
    ]),
    primaryKey("organization_reporting_dirty_dates", ["organization_id", "activity_date"]),
    check(
      "organization_reporting_dirty_dates",
      "organization_reporting_dirty_dates_version_check",
      "CHECK ((version > 0))",
    ),
    primaryKey("organization_reporting_projection_state", ["organization_id"]),
    check(
      "organization_reporting_projection_state",
      "organization_reporting_projection_state_status_check",
      "CHECK (((status)::text = ANY ((ARRAY['pending'::character varying, 'building'::character varying, 'ready'::character varying, 'failed'::character varying])::text[])))",
    ),
    check(
      "organization_reporting_projection_state",
      "organization_reporting_projection_state_versions_check",
      "CHECK (((requested_version >= 0) AND (applied_version >= 0) AND (applied_version <= requested_version)))",
    ),
  ],
};

const foreignKeys0032: readonly ForeignKeyInvariant[] = [
  {
    key: "reporting-accounts-organization",
    tableName: "organization_reporting_accounts",
    columns: ["organization_id"],
    referencedTable: "auth_organizations",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
  {
    key: "reporting-accounts-account",
    tableName: "organization_reporting_accounts",
    columns: ["account_id"],
    referencedTable: "accounts",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
  {
    key: "daily-activity-organization",
    tableName: "organization_daily_account_activity",
    columns: ["organization_id"],
    referencedTable: "auth_organizations",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
  {
    key: "daily-activity-account",
    tableName: "organization_daily_account_activity",
    columns: ["account_id"],
    referencedTable: "accounts",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
  {
    key: "dirty-dates-organization",
    tableName: "organization_reporting_dirty_dates",
    columns: ["organization_id"],
    referencedTable: "auth_organizations",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
  {
    key: "projection-state-organization",
    tableName: "organization_reporting_projection_state",
    columns: ["organization_id"],
    referencedTable: "auth_organizations",
    referencedColumns: ["id"],
    onDelete: "cascade",
  },
];

const reportingFunctionContracts: readonly FunctionContract[] = [
  functionContract(
    "current_organization_id()",
    "bbd4ceb66a8d9631199f2ad8842cb645b585b868abee356397019707e9b64c4c",
    {
      resultType: "text",
      language: "sql",
      volatility: "stable",
      securityDefiner: false,
    },
  ),
  ...[
    [
      "mark_organization_reporting_dirty(text, date)",
      "void",
      "37fb7965819d6345dfb6c621adadf9ed653b01c62fa83ec5ae4c85ebc3350198",
    ],
    [
      "request_organization_reporting_full_rebuild(text)",
      "void",
      "3cefa016aa19ee6e35af9b12ca88c98254bbfe352c6b6fd4abd7f7b429049abb",
    ],
    [
      "mark_organization_reporting_metadata_dirty(text)",
      "void",
      "fb24ad19104fa30b28df331bac5240256bcd218acd2feaec41f3c55764e73530",
    ],
    [
      "mark_reporting_from_changed_accounts()",
      "trigger",
      "3813d516a71f2dfd193c3f1eeaa5dfe0485c255fcd1fece57103adc48c2c759d",
    ],
    [
      "mark_reporting_from_inserted_accounts()",
      "trigger",
      "3be5811fe4826207f80ae295c743456f224360c66ac2979d21753f6d3cef8bb0",
    ],
    [
      "mark_reporting_from_deleted_accounts()",
      "trigger",
      "2710c7c02237f50002fcee1ff0132fa737776b55b43ca86623666df48420917f",
    ],
    [
      "request_reporting_for_inserted_group_entities()",
      "trigger",
      "48b382ca1e78b6ee571852f40e94ad51a14d006232a3ba25939f1804ae305f3c",
    ],
    [
      "request_reporting_for_restored_group_entities()",
      "trigger",
      "05f10a02b78756148c5f6035674a83972dd255619645d5a89de4b0d6aedd5c71",
    ],
    [
      "mark_reporting_from_inserted_headers()",
      "trigger",
      "844384a22f6052dbad180e3d0d951b19aefa4d71e91830bd39eae1f9434bb508",
    ],
    [
      "mark_reporting_from_updated_headers()",
      "trigger",
      "8a7bdcf3268a08b5f03d3c0519ef6df86ac580a6c8526a388cdfc8c8021c0a08",
    ],
    [
      "mark_reporting_from_deleted_headers()",
      "trigger",
      "340307a10a19c2b182576656864ec42ef6a28b77ea1f3a3813b180f22e6132d1",
    ],
    [
      "mark_reporting_from_inserted_lines()",
      "trigger",
      "5d05ad20dc6a88d6972c00cc8e692e96384f5f1c5758245bd654eb64d8240cc9",
    ],
    [
      "mark_reporting_from_updated_lines()",
      "trigger",
      "9c010da30c1644d47cbd6bd1549f1f6ef6ba749943c2589754bbcf6cddc45908",
    ],
    [
      "mark_reporting_from_deleted_lines()",
      "trigger",
      "6d9118b256ffff6ef5b456d586b37deef7ed2dd7581c9f711f6be20dd2290b57",
    ],
  ].map(([identity, resultType, bodySha256]) =>
    functionContract(identity, bodySha256, {
      resultType,
      language: "plpgsql",
      volatility: "volatile",
      securityDefiner: true,
      searchPath: ["public", "pg_temp"],
    }),
  ),
];

const triggers0032 = [
  trigger(
    "accounts",
    "accounts_reporting_insert",
    "mark_reporting_from_inserted_accounts()",
    ["insert"],
    { newTable: "new_accounts" },
  ),
  trigger(
    "accounts",
    "accounts_reporting_update",
    "mark_reporting_from_changed_accounts()",
    ["update"],
    { oldTable: "old_accounts", newTable: "new_accounts" },
  ),
  trigger(
    "accounts",
    "accounts_reporting_delete",
    "mark_reporting_from_deleted_accounts()",
    ["delete"],
    { oldTable: "old_accounts" },
  ),
  trigger(
    "organization_group_entities",
    "organization_group_entities_reporting_insert",
    "request_reporting_for_inserted_group_entities()",
    ["insert"],
    { newTable: "new_group_entities" },
  ),
  trigger(
    "organization_group_entities",
    "organization_group_entities_reporting_update",
    "request_reporting_for_restored_group_entities()",
    ["update"],
    { oldTable: "old_group_entities", newTable: "new_group_entities" },
  ),
  trigger(
    "journal_headers",
    "journal_headers_reporting_insert",
    "mark_reporting_from_inserted_headers()",
    ["insert"],
    { newTable: "new_headers" },
  ),
  trigger(
    "journal_headers",
    "journal_headers_reporting_update",
    "mark_reporting_from_updated_headers()",
    ["update"],
    { oldTable: "old_headers", newTable: "new_headers" },
  ),
  trigger(
    "journal_headers",
    "journal_headers_reporting_delete",
    "mark_reporting_from_deleted_headers()",
    ["delete"],
    { oldTable: "old_headers" },
  ),
  trigger(
    "journal_lines",
    "journal_lines_reporting_insert",
    "mark_reporting_from_inserted_lines()",
    ["insert"],
    { newTable: "new_lines" },
  ),
  trigger(
    "journal_lines",
    "journal_lines_reporting_update",
    "mark_reporting_from_updated_lines()",
    ["update"],
    { oldTable: "old_lines", newTable: "new_lines" },
  ),
  trigger(
    "journal_lines",
    "journal_lines_reporting_delete",
    "mark_reporting_from_deleted_lines()",
    ["delete"],
    { oldTable: "old_lines" },
  ),
] as const;

const policies0032 = [
  "organization_reporting_accounts.organization_reporting_accounts_select",
  "organization_reporting_accounts.organization_reporting_accounts_worker_write",
  "organization_daily_account_activity.organization_daily_account_activity_select",
  "organization_daily_account_activity.organization_daily_account_activity_worker_write",
  "organization_reporting_dirty_dates.organization_reporting_dirty_dates_select",
  "organization_reporting_dirty_dates.organization_reporting_dirty_dates_worker_write",
  "organization_reporting_projection_state.organization_reporting_projection_state_select",
  "organization_reporting_projection_state.organization_reporting_projection_state_worker_write",
] as const;

const reportingTables = [
  "organization_reporting_accounts",
  "organization_daily_account_activity",
  "organization_reporting_dirty_dates",
  "organization_reporting_projection_state",
] as const;

const managedRelations0032 = [
  ...reportingTables,
  "accounts",
  "organization_group_entities",
  "journal_headers",
  "journal_lines",
] as const;

const reportingAclFunctions = [
  "mark_organization_reporting_dirty(text, date)",
  "request_organization_reporting_full_rebuild(text)",
  "mark_organization_reporting_metadata_dirty(text)",
] as const;

const privilegeFootprintScopes0032: readonly PrivilegeFootprintScope[] = [
  {
    objectType: "table",
    objectIdentities: reportingTables,
    grantees: ["PUBLIC", ...runtimeRoleNames],
    privileges: ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"],
  },
  {
    objectType: "function",
    objectIdentities: reportingAclFunctions,
    grantees: ["PUBLIC"],
    privileges: ["EXECUTE"],
  },
];

const policyExpectations0032 = reportingTables.flatMap((tableName) => [
  {
    tableName,
    name: `${tableName}_select`,
    permissive: true,
    roles: ["public"],
    command: "select",
    using: `EXISTS (SELECT 1 FROM auth_members membership WHERE membership.organization_id = ${tableName}.organization_id AND membership.user_id = current_user_id()) OR organization_id = current_organization_id()`,
    withCheck: null,
  },
  {
    tableName,
    name: `${tableName}_worker_write`,
    permissive: true,
    roles: ["public"],
    command: "all",
    using: "organization_id = current_organization_id()",
    withCheck: "organization_id = current_organization_id()",
  },
]);

function privileges0032(snapshot: CatalogSnapshot): PrivilegeExpectation[] {
  return requireNonGrantable([
    ...privilegesForExistingRuntimeRoles(snapshot, (grantee) =>
      reportingTables.flatMap((objectIdentity) => [
        ...["SELECT", "INSERT", "UPDATE", "DELETE"].map((privilege) => ({
          objectType: "table" as const,
          objectIdentity,
          grantee,
          privilege,
        })),
        {
          objectType: "table" as const,
          objectIdentity,
          grantee,
          privilege: "TRUNCATE",
          present: false,
        },
      ]),
    ),
    ...reportingTables.flatMap((objectIdentity) =>
      ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE"].map((privilege) => ({
        objectType: "table" as const,
        objectIdentity,
        grantee: "PUBLIC",
        privilege,
        present: false,
      })),
    ),
    ...reportingAclFunctions.map((objectIdentity) => ({
      objectType: "function" as const,
      objectIdentity,
      grantee: "PUBLIC",
      privilege: "EXECUTE",
      present: false,
    })),
  ]);
}

async function verifyReportingSeed(query: VerificationQuery) {
  const [row] = await query.unsafe<{
    missing_projection_states: number;
    non_pending_projection_states: number;
    non_advanced_projection_versions: number;
    missing_full_rebuild_requests: number;
    invalid_refresh_jobs: number;
  }>(`
    WITH enabled_organizations AS (
      SELECT DISTINCT entity.organization_id
      FROM organization_group_entities AS entity
      WHERE entity.status = 'enabled'
    )
    SELECT
      count(*) FILTER (
        WHERE projection.organization_id IS NULL
      )::integer AS missing_projection_states,
      count(*) FILTER (
        WHERE projection.organization_id IS NOT NULL
          AND projection.status IS DISTINCT FROM 'pending'
      )::integer AS non_pending_projection_states,
      count(*) FILTER (
        WHERE projection.organization_id IS NOT NULL
          AND projection.requested_version <= projection.applied_version
      )::integer AS non_advanced_projection_versions,
      count(*) FILTER (
        WHERE projection.organization_id IS NOT NULL
          AND projection.full_rebuild_requested IS DISTINCT FROM true
      )::integer AS missing_full_rebuild_requests,
      (
        SELECT count(*)::integer
        FROM enabled_organizations AS enabled
        WHERE (
          SELECT count(*)
          FROM processing_jobs AS job
          WHERE job.organization_id = enabled.organization_id
            AND job.status IN ('queued', 'running')
            AND (
              job.job_type = 'business_group_projection_refresh'
              OR job.dedupe_key = 'business_group_projection_refresh'
            )
        ) <> 1
        OR NOT EXISTS (
          SELECT 1
          FROM processing_jobs AS job
          WHERE job.organization_id = enabled.organization_id
            AND job.status IN ('queued', 'running')
            AND job.job_type = 'business_group_projection_refresh'
            AND job.dedupe_key = 'business_group_projection_refresh'
            AND job.max_attempts = 8
            AND job.payload = '{}'::jsonb
        )
      ) AS invalid_refresh_jobs
    FROM enabled_organizations AS enabled
    LEFT JOIN organization_reporting_projection_state AS projection
      ON projection.organization_id = enabled.organization_id
  `);
  return [
    evidence(
      "0032:enabled-organizations-have-projection-state",
      row?.missing_projection_states === 0,
      "0 missing projection states",
      String(row?.missing_projection_states ?? "missing"),
    ),
    evidence(
      "0032:pending-projection-state",
      row?.non_pending_projection_states === 0,
      "every enabled organization projection pending",
      String(row?.non_pending_projection_states ?? "missing"),
    ),
    evidence(
      "0032:advanced-projection-version",
      row?.non_advanced_projection_versions === 0,
      "every requested version ahead of its applied version",
      String(row?.non_advanced_projection_versions ?? "missing"),
    ),
    evidence(
      "0032:full-rebuild-requested",
      row?.missing_full_rebuild_requests === 0,
      "every enabled organization requests a full rebuild",
      String(row?.missing_full_rebuild_requests ?? "missing"),
    ),
    evidence(
      "0032:deduplicated-refresh-job",
      row?.invalid_refresh_jobs === 0,
      "one correctly deduplicated active projection refresh job per enabled organization",
      String(row?.invalid_refresh_jobs ?? "missing"),
    ),
  ];
}

interface ReportingLifecycleRow {
  organization_id: string;
  status: string | null;
  requested_version: number | null;
  applied_version: number | null;
  full_rebuild_requested: boolean | null;
  initial_backfill_completed_at: Date | null;
  last_error: string | null;
  valid_active_refresh_jobs: number;
  invalid_active_refresh_jobs: number;
}

async function verifyReportingLifecycle(query: VerificationQuery) {
  const rows = await query.unsafe<ReportingLifecycleRow>(`
    WITH enabled_organizations AS (
      SELECT DISTINCT entity.organization_id
      FROM organization_group_entities AS entity
      WHERE entity.status = 'enabled'
    )
    SELECT
      enabled.organization_id,
      projection.status,
      projection.requested_version,
      projection.applied_version,
      projection.full_rebuild_requested,
      projection.initial_backfill_completed_at,
      projection.last_error,
      COALESCE(jobs.valid_active_refresh_jobs, 0)::integer AS valid_active_refresh_jobs,
      COALESCE(jobs.invalid_active_refresh_jobs, 0)::integer AS invalid_active_refresh_jobs
    FROM enabled_organizations AS enabled
    LEFT JOIN organization_reporting_projection_state AS projection
      ON projection.organization_id = enabled.organization_id
    LEFT JOIN LATERAL (
      SELECT
        count(*) FILTER (
          WHERE job.job_type = 'business_group_projection_refresh'
            AND job.dedupe_key = 'business_group_projection_refresh'
            AND job.max_attempts = 8
            AND job.payload = '{}'::jsonb
        )::integer AS valid_active_refresh_jobs,
        count(*) FILTER (
          WHERE NOT (
            job.job_type = 'business_group_projection_refresh'
            AND job.dedupe_key = 'business_group_projection_refresh'
            AND job.max_attempts = 8
            AND job.payload = '{}'::jsonb
          )
        )::integer AS invalid_active_refresh_jobs
      FROM processing_jobs AS job
      WHERE job.organization_id = enabled.organization_id
        AND job.status IN ('queued', 'running')
        AND (
          job.job_type = 'business_group_projection_refresh'
          OR job.dedupe_key = 'business_group_projection_refresh'
        )
    ) AS jobs ON true
  `);

  let missingProjectionStates = 0;
  let invalidLifecycleStates = 0;
  let invalidRefreshJobs = 0;
  for (const row of rows) {
    if (
      row.status === null ||
      row.requested_version === null ||
      row.applied_version === null ||
      row.full_rebuild_requested === null
    ) {
      missingProjectionStates += 1;
      continue;
    }

    const ready =
      row.status === "ready" &&
      row.requested_version === row.applied_version &&
      row.full_rebuild_requested === false &&
      row.initial_backfill_completed_at !== null &&
      row.last_error === null;
    const inProgress =
      (row.status === "pending" || row.status === "building") &&
      row.requested_version > row.applied_version &&
      row.last_error === null;
    const retrying =
      row.status === "failed" &&
      row.requested_version > row.applied_version &&
      row.last_error !== null;
    if (!ready && !inProgress && !retrying) invalidLifecycleStates += 1;

    const expectedActiveJobs = ready ? 0 : 1;
    if (
      row.valid_active_refresh_jobs !== expectedActiveJobs ||
      row.invalid_active_refresh_jobs !== 0
    ) {
      invalidRefreshJobs += 1;
    }
  }

  return [
    evidence(
      "0032:enabled-organizations-have-projection-state",
      missingProjectionStates === 0,
      "0 missing projection states",
      String(missingProjectionStates),
    ),
    evidence(
      "0032:durable-projection-lifecycle",
      invalidLifecycleStates === 0,
      "every projection is pending, building, retrying, or durably ready",
      `${invalidLifecycleStates} invalid states`,
    ),
    evidence(
      "0032:durable-refresh-job-lifecycle",
      invalidRefreshJobs === 0,
      "one exact active refresh job while work remains and none when ready",
      `${invalidRefreshJobs} invalid job states`,
    ),
  ];
}

export const verifier0032: MigrationVerifier = {
  id: "0032",
  async verify(query, context) {
    const snapshot = await readCatalogSnapshot(query);
    const footprint =
      reportingMigrationFunctions.some((identity) => snapshot.functions.has(identity)) ||
      reportingTriggers.some((trigger) => snapshot.triggers.has(trigger)) ||
      policies0032.some((policy) => snapshot.policies.has(policy)) ||
      catalogHasPrivilegeFootprint(snapshot, privilegeFootprintScopes0032);
    const foreignKeyChecks = verifyForeignKeyInvariants(snapshot, foreignKeys0032);
    if (!footprint) {
      return schemaSynchronizedAbsence(snapshot, schema0032, context, foreignKeyChecks);
    }

    const securityChecks = await verifyMigrationSecurity(
      query,
      snapshot,
      managedRelations0032,
      reportingFunctionContracts,
    );
    const backfillChecks =
      context.mode === "post_apply"
        ? await verifyReportingSeed(query)
        : await verifyReportingLifecycle(query);

    return classifyVerification(
      footprint,
      [
        ...verifyCatalog(snapshot, {
          ...schema0032,
          relations: schema0032.relations?.map((relation) => ({
            ...relation,
            rls: true,
          })),
          functions: reportingFunctionContracts.map(
            ({ bodySha256: _bodySha256, ...contract }) => contract,
          ),
          triggers: triggers0032,
          policies: policyExpectations0032,
          privileges: privileges0032(snapshot),
        }),
        ...verifyFunctionContracts(snapshot, reportingFunctionContracts),
        ...verifyExactPolicyIdentities(snapshot, "0032", reportingTables, policyExpectations0032),
        ...securityChecks,
        ...foreignKeyChecks,
        ...backfillChecks,
      ],
      "reporting-projections",
    );
  },
};
