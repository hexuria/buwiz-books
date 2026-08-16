import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { DbExecutor } from "@/db";
import { activityLogs } from "@/db/schema/activity-logs";
import { bills } from "@/db/schema/bills";
import { invoices } from "@/db/schema/invoices";
import { journalHeaders, journalLines } from "@/db/schema/journals";
import { journalDuplicateMerges } from "@/db/schema/match-history";
import {
  integrationSources,
  ledgerSourceLinks,
  sourceMatchCandidates,
  sourceRecords,
  workflowEvents,
} from "@/db/schema/inbox";
import { statementLines } from "@/db/schema/reconciliations";
import { getClosedThrough, isDateLocked } from "@/lib/period-close";

type JournalHeader = typeof journalHeaders.$inferSelect;
type MergeRow = typeof journalDuplicateMerges.$inferSelect;

export interface JournalMergeReadContext {
  db: DbExecutor;
  orgId: string;
}

export interface JournalMergeWriteContext extends JournalMergeReadContext {
  userId: string;
}

export interface DuplicateJournalPairInput {
  canonicalJournalId: string;
  duplicateJournalId: string;
}

export interface MergeDuplicateJournalsInput extends DuplicateJournalPairInput {
  duplicateCaseId?: string;
  reason: string;
  idempotencyKey: string;
}

export interface UnmergeDuplicateJournalsInput {
  mergeId: string;
  reason: string;
  idempotencyKey: string;
}

export interface JournalMergeFact {
  id: string;
  transactionNumber: string | null;
  transactionDate: string;
  transactionType: JournalHeader["transactionType"];
  status: JournalHeader["status"];
  totalAmount: string | null;
  currency: string;
  functionalCurrency: string;
  duplicateOfHeaderId: string | null;
  debitTotal: string;
  creditTotal: string;
  originalDebitTotal: string;
  originalCreditTotal: string;
  originalAmountsComplete: boolean;
  originalCurrencies: string[];
  reconciliationCount: number;
  domainOwners: string[];
  economicEventClasses: string[];
  operationalOrigins: JournalOperationalOriginFact[];
  paymentIdentityTokens: string[];
}

export interface JournalOperationalOriginFact {
  sourceRecordId: string;
  integrationSourceId: string | null;
  provider: string | null;
  externalId: string | null;
  normalizedReference: string | null;
  recordType: string;
  economicEventClass: string;
}

export interface JournalMergeCheck {
  key:
    | "distinct"
    | "posted"
    | "effective"
    | "not_already_merged"
    | "balanced"
    | "non_zero"
    | "amount"
    | "currency"
    | "direction"
    | "event_class"
    | "payment_identity"
    | "period"
    | "reconciliation"
    | "domain";
  passed: boolean;
  message: string;
}

export interface JournalMergeFacts {
  canonical: JournalMergeFact;
  duplicate: JournalMergeFact;
  closedThrough: string | null;
  activeMergeIds: string[];
}

export interface JournalMergePreview {
  eligible: boolean;
  canonical: JournalMergeFact;
  duplicate: JournalMergeFact;
  checks: JournalMergeCheck[];
  blockers: string[];
}

export interface JournalMergeResult {
  success: true;
  mergeId: string;
  canonicalJournalId: string;
  duplicateJournalId: string;
  state: string;
  replayed: boolean;
}

export interface JournalUnmergeResult extends JournalMergeResult {
  state: "reversed";
}

const DECIMAL_SCALE = 8;

function decimalUnits(value: string | null): bigint | null {
  if (value === null) return null;
  const match = value.trim().match(/^(-?)(\d+)(?:\.(\d+))?$/);
  if (!match) return null;

  const sign = match[1] === "-" ? -1n : 1n;
  const whole = match[2];
  const rawFraction = match[3] ?? "";
  const discarded = rawFraction.slice(DECIMAL_SCALE);
  if (discarded.replace(/0/g, "").length > 0) return null;

  const fraction = rawFraction.slice(0, DECIMAL_SCALE).padEnd(DECIMAL_SCALE, "0");
  return sign * (BigInt(whole) * 10n ** BigInt(DECIMAL_SCALE) + BigInt(fraction));
}

export function buildJournalMergePairKey(leftId: string, rightId: string): string {
  return [leftId, rightId].sort().join(":");
}

export function classifyJournalDirection(
  transactionType: JournalHeader["transactionType"],
): "inflow" | "outflow" | "journal" | "transfer" {
  if (transactionType === "pay_in") return "inflow";
  if (transactionType === "pay_out") return "outflow";
  return transactionType;
}

function sameDomainOwner(facts: JournalMergeFacts): boolean {
  const canonicalOwners = new Set(facts.canonical.domainOwners);
  const duplicateOwners = new Set(facts.duplicate.domainOwners);

  // The operationally-owned journal must be canonical. This prevents hiding the
  // journal that a bill/invoice lifecycle expects to remain authoritative.
  if (canonicalOwners.size === 0 && duplicateOwners.size > 0) return false;
  if (duplicateOwners.size === 0) return true;

  // If both are operationally owned, they may only represent the same exact
  // bill/invoice. Different business documents are never duplicates.
  return (
    canonicalOwners.size === 1 &&
    duplicateOwners.size === 1 &&
    [...canonicalOwners][0] === [...duplicateOwners][0]
  );
}

