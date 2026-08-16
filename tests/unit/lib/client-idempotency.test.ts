import { describe, expect, it } from "vitest";
import {
  clearStableIdempotencyKey,
  type StableIdempotencyIntent,
  withStableIdempotencyKey,
} from "@/lib/client-idempotency";

describe("client mutation idempotency", () => {
  it("reuses a key for retries and rapid repeat submissions of the same intent", () => {
    const intentRef: { current: StableIdempotencyIntent | null } = { current: null };
    const first = withStableIdempotencyKey(intentRef, {
      invoiceId: "invoice-1",
      newStatus: "partial",
      paymentAmount: "25.00",
      nested: { bank: "bank-1", reference: null },
    });
    const replay = withStableIdempotencyKey(intentRef, {
      nested: { reference: null, bank: "bank-1" },
      paymentAmount: "25.00",
      newStatus: "partial",
      invoiceId: "invoice-1",
    });

    expect(replay.idempotencyKey).toBe(first.idempotencyKey);
  });

  it("rotates the key when the payload changes and clears only the completed intent", () => {
    const intentRef: { current: StableIdempotencyIntent | null } = { current: null };
    const first = withStableIdempotencyKey(intentRef, {
      invoiceId: "invoice-1",
      paymentAmount: "25.00",
    });
    const changed = withStableIdempotencyKey(intentRef, {
      invoiceId: "invoice-1",
      paymentAmount: "30.00",
    });

    expect(changed.idempotencyKey).not.toBe(first.idempotencyKey);
    clearStableIdempotencyKey(intentRef, first.idempotencyKey);
    expect(intentRef.current?.idempotencyKey).toBe(changed.idempotencyKey);
    clearStableIdempotencyKey(intentRef, changed.idempotencyKey);
    expect(intentRef.current).toBeNull();
  });
});
