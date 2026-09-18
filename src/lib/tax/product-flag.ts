// ============================================================================
// Buwiz Books product flag: Philippine BIR / tax filing.
//
// Books is an AI-native accounting product. BIR forms, alphalists, EWT
// remittance, 1601-C / 2307 / 2316 filing packs, and payroll-as-tax-filing
// belong in Buwiz Forms — not here. The engines, drizzle tables, and export
// specs stay in this repo (dormant) so a later migration can move tenant data
// without a schema drop.
//
// Default: OFF. Set BUWIZ_PH_TAX_FILING=1 to temporarily restore the dormant
// module (extraction / data-rescue only). Country = "PH" no longer enables
// filing on its own.
//
// Deferred on purpose (do not do in this peel):
//   - dropping tax_* / payroll_* tables and numbered migrations
//   - moving src/lib/tax into a Forms package
//   - OpenAI-compatible gateway defaults (separate PR)
// ============================================================================

export const PH_TAX_FILING_ENV = "BUWIZ_PH_TAX_FILING";

/** CoA preset that ships BIR control accounts. Hidden from the picker when filing is off. */
export const PH_TAX_FILING_PRESET_ID = "philippines_smb";

let testOverride: boolean | undefined;

function envFlagEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  const raw = (env[PH_TAX_FILING_ENV] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true";
}

/** True only when an operator has explicitly restored the dormant PH filing module. */
export function isPhTaxFilingEnabled(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): boolean {
  if (testOverride !== undefined) return testOverride;
  return envFlagEnabled(env);
}

/** Test-only. Pass `undefined` to restore env / default-off. */
export function overridePhTaxFilingEnabledForTests(value: boolean | undefined): void {
  testOverride = value;
}
