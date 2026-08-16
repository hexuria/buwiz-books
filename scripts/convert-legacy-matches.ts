import postgres from "postgres";
import {
  LEGACY_MATCH_VALIDATOR_VERSION,
  validateLegacyMatchSnapshot,
  validateLegacySurvivorPair,
  type LegacyDeletedHeaderSnapshot,
  type LegacyValidationIssue,
  type ValidatedLegacySnapshot,
} from "../src/lib/legacy-match-conversion";

const DEFAULT_ACTOR = "system:legacy-match-converter";
type QueryClient = ReturnType<typeof postgres>;

interface CliOptions {
  apply: boolean;
  organizationId: string | null;
  limit: number;
  json: boolean;
  quarantines: boolean;
  actor: string;
}

interface LegacyHistoryRow {
  id: string;
  organizationId: string;
  survivingHeaderId: string;
  deletedHeaderSnapshot: unknown;
  deletedLinesSnapshot: unknown;
  matchedAt: Date;
  matchedBy: string | null;
}

interface SurvivorRow {
  id: string;
  organizationId: string;
  transactionNumber: string | null;
  idempotencyKey: string | null;
  transactionDate: string;
  transactionType: "pay_in" | "pay_out" | "journal" | "transfer";
  source: LegacyDeletedHeaderSnapshot["source"];
  status: "draft" | "posted" | "voided";
  totalAmount: string | null;
  functionalCurrency: string;
  transactionCurrency: string | null;
  duplicateOfHeaderId: string | null;
  matchedFromIds: string[];
  isMatched: boolean;
  sourceDocumentId: string | null;
  sourceDocumentType: string | null;
  debitTotal: string;
  creditTotal: string;
}

interface HistoryAnalysis {
  history: LegacyHistoryRow;
  snapshotDigest: string;
  snapshotHeaderId: string | null;
  validated: ValidatedLegacySnapshot | null;
  issues: LegacyValidationIssue[];
}

interface ProcessResult {
  historyId: string;
  organizationId: string;
  survivingHeaderId: string;
  snapshotHeaderId: string | null;
  outcome: "convertible" | "converted" | "would_quarantine" | "quarantined" | "already_processed";
  mergeId?: string;
  issueCodes: string[];
  issues: LegacyValidationIssue[];
}

function usage(): string {
  return `Convert destructive legacy transaction matches safely

Usage:
  bun run dedup:convert-legacy [--org=<organization-id>] [--limit=100] [--json]
  bun run dedup:convert-legacy --apply [--org=<organization-id>] [--limit=100]
  bun run dedup:convert-legacy --quarantines [--org=<organization-id>] [--json]

The default is a read-only dry run. Apply mode revalidates and restores a
complete deleted journal snapshot inside one transaction, then suppresses it
through journal_duplicate_merges. Invalid snapshots are recorded in the durable
manual-quarantine table and legacy match_history is left untouched.

Options:
  --apply          Apply conversions and durable quarantines.
  --org            Limit work to one organization.
  --limit          Maximum unprocessed rows in this batch (default: 100).
  --actor          Audit actor ID (default: system:legacy-match-converter).
  --json           Emit machine-readable JSON.
  --quarantines    Report existing quarantines; never mutates data.
  --help           Show this help.
`;
}

function parseOptions(argv: string[]): CliOptions {
  let apply = false;
  let organizationId: string | null = null;
  let limit = 100;
  let json = false;
  let quarantines = false;
  let actor = DEFAULT_ACTOR;

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") {
      console.log(usage());
      process.exit(0);
    }
    if (argument === "--apply") {
      apply = true;
      continue;
    }
    if (argument === "--json") {
      json = true;
      continue;
    }
    if (argument === "--quarantines") {
      quarantines = true;
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
    if (argument === "--actor") {
      actor = argv[index + 1]?.trim() || "";
      index += 1;
      continue;
    }
    if (argument.startsWith("--actor=")) {
      actor = argument.slice("--actor=".length).trim();
      continue;
    }
    throw new Error(`Unknown argument: ${argument}`);
  }

  if (apply && quarantines) throw new Error("--apply and --quarantines cannot be combined.");
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new Error("--limit must be an integer between 1 and 10000.");
  }
  if (!actor || actor.length > 255) throw new Error("--actor must be 1 to 255 characters.");
  return { apply, organizationId, limit, json, quarantines, actor };
}

function addIssue(issues: LegacyValidationIssue[], code: string, message: string): void {
  if (!issues.some((issue) => issue.code === code && issue.message === message)) {
    issues.push({ code, message });
  }
}

function snapshotHeaderId(snapshot: unknown): string | null {
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const id = (snapshot as Record<string, unknown>).id;
  return typeof id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)
    ? id
    : null;
}

