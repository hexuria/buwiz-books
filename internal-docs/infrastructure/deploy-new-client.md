# Deploy a New Client (White-Label)

> [!WARNING]
> This generic white-label playbook is not the production runbook for this
> checkout. Its Makefile and cloud scripts are locked to the isolated
> `books.buwiz.com` target. Use `internal-docs/infrastructure/deployment.md` for
> Buwiz Books; do not repoint this checkout at another client's project.

End-to-end guide: from cloning the repo to a live, branded deployment in the
client's own GCP project. Total time: ~20 minutes (most of that is Cloud SQL
instance creation and DNS propagation).

---

## Prerequisites

| Tool              | Install                                                               |
| ----------------- | --------------------------------------------------------------------- |
| `gcloud` CLI      | https://cloud.google.com/sdk/docs/install                             |
| `cloud-sql-proxy` | https://cloud.google.com/sql/docs/postgres/connect-auth-proxy#install |
| `bun`             | https://bun.sh                                                        |
| `psql`            | Bundled with most Postgres installers                                 |

You need billing-enabled access to the **client's GCP project** (Editor or Owner).

---

## Step 1 — Clone and initialize

```bash
git clone git@github.com:goldcoders-corp/buwiz-books.git acme-deploy
cd acme-deploy
bash scripts/new-client.sh
```

`new-client.sh` prompts for:

- Client name, slug, domain
- GCP project ID and region
- Branding (colors, logo, support email)

It writes three gitignored config files:
| File | Purpose |
|------|---------|
| `.env` | Operator vars (GCP project, region, infra names, local branding) |
| `.env.production` | Build-time `VITE_*` branding — uploaded to Cloud Build |
| `.env.cloudrun.yaml` | Non-secret runtime env for Cloud Run |

---

## Step 2 — Provision GCP infrastructure

```bash
make provision
```

This runs `scripts/provision-gcp.sh`, which creates (idempotently):

- Required APIs enabled
- Artifact Registry Docker repo
- Cloud SQL Postgres instance + database + app user
- Runtime service account with minimal IAM roles
- Secret Manager secrets (`database-url` auto-populated; others are placeholders)

---

## Step 3 — Populate secrets

The provision script prints the exact commands. Fill in real values:

```bash
# Resend (email)
printf 're_your_key' | gcloud secrets versions add resend-api-key --data-file=- --project=CLIENT_PROJECT

# Google OAuth
printf 'YOUR_CLIENT_ID' | gcloud secrets versions add google-oauth-client-id --data-file=- --project=CLIENT_PROJECT
printf 'YOUR_SECRET'    | gcloud secrets versions add google-oauth-client-secret --data-file=- --project=CLIENT_PROJECT

# Cloudflare R2 storage
printf 'YOUR_KEY_ID' | gcloud secrets versions add r2-access-key-id --data-file=- --project=CLIENT_PROJECT
printf 'YOUR_SECRET' | gcloud secrets versions add r2-secret-access-key --data-file=- --project=CLIENT_PROJECT
```

Also update `.env.cloudrun.yaml` with the real `R2_ENDPOINT` and `R2_BUCKET`.

> **Gemini (AI OCR) is NOT a deployment secret.** Gemini API keys are configured
> per-organization inside the app (Settings → AI Credentials) and stored in the
> database, not in Secret Manager. Each client org adds their own keys after sign-in.

---

## Step 4 — Migrate the database

```bash
make migrate
```

This:

1. Starts the Cloud SQL Auth Proxy locally (port 5433)
2. Retrieves the `database-url` secret, rewrites it to localhost
3. Runs `drizzle-kit push --force` (schema)
4. Runs `psql -f drizzle/rls_policies.sql` (RLS policies)
5. Stops the proxy

Verify with: `make migrate` again (should be a no-op / "No changes").

---

## Step 5 — Deploy to Cloud Run

```bash
make deploy
```

This uploads the source to Cloud Build, builds the Docker image, and deploys to
Cloud Run with:

- `--add-cloudsql-instances` (mounts the Unix socket)
- `--set-secrets` (injects secrets from Secret Manager)
- `--env-vars-file .env.cloudrun.yaml` (non-secret runtime env)

After deploy, `make url` prints the Cloud Run URL. Verify the app loads.

---

## Step 6 — Map custom domain

```bash
make domain
```

Prints the CNAME the client must add:

```
app.acme.com  →  ghs.googlehosted.com.
```

SSL is auto-provisioned by Cloud Run once DNS propagates (~15 minutes).

---

## Step 7 — Client credential checklist

Hand this to the client (or set up on their behalf):

| Service           | What they provide / configure                                                                                                                      |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Google OAuth**  | Create OAuth 2.0 Client in their GCP project. Authorized JS origin: `https://<domain>`. Redirect URI: `https://<domain>/api/auth/callback/google`. |
| **Resend**        | Verified sender domain. API key → Secret Manager.                                                                                                  |
| **Cloudflare R2** | Bucket + API token (Object R/W). Update `.env.cloudrun.yaml` with endpoint + bucket name.                                                          |
| **Gemini**        | API key for AI receipt/statement OCR. Configured **in-app** (Settings → AI Credentials) after sign-in — NOT a deployment secret.                   |
| **DNS**           | CNAME `<domain>` → `ghs.googlehosted.com.`                                                                                                         |

---

## Post-deploy operations

| Task                            | Command                                    |
| ------------------------------- | ------------------------------------------ |
| Push env var changes            | `make env`                                 |
| Tail Cloud Run logs             | `make logs`                                |
| Re-migrate after schema changes | `make migrate`                             |
| Promote a user to admin         | `make promote-prod email=user@example.com` |
| Redeploy after code changes     | `make deploy`                              |

---

## Architecture summary

```
Client domain → Cloud Run (1 service)
                    ├── Cloud SQL (Unix socket /cloudsql/...)
                    ├── Secret Manager (DB URL, API keys, OAuth)
                    ├── Cloudflare R2 (shared storage, external)
                    └── Branding baked at build time (VITE_*)
```

Each client = own GCP project, own Cloud SQL, own secrets. The repo is the same
codebase; per-client identity lives in gitignored config files. No tenants table,
no host-header routing.
