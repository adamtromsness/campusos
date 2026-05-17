import { createHash } from 'crypto';

/**
 * REVIEW-P2C12 ROUND 1 BLOCKING 1 — deterministic event ids for the
 * 4 events module outbox topics. Keys on the underlying domain row so
 * retries land the same envelope and consumer-side idempotency
 * (`fin_journal_batches.source_event_id UNIQUE` and the
 * `platform_event_consumer_idempotency` claim) catches redelivery
 * cleanly.
 *
 * The hash uses SHA-256 and the first 16 bytes are reshaped into a
 * v5-looking UUID (marker nibble 5 at byte 6; RFC-4122 variant bits at
 * byte 8) for compatibility with the existing UUID-typed columns.
 * Mirrors the deterministicGenerationCompletedEventId helper in the
 * transport module from REVIEW-P2C11 ROUND 1 BLOCKING 3.
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

export function deterministicOrderConfirmedEventId(orderId: string): string {
  const h = createHash('sha256')
    .update(orderId + ':evt.order.confirmed:v1')
    .digest();
  return toV5Shape(h);
}

export function deterministicRefundIssuedEventId(refundId: string): string {
  const h = createHash('sha256')
    .update(refundId + ':evt.refund.issued:v1')
    .digest();
  return toV5Shape(h);
}

export function deterministicEventCompletedEventId(eventId: string): string {
  const h = createHash('sha256')
    .update(eventId + ':evt.event.completed:v1')
    .digest();
  return toV5Shape(h);
}

export function deterministicAthleticEventCreatedEventId(eventId: string): string {
  const h = createHash('sha256')
    .update(eventId + ':evt.athletic_event.created:v1')
    .digest();
  return toV5Shape(h);
}
