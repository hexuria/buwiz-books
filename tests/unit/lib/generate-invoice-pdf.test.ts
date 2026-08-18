import { describe, expect, it } from "vitest";
import { generateInvoicePdf } from "../../../src/lib/generate-invoice-pdf";

const base = {
  invoiceNumber: "INV-TEST",
  issueDate: "2026-07-01",
  dueDate: "2026-07-31",
  status: "sent",
  orgName: "Test Business",
  customerName: "Customer",
  subtotal: "800.00",
  discountAmount: "0",
  taxAmount: "0",
  total: "800.00",
  amountPaid: "0",
  balanceDue: "800.00",
  notes: "Thank you.",
  paymentTerms: "Net 30",
};

describe("generateInvoicePdf", () => {
  it("paginates long invoices", () => {
    const doc = generateInvoicePdf({
      ...base,
      currency: "USD",
      lineItems: Array.from({ length: 80 }, (_, index) => ({
        description: `Line item ${index + 1} with a description long enough to exercise wrapping`,
        quantity: "1",
        unitPrice: "10.00",
        amount: "10.00",
      })),
    });

    expect(doc.getNumberOfPages()).toBeGreaterThan(1);
    expect(doc.output("arraybuffer").byteLength).toBeGreaterThan(0);
  });

  it("renders the invoice's own currency, not a USD default", () => {
    // `currency` used to be optional and fell back to "USD", so a Philippine
    // invoice printed its totals as dollars on the document the customer is
    // sent. It is required now — this asserts the value actually reaches the
    // rendered page rather than merely being accepted.
    const doc = generateInvoicePdf({
      ...base,
      currency: "PHP",
      lineItems: [{ description: "Service", quantity: "1", unitPrice: "800.00", amount: "800.00" }],
    });

    // jsPDF keeps the drawn strings in its uncompressed page content stream.
    const raw = doc.output("arraybuffer");
    const body = new TextDecoder("latin1").decode(new Uint8Array(raw));
    expect(body).toContain("PHP");
    expect(body).not.toContain("USD");
  });
});
