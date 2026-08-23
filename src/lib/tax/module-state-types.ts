// Shared client/server types for the PH tax module gate. Kept free of db
// imports so client components can use them without dragging server code
// into the bundle.
export type PhTaxModuleState = "active" | "archived" | "off";

export interface PhTaxRecordCounts {
  payrollRuns: number;
  taxCertificates: number;
  computedReturns: number;
  withholdingRemittances: number;
  taxProfiles: number;
}

export interface PhTaxModuleStatus {
  state: PhTaxModuleState;
  country: string | null;
  records: PhTaxRecordCounts;
  totalRecords: number;
}
