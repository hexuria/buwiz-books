import { describe, expect, it } from "vitest";
import { checkFix, checkLines, checkTitle, summarizeCheckChange } from "@/lib/inbox/v2/check-copy";

describe("Inbox check wording", () => {
  it("names checks the way a reviewer would, never as a raw rule key", () => {
    expect(checkTitle("missing_invoice")).toBe("Vendor's bill not attached");
    expect(checkTitle("uncategorized")).toBe("Category needed");
    expect(checkFix("missing_department")).toBe("Set a department on at least one line.");
    // An unknown rule still reads as words.
    expect(checkTitle("some_new_rule")).toBe("Some new rule");
    expect(checkFix("some_new_rule")).toBeNull();
  });

  it("names the lines a check points at", () => {
    const lines = [
      { lineDescription: "Ergonomic Chairs" },
      { lineDescription: "  " },
      { lineDescription: null },
    ];
    expect(checkLines({ lineIndexes: [0, 1] }, lines)).toBe("Ergonomic Chairs, Line 2");
    expect(checkLines({ lineIndexes: [] }, lines)).toBeNull();
    expect(checkLines({}, lines)).toBeNull();
    expect(checkLines(null, lines)).toBeNull();
  });

  it("says what a save cleared and what still blocks", () => {
    expect(
      summarizeCheckChange(
        ["uncategorized", "missing_department", "missing_invoice"],
        ["missing_invoice"],
      ),
    ).toBe(
      "Saved. Cleared: Category needed, Department needed. Still blocking: Vendor's bill not attached.",
    );
    expect(summarizeCheckChange(["uncategorized"], [])).toBe(
      "Saved. Cleared: Category needed. Nothing blocks approval.",
    );
  });
});
