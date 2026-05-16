import { createHash } from 'crypto';

/**
 * P2-26 — deterministic event ids for Publications outbox emits.
 *
 *   pub.publication.published   keyed on publicationId
 *
 * SHA-256 first 16 bytes reshaped into a v5-shape UUID, matching the
 * helpers across Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21 /
 * P2-22 / P2-23 / P2-24. Marker nibbles let the OutboxPublisherWorker
 * spot redelivered envelopes generated from the same domain key.
 *
 * pub.publication.published can fire from two paths:
 *   - DistributionService.distribute (existing Cycle 25 path)
 *   - ScheduledPublishWorker (P2-26 Step 4)
 *
 * Both must use the same deterministic id keyed on publicationId so
 * the downstream Cycle 14 communications fan-out consumer sees the
 * same envelope regardless of which path fired the publish.
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

export function deterministicPublicationPublishedEventId(publicationId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(publicationId + ':pub.publication.published:v1')
      .digest(),
  );
}
