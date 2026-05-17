import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { getPlatformClient } from '@campusos/database';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { deterministicConferenceBookingOpenEventId } from './event-ids';

/**
 * P2-24a — ConferenceStatusWorker.
 *
 * Periodic sweep across every active school. Per tenant:
 *   UPDATE eng_conference_events
 *   SET status='BOOKING_OPEN', updated_at=now()
 *   WHERE status='DRAFT' AND booking_opens_at <= now()
 *   RETURNING id, title, booking_opens_at, booking_closes_at
 *
 * For each flipped row, enqueues `eng.conference.booking_open` to the
 * platform outbox INSIDE the same transaction so durable delivery is
 * guaranteed. The deterministic v5-shape event_id keys on
 * conferenceEventId so a redelivered envelope from the
 * OutboxPublisherWorker hits the consumer-group idempotency claim
 * cleanly.
 *
 * Reuses the partial INDEX(booking_opens_at, status) WHERE status='DRAFT'
 * from migration 162 as the hot path. Best-effort per tenant — an
 * exception in one tenant does not abort the rest.
 *
 * Run cadence: every minute by default. Configurable via
 * ENG_CONFERENCE_SWEEP_INTERVAL_MS env var.
 */
@Injectable()
export class ConferenceStatusWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ConferenceStatusWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private readonly intervalMs: number;

  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly outbox: OutboxService,
  ) {
    this.intervalMs = Number(process.env.ENG_CONFERENCE_SWEEP_INTERVAL_MS) || 60 * 1000;
  }

  onModuleInit(): void {
    if (process.env.NODE_ENV === 'test') {
      // Do not auto-schedule under vitest
      return;
    }
    this.timer = setInterval(() => {
      void this.runOnce().catch((err) => {
        this.logger.error('ConferenceStatusWorker.runOnce failed', err);
      });
    }, this.intervalMs);
    this.logger.log(
      'ConferenceStatusWorker scheduled — sweep every ' +
        Math.round(this.intervalMs / 1000) +
        ' seconds',
    );
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async runOnce(): Promise<{ tenantsScanned: number; rowsFlipped: number }> {
    const platform = getPlatformClient();
    const schools = await platform.school.findMany({
      where: { isActive: true },
    });

    let totalFlipped = 0;
    let scanned = 0;
    for (const school of schools) {
      if (!school.schemaName) continue;
      scanned += 1;
      try {
        const flipped = await this.tickForSchool(school.schemaName, school.id, school.subdomain);
        totalFlipped += flipped;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn('ConferenceStatusWorker failed for ' + school.schemaName + ': ' + msg);
      }
    }
    return { tenantsScanned: scanned, rowsFlipped: totalFlipped };
  }

  async tickForSchool(schemaName: string, schoolId: string, subdomain: string): Promise<number> {
    return this.tenantPrisma.executeInExplicitSchema(schemaName, async (client) => {
      const flipped = (await client.$queryRawUnsafe(
        `UPDATE eng_conference_events
         SET status = 'BOOKING_OPEN', updated_at = now()
         WHERE school_id = $1::uuid
           AND status = 'DRAFT'
           AND booking_opens_at <= now()
         RETURNING id::text AS id, title,
                   booking_opens_at::text AS booking_opens_at,
                   booking_closes_at::text AS booking_closes_at,
                   start_date::text AS start_date,
                   end_date::text AS end_date`,
        schoolId,
      )) as Array<{
        id: string;
        title: string;
        booking_opens_at: string;
        booking_closes_at: string;
        start_date: string;
        end_date: string;
      }>;

      for (const row of flipped) {
        await this.outbox.enqueueInTx(client, {
          topic: 'eng.conference.booking_open',
          payload: {
            conferenceEventId: row.id,
            schoolId,
            title: row.title,
            startDate: row.start_date,
            endDate: row.end_date,
            bookingOpensAt: row.booking_opens_at,
            bookingClosesAt: row.booking_closes_at,
            sourceRefId: row.id,
          },
          sourceModule: 'engagement',
          eventId: deterministicConferenceBookingOpenEventId(row.id),
          tenantId: schoolId,
          tenantSubdomain: subdomain,
          key: row.id,
        });
      }

      if (flipped.length > 0) {
        this.logger.log(
          'ConferenceStatusWorker flipped ' +
            flipped.length +
            ' conference event(s) to BOOKING_OPEN in ' +
            schemaName,
        );
      }
      return flipped.length;
    });
  }
}
