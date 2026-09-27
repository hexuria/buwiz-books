# Inbox v2: routines, Jev, rule packs, memory

Status: research and design only. No code in this branch. Base: `v2` at `b736189`.
Date: 2026-09-27.

`visual.html` in this folder is the plain-language picture of the same plan (open it in a
browser). This file is the version an agent builds from.

Hosted version of the visual: https://claude.ai/artifact/BBTTrkBY51kpdRTEyRkvib (private;
the owner shares it from the page's Share menu). If the two copies differ, the hosted page is the
newer one.

## Principle

The ledger works without the Inbox. The Inbox only automates typing. What it saves must equal
what a human would save in the existing editors. Never bend ledger rules to fit the Inbox.
Every failure degrades to "Needs you", never to wrong books.

## Goal

A simple inbox where source documents are ingested automatically, classified with high accuracy
by Jev, checked by versioned rules, and approved by Jev (once earned) or a human. Human
corrections stick deterministically. Every change to rules or models is measurable before it
ships.

```text
routine fires (webhook | schedule | integration later)
  -> save raw paper -> OCR text (Gemini)
  -> memory match? yes: deterministic answer
                   no:  Jev (+ approved lessons), closed lists only
  -> rule pack vN checks the draft
  -> Jev approves (earned lane) OR Inbox "Needs you"
  -> approve = the existing editor's own save -> books
```

## What already exists on `v2` (keep, do not rewrite)

| Piece                                                                                                                     | Where                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Event, job queue (retries, dedupe), source records, candidates + lines, inbox items, findings, decisions, workflow events | `src/db/schema/inbox.ts`                                                                                                                                                  |
| Connection, source, sync-run tables with `next_sync_at` and `sync_cursor`                                                 | same file. **No application code reads them yet.**                                                                                                                        |
| Only real ingest webhook: inbound email via Resend                                                                        | `server/routes/api/inbound-email/resend.post.ts`                                                                                                                          |
| Worker drain triggered externally                                                                                         | `server/routes/api/internal/worker.post.ts`, `inbox-worker.post.ts`, `server/plugins/job-drain.ts`                                                                        |
| Model chain router, Gemini first; `ingest_triage` and `classify_document` default to Gemini Flash Lite                    | `src/lib/ai/chains.ts`                                                                                                                                                    |
| OCR tasks are Gemini-only (redaction cannot clean document bytes)                                                         | `src/lib/ai/chains.ts` header                                                                                                                                             |
| Earned autonomy: 200 reviewed at >= 98% to unlock, auto-demote < 95% over last 50, admin-only promotion                   | `src/lib/ai/autonomy.ts`                                                                                                                                                  |
| Hard wall: `match`, `split`, `coa_accounts`, `create_party`, `date_fix`, `categorize` are never model-applied             | `STRUCTURAL_MANUAL_KINDS` in `src/lib/ai/autonomy.ts`                                                                                                                     |
| Corrections -> reflection job -> proposed lessons, admin approves, max 10 lessons / 2000 chars injected as data           | `ai_run_feedback`, `src/lib/jobs/handlers/reflection.ts`, `src/lib/ai/lessons.ts`                                                                                         |
| Corrections -> eval cases; recorded (no network) evals with code graders, money compared in cents                         | `scripts/build-eval-dataset.ts`, `tests/evals/`                                                                                                                           |
| Vendor aliases (descriptor -> party), used only by match-assist today                                                     | `vendor_aliases`, `src/lib/match-assist/aliases.ts`                                                                                                                       |
| Rule catalog: 13 book + 2 system rules; rules carry `formula_version`; seeder is `DO NOTHING`                             | `src/lib/inbox/review-rule-catalog.ts`, `src/lib/inbox/rules.ts`                                                                                                          |
| Every chart preset has Uncategorized accounts; `default_expense` maps to `uncategorized_expense`                          | `src/lib/coa/presets/base.ts`, `base-mappings.ts`                                                                                                                         |
| `uncategorized` book rule is blocking                                                                                     | `src/lib/inbox/rules.ts`                                                                                                                                                  |
| Entity resolver is match-only, exact `ilike` on name; unmatched -> `create_party` proposal                                | `src/routes/api/-ai-entity-resolver.ts`                                                                                                                                   |
| Existing editors                                                                                                          | `bills_.create.tsx`, `bills_.$billId.tsx`, `transactions_.new.tsx` (Journal / Pay in / Pay out / Transfer tabs), `transactions_.$transactionId.tsx`, invoice draft routes |

