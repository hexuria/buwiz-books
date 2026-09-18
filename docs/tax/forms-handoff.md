# Buwiz Forms handoff — Philippine tax export

Books is not a tax-filing app. BIR forms, alphalists, EWT remittance, and
payroll filing belong in **Buwiz Forms**. This repo keeps the dormant engines
and tenant tables so an organization can be exported without a schema drop.

`BUWIZ_PH_TAX_FILING` stays **off** unless an operator is rescuing data. Country
= PH does not turn filing back on.

## How to export

1. Settings → **Export / Import** (requires `report:export`).
2. Leave JSON selected.
3. Check the **PH Tax …** rows. They are unchecked by default and are not
   cherry-pickable — each key exports the whole organization slice.
4. Optionally **Select All** (that includes the PH slice plus the core books
   entities). Parties (`employees` / `vendors`) should travel with the PH
   slice: party tax profiles, payroll lines, certificates, and withholding
   payments resolve by **party name**.
5. Download the file. `meta.version` is `4` today (`EXPORT_VERSION` in
   `src/lib/export-versions.ts`). Older files lift through
   `migrateToLatest`; a newer file refuses.

The same keys are accepted by the `exportData` / `validateImport` /
`executeImport` server functions (`src/routes/api/-export-import.ts`).

Import of PH **record** entities is restore-only: the target organization
must not already have rows for that entity. Config entities upsert by
natural key.

## Tenant keys (exported)

Registry: `PH_EXPORT_SPECS` in `src/lib/export-ph.ts`. Order is dependency
order (payroll runs before lines / year-state).

| Export key               | Table                            | Kind   | Resolvable refs                                                                                  | Stripped (cannot survive a restore)                       |
| ------------------------ | -------------------------------- | ------ | ------------------------------------------------------------------------------------------------ | --------------------------------------------------------- |
| `phOrgTaxProfile`        | `org_tax_profiles`               | config | —                                                                                                | —                                                         |
| `phOrgTaxBranches`       | `org_tax_branches`               | config | —                                                                                                | —                                                         |
| `phTaxYearElections`     | `org_tax_year_elections`         | config | —                                                                                                | —                                                         |
| `phTaxRegistrations`     | `org_tax_registrations`          | config | —                                                                                                | —                                                         |
| `phPartyTaxProfiles`     | `party_tax_profiles`             | config | `partyId` → `partyName`                                                                          | —                                                         |
| `phPreviousEmployer2316` | `payroll_previous_employer_2316` | record | `employeePartyId` → `employeeName`                                                               | `documentId`                                              |
| `phWithholdingPayments`  | `tax_withholding_payments`       | record | `payeePartyId` → `payeeName`                                                                     | `journalHeaderId`, `createdBy`                            |
| `phTaxCertificates`      | `tax_certificates`               | record | `payorPartyId` → `payorName`                                                                     | `journalHeaderId`, `documentId`, `createdBy`              |
| `phPayrollRuns`          | `payroll_runs`                   | record | —                                                                                                | `journalHeaderId`, `importedDocumentId`, `acknowledgedBy` |
| `phPayrollLines`         | `payroll_lines`                  | record | `employeePartyId` → `employeeName`; run via `(runTaxableYear, runPayrollPeriod, runPeriodIndex)` | `varianceAcknowledgedBy`                                  |
| `phPayrollYearState`     | `payroll_employee_year_state`    | record | `employeePartyId` → `employeeName`                                                               | —                                                         |
| `phComputedReturns`      | `tax_computed_returns`           | record | —                                                                                                | `createdBy`                                               |

Every row also drops `id`, `organizationId`, `createdAt`, and `updatedAt`
(`PH_ALWAYS_STRIP`). Journals are not in the export system, so journal /
document / user links are a documented limitation, not silent loss.

## What is NOT exported

Global statutory catalogs — Forms seeds these itself. A per-org copy would
drift (see `docs/tax/IMPLEMENTATION-PLAN.md` blocker B11):

- `tax_reference_datasets`
- `tax_withholding_tables`
- `tax_de_minimis_ceilings`
- `filing_deadline_overrides`

Also not in this file: the general ledger, source documents, and the user
rows behind stripped `createdBy` / `acknowledgedBy` columns.

## What Forms must own next

- Ingest this JSON (versioned `meta` + `data.<key>[]`) and own BIR form
  generation, alphalists, `.DAT` encoding, and eBIRForms output.
- Seed the global catalogs above; do not expect them in a tenant export.
- Re-derive any journal / document / user links it needs. Books will not
  ship those ids across databases.
- Import parties first (or alongside) so name → party resolution works.
- Treat `phComputedReturns.payload` as an as-filed snapshot, not a live
  worksheet.

Out of scope for this handoff (and for this repository peel): pushing into
the `buwiz-forms` repo, the AI gateway, and Jev.

## NON-goals (this peel)

- **No schema drop.** `tax_*` / `payroll_*` tables, engines, and routes stay.
- **Do not enable** `BUWIZ_PH_TAX_FILING` by default.
- **No hard-delete** of tenant PH history when country leaves PH. Archiving
  is derived state (`src/lib/tax/module-state.ts`).

A new org-scoped tax/payroll table must be added to `PH_EXPORT_SPECS` (and
the lists it is tested against) or explicitly classified in
`PH_GLOBAL_TABLES_NOT_EXPORTED`. The wiring test fails if it is in neither.
