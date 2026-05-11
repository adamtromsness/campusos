import { createHash } from 'crypto';

/**
 * Deterministic event ids for the 2 P2-14 behaviour-advanced outbox
 * topics. Keys on the underlying domain row so retries land the same
 * envelope and consumer-side idempotency catches redelivery cleanly.
 *
 * SHA-256 first 16 bytes reshaped into a v5-looking UUID for the
 * UUID-typed event_id columns. Mirrors the deterministic helpers
 * across Cycles 11 + 12 + P2-12.
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

export function deterministicRjResolvedEventId(conferenceId: string): string {
  const h = createHash('sha256')
    .update(conferenceId + ':beh.rj_conference.resolved:v1')
    .digest();
  return toV5Shape(h);
}

export function deterministicPositivePointsAwardedEventId(transactionId: string): string {
  const h = createHash('sha256')
    .update(transactionId + ':beh.positive_points.awarded:v1')
    .digest();
  return toV5Shape(h);
}
