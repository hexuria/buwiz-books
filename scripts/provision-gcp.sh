#!/usr/bin/env bash
# Provision the isolated books.buwiz.com production project.
#
# This script is intentionally target-specific. It refuses any ambient project
# or gcloud configuration so credentials from another deployment cannot be used
# accidentally. It never copies resources or secret values from another project.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
if [ -f "$PROJECT_DIR/.env" ]; then
  set -a
  # shellcheck disable=SC1091
  . "$PROJECT_DIR/.env"
  set +a
fi

EXPECTED_GCP_PROJECT_ID="buwiz-503321"
EXPECTED_GCLOUD_CONFIG="buwiz-books"
EXPECTED_GCP_REGION="europe-north1"
EXPECTED_GITHUB_REPOSITORY="goldcoders-corp/buwiz-books"

GCP_PROJECT="${GCP_PROJECT_ID:-$EXPECTED_GCP_PROJECT_ID}"
GCP_CONFIG="${CLOUDSDK_ACTIVE_CONFIG_NAME:-$EXPECTED_GCLOUD_CONFIG}"
GCP_REGION="${GCP_REGION:-$EXPECTED_GCP_REGION}"
GCP_REPO="${GCP_REPO:-buwiz-books-repo}"
SERVICE_NAME="${SERVICE_NAME:-buwiz-books}"
DB_INSTANCE="${DB_INSTANCE:-buwiz-books-db}"
DB_NAME="${DB_NAME:-buwiz_books}"
DB_ADMIN_USER="${DB_ADMIN_USER:-buwiz_books_admin}"
DB_RUNTIME_USER="${DB_RUNTIME_USER:-app_runtime}"
DB_TIER="${DB_TIER:-db-custom-1-3840}"
DB_VERSION="${DB_VERSION:-POSTGRES_16}"
DB_AVAILABILITY_TYPE="${DB_AVAILABILITY_TYPE:-REGIONAL}"
DB_STORAGE_SIZE_GB="${DB_STORAGE_SIZE_GB:-20}"

RUNTIME_SA_NAME="buwiz-books-runner"
RUNTIME_SA_EMAIL="${RUNTIME_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
DEPLOY_SA_NAME="buwiz-books-deployer"
DEPLOY_SA_EMAIL="${DEPLOY_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
BUILD_SA_NAME="buwiz-books-builder"
BUILD_SA_EMAIL="${BUILD_SA_NAME}@${GCP_PROJECT}.iam.gserviceaccount.com"
WIF_POOL="github-actions"
WIF_PROVIDER="buwiz-books"

BOLD="\033[1m"
RESET="\033[0m"
GREEN="\033[32m"
CYAN="\033[36m"
YELLOW="\033[33m"
RED="\033[31m"
say() { echo -e "${CYAN}▶${RESET} $*"; }
ok() { echo -e "${GREEN}✔${RESET} $*"; }
warn() { echo -e "${YELLOW}⚠${RESET} $*"; }
hdr() { echo -e "\n${BOLD}$*${RESET}"; }
die() { echo -e "${RED}✘ $*${RESET}" >&2; exit 1; }

command -v gcloud >/dev/null || die "gcloud CLI not found."
command -v openssl >/dev/null || die "openssl not found."

[[ "$GCP_PROJECT" == "$EXPECTED_GCP_PROJECT_ID" ]] ||
  die "Refusing project '$GCP_PROJECT'; expected '$EXPECTED_GCP_PROJECT_ID'."
[[ "$GCP_CONFIG" == "$EXPECTED_GCLOUD_CONFIG" ]] ||
  die "Refusing gcloud configuration '$GCP_CONFIG'; expected '$EXPECTED_GCLOUD_CONFIG'."
[[ "$GCP_REGION" == "$EXPECTED_GCP_REGION" ]] ||
  die "Refusing region '$GCP_REGION'; expected '$EXPECTED_GCP_REGION'."
