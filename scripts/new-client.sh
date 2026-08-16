#!/usr/bin/env bash
echo "This production client setup script is disabled in this application repository." >&2
echo "Use the unattached canonical deployment repository and its approved runbook." >&2
exit 1

# Historical implementation below is intentionally unreachable evidence.

# ── Initialize this repo for a new white-label client ─────────────────────────
#
# The single entry point after `git clone`. Interactively collects client +
# GCP + branding details, then writes the per-client config files:
#
#   .env                  operator vars (GCP project/region, gcloud config, infra
#                         names) + branding mirror for local `bun dev`
#   .env.production        VITE_* branding ONLY (non-secret) — baked into the build
#                         by Cloud Build (allow-listed in .gcloudignore)
#   .env.cloudrun.yaml     NON-secret runtime env for Cloud Run (secrets come from
#                         Secret Manager via `make deploy`)
#
# All three are git-ignored. Re-running overwrites them (it prints a backup note).
#
# After this:  make provision → populate secrets → make migrate → make deploy → make domain

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
cd "$PROJECT_DIR"

BOLD="\033[1m"; RESET="\033[0m"; GREEN="\033[32m"; CYAN="\033[36m"; YEL="\033[33m"
ok()   { echo -e "${GREEN}✔${RESET} $*"; }
hdr()  { echo -e "\n${BOLD}$*${RESET}"; }
ask()  { # ask <var> <prompt> <default>
  local __var="$1" __prompt="$2" __default="${3:-}" __reply=""
  if [ -n "$__default" ]; then
    read -r -p "$(echo -e "${CYAN}?${RESET} ${__prompt} [${__default}]: ")" __reply
    __reply="${__reply:-$__default}"
  else
    read -r -p "$(echo -e "${CYAN}?${RESET} ${__prompt}: ")" __reply
  fi
  printf -v "$__var" '%s' "$__reply"
}

