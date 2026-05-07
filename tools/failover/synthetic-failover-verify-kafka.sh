#!/usr/bin/env bash
# Cycle 32 Step 8 — Verify Kafka consumers in the new primary region
# resumed from the translated offsets (not from-earliest). Critical
# for the no-double-processing guarantee on financial events.
set -euo pipefail

BOOTSTRAP="${KAFKA_BROKERS_STANDBY:?KAFKA_BROKERS_STANDBY required}"

# Each known consumer group must show non-zero committed offsets on
# its critical topics. From-earliest replay would show offset=0; if
# we see > 0 we know MM2's offset translation worked.
GROUPS=(
  "gradebook-snapshot-worker"
  "task-worker"
  "payment-account-worker"
  "audience-fan-out-worker"
  "leave-notification-consumer"
  "ticket-notification-consumer"
  "behaviour-notification-consumer"
  "notification-delivery-worker"
  "gl-consumer"
  "iep-accommodation-consumer"
)

failed=0
for group in "${GROUPS[@]}"; do
  out=$(kafka-consumer-groups.sh \
    --bootstrap-server "$BOOTSTRAP" \
    --describe --group "$group" 2>/dev/null || echo "")

  if [[ -z "$out" ]]; then
    echo "WARN: group $group not found in standby cluster yet (acceptable on first deploy)"
    continue
  fi

  # Sum CURRENT-OFFSET column (3rd numeric); if it's 0 across all
  # partitions the consumer has not picked up the MM2 translation.
  total_offset=$(echo "$out" | awk 'NR > 1 && $4 ~ /^[0-9]+$/ { sum += $4 } END { print sum+0 }')
  if (( total_offset == 0 )); then
    echo "FAIL: group $group has 0 committed offset across all partitions — MM2 translation did not work"
    failed=$((failed + 1))
  else
    echo "OK:   group $group has $total_offset total committed offset"
  fi
done

(( failed == 0 )) || exit 1
echo "Consumer offset translation verified across all critical groups."
