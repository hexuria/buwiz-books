/**
 * Payroll register import.
 *
 * The primary intake path for the January slice: the client keeps running
 * payroll wherever they run it, and buwiz-books verifies the result. So the
 * import must be forgiving about SHAPE and unforgiving about MEANING.
 *
 * ── COLUMN MAPPING IS EXPLICIT, NEVER GUESSED ────────────────────────────────
 * Every payroll vendor names its columns differently, and the same word means
 * different things: one vendor's "Gross Pay" includes non-taxable allowances,
 * another's does not. Silently matching a header to a field by fuzzy name is
 * how a de minimis benefit lands in taxable regular compensation and quietly
 * raises someone's tax.
 *
 * So a mapping is DECLARED. `BUWIZ_TEMPLATE` is the canonical shape we publish;
 * a vendor register is imported by supplying an explicit column map. Anything
 * unmapped is reported, never assumed.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { toPesoString, toScaled, type ScaledMoney } from "./money";

/** The fields a register row can supply. Mirrors the payroll_lines columns. */
export const IMPORTABLE_FIELDS = [
  "employeeTin",
  "employeeLastName",
  "employeeFirstName",
  "employeeMiddleName",
  "basicSalary",
  "representationAllowance",
  "transportationAllowance",
  "costOfLivingAllowance",
  "fixedHousingAllowance",
  "otherTaxableRegular",
  "commission",
  "profitSharing",
  "directorsFees",
  "overtimePay",
  "hazardPay",
  "otherTaxableSupplementary",
  "basicSalaryMwe",
  "holidayPayMwe",
  "overtimePayMwe",
  "nightShiftDifferentialMwe",
  "hazardPayMwe",
  "thirteenthMonthAndOtherBenefits",
  "deMinimisBenefits",
  "nonTaxableRetirementSeparation",
  "otherExempt",
  "sssEmployeeShare",
  "philHealthEmployeeShare",
  "pagIbigEmployeeShare",
  "unionDues",
  "reportedTaxWithheld",
] as const;

export type ImportableField = (typeof IMPORTABLE_FIELDS)[number];

/** Fields without which a row cannot be verified at all. */
const REQUIRED_FIELDS: ImportableField[] = ["employeeTin", "basicSalary"];

/**
 * Fields that must parse as money when present.
 *
 * Everything except the four identity fields, which are the only non-monetary
 * ones and are all prefixed `employee`.
 */
const MONEY_FIELDS = new Set<ImportableField>(
  IMPORTABLE_FIELDS.filter((f) => !f.startsWith("employee")),
);

/**
 * The canonical template we publish.
 *
 * Shipping a template the client fills in is the primary path precisely because
 * it removes the mapping problem: the header IS the field name.
 */
export const BUWIZ_TEMPLATE: Readonly<Record<string, ImportableField>> = Object.fromEntries(
  IMPORTABLE_FIELDS.map((f) => [f, f]),
);

export interface ImportIssue {
  rowIndex: number;
  column: string | null;
  severity: "fatal" | "warning";
  message: string;
}

export interface ImportedRow {
  rowIndex: number;
  values: Partial<Record<ImportableField, string>>;
}

export interface ImportResult {
  rows: ImportedRow[];
  issues: ImportIssue[];
  /** Header columns the map did not cover. Reported, never guessed at. */
  unmappedColumns: string[];
  /** Mapped fields no header supplied. */
  missingFields: ImportableField[];
  canProceed: boolean;
}

/**
 * Normalize a money cell.
 *
 * Registers arrive with thousands separators, currency symbols, parenthesised
 * negatives and blank-as-zero. Returns null when the cell is genuinely empty —
 * which is different from zero, because an absent contribution column must not
 * read as "contributed nothing".
 */
