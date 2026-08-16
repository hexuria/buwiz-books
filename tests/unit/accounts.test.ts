import { describe, it, expect } from "vitest";
import { insertAccountSchema } from "../../src/db/validation/accounts";

describe("Account Schema Validation", () => {
  it("should validate a valid account", () => {
    const validAccount = {
      organizationId: "org-test",
      name: "Checking Account",
      accountNumber: "11000",
      accountType: "asset" as const,
      subtype: "bank_accounts" as const,
    };

    const result = insertAccountSchema.safeParse(validAccount);
    expect(result.success).toBe(true);
  });

  it("should fail if name is missing", () => {
    const invalidAccount = {
      organizationId: "org-test",
      accountNumber: "11000",
      accountType: "asset" as const,
    };

    const result = insertAccountSchema.safeParse(invalidAccount);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.length).toBeGreaterThan(0);
      expect(result.error.issues[0].path).toContain("name");
    }
  });

  it("should fail for invalid account type", () => {
    const invalidAccount = {
      name: "Invalid Account",
      accountType: "not-a-type" as any,
    };

    const result = insertAccountSchema.safeParse(invalidAccount);
    expect(result.success).toBe(false);
  });

  it("should accept optional fields", () => {
    const fullAccount = {
      organizationId: "org-test",
      name: "Detailed Account",
      accountNumber: "12000",
      accountType: "asset" as const,
      subtype: "bank_accounts" as const,
      description: "Main checking account",
      icon: "🏦",
      isActive: true,
      isSystem: false,
    };

    const result = insertAccountSchema.safeParse(fullAccount);
    expect(result.success).toBe(true);
  });
});
