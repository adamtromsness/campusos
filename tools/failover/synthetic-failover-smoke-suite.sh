#!/usr/bin/env bash
# Cycle 32 Step 8 — Run the smoke test suite against the standby
# after failover. Reuses the Cycle 31 k6 load tests at low VU count
# as a smoke check (proves the surface is responsive end-to-end, not
# a load test).
set -euo pipefail

API_URL="${STAGING_API_URL_STANDBY:?STAGING_API_URL_STANDBY required}"
PASS_THRESHOLD="${SMOKE_PASS_THRESHOLD:-95}"  # at least 95% checks pass

# Each k6 script pushed at 1 VU for 30s — proves the path works.
SCRIPTS=(
  "tools/load-tests/iam-permission-check.js"
  "tools/load-tests/inbox-list.js"
  "tools/load-tests/student-profile-load.js"
  "tools/load-tests/library-search.js"
  "tools/load-tests/timetable-render.js"
)

passed=0
total=${#SCRIPTS[@]}
for script in "${SCRIPTS[@]}"; do
  if k6 run --vus 1 --duration 30s --env API_URL="$API_URL" "$script" >/dev/null 2>&1; then
    passed=$((passed + 1))
    echo "OK:   $script"
  else
    echo "FAIL: $script"
  fi
done

pct=$((passed * 100 / total))
echo "Smoke pass rate: ${pct}% (${passed}/${total})"
echo "$pct" > /tmp/smoke-pass-rate.txt

if (( pct < PASS_THRESHOLD )); then
  echo "Smoke pass rate below threshold ${PASS_THRESHOLD}%"
  exit 1
fi
