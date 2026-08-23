// Ratchet (audit D6): every PH tax/payroll mutation calls assertPhTaxWritable,
// and every PH page body renders inside PhTaxGate. A new mutation or page
// that skips the gate fails here, not in production.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const MUTATION_FILES = [
  "src/routes/api/-payroll-runs.ts",
  "src/routes/api/-filing.ts",
  "src/routes/api/-tax-certificates.ts",
  "src/routes/api/-tax-ewt.ts",
  "src/routes/api/-tax-returns.ts",
  "src/routes/api/-tax-settings.ts",
  "src/routes/api/-tax-parties.ts",
  "src/routes/api/-payroll-variances.ts",
  "src/routes/api/-tax-ocr.ts",
];

const PAGE_FILES = [
  "src/routes/payroll.tsx",
  "src/routes/payroll_.$runId.tsx",
  "src/routes/tax.certificates.tsx",
  "src/routes/tax.compute.tsx",
  "src/routes/tax.deadlines.tsx",
  "src/routes/tax.ewt.tsx",
  "src/routes/tax.parties.tsx",
  "src/routes/tax.settings.tsx",
];

describe("PH country gate wiring", () => {
  for (const file of MUTATION_FILES) {
    it(`${file}: every mutation asserts the module is writable`, () => {
      const source = readFileSync(file, "utf8");
      const mutations = source.match(/withMutationPermissionOrgContext\(/g) ?? [];
      const asserts = source.match(/await assertPhTaxWritable\(db, orgId\);/g) ?? [];
      expect(mutations.length).toBeGreaterThan(0);
      expect(asserts.length).toBe(mutations.length);
    });
  }

  for (const file of PAGE_FILES) {
    it(`${file}: page body renders inside PhTaxGate`, () => {
      const source = readFileSync(file, "utf8");
      expect(source.includes("<PhTaxGate>")).toBe(true);
    });
  }
});
