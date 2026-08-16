import postgres from "postgres";

interface CliOptions {
  organizationId: string | null;
  json: boolean;
}

interface OrganizationIdentity {
  organizationId: string;
  organizationName: string;
}

interface ReplayMetrics {
  total: number;
  requestIdempotency: number;
  providerIdentity: number;
  unknown: number;
}

interface DocumentReuseMetrics {
  canonicalDocumentsWithEvidence: number;
  reusedCanonicalDocuments: number;
  evidenceLinks: number;
  additionalEvidenceLinks: number;
}

interface CaseBreakdown {
  matchClass: string;
  disposition: string;
  count: number;
}

interface SignalCombination {
  matchClass: string;
  disposition: string;
  signals: string;
  count: number;
}

interface ResolutionMetrics {
  confirmed: number;
  consolidated: number;
  attached: number;
  mergedPosted: number;
  keptSeparate: number;
  rejected: number;
  precisionProxy: number | null;
}

interface UnresolvedMetrics {
  total: number;
  blocking: number;
  shadow: number;
  oldestCreatedAt: string | null;
  oldestAgeSeconds: number | null;
}

interface MergeMetrics {
  active: number;
  reversed: number;
  quarantined: number;
}

interface MatcherLatencyMetrics {
  sampleCount: number;
  averageMs: number | null;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
}

interface OrganizationHealth {
  organizationId: string;
  organizationName: string;
  exactReplaysSuppressed: ReplayMetrics;
  documentReuse: DocumentReuseMetrics;
  duplicateCases: {
    total: number;
    byDisposition: CaseBreakdown[];
    bySignalCombination: SignalCombination[];
  };
  resolutions: ResolutionMetrics;
  unresolved: UnresolvedMetrics;
  merges: MergeMetrics;
  matcherLatency: MatcherLatencyMetrics;
}

const LIMITATIONS = [
  "Metrics are cumulative for the retained database history; this command does not reset counters.",
  "Exact replay events are recorded from this instrumentation onward and are idempotent per logical request or provider version, so they count protected logical artifacts rather than every retry attempt.",
  "Historical document reuse is inferred when one canonical document is linked to more than one unique evidence entity. Upload attempts that reused bytes before instrumentation cannot be reconstructed.",
  "The precision proxy is confirmed duplicate resolutions divided by confirmed plus keep-separate resolutions. Rejected and unresolved cases are excluded, so this is a rollout signal rather than statistically validated precision.",
  "Matcher latency is available only for duplicate_matcher_run workflow events and is sampled once per source input hash and matcher version.",
  "Failed merge and unmerge attempts roll back without a durable event, so this report cannot count failures until a separate out-of-transaction telemetry sink is introduced.",
] as const;

function usage(): string {
  return `Transaction deduplication health report (read-only)

Usage:
  bun run dedup:health [--org=<organization-id>] [--json]

Options:
  --org    Limit the report to one organization.
  --json   Emit machine-readable JSON.
  --help   Show this help.

The report is cumulative and always executes inside a read-only transaction.
`;
}

function parseOptions(argv: string[]): CliOptions {
  let organizationId: string | null = null;
  let json = false;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--org") {
      organizationId = argv[index + 1]?.trim() || null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--org=")) {
      organizationId = argument.slice("--org=".length).trim() || null;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  return { organizationId, json };
}

