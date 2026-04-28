import { Injectable, Logger, OnApplicationShutdown, OnModuleInit } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { TenantInfo, runWithTenantContextAsync } from '../tenant/tenant.context';
import { RedisService } from './redis.service';

/**
 * NotificationDeliveryWorker — pulls PENDING rows out of every tenant's
 * `msg_notification_queue` and delivers them by channel.
 *
 * Channels (per the Cycle 3 plan):
 *   - IN_APP: real delivery — ZADD into Redis sorted set
 *     `notif:inapp:{accountId}` so the Step 8 NotificationBell can render
 *     unread items via ZREVRANGE. Also writes a `msg_notification_log`
 *     row with status=DELIVERED.
 *   - EMAIL / PUSH / SMS: stubbed. The worker logs a "[stub-deliver]"
 *     line and writes a `msg_notification_log` row with status=SENT
 *     (provider integration is Phase 3 work). We mark the queue row SENT
 *     all the same so the polling loop doesn't reprocess it.
 *
 * State machine (REVIEW-CYCLE3 BLOCKING 2):
 *
 *   PENDING    -> PROCESSING  (claim under FOR UPDATE in a short tx)
 *   PROCESSING -> SENT        (only after successful Redis + log writes)
 *   PROCESSING -> PENDING     (transient failure — scheduled_for backoff,
 *                              attempts++; eventually FAILED at MAX_ATTEMPTS)
 *   PROCESSING -> PENDING     (also via the stale-row sweep below, for
 *                              rows whose worker died mid-flight)
 *
 * SENT means "delivered" — never just "in-flight". A crash between the claim
 * and the delivery leaves the row in PROCESSING with `processing_started_at`
 * stamped; the next tick's sweep resets such rows to PENDING after the
 * stale threshold so delivery is retried.
 *
 * Multi-tenant polling: the worker fetches the active school list from
 * `platform.schools` once per tick, then for each school enters
 * `runWithTenantContextAsync` and runs a single
 * `SELECT … FOR UPDATE SKIP LOCKED LIMIT 25` against the tenant's queue.
 * Rows are processed sequentially per tick — concurrency is bounded by
 * the `LIMIT` and `SKIP LOCKED` is in place so two API instances can
 * safely run side by side.
 *
 * Polling cadence: every `POLL_INTERVAL_MS` (10s by default — overridable
 * via `NOTIFICATION_POLL_INTERVAL_MS`). Each tick is fired by an
 * `unref()`'d timeout so the loop never blocks Node from exiting on
 * shutdown.
 *
 * Retry policy: a delivery failure increments `attempts` and re-flips the
 * row to PENDING with a 30-second backoff (the row's `scheduled_for` is
 * pushed forward). After 5 failed attempts the row is moved to FAILED so
 * a future moderator-reviewable view can pick it up. The DLQ table
 * (`platform_dlq_messages`) is tied to Kafka consumer failures, not
 * delivery failures — keeping the two pipelines independent.
 */
var POLL_INTERVAL_MS_DEFAULT = 10_000;
var POLL_BATCH = 25;
var FAILURE_BACKOFF_SECONDS = 30;
var MAX_ATTEMPTS = 5;
// Rows stuck in PROCESSING for longer than this are assumed orphaned by a
// dead worker and recovered to PENDING on the next tick. Generous default —
// in practice no individual delivery should take more than a few seconds.
var STALE_PROCESSING_SECONDS = 5 * 60;

interface PendingRow {
  id: string;
  recipient_id: string;
  notification_type: string;
  payload: unknown;
  attempts: number;
  correlation_id: string | null;
}

@Injectable()
export class NotificationDeliveryWorker implements OnModuleInit, OnApplicationShutdown {
  private readonly logger = new Logger(NotificationDeliveryWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private stopped = false;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly redis: RedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    var intervalMs = Number(process.env.NOTIFICATION_POLL_INTERVAL_MS) || POLL_INTERVAL_MS_DEFAULT;
    this.logger.log('NotificationDeliveryWorker polling every ' + intervalMs + 'ms');
    this.scheduleNext(intervalMs);
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  /**
   * Test seam — manually flush every PENDING row across all tenants
   * synchronously. Used by smoke scripts so they don't have to wait for
   * the next tick. Not called by the production code path.
   */
  async pollOnceForTest(): Promise<void> {
    await this.tick();
  }

  private scheduleNext(intervalMs: number): void {
    if (this.stopped) return;
    var self = this;
    this.timer = setTimeout(async function () {
      try {
        await self.tick();
      } catch (e: any) {
        self.logger.error('Tick failed: ' + (e?.stack || e?.message || e));
      } finally {
        self.scheduleNext(intervalMs);
      }
    }, intervalMs);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running) {
      // Two ticks racing means an earlier tick is still running. Skip the
      // newer tick — its work will be picked up on the next interval.
      this.logger.debug('Skip tick — previous tick still running');
      return;
    }
    this.running = true;
    try {
      var schools = await this.loadActiveSchools();
      for (var i = 0; i < schools.length; i++) {
        await this.tickForTenant(schools[i]!);
      }
    } finally {
      this.running = false;
    }
  }

