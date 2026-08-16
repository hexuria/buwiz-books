import { describe, it, expect } from "vitest";
import {
  createTransactionSchema,
  updateTransactionSchema,
  journalLineInputSchema,
  TRANSACTION_TYPES,
  JOURNAL_STATUSES,
  validateBalance,
  type JournalLineInput,
} from "../../../src/db/validation/journals";
import {
  updateTransactionsBatchSchema,
  deleteTransactionsBatchSchema,
} from "../../../src/db/validation/batch-actions";

describe("Journal Validation Schemas", () => {
  // ========================================================================
  // Constants
  // ========================================================================

  describe("constants", () => {
    it("should define 4 transaction types", () => {
      expect(TRANSACTION_TYPES).toHaveLength(4);
      expect(TRANSACTION_TYPES).toContain("pay_in");
      expect(TRANSACTION_TYPES).toContain("pay_out");
      expect(TRANSACTION_TYPES).toContain("journal");
      expect(TRANSACTION_TYPES).toContain("transfer");
    });

    it("should define 3 journal statuses", () => {
      expect(JOURNAL_STATUSES).toHaveLength(3);
      expect(JOURNAL_STATUSES).toContain("draft");
      expect(JOURNAL_STATUSES).toContain("posted");
      expect(JOURNAL_STATUSES).toContain("voided");
    });
  });

  // ========================================================================
  // journalLineInputSchema
  // ========================================================================

  describe("journalLineInputSchema", () => {
    it("should accept a minimal valid line", () => {
      const result = journalLineInputSchema.parse({
        accountId: "550e8400-e29b-41d4-a716-446655440000",
        debit: "100.00",
      });
      expect(result.accountId).toBe("550e8400-e29b-41d4-a716-446655440000");
    });

    it("should reject non-UUID accountId", () => {
      expect(() => journalLineInputSchema.parse({ accountId: "bad" })).toThrow();
    });

    it("should accept nullable partyId", () => {
      const result = journalLineInputSchema.parse({
        accountId: "550e8400-e29b-41d4-a716-446655440000",
        partyId: null,
      });
      expect(result.partyId).toBeNull();
    });
  });

  // ========================================================================
  // createTransactionSchema
  // ========================================================================

  describe("createTransactionSchema", () => {
    const validLine = {
      accountId: "550e8400-e29b-41d4-a716-446655440000",
      debit: "100.00",
    };
    const validLine2 = {
      accountId: "550e8400-e29b-41d4-a716-446655440001",
      credit: "100.00",
    };
    const idempotencyKey = "550e8400-e29b-41d4-a716-446655440002";

    it("should accept a valid transaction with 2 lines", () => {
      const result = createTransactionSchema.parse({
        idempotencyKey,
        transactionDate: "2026-01-15",
        transactionType: "journal",
        lines: [validLine, validLine2],
      });
      expect(result.transactionType).toBe("journal");
      expect(result.lines).toHaveLength(2);
    });

    it("should require a caller-generated UUID idempotency key", () => {
      expect(() =>
        createTransactionSchema.parse({
          transactionDate: "2026-01-15",
          transactionType: "journal",
          lines: [validLine, validLine2],
        }),
      ).toThrow();
      expect(() =>
        createTransactionSchema.parse({
          idempotencyKey: "not-a-uuid",
          transactionDate: "2026-01-15",
          transactionType: "journal",
          lines: [validLine, validLine2],
        }),
      ).toThrow();
    });

    it("should reject fewer than 2 lines", () => {
      expect(() =>
        createTransactionSchema.parse({
          idempotencyKey,
          transactionDate: "2026-01-15",
          transactionType: "journal",
          lines: [validLine],
        }),
      ).toThrow(/At least 2/);
    });

    it("should reject invalid transaction types", () => {
      expect(() =>
        createTransactionSchema.parse({
          idempotencyKey,
          transactionDate: "2026-01-15",
          transactionType: "withdrawal",
          lines: [validLine, validLine2],
        }),
      ).toThrow();
    });

    it("should accept all valid source values", () => {
      const sources = ["manual", "import", "invoice", "bill", "reconciliation", "system"] as const;
      for (const source of sources) {
        const result = createTransactionSchema.parse({
          idempotencyKey,
          transactionDate: "2026-01-15",
          transactionType: "pay_out",
          source,
          lines: [validLine, validLine2],
        });
        expect(result.source).toBe(source);
      }
    });
  });

  // ========================================================================
  // updateTransactionSchema
  // ========================================================================

  describe("updateTransactionSchema", () => {
    it("should accept a partial update with just ID", () => {
      const result = updateTransactionSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.id).toBeTruthy();
      expect(result.memo).toBeUndefined();
    });

    it("should accept nullable partyId (to clear party)", () => {
      const result = updateTransactionSchema.parse({
        id: "550e8400-e29b-41d4-a716-446655440000",
        partyId: null,
      });
      expect(result.partyId).toBeNull();
    });
  });

  // ========================================================================
  // validateBalance (expanded coverage)
  // ========================================================================

  describe("validateBalance (extended)", () => {
    it("should return valid for balanced lines", () => {
      const lines: JournalLineInput[] = [
        { accountId: "a", debit: "500.00" },
        { accountId: "b", credit: "500.00" },
      ];
      const result = validateBalance(lines);
      expect(result.valid).toBe(true);
      expect(result.difference).toBe(0);
    });

    it("should detect imbalance", () => {
      const lines: JournalLineInput[] = [
        { accountId: "a", debit: "100.00" },
        { accountId: "b", credit: "99.50" },
      ];
      const result = validateBalance(lines);
      expect(result.valid).toBe(false);
      expect(result.difference).toBe(0.5);
    });

    it("should handle empty lines", () => {
      const result = validateBalance([]);
      expect(result.valid).toBe(true);
      expect(result.totalDebits).toBe(0);
      expect(result.totalCredits).toBe(0);
    });

    it("should handle lines with only debits", () => {
      const lines: JournalLineInput[] = [
        { accountId: "a", debit: "100.00" },
        { accountId: "b", debit: "200.00" },
      ];
      const result = validateBalance(lines);
      expect(result.valid).toBe(false);
      expect(result.totalDebits).toBe(300);
      expect(result.totalCredits).toBe(0);
    });

    it("should handle multi-line balanced entries", () => {
      const lines: JournalLineInput[] = [
        { accountId: "a", debit: "100.00" },
        { accountId: "b", debit: "200.00" },
        { accountId: "c", credit: "150.00" },
        { accountId: "d", credit: "150.00" },
      ];
      const result = validateBalance(lines);
      expect(result.valid).toBe(true);
    });
  });
});