slugify() { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//'; }
dbify()   { echo "$1" | tr '[:upper:]' '[:lower:]' | sed -E 's/[^a-z0-9]+/_/g; s/^_+//; s/_+$//'; }

hdr "White-label client setup"
echo "Answer the prompts; press Enter to accept the [default]."

ask CLIENT_NAME   "Client display name (brand shown in the UI)" "Acme Co"
DEFAULT_SLUG="$(slugify "$CLIENT_NAME")"
ask CLIENT_SLUG   "Slug (Cloud Run service / instance prefix)" "$DEFAULT_SLUG"
CLIENT_SLUG="$(slugify "$CLIENT_SLUG")"
ask CLIENT_DOMAIN "Custom domain (e.g. app.acme.com)" "app.${CLIENT_SLUG}.com"

hdr "Google Cloud"
ask GCP_PROJECT_ID "Client's GCP project ID" ""
ask GCP_REGION     "GCP region" "europe-north1"
ask GCLOUD_CONFIG  "gcloud config name to use for this client" "$CLIENT_SLUG"

hdr "Branding"
ask BRAND_PRIMARY  "Primary brand color (hex)" "#22c55e"
ask BRAND_LOGO     "Logo URL (optional, blank = built-in wordmark)" ""
ask SUPPORT_EMAIL  "Support email" "support@${CLIENT_SLUG}.com"

# Derived infra names
DB_INSTANCE="${CLIENT_SLUG}-db"
DB_NAME="$(dbify "$CLIENT_SLUG")"
DB_USER="$(dbify "$CLIENT_SLUG")_app"
CONN_NAME="${GCP_PROJECT_ID}:${GCP_REGION}:${DB_INSTANCE}"
AUTH_URL="https://${CLIENT_DOMAIN}"
MAIL_FROM="${CLIENT_NAME} <noreply@${CLIENT_DOMAIN}>"

backup_if_exists() { [ -f "$1" ] && cp "$1" "$1.bak" && echo -e "${YEL}⚠${RESET} Backed up existing $1 → $1.bak"; }

# ── .env (operator + local-dev branding) ──────────────────────────────────────
backup_if_exists .env
cat > .env <<EOF
# ── Client: ${CLIENT_NAME} — operator config (git-ignored) ───────────────────
# Consumed by the Makefile (auto-loaded) and scripts/*.sh.

CLOUDSDK_ACTIVE_CONFIG_NAME=${GCLOUD_CONFIG}
GCP_PROJECT_ID=${GCP_PROJECT_ID}
GCP_REGION=${GCP_REGION}
GCP_REPO=digits-repo
SERVICE_NAME=${CLIENT_SLUG}

# Cloud SQL
DB_INSTANCE=${DB_INSTANCE}
DB_NAME=${DB_NAME}
DB_USER=${DB_USER}
CLOUD_SQL_CONNECTION_NAME=${CONN_NAME}

# Custom domain
CLIENT_DOMAIN=${CLIENT_DOMAIN}

# Branding mirror (for local 'bun dev'; .env.production is authoritative for builds)
VITE_APP_NAME=${CLIENT_NAME}
VITE_BRAND_PRIMARY=${BRAND_PRIMARY}
VITE_BRAND_LOGO_URL=${BRAND_LOGO}
VITE_SUPPORT_EMAIL=${SUPPORT_EMAIL}
EOF
ok "Wrote .env"

# ── .env.production (build-time branding, uploaded to Cloud Build) ─────────────
backup_if_exists .env.production
cat > .env.production <<EOF
# ── Client: ${CLIENT_NAME} — build-time branding (git-ignored) ───────────────
# VITE_* ONLY. NON-SECRET. Uploaded to Cloud Build (see .gcloudignore) so Vite
# bakes the brand into the client bundle + SSR. Never put secrets here.
VITE_APP_NAME=${CLIENT_NAME}
VITE_BRAND_PRIMARY=${BRAND_PRIMARY}
VITE_BRAND_LOGO_URL=${BRAND_LOGO}
VITE_SUPPORT_EMAIL=${SUPPORT_EMAIL}
EOF
ok "Wrote .env.production"

# ── .env.cloudrun.yaml (non-secret runtime env for Cloud Run) ─────────────────
backup_if_exists .env.cloudrun.yaml
cat > .env.cloudrun.yaml <<EOF
# ── Client: ${CLIENT_NAME} — Cloud Run runtime env (git-ignored) ─────────────
# NON-secret only. Secrets are injected from Secret Manager by 'make deploy'
# (--set-secrets). Format: KEY: value (required by gcloud --env-vars-file).
NODE_ENV: production
BETTER_AUTH_URL: "${AUTH_URL}"
APP_NAME: "${CLIENT_NAME}"
SUPPORT_EMAIL: "${SUPPORT_EMAIL}"
MAIL_FROM: "${MAIL_FROM}"
STORAGE_PROVIDER: r2
R2_BUCKET: "${CLIENT_SLUG}-uploads"
R2_ENDPOINT: "https://CHANGE_ME.r2.cloudflarestorage.com"
EOF
ok "Wrote .env.cloudrun.yaml"

# ── gcloud config ─────────────────────────────────────────────────────────────
if command -v gcloud >/dev/null; then
  if gcloud config configurations describe "$GCLOUD_CONFIG" >/dev/null 2>&1; then
    echo -e "${YEL}⚠${RESET} gcloud config '$GCLOUD_CONFIG' already exists — leaving it."
  else
    gcloud config configurations create "$GCLOUD_CONFIG" >/dev/null
    ok "Created gcloud config: $GCLOUD_CONFIG"
  fi
  gcloud config set project "$GCP_PROJECT_ID" --configuration="$GCLOUD_CONFIG" >/dev/null 2>&1 || true
  echo -e "${CYAN}ℹ${RESET} Authenticate this config if you haven't:  gcloud auth login --configuration=$GCLOUD_CONFIG"
else
  echo -e "${YEL}⚠${RESET} gcloud not found — install the Google Cloud SDK, then:"
  echo "    gcloud config configurations create $GCLOUD_CONFIG && gcloud config set project $GCP_PROJECT_ID"
fi

hdr "✅ Client '${CLIENT_NAME}' initialized"
cat <<EOF

  Service        : ${BOLD}${CLIENT_SLUG}${RESET}   Domain: ${BOLD}${CLIENT_DOMAIN}${RESET}
  GCP project    : ${BOLD}${GCP_PROJECT_ID}${RESET} (${GCP_REGION})
  Cloud SQL conn : ${BOLD}${CONN_NAME}${RESET}

  ${BOLD}Next steps:${RESET}
    1. ${CYAN}make provision${RESET}   # create Cloud SQL, Artifact Registry, SA, secrets
    2. Populate placeholder secrets (provision prints the commands), and set the
       real R2_ENDPOINT/R2_BUCKET in .env.cloudrun.yaml.
    3. ${CYAN}make migrate${RESET}     # create tables + RLS in Cloud SQL
    4. ${CYAN}make deploy${RESET}      # build + deploy to Cloud Run
    5. ${CYAN}make domain${RESET}      # map ${CLIENT_DOMAIN} (prints the CNAME)

  See internal-docs/infrastructure/deploy-new-client.md for the full runbook.
EOF
