import { Logger } from '@nestjs/common';
import { ConsumedMessage } from '../../kafka/kafka-consumer.service';
import { IdempotencyService } from '../../kafka/idempotency.service';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '../../notifications/consumers/notification-consumer-base';

/**
 * Shared scaffolding for the P2-15a operations read-model workers.
 *
 * Every operations worker follows the same skeleton:
 *
 *   1. Subscribe to its Kafka source topic(s) under a unique
 *      consumer-group id (e.g. `procurement-readmodel-worker`).
 *   2. Per inbound message, unwrap the ADR-057 envelope using
 *      `unwrapEnvelope` and short-circuit on a malformed envelope.
 *   3. Run `processWithIdempotency` (claim-after-success per
 *      REVIEW-CYCLE2 BLOCKING 2). The platform `iam.platform_event_consumer_idempotency`
 *      table catches Kafka redelivery; the rpt_* UNIQUE constraint
 *      catches everything else.
 *   4. Inside the per-event work, call `INSERT … ON CONFLICT … DO
 *      UPDATE` against the matching rpt_* UNIQUE constraint so
 *      replaying produces the same row.
 *   5. After successful UPSERT, record the committed Kafka offset to
 *      `rpt_analytics_worker_checkpoints` so the dashboard knows the
 *      worker is alive and on-the-wire.
 *
 * The single-writer guarantee is enforced by convention: each rpt_*
 * table is touched by exactly one consumer group; no domain module
 * writes to rpt_*. CI lint enforces this in P2-15b once the wire
 * pattern is settled.
 */

export interface OperationsWorkerOptions<P> {
  consumerGroup: string;
  topic: string;
  handler: (event: UnwrappedEvent<P>) => Promise<void>;
}

/**
 * Top-level dispatcher used by every operations consumer.
 * Pulls the envelope from the message and routes through the
 * standard idempotency wrapper.
 */
export async function dispatchOperationsEvent<P>(
  msg: ConsumedMessage,
  consumerGroup: string,
  idempotency: IdempotencyService,
  logger: Logger,
  handler: (event: UnwrappedEvent<P>) => Promise<void>,
): Promise<void> {
  const event = unwrapEnvelope<P>(msg, logger);
  if (!event) return;
  const payload = event.payload;
  if (payload === null || typeof payload !== 'object') {
    logger.warn(
      'Dropping ' + msg.topic + ' (eventId=' + event.eventId + ') — invalid payload shape',
    );
    return;
  }
  await processWithIdempotency(
    consumerGroup,
    event as UnwrappedEvent<unknown>,
    idempotency,
    logger,
    async function () {
      await handler(event);
    },
  );
}

/**
 * Return the first day of the month for an ISO date string.
 * Used to anchor monthly grain rows in rpt_*.
 */
export function monthAnchor(isoDate: string): string {
  return isoDate.slice(0, 7) + '-01';
}
