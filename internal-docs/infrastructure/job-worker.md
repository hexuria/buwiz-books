# Job Worker & Scheduler

Every asynchronous piece of work in the app — inbound email ingestion,
attachment extraction, statement OCR, bbox scans, match-assist, AI reflection —
and Business Group reporting projections — is written to the `processing_jobs`
table and drained later by a **worker**.

Enqueueing always succeeds. Draining is a separate, configurable mechanism, and
if it is not wired up **jobs sit at `queued` forever with no error anywhere**.
That is the failure this page exists to prevent.

## The two drain mechanisms

`JOB_DRAIN_MODE` (read by `src/lib/jobs/drain-state.ts`) picks one:

| Mode     | What runs                                                                                                                          | Used by                |
| :------- | :--------------------------------------------------------------------------------------------------------------------------------- | :--------------------- |
| `inline` | An in-process loop (`src/lib/jobs/inline-drain.ts`) ticking every 2s, plus an immediate nudge on each enqueue. No secret required. | `bun dev`, e2e         |
| `off`    | Nothing in-process. An **external scheduler** must POST the worker route.                                                          | Production (Cloud Run) |

Unset it defaults to `inline` outside production, `off` in production, and is
forced `off` under test (a background drain would race the suites for the
pre-claimed rows they seed).

In `off` mode there are still two callers in practice:

1. **Cloud Scheduler**, once a minute — the backstop, and the only thing that
   recovers work after a crash, a redeploy, or a backoff sleep.
2. **The self-trigger** (`triggerWorker` in `src/lib/jobs/trigger.ts`), a
   fire-and-forget POST fired at enqueue time so interactive flows do not wait
   up to 60s. It is an optimisation, not a guarantee: it dies with the
   instance, and it silently does nothing without `INBOX_WORKER_SECRET`.

Both hit the same endpoint:

```text
POST /api/internal/worker
Authorization: Bearer <INBOX_WORKER_SECRET>
Content-Type: application/json

{}                      # or {"jobTypes": ["process_inbound_email"]}
```

One call drains at most `MAX_JOBS_PER_REQUEST` (5) jobs and returns. A minute
tick therefore floors throughput at 5 jobs/min; bursts above that are normally
absorbed by the self-trigger, and the backlog drains 5-per-tick regardless.
Projection work processes at most 31 dirty dates per pass and requeues its
leased job when more dates remain, so a historical backfill may span several
bounded worker calls.

### Why `INTERNAL_WORKER_URL` matters

`workerUrl()` falls back to `BETTER_AUTH_URL` when `INTERNAL_WORKER_URL` is
unset. On Cloud Run that is the public hostname, so the instance would call
_itself_ out through the load balancer and back: a billable round trip that can
cold-start a **second** instance against `--max-instances=3`. Always set it to
the loopback address of the container's own port:

```
INTERNAL_WORKER_URL=http://127.0.0.1:8080
```

8080 is the container port recorded by `ENV PORT=8080` in the `Dockerfile`.
The canonical deployment repository must verify and wire the same loopback port.

## Production deployment contract

This section describes required behavior, not commands to run from this
application checkout. Its cloud workflow is CI-only and its deployment,
provisioning, scheduler, and environment Make targets fail closed. The
unattached canonical deployment repository must implement and verify this
contract.

### Secrets

The canonical deployment must mount one `inbox-worker-secret` value as
`INBOX_WORKER_SECRET` and copy that same value into the external scheduler's
authorization header. Rotation must update both consumers atomically or keep the
service fenced until both are verified.

### Env vars

The canonical deployment must set these non-secret runtime values:

```yaml
JOB_DRAIN_MODE: "off"
INTERNAL_WORKER_URL: "http://127.0.0.1:8080"
```

### Scheduler

The canonical deployment must create or update the external scheduler only after
the no-traffic service revision is healthy. It must target
`POST /api/internal/worker` once a minute with the shared authorization secret,
an empty JSON body, a 320-second deadline, and provider retries disabled.

