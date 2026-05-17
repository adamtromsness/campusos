import { createHash } from 'crypto';

/**
 * REVIEW-P2C28 Round 1 BLOCKING 6 — deterministic event_id helper for
 * the durable svc.referral.escalated outbox emit. A retry against the
 * same (referralId, activityId) pair produces the exact same Kafka
 * event_id so the downstream notification + analytics consumers'
 * idempotency catches the redelivery cleanly. Same shape as
 * deterministicCreditNoteEventId in payments — sha256 first 16 bytes
 * with the UUID v5 marker nibbles.
 */
export function deterministicReferralEscalatedEventId(
  referralId: string,
  activityId: string,
): string {
  const hash = createHash('sha256')
    .update(referralId + ':' + activityId + ':svc.referral.escalated:v1')
    .digest();
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