// ========================================================================
// Batch Action Schemas
// ========================================================================

describe("Batch Action Schemas", () => {
  describe("updateTransactionsBatchSchema", () => {
    it("should accept a valid batch update", () => {
      const result = updateTransactionsBatchSchema.parse({
        ids: ["550e8400-e29b-41d4-a716-446655440000", "550e8400-e29b-41d4-a716-446655440001"],
        updates: {
          partyId: "550e8400-e29b-41d4-a716-446655440002",
        },
      });
      expect(result.ids).toHaveLength(2);
      expect(result.updates.partyId).toBeTruthy();
    });

    it("should accept empty updates object", () => {
      const result = updateTransactionsBatchSchema.parse({
        ids: ["550e8400-e29b-41d4-a716-446655440000"],
        updates: {},
      });
      expect(result.updates.partyId).toBeUndefined();
    });

    it("should reject non-UUID ids", () => {
      expect(() =>
        updateTransactionsBatchSchema.parse({
          ids: ["bad-id"],
          updates: {},
        }),
      ).toThrow();
    });

    it("should accept all valid transaction types", () => {
      for (const type of ["pay_in", "pay_out", "transfer", "journal"] as const) {
        const result = updateTransactionsBatchSchema.parse({
          ids: ["550e8400-e29b-41d4-a716-446655440000"],
          updates: {},
          transactionType: type,
        });
        expect(result.transactionType).toBe(type);
      }
    });
  });

  describe("deleteTransactionsBatchSchema", () => {
    it("should accept a valid array of UUIDs", () => {
      const result = deleteTransactionsBatchSchema.parse({
        ids: ["550e8400-e29b-41d4-a716-446655440000"],
      });
      expect(result.ids).toHaveLength(1);
    });

    it("should reject non-UUID values", () => {
      expect(() =>
        deleteTransactionsBatchSchema.parse({
          ids: ["invalid"],
        }),
      ).toThrow();
    });
  });
});
