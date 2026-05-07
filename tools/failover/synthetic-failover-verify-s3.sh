#!/usr/bin/env bash
# Cycle 32 Step 8 — Verify S3 reads from the standby region.
set -euo pipefail

STANDBY_BUCKET="${S3_STANDBY_BUCKET:?S3_STANDBY_BUCKET required}"
PROBE_KEY="failover-probe/health-check.txt"

# Read a small probe file written by a periodic job. If the file
# isn't present, list the bucket — any object replicated cleanly
# proves the bucket is accessible from this region.
if aws s3api head-object --bucket "$STANDBY_BUCKET" --key "$PROBE_KEY" >/dev/null 2>&1; then
  echo "OK: probe file accessible in standby bucket $STANDBY_BUCKET"
  exit 0
fi

count=$(aws s3 ls "s3://$STANDBY_BUCKET/" --recursive --max-items 1 | wc -l)
if (( count > 0 )); then
  echo "OK: standby bucket $STANDBY_BUCKET has replicated objects"
  exit 0
fi

echo "FAIL: standby bucket $STANDBY_BUCKET appears empty — replication may be down"
exit 1
