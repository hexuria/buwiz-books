/**
 * Invoice PDF Generator — produces a clean, professional invoice PDF with jsPDF.
 * Runs on both server (email attachment via arraybuffer) and client (download via .save()).
 *
 * Previously the product's docs promised a PDF attachment/download that did not exist.
 */
import { jsPDF } from "jspdf";

export interface InvoicePdfLineItem {
  description: string | null;
  quantity: string;
  unitPrice: string;
  amount: string;
}

export interface InvoicePdfData {
  invoiceNumber: string;
  issueDate: string;
  dueDate: string;
  status: string;
  orgName: string;
  customerName: string | null;
  lineItems: InvoicePdfLineItem[];
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  amountPaid: string;
  balanceDue: string;
  notes: string | null;
  paymentTerms: string | null;
  /**
   * ISO 4217 code the invoice is denominated in. Required rather than
   * defaulted: this used to fall back to "USD", so a Philippine invoice
   * rendered its totals as dollars on the document the customer receives.
   */
  currency: string;
}

function money(value: string | number, currency: string): string {
  const n = typeof value === "number" ? value : Number.parseFloat(value || "0");
  return `${currency} ${n.toFixed(2)}`;
}

/**
 * Build the invoice document. Callers:
 *   - server: `doc.output("arraybuffer")` → Buffer for an email attachment
 *   - client: `doc.save(filename)` to download
 */