function numeric(value: unknown): number {
  if (typeof value === "number") return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function nullableNumeric(value: unknown): number | null {
  return value === null || value === undefined ? null : numeric(value);
}

function timestamp(value: unknown): string | null {
  if (value instanceof Date) return value.toISOString();
  return typeof value === "string" ? value : null;
}

function emptyReplayMetrics(): ReplayMetrics {
  return { total: 0, requestIdempotency: 0, providerIdentity: 0, unknown: 0 };
}

function emptyDocumentReuseMetrics(): DocumentReuseMetrics {
  return {
    canonicalDocumentsWithEvidence: 0,
    reusedCanonicalDocuments: 0,
    evidenceLinks: 0,
    additionalEvidenceLinks: 0,
  };
}

function emptyResolutionMetrics(): ResolutionMetrics {
  return {
    confirmed: 0,
    consolidated: 0,
    attached: 0,
    mergedPosted: 0,
    keptSeparate: 0,
    rejected: 0,
    precisionProxy: null,
  };
}

function precisionProxy(confirmed: number, keptSeparate: number): number | null {
  const reviewed = confirmed + keptSeparate;
  return reviewed === 0 ? null : Math.round((confirmed / reviewed) * 10_000) / 100;
}

function emptyUnresolvedMetrics(): UnresolvedMetrics {
  return {
    total: 0,
    blocking: 0,
    shadow: 0,
    oldestCreatedAt: null,
    oldestAgeSeconds: null,
  };
}

function emptyMergeMetrics(): MergeMetrics {
  return { active: 0, reversed: 0, quarantined: 0 };
}

function emptyMatcherLatencyMetrics(): MatcherLatencyMetrics {
  return { sampleCount: 0, averageMs: null, p50Ms: null, p95Ms: null, maxMs: null };
}

function makeHealth(identity: OrganizationIdentity): OrganizationHealth {
  return {
    ...identity,
    exactReplaysSuppressed: emptyReplayMetrics(),
    documentReuse: emptyDocumentReuseMetrics(),
    duplicateCases: {
      total: 0,
      byDisposition: [],
      bySignalCombination: [],
    },
    resolutions: emptyResolutionMetrics(),
    unresolved: emptyUnresolvedMetrics(),
    merges: emptyMergeMetrics(),
    matcherLatency: emptyMatcherLatencyMetrics(),
  };
}

function signalCombinationExpression(): string {
  return `
    COALESCE(
      NULLIF(
        concat_ws(
          '+',
          CASE WHEN signals->>'identicalDocument' = 'true' THEN 'identical_document' END,
          CASE WHEN signals->>'exactReference' = 'true' THEN 'exact_reference' END,
          CASE WHEN signals->>'exactParty' = 'true' THEN 'exact_party' END,
          CASE WHEN signals->>'exactSourceAccount' = 'true' THEN 'exact_source_account' END,
          CASE
            WHEN COALESCE(signals->>'dateScore', '0') NOT IN ('0', '0.0', '0.00')
              THEN 'date'
          END,
          CASE
            WHEN COALESCE(signals->>'descriptionScore', '0') NOT IN ('0', '0.0', '0.00')
              THEN 'description'
          END,
          CASE WHEN signals->>'amountsEqual' = 'true' THEN 'amount' END,
          CASE WHEN signals->>'currenciesEqual' = 'true' THEN 'currency' END,
          CASE WHEN signals->>'amountDifferenceIsSlight' = 'true' THEN 'slight_amount' END
        ),
        ''
      ),
      'none'
    )
  `;
}

async function verifySchema(client: postgres.Sql): Promise<void> {
  const [row] = await client<
    {
      missing_tables: string[] | null;
    }[]
  >`
    WITH required(table_name) AS (
      VALUES
        ('workflow_events'),
        ('source_record_documents'),
        ('document_attachments'),
        ('source_match_candidates'),
        ('journal_duplicate_merges')
    )
    SELECT array_agg(table_name ORDER BY table_name) FILTER (
      WHERE to_regclass('public.' || table_name) IS NULL
    ) AS missing_tables
    FROM required
  `;
  const missing = row?.missing_tables ?? [];
  if (missing.length > 0) {
    throw new Error(
      `Deduplication schema is incomplete. Missing: ${missing.join(", ")}. Apply migrations 0019 through 0024 first.`,
    );
  }
}

async function collectHealth(
  client: postgres.Sql,
  options: CliOptions,
): Promise<{
  organizations: OrganizationHealth[];
  totalLatency: MatcherLatencyMetrics;
}> {
  return client.begin("read only", async (tx) => {
    const query = tx as unknown as typeof client;
    await verifySchema(query);

    const organizations = await query`
      SELECT id AS organization_id, name AS organization_name
      FROM auth_organizations
      WHERE ${options.organizationId}::text IS NULL OR id = ${options.organizationId}
      ORDER BY name, id
    `;
    if (options.organizationId && organizations.length === 0) {
      throw new Error(`Organization not found: ${options.organizationId}`);
    }

    const signalCombinationSql = signalCombinationExpression();
    const [
      replayRows,
      documentRows,
      caseRows,
      signalRows,
      resolutionRows,
      unresolvedRows,
      mergeRows,
      latencyRows,
      totalLatencyRows,
    ] = await Promise.all([
      query`
        SELECT
          organization_id,
          COALESCE(
            data->>'replayType',
            CASE
              WHEN entity_type = 'source_record' AND data ? 'provider' THEN 'provider_identity'
              WHEN entity_type = 'transaction_candidate' THEN 'request_idempotency'
              ELSE 'unknown'
            END
          ) AS replay_type,
          count(*)::integer AS replay_count
        FROM workflow_events
        WHERE
          action = 'exact_replay_suppressed'
          AND (${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId})
        GROUP BY
          organization_id,
          COALESCE(
            data->>'replayType',
            CASE
              WHEN entity_type = 'source_record' AND data ? 'provider' THEN 'provider_identity'
              WHEN entity_type = 'transaction_candidate' THEN 'request_idempotency'
              ELSE 'unknown'
            END
          )
      `,
      query`
        WITH evidence_links AS (
          SELECT
            organization_id,
            document_id,
            'source_record:' || source_record_id::text AS entity_key
          FROM source_record_documents

          UNION

          SELECT
            organization_id,
            document_id,
            'attachment:' || linkable_type || ':' || linkable_id::text AS entity_key
          FROM document_attachments
        ),
        document_link_counts AS (
          SELECT
            organization_id,
            document_id,
            count(DISTINCT entity_key)::integer AS link_count
          FROM evidence_links
          WHERE ${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId}
          GROUP BY organization_id, document_id
        )
        SELECT
          organization_id,
          count(*)::integer AS canonical_documents_with_evidence,
          count(*) FILTER (WHERE link_count > 1)::integer AS reused_canonical_documents,
          COALESCE(sum(link_count), 0)::integer AS evidence_links,
          COALESCE(sum(greatest(link_count - 1, 0)), 0)::integer AS additional_evidence_links
        FROM document_link_counts
        GROUP BY organization_id
      `,
      query`
        SELECT
          organization_id,
          match_class,
          disposition,
          count(*)::integer AS case_count
        FROM source_match_candidates
        WHERE ${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId}
        GROUP BY organization_id, match_class, disposition
        ORDER BY organization_id, match_class, disposition
      `,
      query.unsafe(
        `
          SELECT
            organization_id,
            match_class,
            disposition,
            ${signalCombinationSql} AS signal_combination,
            count(*)::integer AS case_count
          FROM source_match_candidates
          WHERE $1::text IS NULL OR organization_id = $1
          GROUP BY organization_id, match_class, disposition, ${signalCombinationSql}
          ORDER BY organization_id, case_count DESC, match_class, disposition, signal_combination
        `,
        [options.organizationId],
      ),
      query`
        SELECT
          organization_id,
          count(*) FILTER (
            WHERE resolution_action IN (
              'consolidate_candidates',
              'attach_to_posted',
              'merge_posted'
            )
          )::integer AS confirmed,
          count(*) FILTER (
            WHERE resolution_action = 'consolidate_candidates'
          )::integer AS consolidated,
          count(*) FILTER (
            WHERE resolution_action = 'attach_to_posted'
          )::integer AS attached,
          count(*) FILTER (
            WHERE resolution_action = 'merge_posted'
          )::integer AS merged_posted,
          count(*) FILTER (
            WHERE resolution_action = 'keep_separate'
          )::integer AS kept_separate,
          count(*) FILTER (
            WHERE resolution_action = 'reject_source'
          )::integer AS rejected
        FROM source_match_candidates
        WHERE ${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId}
        GROUP BY organization_id
      `,
      query`
        SELECT
          organization_id,
          count(*)::integer AS unresolved_count,
          count(*) FILTER (WHERE disposition = 'blocking')::integer AS blocking_count,
          count(*) FILTER (WHERE disposition = 'shadow')::integer AS shadow_count,
          min(created_at) AS oldest_created_at,
          extract(epoch FROM (clock_timestamp() - min(created_at)))::bigint AS oldest_age_seconds
        FROM source_match_candidates
        WHERE
          state = 'open'
          AND match_class = 'duplicate'
          AND (${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId})
        GROUP BY organization_id
      `,
      query`
        SELECT
          organization_id,
          count(*) FILTER (WHERE state = 'active')::integer AS active_count,
          count(*) FILTER (WHERE state = 'reversed')::integer AS reversed_count,
          count(*) FILTER (WHERE state = 'quarantined')::integer AS quarantined_count
        FROM journal_duplicate_merges
        WHERE ${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId}
        GROUP BY organization_id
      `,
      query`
        WITH samples AS (
          SELECT
            organization_id,
            (data->>'durationMs')::double precision AS duration_ms
          FROM workflow_events
          WHERE
            action = 'duplicate_matcher_run'
            AND jsonb_typeof(data->'durationMs') = 'number'
            AND (${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId})
        )
        SELECT
          organization_id,
          count(*)::integer AS sample_count,
          round(avg(duration_ms)::numeric, 2)::double precision AS average_ms,
          round(
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::numeric,
            2
          )::double precision AS p50_ms,
          round(
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric,
            2
          )::double precision AS p95_ms,
          round(max(duration_ms)::numeric, 2)::double precision AS max_ms
        FROM samples
        GROUP BY organization_id
      `,
      query`
        WITH samples AS (
          SELECT (data->>'durationMs')::double precision AS duration_ms
          FROM workflow_events
          WHERE
            action = 'duplicate_matcher_run'
            AND jsonb_typeof(data->'durationMs') = 'number'
            AND (${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId})
        )
        SELECT
          count(*)::integer AS sample_count,
          round(avg(duration_ms)::numeric, 2)::double precision AS average_ms,
          round(
            percentile_cont(0.5) WITHIN GROUP (ORDER BY duration_ms)::numeric,
            2
          )::double precision AS p50_ms,
          round(
            percentile_cont(0.95) WITHIN GROUP (ORDER BY duration_ms)::numeric,
            2
          )::double precision AS p95_ms,
          round(max(duration_ms)::numeric, 2)::double precision AS max_ms
        FROM samples
      `,
    ]);

    const healthByOrganization = new Map<string, OrganizationHealth>(
      organizations.map((row) => {
        const identity = {
          organizationId: String(row.organization_id),
          organizationName: String(row.organization_name),
        };
        return [identity.organizationId, makeHealth(identity)];
      }),
    );

    for (const row of replayRows) {
      const health = healthByOrganization.get(String(row.organization_id));
      if (!health) continue;
      const count = numeric(row.replay_count);
      health.exactReplaysSuppressed.total += count;
      if (row.replay_type === "request_idempotency") {
        health.exactReplaysSuppressed.requestIdempotency += count;
      } else if (row.replay_type === "provider_identity") {
        health.exactReplaysSuppressed.providerIdentity += count;
      } else {
        health.exactReplaysSuppressed.unknown += count;
      }
    }

    for (const row of documentRows) {
      const health = healthByOrganization.get(String(row.organization_id));
      if (!health) continue;
      health.documentReuse = {
        canonicalDocumentsWithEvidence: numeric(row.canonical_documents_with_evidence),
        reusedCanonicalDocuments: numeric(row.reused_canonical_documents),
        evidenceLinks: numeric(row.evidence_links),
        additionalEvidenceLinks: numeric(row.additional_evidence_links),
      };
    }

    for (const row of caseRows) {
      const health = healthByOrganization.get(String(row.organization_id));
      if (!health) continue;
      const breakdown = {
        matchClass: String(row.match_class),
        disposition: String(row.disposition),
        count: numeric(row.case_count),
      };
      health.duplicateCases.total += breakdown.count;
      health.duplicateCases.byDisposition.push(breakdown);
    }

    for (const row of signalRows) {
      const health = healthByOrganization.get(String(row.organization_id));
      if (!health) continue;
      health.duplicateCases.bySignalCombination.push({
        matchClass: String(row.match_class),
        disposition: String(row.disposition),
        signals: String(row.signal_combination),
        count: numeric(row.case_count),
      });
    }

    for (const row of resolutionRows) {
      const health = healthByOrganization.get(String(row.organization_id));
      if (!health) continue;
      const confirmed = numeric(row.confirmed);
      const keptSeparate = numeric(row.kept_separate);
      health.resolutions = {
        confirmed,
        consolidated: numeric(row.consolidated),
        attached: numeric(row.attached),
        mergedPosted: numeric(row.merged_posted),
        keptSeparate,
        rejected: numeric(row.rejected),
        precisionProxy: precisionProxy(confirmed, keptSeparate),
      };
    }

    for (const row of unresolvedRows) {
      const health = healthByOrganization.get(String(row.organization_id));
      if (!health) continue;
      health.unresolved = {
        total: numeric(row.unresolved_count),
        blocking: numeric(row.blocking_count),
        shadow: numeric(row.shadow_count),
        oldestCreatedAt: timestamp(row.oldest_created_at),
        oldestAgeSeconds: nullableNumeric(row.oldest_age_seconds),
      };
    }

    for (const row of mergeRows) {
      const health = healthByOrganization.get(String(row.organization_id));
      if (!health) continue;
      health.merges = {
        active: numeric(row.active_count),
        reversed: numeric(row.reversed_count),
        quarantined: numeric(row.quarantined_count),
      };
    }

    for (const row of latencyRows) {
      const health = healthByOrganization.get(String(row.organization_id));
      if (!health) continue;
      health.matcherLatency = {
        sampleCount: numeric(row.sample_count),
        averageMs: nullableNumeric(row.average_ms),
        p50Ms: nullableNumeric(row.p50_ms),
        p95Ms: nullableNumeric(row.p95_ms),
        maxMs: nullableNumeric(row.max_ms),
      };
    }

    const totalLatencyRow = totalLatencyRows[0];
    const totalLatency = totalLatencyRow
      ? {
          sampleCount: numeric(totalLatencyRow.sample_count),
          averageMs: nullableNumeric(totalLatencyRow.average_ms),
          p50Ms: nullableNumeric(totalLatencyRow.p50_ms),
          p95Ms: nullableNumeric(totalLatencyRow.p95_ms),
          maxMs: nullableNumeric(totalLatencyRow.max_ms),
        }
      : emptyMatcherLatencyMetrics();

    return {
      organizations: [...healthByOrganization.values()],
      totalLatency,
    };
  });
}

function sumMetric(
  organizations: OrganizationHealth[],
  read: (health: OrganizationHealth) => number,
): number {
  return organizations.reduce((total, health) => total + read(health), 0);
}

function buildTotals(
  organizations: OrganizationHealth[],
  matcherLatency: MatcherLatencyMetrics,
): Omit<OrganizationHealth, "organizationId" | "organizationName"> {
  const confirmed = sumMetric(organizations, (health) => health.resolutions.confirmed);
  const keptSeparate = sumMetric(organizations, (health) => health.resolutions.keptSeparate);
  const oldest = organizations
    .map((health) => health.unresolved)
    .filter(
      (
        unresolved,
      ): unresolved is UnresolvedMetrics & {
        oldestCreatedAt: string;
        oldestAgeSeconds: number;
      } => unresolved.oldestCreatedAt !== null && unresolved.oldestAgeSeconds !== null,
    )
    .sort((left, right) => left.oldestCreatedAt.localeCompare(right.oldestCreatedAt))[0];
  const caseBreakdown = new Map<string, CaseBreakdown>();
  const signalBreakdown = new Map<string, SignalCombination>();

  for (const health of organizations) {
    for (const row of health.duplicateCases.byDisposition) {
      const key = `${row.matchClass}:${row.disposition}`;
      const current = caseBreakdown.get(key);
      caseBreakdown.set(key, { ...row, count: row.count + (current?.count ?? 0) });
    }
    for (const row of health.duplicateCases.bySignalCombination) {
      const key = `${row.matchClass}:${row.disposition}:${row.signals}`;
      const current = signalBreakdown.get(key);
      signalBreakdown.set(key, { ...row, count: row.count + (current?.count ?? 0) });
    }
  }

  return {
    exactReplaysSuppressed: {
      total: sumMetric(organizations, (health) => health.exactReplaysSuppressed.total),
      requestIdempotency: sumMetric(
        organizations,
        (health) => health.exactReplaysSuppressed.requestIdempotency,
      ),
      providerIdentity: sumMetric(
        organizations,
        (health) => health.exactReplaysSuppressed.providerIdentity,
      ),
      unknown: sumMetric(organizations, (health) => health.exactReplaysSuppressed.unknown),
    },
    documentReuse: {
      canonicalDocumentsWithEvidence: sumMetric(
        organizations,
        (health) => health.documentReuse.canonicalDocumentsWithEvidence,
      ),
      reusedCanonicalDocuments: sumMetric(
        organizations,
        (health) => health.documentReuse.reusedCanonicalDocuments,
      ),
      evidenceLinks: sumMetric(organizations, (health) => health.documentReuse.evidenceLinks),
      additionalEvidenceLinks: sumMetric(
        organizations,
        (health) => health.documentReuse.additionalEvidenceLinks,
      ),
    },
    duplicateCases: {
      total: sumMetric(organizations, (health) => health.duplicateCases.total),
      byDisposition: [...caseBreakdown.values()].sort(
        (left, right) =>
          left.matchClass.localeCompare(right.matchClass) ||
          left.disposition.localeCompare(right.disposition),
      ),
      bySignalCombination: [...signalBreakdown.values()].sort(
        (left, right) =>
          right.count - left.count ||
          left.matchClass.localeCompare(right.matchClass) ||
          left.disposition.localeCompare(right.disposition) ||
          left.signals.localeCompare(right.signals),
      ),
    },
    resolutions: {
      confirmed,
      consolidated: sumMetric(organizations, (health) => health.resolutions.consolidated),
      attached: sumMetric(organizations, (health) => health.resolutions.attached),
      mergedPosted: sumMetric(organizations, (health) => health.resolutions.mergedPosted),
      keptSeparate,
      rejected: sumMetric(organizations, (health) => health.resolutions.rejected),
      precisionProxy: precisionProxy(confirmed, keptSeparate),
    },
    unresolved: {
      total: sumMetric(organizations, (health) => health.unresolved.total),
      blocking: sumMetric(organizations, (health) => health.unresolved.blocking),
      shadow: sumMetric(organizations, (health) => health.unresolved.shadow),
      oldestCreatedAt: oldest?.oldestCreatedAt ?? null,
      oldestAgeSeconds: oldest?.oldestAgeSeconds ?? null,
    },
    merges: {
      active: sumMetric(organizations, (health) => health.merges.active),
      reversed: sumMetric(organizations, (health) => health.merges.reversed),
      quarantined: sumMetric(organizations, (health) => health.merges.quarantined),
    },
    matcherLatency,
  };
}

function formatAge(seconds: number | null): string {
  if (seconds === null) return "n/a";
  const days = Math.floor(seconds / 86_400);
  const hours = Math.floor((seconds % 86_400) / 3_600);
  return days > 0 ? `${days}d ${hours}h` : `${hours}h`;
}

function formatPrecision(value: number | null): string {
  return value === null ? "n/a" : `${value.toFixed(2)}%`;
}

function printHealth(
  label: string,
  health: Omit<OrganizationHealth, "organizationId" | "organizationName">,
) {
  console.log(`\n${label}`);
  console.table([
    {
      exact_replays: health.exactReplaysSuppressed.total,
      request_replays: health.exactReplaysSuppressed.requestIdempotency,
      provider_replays: health.exactReplaysSuppressed.providerIdentity,
      reused_documents: health.documentReuse.reusedCanonicalDocuments,
      additional_evidence_links: health.documentReuse.additionalEvidenceLinks,
      duplicate_cases: health.duplicateCases.total,
      confirmed: health.resolutions.confirmed,
      keep_separate: health.resolutions.keptSeparate,
      rejected: health.resolutions.rejected,
      precision_proxy: formatPrecision(health.resolutions.precisionProxy),
      unresolved: health.unresolved.total,
      oldest_unresolved: formatAge(health.unresolved.oldestAgeSeconds),
      active_merges: health.merges.active,
      reversed_merges: health.merges.reversed,
      matcher_p95_ms: health.matcherLatency.p95Ms ?? "n/a",
    },
  ]);
  if (health.duplicateCases.bySignalCombination.length > 0) {
    console.log("Duplicate cases by signal combination");
    console.table(health.duplicateCases.bySignalCombination);
  }
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });

  try {
    const collected = await collectHealth(client, options);
    const totals = buildTotals(collected.organizations, collected.totalLatency);
    const report = {
      generatedAt: new Date().toISOString(),
      readOnly: true,
      scope: options.organizationId ?? "all_organizations",
      limitations: LIMITATIONS,
      totals,
      organizations: collected.organizations,
    };

    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
      return;
    }

    console.log("Transaction deduplication health report");
    console.log(`Scope: ${options.organizationId ?? "all organizations"}`);
    console.log("Mode: READ ONLY");
    printHealth("All selected organizations", totals);
    if (!options.organizationId && collected.organizations.length > 1) {
      for (const health of collected.organizations) {
        printHealth(`${health.organizationName} (${health.organizationId})`, health);
      }
    }
    console.log("\nLimitations");
    LIMITATIONS.forEach((limitation) => console.log(`- ${limitation}`));
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
