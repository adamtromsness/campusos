#!/usr/bin/env bash
# Cycle 32 Step 8 — Capture baseline state pre-failover so the post-
# failover data integrity check has something to diff against.
set -euo pipefail

PRIMARY_HOST="${RDS_PRIMARY_HOST:?RDS_PRIMARY_HOST required}"
DB="${PGDATABASE:-campusos}"
USER="${PGUSER:-campusos_admin}"

mkdir -p /tmp/failover-baseline
date -u +%Y-%m-%dT%H:%M:%SZ > /tmp/failover-baseline/timestamp.txt

# Snapshot row counts on critical tables.
PGHOST="$PRIMARY_HOST" psql -U "$USER" -d "$DB" -tA <<'SQL' > /tmp/failover-baseline/row-counts.txt
SELECT 'platform.platform_audit_log',     count(*) FROM platform.platform_audit_log
UNION ALL SELECT 'platform.iam_person',          count(*) FROM platform.iam_person
UNION ALL SELECT 'tenant_demo.sis_students',    count(*) FROM tenant_demo.sis_students
UNION ALL SELECT 'tenant_demo.msg_messages',    count(*) FROM tenant_demo.msg_messages
UNION ALL SELECT 'tenant_demo.pay_ledger_entries',  count(*) FROM tenant_demo.pay_ledger_entries
UNION ALL SELECT 'tenant_demo.fin_journal_entries', count(*) FROM tenant_demo.fin_journal_entries;
SQL

# Snapshot per-school GL totals.
PGHOST="$PRIMARY_HOST" psql -U "$USER" -d "$DB" -tA <<'SQL' > /tmp/failover-baseline/gl-totals.txt
SELECT school_id::text, COALESCE(SUM(amount), 0)
  FROM tenant_demo.pay_ledger_entries
 GROUP BY school_id
 ORDER BY school_id;
SQL

echo "Baseline captured at $(cat /tmp/failover-baseline/timestamp.txt)"
