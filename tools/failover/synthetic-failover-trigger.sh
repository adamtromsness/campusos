#!/usr/bin/env bash
# Cycle 32 Step 8 — Trigger RDS Global Database failover in staging.
# REFUSES to run against production unless CONFIRM_PRODUCTION=yes.
#
# REVIEW-CYCLE32 BLOCKING 2 — production guard hardened. The earlier
# substring match on cluster name was unsafe (a cluster named
# `campusos-global` does not contain "prod" but is production). The
# guard now requires an explicit TARGET_ENV value AND, when targeting
# production, an additional AWS_ACCOUNT_ID match against a known-
# staging account list set by the caller via STAGING_AWS_ACCOUNT_IDS.
set -euo pipefail

TARGET_ENV="${TARGET_ENV:-staging}"

# Hard refuse production unless explicitly confirmed.
if [[ "$TARGET_ENV" == "production" || "$TARGET_ENV" == "prod" ]]; then
  if [[ "${CONFIRM_PRODUCTION:-}" != "yes" ]]; then
    echo "Refusing to trigger failover against TARGET_ENV=$TARGET_ENV without CONFIRM_PRODUCTION=yes" >&2
    exit 2
  fi
fi

# Belt-and-braces: when STAGING_AWS_ACCOUNT_IDS is set, refuse any
# AWS_ACCOUNT_ID outside that list unless CONFIRM_PRODUCTION=yes.
# Lets ops pin the staging accounts and trip-wire any cross-account
# misconfiguration.
if [[ -n "${STAGING_AWS_ACCOUNT_IDS:-}" ]] && [[ -n "${AWS_ACCOUNT_ID:-}" ]]; then
  if [[ ",${STAGING_AWS_ACCOUNT_IDS}," != *",${AWS_ACCOUNT_ID},"* ]]; then
    if [[ "${CONFIRM_PRODUCTION:-}" != "yes" ]]; then
      echo "AWS_ACCOUNT_ID=$AWS_ACCOUNT_ID is not in STAGING_AWS_ACCOUNT_IDS=$STAGING_AWS_ACCOUNT_IDS" >&2
      echo "Set CONFIRM_PRODUCTION=yes if this is intentional." >&2
      exit 2
    fi
  fi
fi

GLOBAL_CLUSTER="${RDS_GLOBAL_CLUSTER:-campusos-global-${TARGET_ENV}}"
NEW_PRIMARY="${RDS_STANDBY_CLUSTER_ID:-campusos-standby-${TARGET_ENV}}"
SOURCE_PRIMARY="${RDS_PRIMARY_CLUSTER_ID:-campusos-primary-${TARGET_ENV}}"

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
