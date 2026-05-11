import { createHash } from 'crypto';

/**
 * REVIEW-P2C13 ROUND 1 BLOCKING 2 + 3 — deterministic event ids for
 * the SIS Advanced outbox topics.
 *
 * Mirrors the helper shape used by Cycle 11 Transport (REVIEW-P2C11
 * BLOCKING 3) and Cycle 12 Events (REVIEW-P2C12 BLOCKING 1) —
 * SHA-256 over `<key>:<topic>:v1`, reshaped into a v5-looking UUID
 * so the existing UUID-typed columns accept it and Kafka redelivery
 * lands the same envelope through `processWithIdempotency` claims
 * + `platform.platform_event_consumer_idempotency`.
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

export function deterministicAvatarReviewedEventId(profileId: string): string {
  const h = createHash('sha256')
    .update(profileId + ':sis.avatar.reviewed:v1')
    .digest();
  return toV5Shape(h);
}

export function deterministicParentUpdateSubmittedEventId(requestId: string): string {
  const h = createHash('sha256')
    .update(requestId + ':sis.parent_update.submitted:v1')
    .digest();
  return toV5Shape(h);
}

export function deterministicParentUpdateReviewedEventId(requestId: string): string {
  const h = createHash('sha256')
    .update(requestId + ':sis.parent_update.reviewed:v1')
    .digest();
  return toV5Shape(h);
}
