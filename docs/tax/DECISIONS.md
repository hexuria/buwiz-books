# BIR Tax Subsystem — Decisions Register

**Date:** 2026-08-16
**Status:** Settled. These are decided, not open. Reopening one requires a documented reason.
**Basis:** 12-agent verification pass — 5 primary-source research tracks, 4 codebase audits, 3 independent decision panels (compliance-risk / product-value / engineering-cost framings).
**Supersedes:** the "Open questions" and "Verify before building" sections of [2026-08-16-bir-withholding-coa-mapping-and-ebirforms-plan.md](2026-08-16-bir-withholding-coa-mapping-and-ebirforms-plan.md).

> **⚠️ Part D (Sequencing) is superseded by [IMPLEMENTATION-PLAN.md](IMPLEMENTATION-PLAN.md).**
> A subsequent design + adversarial review pass (7 agents, 15 blockers) established that payroll precedes EWT
> **unconditionally** — the client-mix tiebreaker in Part D was settled on the wrong variable — and that the
> January slice is ledger-independent, which takes Stage 0 off the critical path. Parts A–C below stand, amended
> by §4 of the implementation plan. The PH chart of accounts is **frozen** in §3.1 of that document; do not take
> account numbers from Part B §5.4 of the prior report.

---

## Part A — Corrections to the prior report

The prior report was wrong or incomplete on the following. Each is now verified.

### A1. The proposed architecture was wrong on its central claim

The prior report said adding `mappingType: "tax"` to the existing `category_mappings` registry inherits type enforcement, per-org overrides, completeness checking and the unmapped indicator "for free", and is "a one-member addition — not a parallel system."

**That is substantially false.** `allMappingKeys()` (`src/lib/coa/mapping-registry.ts`) is **global, not per-preset**. Adding a `"tax"` type immediately obliges _all four shipped presets_ to satisfy every tax row:

- `src/lib/coa/validate-preset.ts:171-186` fails validation for `general_small_business`, `saas_startup`, `freelancer` and `retail_ecommerce`.
- `src/lib/coa/execute-plan.ts:274` (`assertMappingCompleteness`) throws and **rolls back every preset apply for every org**.
- `src/lib/coa/plan-preset.ts:408-431` gap-filling would **silently synthesize BIR-named accounts into US orgs**.
- The unmapped indicator is not free: `src/routes/organization.$orgId.mappings.tsx:46,55` hard-codes the tab union.
- `isMappingTargetCompatible` is **never applied to human-set mappings at all** — `src/routes/api/-category-mappings.ts:78-120` upserts without calling it.

**DECISION: reject `mappingType: "tax"`.** Tax codes resolve to control accounts through `tax_codes.control_account_id` as a **direct FK**, read by a tax-specific resolver that **fails loud with no subtype-fallback tier**. See D-N2.

### A2. The Cumulative Average Method is mandatory and was omitted entirely

RR 11-2018 §2.79(B)(5)(a) **mandates** the Cumulative Average Method when any of three triggers fires:

1. Regular compensation is below the compensation level **but** supplementary compensation is paid during the year; **or**
2. Supplementary compensation is **equal to or more than** regular compensation; **or**
3. The employee was newly hired with a **previous employer in the same calendar year**.

Once triggered it is **sticky for the remainder of the calendar year**.

**Golden vector F in the prior report (Monthly, Regular ₱20,833, Supplementary ₱500,000 → ₱75,000) is WRONG.** That scenario is trigger (2) and must be computed under the cumulative average method. Vectors A, B, C and E remain valid; none trips a trigger.

The cumulative method brackets on the cumulative **average of regular + supplementary** — so it is _not_ regular-only. A single shared bracketing function is the wrong abstraction: build **two named methods behind one dispatcher**.

