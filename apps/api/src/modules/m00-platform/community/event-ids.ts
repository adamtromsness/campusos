import { createHash } from 'crypto';

/**
 * REVIEW-P2C21 BLOCKING 1 — deterministic event ids for the
 * P2-21c Community Exchange outbox emits.
 *
 *   mkt.listing.published        keyed on listingId
 *   mkt.transaction.completed    keyed on transactionId
 *
 * SHA-256 first 16 bytes reshaped into a v5-looking UUID — mirrors
 * the deterministic helpers across Cycles 11 + 12 + P2-12 + P2-14 +
 * P2-20.
 *
 * For listings the keying on listingId is correct because a listing
 * can be published at most once during its lifecycle (DRAFT → ACTIVE
 * is one-way; ACTIVE → EXPIRED → can't go back to ACTIVE). For
 * transactions the keying on transactionId catches the rare case
 * where a transaction lands in CONFIRMED state from two different
 * legitimate state transitions (DELIVERED → CONFIRMED and
 * DISPUTED → CONFIRMED both call emit).
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

export function deterministicListingPublishedEventId(listingId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(listingId + ':mkt.listing.published:v1')
      .digest(),
  );
}

export function deterministicTransactionCompletedEventId(transactionId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(transactionId + ':mkt.transaction.completed:v1')
      .digest(),
  );
}
