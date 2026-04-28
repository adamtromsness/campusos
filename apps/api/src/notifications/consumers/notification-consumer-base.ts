import { Logger } from '@nestjs/common';
import { ConsumedMessage } from '../../kafka/kafka-consumer.service';
import { IdempotencyService } from '../../kafka/idempotency.service';
import { TenantInfo, runWithTenantContextAsync } from '../../tenant/tenant.context';

/**
 * Shared building blocks for the Step 5 notification consumers.
 *
 * Every consumer follows the same skeleton (REVIEW-CYCLE2 BLOCKING 2 —
 * claim-after-success):
 *
 *   1. unwrap the ADR-057 envelope and pull `event_id`, `tenant_id`,
 *      `tenant-subdomain` (legacy header) into a `TenantInfo`,
 *   2. read-only `IdempotencyService.isClaimed(group, eventId)` — if it
 *      already fired, drop,
 *   3. process the event under the resolved `runWithTenantContextAsync`,
 *      enqueuing notifications via `NotificationQueueService.enqueue()`,
 *   4. only after a successful process, call `IdempotencyService.claim()`
 *      so a transient DB failure leaves the event-id unclaimed and a
 *      Kafka redelivery rebuilds the work.
 *
 * Producers in this codebase always set the `tenant-subdomain` transport
 * header alongside the envelope. This base function fails-closed if any of
 * the three routing fields are missing — a malformed event from a future
 * producer is logged and dropped rather than silently mis-routed.
 */

export interface UnwrappedEvent<P> {
  eventId: string;
  tenant: TenantInfo;
  payload: P;
  topic: string;
}

/**
 * Pull `event_id`, `tenant_id`, and `tenant-subdomain` out of the message
 * (envelope-first, header-fallback) and reconstruct the TenantInfo. Returns
 * null and logs a warning if any required field is missing.
 */
export function unwrapEnvelope<P = unknown>(
  msg: ConsumedMessage,
  logger: Logger,
): UnwrappedEvent<P> | null {
  var raw = msg.payload as
    | (Record<string, unknown> & { payload?: unknown; tenant_id?: unknown; event_id?: unknown })
    | null;
  var hasEnvelope =
    !!raw &&
    typeof raw === 'object' &&
    'payload' in raw &&
    typeof raw.payload === 'object' &&
    raw.payload !== null;

  var eventId =
    (hasEnvelope ? (raw!.event_id as string | undefined) : undefined) || msg.headers['event-id'];
  var schoolId =
    (hasEnvelope ? (raw!.tenant_id as string | undefined) : undefined) || msg.headers['tenant-id'];
  var subdomain = msg.headers['tenant-subdomain'];

  if (!eventId || !schoolId || !subdomain) {
    logger.warn(
      'Dropping ' +
        msg.topic +
        ' — missing routing fields (event_id/tenant_id from envelope or headers, tenant-subdomain header)',
    );
    return null;
  }

  var payload = (hasEnvelope ? raw!.payload : raw) as P;
  if (payload === null || typeof payload !== 'object') {
    logger.warn('Dropping ' + msg.topic + ' (eventId=' + eventId + ') — invalid payload shape');
    return null;
  }

  var tenant: TenantInfo = {
    schoolId: schoolId,
    schemaName: 'tenant_' + subdomain,
    organisationId: null,
    subdomain: subdomain,
    isFrozen: false,
    planTier: 'STANDARD',
  };
  return { eventId, tenant, payload, topic: msg.topic };
}

/**
 * Run the per-event work and, on success, claim the event-id in the
 * idempotency table. A processing throw leaves the event unclaimed so the
 * next Kafka redelivery (or the same consumer on restart) re-runs it. The
 * recipient-side INSERT into `msg_notification_queue` is gated by Redis
 * SET NX inside `NotificationQueueService.enqueue()`, so duplicate
 * processing is harmless.
 */
export async function processWithIdempotency(
  consumerGroup: string,
  event: UnwrappedEvent<unknown>,
  idempotency: IdempotencyService,
  logger: Logger,
  process: () => Promise<void>,
): Promise<void> {
  // Read-only check first — if the claim already exists, drop.
  var alreadyClaimed: boolean;
  try {
    alreadyClaimed = await idempotency.isClaimed(consumerGroup, event.eventId);
  } catch (e: any) {
    logger.error(
      'Idempotency lookup failed (eventId=' + event.eventId + '): ' + (e?.stack || e?.message || e),
    );
    // Fail open: better to process and (idempotently) re-enqueue than to
    // silently drop a notification because the platform DB blinked.
    alreadyClaimed = false;
  }
  if (alreadyClaimed) {
    logger.debug('Skip already-claimed eventId=' + event.eventId);
    return;
  }

  await runWithTenantContextAsync({ tenant: event.tenant }, process);

  try {
    await idempotency.claim(consumerGroup, event.eventId, event.topic);
  } catch (e: any) {
    logger.warn(
      'Post-process idempotency claim failed (eventId=' +
        event.eventId +
        '): ' +
        (e?.message || e) +
        ' — notifications already enqueued; redelivery will be a Redis-deduped no-op',
    );
  }
}
