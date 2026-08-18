# BIR Tax Subsystem — Implementation Plan

**Date:** 2026-08-16
**Supersedes:** Part D (Sequencing) of [DECISIONS.md](DECISIONS.md). Parts A–C of that document stand, amended by §4 below.
**Basis:** 19 agents across two passes — 5 primary-source research tracks, 4 codebase audits, 3 decision panels, 4 design tracks, 3 adversarial reviews. All three reviews returned `significant_gaps`; 15 blockers were found and are resolved or carried below.

**Owner inputs, 2026-08-16:**

- No committed Philippine customers. This is a market-entry bet.
- Target segment: **all four** — sole proprietors/8%, accounting firms with mixed books, labour-heavy SMBs, service/professional firms.
- **Commit to the narrow January 2027 slice**, targeting end of November 2026.

---

## 1. The finding that dissolves the client-mix question

I asked you to choose between EWT-first and payroll-first based on your client mix. **The completeness reviewer showed that was the wrong variable, and the answer is the same for every mix.**

> Slipping Stage 3b costs one quarter, and the client keeps filing 1601-EQ the way they already do — it recurs four times a year and nothing is lost permanently. Slipping Stage 5 costs twelve months, because 2316 and 1604-C are annual with a 31 January statutory date. And structurally, **Stage 5 has no dependency edge on 3a or 3b at all** — it needs the reference spine, the compensation engine, the period machine and the encoder. Putting 3a and 3b on the critical path in front of a date-driven stage that does not depend on them is the ordering defect, not the mix.

So: **payroll precedes EWT unconditionally.** Your answer of "all four segments" is a statement about the destination, not the first release, and it does not change the order. Your client mix only affects how much of Stage 3b ships in Q1 2027.

Your January commitment is also, independently, what the reviewer recommended as the fix for the schedule being unreachable:

> If that still does not fit, descope Stage 5 to the two artifacts with the hard date — 2316 and the 1604-C `.DAT` — and defer 1601-C, the refund workflow and the verifier UI to a Stage 5b.

That is exactly the slice you picked.

**One caveat, stated once.** You have no committed customers, so 31 January 2027 is _your_ marketing date, not a client's compliance obligation. Missing it costs a market-entry moment, not a penalty. That asymmetry should govern every trade-off below: **if Stage 1's shape is at risk, slip January rather than compromise the spine.** Getting the reference-data model wrong is a defect you carry for the life of the product; missing a marketing window is a defect you carry for twelve months.

---

## 2. The insight that makes November credible

The reviewer's verdict on the original ordering was blunt:

> Stage 5 cannot be usable by November 2026 on the ordering in Part D. That is roughly 13 weeks, and ahead of it: Stage 0 (2–3 engineer-weeks, +1,700/−960 LOC across the nine highest-traffic write paths), Stage 0.5, Stage 1 (33+ tables, 19 RLS blocks), Stage 2, Stage 3a, Stage 3b, Stage 4.

The way out is not compression. It is that **2316 and 1604-C do not touch the general ledger.**

Both are computed from the payroll register, the YTD accumulators, the previous-employer 2316, and reference data. Neither reads a journal line. So the January slice can ship as a **ledger-independent compliance module**, and that removes Stage 0, Stage 3a, Stage 3b and most of Stage 1 from the critical path:

| Original predecessor        | Needed for the January slice?                                                                                                                                                             |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Stage 0 — ledger hardening  | **No.** It is a prerequisite for anything that _posts_. The January slice does not post                                                                                                   |
| Stage 0.5 — `.DAT` VM spike | **Yes.** The 1604-C alphalist is a `.DAT` file                                                                                                                                            |
| Stage 1 — reference spine   | **Partly.** Withholding tables, de minimis, SSS/PhilHealth/Pag-IBIG, SMW, `org_tax_profiles`, `party_tax_profiles`. **Not** `tax_codes`, `transaction_taxes`, VAT tables, or anything EWT |
| Stage 2 — pure engine       | **The compensation half only.** Not the EWT rate resolver                                                                                                                                 |
| Stage 3a / 3b               | **No**                                                                                                                                                                                    |
| Stage 4 — filing workspace  | **Minimal subset**: period state machine, encoder, immutable snapshot. Not the deadline engine, not reconciliation                                                                        |

**The architectural risk this creates, and its mitigation.** A ledger-independent module can become an island that never integrates. Mitigation: build Stage 5a on the _real_ payroll data model — `payroll_runs`, `payroll_lines`, `payroll_employee_year_state`, `previous_employer_2316` — with posting simply absent. Stage 5b then adds the journal, it does not rewrite the module. **Do not build a throwaway import-and-print path.**

This runs **Stage 0 in parallel** rather than in front. Stage 0 is pure bug-fix value to your existing non-PH customers with no Philippine dependency (see §6), so parallelising it costs nothing in scope and removes 2–3 weeks from the critical path.

---

## 3. Frozen before any code is written

Three reviews independently found that the four design tracks collide on concrete artifacts. This is the largest single class of blocker and it is **cheap to fix now and expensive to fix after the first `is_control` trigger fires on live data.**

### 3.1 The PH chart is frozen here

Two tracks assigned `12600` to different accounts; three tracks disagreed on whether `25140` is Pag-IBIG Payable or Withholding Tax on Compensation Payable — and Track 4's entire reconciliation identity was written against the wrong one. Track 1's numbering was the only claim any reviewer could reproduce exactly (`grep -ho 'accountNumber: "[0-9]*"' src/lib/coa/presets/*.ts | sort -n | uniq` — every number below is genuinely free across all four shipped presets). **Track 1's numbering wins.**

