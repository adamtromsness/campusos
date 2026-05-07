#!/usr/bin/env bash
# Cycle 32 Step 8 — Push failover-test metrics to the Prometheus
# Pushgateway so the SLO dashboard can trend RTO + RPO + cache
# rebuild time + smoke pass rate over time.
set -euo pipefail

PROM_URL="${PROM_PUSHGATEWAY_URL:-}"
if [[ -z "$PROM_URL" ]]; then
  echo "Pushgateway URL unset; skipping metrics push."
  exit 0
fi

RTO_SECONDS=$(cat /tmp/rto-actual.txt 2>/dev/null || echo "0")
CACHE_REBUILD_SECONDS=$(cat /tmp/cache-rebuild-seconds.txt 2>/dev/null || echo "0")

JOB="synthetic-failover"
TS=$(date +%s)

curl -s -X POST "$PROM_URL/metrics/job/$JOB" --data-binary @- <<EOF
# TYPE failover_test_last_run_timestamp gauge
# HELP failover_test_last_run_timestamp Unix timestamp of the most recent synthetic failover.
failover_test_last_run_timestamp $TS
# TYPE failover_test_rto_seconds gauge
# HELP failover_test_rto_seconds Actual RTO (seconds) measured during the last synthetic failover.
failover_test_rto_seconds $RTO_SECONDS
# TYPE failover_test_cache_rebuild_seconds gauge
# HELP failover_test_cache_rebuild_seconds Time for the IAM cache to repopulate after the failover.
failover_test_cache_rebuild_seconds $CACHE_REBUILD_SECONDS
EOF

echo "Pushed metrics: rto=${RTO_SECONDS}s cache_rebuild=${CACHE_REBUILD_SECONDS}s"
