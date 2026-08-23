# Audit backlog — what deliberately remains

Two remediation programs ran against the 2026-08 six-domain audit (~180 cited findings):

- **Program 1** (PRs 0–20, merged 2026-08-23): all 4 criticals, ~27 highs, 4 systemic
  patterns, each with a ratchet test.
- **Program 2** (14 PRs, merged 2026-08-24): the medium/low backlog — ledger input hygiene,
  posting-lifecycle triggers 0051/0052, export/import fidelity + the PH export set (v4),
  reconciliation guards + the finalize-gate display model, inbox/AI correctness, the last
  org-context deferrals, the earned-autonomy ship (D1), tenancy/reporting polish (D5
  point-in-time balance sheet), the PH country gate (D6 active/archived/off), and both PH
  filing pack-2 clusters.

**This file now holds only what was deliberately NOT fixed**, so descoping never becomes
forgetting. Every entry names its owner class: `product` (needs a product decision or UI
work), `external` (blocked outside this repo), `schema` (a data-model decision), `future`
(real engineering, never scheduled), `process` (hygiene).

## Blocked externally

- **`.DAT` layout transcription** (`external`) — `PROVISIONAL_CONFIG.verified === false`;
  the 1604-C Schedule 1 C1 control record, Schedule 2/MWE, 1601-FQ Schedule 1, and SAWT
  layouts are untranscribed. Generation refuses loudly and filenames say `.incomplete`;
  transcription cannot be done from inside this repo.

## Product decisions

- **Per-organization sender allowlists** (`product`) — inbound email accepts any sender
  (Svix-signed webhook, human-reviewed candidates; trade-off recorded in
  docs/inbox-workflow.md). An org-configurable allowlist needs UI, settings storage, and a
  reject-vs-quarantine policy call.
- **`amendPostedJournal` UI wiring** (`product`) — implemented, tested, integrity-guarded
  (duplicate/finalized-reconciliation refusals landed in Program 2 P3), still unreachable:
  no route or screen calls it.
- **Certificate → invoice application** (`product`) — the CWT credit is an on-account
  customer credit; AR aging now reports it per party (the C1 unapplied-credits tie-line +
  netReceivable). Applying a certificate against a SPECIFIC invoice is a feature, not a fix.
- **Duplicate threshold tuning beyond D4** (`product`) — D4's strong-combo rule (exact
  amount + same day + exact party + no references ⇒ blocking) landed in P8; the general
  threshold stays 70. Further tuning wants production data, not guesses.
- **`category_mapping` autonomy is armed but dormant** (`product`) — the kind is flippable
  (eligibility-gated) but its creation site (coa-scaffold job) emits no confidence, so
  auto-apply never fires until the scaffold pipeline scores its suggestions. `prefill` and
  `create_txn` are deliberately EXCLUDED from autonomy: their appliers are acknowledge-only —
  approving them IS the human feedback label (see AUTONOMY_ALLOWED_KINDS).

## Schema decisions

- **Financial-account child subtype semantics** (`schema`) — a child account inherits the
  parent's subtype (`entity-creation.ts`); P6's reuse keying (last-4 + credit class) treats
  the symptom. Whether children may carry their own subtype is a chart-semantics decision.
- **`sales_tax_payable` fallback subtype** (`schema`) — `invoice-mapping-config.ts` lets
  sales tax fall back to the generic `other_current_liabilities` subtype, which can
  commingle collected tax with unrelated liabilities. Needs a dedicated subtype (and a
  migration for orgs already mapped).

## Future engineering (never scheduled)

- **Bank-CSV import idempotency** (`future`) — `-transactions-import.ts` builds the
  idempotency key from client-supplied `fileHash`/`sourceRow` and never re-derives them;
  altering the hash re-imports the whole file. Fix is a server-side content hash.
- **Timezone bucket drift** (`future`) — `-accounts.ts` chart buckets build a UTC grid
  against locally-parsed row timestamps (edge days land in the wrong bucket);
  `report-utils.ts` `daysPastDue` has the same DST class. The overdue-invoice sweep now
  reads the org's accounting-settings timezone — these readers should follow.
- **Voided-invoice idempotent replay** (`future`) — `invoice-payments.ts` replaying a
  payment against a since-voided invoice reports `"partial"` to the gateway instead of a
  terminal state.
- **FX fetch fully outside the FOR-UPDATE scope** (`future`) — P8 capped the damage
  (10-second AbortSignal, noted in `inbox/fx.ts`); the service-shape fix is to resolve the
  rate before entering the candidate pipeline's transaction.
- **`db:test:fresh` managed-engine drift** (`future`, found during Program 2) — migration
  verifiers 0019–0025 disagree with sync-built shapes on a fresh test database; the working
  local rebuild is the engine sync + the CI recipe chain (documented in TESTING.md history).
  Related: local `drizzle-kit push` prompts interactively where CI's identical command does
  not — unexplained.

## Process debt

- `scripts/apply-tax-foundation.ts` (`process`) — now the general post-schema SQL applier
  (0037+, 0048, 0051, 0052) under a tax-specific name; rename + doc pass.
- **Reconciliation detail on phones** (`process`, found in P7) — the account title `h1`
  resolves hidden at 375px (three-panel layout); the responsive spec anchors on the Back
  link instead. Wants its own mobile design pass.
- **Oxlint `no-unused-vars` warnings** (`process`) — a small standing set of unused-import
  warnings (non-failing); prune opportunistically.
