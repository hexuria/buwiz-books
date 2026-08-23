import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const read = (p: string) => readFileSync(resolve(process.cwd(), p), "utf8");

/**
 * Route-level void/transition invariants, pinned as source shape (the
 * repo's wiring-test pattern) because the handlers are createServerFn and
 * cannot run without a session.
 *
 * Each of these was an audit finding:
 *  - bill void wrote status="voided" with no voidedAt, so point-in-time AP
 *    aging excluded the journal for EVERY as-of date — a closed month's
 *    report silently changed when the void happened.
 *  - bill void had no finalized-reconciliation guard while invoice void,
 *    batch delete and transaction void all did.
 *  - a bill in awaiting_payment/scheduled (where a mistaken bill most often
 *    sits) could not be voided at all; a paid invoice had no correction path.
 */
describe("void integrity wiring", () => {
  const bills = read("src/routes/api/-bills.ts");
  const invoices = read("src/routes/api/-invoices.ts");
  const service = read("src/lib/inbox/service.ts");

  it("every journal void in the bill routes stamps voidedAt", () => {
    // No bare status-void writes may remain; each must carry voidedAt.
    expect(bills).not.toMatch(/set\(\{ status: "voided", updatedAt/);
    const stamped = bills.match(/status: "voided", voidedAt: new Date\(\)/g) ?? [];
    expect(stamped.length).toBeGreaterThanOrEqual(2); // void transition + delete path
  });

  it("bill and invoice void share the finalized-reconciliation guard", () => {
    for (const source of [bills, invoices]) {
      expect(source).toContain("journalsClearedByFinalizedReconciliation(");
    }
    // The old 1:1-only inline check must be gone from the invoice path.
    expect(invoices).not.toMatch(/finalizedMatch/);
  });

  it("voided is reachable from the states corrections actually start in", () => {
    expect(bills).toMatch(/awaiting_payment: \["scheduled", "paid", "partial", "voided"\]/);
    expect(bills).toMatch(/scheduled: \["paid", "partial", "voided"\]/);
    expect(invoices).toMatch(/paid: \["voided"\]/);
  });

  it("voiding an invoice zeroes what the public pay link shows as due", () => {
    expect(invoices).toMatch(/updateFields\.balanceDue = "0\.00"/);
  });

  it("inbox approval stamps the journal with the source-document pair", () => {
    expect(service).toContain("sourceDocumentStampFor(");
    // And the stamp is uuid-guarded, since source_document_id is a uuid column.
    expect(service).toMatch(/UUID_SHAPE/);
  });
});
