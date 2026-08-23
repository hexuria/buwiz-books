import { describe, it, expect } from "vitest";
import { BASE_ACCOUNTS, listPresets } from "@/lib/coa/presets";
import { flattenPresetAccounts } from "@/lib/coa/preset-types";
import { PH_CHART, PH_RESERVED_BANDS, isInPhReservedBand } from "@/lib/tax/ph-chart";

/**
 * Keeps every non-PH preset out of the number bands reserved for Philippine
 * BIR control accounts (docs/tax/IMPLEMENTATION-PLAN.md §3.1).
 *
 * Why this matters: plan-preset's nextFreeNumber silently renumbers a
 * colliding account at apply time, so a US pack drifting into a reserved band
 * would not fail — it would quietly shift whichever preset applies second.
 * Once the control-account protection trigger lands, that shift becomes
 * unrecoverable without a reviewed migration on live orgs. This test turns the
 * collision into a red build instead.
 */
describe("PH reserved number bands", () => {
  it("declares well-formed, non-overlapping bands", () => {
    for (const [from, to] of PH_RESERVED_BANDS) {
      expect(from).toBeLessThanOrEqual(to);
    }
    const sorted = [...PH_RESERVED_BANDS].sort((a, b) => a[0] - b[0]);
    for (let i = 1; i < sorted.length; i++) {
      expect(
        sorted[i][0],
        `band ${sorted[i].join("-")} overlaps ${sorted[i - 1].join("-")}`,
      ).toBeGreaterThan(sorted[i - 1][1]);
    }
  });

  it("keeps BASE_ACCOUNTS out of every reserved band", () => {
    const offenders = flattenPresetAccounts(BASE_ACCOUNTS)
      .filter((n) => isInPhReservedBand(n.account.accountNumber))
      .map((n) => `${n.account.key} (${n.account.accountNumber})`);
    expect(offenders).toEqual([]);
  });

  it.each(listPresets().map((p) => [p.id, p] as const))(
    "keeps preset %s inside its lane of the reserved bands",
    (_id, preset) => {
      const inBand = flattenPresetAccounts(preset.accounts).filter((n) =>
        isInPhReservedBand(n.account.accountNumber),
      );
      if (preset.id === "philippines_smb") {
        // The PH pack is the one legitimate occupant of the reserved bands —
        // and it must occupy them EXACTLY as PH_CHART freezes them: every
        // chart number present, nothing else inside the bands.
        const presetNumbers = inBand.map((n) => n.account.accountNumber).sort();
        const chartNumbers = PH_CHART.map((entry) => entry.accountNumber).sort();
        expect(presetNumbers).toEqual(chartNumbers);
        return;
      }
      const offenders = inBand.map((n) => `${n.account.key} (${n.account.accountNumber})`);
      expect(offenders).toEqual([]);
    },
  );
});