function eventClassesCompatible(leftClasses: string[], rightClasses: string[]): boolean {
  const compatiblePair = (left: string, right: string) => {
    if (left === "transfer" || right === "transfer") return false;
    if (left === right || left === "other" || right === "other") return true;
    const pair = new Set([left, right]);
    return (
      (pair.has("purchase") && pair.has("bill_accrual")) ||
      (pair.has("sale") && pair.has("invoice_accrual"))
    );
  };
  return leftClasses.every((left) => rightClasses.every((right) => compatiblePair(left, right)));
}

function isPaymentEventClass(value: string): boolean {
  return value === "bill_payment" || value === "invoice_payment";
}

function paymentIdentityCompatible(facts: JournalMergeFacts): boolean {
  const paymentIdentityRequired =
    facts.canonical.economicEventClasses.some(isPaymentEventClass) ||
    facts.duplicate.economicEventClasses.some(isPaymentEventClass);
  if (!paymentIdentityRequired) return true;

  // Multiple origin objects can describe multiple captures or installments.
  // A merge may only suppress one economic payment event at a time.
  if (
    facts.canonical.operationalOrigins.length > 1 ||
    facts.duplicate.operationalOrigins.length > 1
  ) {
    return false;
  }

  const canonicalIdentities = new Set(facts.canonical.paymentIdentityTokens);
  return (
    canonicalIdentities.size > 0 &&
    facts.duplicate.paymentIdentityTokens.length > 0 &&
    facts.duplicate.paymentIdentityTokens.some((identity) => canonicalIdentities.has(identity))
  );
}

function originalLineCurrencyIsValid(fact: JournalMergeFact): boolean {
  const transactionCurrency = fact.currency.toUpperCase();
  const currenciesMatch = fact.originalCurrencies.every(
    (currency) => currency.toUpperCase() === transactionCurrency,
  );
  if (!currenciesMatch) return false;

  const isForeignCurrency = transactionCurrency !== fact.functionalCurrency.toUpperCase();
  return (
    !isForeignCurrency ||
    (fact.originalAmountsComplete &&
      fact.originalCurrencies.length === 1 &&
      fact.originalCurrencies[0]?.toUpperCase() === transactionCurrency)
  );
}

export function evaluateJournalMergePreflight(facts: JournalMergeFacts): JournalMergePreview {
  const canonicalDebit = decimalUnits(facts.canonical.debitTotal);
  const canonicalCredit = decimalUnits(facts.canonical.creditTotal);
  const duplicateDebit = decimalUnits(facts.duplicate.debitTotal);
  const duplicateCredit = decimalUnits(facts.duplicate.creditTotal);
  const canonicalOriginalDebit = decimalUnits(facts.canonical.originalDebitTotal);
  const canonicalOriginalCredit = decimalUnits(facts.canonical.originalCreditTotal);
  const duplicateOriginalDebit = decimalUnits(facts.duplicate.originalDebitTotal);
  const duplicateOriginalCredit = decimalUnits(facts.duplicate.originalCreditTotal);
  const canonicalAmount = decimalUnits(facts.canonical.totalAmount);
  const duplicateAmount = decimalUnits(facts.duplicate.totalAmount);

  const functionallyBalanced =
    canonicalDebit !== null &&
    canonicalCredit !== null &&
    duplicateDebit !== null &&
    duplicateCredit !== null &&
    canonicalDebit === canonicalCredit &&
    duplicateDebit === duplicateCredit;
  const originallyBalanced =
    canonicalOriginalDebit !== null &&
    canonicalOriginalCredit !== null &&
    duplicateOriginalDebit !== null &&
    duplicateOriginalCredit !== null &&
    canonicalOriginalDebit === canonicalOriginalCredit &&
    duplicateOriginalDebit === duplicateOriginalCredit;
  const bothBalanced = functionallyBalanced && originallyBalanced;
  const bothNonZero =
    canonicalDebit !== null &&
    duplicateDebit !== null &&
    canonicalOriginalDebit !== null &&
    duplicateOriginalDebit !== null &&
    canonicalDebit > 0n &&
    duplicateDebit > 0n &&
    canonicalOriginalDebit > 0n &&
    duplicateOriginalDebit > 0n;
  const amountsMatch =
    functionallyBalanced &&
    originallyBalanced &&
    canonicalAmount !== null &&
    duplicateAmount !== null &&
    canonicalAmount === canonicalDebit &&
    duplicateAmount === duplicateDebit &&
    canonicalOriginalDebit === duplicateOriginalDebit;
  const currenciesMatch =
    facts.canonical.currency === facts.duplicate.currency &&
    facts.canonical.functionalCurrency === facts.duplicate.functionalCurrency &&
    originalLineCurrencyIsValid(facts.canonical) &&
    originalLineCurrencyIsValid(facts.duplicate);
  const directionMatches =
    facts.canonical.transactionType === facts.duplicate.transactionType &&
    classifyJournalDirection(facts.canonical.transactionType) !== "transfer";
  const eventClassMatches = eventClassesCompatible(
    facts.canonical.economicEventClasses,
    facts.duplicate.economicEventClasses,
  );
  const paymentIdentityMatches = paymentIdentityCompatible(facts);
  const periodsOpen =
    !isDateLocked(facts.canonical.transactionDate, facts.closedThrough) &&
    !isDateLocked(facts.duplicate.transactionDate, facts.closedThrough);

  const checks: JournalMergeCheck[] = [
    {
      key: "distinct",
      passed: facts.canonical.id !== facts.duplicate.id,
      message: "Canonical and duplicate journals must be different.",
    },
    {
      key: "posted",
      passed: facts.canonical.status === "posted" && facts.duplicate.status === "posted",
      message: "Both journals must be posted.",
    },
    {
      key: "effective",
      passed:
        facts.canonical.duplicateOfHeaderId === null &&
        facts.duplicate.duplicateOfHeaderId === null,
      message: "A journal already marked as a duplicate cannot be merged again.",
    },
    {
      key: "not_already_merged",
      passed: facts.activeMergeIds.length === 0,
      message: "One of these journals already belongs to an active duplicate merge.",
    },
    {
      key: "balanced",
      passed: bothBalanced,
      message:
        "Both journals must have exactly balanced functional and transaction-currency debit and credit lines.",
    },
    {
      key: "non_zero",
      passed: bothNonZero,
      message: "Both journals must have a non-zero accounting amount.",
    },
    {
      key: "amount",
      passed: amountsMatch,
      message:
        "Transaction-currency line totals must match exactly, and each functional header total must agree with its own functional lines.",
    },
    {
      key: "currency",
      passed: currenciesMatch,
      message:
        "Journal functional, transaction, and original line currencies must match and be complete for foreign-currency transactions.",
    },
    {
      key: "direction",
      passed: directionMatches,
      message:
        "Journal direction and type must match; transfers cannot be duplicate-merged automatically.",
    },
    {
      key: "event_class",
      passed: eventClassMatches,
      message:
        "Economic event classes are incompatible; accruals, payments, transfers, payroll, and unrelated event types must remain separate.",
    },
    {
      key: "payment_identity",
      passed: paymentIdentityMatches,
      message:
        "Payment journals require one identical provider origin or strong payment reference; distinct captures and installments must remain separate.",
    },
    {
      key: "period",
      passed: periodsOpen,
      message: facts.closedThrough
        ? `Neither journal may be in a period locked through ${facts.closedThrough}.`
        : "Neither journal may be in a locked period.",
    },
    {
      key: "reconciliation",
      passed: facts.duplicate.reconciliationCount === 0,
      message:
        facts.canonical.reconciliationCount === 0 && facts.duplicate.reconciliationCount > 0
          ? "The reconciled journal must be selected as canonical."
          : "The duplicate journal cannot have reconciliation links.",
    },
    {
      key: "domain",
      passed: sameDomainOwner(facts),
      message:
        "Operational bill/invoice ownership conflicts; select the owned journal as canonical and never combine different business documents.",
    },
  ];

  const blockers = checks.filter((check) => !check.passed).map((check) => check.message);
  return {
    eligible: blockers.length === 0,
    canonical: facts.canonical,
    duplicate: facts.duplicate,
    checks,
    blockers,
  };
}

