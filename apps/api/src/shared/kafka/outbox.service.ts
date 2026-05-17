import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { getCurrentTenant } from '@shared/tenant/tenant.context';
import { EnvelopeOptions, envelopeFromOptions, EventEnvelope } from './event-envelope';

/**
 * REVIEW-FINAL P2 — Transactional Outbox.
 *
 * The reliability complement to `KafkaProducerService.emit()`.
 * Where `emit()` is best-effort (a broker outage drops the event
 * silently), `OutboxService.enqueueInTx()` writes the wire-shape
 * envelope to `platform.platform_outbox` INSIDE the caller's
 * transaction. The outbox row commits with the caller's tx; the
 * `OutboxPublisherWorker` later polls, publishes via the producer,
 * and marks `published_at` on success.
 *
 * Use this for safety-critical emits where dropping the event is
 * worse than blocking the request:
 *   - dpo.breach.discovered  — 72-hour regulatory deadline.
 *   - svc.wellbeing.alert.created (SHI) — clinical safety auto-escalation.
 *   - msg.emergency.issued   — life-safety multi-channel fan-out.
 *   - pay.payment.received   — financial events feeding the GL consumer.
 *   - pay.invoice.created    — financial events.
 *   - pay.refund.issued      — financial events.
 *
 * Best-effort `emit()` stays in place for non-critical events
 * (notifications, audience fan-out, debouncer triggers) where the
 * trade-off favours request latency.
 *
 * Caller pattern:
 *   await tx.executeInTenantTransaction(async (tx) => {
 *     // ... domain writes ...
 *     await outbox.enqueueInTx(tx, {
 *       topic: 'dpo.breach.discovered',
 *       key: breachId,
 *       payload: {...},
 *       sourceModule: 'governance',
 *     });
 *   });
 *
 * The tenant context (`getCurrentTenant`) populates tenant_id +
 * tenant subdomain on the envelope automatically. Worker-originated
 * emits with no request context can pass `tenantId` + `tenantSubdomain`
 * explicitly, mirroring `EmitOptions`.
 */
export interface OutboxEnqueueOptions<P = unknown> {
  topic: string;
  key: string;
  payload: P;
  sourceModule: string;
  eventVersion?: number;
  occurredAt?: string;
  tenantId?: string;
  tenantSubdomain?: string;
  correlationId?: string;
  eventId?: string;
}

/**
 * Subset of PrismaClient methods the enqueue path needs. Allows the
 * caller to pass the open `tx` returned by `executeInTenantTransaction`
 * without requiring the full PrismaClient interface.
 */
export interface OutboxTxClient {
  $executeRawUnsafe: (sql: string, ...args: unknown[]) => Promise<unknown>;
}

@Injectable()
export class OutboxService {
  private readonly logger = new Logger(OutboxService.name);

  /**
   * Append a wire-shape envelope to the outbox INSIDE the caller's
   * transaction. The caller is responsible for committing its tx —
   * the outbox row is durable iff the parent tx commits.
   *
   * The OutboxPublisherWorker handles the rest: poll, publish via
   * KafkaProducerService.emitRaw(), mark published_at on success.
   */
  async enqueueInTx<P = unknown>(
    tx: OutboxTxClient,
    opts: OutboxEnqueueOptions<P>,
  ): Promise<string> {
    const envelopeOpts: EnvelopeOptions<P> = {
      eventType: opts.topic,
      payload: opts.payload,
      sourceModule: opts.sourceModule,
      eventVersion: opts.eventVersion,
      occurredAt: opts.occurredAt,
      tenantId: opts.tenantId,
      correlationId: opts.correlationId,
      eventId: opts.eventId,
    };
    const envelope: EventEnvelope<P> = envelopeFromOptions(envelopeOpts);

    let tenantSubdomain: string | undefined = opts.tenantSubdomain;
    let tenantIdResolved: string | undefined = opts.tenantId;
    if (!tenantSubdomain || !tenantIdResolved) {
      try {
        const t = getCurrentTenant();
        tenantSubdomain = tenantSubdomain ?? t.subdomain;
        tenantIdResolved = tenantIdResolved ?? t.schoolId;
      } catch {
        // worker-originated path — caller must supply explicitly.
      }
    }

    const id = generateId();
    await tx.$executeRawUnsafe(
      `INSERT INTO platform.platform_outbox
        (id, topic, envelope, message_key, tenant_id, source_module, created_at)
       VALUES ($1::uuid, $2, $3::jsonb, $4, $5::uuid, $6, now())`,
      id,
      opts.topic,
      JSON.stringify({
        ...envelope,
        // The worker reads `tenant_subdomain` off the envelope when
        // setting the legacy `tenant-subdomain` Kafka header. Stash
        // it on the envelope JSON so the worker doesn't need to
        // re-resolve it. (envelopeFromOptions doesn't surface it
        // because the canonical envelope spec has tenant_id only.)
        tenant_subdomain: tenantSubdomain ?? null,
      }),
      opts.key ?? null,
      tenantIdResolved ?? null,
      opts.sourceModule,
    );

    this.logger.debug(
      `[outbox.enqueueInTx] topic=${opts.topic} id=${id.slice(0, 8)} tenant=${tenantSubdomain ?? '-'}`,
    );
    return id;
  }
}
