// The display derivation must agree exactly with what the sweep persists —
// a list that SHOWS overdue for a row the sweep would not touch (or vice
// versa) reintroduces the read/write drift this split was built to end.
import { describe, expect, it } from "vitest";
import {
  deriveDisplayStatus,
  overdueCutoffDate,
  OVERDUE_SWEEPABLE_STATUSES,
} from "../../../src/lib/invoices/overdue";

describe("overdueCutoffDate", () => {
  it("is the UTC calendar date", () => {
    expect(overdueCutoffDate(new Date("2026-08-24T23:59:00Z"))).toBe("2026-08-24");
    expect(overdueCutoffDate(new Date("2026-08-24T00:00:01Z"))).toBe("2026-08-24");
  });
});

describe("deriveDisplayStatus", () => {
  const cutoff = "2026-08-24";

  it("derives overdue for sent/viewed strictly past due", () => {
    for (const status of OVERDUE_SWEEPABLE_STATUSES) {
      expect(deriveDisplayStatus({ status, dueDate: "2026-08-23" }, cutoff).status).toBe("overdue");
    }
  });

  it("due TODAY is not overdue (strict inequality, matching the sweep's lt())", () => {
    expect(deriveDisplayStatus({ status: "sent", dueDate: "2026-08-24" }, cutoff).status).toBe(
      "sent",
    );
  });

  it("leaves non-sweepable statuses alone even when past due", () => {
    for (const status of ["draft", "paid", "partial", "voided", "overdue"]) {
      expect(deriveDisplayStatus({ status, dueDate: "2020-01-01" }, cutoff).status).toBe(status);
    }
  });

  it("leaves rows without a due date alone", () => {
    expect(deriveDisplayStatus({ status: "sent", dueDate: null }, cutoff).status).toBe("sent");
  });

  it("does not mutate the input row", () => {
    const row = { status: "sent", dueDate: "2020-01-01" };
    deriveDisplayStatus(row, cutoff);
    expect(row.status).toBe("sent");
  });
});
