#!/usr/bin/env bash
# Cycle 32 Step 8 — Fail back to the original primary after
# verification. Always runs (even on test failure) so the staging
# topology returns to its normal shape.
set -euo pipefail

GLOBAL_CLUSTER="${RDS_GLOBAL_CLUSTER:-campusos-global-staging}"
SOURCE_PRIMARY=$(cat /tmp/failover-source-primary.txt 2>/dev/null || true)

if [[ -z "$SOURCE_PRIMARY" ]]; then
  echo "No source primary recorded; skipping failback."
  exit 0
fi

if [[ "$GLOBAL_CLUSTER" == *"prod"* ]] && [[ "${CONFIRM_PRODUCTION:-}" != "yes" ]]; then
  echo "Refusing to fail back against production global cluster $GLOBAL_CLUSTER" >&2
  exit 2
fi

echo "Failing back: promoting $SOURCE_PRIMARY..."
aws rds failover-global-cluster \
  --global-cluster-identifier "$GLOBAL_CLUSTER" \
  --target-db-cluster-identifier "arn:aws:rds:$AWS_REGION:$AWS_ACCOUNT_ID:cluster:$SOURCE_PRIMARY"
aws rds wait db-cluster-available --db-cluster-identifier "$SOURCE_PRIMARY"
echo "Failback complete. Primary restored: $SOURCE_PRIMARY"
