#!/usr/bin/env bash
# Cycle 32 Step 2 — Table count parity (±1%) on platform + every
# tenant schema.
set -euo pipefail

ENDPOINT="${TEMP_ENDPOINT:?TEMP_ENDPOINT required}"
PRIMARY_HOST="${RDS_PRIMARY_HOST:?RDS_PRIMARY_HOST required}"
DB="${PGDATABASE:-campusos}"
USER="${PGUSER:-campusos_admin}"

count_for() {
  local host="$1" schema="$2"
  PGHOST="$host" psql -U "$USER" -d "$DB" -tA \
    -c "SELECT count(*) FROM information_schema.tables
          WHERE table_schema = '$schema'
            AND table_type = 'BASE TABLE'
            AND table_name NOT LIKE '\\_prisma\\_%'"
}

schemas=$(PGHOST="$PRIMARY_HOST" psql -U "$USER" -d "$DB" -tA \
  -c "SELECT schema_name FROM information_schema.schemata
        WHERE schema_name = 'platform' OR schema_name LIKE 'tenant_%'")

failed=0
for schema in $schemas; do
  primary=$(count_for "$PRIMARY_HOST" "$schema")
  restored=$(count_for "$ENDPOINT" "$schema")
  diff=$((primary - restored))
  abs=${diff#-}
  if (( primary > 0 )); then
    pct=$(( abs * 100 / primary ))
  else
    pct=0
  fi
  if (( pct > 1 )); then
    echo "FAIL: schema $schema table count drift ${pct}% (primary=${primary}, restored=${restored})"
    failed=$((failed + 1))
  else
    echo "OK:   schema $schema table count parity (primary=${primary}, restored=${restored})"
  fi
done

(( failed == 0 )) || exit 1
echo "All schemas within 1% table count drift."