async function lockJournalPair(
  db: DbExecutor,
  organizationId: string,
  leftId: string,
  rightId: string,
): Promise<void> {
  const [firstId, secondId] = [leftId, rightId].sort();
  await db.execute(sql`
    SELECT id
    FROM journal_headers
    WHERE organization_id = ${organizationId}
      AND id IN (${firstId}::uuid, ${secondId}::uuid)
    ORDER BY id
    FOR UPDATE
  `);
}

async function lockIdempotencyKey(
  db: DbExecutor,
  organizationId: string,
  operation: "merge" | "unmerge",
  idempotencyKey: string,
): Promise<void> {
  const lockKey = `${organizationId}:${operation}:${idempotencyKey}`;
  await db.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
}

async function assertDuplicateCaseMatchesJournalPair(
  db: DbExecutor,
  organizationId: string,
  duplicateCaseId: string,
  canonicalJournalId: string,
  duplicateJournalId: string,
): Promise<void> {
  const invalidCaseMessage = "Duplicate case does not match the selected journals.";
  const [duplicateCase] = await db
    .select({
      leftSourceRecordId: sourceMatchCandidates.leftSourceRecordId,
      rightSourceRecordId: sourceMatchCandidates.rightSourceRecordId,
      matchClass: sourceMatchCandidates.matchClass,
    })
    .from(sourceMatchCandidates)
    .where(
      and(
        eq(sourceMatchCandidates.organizationId, organizationId),
        eq(sourceMatchCandidates.id, duplicateCaseId),
      ),
    )
    .limit(1);
  if (!duplicateCase || duplicateCase.matchClass !== "duplicate") {
    throw new Error(invalidCaseMessage);
  }

  const sourceIds = [duplicateCase.leftSourceRecordId, duplicateCase.rightSourceRecordId];
  const caseSources = await db
    .select({ id: sourceRecords.id })
    .from(sourceRecords)
    .where(
      and(eq(sourceRecords.organizationId, organizationId), inArray(sourceRecords.id, sourceIds)),
    );
  if (new Set(caseSources.map((source) => source.id)).size !== 2) {
    throw new Error(invalidCaseMessage);
  }

  const links = await db
    .select({
      journalHeaderId: ledgerSourceLinks.journalHeaderId,
      sourceRecordId: ledgerSourceLinks.sourceRecordId,
    })
    .from(ledgerSourceLinks)
    .where(
      and(
        eq(ledgerSourceLinks.organizationId, organizationId),
        inArray(ledgerSourceLinks.journalHeaderId, [canonicalJournalId, duplicateJournalId]),
        inArray(ledgerSourceLinks.sourceRecordId, sourceIds),
      ),
    );
  const linked = new Set(links.map((link) => `${link.journalHeaderId}:${link.sourceRecordId}`));
  const directPair =
    linked.has(`${canonicalJournalId}:${duplicateCase.leftSourceRecordId}`) &&
    linked.has(`${duplicateJournalId}:${duplicateCase.rightSourceRecordId}`);
  const reversedPair =
    linked.has(`${canonicalJournalId}:${duplicateCase.rightSourceRecordId}`) &&
    linked.has(`${duplicateJournalId}:${duplicateCase.leftSourceRecordId}`);
  if (!directPair && !reversedPair) {
    throw new Error(invalidCaseMessage);
  }
}