  private async loadActiveSchools(): Promise<TenantInfo[]> {
    try {
      var client = this.tenantPrisma.getPlatformClient();
      var rows = await client.$queryRawUnsafe<
        Array<{
          id: string;
          subdomain: string;
          schema_name: string;
          organisation_id: string | null;
        }>
      >(
        'SELECT id::text AS id, subdomain, schema_name, organisation_id::text AS organisation_id ' +
          'FROM platform.schools WHERE is_active = true',
      );
      return rows.map(function (r): TenantInfo {
        return {
          schoolId: r.id,
          subdomain: r.subdomain,
          schemaName: r.schema_name,
          organisationId: r.organisation_id,
          isFrozen: false,
          planTier: 'STANDARD',
        };
      });
    } catch (e: any) {
      // Platform DB unreachable — log once per tick and skip.
      this.logger.warn('Could not load schools: ' + (e?.message || e));
      return [];
    }
  }

  private async tickForTenant(tenant: TenantInfo): Promise<void> {
    var self = this;
    try {
      await runWithTenantContextAsync({ tenant: tenant }, async function () {
        await self.processPendingForTenant(tenant);
      });
    } catch (e: any) {
      this.logger.warn(
        'Tenant tick failed for ' + tenant.subdomain + ': ' + (e?.stack || e?.message || e),
      );
    }
  }

