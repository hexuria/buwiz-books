#!/usr/bin/env bash
echo "This historical database restore script is disabled in this application repository." >&2
echo "Use an approved restore runbook in the unattached canonical deployment repository." >&2
exit 1

# Historical implementation below is intentionally unreachable evidence.

# Restore database from backup-2026-02-09.sql
#
# Usage:
#   bun run scripts/restore-backup.sh
#   # or directly:
#   bash scripts/restore-backup.sh
#
# This script:
#   1. Loads DATABASE_URL from .env
#   2. Drops all tables (via drizzle push --force)
#   3. Re-applies schema with drizzle push
#   4. Restores data from the backup SQL file
#
# Prerequisites:
#   - PostgreSQL running and accessible
#   - .env file with DATABASE_URL set

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
BACKUP_FILE="$SCRIPT_DIR/backup-2026-02-09.sql"

# Load .env
if [ -f "$PROJECT_DIR/.env" ]; then
  export $(grep -v '^#' "$PROJECT_DIR/.env" | xargs)
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "❌ DATABASE_URL not set. Check your .env file."
  exit 1
fi

if [ ! -f "$BACKUP_FILE" ]; then
  echo "❌ Backup file not found: $BACKUP_FILE"
  exit 1
fi

echo "🔄 Restoring database from backup..."
echo "   Backup: $BACKUP_FILE"
echo ""

# Step 1: Run drizzle push to ensure schema is up to date
echo "📐 Applying schema with drizzle push..."
cd "$PROJECT_DIR"
bunx drizzle-kit push --force 2>/dev/null || true

# Step 2: Truncate all data tables (preserving drizzle migrations)
echo "🗑️  Clearing existing data..."
psql "$DATABASE_URL" -c "
  DO \$\$ DECLARE
    r RECORD;
  BEGIN
    FOR r IN (SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename != '__drizzle_migrations')
    LOOP
      EXECUTE 'TRUNCATE TABLE public.' || quote_ident(r.tablename) || ' CASCADE';
    END LOOP;
  END \$\$;
" 2>/dev/null

# Step 3: Restore data from backup
echo "📥 Restoring data..."
psql "$DATABASE_URL" -f "$BACKUP_FILE" 2>/dev/null

echo ""
echo "✅ Database restored successfully!"
echo ""
echo "📋 What was restored:"
echo "   • Chart of accounts (70+ categories)"
echo "   • Auth users & organization"
echo "   • Financial accounts (Mercury Checking & Credit Card)"
echo "   • Products"
echo "   • 1 document"
echo ""
echo "📋 Empty tables (clean slate):"
echo "   • bills, invoices, parties"
echo "   • journal_headers, journal_lines"
echo "   • bank_transactions, reconciliations"
