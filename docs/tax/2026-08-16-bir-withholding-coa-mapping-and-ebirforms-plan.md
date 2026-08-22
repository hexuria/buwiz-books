# BIR Withholding Tax → Chart of Accounts Mapping & eBIRForms Implementation Plan

**Date:** 2026-08-16
**Scope:** Reverse-engineering of the BIR Withholding Tax Calculator, verification against current law (as of Aug 2026), mapping to the buwiz-books chart of accounts, and a phased implementation plan for BIR tax compliance.
**Status:** Research + plan. No code changes.

---

## 0. Executive summary

**The single most important finding first:** the page you linked is _not_ a general withholding tax calculator. It is narrowly the **withholding tax on compensation** calculator — "For Employees Earning Purely Compensation Income" — which feeds exactly three forms: **1601-C**, **2316**, and **1604-C**. It has nothing to say about the withholding you do on suppliers (EWT/1601-EQ), on passive income (FWT/1601-FQ), on VAT, or on percentage tax. Those are ~80% of the work in an eBIRForms feature, and they are the parts that actually touch your bills/invoices tables.

So the mapping question splits into two very different answers:

1. **The compensation calculator maps to expense + liability accounts in a payroll journal.** Its 20 input fields are payroll expense sub-accounts (with one important exception — the SSS/PhilHealth/Pag-IBIG box is a _liability_, not an expense), and its single output is a credit to a withholding-tax-payable control account.

2. **Everything else — EWT, VAT, FWT, percentage tax — is _not_ a chart-of-accounts category at all.** It is an _attribute on a transaction line_ that resolves to a small set of **control accounts**. Trying to model "5% professional fee withholding" as a COA category is the classic mistake; you would need one category per ATC code (200+), and you would still not be able to produce Form 2307 because the certificate needs per-payee, per-ATC, per-quarter detail that a GL account balance cannot carry.

