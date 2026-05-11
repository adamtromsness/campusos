import { createHash } from 'crypto';

/**
 * REVIEW-P2C13 ROUND 1 BLOCKING 5 — deterministic event id for
 * sis.graduation.at_risk. The audit worker run is identified by
 * (studentId, runId), so a redelivery from a Kafka retry lands the
 * same envelope and downstream consumers can dedup via the platform
 * event-consumer idempotency table.
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

export function deterministicAtRiskEventId(studentId: string, runId: string): string {
  const h = createHash('sha256')
    .update(studentId + ':' + runId + ':sis.graduation.at_risk:v1')
    .digest();
  return toV5Shape(h);
}
