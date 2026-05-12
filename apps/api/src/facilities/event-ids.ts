import { createHash } from 'crypto';

/**
 * Deterministic event-id helper for the P2-18a facilities-advanced
 * Kafka emit `fac.route_stop.issue_noted`.
 *
 * Keys on the stop completion id so retries land the same envelope and
 * downstream consumer idempotency (claim-after-success) catches
 * redelivery cleanly. Mirrors the SHA-256 first-16-bytes-shaped-as-v5
 * pattern from Cycles 11 + 12 + P2-12 + P2-14.
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

export function deterministicRouteStopIssueNotedEventId(stopCompletionId: string): string {
  const h = createHash('sha256')
    .update(stopCompletionId + ':fac.route_stop.issue_noted:v1')
    .digest();
  return toV5Shape(h);
}
