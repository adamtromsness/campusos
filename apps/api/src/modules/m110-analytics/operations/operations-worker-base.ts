import { Logger } from '@nestjs/common';
import { ConsumedMessage } from '@shared/kafka';
import { IdempotencyService } from '@shared/kafka';
import {
  UnwrappedEvent,
  processWithIdempotency,
  unwrapEnvelope,
} from '@shared/kafka';

/**
 * Shared scaffolding for the P2-15 read-model workers.
 *
 * The wire-level contract has three idempotency layers and one tenant-isolation gate:
 *
 *   1. **Outer claim-after-success** (`processWithIdempotency`) — catches the
 *      common Kafka redelivery case via `platform.platform_event_consumer_idempotency`.
 *      Read-only check on arrival, claim only after successful handler. Same pattern
 *      as Cycle 3 notification consumers (REVIEW-CYCLE2 BLOCKING 2).
 *
 *   2. **Inner contribution ledger** (`claimReadModelContribution`) — the
 *      crash-after-update fix. Tenant-local `rpt_event_contributions` table with
 *      UNIQUE(consumer_group, source_event_id, target_table). Workers insert the
 *      contribution row inside the SAME tenant tx as the additive UPSERT, so a
 *      redelivery after a partial failure between the additive update and the
 *      outer claim cannot double-count — the contribution INSERT hits ON CONFLICT
 *      DO NOTHING and the worker short-circuits before re-applying the update.
 *      (REVIEW-P2C15 R1 BLOCKING 1.)
 *
 *   3. **DB UNIQUE constraint UPSERT** — every rpt_* table has a per-grain UNIQUE
 *      index. Replay against the same key produces the same row state.
 *
 *   4. **Envelope/payload tenant-school validation** (`assertPayloadSchoolMatchesEnvelope`)
 *      — workers refuse to UPSERT when `payload.schoolId` does not match the
 *      envelope's `tenant.schoolId`. Drops the event with a WARN log. Defends
 *      against malformed domain emits where the payload references a different
 *      school than the tenant context the consumer is running in. (REVIEW-P2C15 R1 BLOCKING 3.)
 *
 * The single-writer guarantee is enforced by convention: each rpt_* table is
 * touched by exactly one consumer group (see HANDOFF-P2C15.md for the audit table).
 */

export interface OperationsWorkerOptions<P> {
  consumerGroup: string;
  topic: string;
  handler: (event: UnwrappedEvent<P>) => Promise<void>;
}

/**
 * Top-level dispatcher used by every operations consumer.
 * Pulls the envelope from the message and routes through the standard
 * idempotency wrapper.
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
 * Return the first day of the month for an ISO date string. Used to anchor
 * monthly grain rows in rpt_*.
 */
export function monthAnchor(isoDate: string): string {
  return isoDate.slice(0, 7) + '-01';
}

/**
 * Try to claim a single (consumer_group, source_event_id, target_table) contribution
 * inside an open tenant transaction. Returns true when the worker should proceed
 * with the additive UPSERT, false when the event has already been applied and the
 * worker should skip.
 *
 * The contract: callers MUST run this inside `executeInTenantTransaction` (or
 * a wrapping tenant tx) and MUST treat `false` as a no-op (no further writes).
 *
 * Implementation runs `INSERT ... ON CONFLICT DO NOTHING` against `rpt_event_contributions`.
 * Postgres reports the row count via Prisma's `$executeRawUnsafe` return value —
 * 1 means we won the claim, 0 means the row already existed.
 */
export async function claimReadModelContribution(
  tx: { $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<number> },
  consumerGroup: string,
  sourceEventId: string,
  targetTable: string,
): Promise<boolean> {
  if (!sourceEventId) return true; // tests / synthetic events without an eventId proceed unconditionally
  const inserted = await tx.$executeRawUnsafe(
    `INSERT INTO rpt_event_contributions (consumer_group, source_event_id, target_table, applied_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (consumer_group, source_event_id, target_table) DO NOTHING`,
    consumerGroup,
    sourceEventId,
    targetTable,
  );
  return inserted > 0;
}

/**
 * Validates that the supplied payload schoolId matches the envelope's
 * tenant.schoolId. Returns true when the worker should proceed, false when it
 * should drop the event with a WARN log.
 *
 * This is the wire-level tenant-isolation gate for P2-15 read-model workers.
 * A malformed or buggy domain event with envelope context for School A but
 * payload pointing at School B would otherwise pollute the analytics row for
 * School B inside School A's tenant schema. Defends both schools.
 */
export function assertPayloadSchoolMatchesEnvelope(
  event: { tenant: { schoolId: string }; eventId?: string },
  payloadSchoolId: string | null | undefined,
  consumerGroup: string,
  topic: string,
  logger: Logger,
): boolean {
  if (!payloadSchoolId) return true; // payload doesn't carry a schoolId — nothing to validate against
  const envelopeSchoolId = event.tenant?.schoolId;
  if (!envelopeSchoolId) return true; // synthetic/test envelope without a school context — proceed
  if (envelopeSchoolId !== payloadSchoolId) {
    logger.warn(
      '[' +
        consumerGroup +
        '] schoolId mismatch — envelope=' +
        envelopeSchoolId +
        ' payload=' +
        payloadSchoolId +
        ' topic=' +
        topic +
        ' eventId=' +
        (event.eventId ?? 'unknown') +
        ' — dropping',
    );
    return false;
  }
  return true;
}
