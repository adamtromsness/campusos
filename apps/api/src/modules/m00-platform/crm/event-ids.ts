import { createHash } from 'crypto';

/**
 * REVIEW-P2C21 BLOCKING 1 — deterministic event ids for the
 * P2-21a CRM outbox emit.
 *
 *   crm.account.lifecycle_changed   keyed on (accountId, toStatus)
 *
 * A given (account, target-status) row carries the same envelope on
 * every retry so the consumer-side idempotency claim catches
 * redelivery cleanly.
 *
 * SHA-256 first 16 bytes reshaped into a v5-looking UUID — mirrors
 * the deterministic helpers across Cycles 11 + 12 + P2-12 + P2-14 +
 * P2-20.
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

export function deterministicAccountLifecycleEventId(accountId: string, toStatus: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(accountId + ':' + toStatus + ':crm.account.lifecycle_changed:v1')
      .digest(),
  );
}
