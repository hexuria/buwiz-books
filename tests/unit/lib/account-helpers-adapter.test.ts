import { describe, expect, it, vi } from "vitest";
import type { DbExecutor } from "../../../src/db";
import { getAllDescendantIds } from "../../../src/lib/account-helpers";

function mockDb(rows: Array<{ id: string; parentId: string | null }>) {
  const where = vi.fn().mockResolvedValue(rows);
  const from = vi.fn(() => ({ where }));
  const select = vi.fn(() => ({ from }));
  return { db: { select } as unknown as DbExecutor, select, from, where };
}

describe("account hierarchy database adapter", () => {
  it("loads one organization-scoped account set and delegates hierarchy traversal", async () => {
    const { db, select, from, where } = mockDb([
      { id: "root", parentId: null },
      { id: "child", parentId: "root" },
      { id: "grandchild", parentId: "child" },
    ]);

    await expect(getAllDescendantIds(db, "root", "org-a")).resolves.toEqual([
      "child",
      "grandchild",
    ]);
    expect(select).toHaveBeenCalledOnce();
    expect(from).toHaveBeenCalledOnce();
    expect(where).toHaveBeenCalledOnce();
  });
});
