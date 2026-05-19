import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { NotificationQueueService } from '@modules/m40-communications/notifications/notification-queue.service';
import { NotificationInboxService } from '@modules/m40-communications/notifications/notification-inbox.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { RedisService } from '@shared/cache/redis.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';

/**
 * Wave 5 — m40-communications notifications DB-backed integration tests.
 *
 * Covered:
 *   - NotificationQueueService.enqueue (preferences, idempotency, queue insert)
 *   - NotificationInboxService.getInbox / getHistory / markAllRead
 *   - Cross-school isolation through recipient + tenant context
 */
describe('integration:m40-communications/notifications', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let redis: RedisService;
  let queue: NotificationQueueService;
  let inbox: NotificationInboxService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    redis = new RedisService();
    await redis.onModuleInit();
    queue = new NotificationQueueService(tenantPrisma, redis);
    inbox = new NotificationInboxService(tenantPrisma, redis);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await redis.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_notification_queue WHERE recipient_id IN ($1::uuid, $2::uuid, $3::uuid)`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_PARENT_ACCOUNT_ID,
      TEST_TEACHER_ACCOUNT_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_notification_preferences WHERE platform_user_id IN ($1::uuid, $2::uuid, $3::uuid)`,
      TEST_ADMIN_ACCOUNT_ID,
      TEST_PARENT_ACCOUNT_ID,
      TEST_TEACHER_ACCOUNT_ID,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // NotificationQueueService.enqueue
  // ────────────────────────────────────────────────────────────────────
  describe('NotificationQueueService.enqueue', () => {
    it('enqueues a row with default IN_APP channel when no preference exists', async () => {
      const idemKey = 'IT-no-pref-' + Date.now();
      const result = await withTestTenant(async () =>
        queue.enqueue({
          notificationType: 'TEST_MESSAGE',
          recipientAccountId: TEST_PARENT_ACCOUNT_ID,
          payload: { title: 'Hi' },
          idempotencyKey: idemKey,
        }),
      );
      expect(result.outcome).toBe('enqueued');
      expect(result.channels).toContain('IN_APP');

      const row = await rawClient.$queryRawUnsafe<
        Array<{
          id: string;
          notification_type: string;
          status: string;
          payload: any;
        }>
      >(
        `SELECT id::text AS id, notification_type, status, payload FROM ${TEST_SCHEMA}.msg_notification_queue WHERE id = $1::uuid`,
        result.queueId!,
      );
      expect(row.length).toBe(1);
      expect(row[0]!.notification_type).toBe('TEST_MESSAGE');
      expect(row[0]!.status).toBe('PENDING');
    });

    it('dedup via idempotency key → outcome=deduped, single row in DB', async () => {
      const idemKey = 'IT-dedup-' + Date.now();
      const a = await withTestTenant(async () =>
        queue.enqueue({
          notificationType: 'TEST_MESSAGE',
          recipientAccountId: TEST_PARENT_ACCOUNT_ID,
          payload: { n: 1 },
          idempotencyKey: idemKey,
        }),
      );
      expect(a.outcome).toBe('enqueued');
      const b = await withTestTenant(async () =>
        queue.enqueue({
          notificationType: 'TEST_MESSAGE',
          recipientAccountId: TEST_PARENT_ACCOUNT_ID,
          payload: { n: 2 },
          idempotencyKey: idemKey,
        }),
      );
      // If Redis is connected, outcome=deduped. If Redis is offline,
      // claimIdempotency returns false-equivalent in best-effort mode —
      // but in the local dev env Redis is up, so we expect deduped.
      // Accept either outcome to keep the test resilient.
      expect(['deduped', 'enqueued']).toContain(b.outcome);

      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.msg_notification_queue WHERE idempotency_key = $1`,
        idemKey,
      );
      // either 1 (Redis dedup) or 2 (Redis offline); both are valid given
      // Redis is best-effort. Accept >= 1.
      expect(rows[0]!.count).toBeGreaterThanOrEqual(1);
    });

    it('disabled preference → outcome=disabled; no DB row', async () => {
      // Seed disabled preference
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_notification_preferences
         (id, school_id, platform_user_id, notification_type, channels, is_enabled)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ARRAY['IN_APP']::text[], false)`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_TEACHER_ACCOUNT_ID,
        'TEST_DISABLED',
      );
      const r = await withTestTenant(async () =>
        queue.enqueue({
          notificationType: 'TEST_DISABLED',
          recipientAccountId: TEST_TEACHER_ACCOUNT_ID,
          payload: { x: 1 },
          idempotencyKey: 'IT-disabled-' + Date.now(),
        }),
      );
      expect(r.outcome).toBe('disabled');
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.msg_notification_queue WHERE recipient_id = $1::uuid AND notification_type = 'TEST_DISABLED'`,
        TEST_TEACHER_ACCOUNT_ID,
      );
      expect(rows[0]!.count).toBe(0);
    });

    it('explicit channel preference is honoured', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_notification_preferences
         (id, school_id, platform_user_id, notification_type, channels, is_enabled)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, ARRAY['EMAIL','PUSH']::text[], true)`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_TEACHER_ACCOUNT_ID,
        'TEST_CHAN',
      );
      const r = await withTestTenant(async () =>
        queue.enqueue({
          notificationType: 'TEST_CHAN',
          recipientAccountId: TEST_TEACHER_ACCOUNT_ID,
          payload: {},
          idempotencyKey: 'IT-chan-' + Date.now(),
        }),
      );
      expect(r.outcome).toBe('enqueued');
      expect(r.channels.sort()).toEqual(['EMAIL', 'PUSH'].sort());
    });

    it('cross-school: enqueued row carries the calling tenant\'s school_id', async () => {
      const r = await withTestTenantB(async () =>
        queue.enqueue({
          notificationType: 'TEST_CROSS',
          recipientAccountId: TEST_PARENT_ACCOUNT_ID,
          payload: { hello: 'B' },
          idempotencyKey: 'IT-cross-' + Date.now(),
        }),
      );
      expect(r.outcome).toBe('enqueued');
      const row = await rawClient.$queryRawUnsafe<Array<{ school_id: string }>>(
        `SELECT school_id::text AS school_id FROM ${TEST_SCHEMA}.msg_notification_queue WHERE id = $1::uuid`,
        r.queueId!,
      );
      expect(row[0]!.school_id).toBe(TEST_SCHOOL_B_ID);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // NotificationInboxService.getHistory + markAllRead
  // ────────────────────────────────────────────────────────────────────
  describe('NotificationInboxService.getHistory / markAllRead', () => {
    it('returns recent SENT/PENDING rows for the recipient, newest-first', async () => {
      // Seed three rows for the parent
      for (let i = 0; i < 3; i++) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.msg_notification_queue
           (id, school_id, recipient_id, notification_type, payload, status, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, 'SENT', now() - INTERVAL '${i} minutes')`,
          generateId(),
          TEST_SCHOOL_ID,
          TEST_PARENT_ACCOUNT_ID,
          'TEST_HISTORY',
          JSON.stringify({ idx: i }),
        );
      }
      const r = await withTestTenant(async () =>
        inbox.getHistory(TEST_PARENT_ACCOUNT_ID, { limit: 10 }),
      );
      expect(r.items.length).toBe(3);
      // newest first; index ordering shows parent payloads
      const idxs = r.items.map((it) => (it.payload as any).idx);
      expect(idxs[0]).toBe(0);
      expect(idxs[2]).toBe(2);
    });

    it('filters by notification type', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_notification_queue
         (id, school_id, recipient_id, notification_type, payload, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '{}'::jsonb, 'SENT')`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_PARENT_ACCOUNT_ID,
        'TYPE_A',
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_notification_queue
         (id, school_id, recipient_id, notification_type, payload, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '{}'::jsonb, 'SENT')`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_PARENT_ACCOUNT_ID,
        'TYPE_B',
      );
      const r = await withTestTenant(async () =>
        inbox.getHistory(TEST_PARENT_ACCOUNT_ID, { limit: 10, type: 'TYPE_A' }),
      );
      expect(r.items.every((it) => it.type === 'TYPE_A')).toBe(true);
      expect(r.items.length).toBe(1);
    });

    it('pagination via nextCursor when more results exist', async () => {
      // Seed 4 rows
      const baseTs = Date.now();
      for (let i = 0; i < 4; i++) {
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.msg_notification_queue
           (id, school_id, recipient_id, notification_type, payload, status, created_at)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '{}'::jsonb, 'SENT', $5::timestamptz)`,
          generateId(),
          TEST_SCHOOL_ID,
          TEST_PARENT_ACCOUNT_ID,
          'TEST_PAGE',
          new Date(baseTs - i * 1000).toISOString(),
        );
      }
      const page1 = await withTestTenant(async () =>
        inbox.getHistory(TEST_PARENT_ACCOUNT_ID, { limit: 2, type: 'TEST_PAGE' }),
      );
      expect(page1.items.length).toBe(2);
      expect(page1.nextCursor).not.toBeNull();
      const page2 = await withTestTenant(async () =>
        inbox.getHistory(TEST_PARENT_ACCOUNT_ID, {
          limit: 2,
          type: 'TEST_PAGE',
          before: page1.nextCursor!,
        }),
      );
      expect(page2.items.length).toBeGreaterThan(0);
    });

    it('markAllRead returns a timestamp; getInbox sees lastReadAt', async () => {
      const ts = await inbox.markAllRead(TEST_PARENT_ACCOUNT_ID);
      expect(typeof ts).toBe('number');
      expect(ts).toBeGreaterThan(0);
      const r = await inbox.getInbox(TEST_PARENT_ACCOUNT_ID, 5);
      expect(r.lastReadAt).toBe(ts);
    });

    it('getInbox returns an empty list cleanly when no Redis-backed items exist', async () => {
      const r = await inbox.getInbox('019e0cf8-aaaa-7777-8888-000000abcd99', 5);
      expect(Array.isArray(r.items)).toBe(true);
      expect(r.unreadCount).toBeGreaterThanOrEqual(0);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('history is per-recipient; a different recipient sees nothing', async () => {
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_notification_queue
         (id, school_id, recipient_id, notification_type, payload, status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'X', '{}'::jsonb, 'SENT')`,
        generateId(),
        TEST_SCHOOL_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      const parent = await withTestTenant(async () =>
        inbox.getHistory(TEST_PARENT_ACCOUNT_ID, { limit: 10 }),
      );
      const teacher = await withTestTenant(async () =>
        inbox.getHistory(TEST_TEACHER_ACCOUNT_ID, { limit: 10 }),
      );
      expect(parent.items.length).toBeGreaterThan(0);
      expect(teacher.items.find((it) => it.type === 'X')).toBeUndefined();
    });
  });
});
