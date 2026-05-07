#!/usr/bin/env bash
# Cycle 32 Step 2 — Verify Prisma migration state on the restored
# cluster matches the primary's most recent migration set. A mismatch
# means the backup was taken mid-migration or the snapshot is from a
# different schema version than the primary is currently running.
set -euo pipefail

ENDPOINT="${TEMP_ENDPOINT:?TEMP_ENDPOINT required}"
PRIMARY_HOST="${RDS_PRIMARY_HOST:?RDS_PRIMARY_HOST required}"
DB="${PGDATABASE:-campusos}"
USER="${PGUSER:-campusos_admin}"

primary_latest=$(PGHOST="$PRIMARY_HOST" psql -U "$USER" -d "$DB" -tA \
  -c "SELECT migration_name FROM public._prisma_migrations
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1")

restored_latest=$(PGHOST="$ENDPOINT" psql -U "$USER" -d "$DB" -tA \
  -c "SELECT migration_name FROM public._prisma_migrations
        WHERE finished_at IS NOT NULL
        ORDER BY finished_at DESC LIMIT 1")

if [[ "$primary_latest" != "$restored_latest" ]]; then
  echo "FAIL: migration mismatch."
  echo "  primary:  $primary_latest"
  echo "  restored: $restored_latest"
  exit 1
fi
echo "OK: migration parity ($primary_latest)"
