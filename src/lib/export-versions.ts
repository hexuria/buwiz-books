/**
 * Export Version Constants
 * Tracks the current export schema version and provides metadata utilities.
 */

/** Current export format version. Bump when adding new entities or changing field shapes. */
export const EXPORT_VERSION = 3;

/**
 * All entity types supported by the versioned export format.
 * Order matters: import runs in dependency order (categories before transactions, etc.).
 */
export const EXPORTABLE_ENTITIES = [
  "categories",
  "departments",
  "locations",
  "products",
  "vendors",
  "customers",
  "employees",
  "shareholders",
  "lenders",
  "government",
  "banks",
  "transactions",
  "bills",
  "invoices",
  "numberSequences",
  "orgSettings",
  // v3: the Philippine tax tables (audit P5 — "a full export is not a full
  // backup"). Order matters: runs before lines/year-state.
  "phOrgTaxProfile",
  "phOrgTaxBranches",
  "phTaxYearElections",
  "phTaxRegistrations",
  "phPartyTaxProfiles",
  "phPreviousEmployer2316",
  "phWithholdingPayments",
  "phTaxCertificates",
  "phPayrollRuns",
  "phPayrollLines",
  "phPayrollYearState",
  "phComputedReturns",
] as const;

export type ExportableEntity = (typeof EXPORTABLE_ENTITIES)[number];

/** Human-readable labels for UI display */
export const ENTITY_LABELS: Record<ExportableEntity, string> = {
  categories: "Categories (COA)",
  departments: "Departments",
  locations: "Locations",
  products: "Products & Services",
  vendors: "Vendors",
  customers: "Customers",
  employees: "Employees",
  shareholders: "Shareholders",
  lenders: "Lenders",
  government: "Government",
  banks: "Banks & Cards",
  transactions: "Transactions",
  bills: "Bills (A/P)",
  invoices: "Invoices (A/R)",
  numberSequences: "Number Sequences",
  orgSettings: "Organization Settings",
  phOrgTaxProfile: "PH Tax Profile",
  phOrgTaxBranches: "PH Tax Branches",
  phTaxYearElections: "PH Tax Year Elections",
  phTaxRegistrations: "PH Tax Registrations",
  phPartyTaxProfiles: "PH Party Tax Profiles",
  phPreviousEmployer2316: "PH Previous-Employer 2316",
  phWithholdingPayments: "PH Withholding Payments",
  phTaxCertificates: "PH Tax Certificates",
  phPayrollRuns: "PH Payroll Runs",
  phPayrollLines: "PH Payroll Lines",
  phPayrollYearState: "PH Payroll Year State",
  phComputedReturns: "PH Computed Returns (as-filed)",
};

/** Metadata block included in every versioned export file */
export interface ExportMeta {
  version: number;
  exportedAt: string;
  organizationName: string;
  organizationSlug: string;
  entities: string[];
}

/** Shape of a versioned export file */
export interface VersionedExportFile {
  meta: ExportMeta;
  data: Record<string, unknown>;
}

/**
 * Check whether a parsed JSON object is a legacy (v1) export or a versioned export.
 * Legacy exports have `{ exportedAt, entities }` at the top level with no `meta` block.
 */
export function isLegacyExport(parsed: unknown): boolean {
  if (typeof parsed !== "object" || parsed === null) return false;
  const obj = parsed as Record<string, unknown>;
  return !obj.meta && typeof obj.exportedAt === "string" && typeof obj.entities === "object";
}

/**
 * Get the version number from a parsed export file.
 * Returns 1 for legacy files, or the meta.version for versioned files.
 */
export function getExportVersion(parsed: unknown): number {
  if (isLegacyExport(parsed)) return 1;
  if (typeof parsed === "object" && parsed !== null) {
    const obj = parsed as Record<string, unknown>;
    if (typeof obj.meta === "object" && obj.meta !== null) {
      const meta = obj.meta as Record<string, unknown>;
      if (typeof meta.version === "number") return meta.version;
    }
  }
  return 0; // Unknown format
}
