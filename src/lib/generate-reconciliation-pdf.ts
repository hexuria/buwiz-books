/**
 * Reconciliation Report PDF Generator
 * Generates a reconciliation report PDF using jsPDF
 */
import { jsPDF } from "jspdf";
import { serverBrand } from "@/config/brand";

export interface ReportTransaction {
  date: string;
  type: string;
  payee: string;
  amount: number;
}

export interface ReconciliationReportData {
  accountName: string;
  accountNumber: string | null;
  periodStart: string;
  periodEnd: string;
  preparedBy: string;
  preparedDate: string;
  statementBeginningBalance: number;
  statementEndingBalance: number;
  ledgerBalance: number;
  credits: ReportTransaction[];
  debits: ReportTransaction[];
}

// ── Formatting helpers ──

function fmtCurrency(val: number): string {
  const abs = Math.abs(val);
  const formatted = abs.toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return val < 0 ? `-$${formatted}` : `$${formatted}`;
}

function fmtDate(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}/${d.getFullYear()}`;
}

// ── Colors ──
const BRAND_GREEN = [16, 185, 129] as const; // #10b981
const HEADER_BG = [240, 253, 244] as const; // light green bg
const TABLE_HEADER_BG = [243, 244, 246] as const; // #f3f4f6
const TEXT_PRIMARY = [31, 41, 55] as const; // #1f2937
const TEXT_SECONDARY = [107, 114, 128] as const; // #6b7280
const BORDER_COLOR = [229, 231, 235] as const; // #e5e7eb

export function generateReconciliationPDF(data: ReconciliationReportData): Blob {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "a4" });
  const pageW = doc.internal.pageSize.getWidth();
  const margin = 15;
  const contentW = pageW - margin * 2;
  let y = 0;

  function checkPageBreak(neededHeight: number) {
    const pageH = doc.internal.pageSize.getHeight();
    if (y + neededHeight > pageH - 15) {
      doc.addPage();
      y = 15;
    }
  }

  // ── Header Banner ──
  doc.setFillColor(...HEADER_BG);
  doc.rect(0, 0, pageW, 42, "F");
  doc.setFillColor(...BRAND_GREEN);
  doc.rect(0, 0, pageW, 3, "F"); // top accent line

  y = 12;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.setTextColor(...TEXT_PRIMARY);
  doc.text("Reconciliation Report", margin, y);

  y += 6;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...TEXT_SECONDARY);
  doc.text(`Prepared by ${data.preparedBy} on ${data.preparedDate}`, margin, y);

  y += 5;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...TEXT_PRIMARY);
  doc.text(data.accountName, margin, y);

  if (data.accountNumber) {
    doc.setFont("helvetica", "normal");
    doc.setFontSize(9);
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text(`Account no. ${data.accountNumber}`, margin, y + 5);
    y += 5;
  }

  y += 5;
  doc.setFontSize(9);
  doc.setTextColor(...TEXT_SECONDARY);
  doc.text(`${fmtDate(data.periodStart)} – ${fmtDate(data.periodEnd)}`, margin, y);

  // ── Summary Section ──
  y += 12;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(13);
  doc.setTextColor(...TEXT_PRIMARY);
  doc.text("Summary", margin, y);

  y += 2;
  doc.setDrawColor(...BORDER_COLOR);
  doc.setLineWidth(0.3);
  doc.line(margin, y, margin + contentW, y);

  const creditsTotal = data.credits.reduce((s, c) => s + Math.abs(c.amount), 0);
  const debitsTotal = data.debits.reduce((s, d) => s + Math.abs(d.amount), 0);

  const summaryRows = [
    { label: "Statement beginning balance", value: fmtCurrency(data.statementBeginningBalance) },
    { label: `Credits (${data.credits.length})`, value: fmtCurrency(-creditsTotal) },
    { label: `Debits (${data.debits.length})`, value: fmtCurrency(debitsTotal) },
    { label: "Statement ending balance", value: fmtCurrency(data.statementEndingBalance) },
    {
      label: `Ledger balance as of ${fmtDate(data.periodEnd)}`,
      value: fmtCurrency(data.ledgerBalance),
    },
  ];

  y += 3;
  for (const row of summaryRows) {
    y += 6;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(10);
    doc.setTextColor(...TEXT_PRIMARY);
    doc.text(row.label, margin + 2, y);
    doc.setFont("helvetica", "bold");
    doc.text(row.value, margin + contentW - 2, y, { align: "right" });
  }

  // Divider after statement ending balance
  y += 3;
  doc.setDrawColor(...BORDER_COLOR);
  doc.line(margin, y, margin + contentW, y);

  // ── Detail Tables ──
  function drawDetailTable(title: string, transactions: ReportTransaction[]) {
    checkPageBreak(30);
    y += 10;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(13);
    doc.setTextColor(...TEXT_PRIMARY);
    doc.text(title, margin, y);

    y += 2;
    doc.setDrawColor(...BORDER_COLOR);
    doc.line(margin, y, margin + contentW, y);

    if (transactions.length === 0) {
      y += 7;
      doc.setFont("helvetica", "italic");
      doc.setFontSize(9);
      doc.setTextColor(...TEXT_SECONDARY);
      doc.text("No transactions", margin + 2, y);
      return;
    }

    // Table header
    y += 1;
    doc.setFillColor(...TABLE_HEADER_BG);
    doc.rect(margin, y, contentW, 7, "F");
    y += 5;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...TEXT_SECONDARY);

    const colDate = margin + 2;
    const colType = margin + 28;
    const colPayee = margin + 58;
    const colAmount = margin + contentW - 2;

    doc.text("Date", colDate, y);
    doc.text("Type", colType, y);
    doc.text("Payee", colPayee, y);
    doc.text("Amount", colAmount, y, { align: "right" });

    y += 3;

    // Table rows
    let total = 0;
    for (const txn of transactions) {
      checkPageBreak(7);
      y += 5;
      doc.setFont("helvetica", "normal");
      doc.setFontSize(9);
      doc.setTextColor(...TEXT_PRIMARY);

      doc.text(fmtDate(txn.date), colDate, y);
      doc.text(txn.type, colType, y);

      // Truncate payee if too long
      const maxPayeeW = colAmount - colPayee - 15;
      let payee = txn.payee;
      while (doc.getTextWidth(payee) > maxPayeeW && payee.length > 3) {
        payee = `${payee.substring(0, payee.length - 4)}...`;
      }
      doc.text(payee, colPayee, y);

      doc.setFont("helvetica", "normal");
      doc.text(fmtCurrency(Math.abs(txn.amount)), colAmount, y, { align: "right" });

      total += Math.abs(txn.amount);

      // Light divider between rows
      doc.setDrawColor(245, 245, 245);
      doc.setLineWidth(0.15);
      doc.line(margin, y + 2, margin + contentW, y + 2);
    }

    // Total row
    checkPageBreak(10);
    y += 3;
    doc.setDrawColor(...BORDER_COLOR);
    doc.setLineWidth(0.3);
    doc.line(margin, y, margin + contentW, y);
    y += 6;
    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...TEXT_PRIMARY);
    doc.text("Total", margin + 2, y);
    doc.text(fmtCurrency(total), colAmount, y, { align: "right" });
  }

  // Credits section
  drawDetailTable(`Credits (${data.credits.length})`, data.credits);

  // Debits section
  drawDetailTable(`Debits (${data.debits.length})`, data.debits);

  // ── Footer ──
  const pageCount = doc.getNumberOfPages();
  for (let i = 1; i <= pageCount; i++) {
    doc.setPage(i);
    const footerY = doc.internal.pageSize.getHeight() - 8;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text(`Page ${i} of ${pageCount}`, pageW / 2, footerY, { align: "center" });
    doc.text(`Generated by ${serverBrand.appName}`, pageW - margin, footerY, { align: "right" });
  }

  return doc.output("blob");
}