function sameDomainOwner(canonicalOwners: Set<string>, duplicateOwners: Set<string>): boolean {
  if (canonicalOwners.size === 0 && duplicateOwners.size > 0) return false;
  if (duplicateOwners.size === 0) return true;
  return (
    canonicalOwners.size === 1 &&
    duplicateOwners.size === 1 &&
    [...canonicalOwners][0] === [...duplicateOwners][0]
  );
}

function fallbackEventClass(
  source: LegacyDeletedHeaderSnapshot["source"],
  transactionType: LegacyDeletedHeaderSnapshot["transactionType"],
): string {
  if (source === "bill") return "bill_accrual";
  if (source === "invoice") return "invoice_accrual";
  if (source === "payment") {
    return transactionType === "pay_in" ? "invoice_payment" : "bill_payment";
  }
  if (transactionType === "pay_in") return "sale";
  if (transactionType === "pay_out") return "purchase";
  if (transactionType === "transfer") return "transfer";
  return "other";
}

function eventClassesCompatible(left: string, right: string): boolean {
  if (left === "transfer" || right === "transfer") return false;
  if (left === right || left === "other" || right === "other") return true;
  const pair = new Set([left, right]);
  return (
    (pair.has("purchase") && pair.has("bill_accrual")) ||
    (pair.has("sale") && pair.has("invoice_accrual"))
  );
}

function normalizeDecimal(value: string): string | null {
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;
  const whole = match[2].replace(/^0+(?=\d)/, "");
  const fraction = (match[3] ?? "").replace(/0+$/, "");
  const unsigned = fraction ? `${whole}.${fraction}` : whole;
  return `${match[1] === "-" && unsigned !== "0" ? "-" : ""}${unsigned}`;
}

function decimalsEqual(left: string, right: string): boolean {
  const normalizedLeft = normalizeDecimal(left);
  return normalizedLeft !== null && normalizedLeft === normalizeDecimal(right);
}

async function assertRequiredSchema(client: QueryClient): Promise<void> {
  const [tables] = await client<
    Array<{ mergeTable: string | null; conversionTable: string | null }>
  >`
    SELECT
      to_regclass('public.journal_duplicate_merges')::text AS "mergeTable",
      to_regclass('public.legacy_match_conversion_records')::text AS "conversionTable"
  `;
  if (!tables.mergeTable || !tables.conversionTable) {
    throw new Error(
      "Legacy converter schema is missing. Run `bun run db:migrate` first; the ordered manifest applies 0022.",
    );
  }
}

async function listUnprocessed(
  client: QueryClient,
  options: CliOptions,
): Promise<LegacyHistoryRow[]> {
  return client<LegacyHistoryRow[]>`
    SELECT
      history.id,
      history.organization_id AS "organizationId",
      history.surviving_header_id AS "survivingHeaderId",
      history.deleted_header_snapshot AS "deletedHeaderSnapshot",
      history.deleted_lines_snapshot AS "deletedLinesSnapshot",
      history.matched_at AS "matchedAt",
      history.matched_by AS "matchedBy"
    FROM match_history AS history
    LEFT JOIN legacy_match_conversion_records AS conversion
      ON conversion.legacy_match_history_id = history.id
    WHERE
      history.unmatched_at IS NULL
      AND conversion.id IS NULL
      AND (
        ${options.organizationId}::text IS NULL
        OR history.organization_id = ${options.organizationId}
      )
    ORDER BY history.matched_at, history.id
    LIMIT ${options.limit}
  `;
}

