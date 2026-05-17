import { createHash } from 'crypto';

/**
 * P2-25 — deterministic event ids for the Library Advanced outbox emits.
 *
 *   lib.import.completed       keyed on importJobId
 *
 * SHA-256 first 16 bytes reshaped into a v5-shape UUID, matching the
 * helpers across Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21 /
 * P2-22 / P2-23 / P2-24. Marker nibbles let the OutboxPublisherWorker
 * spot redelivered envelopes generated from the same domain key.
 *
 * The import.completed event is monotonic — fires once per import job
 * on the terminal COMPLETED or FAILED transition. Re-running the
 * CatalogueImportWorker on the same row is a no-op because the
 * status filter excludes terminal rows; a deterministic event_id
 * means a stuck row that the worker reprocesses still produces the
 * same envelope.
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

export function deterministicLibImportCompletedEventId(importJobId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(importJobId + ':lib.import.completed:v1')
      .digest(),
  );
}
