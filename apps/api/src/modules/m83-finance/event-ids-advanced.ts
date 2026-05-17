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
