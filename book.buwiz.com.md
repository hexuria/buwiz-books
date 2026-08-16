# `books.buwiz.com` deployment handoff

Status: deferred  
Target repository: `goldcoders-corp/buwiz-books`  
Target hostname: `books.buwiz.com`  
Last reviewed: 2026-07-24

## Goal

Deploy the `goldcoders-corp/buwiz-books` repository as an independent Buwiz
Books installation on Google Cloud Run, using a new Google account and GCP
project dedicated to this deployment. Route `books.buwiz.com`, which is managed
in Cloudflare, to that Cloud Run service.

The existing `codeitlikemiley/buwiz-books` deployment and
`digits.mvgreenland.com` must remain unchanged.

## Hard isolation rule

- Do not read, list, export, copy, or reuse secrets, databases, buckets,
  credentials, OAuth clients, service accounts, or configuration from any
  existing deployment.
- Create every application dependency specifically for Buwiz.
- Do not rely on the shell's ambient gcloud account or project. Every Buwiz
  command must explicitly select the `buwiz-books` configuration and
  `buwiz-503321` project.
- Do not add GitHub deployment credentials until their repository and project
  restrictions have been verified.

## Current state

- [x] Created the private GitHub repository:
      `https://github.com/goldcoders-corp/buwiz-books`
- [x] Published the existing source repository's `main` branch at commit
      `bf42c5dea5808bc9d65a4180f0c206ad2a9e1393`.
- [x] Confirmed GitHub Actions are enabled for the repository.
- [x] Confirmed the deployment workflow is designed for GitHub Workload
      Identity Federation and Cloud Run.
- [ ] No successful Cloud Run deployment exists for the organization
      repository.
- [ ] No Cloud Run custom-domain mapping exists for `books.buwiz.com`.
- [ ] No Cloudflare DNS record was changed.

### Configuration that must be replaced

An initial setup was started against GCP project
`project-f9c8eb6d-8aee-4e7c-85f`. It created:

- service account `digits-runner@project-f9c8eb6d-8aee-4e7c-85f.iam.gserviceaccount.com`;
- Workload Identity pool `github-actions`;
- provider `buwiz-books`;
- IAM bindings for Cloud Run, Artifact Registry, Secret Manager, and service
  usage;
- GitHub secrets `GCP_PROJECT_ID`, `GCP_SERVICE_ACCOUNT`, and
  `GCP_WORKLOAD_IDENTITY_PROVIDER`;
- GitHub variable `GCP_REGION=europe-north1`.

That project's linked billing account is closed. Secret Manager, Artifact
Registry, and Cloud Run rejected further provisioning. Treat this setup as
disposable. When the dedicated project is ready, replace all three GitHub
secrets with values from the new project.

The first GitHub Actions run also ended with `startup_failure`:
`https://github.com/goldcoders-corp/buwiz-books/actions/runs/30044239169`.
Recheck the organization's private-repository Actions allowance before the
first real deployment.

## Decisions required before provisioning

- [ ] Record the new Google account email.
- [ ] Record the new GCP project ID and project number.
- [ ] Attach an active billing account to the new project.
- [ ] Confirm the Cloud Run region. Use `europe-north1` unless there is a
      latency, data-residency, or cost reason to choose another region.
- [ ] Decide whether the deployment is fully isolated from
      `digits.mvgreenland.com`.

This must be a fully independent installation with its own database, Better
Auth secret, Google OAuth client, R2 bucket, and Resend credentials. Existing
production values are out of scope and must not be accessed or copied.

## Phase 1 — Create the dedicated GCP project

- [ ] Create the project under the new Google account.
- [ ] Enable billing and verify that `billingEnabled` is true.
- [ ] Set the active project and account locally.
- [ ] Enable these APIs:
  - `artifactregistry.googleapis.com`
  - `run.googleapis.com`
  - `secretmanager.googleapis.com`
  - `iam.googleapis.com`
  - `iamcredentials.googleapis.com`
  - `sts.googleapis.com`
- [ ] Create the Artifact Registry Docker repository `digits-repo` in the
      selected region.
- [ ] Create service account `digits-runner`.
- [ ] Grant the deployment/runtime account:
  - `roles/artifactregistry.writer`
  - `roles/run.admin`
  - `roles/secretmanager.secretAccessor`
  - `roles/serviceusage.serviceUsageConsumer`
- [ ] Grant the deployer permission to act as the Cloud Run runtime service
      account with `roles/iam.serviceAccountUser`.

## Phase 2 — Configure keyless GitHub authentication

- [ ] Create Workload Identity pool `github-actions`.
- [ ] Create OIDC provider `buwiz-books` with issuer
      `https://token.actions.githubusercontent.com`.
- [ ] Map `google.subject`, `attribute.actor`, `attribute.repository`, and
      `attribute.repository_owner`.
- [ ] Restrict the provider to the exact repository:
      `assertion.repository == 'goldcoders-corp/buwiz-books'`.
- [ ] Grant `roles/iam.workloadIdentityUser` on `digits-runner` to:

  `principalSet://iam.googleapis.com/projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/attribute.repository/goldcoders-corp/buwiz-books`

- [ ] Replace these GitHub repository secrets:
  - `GCP_PROJECT_ID`
  - `GCP_SERVICE_ACCOUNT`
  - `GCP_WORKLOAD_IDENTITY_PROVIDER`
- [ ] Set repository variable `GCP_REGION`.
- [ ] Do not create or download a long-lived service-account JSON key.

Expected provider value:

