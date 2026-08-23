# Audit backlog — 2026-08 read-only survey

Six independent reviewers audited one domain each (ledger core, PH tax, AR/AP + chart of
accounts, bank reconciliation, inbox/AI, tenancy/reporting) and returned ~180 cited findings.
The remediation program (`/Users/uriah/.claude/plans` plan of 2026-08-23, PRs 0–20) fixes the
4 criticals, the ~27 highs, and the 4 systemic patterns. **This file holds everything
deliberately NOT fixed in that program**, so descoping never becomes forgetting.

Conventions: `M`/`L` = the reviewer's severity. `→ PR-n` = a remediation PR touches the same
file and should absorb this opportunistically; everything else needs its own future work.
Locations are as-of the audit commit; line numbers drift, the file:symbol pairs won't.

## Ledger core & journals

- M `src/lib/inbox/money.ts:46-56` (used `inbox/service.ts:414-429`) — per-line FX rounding at
  scale 8 with no residual allocation; a genuinely balanced FX entry can throw "Unbalanced
  entry" on input the user cannot fix.
- M `src/db/validation/journals.ts:30-39` — schema permits negative amounts and both debit AND
  credit on one line; sum-only `validateBalance` accepts offsetting negatives. Trial balance
  columns understate.
- M `src/routes/api/transactions/-_shared.ts:58-62` — `listAccountBalances` defaults
  `statuses: []`, applying NO filter; drafts and voided journals sum into account balances
  unless every caller remembers to pass statuses.
- M multiple posters (`bill-journal.ts:87-106`, `invoice-journal.ts:78-97,307-326`,
  `invoice-payments.ts:356-374`, `manual-bill-payment.ts:96-115`, tax posters) — `postedAt`
  never set on posted headers; `legacy-match-conversion.ts:246-252` treats that as
  `invalid_posting_state` and refuses every such journal.
- M `src/routes/api/transactions/-_batch.ts:257-267` — targeted category change repoints EVERY
  line matching `lineAccountId` across selected headers; a split journal posting twice to one
  account moves double the intended amount.
- M `src/routes/api/-transactions-import.ts:198-271` — bank-CSV idempotency key built from
  client-supplied `fileHash`/`sourceRow`, never re-derived; altering the hash re-imports the
  whole file.
- L/M `drizzle/0041_journal_balance_constraint.sql:64-95` — zero-line posted journal counts as
  balanced (0 = 0). Diagnostics check exists (PR-0); tightening the trigger is future work.
- L/M `src/lib/journal-amendment.ts:113-123` — app-side one-reversal check counts voided
  reversals; the enforcing index excludes them. A voided reversal freezes the original as
  unamendable.
- L/M `src/lib/journal-amendment.ts:96-137` — no `duplicateOfHeaderId` or
  finalized-reconciliation checks (latent until the amend flow is wired; see also ledger
  finding: `amendPostedJournal` has no UI/route — wiring it is product work).
- L/M `drizzle/0042_journal_amendment_lineage.sql:95-97` — the forbid-mutation trigger returns
  early on `status='voided'`, so one UPDATE can void AND rewrite date/amount/party.
- L `src/routes/api/-accounts.ts:612-668` — UTC bucket grid vs local-parsed row timestamps;
  edge days land in the wrong chart bucket, unmatched ones silently dropped. (DST class also
  hits `report-utils.ts:131-132` daysPastDue.)
- L `src/routes/api/-transactions-import.ts:162,178,264-265` — `Number.parseFloat → String`
  emits exponential notation that downstream money parsing rejects opaquely. → PR-15 file set.
- L comments citing "0038/0039" for the balance/mutation triggers actually shipped as
  0041/0042 (`-_mutations.ts:121`, `bill-journal.ts:38`, `journal-amendment.ts:77,198`).
- L `src/routes/api/transactions/-_batch.ts:75-83` — guard fires on `!== undefined` while the
  write is truthiness-gated; explicit `accountId: null` is rejected needlessly.

## AR/AP & chart of accounts

