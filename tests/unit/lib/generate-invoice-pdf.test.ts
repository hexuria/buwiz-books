import { describe, expect, it } from "vitest";
import { generateInvoicePdf } from "../../../src/lib/generate-invoice-pdf";

describe("generateInvoicePdf", () => {
  it("paginates long invoices", () => {
    const doc = generateInvoicePdf({
      invoiceNumber: "INV-TEST",
      issueDate: "2026-07-01",
      dueDate: "2026-07-31",
      status: "sent",
      orgName: "Test Business",
      customerName: "Customer",
      lineItems: Array.from({ length: 80 }, (_, index) => ({
        description: `Line item ${index + 1} with a description long enough to exercise wrapping`,
        quantity: "1",
        unitPrice: "10.00",
        amount: "10.00",
      })),
      subtotal: "800.00",
      discountAmount: "0",
      taxAmount: "0",
      total: "800.00",
      amountPaid: "0",
      balanceDue: "800.00",
      notes: "Thank you.",
      paymentTerms: "Net 30",
    });

    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    expect(doc.output("arraybuffer").byteLength).toBeGreaterThan(0);
  });
});