function mapMergeResult(row: MergeRow, replayed: boolean): JournalMergeResult {
  return {
    success: true,
    mergeId: row.id,
    canonicalJournalId: row.canonicalHeaderId,
    duplicateJournalId: row.duplicateHeaderId,
    state: row.state,
    replayed,
  };
}

function assertMergeReplayMatches(row: MergeRow, input: MergeDuplicateJournalsInput): void {
  if (
    row.canonicalHeaderId !== input.canonicalJournalId ||
    row.duplicateHeaderId !== input.duplicateJournalId ||
    row.duplicateCaseId !== (input.duplicateCaseId ?? null) ||
    row.reason !== input.reason
  ) {
    throw new Error("Idempotency key was already used for a different journal merge request.");
  }
}

interface JournalDomainContext {
  owners: Map<string, Set<string>>;
  references: Map<string, Set<string>>;
}

function normalizedPaymentReference(value: string | null | undefined): string | null {
  const normalized = value
    ?.normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
  return normalized || null;
}

function strongPaymentReference(
  value: string | null | undefined,
  excludedReferences: Set<string>,
): string | null {
  const normalized = normalizedPaymentReference(value);
  if (
    !normalized ||
    normalized.length < 4 ||
    !/\d/.test(normalized) ||
    ["bill", "invoice", "payment", "receipt", "unknown"].includes(normalized) ||
    excludedReferences.has(normalized)
  ) {
    return null;
  }
  return normalized;
}

async function loadDomainContext(
  db: DbExecutor,
  organizationId: string,
  headers: JournalHeader[],
): Promise<JournalDomainContext> {
  const ids = headers.map((header) => header.id);
  const owners = new Map(ids.map((id) => [id, new Set<string>()]));
  const references = new Map(ids.map((id) => [id, new Set<string>()]));
  const sourceBillIds = headers
    .filter((header) => header.sourceDocumentType?.toLowerCase() === "bill")
    .flatMap((header) => (header.sourceDocumentId ? [header.sourceDocumentId] : []));
  const sourceInvoiceIds = headers
    .filter((header) => header.sourceDocumentType?.toLowerCase() === "invoice")
    .flatMap((header) => (header.sourceDocumentId ? [header.sourceDocumentId] : []));

  for (const header of headers) {
    if (header.sourceDocumentType && header.sourceDocumentId) {
      owners
        .get(header.id)!
        .add(`${header.sourceDocumentType.toLowerCase()}:${header.sourceDocumentId}`);
      const normalizedId = normalizedPaymentReference(header.sourceDocumentId);
      if (normalizedId) references.get(header.id)!.add(normalizedId);
    }
  }

  const [billRows, invoiceRows] = await Promise.all([
    db
      .select({
        id: bills.id,
        journalHeaderId: bills.journalHeaderId,
        documentReference: bills.billNumber,
      })
      .from(bills)
      .where(
        and(
          eq(bills.organizationId, organizationId),
          sourceBillIds.length > 0
            ? or(inArray(bills.journalHeaderId, ids), inArray(bills.id, sourceBillIds))
            : inArray(bills.journalHeaderId, ids),
        ),
      ),
    db
      .select({
        id: invoices.id,
        journalHeaderId: invoices.journalHeaderId,
        documentReference: invoices.invoiceNumber,
      })
      .from(invoices)
      .where(
        and(
          eq(invoices.organizationId, organizationId),
          sourceInvoiceIds.length > 0
            ? or(inArray(invoices.journalHeaderId, ids), inArray(invoices.id, sourceInvoiceIds))
            : inArray(invoices.journalHeaderId, ids),
        ),
      ),
  ]);

  for (const row of billRows) {
    const headerIds = new Set([
      ...(row.journalHeaderId ? [row.journalHeaderId] : []),
      ...headers
        .filter(
          (header) =>
            header.sourceDocumentType?.toLowerCase() === "bill" &&
            header.sourceDocumentId === row.id,
        )
        .map((header) => header.id),
    ]);
    for (const headerId of headerIds) {
      owners.get(headerId)?.add(`bill:${row.id}`);
      const normalizedReference = normalizedPaymentReference(row.documentReference);
      if (normalizedReference) references.get(headerId)?.add(normalizedReference);
    }
  }
  for (const row of invoiceRows) {
    const headerIds = new Set([
      ...(row.journalHeaderId ? [row.journalHeaderId] : []),
      ...headers
        .filter(
          (header) =>
            header.sourceDocumentType?.toLowerCase() === "invoice" &&
            header.sourceDocumentId === row.id,
        )
        .map((header) => header.id),
    ]);
    for (const headerId of headerIds) {
      owners.get(headerId)?.add(`invoice:${row.id}`);
      const normalizedReference = normalizedPaymentReference(row.documentReference);
      if (normalizedReference) references.get(headerId)?.add(normalizedReference);
    }
  }
  return { owners, references };
}