- M `src/lib/coa/plan-preset.ts:353-363` + `execute-plan.ts:229-231` — a stale skipped mapping
  makes every preset apply roll back with "incomplete"; UI never suggests
  `overwriteExistingMappings` as the remedy.
- M `src/lib/coa/plan-preset.ts:245-274` — reuse-by-number/name ignores `isActive`; an
  inactive match can become a mapping target and then fail completeness.
- M `src/lib/invoice-journal.ts:141-164` + `invoice-mapping-config.ts:35-40` —
  `sales_tax_payable` falls back to the generic `other_current_liabilities` subtype and can
  commingle collected tax with unrelated liabilities.
- M `src/routes/api/-accounts.ts:1021-1024` — `getCategoryTransactions` catches everything and
  returns `[]`; DB errors render as "no transactions" on a balance-verification screen.
- L/M `src/routes/api/-invoices.ts:908` — emailed PDF is built from the pre-transition
  snapshot; customer receives "Status: draft".
- L/M `src/routes/api/-parties.ts:401-410` — `hardDeleteParty` misses the invoice reference
  check and the org predicate on the bill count; FK failure surfaces as a generic sanitized
  error.
- L `src/routes/api/-parties.ts:199,229,257,280` — `defaultAccountId` accepted with no
  org/active check.
- L `src/routes/api/-category-mappings.ts:132-155,165-187` — delete/reset mappings with no
  completeness warning; "reset to defaults" creates the state the preset applier exists to
  prevent. (PR-14 hardens upsert; delete/reset UX is here.)
- L `src/routes/api/-invoices.ts:771-802` — `deleteInvoice` leaves voided journals pointing at
  a nonexistent invoice; no period/reconciliation check.
- L `src/routes/api/-bills.ts:478-483` — empty `if` block with a first-person WIP comment.
- L `src/lib/bill-upload-store.ts:468-470,531,537-538` — inline query keys split the cache
  (CLAUDE.md rule); use `src/lib/query-keys.ts`.
- L `src/routes/api/-bills.ts:137-147,1476` — line `amount: z.string()` with no numeric/sign
  validation; negative bills strand as unpayable. → PR-13 can absorb the zod shape.
- L `src/lib/invoice-payments.ts:324-328` — idempotent replay for a since-voided invoice
  reports `"partial"` to the gateway.

## Bank reconciliation & matching

- M `src/routes/api/reconciliations/-_list-detail.ts:481-510` (+ `:339-402`) — the detail-page
  summary still uses the legacy all-activity model the finalize module documents as the
  historical bug, and inflates withdrawals with counterpart lines; display disagrees with the
  finalize gate in both directions. Needs a display-model rewrite on top of
  `computeFinalizeBalances`.
- M `src/routes/api/reconciliations/-_list-detail.ts:347-350` — UI `isMatched` ignores
  `statement_line_matches`; split-cleared ledger lines invite a second match. → PR-1 read-side.
- M `src/lib/reconciliation-claimed-lines.ts:52-59` — org-wide claim check filters
  `matchStatus='matched'` only, omitting `'created'`, and disagrees with the in-recon variant.
  → PR-1 candidate.
- M `src/lib/statement-csv.ts:229-272` — parser returns `ok:true` when ANY row survived; a
  40-of-60-rows-dropped import reports success. (C3 raises balance-integrity to blocking,
  which catches most, not all.)
- M `src/lib/entity-creation.ts:155-174` — financial-account reuse keyed on exact label only;
  same real account with/without last-4 creates duplicates. Root cause (child inherits parent
  subtype, `:228-238`) is a schema-semantics decision, deliberately deferred.
- M `src/routes/api/-financial-accounts.ts:199-227,254-279` — `ledgerAccountId` accepted
  without org/type validation; re-pointing allowed on accounts with finalized reconciliations;
  detail joins `accounts` without an org predicate.
- L `src/routes/api/reconciliations/-_agent.ts:346-362` — agent auto-finalize doesn't set
  `aiAutoFinalized`, attributes to the launching human, skips `persistReconciliationAnomalies`.
- L `src/routes/api/reconciliations/-_mutations.ts:322-341` — manual match doesn't verify the
  journal line is on the reconciliation's ledger account. → PR-4 same-theme.
