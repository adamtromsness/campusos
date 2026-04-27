import { Injectable, Logger } from '@nestjs/common';
import { generateId } from '@campusos/database';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { getCurrentTenant } from '../tenant/tenant.context';
import { RedisService } from './redis.service';

/**
 * Caller-supplied input for `enqueue()`.
 *
 * The notification pipeline is fan-out per recipient — every consumer
 * resolves the recipient list itself and calls `enqueue()` once per
 * recipient. The service handles the per-recipient preference / quiet-hours
 * / idempotency check and the queue insert.
 *
 * `idempotencyKey` should encode the (event, recipient) pair so a Kafka
 * redelivery never enqueues twice. The convention used by the consumers in
 * this module is `<topic>:<eventId>:<recipientId>`.
 *
 * `payload` is persisted as JSONB on `msg_notification_queue.payload` and
 * is the body the Step 8 NotificationBell renders. Keep it small and
 * UI-shaped (display strings, not internal ids).
 */
export interface EnqueueNotificationOptions {
  notificationType: string;
  recipientAccountId: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  correlationId?: string;
  /** Optional override; defaults to "now". Used for scheduled notifications. */
  scheduledFor?: Date;
}

export type EnqueueOutcome = 'enqueued' | 'deduped' | 'disabled';

export interface EnqueueResult {
  outcome: EnqueueOutcome;
  queueId: string | null;
  channels: string[];
  scheduledFor: Date;
}

/**
 * Tenant-scoped: must be called inside `runWithTenantContextAsync` so the
 * service hits `msg_notification_queue` / `msg_notification_preferences`
 * inside the right schema. Every consumer in this module wraps its enqueue
 * loop in a tenant context — see `notification-consumer-base.ts`.
 */
@Injectable()
export class NotificationQueueService {
  private readonly logger = new Logger(NotificationQueueService.name);

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * Enqueue one notification. Pipeline:
   *
   *   1. Redis SET NX on `notif:idem:{subdomain}:{idempotencyKey}` (7d TTL).
   *      The DB lacks a UNIQUE on idempotency_key by design (Step 2 — avoids
   *      deadlocks on emergency fan-out); Redis is the authoritative dedup.
   *   2. Read `msg_notification_preferences` for (recipient, type). If
   *      `is_enabled = false` or no row exists with channels, return early.
   *      A missing row defaults to `IN_APP` enabled — a sensible default
   *      until the user-prefs UI lands in Step 8.
   *   3. Quiet-hours check: if the current TIME falls inside
   *      [quiet_hours_start, quiet_hours_end], shift `scheduled_for` to the
   *      next quiet-end boundary so the row holds in PENDING until the
   *      delivery worker's poll covers that timestamp. Wraps midnight.
   *   4. INSERT into `msg_notification_queue` with status=PENDING. Returns
   *      the queue id.
   *
   * Returns `{ outcome: 'deduped' }` when the Redis key collides (a previous
   * call enqueued the same event for the same recipient). Returns
   * `{ outcome: 'disabled' }` when the recipient has disabled this type
   * outright. Returns `{ outcome: 'enqueued' }` with the queue id otherwise.
   */
  async enqueue(opts: EnqueueNotificationOptions): Promise<EnqueueResult> {
    var tenant = getCurrentTenant();
    var idemKey = 'notif:idem:' + tenant.subdomain + ':' + opts.idempotencyKey;

    var claimed = await this.redis.claimIdempotency(idemKey);
    if (!claimed) {
      this.logger.debug(
        'Skip duplicate (' + opts.notificationType + ') for ' + opts.recipientAccountId,
      );
      return { outcome: 'deduped', queueId: null, channels: [], scheduledFor: new Date() };
    }

    var prefRows = await this.tenantPrisma.executeInTenantContext(async (client) => {
      return client.$queryRawUnsafe<
        Array<{
          channels: string[];
          is_enabled: boolean;
          quiet_hours_start: string | null;
          quiet_hours_end: string | null;
        }>
      >(
        'SELECT channels, is_enabled, ' +
          'quiet_hours_start::text AS quiet_hours_start, ' +
          'quiet_hours_end::text AS quiet_hours_end ' +
          'FROM msg_notification_preferences ' +
          'WHERE platform_user_id = $1::uuid AND notification_type = $2',
        opts.recipientAccountId,
        opts.notificationType,
      );
    });

    var pref = prefRows[0];
    var channels: string[] = pref ? pref.channels : ['IN_APP'];
    var isEnabled = pref ? pref.is_enabled : true;
    if (!isEnabled || channels.length === 0) {
      // Release the idempotency key so a future re-enable-and-redeliver cycle
      // can re-enqueue without manual intervention. The chance of a redeliver
      // racing with a preference flip is negligible in practice.
      await this.redis.releaseIdempotency(idemKey);
      return { outcome: 'disabled', queueId: null, channels: [], scheduledFor: new Date() };
    }

    var scheduledFor = opts.scheduledFor ?? new Date();
    if (pref && pref.quiet_hours_start && pref.quiet_hours_end) {
      var deferred = computeQuietHoursDeferral(
        scheduledFor,
        pref.quiet_hours_start,
        pref.quiet_hours_end,
      );
      if (deferred) scheduledFor = deferred;
    }

    var queueId = generateId();
    var schoolId = tenant.schoolId;

    try {
      await this.tenantPrisma.executeInTenantContext(async (client) => {
        await client.$executeRawUnsafe(
          'INSERT INTO msg_notification_queue ' +
            '(id, school_id, recipient_id, notification_type, payload, status, ' +
            ' idempotency_key, scheduled_for, attempts, correlation_id) ' +
            "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'PENDING', " +
            ' $6, $7::timestamptz, 0, $8::uuid)',
          queueId,
          schoolId,
          opts.recipientAccountId,
          opts.notificationType,
          JSON.stringify(opts.payload),
          opts.idempotencyKey,
          scheduledFor.toISOString(),
          opts.correlationId ?? null,
        );
      });
    } catch (e: any) {
      // Insert failed — release the Redis key so a redelivery can retry.
      await this.redis.releaseIdempotency(idemKey);
      throw e;
    }

    return {
      outcome: 'enqueued',
      queueId: queueId,
      channels: channels,
      scheduledFor: scheduledFor,
    };
  }
}