[[ "$GCP_REPO" == "buwiz-books-repo" ]] || die "Refusing Artifact Registry '$GCP_REPO'."
[[ "$SERVICE_NAME" == "buwiz-books" ]] || die "Refusing Cloud Run service '$SERVICE_NAME'."
[[ "$DB_INSTANCE" == "buwiz-books-db" ]] || die "Refusing Cloud SQL instance '$DB_INSTANCE'."
[[ "$DB_NAME" == "buwiz_books" ]] || die "Refusing database name '$DB_NAME'."
[[ "$DB_ADMIN_USER" == "buwiz_books_admin" ]] || die "Refusing admin database user '$DB_ADMIN_USER'."
[[ "$DB_RUNTIME_USER" == "app_runtime" ]] || die "Refusing runtime database user '$DB_RUNTIME_USER'."
[[ "$DB_VERSION" == "POSTGRES_16" ]] || die "Refusing database version '$DB_VERSION'."
[[ "$DB_TIER" == "db-custom-1-3840" ]] || die "Refusing database tier '$DB_TIER'."
[[ "$DB_AVAILABILITY_TYPE" == "REGIONAL" ]] ||
  die "Refusing availability type '$DB_AVAILABILITY_TYPE'; regional HA is required."
[[ "$DB_STORAGE_SIZE_GB" =~ ^[0-9]+$ ]] && ((DB_STORAGE_SIZE_GB >= 20)) ||
  die "DB_STORAGE_SIZE_GB must be an integer of at least 20."

CONFIGURED_PROJECT="$(gcloud --configuration="$GCP_CONFIG" config get-value project 2>/dev/null)"
[[ "$CONFIGURED_PROJECT" == "$EXPECTED_GCP_PROJECT_ID" ]] ||
  die "gcloud configuration '$GCP_CONFIG' targets '$CONFIGURED_PROJECT', not '$EXPECTED_GCP_PROJECT_ID'."

GC=(gcloud --configuration="$GCP_CONFIG" --project="$GCP_PROJECT" --quiet)
PROJECT_STATE="$("${GC[@]}" projects describe "$GCP_PROJECT" --format='value(lifecycleState)')"
[[ "$PROJECT_STATE" == "ACTIVE" ]] || die "Project '$GCP_PROJECT' is not active."
BILLING_ENABLED="$("${GC[@]}" billing projects describe "$GCP_PROJECT" --format='value(billingEnabled)')"
[[ "$BILLING_ENABLED" == "True" || "$BILLING_ENABLED" == "true" ]] ||
  die "Billing is disabled for '$GCP_PROJECT'. Enable billing before provisioning."

secret_exists() {
  "${GC[@]}" secrets describe "$1" >/dev/null 2>&1
}

create_or_update_secret() {
  local name="$1" value="$2"
  if secret_exists "$name"; then
    printf '%s' "$value" | "${GC[@]}" secrets versions add "$name" --data-file=- >/dev/null
    ok "Added a new version to secret: $name"
  else
    printf '%s' "$value" | "${GC[@]}" secrets create "$name" \
      --data-file=- --replication-policy=automatic >/dev/null
    ok "Created secret: $name"
  fi
}

create_placeholder_secret() {
  local name="$1"
  if secret_exists "$name"; then
    warn "Secret $name exists; leaving its value untouched."
  else
    printf 'REPLACE_ME' | "${GC[@]}" secrets create "$name" \
      --data-file=- --replication-policy=automatic >/dev/null
    ok "Created placeholder secret: $name"
  fi
}

create_generated_secret() {
  local name="$1"
  if secret_exists "$name"; then
    warn "Secret $name exists; leaving its value untouched."
  else
    create_or_update_secret "$name" "$(openssl rand -base64 32)"
  fi
}

ensure_service_account() {
  local name="$1" email="$2" display_name="$3"
  if "${GC[@]}" iam service-accounts describe "$email" >/dev/null 2>&1; then
    warn "Service account $email exists; skipping create."
  else
    "${GC[@]}" iam service-accounts create "$name" --display-name="$display_name"
    ok "Created service account: $email"
  fi
}

