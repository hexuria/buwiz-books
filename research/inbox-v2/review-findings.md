# Inbox v2: seven-angle review findings

Date: 2026-09-27. Seven read-only reviewers each examined the spec against `v2` from one angle.
This file keeps what each found, so later iterations can trace why the spec changed. The
consolidated design lives in [`README.md`](README.md).

## Disputed or overstated claims, and the verdict

| Claim (reviewer)                                                                         | Verdict                                                                                                                                                             | Evidence                                                                                                           |
| ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Voiding leaves two live journals, so undo is broken (posting)                            | **Wrong.** Void sets `status = 'voided'` and reports are as-of aware of `voided_at`. A real reversal primitive also exists.                                         | `src/routes/api/transactions/-_mutations.ts:342`, `src/routes/api/-reports.ts:170`, `src/lib/journal-amendment.ts` |
| Inbox money uses a different implementation, so rounding errors (posting)                | **Partly.** `src/lib/inbox/money.ts` is exact bigint at 8 decimals, not float. The real gap is `bills.amount decimal(15,2)`, which needs an explicit cent policy.   | `src/lib/inbox/money.ts`, `src/db/schema/bills.ts:60`                                                              |
| Use `review_rule_configs.version` as the rule pack (rules)                               | **Rejected.** Version is per row and old versions are not retained. Adopted a small immutable snapshot table instead, following `review_rule_runs.config_snapshot`. | `src/db/schema/inbox.ts:651-700`                                                                                   |
| Lifting the `categorize` wall violates the "never bend ledger rules" principle (rollout) | **Clarified.** The wall governs AI authority, not ledger invariants. The principle now says so explicitly.                                                          | `src/lib/ai/autonomy.ts:31-44`                                                                                     |
| Spot check re-queues posted items (security, rules)                                      | **Changed.** Hold-back sampling before posting gives an unbiased label with nothing to reverse.                                                                     | design choice                                                                                                      |
| Enforce two-undo disable with a CHECK constraint (rules)                                 | **Changed.** Counter logic belongs in code; the constraint would reject the very update that records the second undo.                                               | design choice                                                                                                      |
| Bills from email never become bill records (spec, confirmed by four reviewers)           | **Confirmed and strengthened.** Email and upload candidates are never typed `bill`.                                                                                 | `resend.post.ts:264`, `jobs/handlers/inbound-email.ts:669`, `document-intake.ts:512`, `service.ts:1203-1214`       |

## UI/UX

- Current pane uses its own inline entry editor, not the app's editors (`src/routes/inbox.tsx`).
- Editors are route-bound: navigate on success (`bills_.create.tsx:123-127`); `transactions_.new`
  already accepts `?type`, `?date`, `?amount`, `?description` prefill (lines 151-197).
- Seam: extract editor components with `draft` and `onSubmit` props; routes wrap them.
- Query keys for inbox, bills, transactions, invoices are separate prefixes; approve must
  invalidate all four.
- Three-pane layout hides panes below `xl`/`lg`; the editor pane needs a drawer on small screens.
- Adopted: keyboard flow, optimistic removal, auto-advance, server-side terminal-state filter.
- Rough effort (reviewer estimate, unverified): editor extraction ~40h, approve rewrite ~30h,
  memory ~35h, layout ~20h.

## Ingestion and routines

- Resend: Svix verification (`resend.post.ts:41-66`), multi-org recipients (75-87), event dedupe
  via `onConflictDoNothing` (133). Attachments: 60s timeout, 20MB cap.
- Leases: `SKIP LOCKED`, 5-minute lease, worker-id fence; 8 attempts with backoff.
- Production drain is a fire-and-forget POST guarded by `INBOX_WORKER_SECRET`; unset secret makes
  it a silent no-op (`trigger.ts:85-91`, `job-drain.ts:17-28`).
- No cron library in `package.json`.
- Dedupe partial unique covers queued/running only; suppressed inserts leave no trace.
- Recipients across orgs are processed sequentially; a slow org delays the next.
- Adopted: routines schema, `processing_jobs.routine_id`, per-routine HMAC, schedule presets,
  cursor-after-save, dedupe event logging, fail-loud worker secret.

## Posting correctness

- `approveInboxItem` writes `journal_headers` (1090-1119), lines (1120-1137),
  `ledger_source_links` (1179-1201); checks period lock (979-982), balance (997-1001), idempotency
  key `inbox:${itemId}:approve:${revision}` (1095); blocks on duplicate cases (1043-1086).
- Editor saves are session-bound server functions; a background approval cannot call them.
- `postBillAccrualJournal` posts expense + AP only; bills have no tax columns.
- Adopted: posting core with explicit actor, cent policy, reversal-based undo.

## Jev and evals

- Provider enum lacks Jev (`src/lib/ai/errors.ts:28`); pricing returns null for unknown models;
  spend cap is process-local with a 60s cache.
- COA presets have roughly 110-150 leaf accounts: feasible as an enum, unverified with Jev.
- `ingest_triage` already pins confidence 0..1.
- Recorded evals cannot replay Jev until fixtures exist.
- Adopted: two-stage classification, redaction pre-pass, calibration table, scorecard command.

## Rules, memory, autonomy

- Book rules read live per-org configs at ingest and correction (`service.ts:730-754`).
- Autonomy is keyed by kind in `organization_ai_settings.autonomy`; eligibility counts
  `ai_run_feedback` joined to proposals by kind. No lane fields exist.
- `pg_trgm` is installed (`drizzle/0027_vendor_aliases.sql:13`).
- Export version 4 has no inbox entities.
- Adopted: `ai_autonomy_lanes` + `ai_run_feedback.lane_id`, memory schema with unique key,
  export v5 for new config tables.

## Security and tenancy

- `review_decisions.actor_id` is a required user FK: no system actor possible today.
- `requireDifferentApprover` exists for humans only (`service.ts:887-897`).
- Lessons enter prompts as data behind an untrusted preamble; redaction is typed.
- `evalDataSharing` is org-wide; there is no per-provider consent.
- `request-guards` is process-local, so no cross-replica rate limit.
- Adopted: actor model, Jev opt-in allowlist, memory permissions, bank-detail-change always
  human, org read from the owning row in background handlers, RLS for all new tables.

## Rollout and testing

- Migrations are numbered SQL through `scripts/migrate.ts`; latest is 0052.
- Product flags today are env vars (`src/lib/tax/product-flag.ts`); per-org rollout needs org
  metadata.
- `AI_MODE=mock` gives deterministic E2E.
- Existing inbox and review-agents tests will break when the old pages go; keep them until cutover.
- Adopted: config-to-Settings first, posting core before the new screen, 12-step order with tests
  per step, org flag for coexistence.
