import postgres, { type Row } from "postgres";

interface CliOptions {
  mode: "status" | "dry-run" | "apply";
  organizationId: string | null;
  groupId: string | null;
  enterpriseAccountId: string | null;
  all: boolean;
}

function usage(): string {
  return `Business Group reporting projection operations

Usage:
  bun run business-groups:projection --status [scope]
  bun run business-groups:projection [scope]
  bun run business-groups:projection --apply [scope]

Scope (choose at most one; --apply requires exactly one):
  --organization-id=<id>       One linked organization.
  --group-id=<uuid>            Every enabled business in one group.
  --enterprise-account-id=<uuid>
                                Every enabled business in one Enterprise account.
  --all                         Every enabled Business Group organization.

Modes:
  --status                     Read projection state and active jobs; no writes.
  --apply                      Request a full replay/backfill and enqueue jobs.
  no mode flag                 Preview the selected targets; no writes.
  --help                       Show this help.

DATABASE_URL_ADMIN is required. Read-only modes do not write, but they still
need an operator connection that can inspect projection state across tenants.
`;
}

function valueAfter(argv: string[], index: number, flag: string): [string, number] {
  const value = argv[index + 1]?.trim();
  if (!value) throw new Error(`${flag} requires a value.`);
  return [value, index + 1];
}

function parseOptions(argv: string[]): CliOptions {
  let mode: CliOptions["mode"] = "dry-run";
  let organizationId: string | null = null;
  let groupId: string | null = null;
  let enterpriseAccountId: string | null = null;
  let all = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--status") {
      if (mode === "apply") throw new Error("--status and --apply cannot be combined.");
      mode = "status";
      continue;
    }
    if (argument === "--apply") {
      if (mode === "status") throw new Error("--status and --apply cannot be combined.");
      mode = "apply";
      continue;
    }
    if (argument === "--all") {
      all = true;
      continue;
    }
    if (argument === "--organization-id") {
      [organizationId, index] = valueAfter(argv, index, argument);
      continue;
    }
    if (argument.startsWith("--organization-id=")) {
      organizationId = argument.slice("--organization-id=".length).trim() || null;
      continue;
    }
    if (argument === "--group-id") {
      [groupId, index] = valueAfter(argv, index, argument);
      continue;
    }
    if (argument.startsWith("--group-id=")) {
      groupId = argument.slice("--group-id=".length).trim() || null;
      continue;
    }
    if (argument === "--enterprise-account-id") {
      [enterpriseAccountId, index] = valueAfter(argv, index, argument);
      continue;
    }
    if (argument.startsWith("--enterprise-account-id=")) {
      enterpriseAccountId = argument.slice("--enterprise-account-id=".length).trim() || null;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  const scopeCount = [organizationId, groupId, enterpriseAccountId, all].filter(Boolean).length;
  if (scopeCount > 1) throw new Error("Choose only one projection scope.");
  if (mode === "apply" && scopeCount !== 1) {
    throw new Error("--apply requires one explicit scope, including --all for a global replay.");
  }
  return { mode, organizationId, groupId, enterpriseAccountId, all };
}

function scopeLabel(options: CliOptions): string {
  if (options.organizationId) return `organization ${options.organizationId}`;
  if (options.groupId) return `group ${options.groupId}`;
  if (options.enterpriseAccountId) return `Enterprise account ${options.enterpriseAccountId}`;
  return options.all ? "all linked organizations" : "all enabled linked organizations";
}

async function selectTargets(client: postgres.Sql, options: CliOptions): Promise<Row[]> {
  return client`
    SELECT
      entity.organization_id,
      organization.name AS organization_name,
      count(DISTINCT entity.group_id)::integer AS group_count,
      state.status,
      state.requested_version,
      state.applied_version,
      state.full_rebuild_requested,
      state.last_ledger_event_at,
      state.last_projected_at,
      state.initial_backfill_completed_at,
      state.last_error,
      count(DISTINCT job.id) FILTER (WHERE job.status IN ('queued', 'running'))::integer AS active_jobs
    FROM organization_group_entities entity
    JOIN auth_organizations organization ON organization.id = entity.organization_id
    JOIN organization_groups group_record ON group_record.id = entity.group_id
    LEFT JOIN organization_reporting_projection_state state
      ON state.organization_id = entity.organization_id
    LEFT JOIN processing_jobs job
      ON job.organization_id = entity.organization_id
     AND job.job_type = 'business_group_projection_refresh'
    WHERE entity.status = 'enabled'
      AND (${options.organizationId}::text IS NULL OR entity.organization_id = ${options.organizationId})
      AND (${options.groupId}::uuid IS NULL OR entity.group_id = ${options.groupId})
      AND (${options.enterpriseAccountId}::uuid IS NULL OR group_record.enterprise_account_id = ${options.enterpriseAccountId})
    GROUP BY entity.organization_id, organization.name, state.organization_id
    ORDER BY organization.name, entity.organization_id
  `;
}

function printRows(rows: Row[], options: CliOptions): void {
  console.log(`Scope: ${scopeLabel(options)}`);
  console.log(`Mode: ${options.mode === "apply" ? "APPLY FULL REPLAY" : "READ ONLY"}`);
  console.log(`Targets: ${rows.length}\n`);
  if (rows.length === 0) {
    console.log("No enabled linked organizations matched this scope.");
    return;
  }
  console.table(
    rows.map((row) => ({
      organizationId: row.organization_id,
      organization: row.organization_name,
      groups: row.group_count,
      status: row.status ?? "missing",
      version: `${row.applied_version ?? 0}/${row.requested_version ?? 0}`,
      fullReplay: row.full_rebuild_requested ?? false,
      activeJobs: row.active_jobs,
      projectedAt: row.last_projected_at ?? "never",
      error: row.last_error ?? "",
    })),
  );
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const connectionString = process.env.DATABASE_URL_ADMIN;
  if (!connectionString) {
    throw new Error("DATABASE_URL_ADMIN is required for projection operations.");
  }

  const client = postgres(connectionString, { max: 1, prepare: false });
  try {
    const [target] = await client`
      SELECT
        current_database() AS database,
        current_user AS username,
        coalesce(inet_server_addr()::text, 'local socket') AS host
    `;
    console.log(`Target: ${target.database} as ${target.username} (${target.host})\n`);

    const targets = await selectTargets(client, options);
    printRows(targets, options);
    if (options.mode !== "apply" || targets.length === 0) {
      if (options.mode === "dry-run" && targets.length > 0) {
        console.log("\nNo data was changed. Re-run with --apply to request these full replays.");
      } else if (options.mode === "status") {
        console.log("\nStatus check complete; nothing was written.");
      }
      return;
    }

    const organizationIds = targets.map((row) => String(row.organization_id));
    await client.begin(async (transaction) => {
      await transaction`
        SELECT pg_advisory_xact_lock(hashtextextended('buwiz:business-group-projection-replay', 0))
      `;
      for (const organizationId of organizationIds) {
        await transaction`SELECT request_organization_reporting_full_rebuild(${organizationId})`;
      }
    });
    console.log(
      `\nRequested ${organizationIds.length} full projection replay(s). The durable worker queue will process them in bounded batches.`,
    );
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
