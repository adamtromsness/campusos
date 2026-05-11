import { createHash } from 'crypto';

/**
 * REVIEW-P2C13 ROUND 1 BLOCKING 7 — deterministic event id for the
 * cross-module transcript fee request. SIS no longer writes
 * pay_invoices directly; instead it emits this durable event and
 * the Payments module's TranscriptFeeConsumer (Phase 2 follow-up)
 * materialises the invoice + line items. Deterministic id means a
 * Kafka redelivery dedup at the consumer via the existing
 * platform_event_consumer_idempotency table.
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

export function deterministicTranscriptFeeRequestedEventId(requestId: string): string {
  const h = createHash('sha256')
    .update(requestId + ':sis.transcript_request.fee_requested:v1')
    .digest();
  return toV5Shape(h);
}
