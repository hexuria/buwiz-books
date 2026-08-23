// The whole D6 gate policy in one matrix: one active jurisdiction per org,
// archived means records-without-PH-country, and nothing else flips state.
import { describe, expect, it } from "vitest";
import { derivePhTaxModuleState } from "../../../src/lib/tax/module-state";
import { applyPhTaxGate, PH_TAX_NAV_HREFS } from "../../../src/lib/tax/nav-gate";

describe("derivePhTaxModuleState", () => {
  it("PH country is active regardless of records", () => {
    expect(derivePhTaxModuleState({ country: "PH", totalRecords: 0 })).toBe("active");
    expect(derivePhTaxModuleState({ country: "PH", totalRecords: 500 })).toBe("active");
  });

  it("non-PH with records is archived — never deleted, never hidden", () => {
    expect(derivePhTaxModuleState({ country: "US", totalRecords: 1 })).toBe("archived");
    expect(derivePhTaxModuleState({ country: null, totalRecords: 3 })).toBe("archived");
  });

  it("non-PH without records is off", () => {
    expect(derivePhTaxModuleState({ country: "US", totalRecords: 0 })).toBe("off");
    expect(derivePhTaxModuleState({ country: null, totalRecords: 0 })).toBe("off");
  });

  it("only exact uppercase PH activates (ISO codes are normalized at the write)", () => {
    expect(derivePhTaxModuleState({ country: "ph", totalRecords: 0 })).toBe("off");
  });
});

describe("applyPhTaxGate", () => {
  const nav = [
    { label: "Inbox", href: "/inbox" },
    {
      label: "Accounting",
      children: [
        { label: "Payroll", href: "/payroll" },
        { label: "Tax settings", href: "/tax/settings" },
        { label: "Reconciliations", href: "/reconciliations" },
      ],
    },
  ];

  it("active and loading leave the nav untouched", () => {
    expect(applyPhTaxGate(nav, "active")).toEqual(nav);
    expect(applyPhTaxGate(nav, undefined)).toEqual(nav);
  });

  it("off removes every PH entry and nothing else", () => {
    const gated = applyPhTaxGate(nav, "off");
    const accounting = gated.find((i) => i.label === "Accounting")!;
    expect(accounting.children!.map((c) => c.label)).toEqual(["Reconciliations"]);
    expect(gated.find((i) => i.label === "Inbox")).toBeDefined();
  });

  it("archived badges every PH entry and keeps it navigable", () => {
    const gated = applyPhTaxGate(nav, "archived");
    const accounting = gated.find((i) => i.label === "Accounting")!;
    const payroll = accounting.children!.find((c) => c.label === "Payroll")!;
    const recon = accounting.children!.find((c) => c.label === "Reconciliations")!;
    expect((payroll as { badge?: string }).badge).toBe("archived");
    expect((recon as { badge?: string }).badge).toBeUndefined();
  });

  it("the gated href set covers exactly the sidebar's PH surface", () => {
    expect([...PH_TAX_NAV_HREFS].sort()).toEqual([
      "/payroll",
      "/tax/certificates",
      "/tax/compute",
      "/tax/deadlines",
      "/tax/ewt",
      "/tax/parties",
      "/tax/settings",
    ]);
  });
});
