import postgres from "postgres";

const DEDUP_CHECK_CONSTRAINTS = [
  {
    table: "source_records",
    constraint: "source_records_record_state_check",
  },
  {
    table: "source_records",
    constraint: "source_records_direction_check",
  },
  {
    table: "source_records",
    constraint: "source_records_economic_event_class_check",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_canonical_pair_check",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_score_range_check",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_match_class_check",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_disposition_check",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_resolution_action_check",
  },
] as const;

const TENANT_LINEAGE_FOREIGN_KEYS = [
  {
    table: "source_records",
    constraint: "source_records_org_parent_source_fk",
  },
  {
    table: "source_record_versions",
    constraint: "source_record_versions_org_source_fk",
  },
  {
    table: "source_record_documents",
    constraint: "source_record_documents_org_source_fk",
  },
  {
    table: "source_record_documents",
    constraint: "source_record_documents_org_document_fk",
  },
  {
    table: "transaction_candidates",
    constraint: "transaction_candidates_org_source_fk",
  },
  {
    table: "transaction_candidate_sources",
    constraint: "transaction_candidate_sources_org_candidate_fk",
  },
  {
    table: "transaction_candidate_sources",
    constraint: "transaction_candidate_sources_org_source_fk",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_org_left_source_fk",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_org_right_source_fk",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_org_canonical_candidate_fk",
  },
  {
    table: "source_match_candidates",
    constraint: "source_match_candidates_org_canonical_journal_fk",
  },
  {
    table: "ledger_source_links",
    constraint: "ledger_source_links_org_journal_fk",
  },
  {
    table: "ledger_source_links",
    constraint: "ledger_source_links_org_source_fk",
  },
  {
    table: "journal_headers",
    constraint: "journal_headers_org_duplicate_of_fk",
  },
  {
    table: "journal_duplicate_merges",
    constraint: "journal_duplicate_merges_org_canonical_fk",
  },
  {
    table: "journal_duplicate_merges",
    constraint: "journal_duplicate_merges_org_duplicate_fk",
  },
  {
    table: "journal_duplicate_merges",
    constraint: "journal_duplicate_merges_org_case_fk",
  },
] as const;

const DEDUP_CONSTRAINTS = [
  ...DEDUP_CHECK_CONSTRAINTS.map((item) => ({ ...item, type: "c" as const })),
  ...TENANT_LINEAGE_FOREIGN_KEYS.map((item) => ({ ...item, type: "f" as const })),
];

interface CliOptions {
  statusOnly: boolean;
}

function usage(): string {
  return `Validate transaction-deduplication constraints

Usage:
  bun run db:dedup:validate --status
  bun run db:dedup:validate

Run "bun run dedup:preflight --strict" first. The default command promotes all
dedup CHECK and tenant-lineage foreign-key constraints created NOT VALID by the
manual migrations after PostgreSQL verifies every existing row. New rows are
already checked before this promotion.
`;
}

function parseOptions(argv: string[]): CliOptions {
  let statusOnly = false;
  for (const argument of argv) {
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--status") {
      statusOnly = true;
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }
  return { statusOnly };
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
    for (const item of DEDUP_CONSTRAINTS) {
      const outcome = await client.begin(async (tx) => {
        const query = tx as unknown as typeof client;
        await query`
          SELECT pg_advisory_xact_lock(
            hashtextextended('digits:dedup-constraint-validation', 0::bigint)
          )
        `;
        const [constraint] = await query<Array<{ validated: boolean }>>`
          SELECT constraint_row.convalidated AS validated
          FROM pg_constraint AS constraint_row
          INNER JOIN pg_class AS table_row
            ON table_row.oid = constraint_row.conrelid
          INNER JOIN pg_namespace AS namespace_row
            ON namespace_row.oid = table_row.relnamespace
          WHERE
            namespace_row.nspname = 'public'
            AND table_row.relname = ${item.table}
            AND constraint_row.conname = ${item.constraint}
            AND constraint_row.contype = ${item.type}
        `;
        if (!constraint) {
          throw new Error(
            `Missing constraint public.${item.table}.${item.constraint}; ` +
              "apply the dedup migrations before validation.",
          );
        }
        if (constraint.validated) return "validated" as const;
        if (options.statusOnly) return "pending" as const;

        // These are compile-time constants, not user-provided identifiers.
        await tx.unsafe(`ALTER TABLE "${item.table}" VALIDATE CONSTRAINT "${item.constraint}"`);
        return "validated-now" as const;
      });
      console.log(`${item.table}.${item.constraint}: ${outcome}`);
    }

    if (options.statusOnly) {
      console.log("Constraint status check complete; no constraints were changed.");
    } else {
      console.log("All transaction-deduplication constraints are validated.");
    }
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