- L `src/lib/match-assist/persist.ts:172-190` + `blocking.ts:66-92` — split allocations allow
  duplicate journal ids (fails later as an opaque constraint error) and opposite-sign combos.
- L `src/routes/api/-connections.ts:56-58` — `ilike` without `escapeLikePattern`.
- L `src/routes/api/reconciliations/-_statement-upload.ts:1246-1260` — generated statement
  amounts come from float subtraction; `ocrConfidence: "1.0"` on a 0-100 column.
- L `src/lib/statement-validator.ts:139-154` — balance-integrity is warning-severity; the one
  check that catches dropped/duplicated OCR rows never blocks. (C3 addresses the beginning/
  ending equation; per-row-drop blocking is here.)

## Inbox, documents & AI

- **Decision needed** `src/lib/ai/proposals.ts:82`, `autonomy.ts:62,128` — the entire
  earned-autonomy system (createProposalWithAutonomy, computeAutonomyEligibility, shouldDemote)
  has zero production callers and `updateOrgAiConfig` cannot set the column. Ship it or delete
  it; PR-19 only hardens the wall it would use.
- M `src/lib/inbox/fx.ts:103-108` — external FX fetch inside an open transaction holding
  FOR UPDATE locks, no AbortSignal.
- M `src/routes/api/-documents.ts:38` → `ensure-document.ts:95` — no MIME allowlist; stored
  content type echoed to R2 (stored-XSS risk on the storage origin) and fed to the model.
- L `src/lib/inbox/service.ts:935-945` — blocking-findings query omits the org predicate every
  sibling carries. → PR-2 same-file one-liner.
- L swallowed errors: `-ai-entity-resolver.ts:158-165` (failed entity vanishes),
  `-ai-classify-document.ts:112-119` (error ≡ low confidence), `-ai-bill-ocr.ts:229-238`.
- L `src/lib/inbox/rules.ts:152-155` — float `expenseTotal`, undocumented deviation. → PR-15
  ratchet target.
- L `src/lib/inbox/rules.ts:156-159` — missing_receipt threshold converted with the
  candidate's own exchange rate, wrong pair entirely.
- L `src/lib/inbox/email-attachment-source.ts:101-115` — numeric amounts stringify to
  exponential; `1.234,56` parses as `1.234`.
- L `src/lib/inbox/duplicate-matcher.ts:530-532` — missing currency reported as
  `currency_mismatch`, sending operators hunting a conflict that doesn't exist.
- L `src/lib/inbox/duplicate-engine.ts:286` — candidate lookup truncates at 500 with no
  ordering and no signal.
- L `src/lib/jobs/handlers/inbound-email.ts:439-471` — body-source conflict throws where the
  attachment path converges; superseded-row ordering also missing.
- L `src/lib/inbox/review-engine.ts:383` vs `:137` — SQL matches `%clearing%`
  case-insensitively, JS re-filters case-sensitively; `Clearing_Suspense` is fetched then
  dropped.
- Product call (C8 recorded): `duplicate-matcher.ts:546-552` — without a reference number no
  signal combination reaches the blocking threshold 70; same receipt photographed twice never
  blocks.
- Deferred by decision: per-org inbound-email sender allowlist (PR-20 records the trade-off).

### Deferred from PR-12 (background DB discipline)

- **match-assist facade still takes the module connection** —
  `src/lib/jobs/handlers/match-assist.ts` passes bare `db` into
  `runMatchAssist` / `runTxnPrefill` (`src/lib/match-assist/run.ts`,
  `prefill.ts`), whose internals interleave short queries with model calls
  and filter by orgId manually. Convert the facade to own its org context the
  way `runStep` now does (short `withOrgContext` transactions around each
  query, model calls outside), then remove the documented allowlist entry in
  `tests/unit/background-db-discipline.test.ts`.
- **AI facade runtime's remaining module-db reads** —
  `src/lib/ai/facade-runtime.ts` still reads org metadata, credentials, and
  spend state on the module connection (`loadOrgMetadata`,
  `assertWithinSpendCap`, `getOrgCredentials`). `getOrgAiSettings` was
  converted in PR-12; the rest of the runtime should follow the same
  executor/withOrgContext pattern before the RLS hardening drops the IS NULL
  escape.

