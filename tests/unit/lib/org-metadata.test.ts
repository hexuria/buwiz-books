import { describe, it, expect } from "vitest";
import { orgMetadataSchema, parseOrgMetadata } from "../../../src/lib/org-metadata";

describe("Org Metadata", () => {
  // ========================================================================
  // orgMetadataSchema
  // ========================================================================

  describe("orgMetadataSchema", () => {
    it("should accept an empty object", () => {
      const result = orgMetadataSchema.parse({});
      expect(result).toEqual({});
    });

    it("should strip Gemini API keys from browser-visible metadata", () => {
      const result = orgMetadataSchema.parse({
        geminiApiKeys: ["key-1", "key-2"],
        geminiDefaultModel: "gemini-2.5-flash",
      });
      expect((result as Record<string, unknown>).geminiApiKeys).toBeUndefined();
      expect(result.geminiDefaultModel).toBe("gemini-2.5-flash");
    });

    it("should accept all AI model fields", () => {
      const result = orgMetadataSchema.parse({
        aiModelOcr: "gemini-pro-vision",
        aiModelTextAnalysis: "gemini-pro",
        aiModelImageGen: "imagen-3",
        enableImageGeneration: true,
      });
      expect(result.enableImageGeneration).toBe(true);
    });

    it("should accept email configuration", () => {
      const result = orgMetadataSchema.parse({
        emailSenderName: "Acme Corp",
        emailSenderEmail: "billing@acme.com",
        resendApiKey: "re_secret_123",
      });
      expect(result.emailSenderName).toBe("Acme Corp");
    });

    it("should accept address fields", () => {
      const result = orgMetadataSchema.parse({
        addressStreet: "123 Main St",
        addressCity: "San Francisco",
        addressState: "CA",
        addressPostalCode: "94102",
        addressCountry: "US",
      });
      expect(result.addressCity).toBe("San Francisco");
    });

    it("should accept payment provider configuration", () => {
      const result = orgMetadataSchema.parse({
        paymentProvider: "stripe",
        stripePublishableKey: "pk_test_123",
        stripeSecretKey: "sk_test_456",
        stripeWebhookSecret: "whsec_789",
      });
      expect(result.paymentProvider).toBe("stripe");
    });

    it("should validate paypalMode enum (sandbox|live)", () => {
      expect(orgMetadataSchema.parse({ paypalMode: "sandbox" }).paypalMode).toBe("sandbox");
      expect(orgMetadataSchema.parse({ paypalMode: "live" }).paypalMode).toBe("live");
      expect(() => orgMetadataSchema.parse({ paypalMode: "test" })).toThrow();
    });

    it("should strip unknown and secret keys", () => {
      const result = orgMetadataSchema.parse({
        unknownFutureField: "value",
        geminiApiKeys: ["key-1"],
      });
      expect((result as Record<string, unknown>).geminiApiKeys).toBeUndefined();
      expect((result as Record<string, unknown>).unknownFutureField).toBeUndefined();
    });
  });

  // ========================================================================
  // parseOrgMetadata
  // ========================================================================

  describe("parseOrgMetadata", () => {
    it("should return empty object for null input", () => {
      expect(parseOrgMetadata(null)).toEqual({});
    });

    it("should return empty object for undefined input", () => {
      expect(parseOrgMetadata(undefined)).toEqual({});
    });

    it("should return empty object for empty string", () => {
      expect(parseOrgMetadata("")).toEqual({});
    });

    it("should return empty object for invalid JSON", () => {
      expect(parseOrgMetadata("not-json")).toEqual({});
    });

    it("should parse valid JSON metadata", () => {
      const json = JSON.stringify({
        geminiApiKeys: ["key-1"],
        currency: "PHP",
      });
      const result = parseOrgMetadata(json);
      expect((result as Record<string, unknown>).geminiApiKeys).toBeUndefined();
      expect(result.currency).toBe("PHP");
    });

    it("should return empty object for JSON with invalid schema values", () => {
      const json = JSON.stringify({
        paypalMode: "invalid_mode",
      });
      const result = parseOrgMetadata(json);
      expect(result).toEqual({});
    });
  });
});
