import { Injectable, Logger } from '@nestjs/common';
import { TenantPrismaService } from '../tenant/tenant-prisma.service';
import { generateId } from '@campusos/database';

/**
 * IdempotencyService — gates Kafka consumer handlers so each event is
 * processed at most once per (consumer_group, event_id) pair.
 *
 * Backed by platform.platform_event_consumer_idempotency. The unique
 * (consumer_group, event_id) index makes claim() race-safe: concurrent
 * consumer instances racing on the same redelivered message will see
 * exactly one INSERT succeed; the other gets a 23505 unique violation
 * which we translate to "already claimed" → handler skipped.
 *
 * The platform schema is shared across tenants. Event ids are UUIDv7
 * (collision-safe across tenants) so a single global index is sufficient.
 *
 * Tied to platform — does NOT use the tenant search_path. Uses the raw
 * platform Prisma client directly.
 */
@Injectable()
export class IdempotencyService {
  private readonly logger = new Logger(IdempotencyService.name);

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /**
   * Try to claim an event for a consumer group. Returns true if this is the
   * first time we've seen the (group, eventId) pair (i.e. handler should
   * proceed); false if it was already processed.
   *
   * Errors other than the unique-violation propagate — those represent real
   * DB problems (e.g. table missing) the worker shouldn't silently swallow.
   */
  async claim(consumerGroup: string, eventId: string, topic: string): Promise<boolean> {
    var client = this.tenantPrisma.getPlatformClient();
    try {
      await client.$executeRawUnsafe(
        'INSERT INTO platform.platform_event_consumer_idempotency ' +
          '(id, consumer_group, event_id, topic) VALUES ($1::uuid, $2, $3, $4)',
        generateId(),
        consumerGroup,
        eventId,
        topic,
      );
      return true;
    } catch (e: any) {
      var code = e?.meta?.code || e?.code;
      // Prisma raw errors surface PG SQLSTATE on `e.code`; 23505 = unique_violation.
      if (
        code === '23505' ||
        (typeof e?.message === 'string' &&
          e.message.includes('platform_event_consumer_idempotency_consumer_group_event_id_key'))
      ) {
        this.logger.debug(
          'Idempotency hit — skip (group=' + consumerGroup + ', eventId=' + eventId + ')',
        );
        return false;
      }
      throw e;
    }
  }
}
