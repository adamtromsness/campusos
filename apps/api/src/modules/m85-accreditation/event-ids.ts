import { createHash } from 'crypto';

/**
 * P2-23a — deterministic event ids for the Accreditation outbox emits.
 *
 *   acc.action_plan.overdue       keyed on actionPlanId
 *
 * SHA-256 first 16 bytes reshaped into a v5-shape UUID, matching the
 * helpers across Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21 /
 * P2-22. The v5-shape carries no semantic UUID meaning — Postgres
 * treats it as a regular UUID for storage. The marker nibbles let
 * the OutboxPublisherWorker spot redelivered envelopes generated
 * from the same domain key.
 *
 * For `acc.action_plan.overdue` the keying on `actionPlanId` is safe
 * because the OVERDUE state is monotonic — once a worker pass flips
 * an action plan to OVERDUE, future passes that re-evaluate the same
 * row see status=OVERDUE and skip the emit. A redelivered emit from
 * the OutboxPublisherWorker carries the same envelope event_id so
 * downstream consumers dedupe cleanly through the consumer-group
 * idempotency claim.
 */
function toV5Shape(hash: Buffer): string {
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  const hex = hash.subarray(0, 16).toString('hex');
  return (
    hex.slice(0, 8) +
    '-' +
    hex.slice(8, 12) +
    '-' +
    hex.slice(12, 16) +
    '-' +
    hex.slice(16, 20) +
    '-' +
    hex.slice(20, 32)
  );
}

export function deterministicActionPlanOverdueEventId(actionPlanId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(actionPlanId + ':acc.action_plan.overdue:v1')
      .digest(),
  );
}
