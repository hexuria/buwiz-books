/**
 * Bank Statement PDF Generator
 * Creates a Mercury-style bank statement PDF from ledger transactions.
 * Matches the real Mercury bank statement layout:
 *   - Centered account title + statement period
 *   - Two-column entity / account info
 *   - Blue summary bar (Beginning, Withdrawals, Deposits, Ending)
 *   - Dark-header transaction table with zebra rows
 *   - Red withdrawals / green deposits, running "End of Day Balance"
 *
 * Also returns deterministic bounding boxes (0-1000 normalised coords)
 * for every metadata field and transaction row so the reconciliation
 * viewer can render SVG overlays — no AI/OCR needed.
 *
 * Uses jsPDF — runs on server or client.
 */
import { jsPDF } from "jspdf";

// ============================================================================
// Types
// ============================================================================

export interface BankStatementTransaction {
  id?: string;
  date: string;
  description: string;
  detail?: string;
  amount: number;
  runningBalance: number;
}

export interface BankStatementData {
  bankName: string;
  accountName: string;
  accountNumber: string | null;
  accountType: string;
  entityName: string;
  entityAddress?: string;
  entityEin?: string;
  periodStart: string;
  periodEnd: string;
  openingBalance: number;
  closingBalance: number;
  transactions: BankStatementTransaction[];
}

/** Bounding box in the 0-1000 normalised coordinate system used by the SVG viewer */
export interface StatementBBox {
  /** Unique ID — either a metadata field key or the statement-line UUID */
  id: string;
  /** Human-readable label for tooltip */
  label: string;
  /** Extracted text content */
  text?: string;
  /** [ymin, xmin, ymax, xmax] 0-1000 */
  bbox: [number, number, number, number];
  /** Page number (0-based) */
  page: number;
  /** Field category for colour-coding */
  fieldType: "header" | "metadata" | "summary" | "transaction" | "footer";
}

export interface GenerateResult {
  blob: Blob;
  boundingBoxes: StatementBBox[];
}

// ============================================================================
// Formatting
// ============================================================================

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