### Problems found while grounding

1. **Emailed bills never become bill records.** `approveInboxItem` in `src/lib/inbox/service.ts`
   inserts `journal_headers` directly and only updates a `bills` row that already existed
   (`candidateType === "bill" && sourceRecordExternalId`). A bill arriving by email or upload is
   posted to the ledger but is missing from Bills and payables aging.
2. **Stale comment.** `src/lib/entity-creation.ts` (~line 210) says `create_party` can run
   unattended because it is not in `STRUCTURAL_MANUAL_KINDS`. It now is.
3. **Confidence trap.** `normalizeConfidence` reads a bare `1` as 1% unless the caller pins the
   unit scale (`src/lib/ai/confidence.ts`). Pin Jev's schema to 0..1.
4. **Current Inbox UI** is 1,866 lines (`src/routes/inbox.tsx`) with six overlapping filters and
   email setup in the rail. Review Agents (`src/routes/review-agents.tsx`, 1,429 lines) is the only
   UI for per-org rule enable/impact (`review_rule_configs`) and the posted-ledger scan.

## Decisions (owner-confirmed in the design session)

- **Inbox shows only what needs a human.** No Done folder. Approved work lives in Bills,
  Transactions, and the ledger. Empty state: "Nothing needs you."
- **Reading pane = the existing editor, prefilled.** Approve calls that editor's save path.
- **Jev may approve**, through earned autonomy. This deliberately lifts the `categorize` wall for
  inbox approval only, in its own reviewed PR with tests.
- **Human fixes must stick at 100% for the same paper**, via a deterministic memory layer checked
  before any model.
- **Jev handles category choice and entity matching** because it is cheaper than the larger model.
- **Categories:** require a chart before routines run. No fit goes to Uncategorized, not an error.

## Design

### 1. Routines (how papers get in)

A routine is `trigger + grab/read steps + pinned rule pack version`.

- Trigger kinds: `webhook`, `schedule` (cron), `integration` (later).
- New table `routines`: `organization_id`, `name`, `trigger_kind`, `schedule` (cron), source
  config, `rule_pack_version`, `enabled`, `cursor`, timestamps. Reuse `integration_connections` /
  `integration_sync_runs` for schedule bookkeeping and cursor if that fits cleanly.
- A fire writes `ingestion_events` -> `processing_jobs` -> `source_records` -> candidate ->
  `inbox_items`, exactly the existing chain.
- The scheduler is the existing worker drain picking up due routines. Running twice must never
  duplicate papers (dedupe key on routine + external id / payload hash).
- Inbound email becomes the first webhook routine.
- Enabling a routine requires an applied chart of accounts. Otherwise: "Set up your chart of
  accounts first."

### 2. Jev (classification)

- New adapter in `src/lib/ai/adapters/` next to gemini, openai, anthropic. First hop for
  `ingest_triage` and `classify_document`; Gemini stays as fallback.
- Jev reads **OCR text**, not document bytes, unless the owner changes the Gemini-only OCR
  decision.
- Output schema pins `confidence` to 0..1.
- **Closed lists only.** Categories: the org's leaf accounts, sent as an enum in the output schema.
  Never free text, never a new account.
- No fit: resolve through `src/lib/coa/resolve-mapped-account.ts` (`default_expense` ->
  `uncategorized_expense`). The blocking `uncategorized` rule sends it to "Needs a fix".
- Jev may emit a non-binding "suggest new category" note. Account creation stays human.
- Unverified: Jev's real API. The design assumes text in, label + 0..1 confidence out.

