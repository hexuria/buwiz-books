import { and, eq, gte, inArray, isNull, lte, sql } from "drizzle-orm";
import { db, withOrgContext, type DbExecutor } from "../src/db";
import { organization } from "../src/db/schema/auth";
import { documentAttachments, documents } from "../src/db/schema/documents";
import {
  integrationSources,
  ledgerSourceLinks,
  sourceRecordDocuments,
  sourceRecordVersions,
  sourceRecords,
} from "../src/db/schema/inbox";
import { journalHeaders } from "../src/db/schema/journals";
import { parties } from "../src/db/schema/parties";
import { runDuplicateMatchingForSource } from "../src/lib/inbox/duplicate-engine";
import {
  DUPLICATE_MATCHER_VERSION,
  normalizeDuplicateMatchInput,
  type EconomicEventClass,
  type TransactionDirection,
} from "../src/lib/inbox/duplicate-matcher";
import { scopedIdempotencyUuid } from "../src/lib/idempotency";

const SYSTEM_ACTOR_ID = "system:dedup-backfill";

interface CliOptions {
  apply: boolean;
  organizationId: string | null;
  asOfDate: string;
  limit: number | null;
}

interface LegacyJournal {
  id: string;
  organizationId: string;
  organizationName: string;
  transactionNumber: string | null;
  referenceNumber: string | null;
  transactionDate: string;
  transactionType: "pay_in" | "pay_out" | "journal" | "transfer";
  source:
    | "manual"
    | "import"
    | "document"
    | "email"
    | "integration"
    | "invoice"
    | "bill"
    | "payment"
    | "reconciliation"
    | "system";
  memo: string | null;
  partyName: string | null;
  totalAmount: string | null;
  functionalCurrency: string;
  transactionCurrency: string | null;
  sourceDocumentType: string | null;
}

interface AppliedJournalResult {
  status: "created" | "already_linked";
  sourceRecordId: string | null;
  blockingCases: number;
  shadowCases: number;
}

