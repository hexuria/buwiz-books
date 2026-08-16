import { describe, it, expect, vi } from "vitest";
import { getAllDescendantIds } from "../../../src/lib/account-helpers";
import type { DbExecutor } from "../../../src/db";

/** Build a mock executor whose select chain resolves to the given account rows */
function mockDb(rows: Array<{ id: string; parentId: string | null }>): DbExecutor {
  return {
    select: vi.fn().mockReturnThis(),
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockResolvedValue(rows),
  } as unknown as DbExecutor;
}

describe("Account Helpers", () => {
  describe("getAllDescendantIds", () => {
    it("should return an empty array if parent has no children", async () => {
      const db = mockDb([{ id: "parent-1", parentId: null }]);

      const result = await getAllDescendantIds(db, "parent-1", "org-1");
      expect(result).toEqual([]);
    });

    it("should return immediate children", async () => {
      const db = mockDb([
        { id: "parent-1", parentId: null },
        { id: "child-1", parentId: "parent-1" },
        { id: "child-2", parentId: "parent-1" },
      ]);

      const result = await getAllDescendantIds(db, "parent-1", "org-1");
      expect(result).toHaveLength(2);
      expect(result).toContain("child-1");
      expect(result).toContain("child-2");
    });

    it("should traverse deeply nested graphs", async () => {
      const db = mockDb([
        { id: "root", parentId: null },
        { id: "child-a", parentId: "root" },
        { id: "child-b", parentId: "root" },
        { id: "grandchild-a1", parentId: "child-a" },
        { id: "grandchild-a2", parentId: "child-a" },
        { id: "great-grandchild-1", parentId: "grandchild-a1" },
      ]);

      const result = await getAllDescendantIds(db, "root", "org-1");
      expect(result).toHaveLength(5);
      expect(result).toContain("child-a");
      expect(result).toContain("child-b");
      expect(result).toContain("grandchild-a1");
      expect(result).toContain("grandchild-a2");
      expect(result).toContain("great-grandchild-1");
    });

    it("should isolate by the specific parent requested", async () => {
      const db = mockDb([
        { id: "root", parentId: null },
        { id: "child-a", parentId: "root" },
        { id: "child-b", parentId: "root" },
        { id: "grandchild-a1", parentId: "child-a" },
      ]);

      const result = await getAllDescendantIds(db, "child-a", "org-1");
      expect(result).toEqual(["grandchild-a1"]);
    });

    it("should handle large flat structures safely", async () => {
      const mockData: Array<{ id: string; parentId: string | null }> = Array.from(
        { length: 1000 },
        (_, i) => ({
          id: `child-${i}`,
          parentId: "root",
        }),
      );
      mockData.push({ id: "root", parentId: null });

      const db = mockDb(mockData);

      const result = await getAllDescendantIds(db, "root", "org-1");
      expect(result).toHaveLength(1000);
    });
  });
});
