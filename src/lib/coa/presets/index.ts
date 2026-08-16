/**
 * The preset catalog.
 *
 * Adding a pack means adding it here and to `CoaPresetId`; the invariant test
 * suite then covers it automatically.
 */
import type { CoaPreset, CoaPresetId } from "../preset-types";
import { FREELANCER } from "./freelancer";
import { GENERAL_SMALL_BUSINESS } from "./general-small-business";
import { RETAIL_ECOMMERCE } from "./retail-ecommerce";
import { SAAS_STARTUP } from "./saas-startup";

export const COA_PRESETS: Record<CoaPresetId, CoaPreset> = {
  general_small_business: GENERAL_SMALL_BUSINESS,
  saas_startup: SAAS_STARTUP,
  freelancer: FREELANCER,
  retail_ecommerce: RETAIL_ECOMMERCE,
};

export const DEFAULT_PRESET_ID: CoaPresetId = "general_small_business";

export function listPresets(): CoaPreset[] {
  return Object.values(COA_PRESETS);
}

export function getPreset(id: string): CoaPreset | null {
  return COA_PRESETS[id as CoaPresetId] ?? null;
}

/** The recommended pack for an onboarding `industry` value, always falling back to the baseline. */
export function presetForIndustry(industry: string | null | undefined): CoaPreset {
  if (industry) {
    const match = listPresets().find((preset) => preset.industries.includes(industry));
    if (match) return match;
  }
  return COA_PRESETS[DEFAULT_PRESET_ID];
}

export { BASE_ACCOUNTS } from "./base";
export { BASE_MAPPINGS } from "./base-mappings";