### Deferred from PR-20 (inbound email)

- **Per-organization sender allowlists** — inbound email currently accepts
  any sender (Svix-signed webhook, human-reviewed candidates; decision
  recorded in docs/inbox-workflow.md). An org-configurable allowlist of
  accepted `from` domains/addresses would cut review noise from spoofed or
  stray senders. Needs UI, settings storage, and a reject-vs-quarantine
  policy call.

## Tenancy, auth & reporting

- M `src/routes/api/-export-import.ts:895-907` — `executeImport` never applies the per-entity
  Zod row schemas; validation is advisory. → export/import program (with PR-16's loud-error
  mini-fix as the stopgap).
- M `src/routes/api/-export-import.ts:134` vs `:941-950` — banks export includes
  `ledgerAccountId`, import strips it (the rules doc's "Common Mistake #3"). → same program.
- M export column drift — party exports omit `taxId`/bank fields/`defaultAccountId`;
  financial-account exports omit wire details (`-export-import.ts:126-135,186-199,300-312`).
  → same program.
- M PH tables absent from `EXPORTABLE_ENTITIES` (`export-versions.ts:13-30` vs drizzle
  0037-0047) — a full export is not a full backup. → same program, protocol in
  `.agent/rules/schema-export-import.md`.
- M `src/lib/export-migrations.ts:36-73` — `migrateToLatest` imported only in a comment; dead
  engine, no version guard the moment EXPORT_VERSION bumps. → same program.
- M `src/routes/api/-business-groups.ts:320-331` — refresh fan-out rate-limited only by
  process-local guard keyed on `groupIds[0]`; rotation defeats it, replicas defeat it.
- M `src/lib/business-groups/projected-performance.ts:231,362` — `projectionSyncAgeSeconds`
  computed then hard-coded `null` in the ready path.
- M policy: `services/reports.ts:33` vs `-reports.ts:166-172` — balance sheet (posted-only)
  and aging (point-in-time voided handling) disagree for the same as-of date; pick one
  treatment and apply to both.
- L `src/routes/api/-export-import.ts:839-889` — `validateImport` has no auth wrapper at all;
  unauthenticated CPU/memory amplifier. → PR-16 fold-in candidate (same file).
- L `src/routes/api/-export-import.ts:567-574` — number-sequences export scope filter can
  never match (`startsWith(orgId)` vs `kind:orgId` scopes); always exports `[]`, and the
  un-predicated SELECT materializes every tenant's rows. → PR-16 fold-in (same file).
- L `src/routes/api/-business-groups.ts:290-298` — `recordProjectionMismatches` errors
  swallowed with `.catch(() => undefined)`; shadow rollout reads clean when recording fails.
- L `src/routes/api/-invitation-lookup.ts:9,181-213` — module-level `db` use is probably
  correct (caller is not yet a member) but undocumented, unlike `dbAdmin` in -public-invoice.
- L `src/lib/permission-policy.ts:3-9` vs `permissions.ts:187-195` — `superuser` is a valid
  role value SQL treats as admin but `ROLE_MAP` doesn't know; such a user is locked out of the
  app while privileged in SQL.
- L `src/routes/api/-reports.ts:55-119` — report reads have no permission gate (no-op today —
  every role holds report:view — becomes real the day a role doesn't).
- L `src/routes/api/-invoices.ts:118-139` — `listInvoices` (a GET under the session wrapper)
  mutates sent/viewed → overdue, using server-local time.
- L `comment:moderate` enforced by inline role strings (`-comments.ts:292-295`) instead of the
  permission system.

## PH tax (not covered by PRs 5–9)

- **C1 rescoped (2026-08-23):** `tax_certificates` has NO invoice reference (only
  `payorPartyId`), so the planned "stamp the CWT journal with the invoice pair" fix is
  impossible as designed — the CWT credit is an on-account customer credit, not an invoice
  settlement. Correct fix is an "unapplied credits" tie-line on AR aging (per party, from
  posted non-invoice journals crediting the AR family), which belongs with the report
  correctness work (PR-16). Genuine per-invoice application needs a certificate→invoice
  application feature — separate product work.
- M `src/lib/tax/payroll-run-service.ts:150-160` — `loadBrackets` ignores `datasetVersion`
  (`pickInForce` in `as-of.ts:96` exists for exactly this); a corrective v2 seed makes bracket
  selection arbitrary. → PR-7 same-file candidate.
- M `src/routes/api/-filing.ts:106-115` — as-filed snapshot checksum covers only 6 of ~23
  reported figures; editing `commission` after filing verifies as intact.
- M `src/lib/tax/issue-payroll-artifacts.ts:227` — `nationality: "FILIPINO"` hardcoded on
  every 1604-C row.
- M `src/lib/tax/issue-qap-dat.ts:17-20` — QAP reports the table rate, not the implied rate
  (sworn-declaration 5% payees report 10%); unknown ATC reports 0.00 against non-zero withheld.
- M `src/lib/tax/issue-qap-dat.ts:44` — QAP never runs `preflightAlphalist`; placeholder TINs
  and lumped names reach the .DAT.
- M `src/lib/tax/benefits.ts:326-329` — YTD 13th-month pool summed with window-scoped
  de-minimis excesses; annual rice-subsidy excess never fully tested against the 90k cap.
- M `src/lib/tax/ewt.ts:110-127` — corporate professional fees always WC010 (10%); RR 11-2018
  requires 15% above the 720k gross-income threshold and there is no input for it.
- M `src/lib/tax/vat.ts:389-390`, `percentage-tax.ts:355` — return figures emitted at up to 8
  decimals (`fromScaled`), no `toPesoString` step before a 2-decimal BIR form.
- M `src/lib/tax/vat.ts:394-395` — any negative payable is wholesale labelled
  `carryoverToNextQuarter`; amended-return credits misclassified as excess input VAT.
- M `src/lib/tax/payroll-journal.ts:274` — union dues credited to the 25100 PARENT rollup
  account rather than a leaf.
- M `src/lib/tax/post-ewt-remittance.ts:26-33` — payments fetched org-wide with no date
  predicate and no "remitted" marker; a late-captured payment can never be remitted (PR-8
  changes this function; the marker design is here).
- L `contributions.ts:88-90` SSS bracket +249.99 boundary at scale-8 inputs; L
  `certificate-2307.ts:74` impliedRateBps truncates (spurious RATE_MISMATCH); L `ewt.ts:270-272`
  unreachable December branch; L `ewt.ts:334`/`certificate-2307.ts:285` TIN+ATC grouping key
  lacks a separator; L `ph-account-resolver.ts:13` comment says 21610, chart says 25110; L
  `filing-period.ts:175-183` a period can reach `filed` with `snapshotChecksum: null`; L
  `alphalist-preflight.ts:187` accepts 5-digit branch codes the layouts truncate; L
  `form-2307-pdf.ts:27`/`form-2316-pdf.ts:29` `peso()` truncates instead of rounding; L
  `percentage-tax.ts:243` float utilization ratio (ratchet target); L `compensation.ts:187`
  gross overstated when contributions exceed clamped taxable; L `deadlines.ts:47` 2550Q
  hardcodes calendar quarters while /tax/settings collects a fiscal year end.
- Blocked on external owner: the `.DAT` encoding spike (`PROVISIONAL_CONFIG.verified === false`,
  five unknowns; 1604-C C1 control record, Schedule 2/MWE, 1601-FQ Schedule 1, SAWT file
  layouts all untranscribed). PR-8 makes generation refuse loudly; transcription cannot be
  done from inside this repo.

## Process debt

- `scripts/apply-tax-foundation.ts` is now the general post-schema SQL applier (0037+, and
  0048 once PR-1 lands) under a tax-specific name — rename + doc pass.
- `amendPostedJournal` (ledger finding #2): implemented, tested, unreachable — wiring it into
  the UI is product work beyond PR-9's scope.
