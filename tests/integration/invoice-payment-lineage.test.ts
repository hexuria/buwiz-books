import { randomUUID } from "node:crypto";
import { and, count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { accounts } from "@/db/schema/accounts";
import { organization } from "@/db/schema/auth";
import {
  integrationSources,
  ledgerSourceLinks,
  organizationAccountingSettings,
  sourceRecordVersions,
  sourceRecords,
  workflowEvents,
} from "@/db/schema/inbox";
import { invoices } from "@/db/schema/invoices";
import { journalHeaders } from "@/db/schema/journals";
import { parties } from "@/db/schema/parties";
import { recordCardInvoicePayment } from "@/lib/invoice-payments";
import { createTestDb } from "../utils/db-utils";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("external invoice payment lineage", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let sqlClient: postgres.Sql;

  const organizationId = randomUUID();
  const customerId = randomUUID();
  const invoiceId = randomUUID();
  const externalRef = `pi_${randomUUID()}`;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
    await db.insert(organization).values({
      id: organizationId,
      name: "Payment lineage test",
      slug: `payment-lineage-${organizationId}`,
    });
    await db.insert(organizationAccountingSettings).values({
      organizationId,
      baseCurrency: "USD",
      requireDifferentApprover: false,
    });
    await db.insert(accounts).values([
      {
        organizationId,
        name: "Accounts Receivable",
        accountType: "asset",
        subtype: "account_receivable",
      },
      {
        organizationId,
        name: "Payment Clearing",
        accountType: "asset",
        subtype: "asset_clearing",
      },
    ]);
    await db.insert(parties).values({
      id: customerId,
      organizationId,
      name: "Payment Customer",
      partyType: "customer",
    });
    await db.insert(invoices).values({
      id: invoiceId,
      organizationId,
      invoiceNumber: `INV-${organizationId.slice(0, 8)}`,
      customerId,
      issueDate: "2026-07-20",
      dueDate: "2026-08-20",
      status: "sent",
      subtotal: "125",
      total: "125",
      balanceDue: "125",
    });
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  it("preserves one provider source and journal across webhook retries", async () => {
    const first = await recordCardInvoicePayment({
      db,
      invoiceId,
      amount: 125,
      paidVia: "stripe",
      externalRef,
      currency: "usd",
      occurredAt: new Date("2026-07-24T02:00:00.000Z"),
    });
    const replay = await recordCardInvoicePayment({
      db,
      invoiceId,
      amount: 125,
      paidVia: "stripe",
      externalRef,
      currency: "USD",
      occurredAt: new Date("2026-07-24T02:00:00.000Z"),
    });

    expect(first.alreadyRecorded).toBe(false);
    expect(replay).toMatchObject({
      journalHeaderId: first.journalHeaderId,
      alreadyRecorded: true,
      status: "paid",
    });

    const [journal] = await db
      .select()
      .from(journalHeaders)
      .where(eq(journalHeaders.id, first.journalHeaderId));
    expect(journal).toMatchObject({
      source: "payment",
      transactionCurrency: "USD",
      functionalCurrency: "USD",
      transactionDate: "2026-07-24",
    });

    const providerSources = await db
      .select()
      .from(integrationSources)
      .where(
        and(
          eq(integrationSources.organizationId, organizationId),
          eq(integrationSources.provider, "stripe"),
          eq(integrationSources.externalSourceId, "stripe:invoice-payments"),
        ),
      );
    expect(providerSources).toHaveLength(1);

    const records = await db
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, organizationId),
          eq(sourceRecords.externalId, externalRef),
        ),
      );
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      economicEventClass: "invoice_payment",
      direction: "inflow",
      originalAmount: "125.00000000",
      originalCurrency: "USD",
      effectiveDate: "2026-07-24",
    });

    const [versionCount] = await db
      .select({ value: count() })
      .from(sourceRecordVersions)
      .where(eq(sourceRecordVersions.sourceRecordId, records[0].id));
    expect(versionCount.value).toBe(1);

    const originLinks = await db
      .select()
      .from(ledgerSourceLinks)
      .where(
        and(
          eq(ledgerSourceLinks.journalHeaderId, first.journalHeaderId),
          eq(ledgerSourceLinks.sourceRecordId, records[0].id),
          eq(ledgerSourceLinks.relationship, "origin"),
        ),
      );
    expect(originLinks).toHaveLength(1);

    const replayEvents = await db
      .select()
      .from(workflowEvents)
      .where(
        and(
          eq(workflowEvents.organizationId, organizationId),
          eq(workflowEvents.action, "exact_replay_suppressed"),
        ),
      );
    expect(replayEvents).toHaveLength(1);
  });
});