/**
 * Returns the timestamp the notification should be deferred to if `now`
 * lies inside the (start, end) quiet-hours window. Returns null when not
 * in quiet hours. Wraps midnight: a 22:00–07:00 window is in effect when
 * the local hour is 22 or 23 or strictly less than 7.
 *
 * Implementation note: server runs in UTC; we treat `quiet_hours_start`
 * and `quiet_hours_end` as UTC HH:MM:SS for now. A user-timezone-aware
 * version of this check is on the Step 8 (notification bell) follow-up
 * list — the schema carries plain `TIME` so the layer that interprets
 * the window has to pin a timezone somewhere.
 */
function computeQuietHoursDeferral(now: Date, startStr: string, endStr: string): Date | null {
  var start = parseTime(startStr);
  var end = parseTime(endStr);
  if (start === null || end === null) return null;
  var curMin = now.getUTCHours() * 60 + now.getUTCMinutes();
  var inWindow: boolean;
  if (start === end) {
    return null;
  }
  if (start < end) {
    inWindow = curMin >= start && curMin < end;
  } else {
    // Wraps midnight, e.g. 22:00 → 07:00.
    inWindow = curMin >= start || curMin < end;
  }
  if (!inWindow) return null;

  var deferred = new Date(now);
  deferred.setUTCSeconds(0, 0);
  deferred.setUTCHours(Math.floor(end / 60), end % 60, 0, 0);
  if (deferred.getTime() <= now.getTime()) {
    deferred.setUTCDate(deferred.getUTCDate() + 1);
  }
  return deferred;
}

function parseTime(value: string): number | null {
  // Accept "HH:MM" or "HH:MM:SS". Anything else → null (defensive against
  // unexpected pg formatting).
  var m = /^(\d{2}):(\d{2})(?::\d{2})?$/.exec(value);
  if (!m) return null;
  var h = Number(m[1]);
  var mm = Number(m[2]);
  if (!Number.isFinite(h) || !Number.isFinite(mm)) return null;
  return h * 60 + mm;
}