`--max-retry-attempts=0` is deliberate. The route returns **500** when a job
fails, but that job has already been requeued with exponential backoff by the
runner. Scheduler retries would hammer a job that is intentionally sleeping —
and the next tick is only 60s away.

The scheduler job carries a **copy** of the secret in its header. Rotating
`inbox-worker-secret` without updating the scheduler leaves it authenticating
with the old value: every tick 401s and the queue stops draining.

There is no uppercase duplicate secret. The canonical deployment must detect and
repair a stale scheduler header during rotation or cutover.

## Triage contract: "jobs are stuck"

Live diagnostics are production operations and belong to the canonical
deployment runbook. The observations below identify what that runbook must
check; the historical cloud commands have been removed from this document.

Symptom: uploads/emails are accepted but nothing ever completes; rows pile up in
`processing_jobs` with `status = 'queued'`.

**1. Is the secret set on the service?**

No `INBOX_WORKER_SECRET` → the route returns `500 Inbox worker is not
configured.` and the self-trigger no-ops. Logs show
`Cannot trigger the job worker — queued jobs will not run` (once per instance).
Fix: add the secret to the deploy path and redeploy.

Also confirm `JOB_DRAIN_MODE` is `off` (or unset) and `INTERNAL_WORKER_URL`
points at loopback in the same output.

**2. Does the scheduler job exist, and did its last run succeed?**

- Not found → the canonical deployment never created it or cutover did not finish.
- `state: PAUSED` → resume `buwiz-books-job-worker` in the guarded project.
- `status.code: 16` / repeated 401s → the header secret and Secret Manager have
  diverged during rotation. Repair it through the canonical runbook.
- `status.code: 2` with 500s → the worker is reaching a real job failure; go to
  step 3 and read `last_error`.

**3. What does the queue itself say?**

```sql
-- Backlog by type and status, oldest first
select job_type, status, count(*), min(run_at) as oldest_due
from processing_jobs
where status in ('queued', 'running')
group by 1, 2
order by oldest_due;
```

- `queued` rows with `run_at` far in the **past** → nothing is draining. The
  worker is not being called at all: steps 1–2.
- `queued` rows with `run_at` in the **future** → backoff, working as intended.
  Check `attempts` / `last_error`; they will retry on their own.
- `running` rows with `locked_until` in the past → an instance died mid-job.
  These self-recover: the claim query reclaims a running job once its 5-minute
  lease expires (`DEFAULT_PROCESSING_JOB_LEASE_MS`). No manual intervention —
  just confirm a worker is actually ticking.
- `status = 'failed'` → attempts exhausted (`max_attempts`, default 8) and the
  job was terminalized along with its ingestion event, source, Inbox item, and
  audit event. Read `last_error`; these do not retry.

The canonical runbook must include read-only Business Group projection readiness
for the reviewed scope, as specified in `docs/admin/enterprise-business-groups.md`.

```sql
-- Why did they fail?
select job_type, attempts, max_attempts, last_error, updated_at
from processing_jobs
where status = 'failed'
order by updated_at desc
limit 20;
```

**4. Verify end to end through the canonical runbook**

Issue one authenticated empty-JSON worker request without printing the secret.

- `200` with a job result → the worker is healthy; the problem is the trigger.
- `401` → the deployed secret differs from Secret Manager (redeploy after a
  rotation).
- `500 Inbox worker is not configured.` → the secret is not on the service.

## Local development

Nothing to configure: `JOB_DRAIN_MODE` defaults to `inline`, so `bun dev` drains
its own queue every 2s and immediately on each enqueue. Set `JOB_DRAIN_MODE=off`
locally only to reproduce production behaviour — then jobs stay queued unless
you POST the route yourself with `INBOX_WORKER_SECRET` set in `.env`.