The right shape for buwiz-books is: **a `tax_codes` reference table (rate + ATC + form + base rule) → resolved through the existing `category_mappings` registry (add a 4th `mappingType: "tax"`) → onto a fixed set of ~20 control accounts.** That reuses machinery you already have (`MAPPING_CONFIGS`, `isMappingTargetCompatible`, the preset planner's completeness guarantee) instead of inventing a parallel system.

**Second most important finding:** the BIR calculator's `Basic Salary` field expects an amount **already net of mandatory SSS/PhilHealth/Pag-IBIG contributions** (confirmed by its own tooltip). If you feed gross basic salary into the same formula, every employee is over-withheld. Details in §2.5.

**Third:** the BIR page ships stale de minimis limits (pre-2018 values). Current ceilings come from **RR 29-2025, effective 6 January 2026**. Do not transcribe the numbers from the calculator page. See §3.2.

---

## 1. What was actually extracted

Both the HTML form and the computation engine were downloaded and read in full:

- `https://web-services.bir.gov.ph/tax_calculator/wt_calculator.html` (435 lines)
- `https://web-services.bir.gov.ph/tax_calculator/js/wt_calculator.js` (1,100 lines) — **this is the real specification**; the tax tables, the ₱90,000 ceiling logic and all bracket arithmetic are hard-coded here.

Note: the URL you provided wraps the real page in an `external_url` redirect shim; the canonical page is the bare `wt_calculator.html`. Also, `WebFetch` fails on this host with `unable to verify the first certificate` — BIR serves an incomplete TLS chain. `curl` works. Worth remembering if you ever automate a check against it.

---

## 2. Rules extracted from the calculator

### 2.1 Payroll periods

The JS defines a `period` lookup that is used only as an "is this annual?" discriminator (`getPayrollPeriod() < 4` is true only for `annual`):

| Period         | Internal value | Annualization factor |
| -------------- | -------------- | -------------------- |
| `daily`        | 264            | 264 working days     |
| `weekly`       | 66             | —                    |
| `semi_monthly` | 24             | 24                   |
| `monthly`      | 12             | 12                   |
| `annual`       | 1              | 1                    |

`weekly = 66` is not 52 — it is a legacy artifact. Do not reuse these as annualization multipliers; use 12 / 24 / 52 / 261 (or the employer's actual working days) and derive the periodic table from the annual table instead.

### 2.2 Field taxonomy — the three buckets

The form segregates every peso into exactly one of three buckets. This segregation _is_ the rule; everything downstream follows from it.

**A. Taxable Compensation — REGULAR** (determines the tax bracket)

> "Regular Compensation includes basic salary, fixed allowance for representation, transportation and other allowances paid less: net of mandatory deductions (GSIS, SSS, Philhealth and Pag-IBIG) to an employee per payroll period."

- Basic Salary
- Representation Allowance
- Transportation Allowance
- Cost of Living Allowance
- Fixed Housing Allowance
- Other Taxable Regular Compensation

**B. Taxable Compensation — SUPPLEMENTARY** (added to the excess, does _not_ move the bracket)

> "Supplementary Compensation includes payments to an employee in addition to the regular compensation such as commission, overtime pay, taxable retirement pay, taxable bonus and other taxable benefits with or without regard to a payroll period."

- Commission
- Profit Sharing
- Fees including Director's Fee
- **Taxable 13th Month Pay & Other Benefits** — read-only, derived: `max(0, otherBenefitsNt − 90,000)`
- Hazard Pay
- Overtime Pay
- Other Taxable Supplementary Compensation — explicitly includes taxable retirement pay, taxable separation pay, and _excess de minimis after absorbing the unused portion of the ₱90,000 ceiling_

**C. Non-Taxable / Exempt Compensation**

- Basic Salary / Statutory Minimum Wage Earner (MWE)
- Holiday Pay (MWE)
- Overtime Pay (MWE)
- Night Shift Differential (MWE)
- Hazard Pay (MWE)
- 13th Month Pay & Other Benefits — capped at ₱90,000; `min(input, 90,000)`
- De Minimis Benefits
- SSS, GSIS, Pag-IBIG Contributions and Union Dues (**employee's share only**)
- Salaries and Other Forms of Compensation (non-taxable retirement/separation pay)
- Other Non-Taxable/Exempt Compensation Income

### 2.3 The computation graph (exact, from source)

```
totalRegular        = basicSalary + representationAllowance + transportationAllowance
                    + costOfLivingAllowance + fixedHousingAllowance + otherTaxableRegular

taxableBenefits     = max(0, otherBenefitsNt − 90_000)          // auto-filled, read-only
nonTaxableBenefits  = min(otherBenefitsNt, 90_000)

totalSupplementary  = commission + profitSharing + fees + taxableBenefits
                    + hazardPay + overtimePay + otherTaxableSupplementary

totalNonTaxable     = basicSalaryNt + holidayPayNt + overtimePayNt + nightShiftDifferentialNt
                    + hazardPayNt + nonTaxableBenefits + deMinimisBenefitsNt
                    + sssGsisPagibigNt + salariesOtherCompensationNt + otherCompensationNt1

grossCompensation   = totalRegular + totalSupplementary + totalNonTaxable
netTaxableIncome    = totalRegular + totalSupplementary        // see §2.5

withholdingTax      = prescribedTax(bracketOf(totalRegular))
                    + rate(bracketOf(totalRegular)) × ((totalRegular − bracketFloor) + totalSupplementary)
```

Rounding: `Math.round(x * 100) / 100`, displayed to 2 decimals.

### 2.4 Withholding tax tables (2023-onwards TRAIN Phase 2 — verified current for 2026)

All five tables transcribed exactly from the source. Formula for every row:

> `WT = Prescribed + Rate × ((Regular − Floor) + Supplementary)`

**Daily**

| Regular compensation | Floor  | Prescribed WT | Rate on excess |
| -------------------- | ------ | ------------- | -------------- |
| 0 – 684              | 0      | 0.00          | 0%             |
| 685 – 1,095          | 685    | 0.00          | 15%            |
| 1,096 – 2,191        | 1,096  | 61.65         | 20%            |
| 2,192 – 5,478        | 2,192  | 280.85        | 25%            |
| 5,479 – 21,917       | 5,479  | 1,102.60      | 30%            |
| 21,918 and over      | 21,918 | 6,034.30      | 35%            |

**Weekly**

| Regular compensation | Floor   | Prescribed WT | Rate on excess |
| -------------------- | ------- | ------------- | -------------- |
| 0 – 4,807            | 0       | 0.00          | 0%             |
| 4,808 – 7,691        | 4,808   | 0.00          | 15%            |
| 7,692 – 15,384       | 7,692   | 432.60        | 20%            |
| 15,385 – 38,461      | 15,385  | 1,971.20      | 25%            |
| 38,462 – 153,845     | 38,462  | 7,740.45      | 30%            |
| 153,846 and over     | 153,846 | 42,355.65     | 35%            |

**Semi-monthly**

| Regular compensation | Floor   | Prescribed WT | Rate on excess |
| -------------------- | ------- | ------------- | -------------- |
| 0 – 10,416           | 0       | 0.00          | 0%             |
| 10,417 – 16,666      | 10,417  | 0.00          | 15%            |
| 16,667 – 33,332      | 16,667  | 937.50        | 20%            |
| 33,333 – 83,332      | 33,333  | 4,270.70      | 25%            |
| 83,333 – 333,332     | 83,333  | 16,770.70     | 30%            |
| 333,333 and over     | 333,333 | 91,770.70     | 35%            |

**Monthly**

| Regular compensation | Floor   | Prescribed WT | Rate on excess |
| -------------------- | ------- | ------------- | -------------- |
| 0 – 20,832           | 0       | 0.00          | 0%             |
| 20,833 – 33,332      | 20,833  | 0.00          | 15%            |
| 33,333 – 66,666      | 33,333  | 1,875.00      | 20%            |
| 66,667 – 166,666     | 66,667  | 8,541.80      | 25%            |
| 166,667 – 666,666    | 166,667 | 33,541.80     | 30%            |
| 666,667 and over     | 666,667 | 183,541.80    | 35%            |

**Annual**

| Net taxable income    | Floor     | Prescribed tax | Rate on excess |
| --------------------- | --------- | -------------- | -------------- |
| 0 – 249,999           | 0         | 0              | 0%             |
| 250,000 – 399,999     | 250,000   | 0              | 15%            |
| 400,000 – 799,999     | 400,000   | 22,500         | 20%            |
| 800,000 – 1,999,999   | 800,000   | 102,500        | 25%            |
| 2,000,000 – 7,999,999 | 2,000,000 | 402,500        | 30%            |
| 8,000,000 and over    | 8,000,000 | 2,202,500      | 35%            |

These are the TRAIN Phase 2 rates effective 1 Jan 2023 and **unchanged for 2026** — there is no new 2026 table.

Note that the ₱250,000 zero-rate threshold is _baked into the table's 0% bracket_. Do not subtract ₱250,000 separately anywhere. Likewise, **personal and additional exemptions were repealed by TRAIN** — that is why the entire `totalExemptions` / `personalAdditionalExemptions` / `paidInsurance` fieldset is HTML-commented out in the live page, and why `getTotalExemptions()` and the ₱2,400 health-insurance premium deduction are dead code. Do not implement them.

### 2.5 Traps, quirks and outright bugs in the BIR implementation

These are the things that will silently make your numbers differ from BIR's if you don't handle them deliberately.

**(a) `Basic Salary` is net of mandatory contributions — the biggest trap.**
The REGULAR tooltip says compensation is "paid less: net of mandatory deductions (GSIS, SSS, Philhealth and Pag-IBIG)". Confirming this in code: `getNetTaxableCompensationIncome()` subtracts `sssGsisPagibigNt` and then adds it straight back, so the contributions **never reduce the tax base**. They reduce it only because the user was expected to type a pre-reduced Basic Salary.

Consequence for buwiz-books: your payroll engine must compute
`taxableRegular = grossRegular − employeeShare(SSS + PhilHealth + Pag-IBIG + union dues)`
_before_ entering the bracket lookup. If you pass gross, every employee over-withholds.

**(b) The bracket is chosen by REGULAR compensation only.**
Supplementary compensation is added into the excess term but does not move the column. This is the prescribed "Revised Withholding Tax Table" procedure, but it produces large distortions when supplementary is big relative to regular:

> Monthly, Regular ₱20,833, Commission ₱500,000
> BIR method: `0 + 15% × (0 + 500,000) = ₱75,000`
> Bracketing on total ₱520,833 would give: `33,541.80 + 30% × 354,166 = ₱139,791.60`
> Difference: ₱64,791.60

This is _by design_ — periodic withholding is an estimate; the **year-end annualization** (which feeds 2316 and 1604-C) is the authoritative computation and trues it up. Your engine must implement **both**: a periodic estimator and an annualized true-up, and must not treat the periodic number as final. Worth a confirmation from your tax counsel that regular-only bracketing is what your clients' payroll should do, since practice varies.

**(c) Genuine bug in the daily table.**
`getDailyZero()` for the 0–684 bracket returns `(regular − 0) + supplementary` instead of `0`. The weekly, semi-monthly, monthly and annual functions all correctly return `0` for their lowest bracket. So a daily-paid worker earning ₱600/day is shown a withholding tax of ₱600. **Do not replicate this.** Your golden-vector tests will diverge from the BIR page here and that divergence is correct.

**(d) The ₱90,000 ceiling is applied to whatever is in one box, ignoring the period.**
`getTaxableBenefits()` compares `otherBenefitsNt` against 90,000 with no year-to-date awareness. In a monthly run this is only right if you feed the YTD total. Your implementation must maintain a **per-employee, per-taxable-year running balance** of 13th-month-and-other-benefits against the ₱90,000 statutory ceiling and push the excess into supplementary in the period it crosses over.

**(e) De minimis excess is left to the user.**
The tooltip instructs the operator to (1) total the excesses over each per-benefit ceiling, (2) deduct that from the _unused_ portion of the ₱90,000 ceiling, (3) type any remainder into "Other Taxable Supplementary". This is an obvious automation target and a real source of client error today. Model it as: per-benefit-type ceiling test → total excess → absorb into `90,000 − nonTaxable13thMonth` → remainder becomes taxable supplementary.

**(f) The MWE tooltip's "loses exemption" behaviour is legally questionable.**
The page states that if an MWE receives additional taxable compensation, "the withholding tax due will be automatically computed... based on the entire income earnings (both non-taxable and taxable)". The Supreme Court in _Soriano v. Secretary of Finance_ (G.R. No. 184450, 24 Jan 2017) struck down the RR 10-2008 provisions that disqualified MWEs from the SMW exemption when they earn other income — the SMW, holiday, OT, night-shift-differential and hazard pay of an MWE remain exempt; only the _additional_ income is taxable. **Flag for tax counsel before coding**; the calculator appears not to have been updated.

**(g) The "MWE ceiling" figures in the tooltip are not minimum wages.**
684.99 / 4,807.99 / 10,416.99 / 20,832.99 are simply the top of each table's 0% bracket. Actual MWE status is determined by the **DOLE regional wage order** for the employee's region. You need a regional SMW reference table keyed by region + effective date; you cannot derive it from the tax table.

**(h) Currency/precision.** The calculator uses JS floats. Use decimal arithmetic (`ROUND_HALF_UP`, 2dp) in the app. Note your schema is inconsistent: `journal_lines.debit/credit` are `decimal(20,8)` while `bills.amount` / `invoices.total` are `decimal(15,2)`.

### 2.6 Golden test vectors (computed from the extracted algorithm)

Use these as the first regression suite. Every one is reproducible by hand from §2.4.

| #   | Period       | Regular                                   | Supplementary      | Bracket      | Expected WT                                              |
| --- | ------------ | ----------------------------------------- | ------------------ | ------------ | -------------------------------------------------------- |
| A   | Monthly      | 30,000                                    | 0                  | 20,833 @15%  | **1,375.05**                                             |
| B   | Monthly      | 50,000                                    | 10,000 (OT)        | 33,333 @20%  | **7,208.40**                                             |
| C   | Semi-monthly | 20,000                                    | 5,000 (commission) | 16,667 @20%  | **2,604.10**                                             |
| D   | Daily        | 600                                       | 0                  | 0 @0%        | **0.00** (BIR page wrongly shows 600.00 — see §2.5c)     |
| E   | Annual       | 1,200,000                                 | 200,000            | 800,000 @25% | **252,500.00**                                           |
| F   | Monthly      | 20,833                                    | 500,000            | 20,833 @15%  | **75,000.00** (bracket quirk, §2.5b)                     |
| G   | —            | 13th month & other benefits input 120,000 | —                  | —            | non-taxable **90,000**, taxable supplementary **30,000** |

---

## 3. Corrections and 2026 deltas the calculator does not reflect

### 3.1 What is still current

- The five withholding tax tables in §2.4 — unchanged for 2026.
- The ₱90,000 ceiling on 13th month pay and other benefits — unchanged (NIRC §32(B)(7)(e) as amended by TRAIN).

### 3.2 De minimis benefits — the page is badly out of date

The calculator lists pre-2018 ceilings. The current ceilings come from **RR 29-2025, effective 6 January 2026** (which superseded RR 4-2025, effective 14 Feb 2025, which superseded RR 11-2018).

| De minimis benefit                               | RR 11-2018                 | RR 4-2025                 | **RR 29-2025 (current)** |
| ------------------------------------------------ | -------------------------- | ------------------------- | ------------------------ |
| Uniform and clothing allowance                   | ₱6,000/yr                  | ₱7,000/yr                 | **₱8,000/yr**            |
| Rice subsidy                                     | ₱2,000/mo                  | ₱2,000/mo                 | **₱2,500/mo**            |
| Medical cash allowance for dependents            | ₱1,500/sem                 | ₱1,500/sem                | **₱2,000/sem**           |
| Actual medical assistance                        | ₱10,000/yr                 | ₱10,000/yr                | **₱12,000/yr**           |
| Laundry allowance                                | ₱300/mo                    | ₱300/mo                   | **₱400/mo**              |
| Employee achievement awards                      | ₱10,000/yr (tangible only) | ₱10,000/yr (+ cash & GCs) | **₱12,000/yr**           |
| Christmas / major anniversary gifts              | ₱5,000/yr                  | ₱5,000/yr                 | **₱6,000/yr**            |
| Daily meal allowance (OT / night shift)          | 25% of basic minimum wage  | 25%                       | **30%**                  |
| CBA + productivity incentive benefits (combined) | ₱10,000/yr                 | ₱10,000/yr                | **₱12,000/yr**           |
| Monetized unused vacation leave (private)        | 10 days/yr                 | 10 days                   | **12 days/yr**           |
| Monetized VL/SL (government)                     | fully exempt               | fully exempt              | fully exempt             |

**Design implication:** these ceilings change roughly annually now. They must be **effective-dated reference data**, not constants in a TS file. A `de_minimis_ceilings` table keyed by `(benefit_type, effective_from, effective_to, limit_amount, limit_basis)` where `limit_basis ∈ {per_month, per_semester, per_year, pct_of_minimum_wage, days_of_leave}`.

### 3.3 Statutory contribution rates for 2026 (needed for §2.5a)

| Contribution | Rate    | Split          | Base / ceiling                                  |
| ------------ | ------- | -------------- | ----------------------------------------------- |
| SSS          | 15%     | ER 10% / EE 5% | MSC ceiling ₱35,000                             |
| PhilHealth   | 5%      | 2.5% / 2.5%    | floor ₱10,000, ceiling ₱100,000                 |
| Pag-IBIG     | 2% + 2% | ER 2% / EE 2%  | compensation ceiling ₱10,000 → capped ₱200 each |

Also effective-dated reference data. These change on their own schedule, independent of BIR.

### 3.4 eBIRForms package status

**Offline eBIRForms v7.9.6.0**, released 28 April 2026 under **RMC 036-2026**. Relevant changes:

- New **BIR Form 1701-MS** (Aug 2024 version) — simplified annual ITR for individuals classified as micro/small taxpayers (annual gross sales < ₱20M). E-filing enabled by RMC 037-2026.
- **Six new ATCs added to 1601-EQ**: `WI840`, `WC840`, `WI850`, `WC850`, `WI860`, `WC860`.
- **TIN branch code expanded from 3 digits to 5 digits across all returns.** ← This is a schema-affecting change. If you store a TIN as `NNN-NNN-NNN-NNN`, it is now `NNN-NNN-NNN-NNNNN`. Your `parties.taxId varchar(50)` is wide enough, but any parsing/validation/formatting logic must be built for 5.
- FCDU interest final withholding rate in 1602Q Schedule 1 corrected from 15% → 20% (TRAIN, effective 1 Jan 2025).
- Bug fixes to 0619E, 1601FQ, 1604F, 1702Q v2018C, 1702EX v2018, 1702MX v2018C, 1707 v2021, 2000-OT, 2551Q v2018.

### 3.5 EOPT Act (RA 11976) — affects your invoice model, not just tax

Effective with **RR 3-2024 (27 April 2024)**:

- **"Official Receipt" is gone as the primary VAT document for services.** Both goods and services are now evidenced by an **Invoice**. Your `invoices` table is already the right primitive — but the _document_ your app prints must be titled "Invoice", not "Official Receipt".
- **VAT on services moved from cash basis to accrual.** "Gross receipts" is replaced by "gross sales" for both goods and services. Output VAT is now recognised on invoicing, not on collection. This directly contradicts how most legacy PH accounting systems post service revenue and is a common source of double-counting during migration.
- Registration fee (₱500/yr, Form 0605) abolished.
- Filing/payment can be made at any RDO or AAB ("file anywhere").

### 3.6 CREATE MORE (RA 12066, signed 11 Nov 2024)

Mostly relevant to registered business enterprises in ecozones (SCIT vs Enhanced Deductions election from start of commercial operations). Low priority for an SMB bookkeeping product unless you target PEZA/BOI clients — but if you do, it changes the income tax and VAT-zero-rating treatment substantially.

---

## 4. The rest of the withholding universe (what the calculator omits)

This is the part that actually connects to `bills`, `invoices` and `parties`.

### 4.1 The four withholding regimes

| Regime                        | You are…                                   | Creditable?           | Monthly form                 | Quarterly form        | Annual form            | Certificate     |
| ----------------------------- | ------------------------------------------ | --------------------- | ---------------------------- | --------------------- | ---------------------- | --------------- |
| **Compensation (WTC)**        | employer                                   | credited on 1700/1701 | **1601-C**                   | —                     | **1604-C** + Alphalist | **2316**        |
| **Expanded (EWT/CWT)**        | payor of business income                   | yes, creditable       | **0619-E** (mos. 1–2 of qtr) | **1601-EQ** + **QAP** | **1604-E** + Alphalist | **2307**        |
| **Final (FWT)**               | payor of passive income                    | no, final             | **0619-F**                   | **1601-FQ**           | **1604-F** + Alphalist | **2306**        |
| **VAT / Percentage withheld** | government payor, or payor to non-resident | varies                | **1600-VT / 1600-PT**        | —                     | —                      | **2306 / 2307** |

Plus the taxes you owe in your own right: **2550Q** (quarterly VAT), **2551Q** (quarterly percentage tax), **1701Q/1701/1701A/1701-MS** (individual income tax), **1702Q/1702-RT/1702-MX/1702-EX** (corporate income tax), **1603Q** (fringe benefit tax), **2000/2000-OT** (documentary stamp tax).

### 4.2 Filing deadlines

| Form              | Covers                                  | Deadline                                                                                                       |
| ----------------- | --------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| 1601-C            | monthly compensation withholding        | 10th of the following month (eFPS: staggered by industry group; December return typically 15 Jan — **verify**) |
| 0619-E / 0619-F   | months 1 and 2 of each quarter          | 10th of the following month                                                                                    |
| 1601-EQ / 1601-FQ | the quarter                             | last day of the month following quarter close                                                                  |
| QAP               | attached to 1601-EQ                     | same as 1601-EQ                                                                                                |
| 2307              | the quarter                             | within **20 days** after quarter close (or on demand / on payment)                                             |
| 2306              | the quarter                             | on or before the 20th day after quarter close                                                                  |
| 2316              | the calendar year                       | **31 January** of the following year                                                                           |
| 1604-C            | the calendar year                       | **31 January**                                                                                                 |
| 1604-F            | the calendar year                       | **31 January**                                                                                                 |
| 1604-E            | the calendar year                       | **1 March**                                                                                                    |
| 2550Q             | the quarter                             | 25 days after quarter close                                                                                    |
| 2551Q             | the quarter                             | 25 days after quarter close                                                                                    |
| SAWT              | attached to the income tax / VAT return | with the return                                                                                                |

Treat every one of these as **data**, not as hard-coded constants — deadlines shift with holidays and BIR extensions, and eFPS staggering varies by industry group.

### 4.3 EWT rates for the transactions an SMB actually hits

Current rates under **RR 2-98 as amended by RR 11-2018**. `WI` = individual payee, `WC` = corporate/juridical payee.

| Nature of payment                                                                                     | Payee      | Condition                                                              | Rate      | ATC               |
| ----------------------------------------------------------------------------------------------------- | ---------- | ---------------------------------------------------------------------- | --------- | ----------------- |
| Professional / talent fees (lawyers, CPAs, engineers, doctors…)                                       | Individual | gross income ≤ ₱3M **and** sworn declaration filed                     | 5%        | `WI010`           |
| "                                                                                                     | Individual | > ₱3M, or VAT-registered regardless of amount, or no sworn declaration | 10%       | `WI011`           |
| "                                                                                                     | Juridical  | gross income ≤ ₱720,000                                                | 10%       | `WC010`           |
| "                                                                                                     | Juridical  | > ₱720,000                                                             | 15%       | `WC011`           |
| Management & technical consultants                                                                    | Individual | ≤ ₱3M / > ₱3M                                                          | 5% / 10%  | `WI050` / `WI051` |
| "                                                                                                     | Juridical  | ≤ ₱720K / > ₱720K                                                      | 10% / 15% | `WC050` / `WC051` |
| Directors' fees (non-employee)                                                                        | Individual | ≤ ₱3M / > ₱3M                                                          | 5% / 10%  | `WI090` / `WI091` |
| Rentals — real property, personal property > ₱10,000/yr, poles, satellites, billboards                | either     | —                                                                      | **5%**    | `WI100` / `WC100` |
| Cinematographic film rentals                                                                          | either     | —                                                                      | 5%        | `WI110` / `WC110` |
| Prime contractors / subcontractors                                                                    | either     | —                                                                      | **2%**    | `WI120` / `WC120` |
| Brokers & real estate service practitioners                                                           | Individual | ≤ ₱3M / > ₱3M                                                          | 5% / 10%  | `WI139` / `WI140` |
| Income distribution to beneficiaries of estates & trusts                                              | Individual | —                                                                      | 15%       | `WI130`           |
| Payment to partners of a GPP                                                                          | Individual | ≤ ₱720K / > ₱720K                                                      | 10% / 15% | `WI152` / `WI153` |
| Commissions/rebates to independent & exclusive distributors, medical/technical/sales reps (incl. MLM) | Individual | ≤ ₱3M / > ₱3M                                                          | 5% / 10%  | `WI515` / `WI516` |
| **Top Withholding Agent → local supplier of GOODS**                                                   | either     | —                                                                      | **1%**    | `WI158` / `WC158` |
| **Top Withholding Agent → local supplier of SERVICES**                                                | either     | —                                                                      | **2%**    | `WI160` / `WC160` |
| Government → local supplier of goods                                                                  | either     | —                                                                      | 1%        | `WI640` / `WC640` |
| Government → local supplier of services                                                               | either     | —                                                                      | 2%        | `WI157` / `WC157` |
| Credit card companies → any business entity                                                           | either     | 1% of **one-half** of gross                                            | 1% × ½    | `WI156` / `WC156` |
| Agricultural products, cumulative > ₱300,000/yr                                                       | either     | —                                                                      | 1%        | `WI610` / `WC610` |
| Minerals, mineral products, quarry resources                                                          | either     | —                                                                      | 5%        | `WI630` / `WC630` |
| Political parties / candidates — campaign purchases                                                   | either     | —                                                                      | 5%        | `WI680` / `WC680` |

**Critical correctness rules for the engine:**

1. **The EWT base is the amount NET of VAT.** For a ₱112,000 VAT-inclusive service bill, 2% EWT is ₱2,000 (on ₱100,000), not ₱2,240.
2. **The 5%-vs-10% individual professional split is gated on a Sworn Declaration of Gross Receipts/Sales** filed by the payee with the payor by **15 January** of each year (or before first payment). No declaration on file → you must withhold the higher rate. This is a per-payee, per-year piece of state that must live in the party tax profile with an expiry.
3. **VAT registration overrides the threshold** for individuals: a VAT-registered individual is 10% regardless of gross income.
4. **TWA status is an org-level designation** published by the BIR (thresholds: ₱12M gross sales/purchases for RDO groups A & B, ₱5M for C, D, E). It commences on the first day of the month following BIR publication. Model it as an effective-dated org flag; a non-TWA private company does **not** withhold 1%/2% on ordinary purchases.
5. **`WI640`/`WC640` and `WI157`/`WC157` are GOVERNMENT codes.** A private TWA must use `WI158`/`WC158` and `WI160`/`WC160`. This is one of the most common filing errors in the wild — worth an explicit validation rule.

**Sourcing warning:** the widely-circulated `cneilmon/ph_bir_atc` SQL dataset on GitHub was downloaded and inspected — it is **pre-TRAIN** and wrong in ways that matter (`WI010` at 10% with a ₱720K threshold, `WC212` dividends at 30%, `WF360` FBT at 32%). Useful as a skeleton of code _structure_, unusable as rates. Source the authoritative catalog from the eBIRForms package's own ATC dropdowns or the RR text, and version it.

### 4.4 VAT and percentage tax

- **VAT rate 12%.** Registration threshold: gross sales/receipts > **₱3,000,000** in any 12-month period.
- Below the threshold: **3% percentage tax** under §116 (this reverted from the CREATE-era 1% on 1 July 2023), **or** the **8% election** — 8% on gross sales/receipts and other non-operating income in excess of ₱250,000, _in lieu of_ both the graduated income tax and the 3% percentage tax, available to self-employed individuals and professionals with gross ≤ ₱3M.
- **Input VAT is creditable only if the buyer is VAT-registered.** For a non-VAT org, input VAT is part of the cost of the purchase and must be folded into the expense/asset, not booked to an Input VAT account. Your tax engine must branch on org VAT status.
- Input VAT attributable to VAT-exempt sales must be allocated and charged to expense rather than credited (RR 16-2005 §4.110-4). Advanced; defer, but design the data model so the allocation is expressible.
- Input VAT on capital goods > ₱1M is **no longer amortised** (amortisation ended 31 Dec 2021) — fully creditable in the month of purchase. Only historical data needs the deferred treatment.

---

## 5. Mapping to the buwiz-books chart of accounts

### 5.1 What exists today

Reviewed: `src/db/schema/accounts.ts`, `src/db/schema/account-constants.ts`, `src/db/schema/journals.ts`, `src/db/schema/parties.ts`, `src/db/schema/bills.ts`, `src/db/schema/invoices.ts`, `src/lib/coa/*`, `src/lib/{bill,invoice,bank}-mapping-config.ts`.

**Good foundations:**

- 8 account types × fixed subtype whitelist (`SUBTYPES_BY_TYPE`), compile-time checked.
- Hierarchical `accounts` with `parentId`, 5-digit numbering with type ranges.
- Presets-as-code with a planner (`plan-preset.ts`) and a mapping-completeness guarantee.
- `category_mappings` + `MAPPING_CONFIGS` registry with `isMappingTargetCompatible` type enforcement — **this is exactly the right seam for tax control accounts.**
- Double-entry `journal_headers` / `journal_lines` with per-line party and dimensions.

**Gaps that block BIR compliance:**

| Gap                                                                       | Where                       | Why it blocks                                                                                                                 |
| ------------------------------------------------------------------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| No tax fields on bills at all                                             | `bills`, `bill_line_items`  | Cannot record input VAT or EWT withheld on a purchase                                                                         |
| `invoices.taxAmount` is a single header scalar                            | `invoices`                  | 2550Q needs a breakdown by VATable / zero-rated / exempt / sales-to-government; a single number cannot produce it             |
| Only one tax account in the invoice mapping (`sales_tax_payable`)         | `invoice-mapping-config.ts` | VAT needs Output VAT (liability) **and** Input VAT (asset) — at minimum                                                       |
| `parties` has US tax model (`is1099Vendor`, generic `taxId`)              | `parties.ts`                | No TIN + 5-digit branch code, RDO, registered name, taxpayer classification, VAT status, sworn-declaration state, default ATC |
| No employee/payroll tables                                                | —                           | 1601-C, 2316, 1604-C impossible                                                                                               |
| No tax period / filing / certificate tables                               | —                           | Cannot close a period, cannot issue 2307/2316, cannot reconcile a control account to a form total                             |
| `journal_headers.functionalCurrency` defaults `"USD"`                     | `journals.ts`               | Must be PHP for PH orgs                                                                                                       |
| `journal_lines` at `decimal(20,8)` vs `bills/invoices` at `decimal(15,2)` | —                           | Rounding drift between subledger and GL                                                                                       |
| No `payroll_expenses` granularity, no `taxes` liability subtype           | `account-constants.ts`      | Tax payables currently fall into `other_current_liabilities` alongside everything else                                        |

### 5.2 The core design principle

> **A tax is not a category. A tax is an attribute of a transaction line that resolves to a control account.**

Concretely:

- The **COA** carries a small, fixed set of **control accounts** — where balances live. ~20 of them.
- A separate **`tax_codes`** table carries the _rules_ — rate, base (gross vs net-of-VAT), ATC, form, direction, effective dates — and points at a control account.
- A **`transaction_taxes`** table records, per bill/invoice/journal line, which tax code applied, the base, and the computed amount. This is what feeds QAP, SAWT, 2307 and the alphalists. **A GL balance alone can never produce these** — they need per-payee, per-ATC detail.
- Resolution of `tax code → control account` goes through your existing `category_mappings` registry with a new `mappingType: "tax"`, so it inherits type-compatibility enforcement, per-org overrides, the preset planner's completeness check and the "how many rows are unmapped" indicator for free.

This is a one-member addition to `MAPPING_TYPES` and one new `MappingConfig` — not a parallel system.

### 5.3 Mapping the calculator's fields to accounts

This is the direct answer to "how do we map this to a category". Employer's books, per payroll period.

| BIR calculator field                                 | Bucket                | GL nature           | Proposed account                                   |
| ---------------------------------------------------- | --------------------- | ------------------- | -------------------------------------------------- |
| Basic Salary                                         | Taxable regular       | **Expense** Dr      | 61110 Basic Salary — Regular                       |
| Representation Allowance                             | Taxable regular       | Expense Dr          | 61161 Representation Allowance                     |
| Transportation Allowance                             | Taxable regular       | Expense Dr          | 61162 Transportation Allowance                     |
| Cost of Living Allowance                             | Taxable regular       | Expense Dr          | 61163 Cost of Living Allowance                     |
| Fixed Housing Allowance                              | Taxable regular       | Expense Dr          | 61164 Housing Allowance                            |
| Other Taxable Regular Compensation                   | Taxable regular       | Expense Dr          | 61190 Other Taxable Regular Compensation           |
| Commission                                           | Taxable supplementary | Expense Dr          | 61170 Commissions & Incentives                     |
| Profit Sharing                                       | Taxable supplementary | Expense Dr          | 61180 Profit Sharing                               |
| Fees including Director's Fee                        | Taxable supplementary | Expense Dr          | 61175 Directors' Fees — Employees                  |
| Taxable 13th Month & Other Benefits (derived)        | Taxable supplementary | Expense Dr          | 61220 Other Bonuses & Benefits                     |
| Hazard Pay                                           | Taxable supplementary | Expense Dr          | 61150 Hazard Pay                                   |
| Overtime Pay                                         | Taxable supplementary | Expense Dr          | 61120 Overtime Pay                                 |
| Other Taxable Supplementary                          | Taxable supplementary | Expense Dr          | 61195 Other Taxable Supplementary Compensation     |
| Basic Salary / SMW (MWE)                             | Non-taxable           | Expense Dr          | 61115 Basic Salary — MWE                           |
| Holiday Pay (MWE)                                    | Non-taxable           | Expense Dr          | 61135 Holiday & Premium Pay — MWE                  |
| Overtime Pay (MWE)                                   | Non-taxable           | Expense Dr          | 61125 Overtime Pay — MWE                           |
| Night Shift Differential (MWE)                       | Non-taxable           | Expense Dr          | 61145 Night Shift Differential — MWE               |
| Hazard Pay (MWE)                                     | Non-taxable           | Expense Dr          | 61155 Hazard Pay — MWE                             |
| 13th Month & Other Benefits (≤ ₱90,000)              | Non-taxable           | Expense Dr          | 61210 13th Month Pay                               |
| De Minimis Benefits                                  | Non-taxable           | Expense Dr          | 61230 De Minimis Benefits                          |
| **SSS / GSIS / Pag-IBIG + union dues (EE share)**    | Non-taxable           | **Liability Cr** ⚠️ | 25110 / 25120 / 25130 / 25160                      |
| Salaries & Other Forms of Compensation (non-taxable) | Non-taxable           | Expense Dr          | 61320 Retirement/Separation Benefits — Non-Taxable |
| Other Non-Taxable/Exempt Compensation                | Non-taxable           | Expense Dr          | 61240 Other Exempt Compensation                    |
| **Your Withholding Tax for the Period** (output)     | —                     | **Liability Cr**    | 25140 Withholding Tax Payable — Compensation       |

⚠️ The SSS/PhilHealth/Pag-IBIG box is the one line that is **not an expense**. It is an amount deducted from the employee's gross pay and held for remittance — a liability. Only the **employer's** share is an expense (61610/61620/61630). Getting this backwards inflates payroll expense and understates liabilities; it is the most common error in hand-built PH payroll journals.

### 5.4 Proposed COA additions

Designed to fit the existing numbering, avoiding all numbers already in use across `src/lib/coa/presets/*.ts`. Delivered as a **new `philippines_smb` preset** (`CoaPresetId` union gets a member), expressed as a diff on `BASE_ACCOUNTS`.

**Assets (claims against the BIR)**

| #     | Name                                                       | Type  | Subtype                |
| ----- | ---------------------------------------------------------- | ----- | ---------------------- |
| 12500 | Creditable Withholding Tax Receivable (Form 2307 received) | asset | `other_current_assets` |
| 12600 | Input VAT                                                  | asset | `other_current_assets` |
| 12610 | ⤷ Input VAT — Goods                                        | asset | `other_current_assets` |
| 12620 | ⤷ Input VAT — Services                                     | asset | `other_current_assets` |
| 12630 | ⤷ Input VAT — Capital Goods                                | asset | `other_current_assets` |
| 12640 | ⤷ Deferred Input VAT (legacy, pre-2022 amortisation)       | asset | `other_current_assets` |
| 12700 | Prepaid / Excess Income Tax — Carryover                    | asset | `prepaid_expenses`     |

**Liabilities (owed to the BIR)**

| #     | Name                                                                                                                 | Type      | Subtype                     |
| ----- | -------------------------------------------------------------------------------------------------------------------- | --------- | --------------------------- |
| 21500 | **Output VAT Payable** _(repurposes the existing "Sales Tax Payable" key so the invoice mapping resolves unchanged)_ | liability | `other_current_liabilities` |
| 21510 | ⤷ Output VAT — Regular Sales (12%)                                                                                   | liability | `other_current_liabilities` |
| 21520 | ⤷ Output VAT — Sales to Government                                                                                   | liability | `other_current_liabilities` |
| 21530 | VAT Payable — Net (2550Q settlement)                                                                                 | liability | `other_current_liabilities` |
| 21600 | BIR Withholding Taxes Payable                                                                                        | liability | `other_current_liabilities` |
| 21610 | ⤷ Withholding Tax Payable — Expanded (0619-E / 1601-EQ)                                                              | liability | `other_current_liabilities` |
| 21620 | ⤷ Withholding Tax Payable — Final (0619-F / 1601-FQ)                                                                 | liability | `other_current_liabilities` |
| 21630 | ⤷ Withholding VAT Payable (1600-VT)                                                                                  | liability | `other_current_liabilities` |
| 21640 | ⤷ Withholding Percentage Tax Payable (1600-PT)                                                                       | liability | `other_current_liabilities` |
| 21650 | ⤷ Fringe Benefit Tax Payable (1603Q)                                                                                 | liability | `other_current_liabilities` |
| 21700 | Percentage Tax Payable (2551Q)                                                                                       | liability | `other_current_liabilities` |
| 21800 | Income Tax Payable (1701 / 1702 series)                                                                              | liability | `other_current_liabilities` |
| 21900 | Documentary Stamp Tax Payable (2000 / 2000-OT)                                                                       | liability | `other_current_liabilities` |

**Payroll liabilities — children of the existing 25100**

| #     | Name                                                | Type      | Subtype               |
| ----- | --------------------------------------------------- | --------- | --------------------- |
| 25110 | SSS Contributions Payable (EE + ER)                 | liability | `payroll_liabilities` |
| 25120 | PhilHealth Contributions Payable (EE + ER)          | liability | `payroll_liabilities` |
| 25130 | Pag-IBIG Contributions Payable (EE + ER)            | liability | `payroll_liabilities` |
| 25140 | **Withholding Tax Payable — Compensation (1601-C)** | liability | `payroll_liabilities` |
| 25150 | SSS / Pag-IBIG Loan Repayments Payable              | liability | `payroll_liabilities` |
| 25160 | Union Dues Payable                                  | liability | `payroll_liabilities` |
| 25170 | Net Pay Payable                                     | liability | `payroll_liabilities` |
| 25180 | 13th Month Pay Payable (accrual)                    | liability | `payroll_liabilities` |

25140 sits under Payroll Liabilities for payroll-report coherence, and is _tagged_ as the 1601-C control account by the tax mapping registry — position in the tree and role in a form are different concerns.

**Expenses — children of the existing 61000 Payroll Expenses**

| #           | Name                                                                                                                      |
| ----------- | ------------------------------------------------------------------------------------------------------------------------- |
| 61110       | Basic Salary — Regular                                                                                                    |
| 61115       | Basic Salary — Minimum Wage Earner (non-taxable)                                                                          |
| 61120       | Overtime Pay                                                                                                              |
| 61125       | Overtime Pay — MWE (non-taxable)                                                                                          |
| 61130       | Holiday & Premium Pay                                                                                                     |
| 61135       | Holiday & Premium Pay — MWE (non-taxable)                                                                                 |
| 61140       | Night Shift Differential                                                                                                  |
| 61145       | Night Shift Differential — MWE (non-taxable)                                                                              |
| 61150       | Hazard Pay                                                                                                                |
| 61155       | Hazard Pay — MWE (non-taxable)                                                                                            |
| 61161–61164 | Representation / Transportation / COLA / Housing Allowance                                                                |
| 61170       | Commissions & Incentives                                                                                                  |
| 61175       | Directors' Fees — Employees                                                                                               |
| 61180       | Profit Sharing                                                                                                            |
| 61190       | Other Taxable Regular Compensation                                                                                        |
| 61195       | Other Taxable Supplementary Compensation                                                                                  |
| 61210       | 13th Month Pay                                                                                                            |
| 61220       | Other Bonuses & Benefits                                                                                                  |
| 61230       | De Minimis Benefits                                                                                                       |
| 61240       | Other Exempt Compensation                                                                                                 |
| 61310       | Retirement / Separation Benefits — Taxable                                                                                |
| 61320       | Retirement / Separation Benefits — Non-Taxable                                                                            |
| 61610       | SSS Contribution — Employer Share _(under the existing 61600, renamed "Employer Statutory Contributions" in this preset)_ |
| 61620       | PhilHealth Contribution — Employer Share                                                                                  |
| 61630       | Pag-IBIG Contribution — Employer Share                                                                                    |
| 61640       | SSS Employees' Compensation (EC) — Employer Share                                                                         |

**Other expenses — children of the existing 94000 Taxes**

| #     | Name                                                  |
| ----- | ----------------------------------------------------- |
| 94100 | Taxes & Licenses (BIR registration, LGU permits, DST) |
| 94200 | Fringe Benefit Tax Expense                            |
| 94300 | Income Tax Expense — Current                          |
| 94400 | Percentage Tax Expense                                |

_(94500 is already used by another preset — avoid.)_

**Subtype additions to consider** in `account-constants.ts`: a `tax_liabilities` subtype under `liability` would make BIR payables filterable without name-matching. Optional but cheap, and it removes a real ambiguity — `other_current_liabilities` currently carries Other Current Liabilities, Uncategorized Liabilities and Sales Tax Payable, which is exactly the "three accounts, one subtype" problem `base-mappings.ts` already warns about.

### 5.5 New tax mapping config

Add `"tax"` to `MAPPING_TYPES` and register a `TAX_MAPPING_CONFIG` whose rows are the control accounts:

| sourceKey                | ledgerType    | default account |
| ------------------------ | ------------- | --------------- |
| `output_vat`             | liability     | 21500           |
| `input_vat`              | asset         | 12600           |
| `vat_payable`            | liability     | 21530           |
| `ewt_payable`            | liability     | 21610           |
| `fwt_payable`            | liability     | 21620           |
| `wtc_payable`            | liability     | 25140           |
| `cwt_receivable`         | asset         | 12500           |
| `percentage_tax_payable` | liability     | 21700           |
| `income_tax_payable`     | liability     | 21800           |
| `fbt_payable`            | liability     | 21650           |
| `sss_payable`            | liability     | 25110           |
| `philhealth_payable`     | liability     | 25120           |
| `pagibig_payable`        | liability     | 25130           |
| `net_pay_payable`        | liability     | 25170           |
| `taxes_and_licenses`     | other_expense | 94100           |

`isMappingTargetCompatible` then prevents anyone from pointing "Output VAT" at an asset account, the same way it already prevents pointing "Default Expense" at a revenue account.

### 5.6 Journal entry recipes

**(a) Payroll, one period**

```
Dr  Basic Salary, OT, allowances, etc.        (61110…61195)      gross taxable
Dr  13th Month Pay / De Minimis               (61210 / 61230)    non-taxable comp
Dr  SSS / PhilHealth / Pag-IBIG — ER share    (61610…61640)      employer cost
    Cr  Withholding Tax Payable — Compensation   (25140)
    Cr  SSS Contributions Payable                (25110)         EE + ER
    Cr  PhilHealth Contributions Payable         (25120)         EE + ER
    Cr  Pag-IBIG Contributions Payable           (25130)         EE + ER
    Cr  Union Dues Payable                       (25160)
    Cr  Net Pay Payable                          (25170)
```

**(b) Vendor bill, VAT-registered supplier, 2% contractor EWT.** Services ₱100,000 + 12% VAT = ₱112,000; EWT 2% of the **VAT-exclusive** ₱100,000 = ₱2,000; net payable ₱110,000.

```
Dr  Professional Fees / COGS / etc.           (6xxxx)            100,000.00
Dr  Input VAT — Services                      (12620)             12,000.00
    Cr  Accounts Payable                         (21000)         110,000.00
    Cr  Withholding Tax Payable — Expanded       (21610)           2,000.00
```

→ generates a `transaction_taxes` row: `{atc: WC120, base: 100000, amount: 2000, direction: withheld_by_us, payee: <vendor>}`, which is what feeds QAP and the vendor's 2307.

If the org is **not VAT-registered**, there is no 12620 line — the ₱12,000 is folded into the expense (₱112,000 Dr).

**(c) Customer invoice where the customer is a TWA and withholds 2%.** Sale ₱100,000 + VAT ₱12,000; customer remits ₱110,000 and hands over a 2307.

```
On issue:
Dr  Accounts Receivable                       (12000)            112,000.00
    Cr  Sales Revenue                            (41000)         100,000.00
    Cr  Output VAT Payable                       (21500)          12,000.00

On collection:
Dr  Bank                                      (11000)            110,000.00
Dr  Creditable Withholding Tax Receivable      (12500)             2,000.00
    Cr  Accounts Receivable                      (12000)         112,000.00
```

→ 12500 is later applied against 21800 Income Tax Payable on the 1701Q/1702Q, with **SAWT** attached listing each 2307.

**(d) Quarterly VAT settlement (2550Q)**

```
Dr  Output VAT Payable                        (21500)
    Cr  Input VAT                                (12600)
    Cr  VAT Payable — Net                         (21530)
```

**(e) Remittance of any withholding**

```
Dr  Withholding Tax Payable — Expanded / Compensation / Final
    Cr  Bank
```

**The reconciliation invariant that makes this whole design worth it:** for any period, the **movement in each control account must equal the total on the corresponding return**. `Δ21610 for Q1 == 1601-EQ Q1 total tax withheld == Σ QAP rows == Σ 2307s issued`. Build this as an automated check in the filing workspace; it catches essentially every classification error before it reaches the BIR.

---

## 6. Schema changes required

Sketch only — shapes, not migrations.

```
org_tax_profiles       org_id, tin, branch_code(5), rdo_code, registered_name,
                       taxpayer_classification (micro|small|medium|large),
                       vat_status (vat|non_vat|exempt), vat_registration_date,
                       is_top_withholding_agent, twa_effective_from,
                       income_tax_regime (graduated|8pct|corporate),
                       fiscal_year_end, accounting_method, efps_enrolled

party_tax_profiles     party_id, tin, branch_code(5), rdo_code, registered_name,
                       address_for_bir, payee_type (individual|corporate|gpp|government|
                       cooperative|tax_exempt), vat_status,
                       default_atc, sworn_declaration_year, sworn_declaration_filed_at,
                       tax_exemption_ruling_ref
                       -- supersedes parties.is1099Vendor for PH orgs

tax_codes              org_id (nullable → system), code, kind (vat_output|vat_input|ewt|
                       fwt|wtc|percentage|fbt|dst), name, rate,
                       base_rule (gross|net_of_vat|half_of_gross),
                       atc, form_code, direction (payable|receivable),
                       control_account_mapping_key,
                       effective_from, effective_to, is_system

tax_code_rules         tax_code_id, payee_type, vat_status_required,
                       requires_sworn_declaration, gross_income_threshold,
                       threshold_direction (lte|gt), priority
                       -- drives automatic rate selection (5% vs 10% etc.)

transaction_taxes      id, org_id, source_type (bill_line|invoice_line|journal_line|
                       payroll_line), source_id, tax_code_id, atc,
                       party_id, base_amount, tax_amount, direction, tax_period_id

tax_periods            org_id, form_code, period_type (monthly|quarterly|annual),
                       period_start, period_end, due_date,
                       status (open|computing|computed|filed|paid|amended),
                       filed_at, reference_no, amount_due, amount_paid

tax_filings            tax_period_id, form_code, form_version, payload jsonb,
                       computed_totals jsonb, generated_files jsonb, checksum

tax_certificates       type (2307|2306|2316), org_id, serial_no, payor_party_id,
                       payee_party_id, period_start, period_end,
                       lines jsonb (atc, base, rate, amount), pdf_url,
                       issued_at, acknowledged_at

employees              party_id (partyType='employee') + employment_status,
                       date_hired, date_separated, is_mwe, region_code,
                       pay_frequency, is_substituted_filing_eligible,
                       previous_employer_2316 jsonb

payroll_runs           org_id, period_type, period_start, period_end, pay_date, status
payroll_lines          payroll_run_id, employee_id, per-bucket amounts,
                       computed WT, YTD accumulators, journal_header_id

reference_tax_tables   table_name (wt_compensation|de_minimis|sss|philhealth|pagibig|
                       smw_by_region), effective_from, effective_to, payload jsonb
                       -- everything effective-dated, nothing hard-coded
```

Also required:

- `MAPPING_TYPES` gains `"tax"`; new `TAX_MAPPING_CONFIG`; `MAPPING_CONFIGS` gains the entry (one line, per the registry's own docstring).
- Tax fields on `bill_line_items` and `invoice_line_items`: `taxCodeId`, `taxTreatment` (vatable | zero_rated | exempt | not_subject), `withholdingTaxCodeId`, `taxBaseAmount`, `taxAmount`, `withholdingAmount`.
- `invoices`: replace the single `taxAmount` scalar with a per-line breakdown; retain a cached header total.
- Default `journal_headers.functionalCurrency` to the org's currency, not `"USD"`.
- Align money precision between subledger and GL.

---

## 7. Implementation plan

### Phase 0 — Decisions and foundations (blocking)

Answer the open questions in §8. Add `org_tax_profiles`. Set PHP as functional currency. Establish decimal money handling (`ROUND_HALF_UP`, 2dp) and a single rounding utility. Establish the effective-dated `reference_tax_tables` pattern.

### Phase 1 — Chart of accounts

Ship the `philippines_smb` preset (§5.4). Add `"tax"` to `MAPPING_TYPES` + `TAX_MAPPING_CONFIG` (§5.5). Optionally add the `tax_liabilities` subtype. Extend the existing preset invariant tests to cover it — every tax mapping row must resolve to an account of the right type in a freshly created PH org.
**Deliverable:** a new PH org gets a BIR-shaped chart out of the box; no posting logic yet.

### Phase 2 — Tax code engine (pure, no posting)

`tax_codes` + `tax_code_rules` + `party_tax_profiles`. Rate resolution: given (payee type, VAT status, sworn declaration on file, YTD gross, nature of payment) → tax code + ATC + rate + base. Seed the ~25 high-frequency EWT codes from §4.3, not all 200+.
**Deliverable:** `resolveWithholding(payment) → {atc, rate, base, amount}`, fully unit-testable with no DB.

### Phase 3 — Purchase side (highest client value)

Tax fields on bills. Input VAT and EWT computed on bill entry, posted per §5.6(b). **Form 2307 generation** (PDF, per vendor per quarter). **0619-E** and **1601-EQ + QAP** computation and export.
**Deliverable:** a bookkeeper can enter a bill and the app produces the vendor's 2307 and the quarter's QAP.

### Phase 4 — Sales side

Per-line VAT treatment on invoices (VATable / zero-rated / exempt / government). Output VAT posting. **Inbound 2307 capture** → CWT Receivable (12500) — a strong fit for your existing document/OCR pipeline. **2550Q** computation. **SAWT** generation.
**Deliverable:** VAT return produced from the ledger; received 2307s tracked as an asset and applied to income tax.

### Phase 5 — Payroll and compensation

Employee records. Statutory contribution engine (SSS/PhilHealth/Pag-IBIG, effective-dated). De minimis ceiling engine with the ₱90,000 absorption logic. The withholding calculator (§2.3–2.4) with the periodic estimator **and** the annualised true-up. **1601-C**, **2316**, **1604-C** + Alphalist.
**Deliverable:** run payroll → posted journal → monthly 1601-C → year-end 2316 and alphalist.

### Phase 6 — Remaining regimes

Final withholding (0619-F, 1601-FQ, 1604-F, 2306). Percentage tax (2551Q). Income tax (1701Q/1701/1701A/**1701-MS**/1702Q/1702 series) with CWT application. Fringe benefit tax (1603Q). DST (2000).

### Phase 7 — Filing workspace

A period-close screen per form: compute → **reconcile control account movement against form total** (§5.6) → lock the period → export → record filing reference and payment. Deadline calendar driven by data. Amendment handling.
**Deliverable:** the reconciliation invariant is enforced before anything can be marked filed.

### Phase 8 — BIR interop

**There is no public eBIRForms API.** The realistic integration surface is:

1. **Export files the BIR's own tools ingest** — `.DAT` files for QAP, SAWT and the alphalists, produced to the published technical specification and validated through BIR's **Alphalist Data Entry and Validation Module** before emailing to `esubmission@bir.gov.ph`. This is the highest-leverage deliverable in the whole project and it is _file generation_, not API integration.
2. **Printable BIR-format PDFs** for 2307, 2306, 2316 and the returns themselves.
3. **Pre-filled field maps** so a user can key the offline eBIRForms package quickly, or paste from a CSV.
4. **eFPS** — only for enrolled taxpayers; still no sanctioned programmatic path.
5. **Accreditation**, if you want to go further:
   - **CAS Acknowledgment Certificate** — under RMC 5-2021 a Permit to Use is no longer required; taxpayers using a Computerized Accounting System notify and register with their RDO/LT Office and receive an Acknowledgment Certificate. Your _clients_ need this to use buwiz-books as their books of account. Shipping a "CAS registration pack" (system description, sample reports, sample invoices) is a genuine product feature.
   - **eTSPCert** — the Electronic Tax Software Provider Certification system (expanded by RMC 64-2021) is the route if buwiz-books itself wants to be a certified e-filing/e-payment provider or do electronic invoicing/receipting. Long lead time; treat as a separate business track, not an engineering phase.

### Testing strategy

- **Golden vectors** from §2.6 for the compensation engine, plus a differential harness: the extracted BIR algorithm is small enough to reimplement verbatim as a _reference oracle_, then property-test your production implementation against it across random inputs, asserting equality **except** at the documented divergences (daily zero-bracket bug, gross-vs-net basic salary, YTD-aware ₱90k ceiling).
- **Reconciliation tests**: for a generated set of bills/invoices, assert `Δ control account == Σ transaction_taxes == form total`.
- **Effective-date tests**: a payroll run dated 2025-12-31 must use the RR 4-2025 de minimis ceilings; the same run dated 2026-01-06 must use RR 29-2025.

---

## 8. Open questions — answer these before Phase 1

1. **Scope of client base.** VAT-registered corporations, non-VAT sole proprietors on the 8% option, or both? This decides whether input VAT is an asset or folded into cost, and whether percentage tax exists at all. It also decides how many presets you ship.
2. **Is buwiz-books doing payroll, or importing it?** Phase 5 is the largest phase by far. If clients run payroll in Sprout/PayrollHero/Salarium, you may only need to _import_ the payroll register and post the journal + produce 1601-C. That is a fraction of the work and probably the right first move.
3. **Regular-only vs total-taxable bracketing** (§2.5b) — confirm with tax counsel which your engine should implement as the default, and whether it should be configurable per client.
4. **MWE treatment after _Soriano_** (§2.5f) — confirm the intended behaviour.
5. **Multi-entity / branch.** The 5-digit TIN branch code change (§3.4) suggests BIR expects branch-level filing. Does your `business_groups` model need to carry a BIR branch code per entity, and do returns file per branch?
6. **How far into filing do you go?** "Compute and export" (low risk, fast) vs "file on the client's behalf" (needs eTSPCert, PoA, and a very different liability posture).
7. **Historical data.** Do clients migrate mid-year? If so you need opening YTD accumulators per employee (for the ₱90k ceiling and the annualisation) and opening balances in every control account.

---

## 9. Verify before building

Facts below were sourced from secondary commentary rather than the primary regulation text. They are load-bearing for the engine and should be confirmed against the RR/RMC text or with your tax counsel:

- The exact 1601-C December deadline and the eFPS staggered-filing schedule by industry group.
- The current rate and ATC for "interest income from other debt instruments not within the coverage of deposit substitutes" — sources disagree between 15% (creditable, RR 11-2018) and 20% (final).
- The MERALCO refund and meter-deposit ATC rates post-RR 11-2018 — sources disagree (25%/32% vs 15%/20%). Low priority unless a client is affected.
- The six new 1601-EQ ATCs added in eBIRForms 7.9.6.0 (`WI840`/`WC840`/`WI850`/`WC850`/`WI860`/`WC860`) — descriptions and rates were not published in the commentary; read them out of the package itself.
- The published `.DAT` technical specification for QAP, SAWT and the alphalists — get it from BIR Downloadables alongside the Validation Module rather than reverse-engineering.
- Whether the ₱3,000,000 VAT threshold has been indexed (the NIRC provides for periodic adjustment).

---

## Sources

**Primary artifacts (downloaded and read in full)**

- [BIR Withholding Tax Calculator (HTML)](https://web-services.bir.gov.ph/tax_calculator/wt_calculator.html)
- [BIR Withholding Tax Calculator (computation engine, JS)](https://web-services.bir.gov.ph/tax_calculator/js/wt_calculator.js)
- [BIR Form 1601-EQ (Jan 2019 ENCS)](https://bir-cdn.bir.gov.ph/local/pdf/1601-EQ%20January%202019%20ENCS%20final.pdf)
- [BIR Form 2307 (Jan 2018 ENCS v3)](https://bir-cdn.bir.gov.ph/local/pdf/2307%20Jan%202018%20ENCS%20v3.pdf)
- [RMC No. 64-2021 — expanding the eTSPCert System](https://bir-cdn.bir.gov.ph/local/pdf/RMC%20No.%2064-2021.pdf)
- [BIR Downloadables — Alphalist Data Entry and Validation Module](https://www.bir.gov.ph/Downloadables)
- [RR No. 24-2025 digest](https://bir-cdn.bir.gov.ph/BIR/pdf/RR%20No.%2024-2025%20Digest%20FINAL.pdf)
- [RR No. 14-2018 (amending RR 11-2018) — Supreme Court E-Library](https://elibrary.judiciary.gov.ph/thebookshelf/showdocs/2/90308)
- [EOPT Act flyer (BIR)](https://bir-cdn.bir.gov.ph/BIR/pdf/flyer-eopt.pdf)

**De minimis benefits**

- [KPMG — Philippines: Increased Non-Taxable Limits for Employee De Minimis Benefits (RR 29-2025)](https://kpmg.com/xx/en/our-insights/gms-flash-alert/2026/flash-alert-2026-014.html)
- [Grant Thornton — Amendments to De Minimis Benefits (RR 4-2025)](https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/amendments-to-de-minimis-benefits-uniform-and-clothing-allowance-and-employee-achievement-awards/)
- [IHRI — BIR Issues RR 029-2025](https://ihri.ph/birnewdeminimis/)
- [BusinessMirror — Expanded de minimis benefits and what employers must know](https://businessmirror.com.ph/2026/01/06/expanded-de-minimis-benefits-and-what-employers-must-know/)

**Withholding tax rates, ATCs and forms**

- [Forvis Mazars — Withholding Taxes in the Philippines](https://www.forvismazars.com/ph/en/insights/tax-alerts/withholding-taxes-in-the-philippines-transactions)
- [Taxumo — List of BIR ATC for Income Tax Filing and Withholding Tax](https://www.taxumo.com/blog/list-of-bir-atc-for-income-tax-filing-and-withholding-tax/)
- [Orkids — Withholding Tax Philippines: Rates, Forms & Deadlines 2026](https://orkids.ph/guides/withholding-tax-philippines)
- [Tax and Accounting Center — How to File BIR Form 1601-EQ](https://taxacctgcenter.ph/how-to-file-bir-form-1601-eq/)
- [eFPS — BIR Form 1601EQ Guidelines and Instructions](https://efps.bir.gov.ph/efps-war/EFPSWeb_war/forms2018Version/1601EQ/1601eq_guidelines.html)
- [Grant Thornton — BIR Revises Withholding Tax Rates for Top Withholding Agents](https://www.grantthornton.com.ph/insights/articles-and-updates1/tax-notes/bir-revises-withholding-tax-rates-for-top-withholding-agents/)
- [`cneilmon/ph_bir_atc`](https://github.com/cneilmon/ph_bir_atc) — **pre-TRAIN, do not use for rates**

**Compensation withholding tables (2026 confirmation)**

- [Sprout Solutions — How to Calculate Withholding Tax in the Philippines: 2026 Guide](https://sprout.ph/articles/how-to-calculate-withholding-tax-philippines/)
- [KAMI Workforce — BIR Withholding Tax on Compensation: 2026 TRAIN Law Tables](https://kamiworkforce.com/ph/blog/bir-withholding-tax-compensation-2026/)

**Statutory contributions**

- [KAMI Workforce — SSS, PhilHealth and Pag-IBIG Contribution Tables 2026](https://kamiworkforce.com/ph/blog/sss-philhealth-pagibig-contribution-tables-2026/)
- [Taxumo — BIR Tax Table and Contributions for 2026](https://www.taxumo.com/blog/bir-tax-table-2026/)

**eBIRForms and EOPT / CREATE MORE**

- [Taxify — eBIRForms v7.9.6.0 Update (RMC No. 036-2026)](https://taxify.ph/blog/ebirforms-v7960-update-rmc-036-2026/)
- [Tax and Accounting Center — 7 New VAT Rules under the EOPT Act](https://taxacctgcenter.ph/new-vat-rules-ease-of-paying-taxes-act-ra-11976-philippines/)
- [Grant Thornton — Implementation of EOPT amendments on VAT and Percentage Tax](https://www.grantthornton.com.ph/alerts-and-publications/technical-alerts/tax-alert/2024/implementation-of-the-amendments-introduced-by-eopt-act-on-vat-and-percentage-tax/)
- [Grant Thornton — CREATE MORE Act (RA 12066)](https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/the-create-more-act-ra-12066-a-new-chapter-for-tax-incentives-and-economic-development-in-the-philippines/)
- [Grant Thornton — EOPT on Computerized Accounting System (CAS)](https://www.grantthornton.com.ph/insights/articles-and-updates1/lets-talk-tax/eopt-on-computerized-accounting-system-cas-to-secure-or-not-to-secure-new-acknowledgment-certificate/)

**Alphalist / DAT submission**

- [Sprout Solutions — How to Submit BIR Form 1604-C and Alphalist in 2026](https://sprout.ph/articles/first-time-bir-1604c-alphalist-filing-guide/)
- [DataOn — Complete Guide to BIR Alphalist Submission](https://dataon.ph/blog/bir-alphalist-guide/)

**Reviewed in-repo**

- `src/db/schema/{accounts,account-constants,journals,parties,bills,invoices}.ts`
- `src/lib/coa/{preset-types,mapping-types,mapping-registry}.ts`, `src/lib/coa/presets/{base,base-mappings}.ts`
- `src/lib/{bill,invoice}-mapping-config.ts`
- `COA/README.md`, `COA/types.md`, `COA/subtypes/Subtypes.md`
