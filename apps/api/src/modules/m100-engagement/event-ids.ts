import { createHash } from 'crypto';

/**
 * P2-24a — deterministic event ids for the Parent Engagement outbox emits.
 *
 *   eng.conference.booking_open       keyed on conferenceEventId
 *   eng.survey.opened                 keyed on surveyId
 *
 * SHA-256 first 16 bytes reshaped into a v5-shape UUID, matching the
 * helpers across Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21 /
 * P2-22 / P2-23. Marker nibbles let the OutboxPublisherWorker spot
 * redelivered envelopes generated from the same domain key.
 *
 * Both events are monotonic once fired so deterministic ids are safe:
 *   - booking_open fires once per conference event when the
 *     ConferenceStatusWorker flips DRAFT to BOOKING_OPEN; future passes
 *     see status=BOOKING_OPEN and skip.
 *   - survey.opened fires once per survey when admin flips DRAFT to
 *     OPEN; subsequent toggles do not re-emit.
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

export function deterministicConferenceBookingOpenEventId(conferenceEventId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(conferenceEventId + ':eng.conference.booking_open:v1')
      .digest(),
  );
}

export function deterministicSurveyOpenedEventId(surveyId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(surveyId + ':eng.survey.opened:v1')
      .digest(),
  );
}
