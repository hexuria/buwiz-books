import { randomUUID } from "node:crypto";
import { and, count, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { accounts } from "@/db/schema/accounts";
import { organization, user } from "@/db/schema/auth";
import { billLineItems, bills } from "@/db/schema/bills";
import {
  ledgerSourceLinks,
  organizationAccountingSettings,
  sourceRecords,
} from "@/db/schema/inbox";
import { invoices } from "@/db/schema/invoices";
import { journalHeaders } from "@/db/schema/journals";
import { accountingOperationIdempotency } from "@/db/schema/operation-idempotency";
import { parties } from "@/db/schema/parties";
import { recordManualBillPayment } from "@/lib/manual-bill-payment";
import { recordManualInvoicePayment } from "@/lib/manual-invoice-payment";
import { createTestDb } from "../utils/db-utils";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("operational payment idempotency", () => {
  let firstDb: Awaited<ReturnType<typeof createTestDb>>["db"];
  let secondDb: Awaited<ReturnType<typeof createTestDb>>["db"];
  let firstSql: postgres.Sql;
  let secondSql: postgres.Sql;

  const organizationId = randomUUID();
  const userId = `operational-payments-${randomUUID()}`;
  const customerId = randomUUID();
  const vendorId = randomUUID();
  let bankAccountId: string;
  let expenseAccountId: string;

  beforeAll(async () => {
    ({ db: firstDb, sql: firstSql } = await createTestDb());
    ({ db: secondDb, sql: secondSql } = await createTestDb());
    await firstDb.insert(organization).values({
      id: organizationId,
      name: "Operational idempotency",
      slug: `operational-idempotency-${organizationId}`,
    });
    await firstDb.insert(user).values({
      id: userId,
      name: "Operational payment reviewer",
      email: `${userId}@test.local`,
      emailVerified: true,
    });
    await firstDb.insert(organizationAccountingSettings).values({
      organizationId,
      baseCurrency: "USD",
      requireDifferentApprover: false,
    });
    const accountRows = await firstDb
      .insert(accounts)
      .values([
        {
          organizationId,
          name: "Operating Bank",
          accountType: "asset",
          subtype: "bank_accounts",
        },
        {
          organizationId,
          name: "Accounts Receivable",
          accountType: "asset",
          subtype: "account_receivable",
        },
        {
          organizationId,
          name: "Accounts Payable",
          accountType: "liability",
          subtype: "accounts_payable",
        },
        {
          organizationId,
          name: "Operating Expense",
          accountType: "expense",
          subtype: "office_supplies",
        },
      ])
      .returning({ id: accounts.id });
    bankAccountId = accountRows[0].id;
    expenseAccountId = accountRows[3].id;
    await firstDb.insert(parties).values([
      {
        id: customerId,
        organizationId,
        name: "Payment Customer",
        partyType: "customer",
      },
      {
        id: vendorId,
        organizationId,
        name: "Payment Vendor",
        partyType: "vendor",
      },
    ]);
  });

  afterAll(async () => {
    await Promise.all([firstSql.end(), secondSql.end()]);
  });

  async function createInvoice(total = "100.00") {
    const invoiceId = randomUUID();
    await firstDb.insert(invoices).values({
      id: invoiceId,
      organizationId,
      invoiceNumber: `INV-${invoiceId.slice(0, 8)}`,
      customerId,
      issueDate: "2026-07-20",
      dueDate: "2026-08-20",
      status: "sent",
      subtotal: total,
      total,
      balanceDue: total,
    });
    return invoiceId;
  }

  async function createBill(total = "100.00") {
    const billId = randomUUID();
    await firstDb.insert(bills).values({
      id: billId,
      organizationId,
      vendorId,
      billNumber: `BILL-${billId.slice(0, 8)}`,
      billDate: "2026-07-20",
      dueDate: "2026-08-20",
      status: "in_review",
      amount: total,
      balanceDue: total,
    });
    await firstDb.insert(billLineItems).values({
      billId,
      description: "Operating expense",
      amount: total,
      accountId: expenseAccountId,
      sortOrder: 0,
    });
    return billId;
  }

  it("makes partial-to-partial invoice retries exact and rejects payload reuse", async () => {
    const invoiceId = await createInvoice();
    const firstKey = randomUUID();
    const firstInput = {
      organizationId,
      userId,
      invoiceId,
      requestedStatus: "partial" as const,
      bankAccountId,
      paymentAmount: "40.00",
      idempotencyKey: firstKey,
    };
    const first = await firstDb.transaction((tx) => recordManualInvoicePayment(tx, firstInput));
    const replay = await firstDb.transaction((tx) => recordManualInvoicePayment(tx, firstInput));

    expect(first).toMatchObject({ status: "partial", amountPaid: "40.00", deduplicated: false });
    expect(replay).toMatchObject({
      status: "partial",
      amountPaid: "40.00",
      deduplicated: true,
      operationJournalHeaderId: first.operationJournalHeaderId,
    });
    await expect(
      firstDb.transaction((tx) =>
        recordManualInvoicePayment(tx, { ...firstInput, paymentAmount: "41.00" }),
      ),
    ).rejects.toThrow(
      "This idempotency key was already used for a different accounting operation submission.",
    );

    const secondKey = randomUUID();
    const secondInput = {
      ...firstInput,
      idempotencyKey: secondKey,
      paymentAmount: "30.00",
    };
    const second = await firstDb.transaction((tx) => recordManualInvoicePayment(tx, secondInput));
    const secondReplay = await firstDb.transaction((tx) =>
      recordManualInvoicePayment(tx, secondInput),
    );
    expect(second).toMatchObject({ status: "partial", amountPaid: "70.00" });
    expect(secondReplay).toMatchObject({
      status: "partial",
      amountPaid: "70.00",
      deduplicated: true,
      operationJournalHeaderId: second.operationJournalHeaderId,
    });

    const paymentJournals = await firstDb
      .select()
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.organizationId, organizationId),
          eq(journalHeaders.sourceDocumentId, invoiceId),
          eq(journalHeaders.sourceDocumentType, "invoice"),
          eq(journalHeaders.source, "payment"),
        ),
      );
    expect(paymentJournals).toHaveLength(2);
  });

  it("serializes concurrent invoice retries into one journal and one source", async () => {
    const invoiceId = await createInvoice("75.00");
    const idempotencyKey = randomUUID();
    const input = {
      organizationId,
      userId,
      invoiceId,
      requestedStatus: "paid" as const,
      bankAccountId,
      paymentAmount: "75.00",
      idempotencyKey,
    };
    const [left, right] = await Promise.all([
      firstDb.transaction((tx) => recordManualInvoicePayment(tx, input)),
      secondDb.transaction((tx) => recordManualInvoicePayment(tx, input)),
    ]);

    expect([left.deduplicated, right.deduplicated].sort()).toEqual([false, true]);
    expect(left.operationJournalHeaderId).toBe(right.operationJournalHeaderId);

    const [journalCount, sourceCount, operationCount] = await Promise.all([
      firstDb
        .select({ value: count() })
        .from(journalHeaders)
        .where(
          and(
            eq(journalHeaders.organizationId, organizationId),
            eq(journalHeaders.sourceDocumentId, invoiceId),
            eq(journalHeaders.source, "payment"),
          ),
        )
        .then((rows) => rows[0].value),
      firstDb
        .select({ value: count() })
        .from(sourceRecords)
        .where(
          and(
            eq(sourceRecords.organizationId, organizationId),
            eq(sourceRecords.externalId, idempotencyKey),
          ),
        )
        .then((rows) => rows[0].value),
      firstDb
        .select({ value: count() })
        .from(accountingOperationIdempotency)
        .where(
          and(
            eq(accountingOperationIdempotency.organizationId, organizationId),
            eq(accountingOperationIdempotency.idempotencyKey, idempotencyKey),
          ),
        )
        .then((rows) => rows[0].value),
    ]);
    expect({ journalCount, sourceCount, operationCount }).toEqual({
      journalCount: 1,
      sourceCount: 1,
      operationCount: 1,
    });
  });

  it("locks bill payment posting so concurrent retries preserve one accrual and payment", async () => {
    const billId = await createBill();
    const idempotencyKey = randomUUID();
    const input = {
      organizationId,
      userId,
      billId,
      requestedStatus: "partial" as const,
      bankAccountId,
      paymentAmount: "25.00",
      paymentMethod: "ACH",
      paymentReference: "ACH-100",
      idempotencyKey,
    };
    const [left, right] = await Promise.all([
      firstDb.transaction((tx) => recordManualBillPayment(tx, input)),
      secondDb.transaction((tx) => recordManualBillPayment(tx, input)),
    ]);

    expect([left.deduplicated, right.deduplicated].sort()).toEqual([false, true]);
    expect(left.operationJournalHeaderId).toBe(right.operationJournalHeaderId);
    expect(left.amountPaid).toBe("25.00");
    expect(right.amountPaid).toBe("25.00");

    const linkedJournals = await firstDb
      .select()
      .from(journalHeaders)
      .where(
        and(
          eq(journalHeaders.organizationId, organizationId),
          eq(journalHeaders.sourceDocumentId, billId),
          eq(journalHeaders.sourceDocumentType, "bill"),
        ),
      );
    expect(linkedJournals).toHaveLength(2);
    expect(linkedJournals.filter((journal) => journal.source === "payment")).toHaveLength(1);
    expect(linkedJournals.filter((journal) => journal.source === "bill")).toHaveLength(1);

    const sources = await firstDb
      .select()
      .from(sourceRecords)
      .where(
        and(
          eq(sourceRecords.organizationId, organizationId),
          eq(sourceRecords.externalId, idempotencyKey),
        ),
      );
    expect(sources).toHaveLength(1);
    expect(sources[0]).toMatchObject({
      economicEventClass: "bill_payment",
      direction: "outflow",
      originalAmount: "25.00000000",
    });
    const originLinks = await firstDb
      .select()
      .from(ledgerSourceLinks)
      .where(eq(ledgerSourceLinks.sourceRecordId, sources[0].id));
    expect(originLinks).toHaveLength(1);
    expect(originLinks[0].journalHeaderId).toBe(left.operationJournalHeaderId);
  });

  it("isolates operation keys by organization under the application role", async () => {
    const [operation] = await firstDb
      .select()
      .from(accountingOperationIdempotency)
      .where(eq(accountingOperationIdempotency.organizationId, organizationId))
      .limit(1);
    expect(operation).toBeDefined();

    const visible = await firstDb.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL ROLE buwiz_app`);
      await tx.execute(
        sql`SELECT set_config('app.current_organization_id', ${randomUUID()}, true)`,
      );
      return tx
        .select()
        .from(accountingOperationIdempotency)
        .where(eq(accountingOperationIdempotency.id, operation.id));
    });
    expect(visible).toHaveLength(0);
  });
});
