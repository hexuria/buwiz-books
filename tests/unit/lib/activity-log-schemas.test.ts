import { describe, it, expect } from "vitest";
import {
  insertActivityLogSchema,
  listActivityLogsSchema,
} from "../../../src/db/validation/activity-logs";

describe("Activity Log Schemas", () => {
  // ========================================================================
  // insertActivityLogSchema
  // ========================================================================

  describe("insertActivityLogSchema", () => {
    it("should accept a valid activity log entry", () => {
      const result = insertActivityLogSchema.parse({
        organizationId: "org-1",
        entityType: "transaction",
        entityId: "550e8400-e29b-41d4-a716-446655440000",
        action: "created",
      });
      expect(result.action).toBe("created");
      expect(result.entityType).toBe("transaction");
    });

    it("should accept nullable actorId", () => {
      const result = insertActivityLogSchema.parse({
        organizationId: "org-1",
        entityType: "reconciliation",
        entityId: "550e8400-e29b-41d4-a716-446655440000",
        action: "finalized",
        actorId: null,
      });
      expect(result.actorId).toBeNull();
    });

    it("should accept optional changes record", () => {
      const result = insertActivityLogSchema.parse({
        organizationId: "org-1",
        entityType: "transaction",
        entityId: "550e8400-e29b-41d4-a716-446655440000",
        action: "updated",
        changes: { memo: { from: "Old", to: "New" } },
      });
      expect(result.changes).toEqual({ memo: { from: "Old", to: "New" } });
    });

    it("should reject missing required fields", () => {
      expect(() => insertActivityLogSchema.parse({})).toThrow();
      expect(() =>
        insertActivityLogSchema.parse({
          organizationId: "org-1",
          // missing entityType, entityId, action
        }),
      ).toThrow();
    });

    it("should reject non-UUID entityId", () => {
      expect(() =>
        insertActivityLogSchema.parse({
          organizationId: "org-1",
          entityType: "transaction",
          entityId: "not-a-uuid",
          action: "created",
        }),
      ).toThrow();
    });
  });

  // ========================================================================
  // listActivityLogsSchema
  // ========================================================================

  describe("listActivityLogsSchema", () => {
    it('should default entityType to "transaction"', () => {
      const result = listActivityLogsSchema.parse({
        entityId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.entityType).toBe("transaction");
    });

    it("should accept custom entityType", () => {
      const result = listActivityLogsSchema.parse({
        entityType: "reconciliation",
        entityId: "550e8400-e29b-41d4-a716-446655440000",
      });
      expect(result.entityType).toBe("reconciliation");
    });

    it("should reject non-UUID entityId", () => {
      expect(() =>
        listActivityLogsSchema.parse({
          entityId: "bad",
        }),
      ).toThrow();
    });
  });
});
