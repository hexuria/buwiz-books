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

8080 is the Cloud Run port in both deploy paths (`--port=8080` in the workflow,
`ENV PORT=8080` in the `Dockerfile`).

## Deployment

### Secrets

| Path                   | Secret Manager name     | Wired in                                    |
| :--------------------- | :---------------------- | :------------------------------------------ |
| GitHub Actions         | `inbox-worker-secret`   | `.github/workflows/deploy.yml` (`secrets:`) |
| `make deploy(-docker)` | `inbox-worker-secret`   | `Makefile` (`--set-secrets`)                |
| Cloud Scheduler header | copied from that secret | workflow or `make scheduler`                |

Both deployment paths use the same lowercase Secret Manager ID. `make provision`
generates it with `openssl rand -base64 32` and never overwrites an existing
value. All commands are scoped to gcloud configuration `buwiz-books`, project
`buwiz-503321`, and region `europe-north1`.

### Env vars

`JOB_DRAIN_MODE=off` and `INTERNAL_WORKER_URL=http://127.0.0.1:8080` ship with
the GitHub Actions deploy automatically (`env_vars:` block).

The Makefile path passes plain env vars through `.env.cloudrun.yaml` — gcloud
rejects `--set-env-vars` alongside `--env-vars-file`, and that file is
git-ignored, so **add both keys there by hand** before deploying:

```yaml
JOB_DRAIN_MODE: "off"
INTERNAL_WORKER_URL: "http://127.0.0.1:8080"
```

### Scheduler

The GitHub Actions deployment creates or updates the scheduler after Cloud Run
is healthy. The local idempotent operator path is:

```bash
make scheduler
```

Both paths create or update `buwiz-books-job-worker` and fail if the service or
secret is unavailable. The equivalent target-scoped raw command is:

```bash
gcloud --configuration=buwiz-books scheduler jobs create http buwiz-books-job-worker \
  --location=europe-north1 \
  --project=buwiz-503321 \
  --schedule="* * * * *" \
  --time-zone=UTC \
  --uri="$(gcloud --configuration=buwiz-books run services describe buwiz-books \
            --region=europe-north1 --project=buwiz-503321 \
            --format='value(status.url)')/api/internal/worker" \
  --http-method=POST \
  --message-body='{}' \
  --headers="Authorization=Bearer $(gcloud --configuration=buwiz-books secrets versions access latest \
              --secret=inbox-worker-secret --project=buwiz-503321),Content-Type=application/json" \
  --attempt-deadline=320s \
  --max-retry-attempts=0
```

`--max-retry-attempts=0` is deliberate. The route returns **500** when a job
fails, but that job has already been requeued with exponential backoff by the
runner. Scheduler retries would hammer a job that is intentionally sleeping —
and the next tick is only 60s away.

The scheduler job carries a **copy** of the secret in its header. Rotating
`inbox-worker-secret` without re-running `make scheduler` leaves the job
authenticating with the old value: every tick 401s and the queue stops draining.

There is no uppercase duplicate secret. A stale scheduler header after rotation
is repaired by the next deployment or `make scheduler`.

## Triage: "jobs are stuck"

Symptom: uploads/emails are accepted but nothing ever completes; rows pile up in
`processing_jobs` with `status = 'queued'`.

**1. Is the secret set on the service?**

```bash
gcloud --configuration=buwiz-books run services describe buwiz-books \
  --project=buwiz-503321 --region=europe-north1 \
  --format='value(spec.template.spec.containers[0].env)' | tr ',' '\n' | grep -i worker
```

No `INBOX_WORKER_SECRET` → the route returns `500 Inbox worker is not
configured.` and the self-trigger no-ops. Logs show
`Cannot trigger the job worker — queued jobs will not run` (once per instance).
Fix: add the secret to the deploy path and redeploy.

Also confirm `JOB_DRAIN_MODE` is `off` (or unset) and `INTERNAL_WORKER_URL`
points at loopback in the same output.

**2. Does the scheduler job exist, and did its last run succeed?**

```bash
gcloud --configuration=buwiz-books scheduler jobs describe buwiz-books-job-worker \
  --location=europe-north1 --project=buwiz-503321 \
  --format='yaml(state,schedule,lastAttemptTime,status,scheduleTime)'
```

- Not found → never created. Run `make scheduler`.
- `state: PAUSED` → resume `buwiz-books-job-worker` in the guarded project.
- `status.code: 16` / repeated 401s → the header secret and Secret Manager have
  diverged (rotation). Re-run `make scheduler`.
- `status.code: 2` with 500s → the worker is reaching a real job failure; go to
  step 3 and read `last_error`.

Scheduler attempt history:

```bash
gcloud --configuration=buwiz-books logging read \
  'resource.type="cloud_scheduler_job" AND resource.labels.job_id="buwiz-books-job-worker"' \
  --limit=20 --project=buwiz-503321 --format='value(timestamp,jsonPayload.status)'
```

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

For Business Group projection readiness and scoped full replay, use the
operator command documented in `docs/admin/enterprise-business-groups.md`:

```bash
DATABASE_URL_ADMIN=... bun run business-groups:projection --status
```

```sql
-- Why did they fail?
select job_type, attempts, max_attempts, last_error, updated_at
from processing_jobs
where status = 'failed'
order by updated_at desc
limit 20;
```

**4. Verify end to end by hand**

```bash
SERVICE_URL=$(gcloud --configuration=buwiz-books run services describe buwiz-books \
  --region=europe-north1 --project=buwiz-503321 --format='value(status.url)')
SECRET=$(gcloud --configuration=buwiz-books secrets versions access latest \
  --secret=inbox-worker-secret --project=buwiz-503321)

curl -sS -X POST "$SERVICE_URL/api/internal/worker" \
  -H "Authorization: Bearer $SECRET" \
  -H 'Content-Type: application/json' \
  -d '{}' -w '\nHTTP %{http_code}\n'
```

- `200` with a job result → the worker is healthy; the problem is the trigger.
- `401` → the deployed secret differs from Secret Manager (redeploy after a
  rotation).
- `500 Inbox worker is not configured.` → the secret is not on the service.

## Local development

Nothing to configure: `JOB_DRAIN_MODE` defaults to `inline`, so `bun dev` drains
its own queue every 2s and immediately on each enqueue. Set `JOB_DRAIN_MODE=off`
locally only to reproduce production behaviour — then jobs stay queued unless
you POST the route yourself with `INBOX_WORKER_SECRET` set in `.env`.
