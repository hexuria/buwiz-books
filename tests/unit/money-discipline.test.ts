import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Money-discipline ratchet.
 *
 * CLAUDE.md: amount columns are decimal(20,8) returned as STRINGS, and
 * arithmetic goes through the exact-money layers (src/lib/money.ts for
 * integer-cent flows, src/lib/tax/money.ts for scale-8 ledger sums). The
 * 2026-08 audit found float arithmetic on money in five of six domains, so
 * this test pins the files that are already clean and grows as the sweep
 * (remediation PR-15) converts the rest.
 *
 * Mechanics follow the repo's wiring-test pattern (tax-reference-wiring,
 * review-rules-wiring): read the source, assert its shape. oxlint has no
 * no-restricted-syntax rule, so a test IS the lint here.
 *
 * THE RATCHET ONLY GROWS. Removing a file from this list to make a change
 * pass is the exact failure mode the audit documented — convert the
 * arithmetic instead. `.toFixed(` is banned alongside parseFloat because
 * every audited defect paired them: parse to float, do float math, render
 * with toFixed at the wrong scale.
 */
const CLEAN_MONEY_FILES = [
  "src/lib/coa/resolve-mapped-account.ts",
  "src/lib/inbox/service.ts",
  "src/lib/journal-amendment.ts",
  "src/lib/manual-bill-payment.ts",
  "src/lib/tax/bill-payment-ewt.ts",
  "src/lib/tax/engine.ts",
  "src/lib/tax/payroll-journal.ts",
];

const BANNED = [
  { pattern: /\bparseFloat\s*\(/, label: "parseFloat(" },
  { pattern: /\bNumber\.parseFloat\s*\(/, label: "Number.parseFloat(" },
  { pattern: /\.toFixed\s*\(/, label: ".toFixed(" },
];

describe("money discipline ratchet", () => {
  for (const file of CLEAN_MONEY_FILES) {
    it(`${file} stays free of float-on-money arithmetic`, () => {
      const source = readFileSync(resolve(process.cwd(), file), "utf8");
      for (const { pattern, label } of BANNED) {
        const match = source.match(pattern);
        expect(
          match,
          `${file} now contains ${label} — route money through src/lib/money.ts (cents) or ` +
            `src/lib/tax/money.ts (scale-8) instead of removing it from the ratchet.`,
        ).toBeNull();
      }
    });
  }

  it("the allowlist itself is sorted and unique, so additions are reviewable diffs", () => {
    const sorted = [...CLEAN_MONEY_FILES].sort();
    expect(CLEAN_MONEY_FILES).toEqual(sorted);
    expect(new Set(CLEAN_MONEY_FILES).size).toBe(CLEAN_MONEY_FILES.length);
  });
});
