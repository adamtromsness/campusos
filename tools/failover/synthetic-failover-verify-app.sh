#!/usr/bin/env bash
# Cycle 32 Step 8 — Verify the API reconnects to the promoted primary
# within the <15 min RTO target. Polls the staging /api/v1/health
# endpoint until it returns 200 or the deadline expires.
set -euo pipefail

API_URL="${STAGING_API_URL:?STAGING_API_URL required}"
DEADLINE_SECONDS="${RTO_DEADLINE_SECONDS:-900}"  # 15 minutes
START=$(date +%s)

while :; do
  status=$(curl -s -o /dev/null -w '%{http_code}' "${API_URL}/api/v1/health" || true)
  now=$(date +%s)
  elapsed=$((now - START))
  if [[ "$status" == "200" ]]; then
    echo "API healthy after ${elapsed}s (RTO target: ${DEADLINE_SECONDS}s)"
    echo "$elapsed" > /tmp/rto-actual.txt
    exit 0
  fi
  if (( elapsed >= DEADLINE_SECONDS )); then
    echo "API not healthy after ${elapsed}s (deadline ${DEADLINE_SECONDS}s)"
    exit 1
  fi
  sleep 10
done
