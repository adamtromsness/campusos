#!/usr/bin/env bash
# Cycle 32 Step 2 — Tear down the temporary cluster + instance.
# Always runs, even if validation failed, to avoid leaking spend.
set -euo pipefail

CLUSTER_ID=$(cat /tmp/temp-cluster-id.txt 2>/dev/null || true)
INSTANCE_ID=$(cat /tmp/temp-instance-id.txt 2>/dev/null || true)

if [[ -z "$CLUSTER_ID" ]]; then
  echo "No temporary cluster id found; nothing to tear down."
  exit 0
fi

if [[ -n "$INSTANCE_ID" ]]; then
  echo "Deleting instance $INSTANCE_ID..."
  aws rds delete-db-instance \
    --db-instance-identifier "$INSTANCE_ID" \
    --skip-final-snapshot >/dev/null || true
  aws rds wait db-instance-deleted --db-instance-identifier "$INSTANCE_ID" || true
fi

echo "Deleting cluster $CLUSTER_ID..."
aws rds delete-db-cluster \
  --db-cluster-identifier "$CLUSTER_ID" \
  --skip-final-snapshot >/dev/null || true

aws rds wait db-cluster-deleted --db-cluster-identifier "$CLUSTER_ID" || true

rm -f /tmp/temp-cluster-id.txt /tmp/temp-instance-id.txt /tmp/temp-endpoint.txt
echo "Teardown complete."