export function parseMoneyCell(raw: string): { value: string | null; error: string | null } {
  const trimmed = raw.trim();
  if (trimmed === "" || trimmed === "-") return { value: null, error: null };

  // (1,234.56) is accounting notation for a negative.
  const negative = /^\(.*\)$/.test(trimmed);
  const cleaned = trimmed
    .replace(/^\(|\)$/g, "")
    .replace(/[₱P]/gi, "")
    .replace(/,/g, "")
    .trim();

  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) {
    return { value: null, error: `"${raw}" is not a monetary amount` };
  }

  const signed = negative ? `-${cleaned}` : cleaned;
  return { value: toPesoString(toScaled(signed) as ScaledMoney), error: null };
}

/** Nine digits, however the register formatted it. */
export function normalizeTin(raw: string): { value: string | null; error: string | null } {
  const digits = raw.replace(/\D/g, "");
  if (digits.length === 0) return { value: null, error: null };
  // A register often carries TIN plus branch code; the first nine digits are
  // the TIN proper and the branch belongs on the profile, not here.
  if (digits.length === 12 || digits.length === 13 || digits.length === 14) {
    return { value: digits.slice(0, 9), error: null };
  }
  if (digits.length !== 9) {
    return { value: null, error: `"${raw}" is not a nine-digit TIN` };
  }
  return { value: digits, error: null };
}

export interface ImportInput {
  /** Header row, in order. */
  headers: readonly string[];
  /** Data rows, aligned to `headers`. */
  rows: ReadonlyArray<readonly string[]>;
  /** Header text → field. Declared explicitly; nothing is inferred. */
  columnMap: Readonly<Record<string, ImportableField>>;
}

export function importRegister(input: ImportInput): ImportResult {
  const issues: ImportIssue[] = [];
  const unmappedColumns: string[] = [];

  // Which header index feeds which field.
  const fieldByIndex = new Map<number, ImportableField>();
  input.headers.forEach((header, index) => {
    const field = input.columnMap[header] ?? input.columnMap[header.trim()];
    if (field) fieldByIndex.set(index, field);
    else if (header.trim() !== "") unmappedColumns.push(header);
  });

  const mappedFields = new Set(fieldByIndex.values());
  const missingFields = REQUIRED_FIELDS.filter((f) => !mappedFields.has(f));

  const rows: ImportedRow[] = input.rows.map((cells, rowIndex) => {
    const values: Partial<Record<ImportableField, string>> = {};

    for (const [index, field] of fieldByIndex) {
      const raw = cells[index] ?? "";

      if (field === "employeeTin") {
        const { value, error } = normalizeTin(raw);
        if (error) {
          issues.push({
            rowIndex,
            column: input.headers[index],
            severity: "fatal",
            message: error,
          });
        } else if (value) {
          values[field] = value;
        }
        continue;
      }

      if (MONEY_FIELDS.has(field)) {
        const { value, error } = parseMoneyCell(raw);
        if (error) {
          issues.push({
            rowIndex,
            column: input.headers[index],
            severity: "fatal",
            message: error,
          });
        } else if (value !== null) {
          // A negative is almost always a sign convention the register uses for
          // deductions. Flagged rather than silently flipped, because guessing
          // wrong changes someone's taxable base.
          if (Number(value) < 0) {
            issues.push({
              rowIndex,
              column: input.headers[index],
              severity: "warning",
              message:
                `${value} is negative — if the register writes deductions as negatives, the ` +
                `column map should point at the deduction field rather than have the sign flipped here`,
            });
          }
          values[field] = value;
        }
        continue;
      }

      if (raw.trim() !== "") values[field] = raw.trim();
    }

    for (const required of REQUIRED_FIELDS) {
      if (mappedFields.has(required) && values[required] === undefined) {
        issues.push({
          rowIndex,
          column: null,
          severity: "fatal",
          message: `row is missing ${required}, without which it cannot be verified`,
        });
      }
    }

    return { rowIndex, values };
  });

  if (missingFields.length > 0) {
    issues.push({
      rowIndex: -1,
      column: null,
      severity: "fatal",
      message: `the column map does not supply: ${missingFields.join(", ")}`,
    });
  }

  return {
    rows,
    issues,
    unmappedColumns,
    missingFields,
    canProceed: !issues.some((i) => i.severity === "fatal"),
  };
}
