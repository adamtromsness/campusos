import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { KafkaProducerNotConnectedError, KafkaProducerService } from './kafka-producer.service';
import { prefixedTopic } from './event-envelope';

/**
 * REVIEW-FINAL P2 — OutboxPublisherWorker.
 *
 * Polls `platform.platform_outbox` for unpublished rows oldest-first
 * and publishes each via `KafkaProducerService.emitRaw()`. On success
 * sets `published_at`; on failure bumps `attempt_count` + records
 * `last_error` + sets `failed_at` so operators can monitor stuck rows.
 *
 * A row that fails MAX_OUTBOX_ATTEMPTS (default 10) consecutively
 * stays at `failed_at` and is excluded from the poll WHERE clause;
 * an operator must intervene (typically: investigate the broker
 * issue, then NULL out failed_at + attempt_count to retry, OR mark
 * published_at to write off the row).
 *
 * Idempotency at the consumer side is unchanged — the
 * `processWithIdempotency` claim-after-success pattern handles
 * Kafka redelivery. The outbox just adds DURABLE producer-side
 * delivery on top.
 *
 * Worker lifecycle:
 *   - Polls every OUTBOX_POLL_INTERVAL_MS (default 5_000 = 5s).
 *   - Each poll picks up to OUTBOX_BATCH_SIZE (default 100) pending
 *     rows in a single SELECT … FOR UPDATE SKIP LOCKED so multiple
 *     replicas can run the worker concurrently without double-
 *     publishing.
 *   - Publishes one at a time so a per-row producer error doesn't
 *     starve the rest of the batch.
 *
 * The worker can be disabled in dev via OUTBOX_PUBLISHER_DISABLED=1
 * (matching the convention used by ReferenceHealthScannerWorker).
 */
const POLL_INTERVAL_MS = Number(process.env.OUTBOX_POLL_INTERVAL_MS || 5_000);
const BATCH_SIZE = Number(process.env.OUTBOX_BATCH_SIZE || 100);
const MAX_OUTBOX_ATTEMPTS = Number(process.env.MAX_OUTBOX_ATTEMPTS || 10);