| #     | Name                                        | Type          | Subtype                     | Parent      | Stage |
| ----- | ------------------------------------------- | ------------- | --------------------------- | ----------- | ----- |
| 12600 | Creditable Withholding Tax Receivable       | asset         | `other_current_assets`      | Assets      | 3a    |
| 12610 | Creditable VAT Withheld                     | asset         | `other_current_assets`      | Assets      | 6     |
| 12700 | Employee Advances & Receivables             | asset         | `other_current_assets`      | Assets      | 5b    |
| 12800 | Employee Receivable — Tax Advanced          | asset         | `other_current_assets`      | Assets      | 5b    |
| 13800 | Input VAT                                   | asset         | `other_current_assets`      | Assets      | 3b    |
| 13810 | Input VAT — Unpaid Payables                 | asset         | `other_current_assets`      | 13800       | 3b †  |
| 21600 | Expanded Withholding Tax Payable            | liability     | `other_current_liabilities` | Liabilities | 3b    |
| 21700 | Output VAT                                  | liability     | `other_current_liabilities` | Liabilities | 6     |
| 21710 | Output VAT — Uncollected Receivables        | liability     | `other_current_liabilities` | 21700       | 6     |
| 21750 | VAT Payable — Net                           | liability     | `other_current_liabilities` | Liabilities | 6     |
| 21800 | Percentage Tax Payable                      | liability     | `other_current_liabilities` | Liabilities | 7     |
| 25110 | **Withholding Tax on Compensation Payable** | liability     | `payroll_liabilities`       | 25100       | 5b    |
| 25120 | SSS Contributions Payable                   | liability     | `payroll_liabilities`       | 25100       | 5b    |
| 25130 | PhilHealth Contributions Payable            | liability     | `payroll_liabilities`       | 25100       | 5b    |
| 25140 | **Pag-IBIG (HDMF) Contributions Payable**   | liability     | `payroll_liabilities`       | 25100       | 5b    |
| 25170 | Net Pay Payable                             | liability     | `payroll_liabilities`       | 25100       | 5b    |
| 25175 | Employee Tax Refund Payable                 | liability     | `payroll_liabilities`       | 25100       | 5b    |
| 61950 | Unrecovered Employee Tax                    | expense       | `payroll_expenses`          | 61000       | 5b    |
| 68400 | Input VAT Attributable to Exempt Sales      | expense       | `general_operations`        | 68000       | 6     |
| 94100 | Percentage Tax Expense                      | other_expense | `taxes`                     | 94000       | 7     |

† `13810` moves from Stage 6 to Stage 3b — see blocker B10.

**Reserved bands** (no non-PH preset may use them): `12600–12699`, `12700–12899`, `13800–13899`, `21600–21999`, `25110–25199`, `61900–61999`, `68400–68499`, `94100–94199`.

**No account ships before Stage 3a.** The January slice does not post, so it creates none of these. The freeze exists to stop the collision, not to ship a chart.

**Every other document and every code path references these by preset key (`ph_wtc_payable`, `ph_input_vat`, …), never by number.** Ship `tests/unit/lib/coa/ph-chart-lock.test.ts` asserting the exact `(key → number, name, type, subtype, stage)` tuple set, and `ph-number-reservation.test.ts` asserting no other preset intrudes on a reserved band. A divergence becomes a red build rather than a migration on live data.

**No new liability subtype.** The fail-loud direct-FK resolver never consults subtype, so the many-to-one hazard `base-mappings.ts:3-9` warns about is structurally unreachable. Adding one would cost four coordinated edits plus a failing cash-flow test in `report-calculations.ts` for no gain.

### 3.2 One owner per artifact

Three tracks each claimed `drizzle/0034_*.sql`. `tax_codes` was defined three incompatible ways; `tax_filing_snapshots` twice, with _behaviourally opposite_ immutability (a `CREATE RULE ... DO INSTEAD NOTHING` that silently succeeds on cascade-delete versus a `BEFORE UPDATE OR DELETE ... RAISE EXCEPTION` that aborts it).

| Artifact                                 | Owner       | Resolution                                                                                                                 |
| ---------------------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------------------- |
| `drizzle/0034_ledger_hardening.sql`      | Stage 0     | Highest existing is `0033_projection_reconciliation.sql`                                                                   |
| `drizzle/0035_tax_reference_core.sql`    | Stage 1     |                                                                                                                            |
| `drizzle/0036_payroll_compliance.sql`    | Stage 5a    |                                                                                                                            |
| `src/db/schema/tax-codes.ts`             | Stage 3b    | **Effective-dated form**, per D1's mandatory `asOf`. But see B11 — `rate_bps` and `atc` are removed                        |
| `src/lib/tax/resolve-control-account.ts` | Stage 3a    | `resolveTaxControlAccount(db, orgId, key, asOf)`, throws with a typed `reason`                                             |
| `scripts/seed-tax-reference.ts`          | Stage 1     | Single seeder, all reference tables                                                                                        |
| `tax_de_minimis_ceilings`                | Stage 1     | Bitemporal, `dataset_version` in the PK                                                                                    |
| Filing attempt / snapshot                | Stage 4-min | One `tax_filing_runs` + one `tax_filing_snapshots`, **`BEFORE UPDATE OR DELETE ... RAISE EXCEPTION`**, never the RULE form |
| `filing_deadline_overrides`              | Stage 4     | **Global, no `organization_id`**                                                                                           |

---

## 4. Amendments to DECISIONS.md forced by review

| Ref        | Change                                                                                                                                          |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| **Part D** | Superseded by §5 below. Payroll precedes EWT unconditionally; the client-mix tiebreaker is withdrawn                                            |
| **D-N1**   | Stage 0 remains a hard prerequisite **for anything that posts a journal**. It is not a prerequisite for the January slice, and runs in parallel |
| **D2**     | Add: the Stage 5a data model is the real payroll model with posting absent, not a throwaway import path                                         |
| **D-N12**  | Unchanged in substance, but all three reviews noted the same gap: **no human is named.** Name one before Stage 1                                |
| **U7**     | ✅ Closed 2026-08-17 — annexes retrieved and verified; see B3                                                                                   |

---

## 5. The plan

Two tracks running in parallel. The January track carries the date; the foundation track carries everything after it.

