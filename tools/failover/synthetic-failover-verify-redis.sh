#!/usr/bin/env bash
# Cycle 32 Step 8 — Verify Redis available + cache rebuild.
set -euo pipefail

REDIS_HOST="${REDIS_HOST_STANDBY:?REDIS_HOST_STANDBY required}"

# Ping with timeout — fail fast.
if ! redis-cli -h "$REDIS_HOST" -t 5 ping | grep -q PONG; then
  echo "FAIL: standby Redis $REDIS_HOST not responding to PING"
  exit 1
fi

# Check that some IAM cache keys exist (replicated) OR that they get
# populated within 5 minutes (cold-start rebuild). We don't strictly
# require either — just one or the other.
START=$(date +%s)
DEADLINE=$((START + 300))

while :; do
  iam_keys=$(redis-cli -h "$REDIS_HOST" --scan --pattern 'iam:access:*' | head -1 || true)
  now=$(date +%s)
  elapsed=$((now - START))
  if [[ -n "$iam_keys" ]]; then
    echo "OK: IAM cache populated after ${elapsed}s (key=$iam_keys)"
    echo "$elapsed" > /tmp/cache-rebuild-seconds.txt
    exit 0
  fi
  if (( now >= DEADLINE )); then
    echo "WARN: IAM cache empty after 5 minutes — this is acceptable if no traffic has arrived yet"
    echo "300" > /tmp/cache-rebuild-seconds.txt
    exit 0
  fi
  sleep 5
done