async function loadJournalMergeFacts(
  ctx: JournalMergeReadContext,
  input: DuplicateJournalPairInput,
): Promise<JournalMergeFacts> {
  if (input.canonicalJournalId === input.duplicateJournalId) {
    throw new Error("Canonical and duplicate journals must be different.");
  }

  const ids = [input.canonicalJournalId, input.duplicateJournalId];
  const headers = await ctx.db
    .select()
    .from(journalHeaders)
    .where(and(eq(journalHeaders.organizationId, ctx.orgId), inArray(journalHeaders.id, ids)));

  const byId = new Map(headers.map((header) => [header.id, header]));
  const canonicalHeader = byId.get(input.canonicalJournalId);
  const duplicateHeader = byId.get(input.duplicateJournalId);
  if (!canonicalHeader) throw new Error("Canonical journal not found.");
  if (!duplicateHeader) throw new Error("Duplicate journal not found.");

  const [
    lineTotals,
    reconciliationCounts,
    activeMerges,
    closedThrough,
    domainContext,
    sourceLinks,
  ] = await Promise.all([
    ctx.db
      .select({
        headerId: journalLines.journalHeaderId,
        debitTotal: sql<string>`coalesce(sum(coalesce(${journalLines.debit}, 0)), 0)::text`,
        creditTotal: sql<string>`coalesce(sum(coalesce(${journalLines.credit}, 0)), 0)::text`,
        originalDebitTotal: sql<string>`coalesce(sum(coalesce(${journalLines.originalDebit}, ${journalLines.debit}, 0)), 0)::text`,
        originalCreditTotal: sql<string>`coalesce(sum(coalesce(${journalLines.originalCredit}, ${journalLines.credit}, 0)), 0)::text`,
        originalAmountsComplete: sql<boolean>`coalesce(bool_and(
          (coalesce(${journalLines.debit}, 0) = 0 or (${journalLines.originalDebit} is not null and ${journalLines.originalCurrency} is not null))
          and
          (coalesce(${journalLines.credit}, 0) = 0 or (${journalLines.originalCredit} is not null and ${journalLines.originalCurrency} is not null))
        ), false)`,
        originalCurrencies: sql<string[]>`coalesce(
          array_agg(distinct upper(${journalLines.originalCurrency}))
            filter (where ${journalLines.originalCurrency} is not null),
          array[]::text[]
        )`,
      })
      .from(journalLines)
      .where(inArray(journalLines.journalHeaderId, ids))
      .groupBy(journalLines.journalHeaderId),
    ctx.db
      .select({
        headerId: journalLines.journalHeaderId,
        count: sql<number>`count(*)::int`,
      })
      .from(statementLines)
      .innerJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
      .where(inArray(journalLines.journalHeaderId, ids))
      .groupBy(journalLines.journalHeaderId),
    ctx.db
      .select({ id: journalDuplicateMerges.id })
      .from(journalDuplicateMerges)
      .where(
        and(
          eq(journalDuplicateMerges.organizationId, ctx.orgId),
          eq(journalDuplicateMerges.state, "active"),
          or(
            inArray(journalDuplicateMerges.canonicalHeaderId, ids),
            inArray(journalDuplicateMerges.duplicateHeaderId, ids),
          ),
        ),
      ),
    getClosedThrough(ctx.orgId, ctx.db),
    loadDomainContext(ctx.db, ctx.orgId, headers),
    ctx.db
      .select({
        headerId: ledgerSourceLinks.journalHeaderId,
        sourceRecordId: sourceRecords.id,
        integrationSourceId: sourceRecords.sourceId,
        provider: integrationSources.provider,
        externalId: sourceRecords.externalId,
        normalizedReference: sourceRecords.normalizedReference,
        recordType: sourceRecords.recordType,
        eventClass: sourceRecords.economicEventClass,
        relationship: ledgerSourceLinks.relationship,
      })
      .from(ledgerSourceLinks)
      .innerJoin(sourceRecords, eq(ledgerSourceLinks.sourceRecordId, sourceRecords.id))
      .leftJoin(integrationSources, eq(sourceRecords.sourceId, integrationSources.id))
      .where(
        and(
          eq(ledgerSourceLinks.organizationId, ctx.orgId),
          inArray(ledgerSourceLinks.journalHeaderId, ids),
        ),
      ),
  ]);

  const totalsById = new Map(lineTotals.map((row) => [row.headerId, row]));
  const reconciliationsById = new Map(reconciliationCounts.map((row) => [row.headerId, row.count]));
  const eventClassesById = new Map<string, Set<string>>();
  const originsById = new Map<string, JournalOperationalOriginFact[]>();
  const linksByHeaderId = new Map<string, typeof sourceLinks>();
  for (const row of sourceLinks) {
    const rows = linksByHeaderId.get(row.headerId) ?? [];
    rows.push(row);
    linksByHeaderId.set(row.headerId, rows);
  }
  for (const linkedSources of linksByHeaderId.values()) {
    const meaningfulSource = (source: (typeof linkedSources)[number]) =>
      source.recordType !== "email" && source.eventClass !== "other";
    const meaningfulOrigins = linkedSources.filter(
      (source) => source.relationship === "origin" && meaningfulSource(source),
    );
    const effectiveOrigins =
      meaningfulOrigins.length > 0
        ? meaningfulOrigins
        : linkedSources.some(meaningfulSource)
          ? linkedSources.filter(meaningfulSource)
          : linkedSources.filter((source) => source.relationship === "origin");
    for (const row of effectiveOrigins) {
      const classes = eventClassesById.get(row.headerId) ?? new Set<string>();
      classes.add(row.eventClass);
      eventClassesById.set(row.headerId, classes);
      const origins = originsById.get(row.headerId) ?? [];
      origins.push({
        sourceRecordId: row.sourceRecordId,
        integrationSourceId: row.integrationSourceId,
        provider: row.provider,
        externalId: row.externalId,
        normalizedReference: row.normalizedReference,
        recordType: row.recordType,
        economicEventClass: row.eventClass,
      });
      originsById.set(row.headerId, origins);
    }
  }

  const fallbackEventClass = (header: JournalHeader): string => {
    if (header.source === "bill") return "bill_accrual";
    if (header.source === "invoice") return "invoice_accrual";
    if (header.source === "payment") {
      return header.transactionType === "pay_in" ? "invoice_payment" : "bill_payment";
    }
    const normalizedMemo = header.memo?.trim().toLowerCase() ?? "";
    if (header.sourceDocumentType === "invoice") {
      if (normalizedMemo.startsWith("payment")) return "invoice_payment";
      if (normalizedMemo.startsWith("invoice issued")) return "invoice_accrual";
      return "other";
    }
    if (header.sourceDocumentType === "bill") {
      if (normalizedMemo.startsWith("bill payment")) return "bill_payment";
      if (normalizedMemo.startsWith("bill accrual")) return "bill_accrual";
      return "other";
    }
    if (header.transactionType === "pay_in") return "sale";
    if (header.transactionType === "pay_out") return "purchase";
    if (header.transactionType === "transfer") return "transfer";
    return "other";
  };

  const toFact = (header: JournalHeader): JournalMergeFact => {
    const sourceEventClasses = [...(eventClassesById.get(header.id) ?? [])];
    const authoritativeEventClasses = sourceEventClasses.filter(
      (eventClass) => eventClass !== "other",
    );
    const economicEventClasses = [
      ...new Set(
        authoritativeEventClasses.length > 0
          ? authoritativeEventClasses
          : [fallbackEventClass(header)],
      ),
    ].sort();
    const operationalOrigins = [...(originsById.get(header.id) ?? [])].sort((left, right) =>
      left.sourceRecordId.localeCompare(right.sourceRecordId),
    );
    const excludedReferences = domainContext.references.get(header.id) ?? new Set<string>();
    const paymentIdentityTokens = new Set<string>();
    const addIdentity = (value: string | null | undefined) => {
      const reference = strongPaymentReference(value, excludedReferences);
      if (reference) paymentIdentityTokens.add(`reference:${reference}`);
    };
    addIdentity(header.referenceNumber);
    for (const origin of operationalOrigins) {
      const normalizedExternalId = normalizedPaymentReference(origin.externalId);
      if (origin.integrationSourceId && normalizedExternalId) {
        paymentIdentityTokens.add(
          `provider-origin:${origin.integrationSourceId}:${normalizedExternalId}`,
        );
      }
      addIdentity(origin.externalId);
      addIdentity(origin.normalizedReference);
    }

    return {
      id: header.id,
      transactionNumber: header.transactionNumber,
      transactionDate: header.transactionDate,
      transactionType: header.transactionType,
      status: header.status,
      totalAmount: header.totalAmount,
      currency: (header.transactionCurrency ?? header.functionalCurrency).toUpperCase(),
      functionalCurrency: header.functionalCurrency.toUpperCase(),
      duplicateOfHeaderId: header.duplicateOfHeaderId,
      debitTotal: totalsById.get(header.id)?.debitTotal ?? "0",
      creditTotal: totalsById.get(header.id)?.creditTotal ?? "0",
      originalDebitTotal: totalsById.get(header.id)?.originalDebitTotal ?? "0",
      originalCreditTotal: totalsById.get(header.id)?.originalCreditTotal ?? "0",
      originalAmountsComplete: totalsById.get(header.id)?.originalAmountsComplete ?? false,
      originalCurrencies: totalsById.get(header.id)?.originalCurrencies ?? [],
      reconciliationCount: reconciliationsById.get(header.id) ?? 0,
      domainOwners: [...(domainContext.owners.get(header.id) ?? [])].sort(),
      economicEventClasses,
      operationalOrigins,
      paymentIdentityTokens: [...paymentIdentityTokens].sort(),
    };
  };

  return {
    canonical: toFact(canonicalHeader),
    duplicate: toFact(duplicateHeader),
    closedThrough,
    activeMergeIds: activeMerges.map((merge) => merge.id),
  };
}

