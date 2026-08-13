import { describe, expect, it } from "vitest";
import { descendantAccountIds } from "../../../src/lib/account-hierarchy";

describe("descendantAccountIds", () => {
  it("returns an empty array when the parent has no children", () => {
    expect(descendantAccountIds([{ id: "parent-1", parentId: null }], "parent-1")).toEqual([]);
  });

  it("returns immediate and deeply nested children", () => {
    const result = descendantAccountIds(
      [
        { id: "root", parentId: null },
        { id: "child-a", parentId: "root" },
        { id: "child-b", parentId: "root" },
        { id: "grandchild-a1", parentId: "child-a" },
        { id: "grandchild-a2", parentId: "child-a" },
        { id: "great-grandchild-1", parentId: "grandchild-a1" },
      ],
      "root",
    );

    expect(result).toHaveLength(5);
    expect(result).toEqual(
      expect.arrayContaining([
        "child-a",
        "child-b",
        "grandchild-a1",
        "grandchild-a2",
        "great-grandchild-1",
      ]),
    );
  });

  it("isolates traversal to the requested parent", () => {
    expect(
      descendantAccountIds(
        [
          { id: "root", parentId: null },
          { id: "child-a", parentId: "root" },
          { id: "child-b", parentId: "root" },
          { id: "grandchild-a1", parentId: "child-a" },
        ],
        "child-a",
      ),
    ).toEqual(["grandchild-a1"]);
  });

  it("handles large flat account sets", () => {
    const accounts: Array<{ id: string; parentId: string | null }> = Array.from(
      { length: 1000 },
      (_, index) => ({
        id: `child-${index}`,
        parentId: "root",
      }),
    );
    accounts.push({ id: "root", parentId: null });

    expect(descendantAccountIds(accounts, "root")).toHaveLength(1000);
  });

  it("terminates safely when malformed account data contains a cycle", () => {
    expect(
      descendantAccountIds(
        [
          { id: "root", parentId: "child" },
          { id: "child", parentId: "root" },
        ],
        "root",
      ),
    ).toEqual(["child"]);
  });
});
