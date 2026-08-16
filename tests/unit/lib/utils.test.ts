import { describe, it, expect } from "vitest";
import { cn } from "../../../src/lib/utils";

describe("Utils - cn (class merging)", () => {
  it("should merge strings", () => {
    expect(cn("px-2 py-1", "bg-red-500")).toBe("px-2 py-1 bg-red-500");
  });

  it("should handle conditional classes", () => {
    const isTrue = true;
    const isFalse = false;
    expect(cn("p-2", isTrue && "m-2", isFalse && "b-2")).toBe("p-2 m-2");
  });

  it("should handle arrays", () => {
    expect(cn(["p-2", "m-2"])).toBe("p-2 m-2");
  });

  it("should deduplicate tailwind classes correctly", () => {
    // twMerge logic should override earlier classes with later ones
    expect(cn("px-2 py-1", "p-4")).toBe("p-4");
  });

  it("should handle objects for conditional rendering", () => {
    expect(cn("p-2", { "bg-red-500": true, "bg-blue-500": false })).toBe("p-2 bg-red-500");
  });

  it("should handle undefined and null", () => {
    expect(cn("p-2", null, undefined, "m-2")).toBe("p-2 m-2");
  });
});