Regression suite anchors on **RR 11-2018 Illustrations 6–15** (Illustrations 10, 11, 12 are BIR's own worked examples of each trigger), not on calculator parity. Note Illustration 9 contains an internal contradiction in the published RR — narrative says ₱43,659.89, its own tabulation computes ₱41,833.23. The tabulation is arithmetically correct. Document this in the test.

### A3. MWE treatment is settled law, not an open question

RR 11-2018 §2.78.1(B)(13) **expressly provides** that an MWE's SMW, holiday pay, overtime pay, night shift differential and qualifying hazard pay remain exempt, and that only the additional compensation is subject to withholding. The BIR calculator's tooltip contradicts the regulation the calculator purports to implement.

Implement the regulation. **Do not make it configurable.**

### A4. Rules that changed after the prior report's sources

| Item                                  | Prior report                                  | Verified current                                                                                                                                                                                                                                                                                    |
| ------------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Credit card withholding (WI156/WC156) | 1% of one-half of gross                       | **RR 5-2025: ½% of full gross.** Same tax, different reported income-payment base — changes the QAP and 2307 figures                                                                                                                                                                                |
| TWA rates                             | 1% goods / 2% services                        | **RR 24-2025 adds ½%** for TWA payments to manufacturers and direct importers of (a) motor vehicles CBU/SKD + parts, (b) medicines/pharmaceuticals, (c) solid/liquid fuels, intended for wholesale — ATCs `WI840/WC840`, `WI850/WC850`, `WI860/WC860`. These are the six new codes from RMC 36-2026 |
| Debt instruments (WI710/WC710)        | "15% or 20%, unresolved"                      | **Creditable, not final.** Regulation says 20%, BIR's own form says 15%, eBIRForms enforces 15%. Unreconciled in law — see U2                                                                                                                                                                       |
| MERALCO codes                         | "25%/32% or 15%/20%"                          | WI650/WC650 = 15%, WI651/WC651 = 15%, WI660/WC660 = 10%, WI661/WC661 = 15%, WI662/WC662 = 10%, WI663/WC663 = 15%                                                                                                                                                                                    |
| ₱3M VAT threshold indexation          | open                                          | **Not indexed.** ₱3,000,000 current. Verified by enumerating every 2025 RR (1–29) and 2026 RR (1–4). The parallel ₱500 non-VAT invoice threshold indexes on a 3-year cycle from 22 Jan 2024 → **first adjustment due 22 January 2027**, inside this product's life                                  |
| 1601-C December deadline              | "verify"                                      | Manual/eBIRForms **15 January**; eFPS e-FILING 11 Jan (Grp E) → 15 Jan (Grp A); **eFPS e-PAYMENT 20 January, all groups**                                                                                                                                                                           |
| §116 percentage tax base              | gross receipts                                | **Accrual since RR 3-2024** — gross sales billed, not collected. Computing 2551Q from collections is wrong for every post-April-2024 period                                                                                                                                                         |
| 8% election base                      | "gross + non-operating in excess of ₱250,000" | The ₱250,000 reduction applies **only to purely self-employed individuals**. A mixed-income earner pays 8% on the full base with no allowance (RR 8-2018, RMO 23-2018)                                                                                                                              |

### A5. Rules the prior report missed entirely

**RR 4-2024 §2.57.4 — when the withholding obligation arises.** The duty now arises at `MIN(accrual/booking date in the payor's books, seller's invoice issuance date)` — **not the payment date**. A bill entered in Q1 and paid in Q2 belongs to **Q1's** 1601-EQ, QAP and 2307. This single rule determines which posting site the tax layer attaches to. RR 4-2024 also repealed RR 2-98 §2.58.5 (deductibility conditioned on withholding) while keeping the duty to withhold.

**Zero-remittance months still require filing.** RR 11-2018 §5: "Withholding agents with zero remittance are still required to use and file the same form." The period-close screen must generate the obligation even when the computed tax is nil.

**EOPT uncollected-receivable regime.** RR 3-2024 §4.110-9 + RMC 65-2024 create four new 2550Q lines (items 35, 36, 55, 58) and impose a **new mandatory invoice field: the agreed credit term must be printed on the invoice** with VAT shown separately, or the client **permanently forfeits** the output VAT credit on that receivable. Also creates a buyer-side duty to reverse input VAT when a supplier stamps an invoice "Claimed Output VAT Credit."

**Input VAT allocation is mandatory, not deferrable.** 2550Q item 53 with a BIR-prescribed formula printed on the form (Part V Schedule 2). Any VAT-registered client with a single exempt sale in a quarter must compute it. Requires a **three-state per-line attribution tag** (directly-vatable / directly-exempt / not-directly-attributable) — only the third bucket goes through the sales-ratio allocation. Must be in the schema from the start.

**RR 7-2024 §6(B)(21) invoice-face requirements.** System-generated invoices from a CAS/CBA must print the **ACCN/PTU number, the approved series range and the date issued** on every invoice, plus "REPRINT" on any reissue. A single global invoice number is non-compliant for a client using more than one invoice type — serials are **per invoice type**.

**RR 7-2024 §3(D)(2).** A VAT-registered seller whose invoice for an exempt sale omits the "VAT-Exempt Sale" legend or the component breakdown **owes VAT on that sale as if the exemption did not apply.** Same-day, per-document, irreversible at the moment of issue.

**RR 11-2025 as extended by RR 26-2025 — the e-invoicing mandate is software-triggered.** "Taxpayers using a CAS, CBA with accounting records, or other invoicing software" are mandatory electronic-invoicing filers by **31 December 2026**, with only Micro taxpayers (<₱3M) exempt. **Registering buwiz-books as a client's CAS is itself the trigger.** BIR has not yet published the transmission spec. This inverts the prior report's dismissal of CREATE MORE as low-priority.

**Taxpayer classification now drives penalties.** Under EOPT, Micro and Small get 10% surcharge instead of 25%, 6% interest instead of 12%, and 50% of the normal compromise penalty. `taxpayer_classification` is not just reporting metadata.

**RA 11976 §12 made compensation withholding statutorily quarterly.** NIRC §81 now reads "within twenty-five (25) days from the close of each calendar quarter," in force since 22 January 2024. BIR has not implemented it — no 1601-CQ exists and the 2025 Tax Calendar still runs 1601-C monthly. Keep **return period and remittance period as separate concepts** so the day a 1601-CQ appears it is a data change, not a rewrite.

**Alphalist .DAT uses a 4-digit branch code**, while eBIRForms v7.9.6.0 moved the TIN branch code to 5 digits. BIR has not published an updated alphalist structure. Store 5, emit 4, log the truncation, monitor as a live compliance risk.

**QAP detail records carry `RETRN_PERIOD` as MM/YYYY — a month.** A quarter's QAP is three monthly files. The data model must preserve the month of each withholding event; a quarter-level aggregate cannot produce a compliant QAP.

**The .DAT spec is RMC 25-2024 Annexes A and B**, plus the BIR Tax Advisory of 31 March 2025. It is _not_ on the Downloadables page. Submission has **three channels** (eFPS attachment / eSubmission / RDO email) depending on enrollment status — model as per-org configuration, not a constant.

**RMC 5-2014 content bans.** Special characters (`ñ`, `*`, `?`, `&`) are banned from alphalist data; submission without valid BIR-issued TINs is banned; lumping ("Various Employees", "Various payees", "Others") is banned. `ñ` is common in Filipino names, so the Ñ→N transliteration must be **explicit and logged**. Separately, reporting a sale as "various" on SLSP **forfeits the EOPT output-VAT credit** on that receivable — counterparty TIN is effectively mandatory on B2B documents.

**Amendments must be complete re-files, not deltas** (RMC 5-2014). The product must reproduce any prior period's full alphalist on demand.

### A6. Reference-data corrections

**De minimis (RR 29-2025) needs an eligibility/form dimension, not just amounts.** RR 4-2025 changed the permitted _form_ of employee achievement awards (adding cash and gift certificates) while leaving the amount at ₱10,000 — an amount-only effective-dated table cannot represent it. Two further gaps: government VL+SL monetization has **no ceiling** and must be representable as "fully exempt"; and item (j) is **30% of the regional basic minimum wage**, making the de minimis engine depend on the DOLE SMW table.

**Excess de minimis is aggregation, not ordered absorption.** RMC 50-2018 A5: excess de minimis is added into "other benefits" and the ₱90,000 applied to the resulting total. No waterfall allocator needed — the prior report's "ordered absorption" framing was arithmetically equivalent but misleading.

**De minimis needs per-type accumulation.** Eleven types × independent ceilings means a single lumped `61230 De Minimis Benefits` account cannot produce the per-type excess figures. Either eleven children or a de-minimis-type dimension on the journal line.

**SSS is a 45-row bracketed MSC table, not a flat 15%.** Per SSS Circular 2024-006: MSC steps every ₱500 from ₱5,000 to ₱35,000 across three programs — Regular SS (MSC capped ₱20,000), MPF/MySSS Pension Booster (the ₱20,000–₱35,000 portion), and Employees' Compensation. **EC is employer-only and a flat peso amount**: ₱10.00 where MSC ≤ ₱14,500, ₱30.00 where MSC ≥ ₱15,000. At the ceiling: employer ₱3,530.00, employee ₱1,750.00.

**Pag-IBIG employee rate is 1.0%** where fund salary ≤ ₱1,500, 2.0% above (Circular 460). Employer is 2.0% throughout. The ₱10,000 Maximum Fund Salary and ₱200 cap each are correct.

**PhilHealth base is Monthly Basic Salary** — "the fixed basic rate," excluding commission, overtime, allowances, 13th month, bonuses and gratuities, and explicitly **not** reduced by undertime, tardiness, LWOP or absences (Advisory 2025-0002). This is a different base from both the SSS base and the withholding tax base.

**SMW is keyed by (region, sector, establishment size band, effective tranche)** — a single wage order carries several rates and multiple future-dated tranches. Curated reference data with a per-region `last_verified_at`. Do not scrape NWPC.

### A7. Codebase corrections

| Prior report claim                                           | Verified reality                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| "Cannot close a period"                                      | A period close **does** exist: `auth_organizations.closed_through` (`src/db/schema/auth.ts:92`), `src/lib/period-close.ts`. The real gaps are narrower: one global date with no per-form granularity, **ungated reopen**, and the bill-void path ignores it                                                                                                                              |
| "rounding drift between `decimal(15,2)` and `decimal(20,8)`" | Not what happens. Line amounts pass through as 2dp strings — the widening is lossless. The **actual** hazard: header totals use `Number.parseFloat` + `.toFixed(2)` (`-bills.ts:719`), and `validateBalance` compares floats rounded to 2dp against a ledger stored at 8 decimals, so an 8-decimal amount **passes validation while the stored journal is unbalanced**                   |
| Tax lines can be added at the COA/mapping layer              | **There is no shared posting service.** Nine distinct sites build journal inserts by hand. `src/lib/invoice-journal.ts:78` is **dead code the integration test imports** while production runs a separate copy at `-invoices.ts:565` — despite a comment at `-invoices.ts:509` asserting the two "cannot drift." `src/lib/manual-bill-payment.ts:33` is a second copy of `-bills.ts:684` |
| "`functionalCurrency` defaults USD, must be PHP"             | Worse. **Six of nine posting sites never set the field at all** and take the column default regardless of org configuration                                                                                                                                                                                                                                                              |
| `business_groups` should carry BIR branch codes              | `business_groups` is a **reporting-only overlay** — no parent/child, no ownership, no consolidation entries, its own separate role system. The filing entity is the Better Auth organization. Branch codes do not belong there                                                                                                                                                           |
| "No employee/payroll tables"                                 | Partly refuted: `partyType` already includes `employee` and employees are a first-class exportable entity. There is no payroll **run/line** table — that part stands                                                                                                                                                                                                                     |
| "`invoices.taxAmount` is disruptive to replace"              | The opposite. **No UI can set it** — all three call sites hard-code `taxAmount: "0"`. There is no production data to migrate; per-line VAT is greenfield                                                                                                                                                                                                                                 |
| RLS is the tenant boundary (per `CLAUDE.md:4`)               | **Aspirational, not current.** `drizzle/rls_hardening.sql` Section B (FORCE + dropping the `IS NULL` bypass) is entirely commented out and the app connects as the table owner. **No policy is enforced.** A cross-org IDOR of exactly this shape is already logged in `CODE_REVIEW_findings.md:19`                                                                                      |
| "Deadline calendar driven by data" as if scheduling exists   | **No cron or recurring-schedule primitive anywhere.** One Cloud Scheduler job ticking a generic worker drain. All eight job handlers are event-driven; none send notifications                                                                                                                                                                                                           |
| Testing has a place to plug in                               | Thinner than implied. **No DB fixture/factory library** — `tests/utils/db-utils.ts` is 23 lines returning a raw pool. No transaction-rollback isolation                                                                                                                                                                                                                                  |
| —                                                            | **The migration pipeline is forked.** `drizzle/meta/_journal.json` lists 3 of 36 SQL files; the rest run through three bespoke runners, and `0019_inbox_review_foundation.sql` **never ran in any environment**. A tax migration wired to the wrong runner is silently absent in production                                                                                              |
| —                                                            | **The bill OCR prompt already asks the model to extract TINs** (`src/lib/ai/prompts/bill-ocr.ts:64`, with a "+63 → PH" hint) while `billOcrOutputSchema` has no field to receive them. Every extracted TIN is discarded. Cheapest single win in the plan                                                                                                                                 |

---

## Part B — Settled decisions

### D1 — Taxpayer scope: both segments, one preset, effective-dated facts

Support VAT-registered corporations **and** non-VAT sole proprietors/professionals.

**Reject two COA presets.** Ship **one** `philippines_smb` preset. Reject branching on a scalar `vat_status` enum. Registration status is an **effective-dated fact**:

- `org_tax_registrations(org_id, regime_kind, value, effective_from, effective_to, source_event)`
- `org_tax_year_elections(org_id, taxable_year, regime, elected_via_form, irrevocable, has_compensation_income)`
- TWA designation as a dated range driven by BIR publication date

**Every tax computation takes a mandatory `asOf` date** derived from the transaction or period — never `now()`.

Constraints: a corporation or partnership can never hold `8pct`; a VAT-registered org cannot. Mixed-income earners get 8% on the **full** base with no ₱250,000 allowance.

Add `tax_thresholds(threshold_key, effective_from, amount)` — both the ₱3M VAT threshold and the ₱500 non-VAT invoice threshold are statutorily CPI-indexed.

Add a **rolling-12-month and YTD gross-sales monitor** firing at ₱3M. This is the highest-value automation available to the PH SMB market and is only expressible on the effective-dated model.

**The non-VAT/8% segment ships last**, bundled with the threshold monitor as its headline feature.

### D2 — Payroll: import-first, and the deliverable is a _verifier_

Import the payroll register. Do not build timekeeping, leave, payslips or disbursement.

**Reject "BIR-calculator parity" as the engine's specification.** The spec target is **RR 11-2018 §2.79(B) and Illustrations 6–15**. The calculator is a differential oracle for the ordinary case only.

The v1 deliverable is a **variance report** — `expected vs reported vs delta`, per employee per period — not a "run payroll" button. The v1 product is **"January in a day"**: import register + opening YTD → annualize → 2316 for every employee + 1604-C alphalist `.DAT` + the refund workflow. 1601-C is a by-product presented as a diagnostic.

Accept that "engine only" still requires most of the payroll data model, because the engine is stateful:

- `payroll_employee_year_state` — YTD gross / taxable / non-taxable / 13th-month / tax withheld, **per-de-minimis-type YTD**, the `withholding_method` latch, previous-employer 2316 block
- `previous_employer_2316` as a **blocking precondition** of the first payroll run for any mid-year hire

Keep `return_period` and `remittance_period` separate from day one (see A5, RA 11976 §12).

Ship a buwiz Excel register template as the primary intake path; vendor column-mapping secondary.

### D3 — Bracketing: no configurability, mandatory cumulative average method

**Delete per-org bracketing configurability.** There is no legal basis for an org to elect total-taxable bracketing.

Implement `withholding_method ∈ {regular, cumulative_average}` per **(employee, calendar_year)**, evaluated against the three RR 11-2018 §2.79(B)(5)(a) triggers on **every** payroll run and **latched irreversibly** for the calendar year on first trip. Store the trigger reason and first-trigger date. Surface a per-employee badge stating which method is in force and why.

Two named methods behind one dispatcher — the cumulative method brackets on the cumulative average of regular **+** supplementary, so a shared bracketing function is the wrong abstraction.

Annualization is a **payroll-run-level trigger** (separation **or** December), not a calendar job, and it produces **postings**:

- Over-withholding refund: a real journal (Dr withholding payable, Cr net pay), **deadline 25 January**, recovered by under-remitting the following 1601-C — so the control-account reconciliation must expect that divergence
- Unrecoverable year-end deficiency: employer expense + employee receivable, not a silent zero

If an org wants more withheld, the correct mechanism is per-employee `voluntary_additional_withholding` (an explicit consented amount, reported correctly on 2316) — not a bracketing toggle.

### D4 — MWE: implement the regulation, no override

Implement RR 11-2018 §2.78.1(B)(13) / _Soriano_. **Delete the org-level override.** If an escape hatch is needed it is a per-payroll-run manual adjustment with a recorded reason, which is required anyway.

Spend the saved effort on the complexity that actually exists:

- **Hazard pay splits** into qualifying (exempt for MWE) and non-qualifying (taxable even for MWE), with a `dole_certification_ref` — 1604-C requires the employer to justify exempt hazard pay
- `regional_wage_rates(region, sector, establishment_size_band, daily_rate, effective_from, wage_order_ref, last_verified_at)` as **curated** reference data with a staleness warning in the UI. Explicitly do not scrape NWPC. A stale SMW row silently corrupts de minimis item (j) as well
- **Hard block** on any wage-rate edit that newly qualifies an employee as an MWE, requiring recorded justification — RR 11-2018 treats misrepresentation with automatic disallowance of the employer's compensation expense

### D5 — Filing identity: the Better Auth organization, not business_groups

One Better Auth organization = one TIN = the filing entity.

- `org_tax_profiles` **1:1 with `auth_organizations`**, modeled on the existing `organization_secrets` sidecar pattern — **not** `auth_organizations.metadata`, which is an unconstrained text JSON blob that Better Auth returns to browser clients and which is an exportable entity triggering the export/import protocol
- Fields: TIN, head-office branch code, RDO, `taxpayer_classification` (micro/small/medium/large — drives penalties), `efps_enrolled`, `efps_industry_group` (A–E), `is_nga`, fiscal year end, ACCN/PTU + approved invoice series range
- `org_tax_branches(org_id, branch_code CHAR(5), name, rdo_code, is_withholding_agent)` with `UNIQUE(org_id, branch_code)`
- **No BIR fields on `business_groups` or `organization_group_entities`**

**Reject "returns file per registered branch"** — that over-files. Branch is a filing-identity attribute with **per-form applicability**:

| filing_scope            | Forms                          |
| ----------------------- | ------------------------------ |
| `consolidated`          | 2550Q, 2551Q, 1701/1702 series |
| `per_withholding_agent` | 1601-C, 0619-E/F, 1601-EQ/FQ   |

Ship the schema now (including a nullable `branch_code` on journal lines and every tax table — free now, a migration over live filing data later). Ship **head-office-consolidated computation in v1**; per-branch return splitting is post-v1, gated on BIR reconciling the 4-vs-5-digit divergence.

Store branch codes as 5 digits, emit 4 for `.DAT`, log the truncation.

### D6 — Filing depth: compute + export + printable. No transmission. No CAS registration in v1.

Confirmed: **no transmission, no eTSPCert.** Write into the ToS an explicit statement of who the filer of record is.

Two sharpenings that change the shape of the decision:

**(a) `.DAT` generation is the primary deliverable, not the return PDF.** "Compute and export" is a complete product only if the exports are the `.DAT` files and the certificates. It is a half-product if it is return PDFs and pre-filled field maps.

Build the encoder from **declarative per-(form, schedule) ordered field tables** transcribed from RMC 25-2024 Annex A — never per-form hand-written serializers, because field _order_ differs between 1601EQ and 1601FQ for identically-named fields and schedule numbers are global across the 1604 family. Archive Annexes A and B in-repo as the spec of record with a test asserting field counts per schedule.

Pre-flight validations are **blocking gates**: reject non-ASCII with explicit logged Ñ→N transliteration; block export if any payee lacks a TIN; forbid "Various"/"Others" payee rows; **regenerate the entire period on amendment** (BIR cannot ingest deltas), which requires immutable period snapshots.

Submission channel is **per-org configuration** (eFPS attachment / eSubmission / RDO email), not a hard-coded address.

**(b) buwiz-books does NOT issue Philippine sales invoices in v1, and is NOT registered as the client's CAS in v1.**

RR 11-2025 §3(A)(d) as extended by RR 26-2025 makes CAS users mandatory e-invoicing filers by **31 December 2026** — and registering buwiz-books as a client's CAS is itself the trigger, against a transmission spec BIR has not published. Meanwhile RR 7-2024 §3(D)(2) means a VAT-registered seller whose invoice omits the "VAT-Exempt Sale" legend or the breakdown **owes VAT on that sale as if the exemption did not apply**.

Today the invoice PDF has no seller address, no TIN, no VAT-registration label, no serial series, no four-way VAT breakdown, and the email hard-codes a `$` sigil. Shipping PH invoicing before that is fixed **converts a client's exempt sales into taxable ones**.

**Position for v1: a computation and reporting layer beside the client's already-registered invoices.** Capture their sales from their own registered documents. This defers the e-invoicing mandate exposure entirely and lets the client keep their existing BIR-approved invoices.

The CAS registration pack is **gated** — do not publish it until either the client is Micro (<₱3M, exempt from RR 11-2025) or the product has a structured-data e-invoice output. Until then it must carry a written warning about the 31 December 2026 deadline.

If and when PH invoice issuance does ship, it needs: ACCN/PTU + approved series range + issue date stamped on the face; per-invoice-**type** gapless serials; "REPRINT" on reissue (requires a print/download event log); the full RR 7-2024 §3(B)/§6(B) field set including a buyer block that must **exist** even when B2C leaves it blank; the four-way VATable / VAT Amount / Zero-Rated / Exempt footer; and a two-tier fatal-field validator. Fix the broken `number_sequences` export filter first (see A7 / D-N9).

### D7 — Opening balances: structurally blocking, two tiers

An org must not be able to advance any `tax_period` to `computed` for taxable year Y unless year-Y opening balances exist and tie out. Model the gate on the existing `setClosedThrough` completeness-check shape.

**Tier 1 — blocking, per-form:**

- First payroll run of a calendar year requires per-employee YTD gross / taxable / non-taxable split / 13th-month YTD / tax withheld YTD
- `previous_employer_2316` for anyone hired that year, carrying taxable compensation, tax withheld, employment from/to and the MWE breakdown
- `withholding_method` latch state per employee for the migration year — an employee who tripped a trigger under the prior system must stay latched
- **Per-de-minimis-type** YTD across all eleven RR 29-2025 types, with the three limit shapes representable (peso, day-count, percentage-of-SMW) and government VL/SL representable as uncapped
- The relevant control-account opening balance before the first computation of any return form
- Payee-level pre-migration withholding detail sufficient to reproduce a **complete** annual 1604-C/E/F alphalist for the migration year
- For VAT clients: EOPT transitional flag on migrated AR (pre/post 27 April 2024) plus `credit_term` and VAT-credit lifecycle state on open receivables; `vat_recognition_basis` flag for service receivables invoiced before 27 Apr 2024 (they recognise output VAT on collection under the transitory rule)
- Unconsumed invoice serial ranges per invoice type and the ACCN under which they were approved

**Tier 2 — continuous, never a migration gate:**

- Inbound 2307 capture via the OCR pipeline

Add an org-level `books_as_of` date so prior periods are explicitly marked "filed outside buwiz." Mark every opening balance with a `pre_migration` flag and an as-of date that the reconciliation invariant **excludes by construction**. Stamp the reference-dataset version on every accepted intake so an amended prior-period return recomputes against the figures as they were understood then.

Surface onboarding progress showing exactly what is missing and which artifact it blocks.

---

## Part C — Decisions the seven questions missed

### D-N1 — Stage 0 ledger hardening is a hard prerequisite

All three panels converged on this independently. **No tax code ships until:**

| Defect                                                                                                                              | Evidence                                                                                                             |
| ----------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| Bill void **bypasses the period lock entirely**                                                                                     | `src/routes/api/-bills.ts:911` — unlike bill delete (`:1092`) and invoice void (`-invoices.ts:896`) which both check |
| Bill void **double-removes**: sets header to `voided` **and** posts a mirrored reversal, so reports subtract the amount twice       | `-bills.ts:934` and `:944`                                                                                           |
| Posted journals are **freely editable in place** — all lines deleted and reinserted, no `status==='posted'` check                   | `src/routes/api/transactions/-_mutations.ts:108-161`                                                                 |
| Bulk recategorise **repoints `account_id` across posted journals**                                                                  | `-_batch.ts:243`                                                                                                     |
| **No DB-level debits==credits constraint** anywhere; both bill-accrual paths post without calling `validateBalance` at all          | `-bills.ts:769`                                                                                                      |
| Period-close **reopen is completely ungated** — any `journal:post` holder can set the boundary to null and unlock every filed month | `-_period-close.ts:133`                                                                                              |
| Nine unconsolidated posting sites, two of them dead forks the tests point at                                                        | see A7                                                                                                               |
| `functionalCurrency` USD on almost every journal posted                                                                             | `src/db/schema/journals.ts:89`                                                                                       |
| Three payment paths stamp `transactionDate = new Date()` (server today) instead of the effective date                               | `src/lib/manual-bill-payment.ts:161`                                                                                 |

**Why first:** the entire correctness claim of this product is `Δ control account == Σ tax detail == form total`. That requires the transactions behind a filed return to still exist as filed, and today they need not. This stage is _strictly cheaper now than later_, ships as pure bug-fix value to existing clients with no PH dependency, and every week of tax work built on nine mutable posting paths is a week that gets rewritten.

### D-N2 — Tax code → control account resolution

Reject `mappingType: "tax"` (see A1). Use `tax_codes.control_account_id` as a direct FK, resolved by a tax-specific resolver that **fails loud with no subtype-fallback tier**, seeded per-org by the PH preset.

The prior report's plan to put Output VAT, VAT Payable-Net, EWT/FWT/percentage/income/DST payables all on `other_current_liabilities` is the exact many-to-one hazard `base-mappings.ts:3-9` was written to avoid — the tier-2 subtype fallback would return an arbitrary tax payable. If a dedicated liability subtype is added, it must also be added to `OPERATING/INVESTING/FINANCING_SUBTYPES` in `src/lib/report-calculations.ts:51-85` and to `SUBTYPE_LABELS`, or `tests/unit/lib/coa/presets.test.ts:66` fails.

Build a **control-account protection concept**. `isSystem` is roots-only (asserted by `validate-preset.ts:71-85`) and blocks only delete and deactivate — a mapped control account can still be renamed, renumbered and reparented via `updateAccount`.

Preset reachability: `presetForIndustry` (`src/lib/coa/presets/index.ts:31`) matches only `INDUSTRIES` values and each industry may be claimed by at most one preset (test-enforced). Ship `philippines_smb` with `industries: []` plus a **jurisdiction field** on the org and explicit picker selection.

**Grow the chart one phase at a time.** Every account added early is a permanent obligation on every preset and every org; every account added late costs nothing extra. Do not ship a 20-account preset in Phase 1.

### D-N3 — Period assignment: RR 4-2024 §2.57.4

The withholding obligation arises at `MIN(booking date, supplier invoice date)`. **EWT attaches to the bill accrual journal, not the payment journal.** Thread an explicit `effectiveDate` through the payment paths.

Bills reach the GL via **two independent routes** — the inbox `transaction_candidate` written by `createBill` (`-bills.ts:513`) and the accrual journal from `transitionBillStatus` (`-bills.ts:685`). **Name the authoritative path before Phase 3**; tax wired into one produces two divergent journals for the same bill.

### D-N4 — Tax filing periods are a separate lock axis

`closedThrough` is one global ISO date. 1601-C closes monthly, 1601-EQ/FQ quarterly on calendar quarters, 2550Q on the taxpayer's fiscal quarter, 1604-C annually — all over the same transactions. Overloading `closedThrough` means either March cannot close for VAT until compensation is done, or it closes and cannot be amended.

`tax_filing_periods(org_id, form_code, branch_code, period_start, period_end, state, filed_at, filing_reference, locked_by)` with its own lock that `closedThrough` **cannot override**, and `closedThrough` advancement gated on overlapping tax periods being filed. Reopen is a separately-privileged, reason-recorded path.

### D-N5 — Amendment as a first-class object with an immutable as-filed snapshot

Snapshot at filing, non-recomputable, checksummed, with the reference-dataset version stamped. Given that posted journals are currently mutable, the snapshot is the **only** evidence of what was filed — which raises its priority rather than lowering it. Filing evidence (reference, confirmation attachment, payment) is the precondition for marking a period filed.

### D-N6 — One money type, one rounding rule

BigInt at scale 8 (`src/lib/inbox/money.ts`, matching the `decimal(20,8)` column). State the BIR rounding rule — **half-up at 2dp per tax computation** — explicitly at each computation site rather than inheriting the caller's helper. Route every posting site through one balance check using the exact comparator. `src/lib/money.ts` (integer cents at 2dp) and the `Number.parseFloat`/`.toFixed(2)` paths must not be used for tax.

Model PH invoices as **VAT-exclusive net lines with a derived VAT total**; do the inclusive→exclusive back-out at line entry in the UI, not in the money module. `calculateInvoiceAmounts` hard-enforces `total = subtotal − discount + tax` and `createArJournalEntry` re-validates it; VAT-inclusive list pricing violates both.

### D-N7 — Variance policy when the engine and the imported register disagree

**File the client's figure. Record the variance and the client's acknowledgement immutably. Refuse to mark the period filed while an unacknowledged blocking variance exists.** The product is the control, not the computer of record.

### D-N8 — Filer of record, in writing

Every generated return, 2307, 2306 and 2316 states who prepared it and who is responsible. The ToS says buwiz-books computes; the taxpayer files. NIRC §81 puts withheld taxes in trust with the **employer**; the product must not create an impression it has assumed that.

### D-N9 — Certificate serial control

`bir_certificate_serials(org_id, form_code, period, serial, certificate_id, state, allocated_at)` consuming `allocateSequenceValue` inside the issuing transaction. `number_sequences` gives a gapless row-locked counter but stores no allocation record, no entity binding and no void state — **and its export filter is broken** (`src/routes/api/-export-import.ts:562` tests `r.scope.startsWith(orgId)` against scopes written `<kind>:<orgId>`), so serials restart at 1 on org export/import, producing duplicate BIR certificate numbers. Fix before any BIR serial depends on it.

### D-N10 — RLS posture

Every tax table gets a `NOT NULL organization_id` populated on every insert, an explicit org predicate on every query, a hand-appended DO block in `drizzle/rls_policies.sql` (nothing generates them — a new table silently gets **no policy**), a name added to the commented FORCE array, and a cross-org isolation integration test using the `SET LOCAL ROLE buwiz_app` harness. Add a unit test asserting every org-scoped table exported from `src/db/schema/index.ts` appears in `rls_policies.sql`.

### D-N11 — Migration pipeline

Register tax migrations with the runner **the deploy path actually calls**, and add a wiring test in the style of `tests/unit/review-rules-wiring.test.ts` asserting the link from `db:fresh`, `db:test:fresh`, `deploy.yml` and `make migrate`.

### D-N12 — Reference-data governance is a standing operating cost, with a named owner

The surface: the ATC catalog, withholding tables, de minimis ceilings (**changed twice in fourteen months**, and RR 4-2025 changed a permitted _form_, not just an amount), SSS/PhilHealth/Pag-IBIG schedules, seventeen regional wage orders with independent tranches, a holiday table for deadline roll-forward that distinguishes special **non-working** days (which roll) from special **working** days (which do not), and per-period RMC deadline overrides (**RMC 30-2026 moved the CY2025 annual ITR from 15 April to 15 May 2026 with four weeks' notice**).

Mechanism: seeded TypeScript catalog → `ON CONFLICT DO NOTHING` seeder → a reviewed **numbered migration** for any change → wiring test, following the `review-rule-catalog` precedent. A TypeScript constant edit must not be able to silently retune every tenant's withholding at deploy time with no version bump and no audit row. Per-table `last_verified_at` surfaced in the UI. **Name the human who owns this.**

### D-N13 — Party tax profile

Add `party_tax_profiles` alongside; leave the legacy `is1099Vendor`/`taxId` columns (they are read by nothing computational, but they are in the `EXPORT_VERSION=2` contract with fixtures). `party_tax_profiles` needs `status_code` (residency/entity class, LOV A–G) because 1604F Schedules 4 and 6 and 1601FQ Schedule 3 require it and it **drives ATC selection** — this is not optional metadata.

Add `vendor.tin` to `billOcrOutputSchema` and pass it into `createParty`. The prompt already asks for it and the schema discards it — near-free, and it immediately populates the PH party tax profile.

### D-N14 — PHP as functional currency, independent of tax

Six of nine posting sites never set `functionalCurrency`; `organization_accounting_settings.baseCurrency` also defaults to USD; the invoice email hard-codes `$`; the PDF defaults to `USD`. **A Philippine client's first invoice today goes out with a dollar sign.** Fix and backfill before any PH client sees the product.

### D-N15 — Unit of sale: the accounting firm

_(Business decision, taken as a working assumption — flag for the owner.)_ Sell to the firm. The owner pays, the bookkeeper chooses, and the bookkeeper is the one who switches. The codebase already has a `clientApprover` role suggesting a firm model. Consequences: cross-org filing calendar becomes a near-term feature; prepared-by / reviewed-by workflow matters; employees are a plausible metered dimension (2316 + alphalist is seasonal work firms currently outsource per head).

---

## Part D — Sequencing

Reconciling three panel orderings. Compliance and engineering both put ledger hardening first; product agrees but adds a week-zero `.DAT` spike. The one genuine disagreement is whether received-2307 capture precedes purchase-side EWT — product argues yes on value-to-effort; that is adopted, since it is a subset of the same spine.

| Stage   | Content                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Why here                                                                                                                                                                                                                                                                                                            |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0**   | **Ledger hardening. Zero tax code.** Consolidate nine posting sites into one service per document type; delete the dead `invoice-journal.ts` fork and repoint its test; one money type (BigInt scale 8) through one balance check; deferred DB constraint trigger for debits==credits on posted headers; posted journals amend-by-reversal; fix bill-void (double-removal + period-lock bypass); backfill and explicitly pass `functionalCurrency`; thread `effectiveDate` through payment paths | Only stage that is strictly cheaper now than later. Ships as pure bug-fix value with no PH dependency. The reconciliation invariant is unenforceable until it lands                                                                                                                                                 |
| **0.5** | **`.DAT` empirical spike — half a day, parallel with Stage 0.** Install Alphalist Data Entry and Validation Module 7.4 on a Windows VM; key two dummy payees, one with a comma and one with `ñ` in the registered name; save; hex-dump the eAlpha output                                                                                                                                                                                                                                         | Resolves the single remaining blocking unknown: quoting rule, empty-field handling, line terminator, encoding, numeric padding. A wrong quoting rule doesn't fail loudly — it parses into **shifted fields**, loading wrong amounts against wrong payees into the BIR data warehouse, invisible until an assessment |
| **1**   | **Reference spine + org identity.** Effective-dated tables with mandatory as-of lookups; `org_tax_profiles`, `org_tax_branches`, `org_tax_registrations`, `org_tax_year_elections`, `party_tax_profiles`, `tax_filing_periods`; seeded catalog wired through all four points with a wiring test; RLS DO blocks; migration registered with the real runner. **Three accounts only** — CWT Receivable, Withholding Tax Payable, Input VAT                                                          | No user-visible feature. This is the stage that determines whether the product rots. Getting the _shape_ wrong here — booleans where timelines belong — propagates into every return the product will ever produce                                                                                                  |
| **2**   | **Pure tax engine. No persistence, no posting.** `resolveWithholding(payment, asOf)` and the compensation engine including both withholding methods and the three triggers                                                                                                                                                                                                                                                                                                                       | 100% unit-testable, zero blast radius, auditable in isolation against RR 11-2018 Illustrations 6–15 plus a differential harness against a verbatim BIR-algorithm oracle. The legal correctness lives here                                                                                                           |
| **3a**  | **Received-2307 capture → CWT Receivable → SAWT.** A `form_2307_ocr` AI task (four mechanical edits to an already well-factored registry; two exhaustive `Record<AiTaskName,...>` maps make the compiler enumerate every site), three accounts, one extra journal leg on the invoice payment path                                                                                                                                                                                                | Best value-to-effort ratio in the plan. Needs no invoice compliance, no VAT engine, no payroll. Serves **every** PH segment including 8% sole props. "We found ₱184,000 of unclaimed creditable withholding in your folder" is the demo that sells the product                                                      |
| **3b**  | **Purchase-side EWT.** Tax fields on `bill_line_items`; one poster injecting Input VAT and EWT; `transaction_taxes` with the **month** retained; Form 2307 issuance; 0619-E; 1601-EQ + QAP `.DAT`                                                                                                                                                                                                                                                                                                | Highest frequency of small compounding errors, and the thing clients genuinely cannot do in a spreadsheet. Exercises the entire spine on the smallest surface. Purchase side, so a bug's blast radius is the client's own deduction, not a customer-facing legal document. Seed ~25 high-frequency ATCs, not 200    |
| **4**   | **Filing workspace.** Reconciliation invariant enforced before `filed` (written to accommodate refunds and prior-period adjustments so it does not false-fail); immutable checksummed as-filed snapshots; deadline model as **data** — per-form period type, channel, eFPS group offsets A=+15 → E=+11, the December 1601-C exceptions, roll-forward over a holiday table distinguishing special non-working from special working days, and a `filing_deadline_overrides` table                  | Not an afterthought — it is what turns three computations into a product. Ship as soon as there are two forms to hold                                                                                                                                                                                               |
| **5**   | **January: payroll import + opening YTD + annualization → 2316 + 1604-C alphalist `.DAT` + refund workflow**                                                                                                                                                                                                                                                                                                                                                                                     | **Date-driven, not dependency-driven.** Must be usable by **November 2026** or it is worth nothing for twelve months                                                                                                                                                                                                |
| **6**   | **Sales-side VAT.** Per-line `taxTreatment` with the three-state exempt-attribution tag; 2550Q including the mandatory item-53 allocation and the items 35/36/55/58 uncollected-receivable machinery; SLSP                                                                                                                                                                                                                                                                                       | Larger than it looks, and a risky change to a path that currently works. Initially only for clients whose invoices buwiz does **not** issue                                                                                                                                                                         |
| **7**   | **Non-VAT / 8%.** 2551Q, 1701Q, and the ₱3M threshold monitor                                                                                                                                                                                                                                                                                                                                                                                                                                    | Cheap once the ledger carries gross sales. The threshold monitor is the marketing asset that pulls the cheap segment toward the expensive one                                                                                                                                                                       |

**Deferred, explicitly:** final withholding (1601-FQ / 1604-F / 2306), fringe benefit tax, DST, running payroll (timekeeping, leave, payslips, disbursement), transmission, eTSPCert, PH invoice issuance, per-branch return splitting, a second COA preset.

### The one open scheduling tension

Stage 5 is date-driven and Stage 3b is dependency-driven, and they compete. Compliance flagged the tiebreaker: **the ordering above assumes a client mix skewed toward service firms with many professional-fee suppliers and few employees.** If the mix skews labour-heavy — retail, food service, manufacturing — the 2316 obligation moves up sharply, because failure to furnish 2316 is a ground for **mandatory audit of the employer's entire internal revenue tax position**, not just its payroll, with §255 exposure after two consecutive years. That is a larger single exposure than anything on the EWT side.

**This is the one question the owner must answer:** what is the client mix? It decides Stage 3b vs Stage 5 ordering, and it is the only remaining input that changes the plan.

---

## Part E — Still unresolved

Carried forward. None blocks Stage 0 or Stage 1.

| #   | Item                                                                                                                                                                                                                                                                                                                                                           | Resolution path                                                                                                    |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| U1  | **`.DAT` text-field quoting rule** — RMC 5-2014 says "CSV data file format" but no BIR document states whether text fields are double-quoted, and `REGISTERED_NAME`/`NATURE_INCOME` are 50-char free text that can contain commas. Also unresolved: line terminator, encoding, empty-field handling, numeric padding                                           | **Stage 0.5 VM experiment.** Half a day. Blocks the encoder, nothing else                                          |
| U2  | **WI710/WC710 legal reconciliation** — RR 11-2018 §2.57.2(S) says 20% and was never amended; BIR Form 1601-EQ and eBIRForms say 15%. No RR or RMC effecting the reduction was found                                                                                                                                                                            | Written BIR query or tax counsel opinion before it touches a client filing                                         |
| U3  | **ATC for §2.57.2(X) e-marketplace / DFSP remittances** — RR 16-2023, RMC 8-2024 and RR 5-2025 prescribe the rate without assigning an ATC                                                                                                                                                                                                                     | Read out of the eBIRForms v7.9.6.0 1601-EQ ATC dropdown. **Do not guess** — a wrong ATC on a QAP is a filing error |
| U4  | **Input VAT on services: bill date or payment date?** RR 13-2018 §4.110-3(c) says "upon payment"; EOPT's accrual language is framed around the seller. 2550Q item 55 "Input VAT on Unpaid Payables" implies booking on billing then backing out                                                                                                                | Tax counsel. Safe default: claim on billing and carry the item-55 reversal machinery, matching the form's design   |
| U5  | **RR 5-2025 credit-card QAP base** — the tax is unchanged at 0.5% but the reported income-payment column may now be full gross rather than half                                                                                                                                                                                                                | Verify against the actual eBIRForms package before Stage 3b                                                        |
| U6  | **RR 29-2025 effective date** — the RR states only "fifteen days following publication"; 6 January 2026 is derived from the 22 December 2025 issuance date and corroborated by KPMG/PwC, but no BIR or Official Gazette publication-date page was found                                                                                                        | Verify before using as a hard effective-date boundary in reference data                                            |
| U7  | **RR 11-2018 Annexes D and E** (the withholding tax tables themselves) were not retrieved. The five tables were transcribed from the calculator's JavaScript and are consistent with the annual schedule, but the periodic prescribed constants (monthly ₱8,541.80, ₱33,541.80 — not exactly 1/12 of the annual figures) have not been checked against Annex E | Retrieve Annex E, or RMC 1-2018 for Annex D, before locking golden vectors                                         |
| U8  | **1604-C deadline** not confirmed from primary text — consistent with the 1604-F 31 January deadline but not independently verified                                                                                                                                                                                                                            | Retrieve the 1604-C form PDF                                                                                       |
| U9  | **RR 24-2025 scope questions** — whether the ½% carve-out displaces 1% for _government_ buyers (text says no), and whether "intended for wholesale" is tested at the seller or by the buyer's downstream use                                                                                                                                                   | No BIR guidance found; tax counsel                                                                                 |
| U10 | **₱90,000 ceiling: accrual or receipt?** RR 11-2018 §2.78.1(B)(11) says "paid or accrued during the year" while the same subsection says "actually received." Matters only for benefits declared in December and paid in January                                                                                                                               | Tax counsel before choosing the accumulator basis                                                                  |
| U11 | **No 2026 BIR Tax Calendar PDF** could be located; all deadline claims are anchored to the 2025 calendar                                                                                                                                                                                                                                                       | One manual check before shipping Stage 4                                                                           |
| U12 | **e-Sales Reporting spec** — RR 11-2025/26-2025 promised separate Revenue Regulations for the transmission format and EIS onboarding; none published as of 16 Aug 2026. The e-invoice **issuance** mandate bites 31 December 2026; e-sales **reporting** has no date                                                                                           | Active watch item, not a spec. Reinforces D6(b)                                                                    |