```
        Aug            Sep            Oct            Nov            Dec          Jan '27
JANUARY  ├─0.5─┤├──── 1-cut ────┤├─── 2-comp ───┤├─ 4-min ─┤├─ 5a ─┤├ onboard ┤├─ FILE ─┤
TRACK     spike   reference spine   compensation    encoder   2316 +   client     season
                  (payroll only)      engine        + period  1604-C    YTD

FOUNDATION      ├──────── 0 ────────┤              ├──── 0 cont. ────┤├─ 3a ─┤├─── 3b ───┤
TRACK            ledger hardening                   (parallel, no PH dep)  2307   EWT/QAP
```

### Stage 0.5 — the `.DAT` empirical spike · half a day · **do this first**

Install BIR Alphalist Data Entry and Validation Module 7.4 on a Windows VM. Key two dummy payees — one with a comma and one with `ñ` in the registered name. Save. Hex-dump the output in the `eAlpha` folder.

Resolves the single remaining blocking unknown: **text-field quoting**, line terminator, encoding, empty-field handling, numeric padding. RMC 5-2014 establishes "CSV data file format" but no BIR document states whether text fields are double-quoted — and `REGISTERED_NAME` and `NATURE_INCOME` are 50-char free text that can legitimately contain commas.

**Why it cannot wait:** a wrong quoting rule does not fail loudly. It parses into **shifted fields** — wrong amounts against wrong payees, loaded into the BIR data warehouse, invisible until an assessment.

Isolate all five unknowns behind one configuration object so the result is a one-line change.

### Stage 1-cut — reference spine, payroll subset · ~4 weeks

Ships: the bitemporal effective-dated reference core `(natural key, dataset_version, effective_from)` with mandatory `asOf` lookups; `org_tax_profiles` and `org_tax_branches` as sidecar tables modelled on `organization_secrets`; `party_tax_profiles`; and these reference tables only —

- Withholding tax tables — **both Annex D (2018-01-01 → 2022-12-31) and Annex E (2023-01-01 →)**, see B3
- De minimis ceilings — bitemporal, with the three limit shapes (peso / day-count / % of regional SMW), the eligibility-form dimension, and an uncapped case
- SSS (45-row MSC table, three programs, employer-only EC at ₱10/₱30), PhilHealth (5%, floor ₱10,000, ceiling ₱100,000, Monthly Basic Salary base), Pag-IBIG (EE 1% ≤ ₱1,500 / 2% above, ER 2%, ₱200 cap)
- Regional SMW by `(region, sector, establishment_size_band, effective tranche)` with `last_verified_at`

**Explicitly deferred out of Stage 1:** `tax_codes`, `tax_code_rules`, `transaction_taxes`, `tax_certificates`, `bir_certificate_serials`, every VAT table, `filing_deadline_overrides`. The reviewer's cut — "drop them until their consumer stage" — is adopted.

Also ships the reference-data governance mechanism: seeded TypeScript catalog → `ON CONFLICT DO NOTHING` seeder → reviewed numbered migration for any change → wiring test, mirroring the existing `review-rule-catalog` precedent. **Name the owner.**

### Stage 2-comp — the compensation engine · ~3 weeks · pure, no persistence

Two named methods behind one dispatcher:

- **Regular** — bracket on regular compensation only (RR 11-2018 §2.79(B) Step 3)
- **Cumulative average** — Steps 1–5, bracketing on the cumulative average of regular **+** supplementary, including prior-employer figures, less tax already withheld YTD

Three trigger predicates evaluated every run, latched irreversibly per `(employee, calendar_year)`. The de minimis engine: eleven independent per-type ceilings, per-type YTD accumulation, **aggregation** into other benefits (RMC 50-2018 A5 — not ordered absorption), then the ₱90,000 ceiling applied to the total. Annualization with three outcomes.

Golden vectors: RR 11-2018 Illustrations 6–15, **run at an `asOf` inside 2018–2022** (see B3). Differential harness against a verbatim BIR-algorithm oracle, asserting equality only where method is `regular` and documented divergence elsewhere.

### Stage 4-min — encoder, period machine, snapshot · ~2 weeks

The declarative per-`(formCode, scheduleNum)` layout registry with `EXPECTED_FIELD_COUNTS`, explicit 1-based positions, and field-name order goldens. Both reviewers named this the strongest part of the design — a future RR becomes a seeded row plus a numbered migration rather than a code change.

Period state machine `open → computed → filed → amended`, and the immutable checksummed as-filed snapshot with the reference-dataset version stamped.

Not in scope: the deadline engine, the reconciliation invariant (nothing posts yet), certificates beyond 2316.

### Stage 5a — the January slice · ~4 weeks · **the date**

- Payroll register import (buwiz Excel template primary, vendor column-mapping secondary)
- Opening YTD intake + `previous_employer_2316` as a **blocking** precondition
- Annualization
- **2316 PDF** per employee
- **1604-C alphalist `.DAT`** (D1 is 49 fields, D2 is 59)
- Blocking pre-flight: banned characters with explicit logged Ñ→N transliteration, missing-TIN hard block, no lumped payee rows

Deferred to **5b**: 1601-C monthly, the refund/true-up posting, the variance verifier UI, and all journal posting.

**The real deadline is earlier than November.** Opening YTD and previous-employer 2316 data must be captured from each client _before that client's December payroll run_. Client onboarding is the constraint, not code completion. Budget December for it.

### Foundation track — Stage 0, in parallel · 2–3 engineer-weeks

Nine posting sites consolidated into one service per document type; the dead `invoice-journal.ts` fork deleted and its test repointed; one money type (BigInt scale 8) through one balance check; deferred DB constraint trigger for debits==credits on posted headers; posted journals amend-by-reversal; bill-void fixed (it both voids the header **and** posts a mirrored reversal — a double removal — and skips the period lock every sibling path checks); `functionalCurrency` backfilled and passed explicitly; `effectiveDate` threaded through payment paths.

