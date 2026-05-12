import { createHash } from 'crypto';

/*
 * Deterministic event-id helpers for the scheduling module — REVIEW-P2C17
 * BLOCKING 1 fix.
 *
 * Both helpers produce a v5-shaped UUID via `sha256(<key>:<topic>:v1)` with
 * the v5 marker nibbles set (positions 6 + 8). Outbox redelivery lands the
 * same envelope every time so downstream consumers can dedup cleanly.
 *
 * Mirrors the deterministic helpers in
 *  - payments/reversal.service.ts (deterministicReversalEventId)
 *  - payments/credit-note.service.ts (deterministicCreditNoteEventId)
 *  - payments/lunch-account.service.ts (deterministicLowBalanceEventId)
 */

function makeV5UuidFromKey(key: string): string {
  const hash = createHash('sha256').update(key).digest();
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

export function deterministicGenerationCompletedEventId(requestId: string): string {
  return makeV5UuidFromKey(requestId + ':sch.generation.completed:v1');
}

export function deterministicTimetableUpdatedEventId(activationLogId: string): string {
  return makeV5UuidFromKey(activationLogId + ':sch.timetable.updated:v1');
}
