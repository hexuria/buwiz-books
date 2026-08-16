# ── Buwiz Books — Makefile ───────────────────────────────────────────────────────
#
# Loads .env automatically so CLOUDSDK_ACTIVE_CONFIG_NAME is set for every
# gcloud call — no manual `gcloud config configurations activate` needed.
#
# Usage:
#   make deploy       → Cloud Build: upload source → build on GCP → deploy
#   make deploy-docker→ Local Docker: build → push → deploy (requires Docker)
#   make scheduler    → Create/refresh the Cloud Scheduler job-worker tick
#   make env          → Push env vars to Cloud Run (no redeploy)
#   make run          → Start local dev server
#   make logs         → Tail Cloud Run logs
#   make url          → Print the live service URL
#   make open         → Open the live service in the browser

# ── Load .env ────────────────────────────────────────────────────────────────
ifneq (,$(wildcard .env))
  include .env
  export
endif

# ── Isolated production boundary ────────────────────────────────────────────
EXPECTED_GCP_PROJECT_ID := buwiz-503321
EXPECTED_GCLOUD_CONFIG  := buwiz-books
EXPECTED_GCP_REGION     := europe-north1

# CLI overrides are accepted only so the guard can reject a wrong target with
# a clear error before any mutating command runs.
GCP_PROJECT            ?= $(if $(GCP_PROJECT_ID),$(GCP_PROJECT_ID),$(EXPECTED_GCP_PROJECT_ID))
GCP_REGION             ?= $(EXPECTED_GCP_REGION)
GCP_REPO               ?= buwiz-books-repo
SERVICE_NAME           ?= buwiz-books
CLOUDSDK_ACTIVE_CONFIG_NAME ?= $(EXPECTED_GCLOUD_CONFIG)
SERVICE_ACCOUNT        ?= $(SERVICE_NAME)-runner@$(GCP_PROJECT).iam.gserviceaccount.com
BUILD_SERVICE_ACCOUNT  ?= buwiz-books-builder@$(GCP_PROJECT).iam.gserviceaccount.com
IMAGE                  := $(GCP_REGION)-docker.pkg.dev/$(GCP_PROJECT)/$(GCP_REPO)/$(SERVICE_NAME):latest
PLATFORM               := linux/amd64
GCLOUD                 := gcloud --configuration=$(CLOUDSDK_ACTIVE_CONFIG_NAME) --project=$(GCP_PROJECT) --quiet

# Cloud SQL (populated by scripts/new-client.sh / scripts/provision-gcp.sh)
CLOUD_SQL_CONNECTION_NAME ?= buwiz-503321:europe-north1:buwiz-books-db
DB_INSTANCE            ?= buwiz-books-db
DB_NAME                ?= buwiz_books
CLIENT_DOMAIN          ?= books.buwiz.com