**This ships as pure bug-fix value to your existing non-PH customers.** Reports are wrong today for any org that has voided a bill.

Requires first building `tests/utils/tx-fixture.ts` — `tests/utils/db-utils.ts` is 23 lines returning a raw pool with no transaction isolation, and a `DEFERRABLE INITIALLY DEFERRED` constraint cannot be tested under savepoints.

**Also needs a data-repair pass no design track covered:** bills already voided under the double-removal semantic have historical periods understated by the reversal amount. Survey and repair before those periods are ever used for a filing.

### After January

| Stage  | Content                                                                                                                         |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| **5b** | Payroll journal posting, 1601-C, refund/true-up postings, the variance verifier                                                 |
| **3a** | Received-2307 capture → CWT Receivable → SAWT. The `form_2307_ocr` task is four mechanical edits to a well-factored AI registry |
| **3b** | Purchase-side EWT, 2307 issuance, 0619-E, 1601-EQ + QAP                                                                         |
| **4**  | Full filing workspace: reconciliation invariant, deadline engine, amendment flow                                                |
| **6**  | Sales-side VAT, 2550Q, SLSP, EOPT uncollected-receivable machinery                                                              |
| **7**  | Non-VAT / 8%: 2551Q, 1701Q, ₱3M threshold monitor                                                                               |

### Segment coverage over time

You asked for all four. Here is when each is actually served:

| Segment                     | Jan 2027             | +5b             | +3a                          | +3b          | +6     | +7          |
| --------------------------- | -------------------- | --------------- | ---------------------------- | ------------ | ------ | ----------- |
| Labour-heavy SMB            | ✅ 2316 + 1604-C     | ✅ full payroll |                              |              | ✅ VAT |             |
| Accounting firm, mixed book | ✅ the January wedge | ✅              | ✅                           | ✅           | ✅     | ✅ complete |
| Service / professional firm | partial              |                 | ✅ received 2307s            | ✅ EWT + QAP | ✅     |             |
| Sole prop / 8%              | —                    | —               | ✅ **most of their product** | —            | —      | ✅ complete |

Sole proprietors are served last on this ordering and get almost everything they need from Stage 3a alone. If that segment turns out to matter more than the January bet, **3a is the cheapest pivot available** — three accounts, one journal leg, one AI task — and it can be pulled forward at any point without disturbing the January track.

---

## 6. Blockers carried into implementation

Fifteen blockers were found. Five are resolved above (§3). The remaining ten must be fixed in the stage that owns them.

| #       | Stage | Blocker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------- | ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **B1**  | 0     | **Stage 0's bulk-recategorise guard queries `tax_codes`, which Stage 1 creates.** In Stage 0 that raises `relation "tax_codes" does not exist` and 500s bulk recategorise for every existing non-PH org — a backward stage dependency. Fix: inject `taxControlAccountIds: ReadonlySet<string>` from a stub returning empty; Stage 3b replaces the stub body                                                                                                                                                                                                                                                                                                                                                                    |
| **B2**  | 1     | **`drizzle-kit push --force` hangs a non-TTY deploy on brand-new tables.** `deploy.yml:238-242` documents this verbatim, and the repo's own answer was `scripts/apply-ai-foundation.ts` running _before_ the push. The tax migration must create tables in raw SQL **before** `drizzle-kit push`, not after. Fails only in production — `db:fresh` drops the schema first. Add `expect(wf.indexOf('tax_foundation')).toBeLessThan(wf.indexOf('drizzle-kit push'))` to the wiring test                                                                                                                                                                                                                                          |
| **B3**  | 1, 2  | ✅ **CLOSED 2026-08-17.** Both generations seeded and verified cell-for-cell against the primary annex PDFs (`bir-cdn.bir.gov.ph/local/pdf/Annex D RR 11-2018.pdf` and `.../Annex E RR 11-2018.pdf`). The earlier failure was a URL path — `/BIR/pdf/` now 403s while `/local/pdf/` serves fine; bare `Annex D.pdf` resolves to an unrelated Bacolod procurement template. Illustration vectors run at 2018 as-of dates, and the annex-selection guard asserts the same inputs at 2026 differ. Also established: the annexes are built by different rules — D by exact annual division, E by a bracket chain off its own printed floors                                                                                        |
| **B4**  | 2     | ✅ **CLOSED 2026-08-17**, and the prescribed fix was itself half wrong. The calendar position is _never_ the rule — it merely coincides in Illustration 12 because that employee’s prior employment ran unbroken from January, which is why the wrong reading survives casual checking. Divisor = `previousEmployer.periodsCovered + periods paid here`, in **both** branches; the two readings diverge across an employment gap (the RR’s own Mr. Gerry: prior employer Jan–May, hired 1 July, June unemployed → 6 periods, calendar index 7). Two further corrections the blocker did not name: Step 2 must round the average half-up to 2dp (Illustration 12 prints 215,000 ÷ 7 as 30,714.29), and Step 4 must not re-round |
| **B5**  | 1     | **The RLS coverage test as specified red-builds the repo.** 11 existing org-scoped tables have no policy at all (`organization_secrets` and `financial_account_secrets` among them — a live cross-tenant exposure independent of this work), and 49 of 68 are absent from the FORCE array. Ship the test with a pre-populated `EXEMPT` map of exactly those pre-existing names, each with a reason and a tracking issue, and assert `Object.keys(EXEMPT).length` never grows. A ratchet on new tables, not a retroactive audit                                                                                                                                                                                                 |
| **B6**  | 3a    | **Output VAT will post to `21500 Sales Tax Payable`, not `21700`.** `resolveTaxPayableAccount` at `-invoices.ts:518` resolves the `invoice/sales_tax_payable` mapping, which `base-mappings.ts:59` points at `21500` — inherited by the PH preset. `21700` stays at zero forever and the Stage-6 2550Q reconciliation permanently false-fails. Fix in the stage that introduces `21700`: add a PH mapping override, and add a preset test asserting every jurisdiction-scoped preset's mapping targets resolve to accounts that preset actually creates                                                                                                                                                                        |
| **B7**  | 3b    | **Crediting A/P net of EWT while `bills.balanceDue` stays gross leaves every withheld bill permanently part-paid.** `bills` has no tax column and no track added one. A ₱112,000 bill with ₱10,000 EWT credits A/P ₱102,000; the user disburses ₱102,000; `balanceDue` = ₱10,000 and status stays `partial` forever. Fix: `bills.ewt_amount` and `bills.input_vat_amount` as first-class columns, `balanceDue` derived from them                                                                                                                                                                                                                                                                                               |
| **B8**  | 3b    | **New per-line tax fields must be added to `createBill`'s `idempotencyPayloadHash` in the same commit.** Otherwise two submissions differing only in tax code hash identically and the second is silently suppressed as a replay (`-bills.ts:387-401`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **B9**  | 3b    | **Name the authoritative bill posting path.** Bills reach the GL via two independent routes — the inbox `transaction_candidate` from `createBill` (`-bills.ts:513`) and the accrual journal from `transitionBillStatus` (`-bills.ts:685`). Tax wired into one produces two divergent journals for the same bill                                                                                                                                                                                                                                                                                                                                                                                                                |
| **B10** | 3b    | **Input VAT on services claimed at billing is the taxpayer-_aggressive_ reading, mislabelled as the safe default.** RR 13-2018 §4.110-3(c) says input tax on services is creditable "upon payment." Claiming it early is a deficiency assessment with 25% surcharge. The design deferred the offset account `13810` to Stage 6, leaving **no representable conservative treatment** in between. Fix: ship `13810` in the same stage as `13800`, and gate the leg behind a `vat_input_recognition_basis ∈ (billing, payment)` defaulted to `payment` for service purchases until counsel rules (DECISIONS U4)                                                                                                                   |
| **B11** | 3b    | **`tax_codes.rate_bps` is per-org and written only at preset-apply time, so a national rate change never reaches an org that already onboarded.** Delete `rate_bps` and `atc` from the org-scoped table; rates and ATCs belong in the **global** effective-dated `tax_code_rules` / `bir_atc_catalog`. `tax_codes` carries only `(organization_id, tax_code_key, control_account_id)`                                                                                                                                                                                                                                                                                                                                          |

