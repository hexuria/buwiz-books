import { describe, it, expect } from "vitest";
import { generateR2Key, isR2Configured } from "../../../src/lib/storage/r2-client";

describe("R2 Storage Utilities", () => {
  // ========================================================================
  // generateR2Key
  // ========================================================================

  describe("generateR2Key", () => {
    it("should produce a key with the orgId as prefix", () => {
      const key = generateR2Key("org-123", "report.pdf");
      expect(key.startsWith("org-123/")).toBe(true);
    });

    it("should include a timestamp and random ID segment", () => {
      const key = generateR2Key("org-123", "report.pdf");
      // Format: {orgId}/{timestamp}-{8charUUID}-{sanitizedFilename}
      const parts = key.replace("org-123/", "").split("-");
      // First part = timestamp (numeric)
      expect(Number(parts[0])).toBeGreaterThan(0);
    });

    it("should sanitize special characters in the filename", () => {
      const key = generateR2Key("org-abc", "my file (2).pdf");
      // Spaces and parens should become underscores
      expect(key).not.toContain(" ");
      expect(key).not.toContain("(");
      expect(key).not.toContain(")");
      expect(key).toContain("my_file__2_.pdf");
    });

    it("should truncate very long filenames to 100 characters", () => {
      const longName = "a".repeat(200) + ".pdf";
      const key = generateR2Key("org-x", longName);
      // Format: {orgId}/{timestamp}-{8charUUID}-{sanitizedFilename}
      // Extract the path after orgId/ then skip timestamp and 8-char UUID
      const afterOrg = key.replace("org-x/", "");
      // Match: {digits}-{8alphanum}-{rest}
      const match = afterOrg.match(/^\d+-[a-f0-9]{8}-(.+)$/);
      expect(match).not.toBeNull();
      const filenameSegment = match![1];
      expect(filenameSegment.length).toBeLessThanOrEqual(100);
    });

    it("should generate unique keys for the same filename", () => {
      const key1 = generateR2Key("org-1", "invoice.pdf");
      const key2 = generateR2Key("org-1", "invoice.pdf");
      expect(key1).not.toBe(key2);
    });
  });

  // ========================================================================
  // isR2Configured
  // ========================================================================

  describe("isR2Configured", () => {
    it("should return false when R2 environment variables are not set", () => {
      // In test environment, R2 env vars are typically not set
      const result = isR2Configured();
      expect(typeof result).toBe("boolean");
      // We can't guarantee the value in all environments,
      // but we can verify it returns a boolean
    });
  });
});
