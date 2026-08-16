import { describe, it, expect, vi } from "vitest";
import { isDateInLockedPeriod } from "../../../src/lib/period-close";

vi.mock("../../../src/db", () => {
  return {
    db: {
      select: vi.fn().mockReturnThis(),
      from: vi.fn().mockReturnThis(),
      where: vi.fn().mockReturnThis(),
      limit: vi.fn(),
    },
  };
});

import { db } from "../../../src/db";

describe("Period Close Helpers", () => {
  describe("isDateInLockedPeriod", () => {
    it("should return unlocked if org has no closedThrough date", async () => {
      (db as any).limit.mockResolvedValueOnce([{ closedThrough: null }]);

      const result = await isDateInLockedPeriod("org-1", "2026-01-15");
      expect(result.locked).toBe(false);
      expect(result.closedThrough).toBeNull();
    });

    it("should return unlocked if org record is missing", async () => {
      (db as any).limit.mockResolvedValueOnce([]);

      const result = await isDateInLockedPeriod("org-1", "2026-01-15");
      expect(result.locked).toBe(false);
      expect(result.closedThrough).toBeNull();
    });

    it("should return locked if transaction is before closedThrough date", async () => {
      (db as any).limit.mockResolvedValueOnce([{ closedThrough: "2026-01-31" }]);

      const result = await isDateInLockedPeriod("org-1", "2026-01-15");
      expect(result.locked).toBe(true);
      expect(result.closedThrough).toBe("2026-01-31");
    });

    it("should return locked if transaction is on the exact closedThrough date", async () => {
      (db as any).limit.mockResolvedValueOnce([{ closedThrough: "2026-01-31" }]);

      const result = await isDateInLockedPeriod("org-1", "2026-01-31");
      expect(result.locked).toBe(true);
      expect(result.closedThrough).toBe("2026-01-31");
    });

    it("should return unlocked if transaction is after closedThrough date", async () => {
      (db as any).limit.mockResolvedValueOnce([{ closedThrough: "2026-01-31" }]);

      const result = await isDateInLockedPeriod("org-1", "2026-02-01");
      expect(result.locked).toBe(false);
      expect(result.closedThrough).toBe("2026-01-31");
    });
  });
});
