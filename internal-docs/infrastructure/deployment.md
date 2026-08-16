# Historical Buwiz Books deployment requirements

This application repository is not the canonical production deployment source.
The commands and workflow described below are historical/local validation aids,
not executable production instructions. The owner of the separate canonical
deployment repository must independently reconcile every target, secret binding,
migration, cutover, and live-verification gate. Never use resources or credentials
from another installation.

## Historical target assumptions to verify

| Resource                        | Required value         |
| :------------------------------ | :--------------------- |
| gcloud configuration            | `buwiz-books`          |
| GCP project                     | `buwiz-503321`         |
| Region                          | `europe-north1`        |
| Artifact Registry               | `buwiz-books-repo`     |
| Cloud Run service               | `buwiz-books`          |
| Cloud SQL instance              | `buwiz-books-db`       |
| Runtime service account         | `buwiz-books-runner`   |
| GitHub deployer service account | `buwiz-books-deployer` |
| Source build service account    | `buwiz-books-builder`  |
| Domain                          | `books.buwiz.com`      |

The Makefile, `scripts/provision-gcp.sh`, and deployment workflow in this repository
contain target guards, but those guards do not establish the canonical production
boundary or prove deployment readiness.

The dated billing and target notes in this file may be stale. Repository readiness
is not a live deployment.

## 1. Prerequisites

1. Enable billing on `buwiz-503321`.
2. Confirm the `buwiz-books` gcloud configuration targets that exact project.
3. Create fresh Buwiz-only Cloudflare R2, Google OAuth, and Resend resources.
4. Do not inspect, copy, export, or reuse another deployment's database,
   bucket, secrets, OAuth client, service account, or configuration.

The checked-in `.env.example` carries only identifiers and local placeholders.
Real secrets belong in the target project's Secret Manager.

## 2. Historical local provisioning helper

Do not use this application-repository helper for production. The canonical
deployment owner must provide and verify an equivalent isolated provisioning path.

```bash
make provision
```

The target-specific script verifies project state and billing before enabling
APIs or creating anything. It then provisions:

- regional Cloud SQL PostgreSQL 16 (`db-custom-1-3840`) with SSD auto-growth,
  backups, point-in-time recovery, and deletion protection;
- separate `buwiz_books_admin` and non-owner `app_runtime` database users;
- separate runtime and GitHub deployer service accounts;
- Artifact Registry and Cloud Scheduler access;
- a Workload Identity provider restricted to
  `goldcoders-corp/buwiz-books`; and
- lowercase Secret Manager entries shared by both deploy paths.

The script prints the three non-secret GitHub repository settings to configure:

- `GCP_PROJECT_ID`;
- `GCP_SERVICE_ACCOUNT`; and
- `GCP_WORKLOAD_IDENTITY_PROVIDER`.

Replace every `REPLACE_ME` version directly in `buwiz-503321` Secret Manager.
The deployment workflow rejects placeholders before migration. Never print
secret values into issues, commits, pull requests, or logs.

## 3. Non-secret runtime configuration

For local operator deployments:

```bash
cp .env.cloudrun.example.yaml .env.cloudrun.yaml
```

Keep credentials out of this file. It contains only ordinary Cloud Run env
values such as queue mode, loopback worker URL, and Business Group rollout
switches. `.env.cloudrun.yaml` is git-ignored.

Start Business Group reporting in rollback-safe mode:

```yaml
BUSINESS_GROUP_REPORT_SOURCE: "live"
BUSINESS_GROUP_PROJECTION_ACCOUNT_ALLOWLIST: "none"
```

The GitHub workflow reads the equivalent values from repository variables and
defaults to `live` and `none`.

## 4. Database migration requirements

For local validation, this repository exposes:

```bash
make migrate
```

This is not production authority. Historically, the command acquires a token from the named gcloud configuration, reads only
`database-url-admin` from the isolated project, and applies this fail-fast
order:

1. AI foundation;
2. Drizzle schema reconciliation;
3. Enterprise migrations `0028` through `0036` with checksum fencing;
4. integrity migration;
5. RLS policies;
6. non-owner runtime grants; and
7. review-rule catalog seed.

The canonical deployment must preserve the same order and checksum fencing.
`DATABASE_URL` mounted on the service is the non-owner runtime URL;
`DATABASE_URL_ADMIN` is reserved for migrations and the small set of explicitly
documented context-free server paths.

## 5. Deploy and verify

The historical application-repository workflow documents these requirements; it
is not the production CI path:

1. runs lint, typecheck, fresh schema/RLS setup, and all test tiers;
2. validates `GCP_PROJECT_ID` before cloud authentication;
3. builds and pushes the image to `buwiz-books-repo`;
4. migrates through the Cloud SQL Auth Proxy;
5. deploys `buwiz-books` with the exact Cloud SQL attachment and runtime SA;
6. creates or updates `buwiz-books-job-worker`; and
7. requires an HTTP-success response from the new service URL.

The guarded local path is:

```bash
make deploy-docker
make scheduler
make url
make logs
```

Verify authentication, organization isolation, ordinary ledger writes, email,
R2 uploads, worker drainage, and Business Group entitlement denial before
starting an Enterprise pilot.

## 6. Business Group canary

1. Backfill only the pilot Enterprise account and wait for every projection to
   be `ready` with matching requested/applied versions.
2. Set the global source to `shadow` and keep the allowlist empty.
3. Require zero unexplained reconciliation mismatches and no failed or overdue
   projection jobs.
4. Add only the pilot Enterprise account UUID to
   `BUSINESS_GROUP_PROJECTION_ACCOUNT_ALLOWLIST`.
5. Remove its UUID to return that account to shadow reads, or set the global
   source to `live` for a fleet-wide rollback.

See `docs/admin/enterprise-business-groups.md` for the complete acceptance
matrix and operator commands.

## 7. Domain and final acceptance

After the `run.app` URL is healthy:

```bash
make domain CLIENT_DOMAIN=books.buwiz.com
```

Apply only the DNS record Google returns, then verify certificate issuance,
`https://books.buwiz.com`, and the exact Google OAuth callback. A successful
build or Cloud Run revision is not sufficient: production is complete only
after DNS, HTTPS, integrations, scheduler, isolation, and canary gates pass.
