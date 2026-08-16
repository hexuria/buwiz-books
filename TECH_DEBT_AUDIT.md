# Buwiz Books — Full Technical-Debt & Correctness Audit

_Date: 2026-07-22 · Scope: `src/`, `server/`, `scripts/`, `drizzle/`, CI, docs_

## How to read this

Six parallel audits (business-process correctness, dead code, duplication/design, feature gaps, test debt, security/infra) plus a 10-way adversarial verification pass on the highest-impact claims. Every finding below the "Verified" line was traced through the **live** code path — not inferred from file names. That mattered: two findings named the wrong file, and one alleged "critical fraud hole" turned out to be dead code (see Corrections).

**Priority score** = (Impact + Risk) × (6 − Effort), per the tech-debt framework. Impact/Risk are 1–5; Effort is 1–5 (1 = trivial). Higher score = do sooner.

---

## Corrections to earlier raw findings (verified)

- **PayPal capture is NOT a live fraud hole.** The live handler `server/routes/api/payments/paypal-capture.post.ts` verifies `reference_id === invoice.id`, captured amount ≥ balance due, and currency. The vulnerable version (`src/routes/api/-paypal-order.ts`) is **dead code** — delete it before someone re-wires it.
- **Bill-void double-reversal → it's the invoice-void path.** `deleteBill` is correctly void-only. The double-reversal defect is live and UI-wired for **invoice** voids instead.
- **"journal_lines never sets organization_id" is inaccurate** — the column is `NOT NULL` and the insert relies on it. The RLS-bypass conclusion still holds for a different reason (owner bypass, below).

---

## Executive summary — the five things that matter most

1. **The core ledger loop is broken for hand-entered and imported data.** `postTransaction` exists and works but **no UI calls it**; manual, CSV-import, and reconciliation-created transactions are all inserted as `draft` and stay there forever. Reports count only `posted`, so those transactions never appear in the P&L, Balance Sheet, Trial Balance, or Cash Flow. The ledger list shows drafts (and voided), so **the ledger and the financial statements can never tie out.** For an accounting product this is disqualifying.
2. **Invoices post unbalanced journals.** Every invoice carrying tax or a discount debits A/R for the full total but credits only the line-item subtotal — no tax-payable, no discount contra, and no balance check. The general ledger silently fails to foot on any taxed/discounted invoice.
3. **Card payments never reach the ledger.** Live PayPal capture marks the invoice paid but posts no DR Bank / CR A/R and never clears `balanceDue`. Live Stripe has no webhook at all — a completed card payment changes nothing server-side. Your own docs promise "auto-mark paid + journal entry."
4. **"Closed" periods aren't closed.** The period lock is checked on single-item create/void/post only. Batch delete/update, invoice/bill posting, the AI merge, and the reconciliation agent all bypass it — and `updateTransaction` can move a transaction _into_ a locked period. A lock that bulk-edits ignore is worse than no lock: it manufactures false confidence.
5. **Production deploys with no safety net.** `.github/workflows/deploy.yml` runs on push to `main`, builds the image, runs `drizzle-kit push --force` against the **production** Neon DB, and deploys to Cloud Run — with **zero** lint, typecheck, or test steps. Untested code plus forced schema changes go straight to prod.

Two structural notes: **RLS is decorative** (the app connects as the DB owner, so no policy is enforced — tenant isolation rests entirely on hand-written `orgId` filters), and roughly **~5,600 lines of dead code + ~11,700 lines of stale tracked docs** can be removed with no behavior change.

---

## Master priority table

