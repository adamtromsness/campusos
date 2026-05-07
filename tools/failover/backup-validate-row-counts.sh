#!/usr/bin/env bash
# Cycle 32 Step 2 — Spot-check row counts on 10 critical tables. The
# restored snapshot should be within ±5% of the primary on each.
# A larger drift indicates either a corrupted backup or an unusual
# write spike around the snapshot point — investigate before
# accepting.
set -euo pipefail

ENDPOINT="${TEMP_ENDPOINT:?TEMP_ENDPOINT required}"
PRIMARY_HOST="${RDS_PRIMARY_HOST:?RDS_PRIMARY_HOST required}"
DB="${PGDATABASE:-campusos}"
USER="${PGUSER:-campusos_admin}"

declare -A TABLES=(
  ["platform_audit_log"]="platform"
  ["iam_person"]="platform"
  ["sis_students"]="tenant_demo"
  ["msg_messages"]="tenant_demo"
  ["pay_ledger_entries"]="tenant_demo"
  ["fin_journal_entries"]="tenant_demo"
  ["trn_ridership_records"]="tenant_demo"
  ["fds_meal_transactions"]="tenant_demo"
  ["pfl_portfolios"]="tenant_demo"
  ["dpo_data_breach_records"]="tenant_demo"
)

failed=0
for table in "${!TABLES[@]}"; do
  schema="${TABLES[$table]}"
  primary_count=$(PGHOST="$PRIMARY_HOST" psql -U "$USER" -d "$DB" -tA -c "SELECT count(*) FROM ${schema}.${table}")
  restored_count=$(PGHOST="$ENDPOINT" psql -U "$USER" -d "$DB" -tA -c "SELECT count(*) FROM ${schema}.${table}")

  if [[ -z "$primary_count" || -z "$restored_count" ]]; then
    echo "FAIL: ${schema}.${table} unable to read"
    failed=$((failed + 1))
    continue
  fi

  diff=$((primary_count - restored_count))
  abs_diff=${diff#-}
  if (( primary_count > 0 )); then
    pct=$(( abs_diff * 100 / primary_count ))
  else
    pct=0
  fi
  if (( pct > 5 )); then
    echo "FAIL: ${schema}.${table} drift ${pct}% (primary=${primary_count}, restored=${restored_count})"
    failed=$((failed + 1))
  else
    echo "OK:   ${schema}.${table} drift ${pct}% (primary=${primary_count}, restored=${restored_count})"
  fi
done

if (( failed > 0 )); then
  echo "FAILED: ${failed} table(s) drifted beyond 5%."
  exit 1
fi
echo "All 10 tables within 5% drift threshold."