---

## 7. Gaps no design track covered

Not blockers for the January slice, but each needs an owner before its consumer stage.

**Document-line tax columns** — three tracks consume them and none designs them. `bill_line_items.vat_attribution ∈ (vatable, exempt, common)` for the item-53 allocation; `taxTreatment ∈ (vatable, zero_rated, exempt)` on invoice lines; `line.intent ∈ (wholesale, own_use, retail, unknown)` for the RR 24-2025 carve-out. Neither `bills.ts` nor `invoices.ts` appears in any files-touched list, and no track specifies the UI that sets them.

**Tax settings and party-tax UI** — ~45 tables and a filing workspace were designed; **no screens** that populate `org_tax_profiles`, `org_tax_branches`, `org_tax_registrations`, `org_tax_year_elections` or `party_tax_profiles`. Every downstream gate reads data with no entry point. _This one bites Stage 5a_ — the 2316 employer block reads `org_tax_profiles`.

**Bill OCR TIN capture** — DECISIONS A7 called it the cheapest win in the plan and no track built it. The prompt already asks for TINs; the schema discards them.

**SLSP / RELIEF** — mandatory for all VAT-registered taxpayers with no threshold (RR 1-2012), and reporting a sale as "various" forfeits the EOPT output-VAT credit. Named in a form catalog and nowhere else.

**EOPT uncollected-receivable regime** — the mandatory printed credit term, the 2550Q items 35/36/55/58 machinery, and the buyer-side input-VAT reversal. Listed as an opening-intake requirement, modelled in no table.

**₱3M threshold-breach automation** — called "the single most valuable automation in a PH SMB bookkeeping product," and explicitly not built. On mid-year breach, income tax reverts to graduated for the whole year, percentage tax becomes due retroactively from 1 January on quarters already filed as 8%-exempt, and VAT registration is prospective only.