grant_project_role() {
  local email="$1" role="$2"
  "${GC[@]}" projects add-iam-policy-binding "$GCP_PROJECT" \
    --member="serviceAccount:$email" --role="$role" --condition=None >/dev/null
  ok "$email → $role"
}

hdr "Provisioning isolated Buwiz Books production"
say "Project $GCP_PROJECT · config $GCP_CONFIG · region $GCP_REGION"
say "Service $SERVICE_NAME · Cloud SQL $DB_INSTANCE/$DB_NAME"

hdr "1) Enable required APIs"
"${GC[@]}" services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  artifactregistry.googleapis.com \
  secretmanager.googleapis.com \
  cloudbuild.googleapis.com \
  cloudscheduler.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com
ok "Required APIs enabled."

hdr "2) Artifact Registry"
if "${GC[@]}" artifacts repositories describe "$GCP_REPO" \
  --location="$GCP_REGION" >/dev/null 2>&1; then
  warn "Repository $GCP_REPO exists; skipping create."
else
  "${GC[@]}" artifacts repositories create "$GCP_REPO" \
    --repository-format=docker \
    --location="$GCP_REGION" \
    --description="Buwiz Books production images"
  ok "Created Artifact Registry repository: $GCP_REPO"
fi

hdr "3) Cloud SQL PostgreSQL 16"
if "${GC[@]}" sql instances describe "$DB_INSTANCE" >/dev/null 2>&1; then
  warn "Instance $DB_INSTANCE exists; validating production settings."
  ACTUAL_VERSION="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(databaseVersion)')"
  ACTUAL_REGION="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(region)')"
  ACTUAL_TIER="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(settings.tier)')"
  ACTUAL_AVAILABILITY="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(settings.availabilityType)')"
  BACKUPS_ENABLED="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(settings.backupConfiguration.enabled)')"
  PITR_ENABLED="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(settings.backupConfiguration.pointInTimeRecoveryEnabled)')"
  STORAGE_AUTO_GROWTH="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(settings.storageAutoResize)')"
  DELETION_PROTECTION="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(settings.deletionProtectionEnabled)')"
  [[ "$ACTUAL_VERSION" == "$DB_VERSION" ]] || die "Cloud SQL version is $ACTUAL_VERSION; expected $DB_VERSION."
  [[ "$ACTUAL_REGION" == "$GCP_REGION" ]] || die "Cloud SQL region is $ACTUAL_REGION; expected $GCP_REGION."
  [[ "$ACTUAL_TIER" == "$DB_TIER" ]] || die "Cloud SQL tier is $ACTUAL_TIER; expected $DB_TIER."
  [[ "$ACTUAL_AVAILABILITY" == "$DB_AVAILABILITY_TYPE" ]] ||
    die "Cloud SQL availability is $ACTUAL_AVAILABILITY; expected $DB_AVAILABILITY_TYPE."
  [[ "$BACKUPS_ENABLED" == "True" || "$BACKUPS_ENABLED" == "true" ]] || die "Cloud SQL backups are disabled."
  [[ "$PITR_ENABLED" == "True" || "$PITR_ENABLED" == "true" ]] || die "Cloud SQL PITR is disabled."
  [[ "$STORAGE_AUTO_GROWTH" == "True" || "$STORAGE_AUTO_GROWTH" == "true" ]] || die "Cloud SQL storage auto-growth is disabled."
  [[ "$DELETION_PROTECTION" == "True" || "$DELETION_PROTECTION" == "true" ]] || die "Cloud SQL deletion protection is disabled."
  ok "Existing Cloud SQL instance satisfies the production baseline."
else
  say "Creating $DB_INSTANCE ($DB_VERSION, $DB_TIER, $DB_AVAILABILITY_TYPE)."
  "${GC[@]}" sql instances create "$DB_INSTANCE" \
    --database-version="$DB_VERSION" \
    --tier="$DB_TIER" \
    --region="$GCP_REGION" \
    --availability-type="$DB_AVAILABILITY_TYPE" \
    --storage-type=SSD \
    --storage-size="$DB_STORAGE_SIZE_GB" \
    --storage-auto-increase \
    --backup-start-time=03:00 \
    --enable-point-in-time-recovery \
    --deletion-protection
  ok "Cloud SQL instance created."
