/**
 * Alphalist pre-flight validation.
 *
 * RMC 5-2014 imposes content rules the Validation Module enforces, and a file
 * that violates them is rejected at submission — after the deadline has been
 * relied on. These run BEFORE generation so the bookkeeper fixes data rather
 * than debugging a rejection.
 *
 * TWO TIERS, and the distinction is load-bearing. A FATAL finding blocks
 * generation entirely: the file would be rejected, or worse, accepted with
 * wrong data. A WARNING is generated-but-flagged — something a human should
 * look at that is not itself a violation.
 *
 * The rules that matter most:
 *   - No submission without a valid BIR-issued TIN, and no dummy TINs.
 *   - No lumped entries. "Various Employees", "Various payees" and "Others" are
 *     banned outright, and separately, reporting a sale as "various" on the
 *     SLSP forfeits the EOPT output-VAT credit on that receivable — so a
 *     counterparty TIN is effectively mandatory on B2B documents.
 *   - Banned characters (ñ, *, ?, &). Transliteration is handled by the
 *     encoder, but a name that is ONLY banned characters is a data problem.
 */

export type PreflightSeverity = "fatal" | "warning";

export interface PreflightFinding {
  code: string;
  severity: PreflightSeverity;
  /** Which row, so a 400-employee alphalist is actionable. */
  rowIndex: number;
  subject: string;
  message: string;
}

export interface AlphalistRow {
  tin: string | null;
  branchCode: string | null;
  lastName: string | null;
  firstName: string | null;
  registeredName: string | null;
  /** Any monetary figure the row reports, for the zero-amount check. */
  amount?: string | null;
}

/**
 * Names that mean "we did not identify this person".
 *
 * Matched against the WHOLE normalized name, never as a prefix. "VARIOUS
 * ENTERPRISES INC" is a real company and a prefix rule bans it — the offence is
 * lumping, not the word "various". `LUMPED_COLLECTIVES` covers the
 * "various <collective>" family explicitly rather than by prefix.
 */
const LUMPED_NAMES = new Set([
  "various",
  "others",
  "other",
  "n/a",
  "na",
  "none",
  "unknown",
  "misc",
  "miscellaneous",
  "assorted",
  "sundry",
]);

/** The nouns that turn "various X" into a lumped entry rather than a name. */
const LUMPED_COLLECTIVES = new Set([
  "employees",
  "employee",
  "payees",
  "payee",
  "suppliers",
  "supplier",
  "customers",
  "customer",
  "vendors",
  "vendor",
  "clients",
  "client",
  "individuals",
  "persons",
  "others",
]);

/**
 * Whether a name identifies nobody.
 *
 * Deliberately narrow. A false positive blocks a legitimate payee from a return
 * with a deadline, which is worse than letting a questionable name through to
 * the Validation Module — so this matches whole strings and one explicit
 * two-word pattern, never substrings.
 */
function isLumpedName(normalized: string): boolean {
  if (LUMPED_NAMES.has(normalized)) return true;
  const words = normalized.split(" ");
  return words.length === 2 && words[0] === "various" && LUMPED_COLLECTIVES.has(words[1]);
}

/**
 * TINs that pass a digit check but identify nobody.
 *
 * RMC 5-2014 bans dummy TINs explicitly. These are the placeholders that show
 * up in practice when a bookkeeper needs the field filled.
 */
export const PLACEHOLDER_TINS = new Set([
  "000000000",
  "111111111",
  "123456789",
  "999999999",
  "000000001",
]);

/** True when the TIN passes a digit check but identifies nobody. */
export function isPlaceholderTin(raw: string | null | undefined): boolean {
  if (!raw) return false;
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 9) return false;
  return PLACEHOLDER_TINS.has(digits.slice(0, 9));
}

const BANNED_CHARS = /[ñÑ*?&]/;
/** Global variant. The non-global one replaces only the first match. */
const BANNED_CHARS_ALL = /[ñÑ*?&]/g;

function displayName(row: AlphalistRow): string {
  if (row.registeredName) return row.registeredName;
  return [row.lastName, row.firstName].filter(Boolean).join(", ");
}

export function preflightAlphalist(rows: readonly AlphalistRow[]): PreflightFinding[] {
  const findings: PreflightFinding[] = [];
  const seenTins = new Map<string, number>();

  rows.forEach((row, index) => {
    const subject = displayName(row) || `row ${index + 1}`;
    const add = (code: string, severity: PreflightSeverity, message: string) =>
      findings.push({ code, severity, rowIndex: index, subject, message });

    // ── TIN ────────────────────────────────────────────────────────────────
    if (!row.tin) {
      add("ALPHA-001", "fatal", "no TIN — RMC 5-2014 bans submission without a BIR-issued TIN");
    } else if (!/^\d{9}$/.test(row.tin)) {
      add(
        "ALPHA-002",
        "fatal",
        `TIN "${row.tin}" is not nine digits — a formatted or branch-suffixed TIN shifts every ` +
          `field after it in the .DAT record`,
      );
    } else {
      if (isPlaceholderTin(row.tin)) {
        add("ALPHA-003", "fatal", `TIN "${row.tin}" is a placeholder; dummy TINs are banned`);
      }
      const first = seenTins.get(row.tin);
      if (first !== undefined) {
        // Two rows for one TIN is usually a duplicated import, but it can be
        // legitimate (two ATCs for one payee), so it warns rather than blocks.
        add(
          "ALPHA-004",
          "warning",
          `TIN ${row.tin} also appears on row ${first + 1} — legitimate for two ATCs, otherwise a ` +
            `duplicated import`,
        );
      } else {
        seenTins.set(row.tin, index);
      }
    }

    // ── Branch code ────────────────────────────────────────────────────────
    if (row.branchCode && !/^\d{4,5}$/.test(row.branchCode)) {
      add("ALPHA-005", "fatal", `branch code "${row.branchCode}" must be four or five digits`);
    }

    // ── Name ───────────────────────────────────────────────────────────────
    const name = displayName(row);
    if (!name) {
      add("ALPHA-006", "fatal", "no name — an alphalist row must identify its subject");
    } else {
      const normalized = name.trim().toLowerCase().replace(/\s+/g, " ");
      if (isLumpedName(normalized)) {
        add(
          "ALPHA-007",
          "fatal",
          `"${name}" is a lumped entry — RMC 5-2014 bans these, and on the SLSP reporting a ` +
            `counterparty as "various" forfeits the EOPT output-VAT credit on that receivable`,
        );
      }
      // The encoder transliterates, but a name that is ONLY banned characters
      // transliterates to nothing.
      if (BANNED_CHARS.test(name) && name.replace(BANNED_CHARS_ALL, "").trim() === "") {
        add("ALPHA-008", "fatal", `"${name}" is entirely banned characters`);
      }
    }

    // ── Amount ─────────────────────────────────────────────────────────────
    if (row.amount != null && Number(row.amount) < 0) {
      add(
        "ALPHA-009",
        "fatal",
        `negative amount ${row.amount} — an alphalist reports gross figures`,
      );
    }
  });

  return findings;
}

export interface PreflightResult {
  findings: PreflightFinding[];
  fatal: PreflightFinding[];
  warnings: PreflightFinding[];
  /** False when any fatal finding stands. Generation must not proceed. */
  canGenerate: boolean;
}

export function summarizePreflight(findings: PreflightFinding[]): PreflightResult {
  const fatal = findings.filter((f) => f.severity === "fatal");
  const warnings = findings.filter((f) => f.severity === "warning");
  return { findings, fatal, warnings, canGenerate: fatal.length === 0 };
}