```text
projects/PROJECT_NUMBER/locations/global/workloadIdentityPools/github-actions/providers/buwiz-books
```

## Phase 3 — Provision data and application secrets

- [ ] Create a dedicated PostgreSQL/Neon database.
- [ ] Create a dedicated Cloudflare R2 bucket and object read/write token.
- [ ] Verify the sending domain in Resend and create a deployment-specific API
      key.
- [ ] Generate a new `BETTER_AUTH_SECRET`.
- [ ] Set `BETTER_AUTH_URL` to `https://books.buwiz.com`.
- [ ] Create a Google OAuth web client in the new GCP project.
- [ ] Create these Secret Manager secrets with at least one enabled version:
  - `DATABASE_URL`
  - `BETTER_AUTH_SECRET`
  - `BETTER_AUTH_URL`
  - `GOOGLE_CLIENT_ID`
  - `GOOGLE_CLIENT_SECRET`
  - `R2_BUCKET`
  - `R2_ACCESS_KEY_ID`
  - `R2_SECRET_ACCESS_KEY`
  - `R2_ENDPOINT`
  - `RESEND_API_KEY`
  - `MAIL_FROM`
- [ ] Confirm the `digits-runner` service account can access every secret.
- [ ] Never paste secret values into this document, a Git commit, workflow
      logs, or a pull request.

Google OAuth configuration:

```text
Authorized JavaScript origin:
https://books.buwiz.com

Authorized redirect URI:
https://books.buwiz.com/api/auth/callback/google
```

## Phase 4 — Validate and deploy

- [ ] Review `.github/workflows/deploy.yml` on the organization repository's
      `main` branch.
- [ ] Confirm its registry path matches `digits-repo`.
- [ ] Confirm it uses the new service account as the Cloud Run runtime account.
- [ ] Resolve the GitHub Actions `startup_failure`. Check organization Actions
      usage/billing if the workflow still fails before creating any job.
- [ ] Run the test job and require lint, typecheck, unit, and integration tests
      to pass.
- [ ] Review the production schema diff before allowing
      `drizzle-kit push --force`; it can make destructive schema changes.
- [ ] Run the deployment workflow manually.
- [ ] Confirm Artifact Registry contains images for the deployed commit.
- [ ] Confirm Cloud Run service `digits` has a ready revision and sends 100% of
      traffic to it.
- [ ] Confirm the generated `run.app` URL returns HTTP 200.
- [ ] Inspect Cloud Run logs for startup, database, secret-access, and storage
      errors.

Suggested deployment trigger:

```bash
gh workflow run deploy.yml --repo goldcoders-corp/buwiz-books
gh run watch --repo goldcoders-corp/buwiz-books
```

## Phase 5 — Map `books.buwiz.com`

- [ ] Verify `buwiz.com` ownership for the Google account that owns the new GCP
      project if Cloud Run requests domain verification.
- [ ] Create the Cloud Run domain mapping for `books.buwiz.com`.
- [ ] Read the mapping's required DNS records from GCP; do not guess them.
- [ ] In Cloudflare DNS, create the returned record. The expected subdomain
      shape is normally:

  ```text
  Type: CNAME
  Name: books
  Target: ghs.googlehosted.com
  ```

- [ ] Keep the Cloudflare record DNS-only while Google validates the hostname
      and provisions its certificate.
- [ ] Wait until the Cloud Run domain mapping reports ready and the certificate
      is active.
- [ ] Confirm `https://books.buwiz.com` returns HTTP 200.
- [ ] If Cloudflare proxying is later enabled, use Full (strict) SSL and repeat
      all HTTP, redirect, upload, and authentication checks.

Cloudflare access was not configured in the original session: the Cloudflare
plugin was unavailable, Wrangler was logged out, and the browser required
sign-in. Authenticate through the Cloudflare dashboard or provide a narrowly
scoped API token that can edit DNS for `buwiz.com`.

## Phase 6 — Production acceptance

- [ ] Homepage and login page load without mixed-content or redirect errors.
- [ ] Email OTP delivery and sign-in work.
- [ ] Google sign-in returns through the new callback URI.
- [ ] Sign-out and session refresh work on `books.buwiz.com`.
- [ ] Create a disposable organization and verify onboarding.
- [ ] Create an account, entity, invoice, bill, and journal transaction.
- [ ] Upload and retrieve a disposable document through the new R2 bucket.
- [ ] Verify database row-level security and cross-organization isolation.
- [ ] Verify transactional email uses the intended sender.
- [ ] Verify no credentials appear in GitHub Actions or Cloud Run logs.
- [ ] Confirm the old `digits.mvgreenland.com` deployment still returns HTTP
      200 and was not modified.

## Cleanup after successful cutover

- [ ] Remove the obsolete GCP secrets from the GitHub organization repository
      by replacing them, not by leaving two competing configurations.
- [ ] If `project-f9c8eb6d-8aee-4e7c-85f` will not be used, remove its
      `github-actions` Workload Identity pool and `digits-runner` service account,
      or delete the unused project through the normal recoverable project shutdown
      process.
- [ ] Remove any temporary Cloudflare credentials used for setup.
- [ ] Record the final GCP project ID, region, Cloud Run service URL, deployed
      commit, and production verification date in this document.

## Definition of done

The task is complete only when:

1. GitHub Actions succeeds from tests through deployment.
2. Cloud Run reports a ready revision with 100% traffic.
3. `https://books.buwiz.com` returns HTTP 200 with a valid certificate.
4. Authentication, email, database operations, and R2 uploads work.
5. The existing `digits.mvgreenland.com` deployment remains healthy.