# Colour helpers
BOLD  := \033[1m
RESET := \033[0m
GREEN := \033[32m
CYAN  := \033[36m

.PHONY: help run build push deploy deploy-docker scheduler env logs url open check db-prod rls-prod promote promote-prod provision migrate domain _gcp_guard

## ── Guard: fail fast with a clear message if GCP vars are missing ───────────
_gcp_guard:
	@test "$(GCP_PROJECT)" = "$(EXPECTED_GCP_PROJECT_ID)" || \
	  (echo "\033[31m✘ Refusing GCP project '$(GCP_PROJECT)'; expected '$(EXPECTED_GCP_PROJECT_ID)'.\033[0m"; exit 1)
	@test "$(CLOUDSDK_ACTIVE_CONFIG_NAME)" = "$(EXPECTED_GCLOUD_CONFIG)" || \
	  (echo "\033[31m✘ Refusing gcloud config '$(CLOUDSDK_ACTIVE_CONFIG_NAME)'; expected '$(EXPECTED_GCLOUD_CONFIG)'.\033[0m"; exit 1)
	@test "$(GCP_REGION)" = "$(EXPECTED_GCP_REGION)" || \
	  (echo "\033[31m✘ Refusing GCP region '$(GCP_REGION)'; expected '$(EXPECTED_GCP_REGION)'.\033[0m"; exit 1)
	@test "$(GCP_REPO)" = "buwiz-books-repo" || \
	  (echo "\033[31m✘ Refusing Artifact Registry '$(GCP_REPO)'.\033[0m"; exit 1)
	@test "$(SERVICE_NAME)" = "buwiz-books" || \
	  (echo "\033[31m✘ Refusing Cloud Run service '$(SERVICE_NAME)'.\033[0m"; exit 1)
	@ACTIVE_PROJECT=$$(gcloud --configuration=$(CLOUDSDK_ACTIVE_CONFIG_NAME) config get-value project 2>/dev/null); \
	  test "$$ACTIVE_PROJECT" = "$(EXPECTED_GCP_PROJECT_ID)" || \
	  (echo "\033[31m✘ Named gcloud config targets '$$ACTIVE_PROJECT', not '$(EXPECTED_GCP_PROJECT_ID)'.\033[0m"; exit 1)

## ── Default target ──────────────────────────────────────────────────────────
help:
	@echo ""
	@echo "$(BOLD)Buwiz Books — available targets$(RESET)"
	@echo ""
	@echo "  $(BOLD)White-label deployment:$(RESET)"
	@echo "  $(CYAN)make provision$(RESET)     Create Cloud SQL, Artifact Registry, SA, secrets"
	@echo "  $(CYAN)make migrate$(RESET)       Push schema + RLS to Cloud SQL (via Auth Proxy)"
	@echo "  $(CYAN)make deploy$(RESET)        Deploy via Cloud Build (no Docker needed)"
	@echo "  $(CYAN)make scheduler$(RESET)     Create/refresh the job-worker tick (run after deploy)"
	@echo "  $(CYAN)make domain$(RESET)        Map a custom domain to Cloud Run"
	@echo ""
	@echo "  $(BOLD)Development:$(RESET)"
	@echo "  $(CYAN)make run$(RESET)           Start local dev server"
	@echo "  $(CYAN)make check$(RESET)         Run lint + format + typecheck"
	@echo ""
	@echo "  $(BOLD)Operations:$(RESET)"
	@echo "  $(CYAN)make deploy-docker$(RESET) Deploy via local Docker build"
	@echo "  $(CYAN)make env$(RESET)           Push env vars to Cloud Run (no redeploy)"
	@echo "  $(CYAN)make logs$(RESET)          Tail Cloud Run logs"
	@echo "  $(CYAN)make url$(RESET)           Print the live service URL"
	@echo "  $(CYAN)make open$(RESET)          Open the live service in browser"
	@echo "  $(CYAN)make promote$(RESET)       Promote user to admin (local DB)"
	@echo ""
	@echo "  Active gcloud config: $(BOLD)$(CLOUDSDK_ACTIVE_CONFIG_NAME)$(RESET)"
	@echo "  GCP project:          $(BOLD)$(GCP_PROJECT)$(RESET)"
	@echo ""

## ── Local dev ───────────────────────────────────────────────────────────────
run:
	bun dev

## ── Code quality ────────────────────────────────────────────────────────────
check:
	bun check

## ── Docker (optional, for local builds) ─────────────────────────────────────
build:
	@echo "$(BOLD)$(GREEN)▶ Building image$(RESET) $(IMAGE)"
	docker buildx build \
		--platform $(PLATFORM) \
		-t $(IMAGE) \
		--progress=plain \
		.

push: build
	@echo "$(BOLD)$(GREEN)▶ Pushing image$(RESET) $(IMAGE)"
	docker push $(IMAGE)

## ── Cloud Run ───────────────────────────────────────────────────────────────
##
## Both deploy targets pass plain env vars through .env.cloudrun.yaml (gcloud
## rejects --set-env-vars alongside --env-vars-file), so that file MUST carry:
##
##   JOB_DRAIN_MODE: "off"                        # no in-process drain in prod
##   INTERNAL_WORKER_URL: "http://127.0.0.1:8080" # self-trigger over loopback
##
## Without INTERNAL_WORKER_URL the self-trigger falls back to BETTER_AUTH_URL
## and the instance calls itself through the public load balancer — a billable
## round trip that can cold-start a second instance. Queued jobs only actually
## run once `make scheduler` is in place; see internal-docs/infrastructure/job-worker.md.

## Default: source-based deploy (Cloud Build — no local Docker required)
deploy: _gcp_guard
	@echo "$(BOLD)$(GREEN)▶ Deploying to Cloud Run via Cloud Build$(RESET) ($(GCP_REGION))"
	$(GCLOUD) run deploy $(SERVICE_NAME) \
		--source . \
		--region $(GCP_REGION) \
		--platform managed \
		--allow-unauthenticated \
		--service-account $(SERVICE_ACCOUNT) \
		--build-service-account projects/$(GCP_PROJECT)/serviceAccounts/$(BUILD_SERVICE_ACCOUNT) \
		--add-cloudsql-instances $(CLOUD_SQL_CONNECTION_NAME) \
		--set-secrets DATABASE_URL=database-url:latest,DATABASE_URL_ADMIN=database-url-admin:latest,BETTER_AUTH_SECRET=better-auth-secret:latest,BETTER_AUTH_URL=better-auth-url:latest,GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest,R2_BUCKET=r2-bucket:latest,R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest,R2_ENDPOINT=r2-endpoint:latest,RESEND_API_KEY=resend-api-key:latest,MAIL_FROM=mail-from:latest,INBOX_WORKER_SECRET=inbox-worker-secret:latest,ADMIN_EMAIL=admin-email:latest,SECRETS_ENCRYPTION_KEY=secrets-encryption-key:latest \
		--env-vars-file .env.cloudrun.yaml \
		--project $(GCP_PROJECT)
	@echo ""
	@$(MAKE) url
	@echo "  Next: $(CYAN)make scheduler$(RESET)  (queued jobs do not run without it)"

## Alternative: local Docker build + push + deploy (requires Docker Desktop)
deploy-docker: push _gcp_guard
	@echo "$(BOLD)$(GREEN)▶ Deploying to Cloud Run$(RESET) ($(GCP_REGION))"
	$(GCLOUD) run deploy $(SERVICE_NAME) \
		--image $(IMAGE) \
		--region $(GCP_REGION) \
		--platform managed \
		--allow-unauthenticated \
		--service-account $(SERVICE_ACCOUNT) \
		--add-cloudsql-instances $(CLOUD_SQL_CONNECTION_NAME) \
		--set-secrets DATABASE_URL=database-url:latest,DATABASE_URL_ADMIN=database-url-admin:latest,BETTER_AUTH_SECRET=better-auth-secret:latest,BETTER_AUTH_URL=better-auth-url:latest,GOOGLE_CLIENT_ID=google-client-id:latest,GOOGLE_CLIENT_SECRET=google-client-secret:latest,R2_BUCKET=r2-bucket:latest,R2_ACCESS_KEY_ID=r2-access-key-id:latest,R2_SECRET_ACCESS_KEY=r2-secret-access-key:latest,R2_ENDPOINT=r2-endpoint:latest,RESEND_API_KEY=resend-api-key:latest,MAIL_FROM=mail-from:latest,INBOX_WORKER_SECRET=inbox-worker-secret:latest,ADMIN_EMAIL=admin-email:latest,SECRETS_ENCRYPTION_KEY=secrets-encryption-key:latest \
		--env-vars-file .env.cloudrun.yaml \
		--project $(GCP_PROJECT)
	@echo ""
	@$(MAKE) url
	@echo "  Next: $(CYAN)make scheduler$(RESET)  (queued jobs do not run without it)"

## ── Job worker scheduler ────────────────────────────────────────────────────
##
## Cloud Scheduler ticks POST /api/internal/worker once a minute. This is the
## ONLY thing that drains queued jobs in production (JOB_DRAIN_MODE=off there,
## so there is no in-process drain loop). It is a post-deploy step because it
## needs the live service URL, which provisioning cannot know yet.
##
## --max-retry-attempts=0 is deliberate: the worker route returns 500 when a job
## fails, but that job has ALREADY been requeued with its own backoff. Scheduler
## retries would hammer a job that is intentionally sleeping — and the next tick
## is only 60s away anyway.
##
## Idempotent (create-or-update). gcloud names dict flags per verb — `--headers`
## on create, `--update-headers` on update — hence $$HEADER_FLAG below.
##
## The header carries a COPY of the worker secret, so re-run this target after
## rotating it. CI and local operations use the same lowercase Secret Manager ID.
SCHEDULER_JOB          ?= $(SERVICE_NAME)-job-worker
WORKER_SECRET_NAME     ?= inbox-worker-secret

scheduler: _gcp_guard
	@echo "$(BOLD)$(GREEN)▶ Scheduling job worker$(RESET) $(SCHEDULER_JOB) ($(GCP_REGION))"
	@SERVICE_URL=$$($(GCLOUD) run services describe $(SERVICE_NAME) \
	    --region $(GCP_REGION) \
	    --format 'value(status.url)' 2>/dev/null); \
	  test -n "$$SERVICE_URL" || \
	    (echo "\033[31m✘ $(SERVICE_NAME) is not deployed yet — run 'make deploy' first.\033[0m"; exit 1); \
	  WORKER_SECRET=$$($(GCLOUD) secrets versions access latest \
	    --secret=$(WORKER_SECRET_NAME)); \
	  test -n "$$WORKER_SECRET" || \
	    (echo "\033[31m✘ Secret $(WORKER_SECRET_NAME) is missing/empty — run 'make provision'.\033[0m"; exit 1); \
	  test "$$WORKER_SECRET" != "REPLACE_ME" || \
	    (echo "\033[31m✘ Secret $(WORKER_SECRET_NAME) still contains REPLACE_ME.\033[0m"; exit 1); \
	  if $(GCLOUD) scheduler jobs describe $(SCHEDULER_JOB) \
	       --location=$(GCP_REGION) >/dev/null 2>&1; then \
	    VERB=update; HEADER_FLAG=--update-headers; echo "  Job exists — updating in place."; \
	  else \
	    VERB=create; HEADER_FLAG=--headers; echo "  Creating job."; \
	  fi; \
	  $(GCLOUD) scheduler jobs $$VERB http $(SCHEDULER_JOB) \
	    --location=$(GCP_REGION) \
	    --schedule="* * * * *" \
	    --time-zone=UTC \
	    --uri="$$SERVICE_URL/api/internal/worker" \
	    --http-method=POST \
	    --message-body='{}' \
	    "$$HEADER_FLAG=Authorization=Bearer $$WORKER_SECRET,Content-Type=application/json" \
	    --attempt-deadline=320s \
	    --max-retry-attempts=0
	@echo "$(GREEN)✔ $(SCHEDULER_JOB) now ticks every minute.$(RESET)"
	@echo "  Verify: gcloud scheduler jobs describe $(SCHEDULER_JOB) --location=$(GCP_REGION) --project=$(GCP_PROJECT)"

env: _gcp_guard
	@echo "$(BOLD)$(GREEN)▶ Pushing env vars to Cloud Run$(RESET) ($(SERVICE_NAME))"
	$(GCLOUD) run services update $(SERVICE_NAME) \
		--region $(GCP_REGION) \
		--env-vars-file .env.cloudrun.yaml

logs: _gcp_guard
	$(GCLOUD) run services logs read $(SERVICE_NAME) \
		--region $(GCP_REGION) \
		--limit 100

url: _gcp_guard
	@$(GCLOUD) run services describe $(SERVICE_NAME) \
		--region $(GCP_REGION) \
		--format 'value(status.url)'

open: _gcp_guard
	@open $$($(MAKE) --no-print-directory url)

## ── Retired direct production database paths ────────────────────────────────
## Production credentials no longer live in .env.cloudrun.yaml. Keep these
## legacy target names fail-closed so an old runbook cannot bypass Cloud SQL
## target validation or omit the Enterprise migration chain.
db-prod rls-prod:
	@echo "\033[31m✘ This direct production target is disabled. Use 'make migrate'.\033[0m"
	@exit 1

## ── Documentation ───────────────────────────────────────────────────────────
docs-dev:
	@echo "$(BOLD)$(GREEN)▶ Starting Mintlify local dev server (Client Docs)$(RESET)"
	cd docs && bunx mintlify dev --port 3000

internal-docs-dev:
	@echo "$(BOLD)$(GREEN)▶ Starting Mintlify local dev server (Internal Docs)$(RESET)"
	cd internal-docs && bunx mintlify dev --port 3001

## ── Admin Promotion ────────────────────────────────────────────────────────

## Promote a user to admin role (local DB).  Usage: make promote email=user@example.com
promote:
	@test -n "$(email)" || \
	  (echo "\033[31m✘ email is required.\033[0m"; \
	   echo "  Usage: make promote email=user@example.com"; \
	   exit 1)
	@echo "$(BOLD)$(GREEN)▶ Promoting $(email) to admin (local DB)$(RESET)"
	bun scripts/promote-admin.ts $(email)

## Direct production promotion is intentionally disabled. Production role or
## entitlement changes require an explicit, target-confirming operator runbook.
promote-prod:
	@echo "\033[31m✘ Direct production promotion is disabled for the isolated deployment.\033[0m"
	@exit 1

## ── White-label Provisioning & Migration ────────────────────────────────────

## Provision the client's GCP project (Cloud SQL, Artifact Registry, SA, secrets)
provision: _gcp_guard
	@echo "$(BOLD)$(GREEN)▶ Provisioning GCP project $(GCP_PROJECT)$(RESET)"
	bash scripts/provision-gcp.sh

## Migrate Cloud SQL via Auth Proxy (schema + Enterprise chain + RLS).
## Requires cloud-sql-proxy and psql on PATH.
PROXY_BIN := cloud-sql-proxy
PROXY_PORT := 5433

migrate: _gcp_guard
	@echo "$(BOLD)$(GREEN)▶ Migrating Cloud SQL via Auth Proxy$(RESET)"
	@command -v $(PROXY_BIN) >/dev/null 2>&1 || \
	  (echo "\033[31m✘ $(PROXY_BIN) not found on PATH.\033[0m"; \
	   echo "  Install: https://cloud.google.com/sql/docs/postgres/connect-auth-proxy#install"; \
	   exit 1)
	@command -v psql >/dev/null 2>&1 || \
	  (echo "\033[31m✘ psql not found on PATH.\033[0m"; exit 1)
	@echo "  Starting Cloud SQL Auth Proxy on port $(PROXY_PORT)…"
	@set -eu; \
	  ACCESS_TOKEN=$$($(GCLOUD) auth print-access-token); \
	  $(PROXY_BIN) --token "$$ACCESS_TOKEN" --address 127.0.0.1 --port $(PROXY_PORT) $(CLOUD_SQL_CONNECTION_NAME) >/tmp/buwiz-books-cloud-sql-proxy.log 2>&1 & \
	  PROXY_PID=$$!; \
	  trap 'kill '"$$PROXY_PID"' 2>/dev/null || true' EXIT; \
	  sleep 3; \
	  ADMIN_SOCKET_URL=$$($(GCLOUD) secrets versions access latest --secret=database-url-admin); \
	  test -n "$$ADMIN_SOCKET_URL" && test "$$ADMIN_SOCKET_URL" != "REPLACE_ME" || \
	    (echo "\033[31m✘ database-url-admin is missing or still a placeholder.\033[0m"; exit 1); \
	  DB_URL=$$(printf '%s' "$$ADMIN_SOCKET_URL" | sed -E 's|@/([^?]+)\?host=/cloudsql/[^&]+|@127.0.0.1:$(PROXY_PORT)/\1|'); \
	  test "$$DB_URL" != "$$ADMIN_SOCKET_URL" || \
	    (echo "\033[31m✘ database-url-admin is not the expected Cloud SQL socket URL.\033[0m"; exit 1); \
	  echo "  Applying AI foundation…"; \
	  DATABASE_URL="$$DB_URL" bun run scripts/apply-ai-foundation.ts; \
	  echo "  Reconciling Drizzle schema…"; \
	  DATABASE_URL="$$DB_URL" bun x drizzle-kit push --force; \
	  echo "  Applying Enterprise migrations…"; \
	  DATABASE_URL_ADMIN="$$DB_URL" bun run db:enterprise:migrate; \
	  echo "  Applying integrity migration…"; \
	  DATABASE_URL="$$DB_URL" bun run scripts/apply-integrity-migration.ts; \
	  echo "  Applying RLS policies and runtime grants…"; \
	  psql "$$DB_URL" -v ON_ERROR_STOP=1 -f drizzle/rls_policies.sql; \
	  psql "$$DB_URL" -v ON_ERROR_STOP=1 -f drizzle/rls_hardening.sql; \
	  echo "  Seeding review rule catalog…"; \
	  DATABASE_URL="$$DB_URL" bun run scripts/seed-review-rules.ts
	@echo "$(GREEN)✔ Migration complete.$(RESET)"

## Map a custom domain to Cloud Run.  Usage: make domain
domain: _gcp_guard
	@test -n "$(CLIENT_DOMAIN)" || \
	  (echo "\033[31m✘ CLIENT_DOMAIN is not set.\033[0m"; \
	   echo "  Add to your .env:  CLIENT_DOMAIN=app.acme.com"; \
	   exit 1)
	@echo "$(BOLD)$(GREEN)▶ Mapping domain $(CLIENT_DOMAIN) to $(SERVICE_NAME)$(RESET)"
	$(GCLOUD) run domain-mappings create \
		--service $(SERVICE_NAME) \
		--domain $(CLIENT_DOMAIN) \
		--region $(GCP_REGION) 2>/dev/null || \
	  echo "  (Domain mapping may already exist — check with gcloud run domain-mappings list)"
	@echo ""
	@echo "  $(BOLD)Client DNS:$(RESET) Point $(CLIENT_DOMAIN) → ghs.googlehosted.com."
	@echo "  SSL cert is auto-provisioned once DNS propagates (~15 min)."
