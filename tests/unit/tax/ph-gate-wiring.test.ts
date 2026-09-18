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

  it("assertPhTaxWritable refuses writes when the Books product flag is off", () => {
    const source = readFileSync("src/lib/tax/module-state.ts", "utf8");
    expect(source).toContain("isPhTaxFilingEnabled()");
    expect(source).toContain("PhTaxFilingUnavailableError");
    expect(source).toContain("throw new PhTaxFilingUnavailableError()");
  });

  it("PhTaxGate tells operators filing lives in Buwiz Forms", () => {
    const source = readFileSync("src/components/PhTaxGate.tsx", "utf8");
    expect(source).toContain("BIR tax filing is not part of Books");
    expect(source).toContain("Buwiz Forms");
  });

  it("bill payments reject EWT withheld while filing is off", () => {
    const bills = readFileSync("src/routes/api/-bills.ts", "utf8");
    expect(bills).toContain("PhTaxFilingUnavailableError");
    expect(bills).toContain("isPhTaxFilingEnabled()");
    const poster = readFileSync("src/lib/manual-bill-payment.ts", "utf8");
    expect(poster).toContain("PhTaxFilingUnavailableError");
  });
});