### 3. Entities (vendors and customers)

Order:

1. Exact: TIN, sender email, `vendor_aliases`, memory. Deterministic.
2. Look-alikes: `pg_trgm` top 5 existing parties by name.
3. Jev chooses one of the five, or "new".
4. New: Jev drafts a `create_party` (name, type, TIN, email). It is created in the same
   transaction as the approved entry through `src/lib/entity-creation.ts` (reuse-or-create).

`create_party` stays human-applied, so the first paper from a new party always needs a person.
After that the alias is remembered. Keep the resolver write-free; replace only its matching step.

### 4. Memory (human fixes stick)

A model cannot guarantee 100%. A saved rule can.

- New table `classification_memories`: `organization_id`, `match_kind`
  (`file_hash | sender_party | party | line_text`), normalized `match_key`, `answer` (doc kind,
  party, account per line, tax code), `created_by`, `source_feedback_id`, `rule_pack_version`,
  `uses`, `undos`, `enabled`.
- Lookup order: memory -> Jev (+ approved `ai_lessons`) -> rule pack. A memory hit answers with no
  model on the answer path. Jev may run in shadow only, for the scorecard.
- After a correction the pane asks "Remember this?" with a scope picker. Before saving it shows
  how many past papers the memory would have changed (replay over history).
- Two memories that disagree -> Needs you. Two consecutive undos -> memory disables itself.
- Every saved memory also writes an `ai_eval_cases` row (`provenance: authored`,
  `expected` = corrected answer). Replay must reproduce it exactly or CI fails. This is the
  "test lock".

Three layers, only the first is a guarantee:

| Layer     | Effect                                                      |
| --------- | ----------------------------------------------------------- |
| Memory    | Same paper, same answer, 100%                               |
| Lesson    | Helps near-miss papers, not guaranteed                      |
| Test lock | No change to Jev, prompts, or rules can silently undo a fix |

### 5. Rule packs (rules that can grow)

- New table `rule_packs`: `version`, rule set snapshot (enabled, impact, config, formula
  versions), memories included, `created_by`. Pinned per routine.
- Flow: write vN+1 -> replay on the practice pile -> shadow on live papers (flags logged, not
  shown) -> promote by flipping the routine's pinned version. Keep vN for rollback.
- Changing an existing catalog definition is still a reviewed numbered migration (see
  CLAUDE.md on the seeder).

### 6. Jev approval (earned autonomy)

- New autonomy lane `inbox_approve`, keyed by org + party + document kind.
- Levels: watch (log "would approve") -> suggest -> auto. Promotion admin-only, same criteria as
  `AUTONOMY_CRITERIA`. Auto-demote the same way.
- Auto-approve only if **all** hold: lane at auto; confidence >= threshold; no open blocking
  finding; no duplicate case; known party; open period; amount <= org cap; lines balance to the
  cent.
- Always human: new party, possible duplicate, closed or unusual period, failed read, bank
  matching, splits.
- Posts through the same editor save path with actor = Jev, recorded in `review_decisions`.
- Undo = reversing entry from the entry's own screen, never delete. Counts as a disagreement.
- Random spot-check sample (default 10%) returns to the Inbox. Without it, auto-approval deletes
  the human feedback signal that feeds evals and demotion.

### 7. Scorecard (testing)

One command: practice pile x (model chain, rule pack) ->

- real problems caught
- false alarms
- approved with zero edits
- Jev approvals a human would undo
- memory hit rate
- locked cases still passing (must be 100%)

Practice pile = `ai_eval_cases` (org-scoped; cross-org only with consent, as today).

### 8. Inbox screen

- One list, open states + `failed` only. `approved | rejected | dismissed` never render.
- Filter chips by reason: `needs_fix | jev_unsure | spot_check | failed`.
- Row: who, kind, relative date, amount, one reason chip.
- Pane: the existing editor for the classified kind, prefilled, plus a thin strip (reason,
  Remembered / Jev + confidence, Approve, Reject, "Remember this?", duplicate warning when
  present).