| #   | Finding                                                                         | Cat         | Impact | Risk | Effort | **Score** | Confidence           |
| --- | ------------------------------------------------------------------------------- | ----------- | :----: | :--: | :----: | :-------: | :------------------- |
| 1   | Draft→posted lifecycle severed; manual/imported txns invisible to reports       | Correctness |   5    |  5   |   2    |  **40**   | Verified LIVE        |
| 2   | Invoice A/R journal unbalanced (tax/discount uncredited, no balance check)      | Correctness |   5    |  5   |   2    |  **40**   | Verified LIVE        |
| 3   | Cross-org `invoice_number` global-unique collision (2nd tenant blocked)         | Correctness |   4    |  4   |   1    |  **40**   | Verified LIVE        |
| 4   | Invoice void double-reverses (Revenue −x and A/R −x)                            | Correctness |   4    |  5   |   2    |  **36**   | Verified LIVE        |
| 5   | GitHub deploy: no test gate + `drizzle-kit push --force` to prod                | Infra       |   4    |  5   |   2    |  **36**   | Verified             |
| 6   | Cash-flow statement drops A/R & others (subtype string mismatch)                | Correctness |   3    |  4   |   1    |  **35**   | Verified LIVE        |
| 7   | Card/PayPal payments post no GL journal; Stripe has no webhook                  | Correctness |   5    |  5   |   3    |  **30**   | Verified LIVE        |
| 8   | Import txn-number `count(*)+1` reuses numbers; no unique constraint             | Correctness |   3    |  4   |   2    |  **28**   | Verified LIVE        |
| 9   | Invoice email bypasses state machine; double-pay reachable; overpay unchecked   | Correctness |   3    |  4   |   2    |  **28**   | Verified LIVE        |
| 10  | Period lock bypassed by batch/invoice/bill/AI paths; move-into-locked           | Correctness |   4    |  5   |   3    |  **27**   | Verified LIVE        |
| 11  | Per-org secrets in `org.metadata` may leak to client browser                    | Security    |   3    |  5   |   2    |  **32**   | **Needs live check** |
| 12  | Account pages count draft+voided; COGS sign flipped (ledger≠TB)                 | Correctness |   3    |  3   |   2    |  **24**   | Confirmed (agent)    |
| 13  | RLS not enforced — app connects as table owner                                  | Security    |   3    |  5   |   3    |  **24**   | Verified             |
| 14  | Money layer (API mutations, reports svc, recon agent) has ~zero tests           | Test        |   3    |  5   |   3    |  **24**   | Verified             |
| 15  | Silent test skips + integration/e2e never run in CI                             | Test        |   3    |  3   |   2    |  **24**   | Verified             |
| 16  | No error tracking/monitoring (no Sentry/OTel)                                   | Infra       |   3    |  3   |   2    |  **24**   | Verified             |
| 17  | Reconciliation: cross-period double-match; finalize ignores match status        | Correctness |   3    |  4   |   4    |  **14**   | Verified LIVE        |
| 18  | `nitro: npm:nitro-nightly@latest` unpinned in prod deps                         | Deps        |   2    |  3   |   1    |  **25**   | Verified             |
| 19  | Rate limit in-memory (broken across instances); bypass flags not prod-gated     | Security    |   2    |  3   |   2    |  **20**   | Verified             |
| 20  | Query-key factory missing (316 inline keys, 132 invalidations)                  | Design      |   2    |  2   |   1    |  **20**   | Confirmed (agent)    |
| 21  | Documented-but-fake: invoice PDF, "Viewed" status, silent email success         | Feature     |   2    |  3   |   2    |  **20**   | Verified             |
| 22  | Collapse 6 entity routes + dept/location pages (config-driven)                  | Design      |   3    |  2   |   3    |  **15**   | Confirmed (agent)    |
| 23  | `defineOrgFn` factory: kill double-parse, 3 validation conventions, 114 casts   | Design      |   3    |  2   |   3    |  **15**   | Confirmed (agent)    |
| 24  | Delete ~5,600 lines dead code + 5 unused deps                                   | Dead code   |   2    |  1   |   1    |  **15**   | Verified             |
| 25  | White-label: storage still R2 (not client GCP); `manifest.json` = "Buwiz Books" | Feature     |   2    |  3   |   3    |  **15**   | Verified             |
| 26  | Split 1,800-line god-components; `useTransactionForm` hook                      | Design      |   3    |  2   |   4    |  **10**   | Confirmed (agent)    |
| 27  | Doc processing queue is client-side (dies on tab close); no file dedup          | Feature     |   2    |  3   |   4    |  **10**   | Verified             |
| 28  | Executive dashboard missing (`/` redirects to ledger)                           | Feature     |   2    |  2   |   4    |   **8**   | Verified             |

