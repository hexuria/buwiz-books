// Client-safe PH nav gating (no db imports): which sidebar entries belong to
// the PH tax module, and how a given module state transforms them.
// Policy (D6): off → hidden entirely; archived → visible with an "archived"
// badge (read-only pages); active → untouched. An unknown/loading state
// leaves the nav unchanged rather than flashing entries in and out.
import type { PhTaxModuleState } from "./module-state-types";

export const PH_TAX_NAV_HREFS: ReadonlySet<string> = new Set([
  "/payroll",
  "/tax/certificates",
  "/tax/compute",
  "/tax/ewt",
  "/tax/parties",
  "/tax/settings",
  "/tax/deadlines",
]);

interface GateableItem {
  href?: string;
  badge?: number | string;
  children?: GateableItem[];
}

export function applyPhTaxGate<T extends GateableItem>(
  items: T[],
  state: PhTaxModuleState | undefined,
): T[] {
  if (state === undefined || state === "active") return items;
  const transform = (item: T): T | null => {
    if (item.href && PH_TAX_NAV_HREFS.has(item.href)) {
      if (state === "off") return null;
      return { ...item, badge: "archived" };
    }
    if (item.children) {
      const children = item.children.map((child) => transform(child as T)).filter(Boolean) as T[];
      return { ...item, children };
    }
    return item;
  };
  return items.map(transform).filter(Boolean) as T[];
}
