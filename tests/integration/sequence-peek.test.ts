import { randomUUID } from "node:crypto";
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import postgres from "postgres";
import { createTestDb } from "../utils/db-utils";
import { allocateInvoiceNumber, peekNextInvoiceNumber } from "../../src/lib/sequence";

const describeDb = process.env.TEST_DATABASE_URL ? describe : describe.skip;

/**
 * Checkpoint C6: the draft screen's GET used to ALLOCATE an invoice number —
 * a mutation on read — so every open of the create screen consumed a value
 * and abandoned drafts left gaps. The GET is now a peek; the value is only
 * consumed at save time.
 */
describeDb("invoice number peek", () => {
  let db: any;
  let sql: postgres.Sql;

  beforeAll(async () => {
    ({ db, sql } = await createTestDb());
  });
  afterAll(async () => {
    await sql.end();
  });

  it("peeking never consumes; allocation still advances", async () => {
    const orgId = `seq-peek-${randomUUID()}`;

    // A fresh org previews INV-0001 no matter how many times it looks.
    expect(await peekNextInvoiceNumber(orgId, db)).toBe("INV-0001");
    expect(await peekNextInvoiceNumber(orgId, db)).toBe("INV-0001");

    // Saving takes exactly the previewed value.
    expect(await allocateInvoiceNumber(orgId, db)).toBe("INV-0001");

    // And the preview moves to the next value — again without consuming it.
    expect(await peekNextInvoiceNumber(orgId, db)).toBe("INV-0002");
    expect(await peekNextInvoiceNumber(orgId, db)).toBe("INV-0002");
    expect(await allocateInvoiceNumber(orgId, db)).toBe("INV-0002");
  });
});