  private async processPendingForTenant(tenant: TenantInfo): Promise<void> {
    // Phase 0 — recover stale PROCESSING rows. A worker that died mid-flight
    // would have left rows in PROCESSING with processing_started_at stamped.
    // Reset them to PENDING with a fresh scheduled_for so this tick picks
    // them up. Bounded by STALE_PROCESSING_SECONDS so we don't stomp on
    // legitimately-running deliveries from a sibling worker.
    await this.recoverStaleProcessing();

    // Phase 1 — claim a batch atomically. SELECT … FOR UPDATE SKIP LOCKED
    // + UPDATE status='PROCESSING' commits the in-flight flag without
    // marking the row delivered. PROCESSING means "claimed", not "done".
    var rows = await this.tenantPrisma.executeInTenantTransaction(async (tx) => {
      var pending = await tx.$queryRawUnsafe<PendingRow[]>(
        'SELECT id, recipient_id, notification_type, payload, attempts, correlation_id ' +
          'FROM msg_notification_queue ' +
          "WHERE status = 'PENDING' AND scheduled_for <= now() " +
          'ORDER BY scheduled_for ASC ' +
          'LIMIT $1 ' +
          'FOR UPDATE SKIP LOCKED',
        POLL_BATCH,
      );
      if (pending.length === 0) return [] as PendingRow[];

      for (var i = 0; i < pending.length; i++) {
        await tx.$executeRawUnsafe(
          "UPDATE msg_notification_queue SET status = 'PROCESSING', " +
            ' processing_started_at = now(), ' +
            ' attempts = attempts + 1, updated_at = now() ' +
            'WHERE id = $1::uuid',
          pending[i]!.id,
        );
      }
      return pending;
    });

    if (rows.length === 0) return;

    // Phase 2 — deliver outside the claim tx. On success, flip PROCESSING
    // -> SENT (and clear processing_started_at). On failure, flip back to
    // PENDING with backoff (or FAILED at MAX_ATTEMPTS exhaust). The status
    // never lies: SENT is delivered, PROCESSING is in-flight, PENDING is
    // retryable, FAILED is terminal.
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k]!;
      try {
        await this.deliver(tenant, row);
        await this.markSent(row.id);
      } catch (e: any) {
        this.logger.warn(
          'Delivery failed for queue ' + row.id + ': ' + (e?.stack || e?.message || e),
        );
        await this.markFailure(row.id, row.attempts + 1, e?.message || String(e));
      }
    }
  }

  /**
   * Reset stale PROCESSING rows back to PENDING. Runs at the top of every
   * tick. The recovered row keeps its `attempts` count (so MAX_ATTEMPTS
   * still bounds total retries — including ones lost to crashes) and gets
   * a fresh scheduled_for so it lines up at the front of the next claim.
   */
  private async recoverStaleProcessing(): Promise<void> {
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE msg_notification_queue SET ' +
            " status = 'PENDING', " +
            ' processing_started_at = NULL, ' +
            ' scheduled_for = now(), ' +
            ' updated_at = now() ' +
            "WHERE status = 'PROCESSING' " +
            ' AND processing_started_at < now() - ($1::int * interval ' +
            "'1 second')",
          STALE_PROCESSING_SECONDS,
        );
      });
    } catch (e: any) {
      this.logger.warn('Stale-row recovery sweep failed (non-fatal): ' + (e?.message || e));
    }
  }

  /** Flip PROCESSING -> SENT after a successful deliver(). */
  private async markSent(queueId: string): Promise<void> {
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          "UPDATE msg_notification_queue SET status = 'SENT', sent_at = now(), " +
            ' processing_started_at = NULL, updated_at = now() ' +
            'WHERE id = $1::uuid',
          queueId,
        );
      });
    } catch (e: any) {
      // Loud — a failed status flip after successful delivery means the row
      // will be retried on the next tick by the stale-recovery path.
      // Idempotency on Redis ZADD makes the redelivery safe (same queue_id
      // overwrites the existing sorted-set entry).
      this.logger.error(
        'Failed to mark queue ' + queueId + ' SENT after delivery: ' + (e?.message || e),
      );
    }
  }

  private async deliver(tenant: TenantInfo, row: PendingRow): Promise<void> {
    // Pull preferences for this (recipient, type) to learn which channels
    // to fan out to. Default to IN_APP if no row exists.
    var prefRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<Array<{ channels: string[] }>>(
        'SELECT channels FROM msg_notification_preferences ' +
          'WHERE platform_user_id = $1::uuid AND notification_type = $2',
        row.recipient_id,
        row.notification_type,
      );
    });
    var channels = prefRows[0] ? prefRows[0].channels : ['IN_APP'];

    var payloadObj =
      typeof row.payload === 'object' && row.payload !== null ? (row.payload as object) : {};

    for (var i = 0; i < channels.length; i++) {
      var channel = channels[i]!;
      if (channel === 'IN_APP') {
        await this.redis.pushInAppNotification(row.recipient_id, {
          queue_id: row.id,
          notification_type: row.notification_type,
          delivered_at: new Date().toISOString(),
          payload: payloadObj,
        });
        await this.writeLog(tenant, row, channel, 'DELIVERED', null);
      } else {
        // EMAIL / PUSH / SMS — stubbed. Phase 3 ships actual provider calls.
        this.logger.log(
          '[stub-deliver] ' +
            channel +
            ' to ' +
            row.recipient_id +
            ' type=' +
            row.notification_type +
            ' queue=' +
            row.id,
        );
        await this.writeLog(tenant, row, channel, 'SENT', null);
      }
    }
  }

  private async writeLog(
    tenant: TenantInfo,
    row: PendingRow,
    channel: string,
    status: string,
    errorMessage: string | null,
  ): Promise<void> {
    await this.tenantPrisma.executeInTenantContext(async (client) => {
      await client.$executeRawUnsafe(
        'INSERT INTO msg_notification_log ' +
          '(id, school_id, queue_id, recipient_id, notification_type, channel, status, ' +
          ' error_message, sent_at, delivered_at, correlation_id) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8, now(), ' +
          " CASE WHEN $7 = 'DELIVERED' THEN now() ELSE NULL END, $9::uuid)",
        generateId(),
        tenant.schoolId,
        row.id,
        row.recipient_id,
        row.notification_type,
        channel,
        status,
        errorMessage,
        row.correlation_id,
      );
    });
  }

  private async markFailure(queueId: string, attempts: number, reason: string): Promise<void> {
    var nextStatus = attempts >= MAX_ATTEMPTS ? 'FAILED' : 'PENDING';
    var nextSchedule = new Date(Date.now() + FAILURE_BACKOFF_SECONDS * 1000).toISOString();
    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'UPDATE msg_notification_queue SET ' +
            ' status = $1, ' +
            ' failure_reason = $2, ' +
            ' processing_started_at = NULL, ' +
            " scheduled_for = CASE WHEN $1 = 'PENDING' THEN $3::timestamptz ELSE scheduled_for END, " +
            ' updated_at = now() ' +
            'WHERE id = $4::uuid',
          nextStatus,
          reason.slice(0, 500),
          nextSchedule,
          queueId,
        );
      });
    } catch (e: any) {
      this.logger.error('Could not record failure for queue ' + queueId + ': ' + (e?.message || e));
    }
  }
}