function fmtDateShort(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00`);
  return `${String(d.getMonth() + 1).padStart(2, "0")}/${String(d.getDate()).padStart(2, "0")}`;
}

function fmtPeriodTitle(start: string, _end: string): string {
  const s = new Date(`${start}T00:00:00`);
  return `${s.toLocaleString("en-US", { month: "long" })} ${s.getFullYear()} Statement`;
}

// ============================================================================
// Colors (Mercury-style)
// ============================================================================

const SLATE_900 = [15, 23, 42] as const; // Dark navy header
const SLATE_700 = [51, 65, 85] as const; // Table header bg
const SLATE_500 = [100, 116, 139] as const; // Secondary text
const SLATE_200 = [226, 232, 240] as const; // Borders
const BLUE_50 = [241, 245, 249] as const; // Light blue shading
const BLUE_100 = [219, 234, 254] as const; // Summary bar bg
const BLUE_400 = [96, 165, 250] as const; // Accent divider
const WHITE = [255, 255, 255] as const;
const TEXT_PRIMARY = [15, 23, 42] as const;
const TEXT_SECONDARY = [100, 116, 139] as const;
const RED_500 = [239, 68, 68] as const; // Withdrawals
const GREEN_500 = [16, 185, 129] as const; // Deposits

// ============================================================================
// Generator
// ============================================================================

export function generateBankStatementPDF(data: BankStatementData): GenerateResult {
  const doc = new jsPDF({ orientation: "portrait", unit: "mm", format: "letter" });
  const pageW = doc.internal.pageSize.getWidth();
  const pageH = doc.internal.pageSize.getHeight();
  const margin = 18;
  const contentW = pageW - margin * 2;
  let y = 0;

  // Track bounding boxes
  const boxes: StatementBBox[] = [];
  let currentPage = 0;

  /** Convert mm coords to 0-1000 normalised system */
  function mmToNorm(
    xMm: number,
    yMm: number,
    wMm: number,
    hMm: number,
  ): [number, number, number, number] {
    const xmin = Math.round((xMm / pageW) * 1000);
    const ymin = Math.round((yMm / pageH) * 1000);
    const xmax = Math.round(((xMm + wMm) / pageW) * 1000);
    const ymax = Math.round(((yMm + hMm) / pageH) * 1000);
    // Return [ymin, xmin, ymax, xmax] to match the viewer's convention
    return [ymin, xmin, ymax, xmax];
  }

  function addBox(
    id: string,
    label: string,
    text: string,
    xMm: number,
    yMm: number,
    wMm: number,
    hMm: number,
    fieldType: StatementBBox["fieldType"],
  ) {
    boxes.push({
      id,
      label,
      text,
      bbox: mmToNorm(xMm, yMm, wMm, hMm),
      page: currentPage,
      fieldType,
    });
  }

  function checkPageBreak(neededHeight: number) {
    if (y + neededHeight > pageH - 18) {
      drawFooter();
      doc.addPage();
      currentPage++;
      y = 18;
    }
  }

  function drawFooter() {
    const footerY = pageH - 10;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...SLATE_500);
    doc.text(`Page ${doc.getNumberOfPages()}`, pageW / 2, footerY, { align: "center" });
    doc.text(`${data.bankName} — Confidential`, pageW - margin, footerY, { align: "right" });
  }

  // ================================================================
  // 1. HEADER — Centered account title + period
  // ================================================================

  y = 18;
  const headerStartY = y - 5;

  // Account title: "Mercury Checking xxxxxxxx1231"
  doc.setFont("helvetica", "bold");
  doc.setFontSize(16);
  doc.setTextColor(...SLATE_900);
  const acctDisplay = data.accountNumber
    ? `${data.bankName} ${data.accountType} xxxxxxxx${data.accountNumber}`
    : `${data.bankName} ${data.accountType}`;
  doc.text(acctDisplay, pageW / 2, y, { align: "center" });

  // Period title: "May 2025 Statement"
  y += 7;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...SLATE_700);
  const periodTitle = fmtPeriodTitle(data.periodStart, data.periodEnd);
  doc.text(periodTitle, pageW / 2, y, { align: "center" });

  // Date range: "05/01/2025 - 05/31/2025"
  y += 5;
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  doc.setTextColor(...SLATE_500);
  const dateRange = `${fmtDate(data.periodStart)} - ${fmtDate(data.periodEnd)}`;
  doc.text(dateRange, pageW / 2, y, { align: "center" });

  // Header bounding box (account title + period + date range)
  addBox(
    "header_title",
    "Account Title",
    acctDisplay,
    margin,
    headerStartY,
    contentW,
    y - headerStartY + 3,
    "header",
  );

  // Light blue accent divider
  y += 4;
  doc.setDrawColor(...BLUE_400);
  doc.setLineWidth(0.8);
  doc.line(margin, y, margin + contentW, y);

  // ================================================================
  // 2. ENTITY INFO + ACCOUNT DETAILS (two-column)
  // ================================================================

  y += 8;
  const entityStartY = y - 3;
  const halfW = contentW / 2;

  // Left: entity info
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...TEXT_PRIMARY);
  doc.text(data.entityName, margin, y);

  if (data.entityAddress) {
    y += 4.5;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text(data.entityAddress, margin, y);
  }

  if (data.entityEin) {
    y += 4;
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...TEXT_SECONDARY);
    doc.text(`EIN: ${data.entityEin}`, margin, y);
  }

  // Entity info bbox
  addBox(
    "entity_name",
    "Entity Name",
    data.entityName,
    margin,
    entityStartY,
    halfW - 4,
    y - entityStartY + 3,
    "metadata",
  );

  // Right: account details box
  const boxX = margin + halfW + 10;
  const boxW = halfW - 10;
  const boxY = entityStartY;
  doc.setFillColor(...BLUE_50);
  doc.setDrawColor(...SLATE_200);
  doc.setLineWidth(0.3);
  doc.roundedRect(boxX, boxY - 2, boxW, 18, 2, 2, "FD");

  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...SLATE_500);
  doc.text("Account Type:", boxX + 4, boxY + 5);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...TEXT_PRIMARY);
  doc.text(data.accountType, boxX + 30, boxY + 5);

  doc.setFont("helvetica", "bold");
  doc.setTextColor(...SLATE_500);
  doc.text("Account Number:", boxX + 4, boxY + 12);
  doc.setFont("helvetica", "normal");
  doc.setTextColor(...TEXT_PRIMARY);
  const acctNum = data.accountNumber ? `xxxxxxxx${data.accountNumber}` : "N/A";
  doc.text(acctNum, boxX + 34, boxY + 12);

  // Account details bbox
  addBox(
    "account_details",
    "Account Details",
    `${data.accountType} • ${acctNum}`,
    boxX,
    boxY - 2,
    boxW,
    18,
    "metadata",
  );

  // ================================================================
  // 3. ACCOUNT ACTIVITY SUMMARY BAR
  // ================================================================

  y += 12;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.setTextColor(...SLATE_900);
  doc.text("Account Activity", margin, y);

  y += 5;

  // Blue summary bar
  const barH = 14;
  const barStartY = y;
  doc.setFillColor(...BLUE_100);
  doc.setDrawColor(...BLUE_400);
  doc.setLineWidth(0.3);
  doc.roundedRect(margin, y, contentW, barH, 2, 2, "FD");

  const totalWithdrawals = data.transactions
    .filter((t) => t.amount < 0)
    .reduce((s, t) => s + Math.abs(t.amount), 0);
  const totalDeposits = data.transactions
    .filter((t) => t.amount > 0)
    .reduce((s, t) => s + t.amount, 0);

  const summaryItems = [
    {
      key: "beginning_balance",
      label: "Beginning Balance",
      value: fmtCurrency(data.openingBalance),
    },
    {
      key: "total_withdrawals",
      label: "Total Withdrawals",
      value: `-${fmtCurrency(totalWithdrawals)}`,
    },
    { key: "total_deposits", label: "Total Deposits", value: fmtCurrency(totalDeposits) },
    { key: "ending_balance", label: "Ending Balance", value: fmtCurrency(data.closingBalance) },
  ];

  const colW = contentW / summaryItems.length;
  const textY = y + 5;
  const valY = y + 10.5;

  for (let i = 0; i < summaryItems.length; i++) {
    const item = summaryItems[i];
    const cx = margin + colW * i + colW / 2;

    doc.setFont("helvetica", "normal");
    doc.setFontSize(7);
    doc.setTextColor(...SLATE_500);
    doc.text(item.label, cx, textY, { align: "center" });

    doc.setFont("helvetica", "bold");
    doc.setFontSize(10);
    doc.setTextColor(...SLATE_900);
    doc.text(item.value, cx, valY, { align: "center" });

    // Vertical separator
    if (i < summaryItems.length - 1) {
      doc.setDrawColor(...BLUE_400);
      doc.setLineWidth(0.2);
      doc.line(margin + colW * (i + 1), y + 3, margin + colW * (i + 1), y + barH - 3);
    }

    // Summary item bbox
    addBox(
      `summary_${item.key}`,
      item.label,
      item.value,
      margin + colW * i,
      barStartY,
      colW,
      barH,
      "summary",
    );
  }

  y += barH + 8;

  // ================================================================
  // 4. TRANSACTION TABLE
  // ================================================================

  // Table header
  const colDate = margin + 3;
  const colDesc = margin + 28;
  const colAmount = margin + contentW - 42;
  const colBalance = margin + contentW - 3;
  const headerH = 7;

  doc.setFillColor(...SLATE_700);
  doc.roundedRect(margin, y, contentW, headerH, 1, 1, "F");
  y += 5;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(8);
  doc.setTextColor(...WHITE);

  doc.text("Date (UTC)", colDate, y);
  doc.text("Description", colDesc, y);
  doc.text("Amount", colAmount, y, { align: "right" });
  doc.text("End of Day Balance", colBalance, y, { align: "right" });

  y += 4;

  // Transaction rows
  let rowIdx = 0;
  for (const txn of data.transactions) {
    const hasDetail = !!txn.detail;
    const rowH = hasDetail ? 10 : 6;

    checkPageBreak(rowH + 2);

    const rowStartY = y - 0.5;

    // Zebra stripe
    if (rowIdx % 2 === 0) {
      doc.setFillColor(...BLUE_50);
      doc.rect(margin, y - 0.5, contentW, rowH, "F");
    }

    const rowTextY = y + 3.5;

    // Date
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...TEXT_PRIMARY);
    doc.text(fmtDateShort(txn.date), colDate, rowTextY);

    // Description — bold merchant name
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    doc.setTextColor(...TEXT_PRIMARY);
    let desc = txn.description;
    const maxDescW = colAmount - colDesc - 18;
    while (doc.getTextWidth(desc) > maxDescW && desc.length > 3) {
      desc = `${desc.substring(0, desc.length - 4)}…`;
    }
    doc.text(desc, colDesc, rowTextY);

    // Detail line (lighter, smaller)
    if (txn.detail) {
      doc.setFont("helvetica", "normal");
      doc.setFontSize(7);
      doc.setTextColor(...SLATE_500);
      let detail = txn.detail;
      while (doc.getTextWidth(detail) > maxDescW && detail.length > 3) {
        detail = `${detail.substring(0, detail.length - 4)}…`;
      }
      doc.text(detail, colDesc, rowTextY + 4);
    }

    // Amount — red for withdrawals, green for deposits
    doc.setFont("helvetica", "bold");
    doc.setFontSize(8);
    if (txn.amount < 0) {
      doc.setTextColor(...RED_500);
      doc.text(`-${fmtCurrency(Math.abs(txn.amount))}`, colAmount, rowTextY, { align: "right" });
    } else {
      doc.setTextColor(...GREEN_500);
      doc.text(fmtCurrency(txn.amount), colAmount, rowTextY, { align: "right" });
    }

    // End of day balance
    doc.setFont("helvetica", "normal");
    doc.setFontSize(8);
    doc.setTextColor(...TEXT_PRIMARY);
    doc.text(fmtCurrency(txn.runningBalance), colBalance, rowTextY, { align: "right" });

    // Transaction row bounding box — uses txn.id if available, otherwise rowIdx
    addBox(
      txn.id || `txn_${rowIdx}`,
      txn.description,
      `${fmtDateShort(txn.date)} • ${fmtCurrency(txn.amount)}`,
      margin,
      rowStartY,
      contentW,
      rowH,
      "transaction",
    );

    y += rowH;
    rowIdx++;
  }

  // Bottom border
  doc.setDrawColor(...SLATE_200);
  doc.setLineWidth(0.3);
  doc.line(margin, y, margin + contentW, y);

  // Ending balance footer row
  y += 4;
  const footerRowY = y - 1;
  doc.setFillColor(...BLUE_50);
  doc.roundedRect(margin, footerRowY, contentW, 8, 1, 1, "F");
  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.setTextColor(...SLATE_900);
  doc.text("Ending Balance", margin + 4, y + 4);
  doc.text(fmtCurrency(data.closingBalance), margin + contentW - 4, y + 4, { align: "right" });

  addBox(
    "ending_balance_row",
    "Ending Balance",
    fmtCurrency(data.closingBalance),
    margin,
    footerRowY,
    contentW,
    8,
    "footer",
  );

  // ================================================================
  // 5. FOOTER ON ALL PAGES
  // ================================================================

  const totalPages = doc.getNumberOfPages();
  for (let i = 1; i <= totalPages; i++) {
    doc.setPage(i);
    drawFooter();
  }

  return {
    blob: doc.output("blob"),
    boundingBoxes: boxes,
  };
}