---

## Detailed findings

### A. Business-process correctness (the priority the owner flagged)

**1 — Draft→posted lifecycle severed.** `postTransaction`/`voidTransaction` (`src/routes/api/transactions/-_mutations.ts:297,372`) are only re-exported, never imported by any `.tsx`. The live detail route imports `getTransaction, updateTransaction, listActivityLogs, getSimilarTransactions, deleteTransactionsBatch` — no post/void. All creation paths write `draft` (`-_mutations.ts:77`, `-transactions-import.ts:286,612`, `reconciliations/-_mutations.ts:241`). Reports filter `status = "posted"` (`src/services/reports.ts:33`). Only bills/invoices generate `posted` journals. → Fix: wire a post/approve action (and decide auto-post vs. review); backfill or bulk-post existing drafts; make the ledger and reports share one status filter so they reconcile.

**2 — Unbalanced invoice A/R journal.** `createArJournalEntry` (`src/routes/api/-invoices.ts:434`, called on invoice "sent"/first send) debits A/R for `invoice.total` (= subtotal − discount + tax) but credits only Σ line amounts (= subtotal). No tax-payable credit, no discount contra, and no `validateBalance` — even though that validator exists and is used in the manual path. Example: subtotal 100, tax 8 → DR A/R 108 / CR Revenue 100, off by 8. Lines lacking `revenueAccountId` are dropped from the credits while A/R is debited in full. → Fix: add tax/discount postings, route every posting path through `validateBalance`, add a DB CHECK/trigger for debits = credits.

**3 — Cross-org invoice number collision.** `invoices.invoice_number` has a single-column global unique (`invoices_invoice_number_unique`) while sequences are per-org starting at `INV-0001` (`src/lib/sequence.ts`). In shared-tenant mode the 2nd org's first invoice fails. (Model C one-DB-per-client avoids it by deployment, not by code.) → Fix: composite unique `(organization_id, invoice_number)`.

**4 — Invoice void double-reversal.** `src/routes/api/-invoices.ts:780-855` (live via the Void action) sets the original journals to `voided` **and** posts a swapped-sides reversal as `posted`. Since reports aggregate `posted` only, the net effect is −(original): voiding a $500 invoice leaves Revenue −$500 and A/R −$500. → Fix: void-only OR reverse-only, never both. (`deleteBill` already does void-only correctly — mirror it.)

**6 — Cash-flow statement drops accounts.** `src/lib/report-calculations.ts:45-70` uses subtype strings that don't exist in `src/db/schema/account-constants.ts`: `accounts_receivable` (canonical is singular `account_receivable`), plus `accrued_liabilities`, `accumulated_depreciation`, `long_term_investments`, `notes_payable`, `owners_draw`, `paid_in_capital`. Unmatched accounts contribute nothing; there's no fallback branch, so net change in cash is wrong whenever those accounts move. Live via the XLSX export. → Fix: align the constants (share one source of truth with `account-constants.ts`); add a test that every canonical subtype maps to a cash-flow section.

**7 — Card payments never reach the GL.** Live `paypal-capture.post.ts` sets `status='paid'`, `amountPaid`, but posts no journal and never updates `balanceDue`. Live `stripe-checkout.post.ts` only creates a Checkout Session; no `stripe-webhook` route is mounted, so a completed card payment records nothing. The correct path (`transitionInvoiceStatus` → `createPaymentJournalEntry`, `-invoices.ts:763`) posts DR Bank / CR A/R and clears `balanceDue` — the card paths replicate none of it. → Fix: mount a Stripe webhook, call `createPaymentJournalEntry` and update `balanceDue` from both card handlers.

**8 — Import transaction-number duplication.** CSV import numbers from `count(*)+1` (`-transactions-import.ts:249-253,569-586`) instead of the atomic sequence, so after any hard delete numbers get reused, concurrent imports collide, and the sequence counter never learns imported values. No unique constraint on `journal_headers.transaction_number`. → Fix: use `allocateJournalTransactionNumber` everywhere; add a unique constraint `(organization_id, transaction_number)`.

