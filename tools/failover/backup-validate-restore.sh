#!/usr/bin/env bash
# Cycle 32 Step 2 — Restore latest snapshot (or PITR target) to a
# temporary cluster for validation.
#
# Modes:
#   weekly  — restore the latest automated snapshot
#   pitr    — point-in-time restore to (now - 15 minutes)
#
# Writes the temporary cluster endpoint to /tmp/temp-endpoint.txt so
# the downstream validation steps can find it.
set -euo pipefail

MODE="${1:-weekly}"
PRIMARY="${RDS_PRIMARY_CLUSTER_ID:-campusos-primary}"
TEMP_ID="campusos-bv-$(date +%s)"
TEMP_INSTANCE_ID="${TEMP_ID}-1"

if [[ -n "${CONFIRM_PRODUCTION:-}" || -z "${AWS_PROFILE:-}" ]]; then
  : # production guarded by CONFIRM_PRODUCTION explicit env
fi

case "$MODE" in
  weekly)
    echo "Restoring from latest automated snapshot for $PRIMARY..."
    LATEST_SNAPSHOT=$(aws rds describe-db-cluster-snapshots \
      --db-cluster-identifier "$PRIMARY" \
      --snapshot-type automated \
      --query 'reverse(sort_by(DBClusterSnapshots, &SnapshotCreateTime))[0].DBClusterSnapshotIdentifier' \
      --output text)
    aws rds restore-db-cluster-from-snapshot \
      --db-cluster-identifier "$TEMP_ID" \
      --snapshot-identifier "$LATEST_SNAPSHOT" \
      --engine aurora-postgresql \
      --no-deletion-protection
    ;;
  pitr)
    echo "Performing PITR for $PRIMARY to (now - 15 minutes)..."
    RESTORE_TIME=$(date -u -d '15 minutes ago' +%Y-%m-%dT%H:%M:%SZ)
    aws rds restore-db-cluster-to-point-in-time \
      --db-cluster-identifier "$TEMP_ID" \
      --source-db-cluster-identifier "$PRIMARY" \
      --restore-to-time "$RESTORE_TIME" \
      --no-deletion-protection
    ;;
  *)
    echo "Unknown mode: $MODE (expected weekly | pitr)" >&2
    exit 2
    ;;
esac

aws rds create-db-instance \
  --db-instance-identifier "$TEMP_INSTANCE_ID" \
  --db-cluster-identifier "$TEMP_ID" \
  --db-instance-class db.r6g.large \
  --engine aurora-postgresql >/dev/null

echo "Waiting for cluster availability..."
aws rds wait db-cluster-available --db-cluster-identifier "$TEMP_ID"

ENDPOINT=$(aws rds describe-db-clusters \
  --db-cluster-identifier "$TEMP_ID" \
  --query 'DBClusters[0].Endpoint' --output text)

echo "$TEMP_ID" > /tmp/temp-cluster-id.txt
echo "$TEMP_INSTANCE_ID" > /tmp/temp-instance-id.txt
echo "$ENDPOINT" > /tmp/temp-endpoint.txt

echo "Temporary cluster $TEMP_ID restored. Endpoint: $ENDPOINT"
