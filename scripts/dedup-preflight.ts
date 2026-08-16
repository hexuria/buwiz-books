import postgres, { type Row } from "postgres";

interface CliOptions {
  organizationId: string | null;
  limit: number;
  json: boolean;
  strict: boolean;
}

interface AuditSection {
  key: string;
  label: string;
  rows: Row[];
}

function usage(): string {
  return `Transaction deduplication preflight (read-only)

Usage:
  bun run dedup:preflight [--org=<organization-id>] [--limit=25] [--json] [--strict]

Options:
  --org       Limit every check to one organization.
  --limit     Maximum sample rows per check (default: 25).
  --json      Emit machine-readable JSON.
  --strict    Exit 2 when any finding is present.
  --help      Show this help.
`;
}

function parseOptions(argv: string[]): CliOptions {
  let organizationId: string | null = null;
  let limit = 25;
  let json = false;
  let strict = false;

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
    if (argument === "--strict") {
      strict = true;
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
    if (argument === "--limit") {
      limit = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (argument.startsWith("--limit=")) {
      limit = Number(argument.slice("--limit=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) {
    throw new Error("--limit must be an integer between 1 and 1000.");
  }
  return { organizationId, limit, json, strict };
}

function printHuman(sections: AuditSection[], organizationId: string | null): void {
  console.log("Transaction deduplication preflight");
  console.log(`Scope: ${organizationId ?? "all organizations"}`);
  console.log("Mode: READ ONLY\n");

  for (const section of sections) {
    console.log(`${section.label}: ${section.rows.length} sampled finding(s)`);
    if (section.rows.length > 0) console.table(section.rows);
  }

  const sampledFindings = sections.reduce((total, section) => total + section.rows.length, 0);
  console.log(`\nSampled findings across all checks: ${sampledFindings}`);
  if (sampledFindings === 0) {
    console.log("No preflight issues were found.");
  } else {
    console.log("Review every section before enabling enforce mode or applying the backfill.");
  }
}

async function run(): Promise<number> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");

  const client = postgres(databaseUrl, {
    max: 1,
    prepare: false,
    onnotice: () => undefined,
  });

  try {
    const sections = await client.begin("read only", async (tx) => {
      // postgres.js's TransactionSql type currently loses the Sql call
      // signature through Omit even though the runtime value remains a tag.
      const query = tx as unknown as typeof client;
      const duplicateDocumentHashes = await query`
        SELECT
          organization_id,
          content_hash,
          count(*)::integer AS document_count,
          (array_agg(id ORDER BY created_at, id))[1:10] AS document_ids
        FROM documents
        WHERE
          content_hash IS NOT NULL
          AND (${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId})
        GROUP BY organization_id, content_hash
        HAVING count(*) > 1
        ORDER BY count(*) DESC, organization_id, content_hash
        LIMIT ${options.limit}
      `;

      const repeatedProviderIdentities = await query`
        SELECT
          organization_id,
          source_id,
          external_id,
          count(*)::integer AS active_record_count,
          array_agg(id ORDER BY updated_at DESC, id) AS source_record_ids
        FROM source_records
        WHERE
          record_state = 'active'
          AND source_id IS NOT NULL
          AND external_id IS NOT NULL
          AND (${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId})
        GROUP BY organization_id, source_id, external_id
        HAVING count(*) > 1
        ORDER BY count(*) DESC, organization_id, source_id, external_id
        LIMIT ${options.limit}
      `;

      const multiJournalOrigins = await query`
        SELECT
          organization_id,
          source_record_id,
          count(DISTINCT journal_header_id)::integer AS journal_count,
          array_agg(DISTINCT journal_header_id) AS journal_header_ids
        FROM ledger_source_links
        WHERE
          relationship = 'origin'
          AND (${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId})
        GROUP BY organization_id, source_record_id
        HAVING count(DISTINCT journal_header_id) > 1
        ORDER BY count(DISTINCT journal_header_id) DESC, organization_id, source_record_id
        LIMIT ${options.limit}
      `;

      const multipleCurrentCandidates = await query`
        WITH current_candidate_sources AS (
          SELECT
            candidate.organization_id,
            candidate.source_record_id,
            candidate.id AS candidate_id
          FROM transaction_candidates AS candidate
          WHERE candidate.status = 'current'
            AND candidate.source_record_id IS NOT NULL
            -- source_record_id is a compatibility pointer. Only treat it as
            -- the origin when this legacy candidate has no authoritative
            -- candidate-source rows; supporting evidence (for example one
            -- parent email shared by split attachment candidates) is allowed
            -- to belong to more than one current candidate.
            AND NOT EXISTS (
              SELECT 1
              FROM transaction_candidate_sources AS authoritative_source
              WHERE authoritative_source.organization_id = candidate.organization_id
                AND authoritative_source.candidate_id = candidate.id
            )

          UNION

          SELECT
            candidate_source.organization_id,
            candidate_source.source_record_id,
            candidate_source.candidate_id
          FROM transaction_candidate_sources AS candidate_source
          INNER JOIN transaction_candidates AS candidate
            ON candidate.id = candidate_source.candidate_id
          WHERE candidate.status = 'current'
            AND candidate_source.relationship = 'origin'
        )
        SELECT
          organization_id,
          source_record_id,
          count(DISTINCT candidate_id)::integer AS current_candidate_count,
          array_agg(DISTINCT candidate_id) AS candidate_ids
        FROM current_candidate_sources
        WHERE ${options.organizationId}::text IS NULL OR organization_id = ${options.organizationId}
        GROUP BY organization_id, source_record_id
        HAVING count(DISTINCT candidate_id) > 1
        ORDER BY count(DISTINCT candidate_id) DESC, organization_id, source_record_id
        LIMIT ${options.limit}
      `;

      const invalidSourcePairs = await query`
        SELECT
          match_case.id,
          match_case.organization_id,
          match_case.left_source_record_id,
          match_case.right_source_record_id,
          CASE
            WHEN match_case.left_source_record_id = match_case.right_source_record_id
              THEN 'self_pair'
            WHEN match_case.left_source_record_id > match_case.right_source_record_id
              THEN 'reversed_pair'
            WHEN left_source.id IS NULL OR right_source.id IS NULL
              THEN 'missing_source'
            WHEN
              left_source.organization_id <> match_case.organization_id
              OR right_source.organization_id <> match_case.organization_id
              THEN 'cross_organization_pair'
            ELSE 'unknown'
          END AS issue
        FROM source_match_candidates AS match_case
        LEFT JOIN source_records AS left_source
          ON left_source.id = match_case.left_source_record_id
        LEFT JOIN source_records AS right_source
          ON right_source.id = match_case.right_source_record_id
        WHERE
          (
            match_case.left_source_record_id >= match_case.right_source_record_id
            OR left_source.id IS NULL
            OR right_source.id IS NULL
            OR left_source.organization_id <> match_case.organization_id
            OR right_source.organization_id <> match_case.organization_id
          )
          AND (
            ${options.organizationId}::text IS NULL
            OR match_case.organization_id = ${options.organizationId}
          )
        ORDER BY match_case.organization_id, match_case.created_at, match_case.id
        LIMIT ${options.limit}
      `;

      const tenantLineageMismatches = await query`
        WITH lineage_mismatches AS (
          SELECT
            'source_records.parent_source_record_id'::text AS relationship,
            child.organization_id AS child_organization_id,
            child.id::text AS child_id,
            parent.organization_id AS parent_organization_id,
            parent.id::text AS parent_id
          FROM source_records AS child
          INNER JOIN source_records AS parent ON parent.id = child.parent_source_record_id
          WHERE child.organization_id <> parent.organization_id

          UNION ALL

          SELECT
            'source_record_versions.source_record_id',
            version.organization_id,
            version.id::text,
            source.organization_id,
            source.id::text
          FROM source_record_versions AS version
          INNER JOIN source_records AS source ON source.id = version.source_record_id
          WHERE version.organization_id <> source.organization_id

          UNION ALL

          SELECT
            'source_record_documents.source_record_id',
            source_document.organization_id,
            source_document.source_record_id::text || ':' || source_document.document_id::text,
            source.organization_id,
            source.id::text
          FROM source_record_documents AS source_document
          INNER JOIN source_records AS source ON source.id = source_document.source_record_id
          WHERE source_document.organization_id <> source.organization_id

          UNION ALL

          SELECT
            'source_record_documents.document_id',
            source_document.organization_id,
            source_document.source_record_id::text || ':' || source_document.document_id::text,
            document.organization_id,
            document.id::text
          FROM source_record_documents AS source_document
          INNER JOIN documents AS document ON document.id = source_document.document_id
          WHERE source_document.organization_id <> document.organization_id

          UNION ALL

          SELECT
            'transaction_candidates.source_record_id',
            candidate.organization_id,
            candidate.id::text,
            source.organization_id,
            source.id::text
          FROM transaction_candidates AS candidate
          INNER JOIN source_records AS source ON source.id = candidate.source_record_id
          WHERE candidate.organization_id <> source.organization_id

          UNION ALL

          SELECT
            'transaction_candidate_sources.candidate_id',
            candidate_source.organization_id,
            candidate_source.candidate_id::text || ':' || candidate_source.source_record_id::text,
            candidate.organization_id,
            candidate.id::text
          FROM transaction_candidate_sources AS candidate_source
          INNER JOIN transaction_candidates AS candidate ON candidate.id = candidate_source.candidate_id
          WHERE candidate_source.organization_id <> candidate.organization_id

          UNION ALL

          SELECT
            'transaction_candidate_sources.source_record_id',
            candidate_source.organization_id,
            candidate_source.candidate_id::text || ':' || candidate_source.source_record_id::text,
            source.organization_id,
            source.id::text
          FROM transaction_candidate_sources AS candidate_source
          INNER JOIN source_records AS source ON source.id = candidate_source.source_record_id
          WHERE candidate_source.organization_id <> source.organization_id

          UNION ALL

          SELECT
            'source_match_candidates.left_source_record_id',
            match_case.organization_id,
            match_case.id::text,
            source.organization_id,
            source.id::text
          FROM source_match_candidates AS match_case
          INNER JOIN source_records AS source ON source.id = match_case.left_source_record_id
          WHERE match_case.organization_id <> source.organization_id

          UNION ALL

          SELECT
            'source_match_candidates.right_source_record_id',
            match_case.organization_id,
            match_case.id::text,
            source.organization_id,
            source.id::text
          FROM source_match_candidates AS match_case
          INNER JOIN source_records AS source ON source.id = match_case.right_source_record_id
          WHERE match_case.organization_id <> source.organization_id

          UNION ALL

          SELECT
            'source_match_candidates.canonical_candidate_id',
            match_case.organization_id,
            match_case.id::text,
            candidate.organization_id,
            candidate.id::text
          FROM source_match_candidates AS match_case
          INNER JOIN transaction_candidates AS candidate ON candidate.id = match_case.canonical_candidate_id
          WHERE match_case.organization_id <> candidate.organization_id

          UNION ALL

          SELECT
            'source_match_candidates.canonical_journal_header_id',
            match_case.organization_id,
            match_case.id::text,
            journal.organization_id,
            journal.id::text
          FROM source_match_candidates AS match_case
          INNER JOIN journal_headers AS journal ON journal.id = match_case.canonical_journal_header_id
          WHERE match_case.organization_id <> journal.organization_id

          UNION ALL

          SELECT
            'ledger_source_links.journal_header_id',
            ledger_source.organization_id,
            ledger_source.journal_header_id::text || ':' || ledger_source.source_record_id::text,
            journal.organization_id,
            journal.id::text
          FROM ledger_source_links AS ledger_source
          INNER JOIN journal_headers AS journal ON journal.id = ledger_source.journal_header_id
          WHERE ledger_source.organization_id <> journal.organization_id

          UNION ALL

          SELECT
            'ledger_source_links.source_record_id',
            ledger_source.organization_id,
            ledger_source.journal_header_id::text || ':' || ledger_source.source_record_id::text,
            source.organization_id,
            source.id::text
          FROM ledger_source_links AS ledger_source
          INNER JOIN source_records AS source ON source.id = ledger_source.source_record_id
          WHERE ledger_source.organization_id <> source.organization_id

          UNION ALL

          SELECT
            'journal_headers.duplicate_of_header_id',
            duplicate.organization_id,
            duplicate.id::text,
            canonical.organization_id,
            canonical.id::text
          FROM journal_headers AS duplicate
          INNER JOIN journal_headers AS canonical ON canonical.id = duplicate.duplicate_of_header_id
          WHERE duplicate.organization_id <> canonical.organization_id

          UNION ALL

          SELECT
            'journal_duplicate_merges.canonical_header_id',
            merge.organization_id,
            merge.id::text,
            journal.organization_id,
            journal.id::text
          FROM journal_duplicate_merges AS merge
          INNER JOIN journal_headers AS journal ON journal.id = merge.canonical_header_id
          WHERE merge.organization_id <> journal.organization_id

          UNION ALL

          SELECT
            'journal_duplicate_merges.duplicate_header_id',
            merge.organization_id,
            merge.id::text,
            journal.organization_id,
            journal.id::text
          FROM journal_duplicate_merges AS merge
          INNER JOIN journal_headers AS journal ON journal.id = merge.duplicate_header_id
          WHERE merge.organization_id <> journal.organization_id

          UNION ALL

          SELECT
            'journal_duplicate_merges.duplicate_case_id',
            merge.organization_id,
            merge.id::text,
            duplicate_case.organization_id,
            duplicate_case.id::text
          FROM journal_duplicate_merges AS merge
          INNER JOIN source_match_candidates AS duplicate_case ON duplicate_case.id = merge.duplicate_case_id
          WHERE merge.organization_id <> duplicate_case.organization_id
        )
        SELECT
          relationship,
          child_organization_id,
          child_id,
          parent_organization_id,
          parent_id
        FROM lineage_mismatches
        WHERE
          ${options.organizationId}::text IS NULL
          OR child_organization_id = ${options.organizationId}
        ORDER BY child_organization_id, relationship, child_id
        LIMIT ${options.limit}
      `;

      const activeLegacyMatches = await query`
        SELECT
          history.id,
          history.organization_id,
          history.surviving_header_id,
          history.matched_at,
          history.matched_by,
          coalesce(conversion.status, 'unprocessed') AS conversion_status,
          conversion.reason_codes
        FROM match_history AS history
        LEFT JOIN legacy_match_conversion_records AS conversion
          ON conversion.legacy_match_history_id = history.id
        WHERE
          history.unmatched_at IS NULL
          AND (conversion.id IS NULL OR conversion.status = 'quarantined')
          AND (
            ${options.organizationId}::text IS NULL
            OR history.organization_id = ${options.organizationId}
          )
        ORDER BY history.matched_at, history.id
        LIMIT ${options.limit}
      `;

      const orphanedAttachments = await query`
        SELECT
          attachment.id,
          attachment.organization_id,
          attachment.document_id,
          attachment.linkable_type,
          attachment.linkable_id,
          CASE
            WHEN document.id IS NULL THEN 'missing_document'
            WHEN attachment.linkable_type IN ('journal_header', 'transaction')
              AND journal.id IS NULL THEN 'missing_journal'
            WHEN attachment.linkable_type = 'transaction_candidate'
              AND candidate.id IS NULL THEN 'missing_candidate'
            WHEN attachment.linkable_type = 'invoice' AND invoice.id IS NULL THEN 'missing_invoice'
            WHEN attachment.linkable_type = 'bill' AND bill.id IS NULL THEN 'missing_bill'
            WHEN attachment.linkable_type = 'party' AND party.id IS NULL THEN 'missing_party'
            WHEN attachment.linkable_type = 'reconciliation'
              AND reconciliation.id IS NULL THEN 'missing_reconciliation'
            WHEN attachment.linkable_type NOT IN (
              'journal_header',
              'transaction',
              'transaction_candidate',
              'invoice',
              'bill',
              'party',
              'reconciliation'
            ) THEN 'unknown_linkable_type'
            ELSE 'unknown'
          END AS issue
        FROM document_attachments AS attachment
        LEFT JOIN documents AS document
          ON document.id = attachment.document_id
        LEFT JOIN journal_headers AS journal
          ON
            attachment.linkable_type IN ('journal_header', 'transaction')
            AND journal.id = attachment.linkable_id
        LEFT JOIN transaction_candidates AS candidate
          ON
            attachment.linkable_type = 'transaction_candidate'
            AND candidate.id = attachment.linkable_id
        LEFT JOIN invoices AS invoice
          ON attachment.linkable_type = 'invoice' AND invoice.id = attachment.linkable_id
        LEFT JOIN bills AS bill
          ON attachment.linkable_type = 'bill' AND bill.id = attachment.linkable_id
        LEFT JOIN parties AS party
          ON attachment.linkable_type = 'party' AND party.id = attachment.linkable_id
        LEFT JOIN reconciliations AS reconciliation
          ON
            attachment.linkable_type = 'reconciliation'
            AND reconciliation.id = attachment.linkable_id
        WHERE
          (
            document.id IS NULL
            OR (
              attachment.linkable_type IN ('journal_header', 'transaction')
              AND journal.id IS NULL
            )
            OR (attachment.linkable_type = 'transaction_candidate' AND candidate.id IS NULL)
            OR (attachment.linkable_type = 'invoice' AND invoice.id IS NULL)
            OR (attachment.linkable_type = 'bill' AND bill.id IS NULL)
            OR (attachment.linkable_type = 'party' AND party.id IS NULL)
            OR (attachment.linkable_type = 'reconciliation' AND reconciliation.id IS NULL)
            OR attachment.linkable_type NOT IN (
              'journal_header',
              'transaction',
              'transaction_candidate',
              'invoice',
              'bill',
              'party',
              'reconciliation'
            )
          )
          AND (
            ${options.organizationId}::text IS NULL
            OR attachment.organization_id = ${options.organizationId}
          )
        ORDER BY attachment.organization_id, attachment.created_at, attachment.id
        LIMIT ${options.limit}
      `;

      return [
        {
          key: "duplicate_document_hashes",
          label: "Duplicate document hashes",
          rows: duplicateDocumentHashes,
        },
        {
          key: "repeated_active_provider_identities",
          label: "Repeated active provider identities",
          rows: repeatedProviderIdentities,
        },
        {
          key: "origin_source_multiple_journals",
          label: "Origin sources linked to multiple journals",
          rows: multiJournalOrigins,
        },
        {
          key: "source_multiple_current_candidates",
          label: "Origin sources linked to multiple current candidates",
          rows: multipleCurrentCandidates,
        },
        {
          key: "invalid_source_pairs",
          label: "Invalid or reversed source-match pairs",
          rows: invalidSourcePairs,
        },
        {
          key: "tenant_lineage_mismatches",
          label: "Cross-organization UUID lineage links",
          rows: tenantLineageMismatches,
        },
        {
          key: "active_legacy_matches",
          label: "Unprocessed or quarantined legacy destructive matches",
          rows: activeLegacyMatches,
        },
        {
          key: "orphaned_document_attachments",
          label: "Orphaned polymorphic document attachments",
          rows: orphanedAttachments,
        },
      ] satisfies AuditSection[];
    });

    const sampledFindings = sections.reduce((total, section) => total + section.rows.length, 0);
    if (options.json) {
      console.log(
        JSON.stringify(
          {
            generatedAt: new Date().toISOString(),
            readOnly: true,
            organizationId: options.organizationId,
            sampleLimit: options.limit,
            sampledFindings,
            sections: Object.fromEntries(
              sections.map((section) => [
                section.key,
                { label: section.label, sampledCount: section.rows.length, rows: section.rows },
              ]),
            ),
          },
          null,
          2,
        ),
      );
    } else {
      printHuman(sections, options.organizationId);
    }
    return options.strict && sampledFindings > 0 ? 2 : 0;
  } finally {
    await client.end();
  }
}

run()
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