**9 — Invoice status/payment holes.** `sendInvoiceEmailFn` (`-invoices.ts:1074`) writes `status='sent'` with no state-machine check (server-side hole even though the UI resend button is gated). A second `mark-paid` with an explicit positive amount posts a second `pay_in` journal (double cash, negative A/R) via the payment modal's custom-amount field. Overpayment isn't validated against `balanceDue` (bills do check). Invoice totals are client-supplied and never reconciled to line items. → Fix: guard the email status write with `VALID_TRANSITIONS`; add idempotency to `createPaymentJournalEntry`; validate `payAmt ≤ balanceDue` and `total = subtotal − discount + tax`.

**10 — Period lock is advisory.** Checked only in single-item `-_mutations.ts` (create/update/void/post) and `reconciliations/-_mutations.ts`. Bypassed by: `deleteTransactionsBatch`/`updateTransactionsBatch` (`transactions/-_batch.ts` — the `source` guard against `{mercury,stripe,plaid,brex,ramp}` is dead code, since the enum is `manual|import|invoice|bill|reconciliation|system`); the entire invoice/bill lifecycle; the AI merge (`-match-transactions.ts`); the reconciliation agent's `date_fix` (`reconciliations/-_agent.ts:194`). `updateTransaction` checks the lock against the _existing_ date and applies the _new_ date unchecked, so you can move a txn into a closed period; it also edits posted (not just draft) transactions. → Fix: centralize the lock in one guard applied to every ledger-mutating path (old date and new date); require a stronger permission to reopen.

**12 — Account pages disagree with the trial balance.** `src/routes/api/-accounts.ts:622-668,715-754` has no `status='posted'` filter (reports do), so account balances include drafts and voided. The debit-normal list `["asset","other_asset","expense","other_expense"]` misses `cost_of_revenue`, so COGS shows negated on account/category screens. → Fix: posted-only filter; correct the normal-balance list from `account-constants.ts`.

**17 — Reconciliation model gaps.** Finalize math = statement beginning balance + _all_ posted activity (matched/unmatched/ignored alike), so you can finalize with everything unmatched if totals happen to agree, and genuine timing differences make correct reconciliations impossible (no cleared/uncleared concept though `matchStatus` exists). A journal line cleared in one finalized reconciliation can be matched again in the next period (the "already matched" guard is scoped to the current reconciliation only, `reconciliations/-_mutations.ts:302-321`). AI auto-finalize writes `finalizedById:"ai-agent"` into a `uuid` column — Postgres rejects it, the error is swallowed, so auto-finalize silently never works. → Fix: global match-uniqueness; a cleared/uncleared balance model; fix the `finalizedById` type or use a sentinel UUID.

Additional confirmed correctness items (lower individual severity, same root causes): IEEE-754 float math on money strings with inconsistent rounding tolerances (0.005 / 0.01) and one unrounded float written to a `decimal(15,2)` recon column; `basis: "cash"` accepted then ignored (all reports are accrual); retained earnings never rolled (prior-year earnings show as current "Net Income", and there's no `assets = liabilities + equity` assertion to catch #2's imbalance); balance-sheet "prior period" compare is the previous _day_ (`services/reports.ts:68`), P&L "prior period" is a mirrored day-span that also omits accounts absent from the current period; AR/AP aging includes drafts and disagrees with the GL; payment/reversal journals dated with UTC "today" (org timezone is display-only), landing near month-end in the wrong period.

### B. Security & infrastructure

**5 — Unguarded production deploy.** `.github/workflows/deploy.yml`: on push, build → `drizzle-kit push --force` against prod Neon → Cloud Run deploy. No test/lint/typecheck. `--force` can drop columns on a live DB. → Fix: add a CI gate (typecheck + unit + integration) that blocks deploy; replace `push --force` with reviewed migrations (`drizzle-kit migrate`).