fi

CONNECTION_NAME="$("${GC[@]}" sql instances describe "$DB_INSTANCE" --format='value(connectionName)')"
[[ "$CONNECTION_NAME" == "$GCP_PROJECT:$GCP_REGION:$DB_INSTANCE" ]] ||
  die "Unexpected Cloud SQL connection name '$CONNECTION_NAME'."

if "${GC[@]}" sql databases describe "$DB_NAME" --instance="$DB_INSTANCE" >/dev/null 2>&1; then
  warn "Database $DB_NAME exists; skipping create."
else
  "${GC[@]}" sql databases create "$DB_NAME" --instance="$DB_INSTANCE"
  ok "Created database: $DB_NAME"
fi

ensure_database_user_secret() {
  local database_user="$1" secret_name="$2"
  local password database_url
  if "${GC[@]}" sql users list --instance="$DB_INSTANCE" --format='value(name)' | grep -Fqx "$database_user"; then
    if secret_exists "$secret_name"; then
      warn "Database user $database_user and $secret_name exist; leaving credentials untouched."
      return
    fi
    warn "Database user $database_user exists without $secret_name; rotating once to restore consistency."
    password="$(openssl rand -hex 24)"
    "${GC[@]}" sql users set-password "$database_user" \
      --instance="$DB_INSTANCE" --password="$password"
  else
    password="$(openssl rand -hex 24)"
    "${GC[@]}" sql users create "$database_user" \
      --instance="$DB_INSTANCE" --password="$password"
    ok "Created database user: $database_user"
  fi
  database_url="postgresql://${database_user}:${password}@/${DB_NAME}?host=/cloudsql/${CONNECTION_NAME}"
  create_or_update_secret "$secret_name" "$database_url"
}

ensure_database_user_secret "$DB_ADMIN_USER" "database-url-admin"
ensure_database_user_secret "$DB_RUNTIME_USER" "database-url"

hdr "4) Runtime and deployment identities"
ensure_service_account "$RUNTIME_SA_NAME" "$RUNTIME_SA_EMAIL" "Buwiz Books Cloud Run runtime"
ensure_service_account "$DEPLOY_SA_NAME" "$DEPLOY_SA_EMAIL" "Buwiz Books GitHub deployer"
ensure_service_account "$BUILD_SA_NAME" "$BUILD_SA_EMAIL" "Buwiz Books source builder"

for role in roles/cloudsql.client roles/secretmanager.secretAccessor; do
  grant_project_role "$RUNTIME_SA_EMAIL" "$role"
done
for role in \
  roles/run.admin \
  roles/artifactregistry.writer \
  roles/cloudsql.client \
  roles/secretmanager.secretAccessor \
  roles/cloudscheduler.admin \
  roles/serviceusage.serviceUsageConsumer; do
  grant_project_role "$DEPLOY_SA_EMAIL" "$role"
done
grant_project_role "$BUILD_SA_EMAIL" roles/run.builder
"${GC[@]}" iam service-accounts add-iam-policy-binding "$RUNTIME_SA_EMAIL" \
  --member="serviceAccount:$DEPLOY_SA_EMAIL" \
  --role=roles/iam.serviceAccountUser >/dev/null
ok "$DEPLOY_SA_EMAIL may deploy only as $RUNTIME_SA_EMAIL."
"${GC[@]}" iam service-accounts add-iam-policy-binding "$BUILD_SA_EMAIL" \
  --member="serviceAccount:$DEPLOY_SA_EMAIL" \
  --role=roles/iam.serviceAccountUser >/dev/null

hdr "5) GitHub Workload Identity Federation"
PROJECT_NUMBER="$("${GC[@]}" projects describe "$GCP_PROJECT" --format='value(projectNumber)')"
if "${GC[@]}" iam workload-identity-pools describe "$WIF_POOL" \
  --location=global >/dev/null 2>&1; then
  warn "Workload Identity pool $WIF_POOL exists; skipping create."