**Also missing:** Form 1606 as a filing object; the payor-side Annex C sworn-declaration obligation; deferred input VAT on pre-2022 capital goods (2550Q items 39/52); 2550Q purchase-type classification (items 44/45/46/48/49); withholding VAT on non-resident payments (1600-VT, MAP, 2306); surcharge/interest/compromise computation — `taxpayer_classification` is stored and never read; credit notes and purchase/sales returns after an EWT accrual; business cessation and short-period final returns; organization deletion when filed periods exist (the FK graph aborts, and relaxing it destroys the as-filed snapshots that D-N5 makes the sole evidence, against NIRC §235's ten-year retention); transitional and presumptive input tax on becoming VAT-registered — which the Stage 7 threshold monitor is designed to _cause_; a producer for `tax_filing_periods` — the D-N4 lock axis has no code path that inserts a row; **a CAS-registration flag or warning**, when registering buwiz-books as a client's CAS is itself the RR 11-2025 e-invoicing trigger.

---

## 8. What can slip, and what cannot

**Cannot slip:**

- The chart freeze and schema ownership (§3). Both are free now and require a migration on live data later. The `is_control` trigger blocks renumber, retype and reparent — the wrong choice is unrecoverable without a reviewed migration.
- Stage 0.5. Half a day, gates the encoder, and the failure mode is silent field-shifting.
- B3 (Annex D + E). Getting this wrong corrupts the live table for every client.
- The Stage 1 reference-data _shape_. Booleans where timelines belong is the error that propagates into every return the product will ever produce.

**Can slip, at known cost:**

- January itself. You have no committed customers; the cost is a marketing moment. **Prefer this to compromising Stage 1.**
- Stage 0. It is parallel and independent. It becomes blocking only at Stage 5b.
- Everything after January.

**The honest risk on November.** Four workstreams in roughly fourteen weeks, with Stage 1 the widest and least compressible. Client onboarding for opening YTD data must happen in December, before each client's December payroll run. If Stage 1 runs long, the fallback is not to compress Stage 2 — the cumulative average method is mandatory, not optional — it is to move the target to the **2028** season and spend 2027 on 3a/3b/6/7, which work all year round rather than one month.

---

## 9. Open items requiring a human

| Item                                                                                                                   | Who                                                                                                                                                                                        |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Name the reference-data owner** (D-N12)                                                                              | ✅ **Resolved 2026-08-16** — the owner, backed by a monthly AI sweep. See §10.1                                                                                                            |
| **Stage 0.5 VM experiment**                                                                                            | ✅ **Assigned 2026-08-16** — owner-run, fully scripted. Wizard pack: [dat-spike-wizard.md](dat-spike-wizard.md)                                                                            |
| **U2** — WI710/WC710: regulation says 20%, BIR's own form says 15%, eBIRForms enforces 15%, no amending issuance found | Tax counsel, before Stage 3b                                                                                                                                                               |
| **U4** — input VAT on services at billing or payment                                                                   | Tax counsel, before Stage 3b. B10 makes the conservative default representable in the meantime                                                                                             |
| ~~**U7** — retrieve RR 11-2018 Annex D and Annex E directly~~                                                          | ✅ **Done 2026-08-17.** Both retrieved from `bir-cdn.bir.gov.ph/local/pdf/`; all 48 sub-annual constants verified and independently re-derived. Closes document request D1 for the annexes |
| **U10** — ₱90,000 ceiling: accrual or receipt basis                                                                    | Tax counsel, before Stage 5a's accumulator                                                                                                                                                 |
| **U6** — RR 29-2025 publication date (6 Jan 2026 is derived, not sourced)                                              | Before it becomes a hard effective-date boundary                                                                                                                                           |
| **U11** — no 2026 BIR Tax Calendar located; deadlines anchored to 2025                                                 | One manual check before Stage 4                                                                                                                                                            |

---

## 10. Owner decisions — 2026-08-16

Recorded from the owner's answers. These close §9's first two rows and formalize §8's slip preference.

**10.1 Reference-data owner: the owner, backed by a monthly AI sweep.** A scheduled monthly sweep scans the BIR RR/RMC issuance indexes, big-4 PH tax alerts, NWPC wage orders and SSS/PhilHealth/Pag-IBIG circulars, diffs findings against the seeded catalog, and files a digest under `docs/tax/reference-watch/`. The owner reviews (~30 min/month); every accepted change lands as a reviewed numbered migration; `last_verified_at` updates on review. The sweep is the legwork; the owner is the named backstop.

**10.2 `.DAT` spike: owner-run, fully scripted.** Wizard pack at [dat-spike-wizard.md](dat-spike-wizard.md). The results form feeds the single encoder configuration object from Stage 0.5 — a one-line change once known. If the module refuses the comma or the `ñ` at data entry, that refusal **is** a result: record the exact error text.

**10.3 Slip rule — pre-committed, spine wins.**

> IF Stage 1-cut is not merged by ~10 Oct 2026, OR the compensation engine is not green against RR 11-2018 Illustrations 6–15 (at an Annex D `asOf`) by ~31 Oct 2026,
> THEN January retargets to the 2028 season with no further debate; Stage 3a is pulled forward as the cheapest pivot; 2027 is spent on 3b → 6 → 7.
>
> Never cut, regardless of date pressure: the Stage 1 reference-data shape, Annex D+E dual seeding (B3), and the withholding-method latch (B4). The cumulative-average method is mandatory law, not scope.

**10.4 Implementation begins now.** PR 1 = chart-lock + number-reservation tests (the §3.1 freeze becomes executable). PR 2 = reference-core schema + `asOf` lookup + seeder + governance wiring, with the migration wired **pre-push** per B2. PR 3 = Stage 0 start (`tx-fixture.ts`, then posting-site consolidation). Side deliverables: the wizard pack and the tax-counsel question pack ([tax-counsel-questions.md](tax-counsel-questions.md)).

---

## 11. Build status — 2026-08-17

Thirteen commits on `feat/ph-tax-reference-core`. 1427 unit tests, 17 integration
tests, `bun check` clean.

### Shipped

| Stage  | What landed                                                                                                                                                                                                                                                                                                     |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **1**  | Bitemporal reference core with mandatory `asOf` lookups; `org_tax_profiles`, `org_tax_branches`, `party_tax_profiles`; both withholding annexes and all 33 de minimis ceilings, primary-verified; seeder wired through every build path with a wiring test                                                      |
| **2**  | The full compensation engine — segregation, both statutory withholding methods with the three triggers and the sticky latch, de minimis with four limit shapes, year-end annualization, and one dispatcher over all three paths. Reproduces RR 11-2018 Illustrations 6–15 to the centavo                        |
| **5a** | Payroll data model (runs, lines, per-employee year state, previous-employer 2316); the run computation service and its variance recording; the statutory contribution engine and the check against it; register import; Form 2316; the filing period state machine; the `.DAT` encoder and alphalist pre-flight |

### Verified against primary text, not commentary

Both annexes (all 48 sub-annual constants, independently re-derived), all 33 de
minimis ceilings across three generations, the SSS 61-row MSC table, the
PhilHealth premium schedule and the Pag-IBIG tiers.

### Two things still need a human

**The `.DAT` spike.** Five facts — quoting, line terminator, encoding,
empty-field handling, numeric padding — are unknowable from the public record
and answerable only by running the Validation Module. The encoder is written
with all five isolated in `PROVISIONAL_CONFIG`, and a test asserts the whole
file's shape flips from that object alone, so the result is a one-line change.
`verified: false` is asserted by another test so it cannot be quietly blessed.
Wizard: [dat-spike-wizard.md](dat-spike-wizard.md).

**The reference-data owner.** The monthly sweep runs (routine
`trig_011hE4UdxseQf1serqaxSBRo`, first fire 1 September) and files a digest, but
a sweep with no named reviewer is a mechanism with no operator.

### Carried, with the reason each is open

| Item                                 | Why it is not closed                                                                                                                                                                                                                              |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `last_verified_at` still NULL        | Amounts are verified; the two de minimis GENERATION BOUNDARIES are not. Neither 2025 RR states a publication date, so 14 Feb 2025 and 6 Jan 2026 rest on agreeing secondary sources. A wrong boundary applies the wrong ceiling to a whole period |
| Pag-IBIG "Fund Salary" definition    | `pagibigfund.gov.ph` is behind a reCAPTCHA; the schedule rests on DBM Circular Letter 2024-2 quoting Circular 460 verbatim. Rates are solid; the exclusion list is unresolved, and only matters below the ₱10,000 cap                             |
| PhilHealth CY2026 floor/ceiling      | PhilHealth published no 2026 premium advisory — all 47 were enumerated. The figures carry over from Circular 2020-0005 rather than a 2026-dated document                                                                                          |
| Semi-monthly contribution convention | Contributions are monthly obligations; employers split them across periods differently. The check records `skipped_non_monthly` rather than inventing a split rule. Needs a per-org setting                                                       |
| Illustration 12's July centavo       | RR 11-2018 contradicts itself inside one illustration — July truncates, November rounds half-up. We follow half-up per D-N6 and the test documents the divergence                                                                                 |
| U2, U4, U9, U10                      | Tax counsel questions, unchanged. See [tax-counsel-questions.md](tax-counsel-questions.md)                                                                                                                                                        |

### Corrected 2026-08-17 — two things I had wrongly filed as blocked

**The 1604-C layouts were never blocked on the spike.** Only the encoder CONFIG
was. The layouts are published in RMC 25-2024 Annex A and were already retrieved
at field level. Now transcribed, with three traps pinned by tests: field ORDER
differs between 1601-EQ and 1601-FQ for identical fields (SEQ_NUM moves from
position 3 to 10); date formats differ by family (MM/YYYY vs MM/DD/YYYY); and
1604-C Schedule 2 pictures money with ZERO decimals where Schedule 1 uses two.

1604-C Schedule 2 (59 fields) and the control record stay in
`UNTRANSCRIBED_LAYOUTS` — a guessed field order produces a file that parses
cleanly into wrong columns, which is invisible until an assessment.

**Stage 0 is complete.** Every codeable item in it has landed, including the
two the stage description names as prerequisites — the transaction fixture and
the historical data survey — which an earlier pass through this section
wrongly reported as done:

- **Bill void double-removed.** It flipped the original journal to voided AND
  posted a mirrored reversal, so every voided bill understated its period by the
  bill's value. The invoice path had already fixed this and calls the reversal
  "the historical bug". Now void-only, and it respects the period lock its
  sibling paths check.
- **A database-level balance guarantee**, which did not exist anywhere in
  `drizzle/`. It compares at full scale and rejects a ₱0.00000001 imbalance —
  precisely what the float-based application check passes. It immediately found
  four existing integration fixtures creating single-sided posted journals;
  those were fixed rather than exempted.

- **`functionalCurrency` on every posting site.** The column defaults to `'USD'`
  and four of the six posting files never set it; `base_currency` defaults to
  USD too, so no layer would have noticed. One resolver now owns it, and an
  invalid configured code throws instead of degrading to dollars. Tracing the
  callers turned up the same default on three customer-facing surfaces — the
  invoice email hard-coded a `$`, the PDF defaulted to USD, and the pay page
  hard-coded `currency=USD` into the PayPal SDK URL. That last one is not a
  display bug: a peso invoice was initialised for charge in dollars. `currency`
  is now required on both the email payload and the PDF data, so a caller that
  forgets it fails to compile.
- **Amend-by-reversal for posted journals.** `-_mutations.ts` deleted every line
  and reinserted with no `status = 'posted'` check; `-_batch.ts` bulk-repointed
  `account_id`. Any tax line the compliance layer writes could be silently
  mutated after the return it fed had been filed. Migration 0042 adds the
  lineage columns, a partial unique index allowing one reversal per original,
  and two triggers. The line trigger is deliberately column-scoped: `account_id`,
  `debit`, `credit` and re-parenting are frozen; department/location re-tagging
  stays editable because it moves no money. `lib/journal-amendment.ts` posts the
  reversal and replacement together. Twelve trigger behaviours verified against
  a live database.
- **Exact money arithmetic.** `validateBalance` accumulated with
  `Number.parseFloat` and rounded BOTH sides to 2dp _before_ comparing, against a
  ledger stored at `decimal(20,8)` — so a journal out of balance by 0.00000001
  passed and was posted, and float addition drifted over long line sets. It now
  sums as scaled integers at the ledger's own scale and throws on a malformed
  amount rather than coercing to `NaN`. The bill paths were worse than a
  rounding difference: the DEBIT lines used each line's raw amount while the A/P
  CREDIT used a float sum through `.toFixed(2)`, so the two sides were derived
  differently and could disagree.
- **Nine posting sites down to the shared services.** The dead `invoice-journal.ts`
  A/R fork deleted (its tests repointed at the live implementation, so the
  coverage now applies to code that actually posts), and the two bill-accrual
  implementations consolidated into `lib/bill-journal.ts` — 211 lines of
  duplicated posting logic, which had just cost three defects fixed twice each.
- **`effectiveDate` threaded.** The bill-payment and invoice-payment journals
  stamped `new Date()` unconditionally and never checked the period lock, so a
  payment could land in a closed month even though issuing the document could
  not. `manual-invoice-payment` computed the journal date and the lineage date
  separately, so a payment recorded across midnight carried two different dates
  for one event.

- **`tests/utils/tx-fixture.ts`.** `db-utils.ts` is 23 lines returning a raw
  pooled connection with no isolation. The obvious replacement — wrap each test
  in a rolled-back transaction — is WRONG for this suite: the balance check is
  `DEFERRABLE INITIALLY DEFERRED`, fires only at COMMIT, and a rolled-back test
  therefore passes every balance violation it was written to catch. So there
  are two fixtures, and the choice between them is a real one: `withRollback` /
  `withRollbackDb` for ordinary isolation, `withCommittedScope` when the commit
  IS the thing under test. A test asserts the distinction in both directions,
  so the trap cannot be rediscovered later.
- **The historical data survey.** `scripts/survey-bill-void-exposure.ts` reports
  which organizations and periods were understated by the double-removal, and by
  how much. It is READ-ONLY by design: changing historical financial figures is
  the owner's decision, not a script's default. The dev database shows no
  exposure; production has not been surveyed. The repair, once authorised, is to
  void those reversal headers — not delete them, which the ledger refuses anyway.

### Built since, beyond Stage 0

- **Stage 4 — the as-filed snapshot** (`filing-snapshot.ts`). `filing-period.ts`
  already refused to reach `filed` without a checksummed snapshot; nothing took
  one, so the state machine was gated on a missing component. Canonicalisation
  distinguishes `null` from `"0"` (not reported vs reported as nil are different
  statements) while treating `"84000"`, `"84000.00"` and `-0` as one figure.
  `verifySnapshot` separates "cannot verify" from "was altered".
- **Stage 5a — the 2316 PDF** (`form-2316-pdf.ts`). Says on its face that it is
  a substitute, not the BIR's printed template. Blocking issues are rendered,
  not suppressed: a red banner plus a NOT FOR ISSUE watermark on every page.
- **Stage 5b — the payroll journal** (`payroll-journal.ts`, migration 0043) and
  the **PH account resolver** (`ph-account-resolver.ts`). Only the EMPLOYER
  share is expensed; net pay is derived so the identity must hold. It posts the
  REPORTED tax, not the computed one. A run with unacknowledged variances is
  refused — posting is an advance, so the D-N7 gate applies.
- **Stage 5b — 1601-C** (`form-1601c.ts`), built as a reconciliation rather
  than a computation. An unposted period blocks rather than passes. The
  December exception (15 Jan) and the eFPS stagger are handled; an unknown eFPS
  group takes the EARLIEST date, because guessing late risks a surcharge.
- **Stage 5b — the year-end true-up** (`annualization-posting.ts`). An
  uncollectible deficiency is the employer's EXPENSE, never a receivable, and
  that fact is an explicit input rather than inferred.

- **Stage 5b — the variance verifier** (`-payroll-variances.ts`,
  `VarianceVerifier.tsx`, migration 0044). D-N7 in the interface. It
  deliberately offers NO control that replaces the register with the engine's
  figure — a component test asserts that negative, because overwriting would
  make the ledger disagree with payslips already in employees' hands, in one
  click and with no record. The only action is to acknowledge WITH A REASON;
  0044 adds `acknowledgement_note` and a CHECK requiring all three
  acknowledgement fields together, so an empty click cannot be stored.

**Stage 5b is complete.**

- **Stage 3a — received 2307, CWT, SAWT** (`certificate-2307.ts`, migration
  0045). The certificate is tracked separately from the ledger because a CWT
  receivable with no paper behind it is disallowed at assessment. Status
  defaults to `pending`, not `received`.
- **Stage 3b — EWT as agent, 0619-E/1601-EQ, QAP** (`ewt.ts`). "Could not
  determine" is never presented as "nothing to withhold". The base is net of
  VAT — taking it on the gross over-withholds by 1,200 on a 112,000 invoice.
  Months 1–2 of a quarter go on 0619-E; month 3 issues none and the quarter
  goes on 1601-EQ.
- **Stage 6 — VAT, EOPT, 2550Q, SLSP** (`vat.ts`). The EOPT deduction is a
  DEFERRAL and the module says so in its return value; eligible invoices are
  listed individually so the add-back stays traceable.
- **Stage 7 — percentage tax, 8%, threshold monitor** (`percentage-tax.ts`).
  The ₱250,000 deduction is withheld from mixed-income earners, worth exactly
  ₱20,000 a year. A mid-year breach credits the 8% already paid rather than
  forfeiting it.

### Still not started

PH invoice issuance (deliberately out of v1 scope per D6). Tax-settings /
party-tax screens. Deadline engine. Stages 3a/3b/6/7 product UI beyond the
engines, the 2307 OCR registry, and the payroll filing journey.

Stage 3a's OCR wiring, Stage 4's filing workspace, and the January persist
path have landed on `feat/ph-tax-on-main`: `/payroll_/$runId` can import a
template register (TIN-matched, no invented employees), compute the verifier,
post the journal, review variances, snapshot, and file. Still missing from a
client-complete January path: creating the run itself, tax-profile screens,
and the owner `.DAT` spike.

**And the gap that matters more than any of those:** none of Stages 3a/3b/6/7
is a client-complete UI. That remaining wiring, not more tax regimes, is what
stands between this and something a client can file with in January.

**Export protocol, current `main`.** This branch now sits on current `main`
with tax migrations numbered 0037-0046. `payroll_*`, `party_tax_profiles`,
`tax_certificates`, and the tax-reference tables are still not in
`EXPORTABLE_ENTITIES`. They stay out of v2 until they have export/import
handlers; adding empty arrays without handlers would be a version bump for
no client-visible path. Recorded so the next export-capable stage cannot
forget them.

### Blocked on the owner — cannot be done from here

- The `.DAT` Windows VM spike. Five unknowns stay isolated in
  `PROVISIONAL_CONFIG`, whose `verified` flag remains `false`. The wizard in
  `dat-spike-wizard.md` is ready to run.
- Naming the reference-data owner for the monthly sweep. The cloud routine
  exists and first fires 2026-09-01; it has no human owner assigned.
