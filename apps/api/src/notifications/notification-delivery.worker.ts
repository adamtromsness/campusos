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
    // Pull a small batch under a transaction with FOR UPDATE SKIP LOCKED.
    // The transaction stays open while we process to keep the lock — that's
    // not ideal for a high-volume worker but is fine for Cycle 3 demo
    // volumes (a few rows per minute peak). When we tune for Phase 2 we
    // can switch to "SELECT ids ; UPDATE TO PROCESSING ; release lock ;
    // process ; UPDATE TO SENT" so processing happens outside the lock.
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

      // Mark every row in-flight so a concurrent worker would see SENT and
      // skip it on the next tick. We immediately deliver and overwrite the
      // status afterwards. Using SENT as the in-flight flag is acceptable
      // because the DELIVERED state on `msg_notification_log` is what the
      // UI actually renders against.
      for (var i = 0; i < pending.length; i++) {
        await tx.$executeRawUnsafe(
          "UPDATE msg_notification_queue SET status = 'SENT', sent_at = now(), " +
            ' attempts = attempts + 1, updated_at = now() WHERE id = $1::uuid',
          pending[i]!.id,
        );
      }
      return pending;
    });

    if (rows.length === 0) return;

    // Deliver each. The deliver step writes the log row + Redis update; if
    // it throws we flip the queue row back to PENDING with a small
    // backoff so the next tick retries. After MAX_ATTEMPTS we leave it as
    // FAILED for human review.
    for (var k = 0; k < rows.length; k++) {
      var row = rows[k]!;
      try {
        await this.deliver(tenant, row);
      } catch (e: any) {
        this.logger.warn(
          'Delivery failed for queue ' + row.id + ': ' + (e?.stack || e?.message || e),
        );
        await this.markFailure(row.id, row.attempts + 1, e?.message || String(e));
      }
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