interface OutboxRow {
  id: string;
  topic: string;
  envelope: Record<string, unknown>;
  message_key: string | null;
  tenant_id: string | null;
  source_module: string;
  attempt_count: number;
}

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(OutboxPublisherWorker.name);
  private intervalHandle: NodeJS.Timeout | null = null;
  private polling = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly producer: KafkaProducerService,
  ) {}

  async onModuleInit(): Promise<void> {
    if (process.env.OUTBOX_PUBLISHER_DISABLED === '1') {
      this.logger.log('OutboxPublisherWorker disabled via OUTBOX_PUBLISHER_DISABLED=1');
      return;
    }
    // Stagger initial start so multiple replicas don't all hammer
    // the same poll on boot.
    const initialDelayMs = 1_000 + Math.floor(Math.random() * 1_000);
    setTimeout(() => {
      this.tickSafely();
      this.intervalHandle = setInterval(() => this.tickSafely(), POLL_INTERVAL_MS);
    }, initialDelayMs);
    this.logger.log(
      `OutboxPublisherWorker scheduled (poll=${POLL_INTERVAL_MS}ms, batch=${BATCH_SIZE}, max_attempts=${MAX_OUTBOX_ATTEMPTS})`,
    );
  }

  onApplicationShutdown(): void {
    if (this.intervalHandle) clearInterval(this.intervalHandle);
  }

  private tickSafely(): void {
    if (this.polling) return; // re-entrancy guard for slow polls
    this.polling = true;
    this.tick()
      .catch((e: unknown) => {
        this.logger.error(
          'Outbox poll failed: ' + ((e as Error)?.stack || (e as Error)?.message || String(e)),
        );
      })
      .finally(() => {
        this.polling = false;
      });
  }

  /**
   * One poll cycle: pick up to BATCH_SIZE pending rows + publish each.
   * Per-row failure does not abort the batch.
   */
  private async tick(): Promise<void> {
    const platform = this.tenantPrisma.getPlatformClient();
    // SELECT FOR UPDATE SKIP LOCKED so multiple worker replicas can
    // run concurrently. Filter excludes rows that have failed
    // MAX_OUTBOX_ATTEMPTS times — they need operator action.
    const rows = (await platform.$queryRawUnsafe(
      `SELECT id, topic, envelope, message_key, tenant_id, source_module, attempt_count
         FROM platform.platform_outbox
        WHERE published_at IS NULL
          AND attempt_count < $1
        ORDER BY created_at ASC
        LIMIT $2
        FOR UPDATE SKIP LOCKED`,
      MAX_OUTBOX_ATTEMPTS,
      BATCH_SIZE,
    )) as OutboxRow[];

    if (rows.length === 0) return;
    this.logger.debug(`[outbox.tick] picked ${rows.length} rows`);

    for (const row of rows) {
      await this.publishOne(row);
    }
  }

  private async publishOne(row: OutboxRow): Promise<void> {
    const platform = this.tenantPrisma.getPlatformClient();
    try {
      const wireTopic = prefixedTopic(row.topic);
      // Pull tenant_subdomain off the envelope JSON and pass it
      // through as a Kafka transport header. tenant_subdomain is an
      // internal routing hint stashed by OutboxService.enqueueInTx
      // — it is NOT part of the canonical ADR-057 envelope, so we
      // strip it from the JSON we send on the wire and forward it
      // separately as the legacy `tenant-subdomain` header that
      // unwrapEnvelope() in notification-consumer-base requires.
      // (REVIEW-FINAL Q1 — without this forwarding, outbox-
      // published events drop tenant-subdomain and consumers that
      // route on the legacy header silently discard the message.)
      const env = row.envelope as Record<string, unknown> & { tenant_subdomain?: string | null };
      const subdomain = env.tenant_subdomain ?? null;
      const envelopeForSend: Record<string, unknown> = { ...env };
      delete envelopeForSend.tenant_subdomain;

      await this.producer.emitRaw({
        topic: wireTopic,
        key: row.message_key,
        envelope: envelopeForSend as {
          event_id?: string;
          event_type?: string;
          tenant_id?: string;
          [k: string]: unknown;
        },
        tenantSubdomain: subdomain,
      });
      await platform.$executeRawUnsafe(
        `UPDATE platform.platform_outbox
            SET published_at = now(), failed_at = NULL, last_error = NULL
          WHERE id = $1::uuid`,
        row.id,
      );
      this.logger.log(
        `[outbox.publish] topic=${row.topic} id=${row.id.slice(0, 8)} tenant=${row.tenant_id ?? '-'} subdomain=${subdomain ?? '-'} (attempt ${row.attempt_count + 1})`,
      );
    } catch (e: unknown) {
      const errMsg =
        (e as Error)?.message ||
        (typeof e === 'string' ? e : JSON.stringify(e)) ||
        'unknown publisher error';
      const isConnectionError = e instanceof KafkaProducerNotConnectedError;
      try {
        await platform.$executeRawUnsafe(
          `UPDATE platform.platform_outbox
              SET attempt_count = attempt_count + 1,
                  failed_at = now(),
                  last_error = $2
            WHERE id = $1::uuid`,
          row.id,
          errMsg.slice(0, 4000),
        );
      } catch (updateErr: unknown) {
        this.logger.error(
          'Outbox bookkeeping update FAILED for row ' +
            row.id +
            ': ' +
            ((updateErr as Error)?.message || updateErr),
        );
      }
      if (isConnectionError) {
        this.logger.warn(
          `[outbox.publish-fail] topic=${row.topic} id=${row.id.slice(0, 8)} — broker unavailable; will retry on next poll`,
        );
      } else {
        this.logger.error(
          `[outbox.publish-fail] topic=${row.topic} id=${row.id.slice(0, 8)}: ${errMsg}`,
        );
      }
    }
  }
}