**11 — Per-org secrets may leak to the browser (needs a live check).** `stripeSecretKey`, `paypalClientSecret`, `resendApiKey`, `geminiApiKeys[]` are stored unencrypted in `organization.metadata`. The server settings endpoint returns only `...Set` booleans, but `useActiveOrganization` calls better-auth `getFullOrganization` and `JSON.parse`s the whole `metadata` blob into the client (`src/hooks/useActiveOrganization.ts:36-58`). better-auth doesn't know these keys are secret. → Verify what `getFullOrganization` actually returns to a `member`; if it includes `metadata`, move secrets to Secret Manager or an encrypted server-only column immediately.

**13 — RLS not enforced.** No `FORCE ROW LEVEL SECURITY`, no non-owner role, no `GRANT` anywhere; the app uses one owner `DATABASE_URL`. Postgres skips RLS for the table owner, so every policy in `drizzle/rls_policies.sql` is bypassed, and the `IS NULL` escape clause means any query outside `withOrgContext` (raw `db` is used in ~17 modules) is cross-tenant. Isolation depends entirely on developers remembering `eq(x.organizationId, orgId)`. → Fix: create an `app_runtime` role with DML-only, `FORCE RLS`, drop the `IS NULL` clause, run migrations as a separate owner.

**16 / 18 / 19 — Infra hygiene.** No error tracking (no Sentry/OTel; `logger.ts` is console-only). `nitro: npm:nitro-nightly@latest` in prod deps drags pre-release transitive deps (`h3@2.0.1-rc`, `rolldown@1.0.0-rc`) — pin to a stable release. Rate limiting is in-memory per-instance (defeated by Cloud Run autoscaling); `BYPASS_RATE_LIMITS`/`E2E_BYPASS_R2` are read at runtime (not tree-shaken) and only off by env hygiene — hard-gate them on `NODE_ENV !== "production"`. Committed DB dump `scripts/backup-2026-02-09.sql` should be purged from history. `getSessionContext` performs a write (`setActiveOrganization`) on a read path, racing multi-org users onto the wrong org.

### C. Test debt

**14 — The money-writing layer is untested.** Pure calculators (`report-calculations`, `auto-matcher`, `sequence`, `period-close`, `account-helpers`) have unit tests, but the layer that turns actions into ledger rows does not: API mutation/batch routes, `reconciliations/-_matching|-_mutations|-_agent`, `services/reports.ts` `aggregateBalances`, and `reconciliation-agent.ts` (zero tests). `tests/integration/transactions.test.ts` is test theater — it asserts regexes defined inside the test. → Fix: DB-backed integration tests for posting (balance rejection), period-lock enforcement, recon finalize, and report aggregation.

**15 — CI runs almost nothing; skips are silent.** GitLab CI runs lint/typecheck/unit only — integration/component/e2e never run automatically (only in a bypassable husky hook). 67 integration cases `describe.skip` without a DB env; AI-OCR tests skip on any machine lacking a hardcoded `/Users/uriah/...` fixture path — green everywhere but one laptop. e2e is `fullyParallel` across 3 browsers against one shared seeded DB with no cleanup and hardcoded row UUIDs — a built-in flake machine. → Fix: run integration in CI with a Postgres service; make fixture-dependent skips fail loudly in CI; serialize mutating e2e or give each spec its own data.

### D. Lean code, dead code, duplication

**24 — Delete on sight (~5,600 lines, 5 deps).** Orphaned transaction components (`TransactionForm`, `JournalEntryForm`, `TransactionDetail`, `TransactionRow`, `InsightsChart`, `CommentsTab` — ~1,590 lines); dead payment/period files (`-paypal-order.ts`, `-stripe-checkout.ts`, `-period-close.ts` — ~470); `security-middleware.ts` + `validation.ts` (+ its test) — ~490; `Header.tsx`/`.css`, `MonthStrip.tsx`; ~25 unused exports; ~18 orphan debug scripts (~2,040). Unused deps: `@paypal/paypal-js`, `react-pdf`, `@uidotdev/usehooks`, `@tanstack/react-router-ssr-query`, `web-vitals`. Safety net: `bun run check && bun run test`. Also `git rm -r --cached EPICS/` (10,579 lines tracked despite `.gitignore`) and `research/buwiz_agent.md`.

