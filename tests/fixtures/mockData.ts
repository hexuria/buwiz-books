/**
 * Mock Data Fixtures
 * Sample data for testing
 */

export const mockAccount = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  accountNumber: "10000",
  name: "Cash",
  accountType: "asset" as const,
  subtype: "bank_accounts" as const,
  isActive: true,
  isSystem: false,
  createdAt: new Date("2024-01-01"),
  updatedAt: new Date("2024-01-01"),
};
