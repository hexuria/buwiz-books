# Inbox review workflow

All newly submitted accounting transactions enter **Inbox** before they can
become posted journal entries. This applies to manual entry, CSV imports,
scanned documents, bills, and inbound email.

## Lifecycle

1. The source payload is recorded with a stable external ID and content hash.
2. A balanced transaction candidate is created without changing the ledger.
3. Book rules run immediately and create findings against the Inbox item.
4. A reviewer can correct extracted accounting fields and heuristic event type,
   resolves blocking Book findings, and approves or rejects the item.
5. Approval locks the Inbox item and candidate, revalidates the accounting
   period and balance, then creates the posted journal atomically.

Review rules are not part of this lifecycle. They run on demand across the
posted ledger and attach to journals and account-months rather than to Inbox
items — see [Review agents](#review-agents) below.

Exact duplicate provider records are idempotent. Possible cross-source
duplicates create a blocking finding and must be reviewed. Whether semantic
matches block or are only recorded depends on the `possible_duplicate` agent's
`mode` (`enforce` / `shadow` / `off`), which is per-organization and defaults to
`enforce`; `bun db:review-rules:status` reports the effective value for a given
database. Operational deployment, backfill, matcher thresholds, and safe merge
behavior are described in
[Transaction deduplication operations](./transaction-deduplication.md).

## Review policy

- **Book rules** detect missing or invalid accounting data. A finding with
  `blocking` impact prevents approval until it is resolved; a `warning` stays
  visible and lets approval through.
- **Review rules** detect anomalies across posted journals. They never gate an
  individual approval. A `blocking` review finding gates **period close**, and
  only for the period it falls in.
- Organizations can require a different submitter and approver. An owner can
  override that policy only when owner overrides are enabled and a reason is
  recorded.

Impact is per-agent and per-organization, and the group only supplies the
default. A rule's group determines _when it runs_, not how hard it bites.

## Review agents

The **Review Agents** page configures the rule catalog and shows what each rule
has flagged. Two groups, two moments:

| Group      | Count | Runs                                                                   | Findings attach to            |
| ---------- | ----- | ---------------------------------------------------------------------- | ----------------------------- |
| **Book**   | 9     | Automatically, on every candidate at ingest and after every correction | The Inbox item                |
| **Review** | 5     | Only when someone presses **Run review agents**                        | A journal or an account-month |
| **System** | 2     | Raised by inbound processing. Not configurable, not runnable           | The Inbox item                |

Group is not a perfect proxy for cadence, and the UI states the cadence per
agent rather than deriving it: `transaction_in_parent_category` is a Review rule
that _also_ runs at ingest, and `low_confidence_category` is a Book rule the
on-demand run can never evaluate, because it reads a classifier confidence score
that does not survive posting.

### Resolving findings

A Book finding clears in one of two ways: **correct the entry**, which re-runs
the rules and auto-resolves anything no longer true, or **document an
exception** with a note of at least three characters. Possible duplicates accept
neither — they require a structured decision in the duplicate comparison view.

A Review finding has no Inbox item, so it is resolved in place from the findings
panel on **Review Agents**, with the same note requirement. Resolving is
permanent: a later run that observes the same condition advances `lastSeenAt`
but does not reopen the finding, because re-observing a fact a reviewer already
documented an exception for is not new information.

### The on-demand run

**Run review agents** evaluates only the five Review rules, as of a date you
choose — set it to a period end to reproduce a close. Book rules are excluded
deliberately: they already ran at ingest, against the candidate, at the only
point where their findings could still be acted on. Running them across posted
journals produced blocking findings on entries that can no longer be un-posted.

### The catalog

`review_rule_definitions` is a **global** table — no `organization_id`, and
excluded from every RLS policy — so one empty table means every organization
sees zero agents. It is seeded from `src/lib/inbox/review-rule-catalog.ts` on
every path that builds a database. If the page reports that no agents are set
up, inspect the database before anything else:

```bash
bun db:review-rules:status
```

See [Database Operations](../internal-docs/infrastructure/database.md) for the
production procedure.

## Inbound email

Each organization can configure its exact inbound recipient in **Inbox
settings**. Point a Resend inbound-email webhook at:

```text
POST /api/inbound-email/resend
```

Configure `RESEND_API_KEY` and `RESEND_WEBHOOK_SECRET`. Queued email and
attachment jobs are drained by a worker endpoint:

```text
POST /api/internal/worker
Authorization: Bearer <INBOX_WORKER_SECRET>
```

In production a Cloud Scheduler job calls it every minute; in development an
in-process drain runs instead (`JOB_DRAIN_MODE=inline`). If neither is active,
inbound email is accepted and then never processed — the jobs stay `queued`
indefinitely. Deployment, the exact schedule, and the "jobs are stuck" triage
flow are in the [job worker runbook](../internal-docs/infrastructure/job-worker.md).

The worker downloads the email and attachments, stores evidence in the document
vault, and leaves the candidate in `needs_information` for accounting review.
The endpoint is safe to poll: it claims one queued job at a time and retries
failed jobs with backoff. A crashed final lease atomically marks the job,
ingestion event, source, Inbox item, finding, and audit event as failed. An
exact webhook replay can requeue that work only while the original failure and
candidate are still open; it cannot reopen an approved or rejected lifecycle.

Event classes inferred from email text, OCR, or document extraction are
reviewer-editable and every change is audited. Provider-owned payment, payroll,
transfer, bill, and invoice identities remain protected from silent rewriting.
Rejecting a reviewable failure retires its unposted candidate and unshared
origin evidence so it cannot reopen duplicate cases later.

## Current integration boundary

This release includes the normalized source, connection, ingestion, evidence,
candidate, review, and ledger-linking foundation. Manual entry, both CSV
importers, bills, scans/documents, and inbound email use that foundation.
Provider OAuth and sync adapters for bank/card, Ramp, Gusto, Stripe, and other
external systems remain separate connector work; their records should enter
through the same source-record and candidate pipeline.
