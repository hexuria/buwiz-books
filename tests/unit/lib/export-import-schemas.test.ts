/**
 * Tests for the Zod validation schemas used by the import flow.
 * We import getRowSchema indirectly by testing the schemas via safeParse.
 * Since getRowSchema is not exported, we replicate the schemas here for isolation.
 */
import { describe, expect, it } from "vitest";
import { z } from "zod";

// ── Replicated schemas (matching src/routes/api/-export-import.ts) ─────────
// We replicate rather than import because the server file uses createServerFn
// which requires a Nitro context and cannot be imported in a jsdom unit test.

const bankRowSchema = z.object({
  accountName: z.string().min(1, "Account name is required"),
  institutionName: z.string().optional().nullable(),
  accountType: z.enum([
    "checking",
    "savings",
    "credit_card",
    "money_market",
    "investment",
    "other",
  ]),
  lastFour: z.string().max(4).optional().nullable(),
  isManual: z.boolean().optional().default(true),
  connectionStatus: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const vendorRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  partyType: z.enum(["vendor", "customer", "both"]).optional().default("vendor"),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  website: z.string().optional().nullable(),
  address: z
    .object({
      street: z.string().optional(),
      city: z.string().optional(),
      state: z.string().optional(),
      postalCode: z.string().optional(),
      country: z.string().optional(),
    })
    .optional()
    .nullable(),
  is1099Vendor: z.boolean().optional().default(false),
  taxId: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const customerRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  partyType: z.enum(["vendor", "customer", "both"]).optional().default("customer"),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  creditLimit: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const partyRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  partyType: z.string().optional(),
  email: z.string().optional().nullable(),
  phone: z.string().optional().nullable(),
  paymentTerms: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  notes: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const categoryRowSchema = z.object({
  accountNumber: z.string().optional().nullable(),
  name: z.string().min(1, "Name is required"),
  description: z.string().optional().nullable(),
  accountType: z.string().min(1, "Account type is required"),
  subtype: z.string().optional().nullable(),
  parentName: z.string().optional().nullable(),
  icon: z.string().optional().nullable(),
  status: z.string().optional().default("active"),
  isActive: z.boolean().optional().default(true),
});

const dimensionRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  code: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  parentName: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

const productRowSchema = z.object({
  name: z.string().min(1, "Name is required"),
  defaultPrice: z.string().optional().nullable(),
  description: z.string().optional().nullable(),
  isActive: z.boolean().optional().default(true),
});

// ============================================================================
// Tests
// ============================================================================

describe("export-import schemas", () => {
  // ── bankRowSchema ─────────────────────────────────────────────────────────

  describe("bankRowSchema", () => {
    it("accepts a valid bank row", () => {
      const result = bankRowSchema.safeParse({
        accountName: "Business Checking",
        accountType: "checking",
        lastFour: "4321",
        isManual: true,
        isActive: true,
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing accountName", () => {
      const result = bankRowSchema.safeParse({
        accountType: "checking",
      });
      expect(result.success).toBe(false);
    });

    it("rejects invalid accountType", () => {
      const result = bankRowSchema.safeParse({
        accountName: "Test",
        accountType: "crypto_wallet",
      });
      expect(result.success).toBe(false);
    });

    it("defaults isManual to true when omitted", () => {
      const result = bankRowSchema.safeParse({
        accountName: "Savings",
        accountType: "savings",
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isManual).toBe(true);
      }
    });
  });

  // ── vendorRowSchema ───────────────────────────────────────────────────────

  describe("vendorRowSchema", () => {
    it("accepts a minimal vendor row with just name", () => {
      const result = vendorRowSchema.safeParse({ name: "Acme Supplies" });
      expect(result.success).toBe(true);
    });

    it("accepts a full vendor row with address object", () => {
      const result = vendorRowSchema.safeParse({
        name: "Acme Supplies",
        partyType: "vendor",
        email: "billing@acme.com",
        phone: "555-0100",
        address: {
          street: "123 Main St",
          city: "Springfield",
          state: "IL",
          postalCode: "62701",
          country: "US",
        },
        is1099Vendor: true,
        taxId: "12-3456789",
        paymentTerms: "net_30",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing name", () => {
      const result = vendorRowSchema.safeParse({ email: "test@test.com" });
      expect(result.success).toBe(false);
    });

    it("defaults partyType to vendor when omitted", () => {
      const result = vendorRowSchema.safeParse({ name: "Test Vendor" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.partyType).toBe("vendor");
      }
    });
  });

  // ── customerRowSchema ─────────────────────────────────────────────────────

  describe("customerRowSchema", () => {
    it("accepts a minimal customer row", () => {
      const result = customerRowSchema.safeParse({ name: "Globex Corp" });
      expect(result.success).toBe(true);
    });

    it("defaults partyType to customer", () => {
      const result = customerRowSchema.safeParse({ name: "Globex Corp" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.partyType).toBe("customer");
      }
    });

    it("accepts creditLimit as string", () => {
      const result = customerRowSchema.safeParse({
        name: "Big Client",
        creditLimit: "50000.00",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing name", () => {
      const result = customerRowSchema.safeParse({ email: "test@test.com" });
      expect(result.success).toBe(false);
    });
  });

  // ── partyRowSchema (employees, shareholders, lenders, government) ────────

  describe("partyRowSchema", () => {
    it("accepts a minimal party row with just name", () => {
      const result = partyRowSchema.safeParse({ name: "John Doe" });
      expect(result.success).toBe(true);
    });

    it("accepts optional fields", () => {
      const result = partyRowSchema.safeParse({
        name: "Jane Smith",
        partyType: "employee",
        email: "jane@company.com",
        phone: "555-9999",
        description: "Senior engineer",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing name", () => {
      const result = partyRowSchema.safeParse({ email: "test@test.com" });
      expect(result.success).toBe(false);
    });

    it("defaults isActive to true", () => {
      const result = partyRowSchema.safeParse({ name: "Test" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isActive).toBe(true);
      }
    });
  });

  // ── categoryRowSchema ─────────────────────────────────────────────────────

  describe("categoryRowSchema", () => {
    it("accepts a valid category", () => {
      const result = categoryRowSchema.safeParse({
        accountNumber: "10000",
        name: "Assets",
        accountType: "asset",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing accountType", () => {
      const result = categoryRowSchema.safeParse({
        name: "Assets",
      });
      expect(result.success).toBe(false);
    });

    it("rejects missing name", () => {
      const result = categoryRowSchema.safeParse({
        accountType: "asset",
      });
      expect(result.success).toBe(false);
    });

    it("accepts null parentName", () => {
      const result = categoryRowSchema.safeParse({
        name: "Assets",
        accountType: "asset",
        parentName: null,
      });
      expect(result.success).toBe(true);
    });

    it("accepts parentName as string", () => {
      const result = categoryRowSchema.safeParse({
        name: "Cash",
        accountType: "asset",
        parentName: "Assets",
      });
      expect(result.success).toBe(true);
    });
  });

  // ── dimensionRowSchema (departments, locations) ───────────────────────────

  describe("dimensionRowSchema", () => {
    it("accepts a minimal dimension with just name", () => {
      const result = dimensionRowSchema.safeParse({ name: "Engineering" });
      expect(result.success).toBe(true);
    });

    it("accepts full dimension with code and parent", () => {
      const result = dimensionRowSchema.safeParse({
        name: "Frontend",
        code: "FE",
        description: "Frontend team",
        parentName: "Engineering",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing name", () => {
      const result = dimensionRowSchema.safeParse({ code: "ENG" });
      expect(result.success).toBe(false);
    });
  });

  // ── productRowSchema ──────────────────────────────────────────────────────

  describe("productRowSchema", () => {
    it("accepts a minimal product with just name", () => {
      const result = productRowSchema.safeParse({ name: "Widget A" });
      expect(result.success).toBe(true);
    });

    it("accepts product with defaultPrice", () => {
      const result = productRowSchema.safeParse({
        name: "Premium Widget",
        defaultPrice: "99.99",
        description: "Our best widget",
      });
      expect(result.success).toBe(true);
    });

    it("rejects missing name", () => {
      const result = productRowSchema.safeParse({ defaultPrice: "10.00" });
      expect(result.success).toBe(false);
    });

    it("defaults isActive to true", () => {
      const result = productRowSchema.safeParse({ name: "Test Product" });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.isActive).toBe(true);
      }
    });
  });
});