else
  "${GC[@]}" iam workload-identity-pools create "$WIF_POOL" \
    --location=global --display-name="GitHub Actions"
  ok "Created Workload Identity pool: $WIF_POOL"
fi

EXPECTED_ISSUER="https://token.actions.githubusercontent.com"
EXPECTED_CONDITION="assertion.repository=='$EXPECTED_GITHUB_REPOSITORY'"
if "${GC[@]}" iam workload-identity-pools providers describe "$WIF_PROVIDER" \
  --workload-identity-pool="$WIF_POOL" --location=global >/dev/null 2>&1; then
  ISSUER="$("${GC[@]}" iam workload-identity-pools providers describe "$WIF_PROVIDER" \
    --workload-identity-pool="$WIF_POOL" --location=global --format='value(oidc.issuerUri)')"
  CONDITION="$("${GC[@]}" iam workload-identity-pools providers describe "$WIF_PROVIDER" \
    --workload-identity-pool="$WIF_POOL" --location=global --format='value(attributeCondition)')"
  [[ "$ISSUER" == "$EXPECTED_ISSUER" ]] || die "Existing WIF provider has an unexpected issuer."
  [[ "$CONDITION" == "$EXPECTED_CONDITION" ]] ||
    die "Existing WIF provider is not restricted to $EXPECTED_GITHUB_REPOSITORY."
  ok "Existing WIF provider has the expected repository boundary."
else
  "${GC[@]}" iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
    --workload-identity-pool="$WIF_POOL" \
    --location=global \
    --display-name="Buwiz Books GitHub Actions" \
    --issuer-uri="$EXPECTED_ISSUER" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="$EXPECTED_CONDITION"
  ok "Created repository-restricted WIF provider."
fi

WIF_PRINCIPAL="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/attribute.repository/${EXPECTED_GITHUB_REPOSITORY}"
"${GC[@]}" iam service-accounts add-iam-policy-binding "$DEPLOY_SA_EMAIL" \
  --member="$WIF_PRINCIPAL" \
  --role=roles/iam.workloadIdentityUser >/dev/null
ok "GitHub repository may impersonate only $DEPLOY_SA_EMAIL."

hdr "6) Secret Manager"
create_generated_secret "better-auth-secret"
create_generated_secret "inbox-worker-secret"
create_generated_secret "secrets-encryption-key"

for secret_name in \
  better-auth-url \
  google-client-id \
  google-client-secret \
  r2-bucket \
  r2-access-key-id \
  r2-secret-access-key \
  r2-endpoint \
  resend-api-key \
  mail-from \
  admin-email; do
  create_placeholder_secret "$secret_name"
done

WIF_PROVIDER_NAME="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${WIF_POOL}/providers/${WIF_PROVIDER}"
hdr "Provisioning complete"
cat <<EOF

  Cloud Run service       : ${BOLD}${SERVICE_NAME}${RESET}
  Artifact Registry       : ${BOLD}${GCP_REPO}${RESET}
  Cloud SQL connection    : ${BOLD}${CONNECTION_NAME}${RESET}
  Runtime database secret : ${BOLD}database-url${RESET} (non-owner app_runtime)
  Migration/admin secret  : ${BOLD}database-url-admin${RESET}

  Configure these GitHub repository secrets without printing their values:
    GCP_PROJECT_ID=$GCP_PROJECT
    GCP_SERVICE_ACCOUNT=$DEPLOY_SA_EMAIL
    GCP_WORKLOAD_IDENTITY_PROVIDER=$WIF_PROVIDER_NAME

  Replace every REPLACE_ME version directly in this project's Secret Manager.
  Use fresh Buwiz OAuth, R2, Resend, and operator values; do not copy another
  deployment's credentials or resources.

  Then run:
    make migrate
    make deploy-docker
    make scheduler
    make domain CLIENT_DOMAIN=books.buwiz.com
EOF
