#!/usr/bin/env bash
# Cycle 32 Step 2 — Push backup-validation success metric to the
# Prometheus Pushgateway. Extracted from the workflow heredoc per
# REVIEW-CYCLE32 MAJOR 8 so the metric body is independently
# testable + the YAML can't misinterpret indentation.
set -euo pipefail

PROM_URL="${PROM_PUSHGATEWAY_URL:-}"
MODE="${MODE:-weekly}"

if [[ -z "$PROM_URL" ]]; then
  echo "PROM_PUSHGATEWAY_URL not set; skipping metric push."
  exit 0
fi

# Sanity-check the URL shape (no trailing slash; matching scheme).
if [[ ! "$PROM_URL" =~ ^https?:// ]]; then
  echo "PROM_PUSHGATEWAY_URL=$PROM_URL is not a valid http(s) URL." >&2
  exit 1
fi

NOW=$(date +%s)
METRIC_BODY=$(cat <<METRIC
# TYPE backup_validation_last_success_timestamp gauge
# HELP backup_validation_last_success_timestamp Unix timestamp of last successful backup validation.
backup_validation_last_success_timestamp{mode="${MODE}"} ${NOW}
METRIC
)

# Pushgateway expects a trailing newline on the body.
printf '%s\n' "$METRIC_BODY" \
  | curl -s --fail -X POST \
      "$PROM_URL/metrics/job/backup-validation/mode/$MODE" \
      --data-binary @-

echo "Pushed backup_validation_last_success_timestamp=${NOW} (mode=${MODE})"
