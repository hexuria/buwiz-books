import { describe, it, expect } from "vitest";
import { escapeLikePattern } from "../../../src/lib/sql-escape";

describe("escapeLikePattern", () => {
  it("leaves ordinary text unchanged", () => {
    expect(escapeLikePattern("Acme Corporation")).toBe("Acme Corporation");
  });

  it("escapes % so it matches literally", () => {
    expect(escapeLikePattern("50% Off Store")).toBe("50\\% Off Store");
  });

  it("escapes _ so it matches literally", () => {
    expect(escapeLikePattern("A_B Traders")).toBe("A\\_B Traders");
  });

  it("escapes backslashes first (no double-escaping)", () => {
    expect(escapeLikePattern("path\\to")).toBe("path\\\\to");
  });

  it("escapes a mix of metacharacters", () => {
    expect(escapeLikePattern("a%b_c\\d")).toBe("a\\%b\\_c\\\\d");
  });
});
