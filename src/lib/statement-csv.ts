// ============================================================================
// Deterministic CSV bank-statement parser.
//
// Clean CSV exports need a parser, not a vision model (a cost AND accuracy
// win — AI_NATIVE_ARCHITECTURE §4 "routing"). The statement pipeline's triage
// stage sends text/csv uploads here; PDFs/images continue to OCR.
//
// Column detection is header-name driven with common bank vocabulary;
// amounts support signed values, parens negatives, and debit/credit column
// pairs. Anything ambiguous becomes an issue instead of a guess.
// ============================================================================

export interface CsvStatementLine {
  date: string; // YYYY-MM-DD
  description: string;
  amount: number; // positive = deposit, negative = withdrawal
  runningBalance?: number;
  referenceNumber?: string;
}

export interface CsvStatementParseResult {
  ok: boolean;
  /** Data rows that failed to parse and were skipped (audit P6). */
  droppedRows: number;
  issues: string[];
  transactions: CsvStatementLine[];
  /** Which columns were detected — recorded on the run for auditability. */
  detected: {
    date?: string;
    description?: string;
    amount?: string;
    debit?: string;
    credit?: string;
    balance?: string;
    reference?: string;
  };
}

// ── CSV tokenizer (RFC 4180: quoted fields, escaped quotes, CRLF) ──────────

export function tokenizeCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else {
      field += ch;
    }
  }
  row.push(field);
  if (row.length > 1 || row[0] !== "") rows.push(row);
  return rows;
}

// ── Column detection ────────────────────────────────────────────────────────

const DATE_HEADERS = [
  "date",
  "posted",
  "posting date",
  "transaction date",
  "trans date",
  "value date",
];
const DESC_HEADERS = [
  "description",
  "memo",
  "payee",
  "details",
  "narrative",
  "transaction",
  "name",
];
const AMOUNT_HEADERS = ["amount", "value", "transaction amount"];
const DEBIT_HEADERS = ["debit", "withdrawal", "withdrawals", "money out", "paid out", "outflow"];
const CREDIT_HEADERS = ["credit", "deposit", "deposits", "money in", "paid in", "inflow"];
const BALANCE_HEADERS = ["balance", "running balance", "closing balance"];
const REFERENCE_HEADERS = ["reference", "ref", "check", "check number", "cheque", "confirmation"];

function findColumn(headers: string[], candidates: string[]): number {
  const normalized = headers.map((h) => h.trim().toLowerCase());
  // Exact match wins over substring so "transaction date" doesn't grab "transaction".
  for (const candidate of candidates) {
    const idx = normalized.findIndex((h) => h === candidate);
    if (idx !== -1) return idx;
  }
  for (const candidate of candidates) {
    const idx = normalized.findIndex((h) => h.includes(candidate));
    if (idx !== -1) return idx;
  }
  return -1;
}

// ── Value parsing ───────────────────────────────────────────────────────────

/** Parse common statement date formats to YYYY-MM-DD (US-order for slashes). */
export function parseCsvDate(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;

  const iso = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (iso) {
    return `${iso[1]}-${iso[2].padStart(2, "0")}-${iso[3].padStart(2, "0")}`;
  }

  const slash = /^(\d{1,2})[/.](\d{1,2})[/.](\d{2,4})$/.exec(value);
  if (slash) {
    const [, first, second, yearRaw] = slash;
    const year = yearRaw.length === 2 ? `20${yearRaw}` : yearRaw;
    const month = Number(first);
    const day = Number(second);
    // US order (MM/DD). If the "month" is impossible, the file is DD/MM.
    const [m, d] = month > 12 && day <= 12 ? [day, month] : [month, day];
    if (m < 1 || m > 12 || d < 1 || d > 31) return null;
    return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  }

  return null;
}

