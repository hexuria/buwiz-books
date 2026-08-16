import { randomUUID } from "node:crypto";
import { count, eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type postgres from "postgres";
import { accounts } from "@/db/schema/accounts";
import { organization, user } from "@/db/schema/auth";
import {
  organizationAccountingSettings,
  sourceRecords,
  transactionCandidates,
} from "@/db/schema/inbox";
import { createTransactionCandidate } from "@/lib/inbox/service";
import { createTestDb } from "../utils/db-utils";

const describeDb =
  process.env.TEST_DATABASE_URL || process.env.DATABASE_URL ? describe : describe.skip;

describeDb("payload-bound transaction idempotency", () => {
  let db: Awaited<ReturnType<typeof createTestDb>>["db"];
  let sqlClient: postgres.Sql;

  const organizationId = randomUUID();
  const userId = `idempotency-test-${randomUUID()}`;
  const requestIdempotencyKey = randomUUID();
  let bankAccountId: string;
  let expenseAccountId: string;

  beforeAll(async () => {
    ({ db, sql: sqlClient } = await createTestDb());
    await db.insert(organization).values({
      id: organizationId,
      name: "Payload idempotency test",
      slug: `payload-idempotency-${organizationId}`,
    });
    await db.insert(user).values({
      id: userId,
      name: "Payload idempotency test user",
      email: `${userId}@test.local`,
      emailVerified: true,
    });
    await db.insert(organizationAccountingSettings).values({
      organizationId,
      baseCurrency: "USD",
      requireDifferentApprover: false,
    });
    const [bank, expense] = await db
      .insert(accounts)
      .values([
        {
          organizationId,
          name: "Operating Bank",
          accountType: "asset",
          subtype: "checking",
        },
        {
          organizationId,
          name: "Office Supplies",
          accountType: "expense",
          subtype: "office_supplies",
        },
      ])
      .returning({ id: accounts.id });
    bankAccountId = bank.id;
    expenseAccountId = expense.id;
  });

  afterAll(async () => {
    await sqlClient.end();
  });

  it("replays identical content and rejects changed content for the same key", async () => {
    const baseInput = {
      transactionDate: "2026-07-24",
      transactionType: "pay_out" as const,
      memo: "Office supplies",
      originalCurrency: "USD",
      requestIdempotencyKey,
      lines: [
        { accountId: expenseAccountId, debit: "48.50" },
        { accountId: bankAccountId, credit: "48.50" },
      ],
    };
    const ctx = {
      db,
      orgId: organizationId,
      userId,
      role: "owner" as const,
    };

    const first = await createTransactionCandidate(ctx, baseInput);
    const retry = await createTransactionCandidate(ctx, baseInput);

    expect(retry).toMatchObject({
      deduplicated: true,
      candidate: { id: first.candidate.id },
      inboxItem: { id: first.inboxItem.id },
    });

    await expect(
      createTransactionCandidate(ctx, {
        ...baseInput,
        memo: "Different purchase using the same client key",
      }),
    ).rejects.toThrow(
      "This idempotency key was already used for a different transaction submission.",
    );

    const [candidateCount] = await db
      .select({ value: count() })
      .from(transactionCandidates)
      .where(eq(transactionCandidates.organizationId, organizationId));
    expect(candidateCount.value).toBe(1);
  });

  it("preserves the original request binding across provider version updates", async () => {
    const boundKey = randomUUID();
    const externalId = `card-charge-${randomUUID()}`;
    const initialInput = {
      transactionDate: "2026-07-23",
      transactionType: "pay_out" as const,
      memo: "Card purchase awaiting settlement",
      originalCurrency: "USD",
      sourceChannel: "card" as const,
      sourceProvider: "test_card",
      externalId,
      externalVersion: "1",
      requestIdempotencyKey: boundKey,
      lines: [
        { accountId: expenseAccountId, debit: "22.00" },
        { accountId: bankAccountId, credit: "22.00" },
      ],
    };
    const ctx = {
      db,
      orgId: organizationId,
      userId,
      role: "owner" as const,
    };

    const first = await createTransactionCandidate(ctx, initialInput);
    await db
      .update(sourceRecords)
      .set({
        economicEventClass: "bill_payment",
        direction: "outflow",
      })
      .where(eq(sourceRecords.id, first.candidate.sourceRecordId!));
    const providerUpdate = await createTransactionCandidate(ctx, {
      ...initialInput,
      memo: "Card purchase settled",
      externalVersion: "2",
      requestIdempotencyKey: undefined,
    });
    expect(providerUpdate).toMatchObject({
      deduplicated: true,
      candidate: { id: first.candidate.id },
    });
    const [updatedSource] = await db
      .select({
        economicEventClass: sourceRecords.economicEventClass,
        direction: sourceRecords.direction,
      })
      .from(sourceRecords)
      .where(eq(sourceRecords.id, first.candidate.sourceRecordId!));
    expect(updatedSource).toEqual({
      economicEventClass: "bill_payment",
      direction: "outflow",
    });

    const retry = await createTransactionCandidate(ctx, initialInput);
    expect(retry).toMatchObject({
      deduplicated: true,
      candidate: { id: first.candidate.id },
    });

    await expect(
      createTransactionCandidate(ctx, {
        ...initialInput,
        memo: "A different request must not inherit this key",
      }),
    ).rejects.toThrow(
      "This idempotency key was already used for a different transaction submission.",
    );
  });
});