export async function previewDuplicateJournalMerge(
  ctx: JournalMergeReadContext,
  input: DuplicateJournalPairInput,
): Promise<JournalMergePreview> {
  return evaluateJournalMergePreflight(await loadJournalMergeFacts(ctx, input));
}

export async function mergeDuplicateJournals(
  ctx: JournalMergeWriteContext,
  input: MergeDuplicateJournalsInput,
): Promise<JournalMergeResult> {
  return ctx.db.transaction(async (tx) => {
    await lockIdempotencyKey(tx, ctx.orgId, "merge", input.idempotencyKey);

    const [existing] = await tx
      .select()
      .from(journalDuplicateMerges)
      .where(
        and(
          eq(journalDuplicateMerges.organizationId, ctx.orgId),
          eq(journalDuplicateMerges.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (existing) {
      assertMergeReplayMatches(existing, input);
      return mapMergeResult(existing, true);
    }

    await lockJournalPair(tx, ctx.orgId, input.canonicalJournalId, input.duplicateJournalId);
    if (input.duplicateCaseId) {
      await assertDuplicateCaseMatchesJournalPair(
        tx,
        ctx.orgId,
        input.duplicateCaseId,
        input.canonicalJournalId,
        input.duplicateJournalId,
      );
    }

    const preview = await previewDuplicateJournalMerge({ db: tx, orgId: ctx.orgId }, input);
    if (!preview.eligible) {
      throw new Error(`Cannot merge journals: ${preview.blockers.join(" ")}`);
    }

    const [merge] = await tx
      .insert(journalDuplicateMerges)
      .values({
        organizationId: ctx.orgId,
        canonicalHeaderId: input.canonicalJournalId,
        duplicateHeaderId: input.duplicateJournalId,
        duplicateCaseId: input.duplicateCaseId ?? null,
        pairKey: buildJournalMergePairKey(input.canonicalJournalId, input.duplicateJournalId),
        state: "active",
        reason: input.reason,
        evidence: {
          checks: preview.checks,
          canonical: preview.canonical,
          duplicate: preview.duplicate,
        },
        idempotencyKey: input.idempotencyKey,
        matchedBy: ctx.userId,
      })
      .returning();

    const [updatedDuplicate] = await tx
      .update(journalHeaders)
      .set({
        duplicateOfHeaderId: input.canonicalJournalId,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(journalHeaders.id, input.duplicateJournalId),
          eq(journalHeaders.organizationId, ctx.orgId),
          isNull(journalHeaders.duplicateOfHeaderId),
        ),
      )
      .returning({ id: journalHeaders.id });
    if (!updatedDuplicate) {
      throw new Error("Duplicate journal changed while the merge was being applied.");
    }

    await tx.insert(activityLogs).values([
      {
        organizationId: ctx.orgId,
        entityType: "transaction",
        entityId: input.canonicalJournalId,
        action: "duplicate_merge_canonical",
        actorId: ctx.userId,
        changes: {
          mergeId: merge.id,
          duplicateJournalId: input.duplicateJournalId,
          duplicateCaseId: input.duplicateCaseId ?? null,
          reason: input.reason,
        },
      },
      {
        organizationId: ctx.orgId,
        entityType: "transaction",
        entityId: input.duplicateJournalId,
        action: "duplicate_merge_suppressed",
        actorId: ctx.userId,
        changes: {
          mergeId: merge.id,
          canonicalJournalId: input.canonicalJournalId,
          duplicateCaseId: input.duplicateCaseId ?? null,
          reason: input.reason,
        },
      },
    ]);
    await tx.insert(workflowEvents).values({
      organizationId: ctx.orgId,
      entityType: "journal_duplicate_merge",
      entityId: merge.id,
      action: "posted_merge",
      actorType: "user",
      actorId: ctx.userId,
      idempotencyKey: `journal-merge:${input.idempotencyKey}`,
      data: {
        canonicalJournalId: input.canonicalJournalId,
        duplicateJournalId: input.duplicateJournalId,
        duplicateCaseId: input.duplicateCaseId ?? null,
        reason: input.reason,
      },
    });

    return mapMergeResult(merge, false);
  });
}

function assertUnmergeReplayMatches(row: MergeRow, input: UnmergeDuplicateJournalsInput): void {
  if (row.id !== input.mergeId || row.reversalReason !== input.reason) {
    throw new Error("Idempotency key was already used for a different journal unmerge request.");
  }
}

export async function unmergeDuplicateJournals(
  ctx: JournalMergeWriteContext,
  input: UnmergeDuplicateJournalsInput,
): Promise<JournalUnmergeResult> {
  return ctx.db.transaction(async (tx) => {
    await lockIdempotencyKey(tx, ctx.orgId, "unmerge", input.idempotencyKey);

    const [replayed] = await tx
      .select()
      .from(journalDuplicateMerges)
      .where(
        and(
          eq(journalDuplicateMerges.organizationId, ctx.orgId),
          eq(journalDuplicateMerges.reversalIdempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (replayed) {
      assertUnmergeReplayMatches(replayed, input);
      return {
        ...mapMergeResult(replayed, true),
        state: "reversed",
      };
    }

    const [candidate] = await tx
      .select()
      .from(journalDuplicateMerges)
      .where(
        and(
          eq(journalDuplicateMerges.id, input.mergeId),
          eq(journalDuplicateMerges.organizationId, ctx.orgId),
        ),
      )
      .limit(1);
    if (!candidate) throw new Error("Duplicate merge not found.");

    await lockJournalPair(tx, ctx.orgId, candidate.canonicalHeaderId, candidate.duplicateHeaderId);
    await tx.execute(sql`
      SELECT id
      FROM journal_duplicate_merges
      WHERE id = ${candidate.id}::uuid
        AND organization_id = ${ctx.orgId}
      FOR UPDATE
    `);

    const [merge] = await tx
      .select()
      .from(journalDuplicateMerges)
      .where(
        and(
          eq(journalDuplicateMerges.id, candidate.id),
          eq(journalDuplicateMerges.organizationId, ctx.orgId),
        ),
      )
      .limit(1);
    if (!merge || merge.state !== "active") {
      throw new Error("Duplicate merge is not active.");
    }

    const [canonical, duplicate, closedThrough] = await Promise.all([
      tx
        .select({
          id: journalHeaders.id,
          transactionDate: journalHeaders.transactionDate,
        })
        .from(journalHeaders)
        .where(
          and(
            eq(journalHeaders.id, merge.canonicalHeaderId),
            eq(journalHeaders.organizationId, ctx.orgId),
          ),
        )
        .limit(1),
      tx
        .select({
          id: journalHeaders.id,
          transactionDate: journalHeaders.transactionDate,
          duplicateOfHeaderId: journalHeaders.duplicateOfHeaderId,
        })
        .from(journalHeaders)
        .where(
          and(
            eq(journalHeaders.id, merge.duplicateHeaderId),
            eq(journalHeaders.organizationId, ctx.orgId),
          ),
        )
        .limit(1),
      getClosedThrough(ctx.orgId, tx),
    ]);
    const canonicalHeader = canonical[0];
    const duplicateHeader = duplicate[0];
    if (!canonicalHeader || !duplicateHeader) {
      throw new Error("One of the journals in this merge no longer exists.");
    }
    if (duplicateHeader.duplicateOfHeaderId !== canonicalHeader.id) {
      throw new Error("Duplicate journal lineage no longer matches this merge.");
    }
    if (
      isDateLocked(canonicalHeader.transactionDate, closedThrough) ||
      isDateLocked(duplicateHeader.transactionDate, closedThrough)
    ) {
      throw new Error(`Cannot unmerge journals in a period locked through ${closedThrough}.`);
    }

    const [reconciliation] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(statementLines)
      .innerJoin(journalLines, eq(statementLines.matchedJournalLineId, journalLines.id))
      .where(
        inArray(journalLines.journalHeaderId, [merge.canonicalHeaderId, merge.duplicateHeaderId]),
      );
    if ((reconciliation?.count ?? 0) > 0) {
      throw new Error(
        "Cannot unmerge while either journal has reconciliation links. Unmatch the bank reconciliation first.",
      );
    }

    const [restored] = await tx
      .update(journalHeaders)
      .set({
        duplicateOfHeaderId: null,
        updatedAt: new Date(),
      })
      .where(
        and(
          eq(journalHeaders.id, merge.duplicateHeaderId),
          eq(journalHeaders.organizationId, ctx.orgId),
          eq(journalHeaders.duplicateOfHeaderId, merge.canonicalHeaderId),
        ),
      )
      .returning({ id: journalHeaders.id });
    if (!restored) {
      throw new Error("Duplicate journal changed while the unmerge was being applied.");
    }

    const reversedAt = new Date();
    const [reversed] = await tx
      .update(journalDuplicateMerges)
      .set({
        state: "reversed",
        reversedAt,
        reversedBy: ctx.userId,
        reversalReason: input.reason,
        reversalIdempotencyKey: input.idempotencyKey,
      })
      .where(
        and(
          eq(journalDuplicateMerges.id, merge.id),
          eq(journalDuplicateMerges.organizationId, ctx.orgId),
          eq(journalDuplicateMerges.state, "active"),
        ),
      )
      .returning();
    if (!reversed) throw new Error("Duplicate merge changed while it was being reversed.");

    await tx.insert(activityLogs).values([
      {
        organizationId: ctx.orgId,
        entityType: "transaction",
        entityId: merge.canonicalHeaderId,
        action: "duplicate_merge_reversed",
        actorId: ctx.userId,
        changes: {
          mergeId: merge.id,
          restoredJournalId: merge.duplicateHeaderId,
          reason: input.reason,
        },
      },
      {
        organizationId: ctx.orgId,
        entityType: "transaction",
        entityId: merge.duplicateHeaderId,
        action: "duplicate_merge_restored",
        actorId: ctx.userId,
        changes: {
          mergeId: merge.id,
          canonicalJournalId: merge.canonicalHeaderId,
          reason: input.reason,
        },
      },
    ]);
    await tx.insert(workflowEvents).values({
      organizationId: ctx.orgId,
      entityType: "journal_duplicate_merge",
      entityId: merge.id,
      action: "posted_unmerge",
      actorType: "user",
      actorId: ctx.userId,
      idempotencyKey: `journal-unmerge:${input.idempotencyKey}`,
      data: {
        canonicalJournalId: merge.canonicalHeaderId,
        restoredJournalId: merge.duplicateHeaderId,
        reason: input.reason,
      },
    });

    return {
      ...mapMergeResult(reversed, false),
      state: "reversed",
    };
  });
}