| Classified as  | Opens in                                    | Approve does                        |
| -------------- | ------------------------------------------- | ----------------------------------- |
| Vendor bill    | Bills editor (document viewer + line items) | Saves a real bill (fixes problem 1) |
| Paid expense   | `transactions_.new`, Pay out tab            | Saves payment                       |
| Money received | `transactions_.new`, Pay in tab             | Saves receipt                       |
| Transfer       | `transactions_.new`, Transfer tab           | Saves transfer                      |
| Anything else  | `transactions_.new`, Journal tab            | Saves journal                       |
| Sales invoice  | Invoice draft editor                        | Saves invoice                       |

- Link the saved entry back to its sources via `ledger_source_links`.
- Saved entries show a small "by Jev" / "remembered" tag in Bills and Transactions.
- Rejected sources stay findable under Documents.
- Settings gets: Routines, Rule packs (on/off, stop vs warn), Scorecard, Jev approval lanes.
- `/review-agents` redirects to `/inbox`; the posted-ledger scan becomes one Settings button.
  Move rule enable/impact config to Settings **before** removing the page.

## Review of the earlier pasted plans

- Agree: one queue, one primary action, hide Review Agents, move email setup out, drop jargon.
- Drop: "Needs you | Done". No Done folder.
- Fix: `failed` belongs in Needs you, not Done.
- Fix: "behavior unchanged, correctness 5/5" is too generous. Removing Review Agents removes the
  only rule-config UI and the ledger scan.
- Rethink: do not polish the old page in P1. Build the new screen once, on routines.
- Add: reuse existing editors and their save.
- Add: rule testing (packs, replay, scorecard) was missing from all three plans.

## Build order (one PR each, base `v2`)

1. **Hide Review Agents, redirect the old link.** Done when: no sidebar entry; `/review-agents`
   lands on `/inbox`. Rule config moved to Settings first, or explicitly deferred.
2. **Routines table; inbound email as the first webhook routine.** Done when: email arrives
   through a routine and the old path's tests pass.
3. **Schedule trigger.** Done when: the worker drain starts due routines, saves a cursor, and a
   double run creates no duplicate papers.
4. **Jev provider, first hop.** Done when: recorded Jev answers pass evals, confidence pinned
   0..1, Gemini still catches failures.
5. **Category and entity checks.** Done when: no routine without a chart; Jev returns only org
   accounts; no fit -> Uncategorized + blocking; look-alike parties resolved by Jev from top-5.
6. **Rule packs, replay, scorecard.** Done when: one command replays the pile under two packs and
   prints the metrics above.
7. **New Inbox screen from existing editors.** Done when: only items needing a human are listed;
   each opens the matching editor prefilled; Approve uses that editor's save (an emailed bill
   becomes a real bill); failed shows; Approve disabled while a blocking finding is open.
8. **Memory + "Remember this?".** Done when: a saved fix makes the same paper return the same
   answer with no model on the answer path, and the fix is a locked eval case.
9. **Jev approval, starting at watch.** Done when: "would approve" logged on every row; per-lane
   agreement on the scorecard; admin can unlock; undo posts a reversal and counts toward
   demotion.

## Rules for the building agent

- Every DB access through the org-context wrappers (`src/lib/server-context.ts`); background
  handlers use `withOrgContext(orgId, …)`.
- Money via `src/lib/money.ts`. Journal lines balance to the cent.
- Query keys from `src/lib/query-keys.ts`.
- Read `.agent/rules/schema-export-import.md` before adding tables.
- Posting accounts via `src/lib/coa/resolve-mapped-account.ts`, never by hardcoded subtype.
- `bun check` passes. Run the test tier matching the change.

## Open questions

- Jev's API shape, pricing, latency, and data-handling terms. Unverified.
- Whether Jev may ever read document bytes (would change the Gemini-only OCR decision).
- Default org amount cap for Jev auto-approval.
- Spot-check rate: fixed 10%, or decaying with lane accuracy.
