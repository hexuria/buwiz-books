import { beforeEach, describe, expect, it, vi } from "vitest";
import { isDateInLockedPeriod } from "../../../src/lib/period-close";

const { limitMock } = vi.hoisted(() => ({ limitMock: vi.fn() }));

vi.mock("../../../src/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({ limit: limitMock })),
      })),
    })),
  },
}));

describe("period-close database adapter", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns the stored close boundary and applies the pure lock policy", async () => {
    limitMock.mockResolvedValueOnce([{ closedThrough: "2026-01-31" }]);

    await expect(isDateInLockedPeriod("org-a", "2026-01-31")).resolves.toEqual({
      locked: true,
      closedThrough: "2026-01-31",
    });
  });

  it("treats a missing organization row as open", async () => {
    limitMock.mockResolvedValueOnce([]);

    await expect(isDateInLockedPeriod("org-missing", "2026-01-31")).resolves.toEqual({
      locked: false,
      closedThrough: null,
    });
  });
});