function usage(): string {
  return `Twelve-month transaction deduplication backfill

Usage:
  bun run dedup:backfill [--org=<organization-id>] [--as-of=YYYY-MM-DD] [--limit=N]
  bun run dedup:backfill --apply [--org=<organization-id>] [--as-of=YYYY-MM-DD] [--limit=N]

The default is a read-only dry run. --apply only creates legacy source evidence,
ledger-source links, and matcher review cases. It never merges journal entries.
`;
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

function validIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

function parseOptions(argv: string[]): CliOptions {
  let apply = false;
  let organizationId: string | null = null;
  let asOfDate = todayIso();
  let limit: number | null = null;

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
    if (argument === "--org") {
      organizationId = argv[index + 1]?.trim() || null;
      index += 1;
      continue;
    }
    if (argument.startsWith("--org=")) {
      organizationId = argument.slice("--org=".length).trim() || null;
      continue;
    }
    if (argument === "--as-of") {
      asOfDate = argv[index + 1]?.trim() || "";
      index += 1;
      continue;
    }
    if (argument.startsWith("--as-of=")) {
      asOfDate = argument.slice("--as-of=".length).trim();
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

  if (!validIsoDate(asOfDate)) throw new Error("--as-of must be a valid YYYY-MM-DD date.");
  if (limit !== null && (!Number.isInteger(limit) || limit < 1 || limit > 100_000)) {
    throw new Error("--limit must be an integer between 1 and 100000.");
  }
  return { apply, organizationId, asOfDate, limit };
}

function twelveMonthsBefore(value: string): string {
  const [year, month, day] = value.split("-").map(Number);
  const daysInTargetMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const target = new Date(Date.UTC(year - 1, month - 1, Math.min(day, daysInTargetMonth)));
  return target.toISOString().slice(0, 10);
}

function classifyJournal(journal: LegacyJournal): {
  economicEventClass: EconomicEventClass;
  direction: TransactionDirection;
} {
  if (journal.source === "bill") {
    return { economicEventClass: "bill_accrual", direction: "outflow" };
  }
  if (journal.source === "invoice") {
    return { economicEventClass: "invoice_accrual", direction: "inflow" };
  }
  if (journal.source === "payment") {
    return journal.transactionType === "pay_in"
      ? { economicEventClass: "invoice_payment", direction: "inflow" }
      : { economicEventClass: "bill_payment", direction: "outflow" };
  }
  const normalizedMemo = journal.memo?.trim().toLowerCase() ?? "";
  if (journal.sourceDocumentType === "invoice") {
    if (normalizedMemo.startsWith("payment")) {
      return { economicEventClass: "invoice_payment", direction: "inflow" };
    }
    if (normalizedMemo.startsWith("invoice issued")) {
      return { economicEventClass: "invoice_accrual", direction: "inflow" };
    }
    return { economicEventClass: "other", direction: "unknown" };
  }
  if (journal.sourceDocumentType === "bill") {
    if (normalizedMemo.startsWith("bill payment")) {
      return { economicEventClass: "bill_payment", direction: "outflow" };
    }
    if (normalizedMemo.startsWith("bill accrual")) {
      return { economicEventClass: "bill_accrual", direction: "outflow" };
    }
    return { economicEventClass: "other", direction: "unknown" };
  }
  switch (journal.transactionType) {
    case "pay_in":
      return { economicEventClass: "sale", direction: "inflow" };
    case "pay_out":
      return { economicEventClass: "purchase", direction: "outflow" };
    case "transfer":
      return { economicEventClass: "transfer", direction: "neutral" };
    default:
      return { economicEventClass: "other", direction: "unknown" };
  }
}

async function findEligibleJournals(options: CliOptions): Promise<LegacyJournal[]> {
  const predicates = [
    eq(journalHeaders.status, "posted"),
    gte(journalHeaders.transactionDate, twelveMonthsBefore(options.asOfDate)),
    lte(journalHeaders.transactionDate, options.asOfDate),
    isNull(journalHeaders.duplicateOfHeaderId),
    isNull(ledgerSourceLinks.journalHeaderId),
  ];
  if (options.organizationId) {
    predicates.push(eq(journalHeaders.organizationId, options.organizationId));
  }

  let query = db
    .select({
      id: journalHeaders.id,
      organizationId: journalHeaders.organizationId,
      organizationName: organization.name,
      transactionNumber: journalHeaders.transactionNumber,
      referenceNumber: journalHeaders.referenceNumber,
      transactionDate: journalHeaders.transactionDate,
      transactionType: journalHeaders.transactionType,
      source: journalHeaders.source,
      memo: journalHeaders.memo,
      partyName: parties.name,
      totalAmount: journalHeaders.totalAmount,
      functionalCurrency: journalHeaders.functionalCurrency,
      transactionCurrency: journalHeaders.transactionCurrency,
      sourceDocumentType: journalHeaders.sourceDocumentType,
    })
    .from(journalHeaders)
    .innerJoin(organization, eq(organization.id, journalHeaders.organizationId))
    .leftJoin(parties, eq(parties.id, journalHeaders.partyId))
    .leftJoin(
      ledgerSourceLinks,
      and(
        eq(ledgerSourceLinks.journalHeaderId, journalHeaders.id),
        eq(ledgerSourceLinks.relationship, "origin"),
      ),
    )
    .where(and(...predicates))
    .orderBy(journalHeaders.organizationId, journalHeaders.transactionDate, journalHeaders.id)
    .$dynamic();
  if (options.limit !== null) query = query.limit(options.limit);
  return query;
}

async function ensureLegacyIntegrationSource(
  tx: DbExecutor,
  organizationId: string,
): Promise<string> {
  const provider = "legacy_ledger";
  const externalSourceId = "legacy-ledger";
  const [created] = await tx
    .insert(integrationSources)
    .values({
      id: scopedIdempotencyUuid("dedup-backfill-integration-source", organizationId),
      organizationId,
      provider,
      channel: "ledger",
      externalSourceId,
      name: "Legacy posted ledger",
      status: "active",
    })
    .onConflictDoNothing()
    .returning({ id: integrationSources.id });
  if (created) return created.id;

  const [existing] = await tx
    .select({ id: integrationSources.id })
    .from(integrationSources)
    .where(
      and(
        eq(integrationSources.organizationId, organizationId),
        eq(integrationSources.provider, provider),
        eq(integrationSources.externalSourceId, externalSourceId),
      ),
    )
    .limit(1);
  if (!existing) throw new Error("Could not initialize the legacy ledger integration source.");
  return existing.id;
}

async function sourceDocumentsForJournal(
  tx: DbExecutor,
  journal: LegacyJournal,
): Promise<Array<{ id: string; contentHash: string | null }>> {
  return tx
    .selectDistinct({ id: documents.id, contentHash: documents.contentHash })
    .from(documentAttachments)
    .innerJoin(documents, eq(documents.id, documentAttachments.documentId))
    .where(
      and(
        eq(documentAttachments.organizationId, journal.organizationId),
        inArray(documentAttachments.linkableType, ["journal_header", "transaction"]),
        eq(documentAttachments.linkableId, journal.id),
      ),
    );
}

async function applyJournal(journal: LegacyJournal): Promise<AppliedJournalResult> {
  return withOrgContext(
    journal.organizationId,
    SYSTEM_ACTOR_ID,
    "owner",
    async (tx): Promise<AppliedJournalResult> => {
      await tx.execute(sql`
        SELECT pg_advisory_xact_lock(
          hashtextextended(
            ${"dedup-backfill:" + journal.organizationId + ":" + journal.id},
            0::bigint
          )
        )
      `);
      const [linked] = await tx
        .select({ sourceRecordId: ledgerSourceLinks.sourceRecordId })
        .from(ledgerSourceLinks)
        .where(
          and(
            eq(ledgerSourceLinks.organizationId, journal.organizationId),
            eq(ledgerSourceLinks.journalHeaderId, journal.id),
            eq(ledgerSourceLinks.relationship, "origin"),
          ),
        )
        .limit(1);
      if (linked) {
        return {
          status: "already_linked",
          sourceRecordId: linked.sourceRecordId,
          blockingCases: 0,
          shadowCases: 0,
        };
      }

      const integrationSourceId = await ensureLegacyIntegrationSource(tx, journal.organizationId);
      const journalDocuments = await sourceDocumentsForJournal(tx, journal);
      const classification = classifyJournal(journal);
      // totalAmount is the posted functional amount. Do not pair it with a
      // foreign transaction currency and pretend it is the original amount.
      // The raw transaction currency is retained below for a later enriched
      // backfill if exact original-line amounts become available.
      const matchingCurrency = journal.functionalCurrency.toUpperCase();
      const normalized = normalizeDuplicateMatchInput({
        economicEventClass: classification.economicEventClass,
        direction: classification.direction,
        originalAmount: journal.totalAmount,
        originalCurrency: matchingCurrency,
        effectiveDate: journal.transactionDate,
        party: journal.partyName,
        reference: journal.referenceNumber,
        description: journal.memo,
        provider: "legacy_ledger",
        documentHashes: journalDocuments.flatMap(({ contentHash }) =>
          contentHash ? [contentHash] : [],
        ),
      });
      const sourceRecordId = scopedIdempotencyUuid(
        `dedup-backfill-source:${journal.organizationId}`,
        journal.id,
      );
      const rawData = {
        backfilledFrom: "journal_header",
        journalHeaderId: journal.id,
        transactionNumber: journal.transactionNumber,
        journalSource: journal.source,
        transactionType: journal.transactionType,
        transactionCurrency: journal.transactionCurrency,
        matchingAmountBasis: "functional_total",
      };

      await tx
        .insert(sourceRecords)
        .values({
          id: sourceRecordId,
          organizationId: journal.organizationId,
          sourceId: integrationSourceId,
          recordType: "legacy_journal",
          externalId: journal.id,
          externalVersion: "1",
          providerStatus: "posted",
          recordState: "active",
          transactionDate: journal.transactionDate,
          description: journal.memo,
          amount: normalized.originalAmount,
          currency: matchingCurrency,
          economicEventClass: classification.economicEventClass,
          direction: classification.direction,
          originalAmount: normalized.originalAmount,
          originalCurrency: matchingCurrency,
          functionalAmount: normalized.originalAmount,
          functionalCurrency: journal.functionalCurrency,
          effectiveDate: journal.transactionDate,
          normalizedParty: normalized.normalizedParty,
          normalizedReference: normalized.normalizedReference,
          matcherInputHash: normalized.inputHash,
          matcherVersion: DUPLICATE_MATCHER_VERSION,
          rawData,
        })
        .onConflictDoNothing();
      await tx
        .update(sourceRecords)
        .set({
          economicEventClass: classification.economicEventClass,
          direction: classification.direction,
          originalAmount: normalized.originalAmount,
          originalCurrency: matchingCurrency,
          functionalAmount: normalized.originalAmount,
          functionalCurrency: journal.functionalCurrency,
          effectiveDate: journal.transactionDate,
          normalizedParty: normalized.normalizedParty,
          normalizedReference: normalized.normalizedReference,
          matcherInputHash: normalized.inputHash,
          matcherVersion: DUPLICATE_MATCHER_VERSION,
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(sourceRecords.id, sourceRecordId),
            eq(sourceRecords.organizationId, journal.organizationId),
          ),
        );
      await tx
        .insert(sourceRecordVersions)
        .values({
          organizationId: journal.organizationId,
          sourceRecordId,
          externalVersion: "1",
          providerStatus: "posted",
          rawData,
          occurredAt: new Date(`${journal.transactionDate}T00:00:00.000Z`),
        })
        .onConflictDoNothing();
      if (journalDocuments.length > 0) {
        await tx
          .insert(sourceRecordDocuments)
          .values(
            journalDocuments.map(({ id }) => ({
              organizationId: journal.organizationId,
              sourceRecordId,
              documentId: id,
              relationship: "evidence",
            })),
          )
          .onConflictDoNothing();
      }
      await tx.insert(ledgerSourceLinks).values({
        organizationId: journal.organizationId,
        journalHeaderId: journal.id,
        sourceRecordId,
        relationship: "origin",
      });

      const matchResult = await runDuplicateMatchingForSource(
        { db: tx, orgId: journal.organizationId, userId: SYSTEM_ACTOR_ID },
        sourceRecordId,
        "backfill",
      );
      return {
        status: "created",
        sourceRecordId,
        blockingCases: matchResult.blockingCases.length,
        shadowCases: matchResult.shadowCases.length,
      };
    },
  );
}

function printDryRun(journals: LegacyJournal[], options: CliOptions, windowStart: string): void {
  const byOrganization = new Map<string, { name: string; count: number }>();
  for (const journal of journals) {
    const summary = byOrganization.get(journal.organizationId) ?? {
      name: journal.organizationName,
      count: 0,
    };
    summary.count += 1;
    byOrganization.set(journal.organizationId, summary);
  }

  console.log("Transaction deduplication backfill: DRY RUN");
  console.log(`Window: ${windowStart} through ${options.asOfDate}`);
  console.log(`Scope: ${options.organizationId ?? "all organizations"}`);
  console.log(`Eligible effective posted journals without an origin source: ${journals.length}\n`);
  console.table(
    [...byOrganization.entries()].map(([organizationId, summary]) => ({
      organizationId,
      organizationName: summary.name,
      eligibleJournals: summary.count,
    })),
  );
  if (journals.length > 0) {
    console.log("Sample:");
    console.table(
      journals.slice(0, 20).map((journal) => ({
        organizationId: journal.organizationId,
        journalId: journal.id,
        transactionNumber: journal.transactionNumber,
        date: journal.transactionDate,
        amount: journal.totalAmount,
        currency: journal.transactionCurrency ?? journal.functionalCurrency,
      })),
    );
  }
  console.log("\nNo data was changed. Re-run with --apply to create evidence and review cases.");
}

async function run(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  const windowStart = twelveMonthsBefore(options.asOfDate);
  const journals = await findEligibleJournals(options);
  if (!options.apply) {
    printDryRun(journals, options, windowStart);
    return;
  }

  console.log("Transaction deduplication backfill: APPLY");
  console.log(`Window: ${windowStart} through ${options.asOfDate}`);
  console.log(`Journals selected: ${journals.length}`);
  console.log("Safety invariant: this command never merges or deletes journal entries.\n");

  let created = 0;
  let alreadyLinked = 0;
  let blockingCases = 0;
  let shadowCases = 0;
  for (const [index, journal] of journals.entries()) {
    const result = await applyJournal(journal);
    if (result.status === "created") created += 1;
    if (result.status === "already_linked") alreadyLinked += 1;
    blockingCases += result.blockingCases;
    shadowCases += result.shadowCases;
    if ((index + 1) % 25 === 0 || index + 1 === journals.length) {
      console.log(`Processed ${index + 1}/${journals.length} journal(s).`);
    }
  }

  console.log("\nBackfill complete.");
  console.table({
    selected: journals.length,
    sourcesAndLinksCreated: created,
    alreadyLinked,
    blockingCases,
    shadowCases,
    journalsMerged: 0,
  });
}

run()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
