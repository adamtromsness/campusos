import { createHash } from 'crypto';

/**
 * P2-27 — deterministic event ids for Portfolio Advanced outbox emits.
 *
 *   pfl.pathway.milestone_completed   keyed on (assignmentId, milestoneId)
 *
 * The same milestone can be flipped to COMPLETED through two paths:
 *   - ReadinessPathwayService.updateMilestoneStatus (counsellor / student)
 *   - ReadinessPathwayService.autoCheckByCrossModuleEvent (consumer)
 *
 * Both produce the same envelope when the same (assignment, milestone)
 * pair flips, so downstream consumers see one logical completion event
 * regardless of which path fired it, and Kafka redelivery dedups
 * cleanly through the outbox publisher.
 *
 * SHA-256 first 16 bytes reshaped into a v5-shape UUID, matching the
 * helpers across Cycles 11 / 12 / P2-12 / P2-14 / P2-20 / P2-21 /
 * P2-22 / P2-23 / P2-24 / P2-26.
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

export function deterministicMilestoneCompletedEventId(
  assignmentId: string,
  milestoneId: string,
): string {
  return toV5Shape(
    createHash('sha256')
      .update(assignmentId + ':' + milestoneId + ':pfl.pathway.milestone_completed:v1')
      .digest(),
  );
}
