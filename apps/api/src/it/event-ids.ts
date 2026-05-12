import { createHash } from 'crypto';

/**
 * Deterministic event ids for the 3 P2-20 IT Advanced outbox topics.
 *
 *   tech.remote_action.issued   keyed on the remote_action row id
 *   tech.usage.flagged           keyed on the usage row id
 *   tech.monitoring.alert        keyed on the alert row id (each DOWN /
 *                                DEGRADED / RECOVERED row gets its own
 *                                deterministic id so a retry lands the
 *                                same envelope)
 *
 * SHA-256 first 16 bytes reshaped into a v5-looking UUID for the
 * UUID-typed event_id columns. Mirrors the deterministic helpers
 * across Cycles 11 + 12 + P2-12 + P2-14.
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

export function deterministicRemoteActionIssuedEventId(actionId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(actionId + ':tech.remote_action.issued:v1')
      .digest(),
  );
}

export function deterministicUsageFlaggedEventId(usageId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(usageId + ':tech.usage.flagged:v1')
      .digest(),
  );
}

export function deterministicMonitoringAlertEventId(alertId: string): string {
  return toV5Shape(
    createHash('sha256')
      .update(alertId + ':tech.monitoring.alert:v1')
      .digest(),
  );
}
