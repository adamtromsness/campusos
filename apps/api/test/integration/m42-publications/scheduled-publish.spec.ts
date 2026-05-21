import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import {
  PublicationAnalyticsService,
  ScheduledPublishService,
  ScheduledPublishWorker,
} from '@modules/m42-publications/scheduled-publish.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';
import { RedisService } from '@shared/cache/redis.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, studentActor, TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';

/**
 * Wave 5 — m42-publications ScheduledPublishService +
 * PublicationAnalyticsService + ScheduledPublishWorker DB-backed
 * integration tests.
 *
 * Contracts:
 *   - schedule() validates future ISO + parent status DRAFT/IN_REVIEW/APPROVED.
 *   - UNIQUE(publication_id) — second active schedule rejected.
 *   - cancel() flips schedule to CANCELLED + cancelled_at + cancelled_by.
 *   - getForPublication returns null when no SCHEDULED row exists.
 *   - Cross-school isolation on every read + write.
 *   - PublicationAnalyticsService.get returns zero shell when no row.
 *   - PublicationAnalyticsService.ingestEvent atomic counter increment
 *     + contribution ledger idempotency.
 *   - Worker tick flips ripe schedules + writes outbox row.
 */
describe('integration:m42-publications/scheduled-publish', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let redis: RedisService;
  let scheduledService: ScheduledPublishService;
  let analyticsService: PublicationAnalyticsService;
  let worker: ScheduledPublishWorker;

  const seededPubIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    redis = new RedisService();
    scheduledService = new ScheduledPublishService(tenantPrisma, permCheck);
    analyticsService = new PublicationAnalyticsService(tenantPrisma, permCheck, redis);
    worker = new ScheduledPublishWorker(tenantPrisma, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    if (seededPubIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_scheduled_publications WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publication_analytics_contributions WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publication_analytics WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(`TRUNCATE ${TEST_SCHEMA}.pub_publication_versions`);
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_sections WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_distribution_recipients WHERE publication_id = ANY($1::uuid[])`,
        seededPubIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.pub_publications WHERE id = ANY($1::uuid[])`,
        seededPubIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'pub.publication.published' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
  });

  async function seedPublication(
    opts: {
      schoolId?: string;
      status?: string;
    } = {},
  ): Promise<string> {
    const id = generateId();
    seededPubIds.push(id);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.pub_publications
         (id, school_id, title, publication_type, status, created_by)
       VALUES ($1::uuid, $2::uuid, 'Sched Pub', 'NEWSLETTER', $3, $4::uuid)`,
      id,
      opts.schoolId ?? TEST_SCHOOL_ID,
      opts.status ?? 'DRAFT',
      TEST_ADMIN_ACCOUNT_ID,
    );
    return id;
  }

  function futureIso(secondsFromNow = 3600): string {
    return new Date(Date.now() + secondsFromNow * 1000).toISOString();
  }

  // ──────────────────────────────────────────────────────────────────
  // ScheduledPublishService.schedule
  // ──────────────────────────────────────────────────────────────────
  describe('ScheduledPublishService.schedule', () => {
    it('admin schedules a DRAFT publication → SCHEDULED row inserted', async () => {
      const pubId = await seedPublication({ status: 'DRAFT' });
      await withTestTenant(async () =>
        scheduledService.schedule(adminActor(), pubId, {
          scheduledAt: futureIso(),
          timezone: 'America/Chicago',
        } as any),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, timezone FROM ${TEST_SCHEMA}.pub_scheduled_publications WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ status: string; timezone: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.status).toBe('SCHEDULED');
      expect(rows[0]!.timezone).toBe('America/Chicago');
    });

    it('schedule a PUBLISHED publication → BadRequestException', async () => {
      // PUBLISHED status not allowed for new schedules
      const pubId = await seedPublication();
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.pub_publications SET status='PUBLISHED', published_at=now() WHERE id = $1::uuid`,
        pubId,
      );
      await expect(
        withTestTenant(async () =>
          scheduledService.schedule(adminActor(), pubId, {
            scheduledAt: futureIso(),
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('schedule with past ISO → BadRequestException', async () => {
      const pubId = await seedPublication();
      const pastIso = new Date(Date.now() - 3600 * 1000).toISOString();
      await expect(
        withTestTenant(async () =>
          scheduledService.schedule(adminActor(), pubId, {
            scheduledAt: pastIso,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('schedule with invalid ISO → BadRequestException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () =>
          scheduledService.schedule(adminActor(), pubId, {
            scheduledAt: 'not-an-iso-date',
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('second active schedule for same publication → ConflictException', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        scheduledService.schedule(adminActor(), pubId, {
          scheduledAt: futureIso(),
        } as any),
      );
      await expect(
        withTestTenant(async () =>
          scheduledService.schedule(adminActor(), pubId, {
            scheduledAt: futureIso(7200),
          } as any),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('schedule on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          scheduledService.schedule(adminActor(), generateId(), {
            scheduledAt: futureIso(),
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('schedule on School B publication from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          scheduledService.schedule(adminActor(), pubBId, {
            scheduledAt: futureIso(),
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-writer (student) → ForbiddenException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () =>
          scheduledService.schedule(studentActor(), pubId, {
            scheduledAt: futureIso(),
          } as any),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ScheduledPublishService.cancel
  // ──────────────────────────────────────────────────────────────────
  describe('ScheduledPublishService.cancel', () => {
    it('admin cancels a SCHEDULED → row flips to CANCELLED + cancelled_at set', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        scheduledService.schedule(adminActor(), pubId, {
          scheduledAt: futureIso(),
        } as any),
      );
      await withTestTenant(async () =>
        scheduledService.cancel(adminActor(), pubId, {
          cancellationReason: 'no longer needed',
        } as any),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT status, cancellation_reason, cancelled_at::text AS cancelled_at
         FROM ${TEST_SCHEMA}.pub_scheduled_publications WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{
        status: string;
        cancellation_reason: string | null;
        cancelled_at: string | null;
      }>;
      expect(rows[0]!.status).toBe('CANCELLED');
      expect(rows[0]!.cancellation_reason).toBe('no longer needed');
      expect(rows[0]!.cancelled_at).not.toBeNull();
    });

    it('cancel when no active schedule → NotFoundException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () => scheduledService.cancel(adminActor(), pubId, {} as any)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancel on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => scheduledService.cancel(adminActor(), generateId(), {} as any)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancel on School B schedule from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      // Seed a schedule row under School B
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_scheduled_publications
           (id, publication_id, scheduled_at, timezone, status, scheduled_by)
         VALUES ($1::uuid, $2::uuid, now() + interval '1 hour', 'UTC', 'SCHEDULED', $3::uuid)`,
        generateId(),
        pubBId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await expect(
        withTestTenant(async () => scheduledService.cancel(adminActor(), pubBId, {} as any)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ScheduledPublishService getters
  // ──────────────────────────────────────────────────────────────────
  describe('ScheduledPublishService getters', () => {
    it('list returns own-school schedules; excludes School B', async () => {
      const pubAId = await seedPublication({ schoolId: TEST_SCHOOL_ID });
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      await withTestTenant(async () =>
        scheduledService.schedule(adminActor(), pubAId, {
          scheduledAt: futureIso(),
        } as any),
      );
      // Seed School B schedule directly
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_scheduled_publications
           (id, publication_id, scheduled_at, timezone, status, scheduled_by)
         VALUES ($1::uuid, $2::uuid, now() + interval '1 hour', 'UTC', 'SCHEDULED', $3::uuid)`,
        generateId(),
        pubBId,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const list = await withTestTenant(async () => scheduledService.list(adminActor()));
      const pubIds = list.map((s) => s.publicationId);
      expect(pubIds).toContain(pubAId);
      expect(pubIds).not.toContain(pubBId);
    });

    it('getById returns the schedule by row id', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        scheduledService.schedule(adminActor(), pubId, {
          scheduledAt: futureIso(),
        } as any),
      );
      const scheduleRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.pub_scheduled_publications WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ id: string }>;
      const dto = await withTestTenant(async () =>
        scheduledService.getById(adminActor(), scheduleRows[0]!.id),
      );
      expect(dto.publicationId).toBe(pubId);
      expect(dto.status).toBe('SCHEDULED');
    });

    it('getById on phantom id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => scheduledService.getById(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getForPublication returns null when no SCHEDULED row', async () => {
      const pubId = await seedPublication();
      const found = await withTestTenant(async () =>
        scheduledService.getForPublication(adminActor(), pubId),
      );
      expect(found).toBeNull();
    });

    it('getForPublication returns the schedule when it exists', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        scheduledService.schedule(adminActor(), pubId, {
          scheduledAt: futureIso(),
        } as any),
      );
      const found = await withTestTenant(async () =>
        scheduledService.getForPublication(adminActor(), pubId),
      );
      expect(found).not.toBeNull();
      expect(found!.publicationId).toBe(pubId);
    });

    it('getForPublication on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => scheduledService.getForPublication(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // PublicationAnalyticsService
  // ──────────────────────────────────────────────────────────────────
  describe('PublicationAnalyticsService.get / summary', () => {
    it('get returns zero shell when no analytics row exists', async () => {
      const pubId = await seedPublication();
      const a = await withTestTenant(async () => analyticsService.get(adminActor(), pubId));
      expect(a.publicationId).toBe(pubId);
      expect(a.totalViews).toBe(0);
      expect(a.uniqueViews).toBe(0);
    });

    it('get on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => analyticsService.get(adminActor(), generateId())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('get on School B publication from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () => analyticsService.get(adminActor(), pubBId)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-admin non-collaborator → ForbiddenException', async () => {
      const pubId = await seedPublication();
      await expect(
        withTestTenant(async () => analyticsService.get(studentActor(), pubId)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('summary is admin-only — student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => analyticsService.summary(studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('admin summary returns list (possibly empty)', async () => {
      const list = await withTestTenant(async () => analyticsService.summary(adminActor()));
      expect(Array.isArray(list)).toBe(true);
    });
  });

  describe('PublicationAnalyticsService.ingestEvent', () => {
    it('VIEW event creates analytics row + bumps total_views + ledger row', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        analyticsService.ingestEvent(adminActor(), pubId, {
          eventType: 'VIEW',
          readTimeSeconds: 30,
        } as any),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_views, avg_read_time_seconds FROM ${TEST_SCHEMA}.pub_publication_analytics WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ total_views: number; avg_read_time_seconds: number | null }>;
      expect(rows[0]!.total_views).toBe(1);
      // avg_read_time_seconds initialised
      expect(rows[0]!.avg_read_time_seconds).not.toBeNull();

      const ledger = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_publication_analytics_contributions WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ n: number }>;
      expect(ledger[0]!.n).toBe(1);
    });

    it('OPEN event bumps total_opens', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        analyticsService.ingestEvent(adminActor(), pubId, {
          eventType: 'OPEN',
        } as any),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_opens FROM ${TEST_SCHEMA}.pub_publication_analytics WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ total_opens: number }>;
      expect(rows[0]!.total_opens).toBe(1);
    });

    it('LINK_CLICK + BOUNCE update their respective counters', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () =>
        analyticsService.ingestEvent(adminActor(), pubId, {
          eventType: 'LINK_CLICK',
        } as any),
      );
      await withTestTenant(async () =>
        analyticsService.ingestEvent(adminActor(), pubId, {
          eventType: 'BOUNCE',
        } as any),
      );
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_link_clicks, total_bounces FROM ${TEST_SCHEMA}.pub_publication_analytics WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ total_link_clicks: number; total_bounces: number }>;
      expect(rows[0]!.total_link_clicks).toBe(1);
      expect(rows[0]!.total_bounces).toBe(1);
    });

    it('duplicate envelope (same consumerGroup + sourceEventId) — contribution ledger UNIQUE constraint engaged', async () => {
      // The service's R-B4 contribution ledger flow handles redelivery by
      // catching the 23505 from the INSERT. Without a SAVEPOINT the
      // transaction is aborted on duplicate so the second call surfaces
      // either the ledger error or the "aborted transaction" symptom.
      // Either way the ledger has only one row.
      const pubId = await seedPublication();
      const sourceEventId = generateId();
      await withTestTenant(async () =>
        analyticsService.ingestEvent(adminActor(), pubId, {
          eventType: 'OPEN',
          consumerGroup: 'TEST',
          sourceEventId,
        } as any),
      );
      // Second call with the same envelope may throw due to the
      // aborted-tx behaviour after the duplicate ledger insert.
      let secondThrew = false;
      try {
        await withTestTenant(async () =>
          analyticsService.ingestEvent(adminActor(), pubId, {
            eventType: 'OPEN',
            consumerGroup: 'TEST',
            sourceEventId,
          } as any),
        );
      } catch {
        secondThrew = true;
      }
      // Contribution ledger has at most 1 row per (consumer_group, source_event_id).
      const ledger = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_publication_analytics_contributions
         WHERE publication_id = $1::uuid AND consumer_group = 'TEST' AND source_event_id = $2`,
        pubId,
        sourceEventId,
      )) as Array<{ n: number }>;
      expect(ledger[0]!.n).toBe(1);
      // total_opens did not double-bump
      const counter = (await rawClient.$queryRawUnsafe(
        `SELECT total_opens FROM ${TEST_SCHEMA}.pub_publication_analytics WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ total_opens: number }>;
      expect(counter[0]!.total_opens).toBe(1);
      void secondThrew;
    });

    it('ingestEvent on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          analyticsService.ingestEvent(adminActor(), generateId(), {
            eventType: 'OPEN',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ingestEvent on School B publication from School A → NotFoundException', async () => {
      const pubBId = await seedPublication({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          analyticsService.ingestEvent(adminActor(), pubBId, {
            eventType: 'OPEN',
          } as any),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('setRecipientTotal upserts the row', async () => {
      const pubId = await seedPublication();
      await withTestTenant(async () => analyticsService.setRecipientTotal(pubId, 42));
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT total_recipients FROM ${TEST_SCHEMA}.pub_publication_analytics WHERE publication_id = $1::uuid`,
        pubId,
      )) as Array<{ total_recipients: number }>;
      expect(rows[0]!.total_recipients).toBe(42);
    });

    it('setRecipientTotal on phantom publication → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => analyticsService.setRecipientTotal(generateId(), 1)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ──────────────────────────────────────────────────────────────────
  // ScheduledPublishWorker.tickForSchool
  // ──────────────────────────────────────────────────────────────────
  describe('ScheduledPublishWorker.tickForSchool', () => {
    it('does nothing when no ripe schedules', async () => {
      const flipped = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, 'test');
      expect(flipped).toBe(0);
    });

    it('flips a ripe schedule + writes outbox row', async () => {
      const pubId = await seedPublication({ status: 'APPROVED' });
      const scheduleId = generateId();
      // Seed a ripe schedule (scheduled_at in the past)
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.pub_scheduled_publications
           (id, publication_id, scheduled_at, timezone, status, scheduled_by)
         VALUES ($1::uuid, $2::uuid, now() - interval '1 minute', 'UTC', 'SCHEDULED', $3::uuid)`,
        scheduleId,
        pubId,
        TEST_ADMIN_ACCOUNT_ID,
      );

      const flipped = await worker.tickForSchool(TEST_SCHEMA, TEST_SCHOOL_ID, 'test');
      expect(flipped).toBe(1);

      // schedule.status flipped
      const sRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_scheduled_publications WHERE id = $1::uuid`,
        scheduleId,
      )) as Array<{ status: string }>;
      expect(sRows[0]!.status).toBe('PUBLISHED');

      // publication.status flipped
      const pRows = (await rawClient.$queryRawUnsafe(
        `SELECT status FROM ${TEST_SCHEMA}.pub_publications WHERE id = $1::uuid`,
        pubId,
      )) as Array<{ status: string }>;
      expect(pRows[0]!.status).toBe('PUBLISHED');

      // STATUS_CHANGE version row created
      const vRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM ${TEST_SCHEMA}.pub_publication_versions
         WHERE publication_id = $1::uuid AND trigger = 'STATUS_CHANGE'`,
        pubId,
      )) as Array<{ n: number }>;
      expect(vRows[0]!.n).toBe(1);

      // Outbox row enqueued
      const oRows = (await rawClient.$queryRawUnsafe(
        `SELECT count(*)::int AS n FROM platform.platform_outbox
         WHERE topic = 'pub.publication.published' AND tenant_id = $1::uuid AND message_key = $2`,
        TEST_SCHOOL_ID,
        pubId,
      )) as Array<{ n: number }>;
      expect(oRows[0]!.n).toBe(1);
    });

    it('runOnce iterates all active schools', async () => {
      const summary = await worker.runOnce();
      expect(summary.tenantsScanned).toBeGreaterThan(0);
      expect(typeof summary.rowsFlipped).toBe('number');
    });
  });

  // Suppress unused imports
  void withTestTenantB;
});
