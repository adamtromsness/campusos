import { createHash } from 'crypto';

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
