import { createHash } from 'crypto';

/**
 * REVIEW-P2C22 BLOCKING 1 — deterministic event ids for the P2-22
 * Alumni outbox emits.
 *
 *   alm.campaign.activated       keyed on campaignId
 *   alm.donation.received        keyed on donationId
 *
 * SHA-256 first 16 bytes reshaped into a v5-looking UUID, matching
 * the helpers across Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21.
 * The v5-shape carries no semantic UUID meaning — Postgres treats
 * it as a regular UUID for storage. The marker nibbles let the
 * OutboxPublisherWorker spot redelivered envelopes generated from
 * the same domain key.
 *
 * For `alm.campaign.activated` the keying on `campaignId` is safe
 * because the lifecycle is one-way (DRAFT → ACTIVE; ACTIVE never
 * returns to DRAFT). A retried activate against an already-active
 * row collapses to a 409 at the service layer before the outbox
 * row would be enqueued.
 *
 * For `alm.donation.received` the keying on `donationId` is the
 * primary key of the donation row itself, which is generated once
 * inside the same tx as the INSERT. A redelivered emit from the
 * OutboxPublisherWorker carries the same envelope event_id so
 * downstream consumers dedupe cleanly through the consumer-group
 * idempotency claim.
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

export function deterministicCampaignActivatedEventId(campaignId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(campaignId + ':alm.campaign.activated:v1')
      .digest(),
  );
}

export function deterministicDonationReceivedEventId(donationId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(donationId + ':alm.donation.received:v1')
      .digest(),
  );
}
