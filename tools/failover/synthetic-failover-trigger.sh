#!/usr/bin/env bash
# Cycle 32 Step 8 — Trigger RDS Global Database failover in staging.
# REFUSES to run against production unless CONFIRM_PRODUCTION=yes.
set -euo pipefail

GLOBAL_CLUSTER="${RDS_GLOBAL_CLUSTER:-campusos-global-staging}"
NEW_PRIMARY="${RDS_STANDBY_CLUSTER_ID:-campusos-standby-staging}"
SOURCE_PRIMARY="${RDS_PRIMARY_CLUSTER_ID:-campusos-primary-staging}"

# Production guard.
if [[ "$GLOBAL_CLUSTER" == *"prod"* ]] && [[ "${CONFIRM_PRODUCTION:-}" != "yes" ]]; then
  echo "Refusing to trigger failover against production global cluster $GLOBAL_CLUSTER" >&2
  echo "Set CONFIRM_PRODUCTION=yes if you really mean it." >&2
  exit 2
fi

echo "Triggering Global Database failover: promoting $NEW_PRIMARY..."
START_TS=$(date +%s)

aws rds failover-global-cluster \
  --global-cluster-identifier "$GLOBAL_CLUSTER" \
  --target-db-cluster-identifier "arn:aws:rds:$AWS_REGION:$AWS_ACCOUNT_ID:cluster:$NEW_PRIMARY"

# Wait for the new primary to be available.
aws rds wait db-cluster-available --db-cluster-identifier "$NEW_PRIMARY"

END_TS=$(date +%s)
DURATION=$((END_TS - START_TS))
echo "Failover complete in ${DURATION}s. New primary: $NEW_PRIMARY"

echo "$START_TS" > /tmp/failover-start.txt
echo "$END_TS"   > /tmp/failover-end.txt
echo "$NEW_PRIMARY" > /tmp/failover-new-primary.txt
echo "$SOURCE_PRIMARY" > /tmp/failover-source-primary.txt
