import { describe, expect, it } from "vitest";
import { enforceGrounding, TASK_GROUNDING } from "../../../src/lib/ai/grounding";

const allowed = {
  accounts: new Set(["acct-1", "acct-2"]),
  parties: new Set(["party-1"]),
  dimensions: new Set(["dim-1"]),
};

describe("enforceGrounding", () => {
  it("keeps IDs that the caller supplied", () => {
    const { output, blanked } = enforceGrounding(
      { categoryId: "acct-1", partyId: "party-1" },
      TASK_GROUNDING.transaction_parse,
      allowed,
    );
    expect(output).toMatchObject({ categoryId: "acct-1", partyId: "party-1" });
    expect(blanked).toEqual([]);
  });

  it("blanks a hallucinated ID and reports the path", () => {
    const { output, blanked } = enforceGrounding(
      { categoryId: "acct-invented", partyId: "party-1" },
      TASK_GROUNDING.transaction_parse,
      allowed,
    );
    expect(output.categoryId).toBe("");
    expect(output.partyId).toBe("party-1");
    expect(blanked).toEqual(["categoryId"]);
  });

  it("walks array elements and reports indexed paths", () => {
    const { output, blanked } = enforceGrounding(
      {
        lines: [{ categoryId: "acct-1" }, { categoryId: "acct-nope" }, { categoryId: "acct-2" }],
      },
      TASK_GROUNDING.transaction_parse,
      allowed,
    );
    expect(output.lines.map((l: any) => l.categoryId)).toEqual(["acct-1", "", "acct-2"]);
    expect(blanked).toEqual(["lines[1].categoryId"]);
  });

  it("treats an empty string as 'unknown', not a violation", () => {
    const { blanked } = enforceGrounding(
      { categoryId: "", partyId: "" },
      TASK_GROUNDING.transaction_parse,
      allowed,
    );
    expect(blanked).toEqual([]);
  });

  it("blanks everything on a path when no allowed set was supplied", () => {
    const { output, blanked } = enforceGrounding(
      { categoryId: "acct-1" },
      [{ path: "categoryId", set: "accounts" }],
      {},
    );
    expect(output.categoryId).toBe("");
    expect(blanked).toEqual(["categoryId"]);
  });

  it("does not mutate the caller's object", () => {
    const original = { categoryId: "acct-invented" };
    enforceGrounding(original, [{ path: "categoryId", set: "accounts" }], allowed);
    expect(original.categoryId).toBe("acct-invented");
  });

  it("leaves names intact so a reviewer still sees the intent", () => {
    const { output } = enforceGrounding(
      { categoryId: "acct-invented", categoryName: "Office Supplies" },
      TASK_GROUNDING.transaction_parse,
      allowed,
    );
    expect(output.categoryId).toBe("");
    expect(output.categoryName).toBe("Office Supplies");
  });

  it("grounds receipt entity matches too", () => {
    const { output, blanked } = enforceGrounding(
      { extractedEntities: [{ matchedPartyId: "party-1" }, { matchedPartyId: "party-fake" }] },
      TASK_GROUNDING.receipt_ocr,
      allowed,
    );
    expect(output.extractedEntities[1].matchedPartyId).toBe("");
    expect(blanked).toContain("extractedEntities[1].matchedPartyId");
  });

  it("is a no-op for tasks with no rules", () => {
    const input = { anything: "goes" };
    const { output, blanked } = enforceGrounding(input, [], allowed);
    expect(output).toBe(input);
    expect(blanked).toEqual([]);
  });
});
