import { describe, it, expect, vi } from "vitest";
import { callServerFn } from "../../../src/lib/server-fn-client";

describe("Server Fn Client", () => {
  describe("callServerFn", () => {
    it("should call the provided function with the given input", async () => {
      const mockFn = vi.fn().mockResolvedValue({ success: true, data: "test" });
      const input = { id: 1 };

      const result = await callServerFn(mockFn, input);

      expect(mockFn).toHaveBeenCalledOnce();
      expect(mockFn).toHaveBeenCalledWith(input);
      expect(result).toEqual({ success: true, data: "test" });
    });

    it("should correctly propagate errors from the server function", async () => {
      const mockError = new Error("Server error");
      const mockFn = vi.fn().mockRejectedValue(mockError);

      await expect(callServerFn(mockFn, {})).rejects.toThrow("Server error");
    });
  });
});