async function missingScopedIds(
  query: QueryClient,
  table: "accounts" | "parties" | "dimensions" | "fx_rates",
  ids: string[],
  organizationId: string,
): Promise<string[]> {
  if (ids.length === 0) return [];
  const rows = await query.unsafe<Array<{ id: string; organization_id: string }>>(
    `SELECT id, organization_id FROM ${table} WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  const valid = new Set(
    rows.filter((row) => row.organization_id === organizationId).map((row) => row.id),
  );
  return ids.filter((id) => !valid.has(id));
}

async function analyzeHistory(
  query: QueryClient,
  history: LegacyHistoryRow,
): Promise<HistoryAnalysis> {
  const validation = validateLegacyMatchSnapshot({
    historyId: history.id,
    organizationId: history.organizationId,
    survivingHeaderId: history.survivingHeaderId,
    deletedHeaderSnapshot: history.deletedHeaderSnapshot,
    deletedLinesSnapshot: history.deletedLinesSnapshot,
  });
  const analysis: HistoryAnalysis = {
    history,
    snapshotDigest: validation.valid ? validation.value.snapshotDigest : validation.snapshotDigest,
    snapshotHeaderId: snapshotHeaderId(history.deletedHeaderSnapshot),
    validated: validation.valid ? validation.value : null,
    issues: [...validation.issues],
  };
  if (!validation.valid) return analysis;

  const deleted = validation.value;
  const [survivor] = await query<SurvivorRow[]>`
    SELECT
      header.id,
      header.organization_id AS "organizationId",
      header.transaction_number AS "transactionNumber",
      header.idempotency_key AS "idempotencyKey",
      header.transaction_date AS "transactionDate",
      header.transaction_type AS "transactionType",
      header.source,
      header.status,
      header.total_amount::text AS "totalAmount",
      header.functional_currency AS "functionalCurrency",
      header.transaction_currency AS "transactionCurrency",
      header.duplicate_of_header_id AS "duplicateOfHeaderId",
      header.matched_from_ids AS "matchedFromIds",
      header.is_matched AS "isMatched",
      header.source_document_id AS "sourceDocumentId",
      header.source_document_type AS "sourceDocumentType",
      coalesce(sum(coalesce(line.debit, 0)), 0)::text AS "debitTotal",
      coalesce(sum(coalesce(line.credit, 0)), 0)::text AS "creditTotal"
    FROM journal_headers AS header
    LEFT JOIN journal_lines AS line ON line.journal_header_id = header.id
    WHERE
      header.id = ${history.survivingHeaderId}::uuid
      AND header.organization_id = ${history.organizationId}
    GROUP BY header.id
  `;
  if (!survivor) {
    addIssue(analysis.issues, "survivor_missing", "Surviving legacy journal no longer exists.");
    return analysis;
  }
  analysis.issues.push(...validateLegacySurvivorPair(survivor, deleted));

  const pairIds = [survivor.id, deleted.header.id];
  const [headerCollision, lineCollisions, activeMerges, numberCollision, keyCollision] =
    await Promise.all([
      query<Array<{ id: string }>>`
        SELECT id FROM journal_headers WHERE id = ${deleted.header.id}::uuid LIMIT 1
      `,
      query<Array<{ id: string }>>`
        SELECT id FROM journal_lines WHERE id = ANY(${deleted.lines.map((line) => line.id)}::uuid[])
      `,
      query<Array<{ id: string }>>`
        SELECT id
        FROM journal_duplicate_merges
        WHERE
          organization_id = ${history.organizationId}
          AND state = 'active'
          AND (
            canonical_header_id = ANY(${pairIds}::uuid[])
            OR duplicate_header_id = ANY(${pairIds}::uuid[])
          )
      `,
      deleted.header.transactionNumber === null
        ? Promise.resolve([])
        : query<Array<{ id: string }>>`
          SELECT id
          FROM journal_headers
          WHERE
            organization_id = ${history.organizationId}
            AND transaction_number = ${deleted.header.transactionNumber}
            AND id <> ${deleted.header.id}::uuid
          LIMIT 1
        `,
      deleted.header.idempotencyKey === null
        ? Promise.resolve([])
        : query<Array<{ id: string }>>`
          SELECT id
          FROM journal_headers
          WHERE
            organization_id = ${history.organizationId}
            AND idempotency_key = ${deleted.header.idempotencyKey}
            AND id <> ${deleted.header.id}::uuid
          LIMIT 1
        `,
    ]);
  if (headerCollision.length > 0) {
    addIssue(
      analysis.issues,
      "duplicate_header_id_in_use",
      "Deleted snapshot header ID is already present in journal_headers.",
    );
  }
  if (lineCollisions.length > 0) {
    addIssue(
      analysis.issues,
      "duplicate_line_id_in_use",
      `Deleted snapshot line IDs already exist: ${lineCollisions.map((row) => row.id).join(", ")}.`,
    );
  }
  if (activeMerges.length > 0) {
    addIssue(
      analysis.issues,
      "active_safe_merge_conflict",
      "One of the journals already participates in an active safe duplicate merge.",
    );
  }
  if (numberCollision.length > 0) {
    addIssue(
      analysis.issues,
      "transaction_number_in_use",
      "Deleted snapshot transaction number has been reused by another journal.",
    );
  }
  if (keyCollision.length > 0) {
    addIssue(
      analysis.issues,
      "idempotency_key_in_use",
      "Deleted snapshot idempotency key has been reused by another journal.",
    );
  }

  const accountIds = [...new Set(deleted.lines.map((line) => line.accountId))];
  const partyIds = [
    ...new Set(
      [deleted.header.partyId, ...deleted.lines.map((line) => line.partyId)].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
  const dimensionIds = [
    ...new Set(
      deleted.lines
        .flatMap((line) => [line.departmentId, line.locationId])
        .filter((id): id is string => id !== null),
    ),
  ];
  const fxIds = [
    ...new Set(
      [deleted.header.exchangeRateId, ...deleted.lines.map((line) => line.exchangeRateId)].filter(
        (id): id is string => id !== null,
      ),
    ),
  ];
  const [missingAccounts, missingParties, missingDimensions, missingFxRates] = await Promise.all([
    missingScopedIds(query, "accounts", accountIds, history.organizationId),
    missingScopedIds(query, "parties", partyIds, history.organizationId),
    missingScopedIds(query, "dimensions", dimensionIds, history.organizationId),
    missingScopedIds(query, "fx_rates", fxIds, history.organizationId),
  ]);
  if (missingAccounts.length > 0) {
    addIssue(
      analysis.issues,
      "missing_or_cross_org_account",
      `Snapshot accounts are missing or belong to another organization: ${missingAccounts.join(", ")}.`,
    );
  }
  if (missingParties.length > 0) {
    addIssue(
      analysis.issues,
      "missing_or_cross_org_party",
      `Snapshot parties are missing or belong to another organization: ${missingParties.join(", ")}.`,
    );
  }
  if (missingDimensions.length > 0) {
    addIssue(
      analysis.issues,
      "missing_or_cross_org_dimension",
      `Snapshot dimensions are missing or belong to another organization: ${missingDimensions.join(", ")}.`,
    );
  }
  if (missingFxRates.length > 0) {
    addIssue(
      analysis.issues,
      "missing_or_cross_org_fx_rate",
      `Snapshot FX rates are missing or belong to another organization: ${missingFxRates.join(", ")}.`,
    );
  }

  if (dimensionIds.length > 0) {
    const dimensions = await query<Array<{ id: string; dimensionType: string }>>`
      SELECT id, dimension_type AS "dimensionType"
      FROM dimensions
      WHERE id = ANY(${dimensionIds}::uuid[])
    `;
    const byId = new Map(dimensions.map((dimension) => [dimension.id, dimension.dimensionType]));
    for (const [index, line] of deleted.lines.entries()) {
      if (line.departmentId && byId.get(line.departmentId) !== "department") {
        addIssue(
          analysis.issues,
          "invalid_department_dimension",
          `Line ${index + 1} department ID is not a department dimension.`,
        );
      }
      if (line.locationId && byId.get(line.locationId) !== "location") {
        addIssue(
          analysis.issues,
          "invalid_location_dimension",
          `Line ${index + 1} location ID is not a location dimension.`,
        );
      }
    }
  }

  if (fxIds.length > 0) {
    const rates = await query<
      Array<{
        id: string;
        baseCurrency: string;
        quoteCurrency: string;
        rate: string;
      }>
    >`
      SELECT
        id,
        base_currency AS "baseCurrency",
        quote_currency AS "quoteCurrency",
        rate::text AS rate
      FROM fx_rates
      WHERE organization_id = ${history.organizationId} AND id = ANY(${fxIds}::uuid[])
    `;
    const byId = new Map(rates.map((rate) => [rate.id, rate]));
    for (const [index, line] of deleted.lines.entries()) {
      if (!line.exchangeRateId) continue;
      const rate = byId.get(line.exchangeRateId);
      if (!rate) continue;
      if (
        rate.baseCurrency !== line.originalCurrency ||
        rate.quoteCurrency !== deleted.header.functionalCurrency ||
        line.exchangeRate === null ||
        !decimalsEqual(rate.rate, line.exchangeRate)
      ) {
        addIssue(
          analysis.issues,
          "fx_rate_evidence_mismatch",
          `Line ${index + 1} FX-rate record does not match its snapshotted currency/rate fields.`,
        );
      }
    }
  }

  if (deleted.header.sourceDocumentId && deleted.header.sourceDocumentType) {
    const sourceDocumentType = deleted.header.sourceDocumentType.toLowerCase();
    if (sourceDocumentType !== "bill" && sourceDocumentType !== "invoice") {
      addIssue(
        analysis.issues,
        "unsupported_source_document_type",
        `Cannot validate polymorphic source document type ${deleted.header.sourceDocumentType}.`,
      );
    } else {
      const table = sourceDocumentType === "bill" ? "bills" : "invoices";
      const rows = await query.unsafe<Array<{ id: string }>>(
        `SELECT id FROM ${table} WHERE id = $1::uuid AND organization_id = $2 LIMIT 1`,
        [deleted.header.sourceDocumentId, history.organizationId],
      );
      if (rows.length === 0) {
        addIssue(
          analysis.issues,
          "missing_source_document",
          `Deleted journal ${sourceDocumentType} source document is missing or belongs to another organization.`,
        );
      }
    }
  }

  const canonicalOwners = new Set<string>();
  if (survivor.sourceDocumentId && survivor.sourceDocumentType) {
    canonicalOwners.add(
      `${survivor.sourceDocumentType.toLowerCase()}:${survivor.sourceDocumentId}`,
    );
  }
  const operationalOwners = await query<Array<{ owner: string }>>`
    SELECT 'bill:' || id::text AS owner
    FROM bills
    WHERE
      organization_id = ${history.organizationId}
      AND journal_header_id = ${survivor.id}::uuid
    UNION ALL
    SELECT 'invoice:' || id::text AS owner
    FROM invoices
    WHERE
      organization_id = ${history.organizationId}
      AND journal_header_id = ${survivor.id}::uuid
  `;
  for (const row of operationalOwners) canonicalOwners.add(row.owner);
  const duplicateOwners = new Set<string>();
  if (deleted.header.sourceDocumentId && deleted.header.sourceDocumentType) {
    duplicateOwners.add(
      `${deleted.header.sourceDocumentType.toLowerCase()}:${deleted.header.sourceDocumentId}`,
    );
  }
  if (!sameDomainOwner(canonicalOwners, duplicateOwners)) {
    addIssue(
      analysis.issues,
      "incompatible_domain_owner",
      "The deleted journal has stronger or conflicting bill/invoice ownership.",
    );
  }

  const sourceClasses = await query<Array<{ eventClass: string }>>`
    SELECT DISTINCT source_record.economic_event_class AS "eventClass"
    FROM ledger_source_links AS link
    INNER JOIN source_records AS source_record ON source_record.id = link.source_record_id
    WHERE
      link.organization_id = ${history.organizationId}
      AND link.journal_header_id = ${survivor.id}::uuid
      AND link.relationship = 'origin'
  `;
  const deletedClass = fallbackEventClass(deleted.header.source, deleted.header.transactionType);
  for (const sourceClass of sourceClasses) {
    if (!eventClassesCompatible(sourceClass.eventClass, deletedClass)) {
      addIssue(
        analysis.issues,
        "source_event_class_mismatch",
        `Surviving source class ${sourceClass.eventClass} is incompatible with deleted class ${deletedClass}.`,
      );
    }
  }
  return analysis;
}

function resultFromAnalysis(
  analysis: HistoryAnalysis,
  outcome: ProcessResult["outcome"],
  mergeId?: string,
): ProcessResult {
  return {
    historyId: analysis.history.id,
    organizationId: analysis.history.organizationId,
    survivingHeaderId: analysis.history.survivingHeaderId,
    snapshotHeaderId: analysis.snapshotHeaderId,
    outcome,
    mergeId,
    issueCodes: [...new Set(analysis.issues.map((issue) => issue.code))],
    issues: analysis.issues,
  };
}

async function recordQuarantine(
  query: QueryClient,
  analysis: HistoryAnalysis,
  actor: string,
): Promise<ProcessResult> {
  const reasonCodes = [...new Set(analysis.issues.map((issue) => issue.code))];
  const details = {
    issues: analysis.issues,
    survivingHeaderId: analysis.history.survivingHeaderId,
    matchedAt: analysis.history.matchedAt.toISOString(),
    matchedBy: analysis.history.matchedBy,
    note: "Legacy state and snapshots were left untouched for manual review.",
  };
  await query`
    INSERT INTO legacy_match_conversion_records (
      organization_id,
      legacy_match_history_id,
      status,
      journal_duplicate_merge_id,
      snapshot_duplicate_header_id,
      snapshot_digest,
      validator_version,
      reason_codes,
      details,
      processed_by
    )
    VALUES (
      ${analysis.history.organizationId},
      ${analysis.history.id}::uuid,
      'quarantined',
      NULL,
      ${analysis.snapshotHeaderId}::uuid,
      ${analysis.snapshotDigest},
      ${LEGACY_MATCH_VALIDATOR_VERSION},
      ${query.json(reasonCodes)},
      ${query.json(details)},
      ${actor}
    )
  `;
  await query`
    INSERT INTO activity_logs (
      organization_id, entity_type, entity_id, action, actor_id, changes
    )
    VALUES (
      ${analysis.history.organizationId},
      'legacy_match_history',
      ${analysis.history.id}::uuid,
      'legacy_match_quarantined',
      ${actor},
      ${query.json({ reasonCodes, snapshotDigest: analysis.snapshotDigest })}
    )
  `;
  await query`
    INSERT INTO workflow_events (
      organization_id,
      entity_type,
      entity_id,
      action,
      actor_type,
      actor_id,
      idempotency_key,
      data
    )
    VALUES (
      ${analysis.history.organizationId},
      'legacy_match_history',
      ${analysis.history.id}::uuid,
      'legacy_match_quarantined',
      'system',
      ${actor},
      ${`legacy-match-quarantine:${analysis.history.id}`},
      ${query.json({ reasonCodes, snapshotDigest: analysis.snapshotDigest })}
    )
    ON CONFLICT (organization_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING
  `;
  return resultFromAnalysis(analysis, "quarantined");
}

async function restoreAndConvert(
  query: QueryClient,
  analysis: HistoryAnalysis,
  actor: string,
): Promise<ProcessResult> {
  if (!analysis.validated) throw new Error("Cannot restore an invalid legacy snapshot.");
  const { header, lines, snapshotDigest } = analysis.validated;

  await query`
    INSERT INTO journal_headers (
      id,
      organization_id,
      transaction_number,
      reference_number,
      idempotency_key,
      transaction_date,
      transaction_type,
      source,
      memo,
      party_id,
      total_amount,
      functional_currency,
      transaction_currency,
      exchange_rate_id,
      status,
      source_document_id,
      source_document_type,
      created_by,
      created_at,
      updated_at,
      posted_at,
      voided_at,
      duplicate_of_header_id,
      matched_from_ids,
      is_matched
    )
    VALUES (
      ${header.id}::uuid,
      ${header.organizationId},
      ${header.transactionNumber},
      ${header.referenceNumber},
      ${header.idempotencyKey},
      ${header.transactionDate}::date,
      ${header.transactionType}::transaction_type,
      ${header.source}::journal_source,
      ${header.memo},
      ${header.partyId}::uuid,
      ${header.totalAmount}::numeric,
      ${header.functionalCurrency},
      ${header.transactionCurrency},
      ${header.exchangeRateId}::uuid,
      ${header.status}::journal_status,
      ${header.sourceDocumentId}::uuid,
      ${header.sourceDocumentType},
      ${header.createdBy},
      ${header.createdAt},
      ${header.updatedAt},
      ${header.postedAt},
      ${header.voidedAt},
      NULL,
      '{}'::uuid[],
      false
    )
  `;
  for (const line of lines) {
    await query`
      INSERT INTO journal_lines (
        id,
        journal_header_id,
        account_id,
        debit,
        credit,
        original_debit,
        original_credit,
        original_currency,
        exchange_rate,
        exchange_rate_id,
        line_description,
        party_id,
        department_id,
        location_id,
        sort_order,
        created_at
      )
      VALUES (
        ${line.id}::uuid,
        ${line.journalHeaderId}::uuid,
        ${line.accountId}::uuid,
        ${line.debit}::numeric,
        ${line.credit}::numeric,
        ${line.originalDebit}::numeric,
        ${line.originalCredit}::numeric,
        ${line.originalCurrency},
        ${line.exchangeRate}::numeric,
        ${line.exchangeRateId}::uuid,
        ${line.lineDescription},
        ${line.partyId}::uuid,
        ${line.departmentId}::uuid,
        ${line.locationId}::uuid,
        ${line.sortOrder},
        ${line.createdAt}
      )
    `;
  }

  const [restoredTotals] = await query<
    Array<{ lineCount: number; debitTotal: string; creditTotal: string }>
  >`
    SELECT
      count(*)::integer AS "lineCount",
      coalesce(sum(coalesce(debit, 0)), 0)::text AS "debitTotal",
      coalesce(sum(coalesce(credit, 0)), 0)::text AS "creditTotal"
    FROM journal_lines
    WHERE journal_header_id = ${header.id}::uuid
  `;
  if (
    restoredTotals.lineCount !== lines.length ||
    !decimalsEqual(restoredTotals.debitTotal, analysis.validated.debitTotal) ||
    !decimalsEqual(restoredTotals.creditTotal, analysis.validated.creditTotal)
  ) {
    throw new Error("Restored journal failed the post-insert line-total verification.");
  }

  const pairKey = [analysis.history.survivingHeaderId, header.id].sort().join(":");
  const idempotencyKey = `legacy-match-history:${analysis.history.id}`;
  const evidence = {
    legacyMatchHistoryId: analysis.history.id,
    snapshotDigest,
    validatorVersion: LEGACY_MATCH_VALIDATOR_VERSION,
    originalMatchedAt: analysis.history.matchedAt.toISOString(),
    originalMatchedBy: analysis.history.matchedBy,
    canonicalMetadataPreviouslyModifiedByLegacyWorkflow: true,
  };
  const [merge] = await query<Array<{ id: string }>>`
    INSERT INTO journal_duplicate_merges (
      organization_id,
      canonical_header_id,
      duplicate_header_id,
      pair_key,
      state,
      reason,
      evidence,
      idempotency_key,
      matched_at,
      matched_by
    )
    VALUES (
      ${analysis.history.organizationId},
      ${analysis.history.survivingHeaderId}::uuid,
      ${header.id}::uuid,
      ${pairKey},
      'active',
      'Converted from a complete, validated destructive legacy match snapshot.',
      ${query.json(evidence)},
      ${idempotencyKey},
      ${analysis.history.matchedAt},
      ${analysis.history.matchedBy ?? actor}
    )
    RETURNING id
  `;

  const [suppressed] = await query<Array<{ id: string }>>`
    UPDATE journal_headers
    SET duplicate_of_header_id = ${analysis.history.survivingHeaderId}::uuid, updated_at = now()
    WHERE id = ${header.id}::uuid AND duplicate_of_header_id IS NULL
    RETURNING id
  `;
  if (!suppressed) throw new Error("Restored duplicate changed before it could be suppressed.");

  const [legacyCleared] = await query<Array<{ id: string }>>`
    UPDATE journal_headers
    SET is_matched = false, matched_from_ids = '{}'::uuid[], updated_at = now()
    WHERE
      id = ${analysis.history.survivingHeaderId}::uuid
      AND organization_id = ${analysis.history.organizationId}
      AND is_matched = true
      AND matched_from_ids = ARRAY[${header.id}::uuid]
    RETURNING id
  `;
  if (!legacyCleared) {
    throw new Error(
      "Surviving legacy journal changed before its compatibility flags were cleared.",
    );
  }

  await query`
    INSERT INTO legacy_match_conversion_records (
      organization_id,
      legacy_match_history_id,
      status,
      journal_duplicate_merge_id,
      snapshot_duplicate_header_id,
      snapshot_digest,
      validator_version,
      reason_codes,
      details,
      processed_by
    )
    VALUES (
      ${analysis.history.organizationId},
      ${analysis.history.id}::uuid,
      'converted',
      ${merge.id}::uuid,
      ${header.id}::uuid,
      ${snapshotDigest},
      ${LEGACY_MATCH_VALIDATOR_VERSION},
      '[]'::jsonb,
      ${query.json({
        lineCount: lines.length,
        debitTotal: analysis.validated.debitTotal,
        creditTotal: analysis.validated.creditTotal,
        note: "The deleted journal and lines were restored exactly from the validated snapshot before suppression.",
      })},
      ${actor}
    )
  `;
  await query`
    INSERT INTO activity_logs (
      organization_id, entity_type, entity_id, action, actor_id, changes
    )
    VALUES
      (
        ${analysis.history.organizationId},
        'transaction',
        ${analysis.history.survivingHeaderId}::uuid,
        'legacy_match_converted',
        ${actor},
        ${query.json({ mergeId: merge.id, restoredDuplicateId: header.id, snapshotDigest })}
      ),
      (
        ${analysis.history.organizationId},
        'transaction',
        ${header.id}::uuid,
        'restored_as_duplicate',
        ${actor},
        ${query.json({
          mergeId: merge.id,
          canonicalJournalId: analysis.history.survivingHeaderId,
          snapshotDigest,
        })}
      )
  `;
  await query`
    INSERT INTO workflow_events (
      organization_id,
      entity_type,
      entity_id,
      action,
      actor_type,
      actor_id,
      idempotency_key,
      data
    )
    VALUES (
      ${analysis.history.organizationId},
      'journal_duplicate_merge',
      ${merge.id}::uuid,
      'legacy_match_converted',
      'system',
      ${actor},
      ${`legacy-match-converted:${analysis.history.id}`},
      ${query.json({
        legacyMatchHistoryId: analysis.history.id,
        canonicalJournalId: analysis.history.survivingHeaderId,
        restoredDuplicateId: header.id,
        snapshotDigest,
      })}
    )
    ON CONFLICT (organization_id, idempotency_key)
      WHERE idempotency_key IS NOT NULL
      DO NOTHING
  `;
  return resultFromAnalysis(analysis, "converted", merge.id);
}

async function processOne(
  client: QueryClient,
  selected: LegacyHistoryRow,
  actor: string,
): Promise<ProcessResult> {
  return client.begin(async (tx) => {
    const query = tx as unknown as QueryClient;
    await query`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${"legacy-match-conversion:" + selected.id}, 0::bigint)
      )
    `;
    const [existing] = await query<Array<{ status: string; mergeId: string | null }>>`
      SELECT status, journal_duplicate_merge_id AS "mergeId"
      FROM legacy_match_conversion_records
      WHERE legacy_match_history_id = ${selected.id}::uuid
      FOR UPDATE
    `;
    if (existing) {
      return {
        historyId: selected.id,
        organizationId: selected.organizationId,
        survivingHeaderId: selected.survivingHeaderId,
        snapshotHeaderId: snapshotHeaderId(selected.deletedHeaderSnapshot),
        outcome: "already_processed",
        mergeId: existing.mergeId ?? undefined,
        issueCodes: [],
        issues: [],
      };
    }

    const [history] = await query<LegacyHistoryRow[]>`
      SELECT
        id,
        organization_id AS "organizationId",
        surviving_header_id AS "survivingHeaderId",
        deleted_header_snapshot AS "deletedHeaderSnapshot",
        deleted_lines_snapshot AS "deletedLinesSnapshot",
        matched_at AS "matchedAt",
        matched_by AS "matchedBy"
      FROM match_history
      WHERE
        id = ${selected.id}::uuid
        AND organization_id = ${selected.organizationId}
        AND unmatched_at IS NULL
      FOR UPDATE
    `;
    if (!history) {
      throw new Error(`Legacy match ${selected.id} is no longer active.`);
    }

    await query`
      SELECT id
      FROM journal_headers
      WHERE id = ${history.survivingHeaderId}::uuid
      FOR UPDATE
    `;
    const analysis = await analyzeHistory(query, history);
    if (analysis.issues.length > 0) {
      return recordQuarantine(query, analysis, actor);
    }
    return restoreAndConvert(query, analysis, actor);
  });
}

async function reportQuarantines(client: QueryClient, options: CliOptions): Promise<void> {
  const rows = await client<
    Array<{
      id: string;
      organizationId: string;
      legacyMatchHistoryId: string;
      survivingHeaderId: string;
      snapshotDuplicateHeaderId: string | null;
      reasonCodes: string[];
      details: Record<string, unknown>;
      processedAt: Date;
      processedBy: string;
      reviewedAt: Date | null;
      reviewedBy: string | null;
      reviewNote: string | null;
    }>
  >`
    SELECT
      conversion.id,
      conversion.organization_id AS "organizationId",
      conversion.legacy_match_history_id AS "legacyMatchHistoryId",
      history.surviving_header_id AS "survivingHeaderId",
      conversion.snapshot_duplicate_header_id AS "snapshotDuplicateHeaderId",
      conversion.reason_codes AS "reasonCodes",
      conversion.details,
      conversion.processed_at AS "processedAt",
      conversion.processed_by AS "processedBy",
      conversion.reviewed_at AS "reviewedAt",
      conversion.reviewed_by AS "reviewedBy",
      conversion.review_note AS "reviewNote"
    FROM legacy_match_conversion_records AS conversion
    INNER JOIN match_history AS history ON history.id = conversion.legacy_match_history_id
    WHERE
      conversion.status = 'quarantined'
      AND (
        ${options.organizationId}::text IS NULL
        OR conversion.organization_id = ${options.organizationId}
      )
    ORDER BY conversion.processed_at, conversion.id
    LIMIT ${options.limit}
  `;
  if (options.json) {
    console.log(JSON.stringify({ mode: "quarantine_report", rows }, null, 2));
    return;
  }
  console.log("Legacy match manual-quarantine report");
  console.log(`Scope: ${options.organizationId ?? "all organizations"}`);
  console.log(`Rows: ${rows.length}\n`);
  console.table(
    rows.map((row) => ({
      historyId: row.legacyMatchHistoryId,
      organizationId: row.organizationId,
      survivor: row.survivingHeaderId,
      snapshotLoser: row.snapshotDuplicateHeaderId,
      reasons: row.reasonCodes.join(", "),
      processedAt: row.processedAt.toISOString(),
      reviewed: row.reviewedAt ? "yes" : "no",
    })),
  );
}

function printResults(results: ProcessResult[], options: CliOptions): void {
  if (options.json) {
    console.log(
      JSON.stringify(
        {
          mode: options.apply ? "apply" : "dry_run",
          scope: options.organizationId,
          validatorVersion: LEGACY_MATCH_VALIDATOR_VERSION,
          results,
        },
        null,
        2,
      ),
    );
    return;
  }
  console.log("Legacy destructive match conversion");
  console.log(`Scope: ${options.organizationId ?? "all organizations"}`);
  console.log(`Mode: ${options.apply ? "APPLY" : "DRY RUN (read only)"}`);
  console.log(`Validator: ${LEGACY_MATCH_VALIDATOR_VERSION}\n`);
  console.table(
    results.map((result) => ({
      historyId: result.historyId,
      organizationId: result.organizationId,
      survivor: result.survivingHeaderId,
      snapshotLoser: result.snapshotHeaderId,
      outcome: result.outcome,
      reasons: result.issueCodes.join(", "),
    })),
  );
  const counts = results.reduce<Record<string, number>>((totals, result) => {
    totals[result.outcome] = (totals[result.outcome] ?? 0) + 1;
    return totals;
  }, {});
  console.log("\nSummary:", counts);
  if (!options.apply) {
    console.log(
      "No data was changed. Re-run with --apply only after reviewing every convertible and quarantine result.",
    );
  }
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required.");
  const client = postgres(databaseUrl, {
    max: options.apply ? 2 : 1,
    prepare: false,
    onnotice: () => undefined,
  });
  try {
    await assertRequiredSchema(client);
    if (options.quarantines) {
      await reportQuarantines(client, options);
      return;
    }
    const rows = await listUnprocessed(client, options);
    const results: ProcessResult[] = [];
    for (const history of rows) {
      if (options.apply) {
        results.push(await processOne(client, history, options.actor));
      } else {
        const analysis = await client.begin("read only", async (tx) =>
          analyzeHistory(tx as unknown as QueryClient, history),
        );
        results.push(
          resultFromAnalysis(
            analysis,
            analysis.issues.length === 0 ? "convertible" : "would_quarantine",
          ),
        );
      }
    }
    printResults(results, options);
  } finally {
    await client.end();
  }
}

run().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
