import { createHash } from 'crypto';

/**
 * P2-29a — deterministic event ids for the Commerce bundle outbox emits.
 *
 *   prc.contract.expiring          keyed on contractId
 *   prc.contract.amended           keyed on amendmentId
 *   fin.budget_transfer.approved   keyed on transferId
 *   fin.journal_batch.posted       keyed on batchId
 *
 * SHA-256 first 16 bytes reshaped into a v5-shape UUID, matching the
 * helpers across Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21 /
 * P2-22 / P2-23 / P2-24. Marker nibbles let the OutboxPublisherWorker
 * spot redelivered envelopes generated from the same domain key.
 *
 * All four events are monotonic once fired so deterministic ids are
 * safe:
 *   - contract.expiring fires once per contract when the
 *     ContractExpiryWorker flips ACTIVE to EXPIRING. Subsequent ticks
 *     see status=EXPIRING and skip.
 *   - contract.amended fires once per amendment row insert.
 *   - budget_transfer.approved fires once when status flips PENDING
 *     to APPROVED.
 *   - journal_batch.posted fires once when status flips DRAFT to
 *     POSTED.
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

export function deterministicContractExpiringEventId(contractId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(contractId + ':prc.contract.expiring:v1')
      .digest(),
  );
}

export function deterministicContractAmendedEventId(amendmentId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(amendmentId + ':prc.contract.amended:v1')
      .digest(),
  );
}

export function deterministicBudgetTransferApprovedEventId(transferId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(transferId + ':fin.budget_transfer.approved:v1')
      .digest(),
  );
}

export function deterministicJournalBatchPostedEventId(batchId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(batchId + ':fin.journal_batch.posted:v1')
      .digest(),
  );
}

/**
 * P2-29b — Store Advanced event ids.
 *
 *   str.promotion.code_redeemed   keyed on (promotionId, current_uses_after)
 *   str.price.scheduled_applied   keyed on (scheduleId, applied_at)
 *   str.gift_card.depleted        keyed on giftCardId
 *
 * The promotion redemption helper keys on the post-increment uses
 * counter so each successful atomic UPDATE produces a fresh event id
 * even though the promotion id is reused across many customers.
 */
export function deterministicPromotionRedeemedEventId(
  promotionId: string,
  usesAfter: number,
): string {
  return toV5Shape(
    createHash('sha256')
      .update(`${promotionId}:${usesAfter}:str.promotion.code_redeemed:v1`)
      .digest(),
  );
}

export function deterministicPriceScheduleAppliedEventId(scheduleId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(scheduleId + ':str.price.scheduled_applied:v1')
      .digest(),
  );
}

export function deterministicGiftCardDepletedEventId(giftCardId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(giftCardId + ':str.gift_card.depleted:v1')
      .digest(),
  );
}
