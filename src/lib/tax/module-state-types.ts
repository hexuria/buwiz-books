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
  /**
   * Product flag (BUWIZ_PH_TAX_FILING). Independent of `state`: country = PH
   * still derives `active`, but Books hides filing UX and refuses writes
   * unless this is true.
   */
  filingEnabled: boolean;
  country: string | null;
  records: PhTaxRecordCounts;
  totalRecords: number;
}
