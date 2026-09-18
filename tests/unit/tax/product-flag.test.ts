import { afterEach, describe, expect, it } from "vitest";
import {
  isPhTaxFilingEnabled,
  overridePhTaxFilingEnabledForTests,
  PH_TAX_FILING_ENV,
  PH_TAX_FILING_PRESET_ID,
} from "../../../src/lib/tax/product-flag";
import { effectivePhTaxUiState } from "../../../src/lib/tax/nav-gate";

describe("PH tax filing product flag", () => {
  afterEach(() => {
    overridePhTaxFilingEnabledForTests(undefined);
  });

  it("defaults off — Books is not a tax-filing app", () => {
    expect(isPhTaxFilingEnabled({})).toBe(false);
    expect(isPhTaxFilingEnabled({ [PH_TAX_FILING_ENV]: undefined })).toBe(false);
    expect(isPhTaxFilingEnabled({ [PH_TAX_FILING_ENV]: "" })).toBe(false);
    expect(isPhTaxFilingEnabled({ [PH_TAX_FILING_ENV]: "0" })).toBe(false);
    expect(isPhTaxFilingEnabled({ [PH_TAX_FILING_ENV]: "false" })).toBe(false);
  });

  it("turns on only for explicit 1/true", () => {
    expect(isPhTaxFilingEnabled({ [PH_TAX_FILING_ENV]: "1" })).toBe(true);
    expect(isPhTaxFilingEnabled({ [PH_TAX_FILING_ENV]: "true" })).toBe(true);
    expect(isPhTaxFilingEnabled({ [PH_TAX_FILING_ENV]: "TRUE" })).toBe(true);
  });

  it("names the BIR CoA preset that the picker hides when filing is off", () => {
    expect(PH_TAX_FILING_PRESET_ID).toBe("philippines_smb");
  });
});

describe("effectivePhTaxUiState", () => {
  it("hides filing while loading or when the product flag is off", () => {
    expect(effectivePhTaxUiState(undefined)).toBe("off");
    expect(effectivePhTaxUiState({ state: "active", filingEnabled: false })).toBe("off");
    expect(effectivePhTaxUiState({ state: "archived", filingEnabled: false })).toBe("off");
  });

  it("passes through country-derived state only when the flag is on", () => {
    expect(effectivePhTaxUiState({ state: "active", filingEnabled: true })).toBe("active");
    expect(effectivePhTaxUiState({ state: "archived", filingEnabled: true })).toBe("archived");
    expect(effectivePhTaxUiState({ state: "off", filingEnabled: true })).toBe("off");
  });
});