**20 / 22 / 23 / 26 — Design patterns.** Query-key factory (`src/lib/query-keys.ts`) to replace 316 inline keys + 132 hand-synced invalidations. Config-driven route for the 6 near-identical entity pages (~1,900 lines → ~450) and the departments/locations pair (~90% identical, ~4,600 → ~2,400). A `defineOrgFn({method, schema, permission})` factory to collapse the double-parse, three validation conventions, and 114 unsafe client casts across 255 server functions. Extract `useTransactionForm()` (the repo already proves the pattern in `useReconciliationData`/`useReconciliationMutations`) and split the 1,800–3,160-line god-components on the transaction/reconciliation routes. Consolidate 15 local `formatDate` copies + two `formatCurrency` modules into one; promote recurring hex colors to design tokens.

### E. Missing / documented-but-fake features

**21 — Docs oversell.** Invoice PDF attachment/download is promised on three doc pages but no invoice-PDF code exists; `sendInvoiceEmail` sends HTML with no attachment and **returns `{success:true}` when no Resend key is configured** (invoices marked "sent" that never sent). The `"viewed"` status is read in 8 files but never written. → Fix: build invoice PDF or correct the docs; make the email no-op fail; write `viewed` from the public portal or drop the status.

**25 — White-label gaps.** File storage is still Cloudflare R2, so client data does **not** fully live in the client's GCP as the Model-C plan sells; `public/manifest.json` still hardcodes `"Buwiz Books"` (the plan's own verification step fails). → Fix: GCS storage abstraction; template the manifest.

**27 / 28 — Bigger builds.** Document processing is a client-side pipeline that dies if the tab closes (no server queue, no retry, no status); no file-dedup `content_hash`, so identical uploads re-run paid Gemini OCR. No executive dashboard — `/` redirects to the ledger.

---

## Phased remediation plan (alongside feature work)

### Phase 0 — Correctness & deploy safety (do first; mostly small, high score)

Ledger integrity is the product. These are the score-40 items plus the cheap high-risk fixes.

- Fix the unbalanced invoice A/R journal (#2) and route all posting through `validateBalance`; add a DB debits=credits CHECK.
- Fix the invoice-void double-reversal (#4).
- Wire post/void into the transaction UI and settle the posting workflow; reconcile ledger vs. reports status filter (#1).
- Post card/PayPal payments to the GL + mount the Stripe webhook (#7).
- Composite unique on `(org, invoice_number)` (#3) and `(org, transaction_number)` + atomic import numbering (#8).
- Fix cash-flow subtype constants (#6).
- Add a CI test gate and stop `drizzle-kit push --force` to prod (#5).

### Phase 1 — Close the integrity & isolation gaps

- Centralize period-lock enforcement across every mutation path (#10).
- Reconciliation: global match-uniqueness + cleared/uncleared model; fix silent auto-finalize (#17).
- Account-page posted-only filter + COGS sign (#12); invoice email/payment/overpay guards (#9).
- Non-owner role + `FORCE RLS` (#13); resolve the metadata-secret leak (#11).
- DB-backed tests for the money layer; make CI run integration; de-flake e2e (#14, #15).

### Phase 2 — Lean & design (safe, mechanical, parallel to features)

- Delete dead code + unused deps; untrack `EPICS/` and research notes (#24).
- Query-key factory (#20); config-driven entity/dimension routes (#22); `defineOrgFn` factory (#23); god-component split (#26).
- Pin nitro; shared-store rate limiting; prod-gate bypass flags; add error tracking (#18, #19, #16).

### Phase 3 — Product credibility & features

- Invoice PDF or doc correction + email no-op fix + `viewed` (#21).
- White-label GCS storage + manifest fix (#25).
- Server-side document processing queue + file dedup (#27); executive dashboard (#28).

## Quick wins (< 1 day each, do opportunistically)

Composite unique constraints (#3, #8) · cash-flow subtype fix (#6) · invoice-void void-only (#4) · `manifest.json` de-brand (#25) · delete dead files + deps (#24) · email no-op returns failure (#21) · prod-gate bypass flags (#19).
