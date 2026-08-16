import { describe, expect, it } from "vitest";
import { isDateLocked } from "../../../src/lib/period-lock-policy";

describe("isDateLocked", () => {
  it("returns unlocked without a close boundary", () => {
    expect(isDateLocked("2026-01-15", null)).toBe(false);
  });

  it("locks dates before and on the close boundary", () => {
    expect(isDateLocked("2026-01-15", "2026-01-31")).toBe(true);
    expect(isDateLocked("2026-01-31", "2026-01-31")).toBe(true);
  });

  it("leaves later dates unlocked", () => {
    expect(isDateLocked("2026-02-01", "2026-01-31")).toBe(false);
  });
});