export function generateInvoicePdf(data: InvoicePdfData): jsPDF {
  const currency = data.currency;
  const doc = new jsPDF({ unit: "pt", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const marginX = 48;
  const bottomMargin = 48;
  let y = 56;

  // ── Header: org name (left) + INVOICE (right) ──
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(30, 41, 59);
  doc.text(data.orgName || "Invoice", marginX, y);

  doc.setFontSize(22);
  doc.setTextColor(99, 102, 241);
  doc.text("INVOICE", pageW - marginX, y, { align: "right" });

  y += 22;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(100, 116, 139);
  doc.text(`#${data.invoiceNumber}`, pageW - marginX, y, { align: "right" });

  // ── Bill-to + meta ──
  y += 34;
  doc.setFontSize(9);
  doc.setTextColor(148, 163, 184);
  doc.text("BILL TO", marginX, y);
  doc.text("DETAILS", pageW - marginX - 180, y);

  y += 15;
  doc.setFontSize(11);
  doc.setTextColor(30, 41, 59);
  doc.text(data.customerName || "—", marginX, y);

  doc.setFontSize(9);
  doc.setTextColor(71, 85, 105);
  const metaX = pageW - marginX - 180;
  doc.text(`Issue date:  ${data.issueDate}`, metaX, y);
  doc.text(`Due date:    ${data.dueDate}`, metaX, y + 14);
  doc.text(`Status:      ${data.status}`, metaX, y + 28);

  // ── Line-item table ──
  y += 54;
  const colDesc = marginX;
  const colQty = pageW - marginX - 260;
  const colPrice = pageW - marginX - 150;
  const colAmt = pageW - marginX;

  const drawTableHeader = () => {
    doc.setFillColor(30, 41, 59);
    doc.rect(marginX, y - 12, pageW - marginX * 2, 22, "F");
    doc.setTextColor(255, 255, 255);
    doc.setFontSize(9);
    doc.setFont("helvetica", "bold");
    doc.text("DESCRIPTION", colDesc + 6, y + 3);
    doc.text("QTY", colQty, y + 3, { align: "right" });
    doc.text("UNIT PRICE", colPrice, y + 3, { align: "right" });
    doc.text("AMOUNT", colAmt - 6, y + 3, { align: "right" });
    y += 22;
  };
  const startContinuationPage = () => {
    doc.addPage();
    y = 48;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(11);
    doc.setTextColor(30, 41, 59);
    doc.text(`${data.orgName} — Invoice #${data.invoiceNumber}`, marginX, y);
    y += 30;
    drawTableHeader();
  };

  drawTableHeader();
  doc.setFont("helvetica", "normal");
  doc.setTextColor(30, 41, 59);
  data.lineItems.forEach((li, i) => {
    const descriptionLines = doc.splitTextToSize(
      li.description || "—",
      colQty - colDesc - 60,
    ) as string[];
    const rowHeight = Math.max(20, descriptionLines.length * 11 + 8);
    if (y + rowHeight > pageH - bottomMargin) {
      startContinuationPage();
      doc.setFont("helvetica", "normal");
      doc.setTextColor(30, 41, 59);
    }
    if (i % 2 === 1) {
      doc.setFillColor(241, 245, 249);
      doc.rect(marginX, y - 11, pageW - marginX * 2, rowHeight, "F");
    }
    doc.text(descriptionLines, colDesc + 6, y + 2);
    doc.text(String(Number.parseFloat(li.quantity || "0")), colQty, y + 2, { align: "right" });
    doc.text(money(li.unitPrice, currency), colPrice, y + 2, { align: "right" });
    doc.text(money(li.amount, currency), colAmt - 6, y + 2, { align: "right" });
    y += rowHeight;
  });

  // ── Totals ──
  const totalsHeight =
    80 +
    (Number.parseFloat(data.discountAmount || "0") > 0 ? 16 : 0) +
    (Number.parseFloat(data.taxAmount || "0") > 0 ? 16 : 0) +
    (Number.parseFloat(data.amountPaid || "0") > 0 ? 36 : 0);
  if (y + totalsHeight > pageH - bottomMargin) {
    doc.addPage();
    y = 56;
  }
  y += 12;
  const labelX = pageW - marginX - 150;
  const valX = pageW - marginX - 6;
  const totalRow = (label: string, value: string, bold = false) => {
    doc.setFont("helvetica", bold ? "bold" : "normal");
    doc.setFontSize(bold ? 12 : 10);
    doc.setTextColor(bold ? 30 : 71, bold ? 41 : 85, bold ? 59 : 105);
    doc.text(label, labelX, y, { align: "right" });
    doc.text(value, valX, y, { align: "right" });
    y += bold ? 20 : 16;
  };
  totalRow("Subtotal", money(data.subtotal, currency));
  if (Number.parseFloat(data.discountAmount || "0") > 0) {
    totalRow("Discount", `- ${money(data.discountAmount, currency)}`);
  }
  if (Number.parseFloat(data.taxAmount || "0") > 0) {
    totalRow("Tax", money(data.taxAmount, currency));
  }
  totalRow("Total", money(data.total, currency), true);
  if (Number.parseFloat(data.amountPaid || "0") > 0) {
    totalRow("Paid", `- ${money(data.amountPaid, currency)}`);
    totalRow("Balance Due", money(data.balanceDue, currency), true);
  }

  // ── Notes / terms ──
  if (data.notes || data.paymentTerms) {
    const noteWidth = pageW - marginX * 2;
    const noteLines = data.notes ? (doc.splitTextToSize(data.notes, noteWidth) as string[]) : [];
    const notesHeight = 48 + (data.paymentTerms ? 14 : 0) + noteLines.length * 11;
    if (y + notesHeight > pageH - bottomMargin) {
      doc.addPage();
      y = 56;
    }
    y += 20;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(9);
    doc.setTextColor(148, 163, 184);
    doc.text("NOTES", marginX, y);
    y += 14;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(71, 85, 105);
    if (data.paymentTerms) {
      doc.text(`Payment terms: ${data.paymentTerms}`, marginX, y, {
        maxWidth: pageW - marginX * 2,
      });
      y += 14;
    }
    if (data.notes) {
      doc.text(noteLines, marginX, y);
    }
  }

  const pageCount = doc.getNumberOfPages();
  for (let page = 1; page <= pageCount; page++) {
    doc.setPage(page);
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(148, 163, 184);
    doc.text(`Page ${page} of ${pageCount}`, pageW - marginX, pageH - 24, {
      align: "right",
    });
  }

  return doc;
}

/** Server-side: invoice PDF as a Buffer, for an email attachment. */
export function invoicePdfBuffer(data: InvoicePdfData): Buffer {
  const doc = generateInvoicePdf(data);
  return Buffer.from(doc.output("arraybuffer"));
}