/** Parse "$1,234.56", "(45.00)", "-45.00", "1.234,56" is NOT supported. */
export function parseCsvAmount(raw: string): number | null {
  let value = raw.trim();
  if (!value) return null;
  let negative = false;
  if (value.startsWith("(") && value.endsWith(")")) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/[$€£¥,\s]/g, "");
  if (value.startsWith("-")) {
    negative = true;
    value = value.slice(1);
  } else if (value.startsWith("+")) {
    value = value.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

// ── Parser ──────────────────────────────────────────────────────────────────

const MAX_HEADER_SCAN_ROWS = 10;

export function parseStatementCsv(csvText: string): CsvStatementParseResult {
  const issues: string[] = [];
  const rows = tokenizeCsv(csvText);
  if (rows.length === 0) {
    return {
      ok: false,
      droppedRows: 0,
      issues: ["CSV file is empty"],
      transactions: [],
      detected: {},
    };
  }

  // Find the header row: first row (within the scan window) that has a date
  // column AND either an amount column or a debit/credit pair.
  let headerIdx = -1;
  let dateCol = -1;
  let descCol = -1;
  let amountCol = -1;
  let debitCol = -1;
  let creditCol = -1;
  let balanceCol = -1;
  let refCol = -1;

  for (let i = 0; i < Math.min(rows.length, MAX_HEADER_SCAN_ROWS); i++) {
    const headers = rows[i];
    const date = findColumn(headers, DATE_HEADERS);
    const amount = findColumn(headers, AMOUNT_HEADERS);
    const debit = findColumn(headers, DEBIT_HEADERS);
    const credit = findColumn(headers, CREDIT_HEADERS);
    if (date !== -1 && (amount !== -1 || (debit !== -1 && credit !== -1))) {
      headerIdx = i;
      dateCol = date;
      amountCol = amount;
      debitCol = debit;
      creditCol = credit;
      descCol = findColumn(headers, DESC_HEADERS);
      balanceCol = findColumn(headers, BALANCE_HEADERS);
      refCol = findColumn(headers, REFERENCE_HEADERS);
      break;
    }
  }

  if (headerIdx === -1) {
    return {
      ok: false,
      droppedRows: 0,
      issues: [
        "Could not detect statement columns — expected a header row with a date column and an amount (or debit/credit) column",
      ],
      transactions: [],
      detected: {},
    };
  }

  const headers = rows[headerIdx];
  const detected: CsvStatementParseResult["detected"] = {
    date: headers[dateCol],
    description: descCol !== -1 ? headers[descCol] : undefined,
    amount: amountCol !== -1 ? headers[amountCol] : undefined,
    debit: debitCol !== -1 ? headers[debitCol] : undefined,
    credit: creditCol !== -1 ? headers[creditCol] : undefined,
    balance: balanceCol !== -1 ? headers[balanceCol] : undefined,
    reference: refCol !== -1 ? headers[refCol] : undefined,
  };

  const transactions: CsvStatementLine[] = [];
  let droppedRows = 0;
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.every((cell) => cell.trim() === "")) continue;

    const rowNum = i + 1;
    const date = parseCsvDate(row[dateCol] ?? "");
    if (!date) {
      issues.push(`Row ${rowNum}: unparseable date "${row[dateCol] ?? ""}"`);
      droppedRows++;
      continue;
    }

    let amount: number | null = null;
    if (amountCol !== -1) {
      amount = parseCsvAmount(row[amountCol] ?? "");
    } else {
      const debit = parseCsvAmount(row[debitCol] ?? "");
      const credit = parseCsvAmount(row[creditCol] ?? "");
      if (debit !== null && debit !== 0) {
        amount = -Math.abs(debit);
      } else if (credit !== null) {
        amount = Math.abs(credit);
      }
    }
    if (amount === null) {
      issues.push(`Row ${rowNum}: unparseable amount`);
      droppedRows++;
      continue;
    }

    const balance = balanceCol !== -1 ? parseCsvAmount(row[balanceCol] ?? "") : null;
    const reference = refCol !== -1 ? (row[refCol] ?? "").trim() : "";

    transactions.push({
      date,
      description: descCol !== -1 ? (row[descCol] ?? "").trim() : "",
      amount,
      ...(balance !== null ? { runningBalance: balance } : {}),
      ...(reference ? { referenceNumber: reference } : {}),
    });
  }

  if (transactions.length === 0) {
    issues.push("No parseable transaction rows found");
  }

  // A parse that DROPPED a meaningful share of its data rows is a failed
  // parse, not a successful import with footnotes: 40 of 60 rows dropped
  // used to report ok:true, and the reconciliation started from a statement
  // missing two thirds of its activity (audit P6, extending checkpoint C3).
  const totalDataRows = transactions.length + droppedRows;
  const dropRatio = totalDataRows > 0 ? droppedRows / totalDataRows : 0;
  if (droppedRows > 0 && dropRatio > 0.2) {
    issues.push(
      `Parsed ${transactions.length} of ${totalDataRows} data rows — ${droppedRows} dropped. ` +
        `Fix the file (or its column mapping) and re-upload; importing a fifth-missing statement silently breaks the reconciliation.`,
    );
    return { ok: false, droppedRows, issues, transactions, detected };
  }

  return { ok: transactions.length > 0, droppedRows, issues, transactions, detected };
}
