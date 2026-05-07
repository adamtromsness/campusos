#!/usr/bin/env bash
# Cycle 32 Step 8 — Fail back to the original primary after
# verification. Always runs (even on test failure) so the staging
# topology returns to its normal shape.
#
# REVIEW-CYCLE32 BLOCKING 2 — same hardened production guard as
# synthetic-failover-trigger.sh.
set -euo pipefail

TARGET_ENV="${TARGET_ENV:-staging}"

if [[ "$TARGET_ENV" == "production" || "$TARGET_ENV" == "prod" ]]; then
  if [[ "${CONFIRM_PRODUCTION:-}" != "yes" ]]; then
    echo "Refusing to fail back against TARGET_ENV=$TARGET_ENV without CONFIRM_PRODUCTION=yes" >&2
    exit 2
  fi
fi
if [[ -n "${STAGING_AWS_ACCOUNT_IDS:-}" ]] && [[ -n "${AWS_ACCOUNT_ID:-}" ]]; then
  if [[ ",${STAGING_AWS_ACCOUNT_IDS}," != *",${AWS_ACCOUNT_ID},"* ]]; then
    if [[ "${CONFIRM_PRODUCTION:-}" != "yes" ]]; then
      echo "AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID is not in STAGING_AWS_ACCOUNT_IDS=$STAGING_AWS_ACCOUNT_IDS" >&2
      exit 2
    fi
  fi
fi

GLOBAL_CLUSTER="${RDS_GLOBAL_CLUSTER:-campusos-global-${TARGET_ENV}}"
SOURCE_PRIMARY=$(cat /tmp/failover-source-primary.txt 2>/dev/null || true)

if [[ -z "$SOURCE_PRIMARY" ]]; then
  echo "No source primary recorded; skipping failback."
  exit 0
fi

echo "Failing back: promoting $SOURCE_PRIMARY..."
aws rds failover-global-cluster \
  --global-cluster-identifier "$GLOBAL_CLUSTER" \
  --target-db-cluster-identifier "arn:aws:rds:$AWS_REGION:$AWS_ACCOUNT_ID:cluster:$SOURCE_PRIMARY"
aws rds wait db-cluster-available --db-cluster-identifier "$SOURCE_PRIMARY"
echo "Failback complete. Primary restored: $SOURCE_PRIMARY"
