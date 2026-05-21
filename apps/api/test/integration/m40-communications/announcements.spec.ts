import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { AnnouncementService } from '@modules/m40-communications/announcements/announcement.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
import type { KafkaProducerService } from '@shared/kafka/kafka-producer.service';

import { makeRecordingKafka, RecordingKafkaProducer } from '../helpers/recording-kafka';
import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  studentActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_STUDENT_ACCOUNT_ID,
} from '../helpers/actor';
import {
  TEST_ALERT_TYPE_INFO_ID,
  TEST_ALERT_TYPE_EMERGENCY_ID,
  TEST_ALERT_TYPE_INFO_B_ID,
} from '../fixtures/communications';

/**
 * Wave 5 — m40-communications announcements DB-backed integration tests.
 *
 * AnnouncementService surface:
 *   - list / getById with manager vs reader scope
 *   - create draft + publish-now (emits msg.announcement.published)
 *   - update (publish flow)
 *   - markRead (idempotent)
 *   - getStats (author or admin only)
 *
 * Manager status is decided by PermissionCheckService.hasAnyPermissionInTenant
 * against com-002:write. The integration suite seeds no role assignments by
 * default; only the admin actor flips manager=true via isSchoolAdmin. Teacher,
 * student, and parent are readers.
 */
describe('integration:m40-communications/announcements', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let kafka: ReturnType<typeof makeRecordingKafka>;
  let permissions: PermissionCheckService;
  let service: AnnouncementService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    kafka = makeRecordingKafka();
    permissions = new PermissionCheckService(rawClient);
    service = new AnnouncementService(
      tenantPrisma,
      kafka as unknown as KafkaProducerService,
      permissions,
    );
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    (kafka as unknown as RecordingKafkaProducer).reset();
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcement_reads`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcement_audiences`);
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_announcements`);
  });

  // ────────────────────────────────────────────────────────────────────
  // create — auth gate + emit
  // ────────────────────────────────────────────────────────────────────
  describe('AnnouncementService.create', () => {
    it('admin creates a draft → row inserted, no Kafka emit', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            title: 'Draft only',
            body: 'Test body',
            audienceType: 'ALL_SCHOOL',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Draft only');
      expect(dto.isPublished).toBe(false);
      const row = await rawClient.$queryRawUnsafe<Array<{ is_published: boolean }>>(
        `SELECT is_published FROM ${TEST_SCHEMA}.msg_announcements WHERE id = $1::uuid`,
        dto.id,
      );
      expect(row[0]!.is_published).toBe(false);
      expect(
        (kafka as unknown as RecordingKafkaProducer).callsForTopic('msg.announcement.published'),
      ).toHaveLength(0);
    });

    it('admin publishes immediately → row.is_published=true + msg.announcement.published emit', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            title: 'Live!',
            body: 'Goes out now',
            audienceType: 'ALL_SCHOOL',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.isPublished).toBe(true);
      const emits = (kafka as unknown as RecordingKafkaProducer).callsForTopic(
        'msg.announcement.published',
      );
      expect(emits.length).toBe(1);
      expect(emits[0]!.key).toBe(dto.id);
      expect(emits[0]!.payload).toMatchObject({
        announcementId: dto.id,
        title: 'Live!',
        audienceType: 'ALL_SCHOOL',
      });
    });

    it('CLASS audience requires audienceRef → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create({ title: 'Class', body: 'b', audienceType: 'CLASS' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ALL_SCHOOL with non-empty audienceRef → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              title: 'All',
              body: 'b',
              audienceType: 'ALL_SCHOOL',
              audienceRef: 'should-be-empty',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('invalid audience type → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            { title: 'Bad', body: 'b', audienceType: 'BOGUS' as any } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('alertTypeId from another school → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            {
              title: 'wrong-alert',
              body: 'b',
              audienceType: 'ALL_SCHOOL',
              alertTypeId: TEST_ALERT_TYPE_INFO_B_ID,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('alertTypeId resolves when in-school', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            title: 'alert-attached',
            body: 'b',
            audienceType: 'ALL_SCHOOL',
            alertTypeId: TEST_ALERT_TYPE_INFO_ID,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.alertTypeId).toBe(TEST_ALERT_TYPE_INFO_ID);
      expect(dto.alertTypeName).toBe('Info');
    });

    it('non-manager (parent) cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            { title: 'parent-attempt', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // list — manager vs reader scope
  // ────────────────────────────────────────────────────────────────────
  describe('AnnouncementService.list', () => {
    it('manager sees published rows by default; includeDrafts surfaces drafts', async () => {
      const pub = await withTestTenant(async () =>
        service.create(
          {
            title: 'pub',
            body: 'b',
            audienceType: 'ALL_SCHOOL',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      const draft = await withTestTenant(async () =>
        service.create(
          { title: 'draft', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      const def = await withTestTenant(async () => service.list({} as any, adminActor()));
      expect(def.map((r) => r.id)).toContain(pub.id);
      expect(def.map((r) => r.id)).not.toContain(draft.id);

      const withDrafts = await withTestTenant(async () =>
        service.list({ includeDrafts: true } as any, adminActor()),
      );
      expect(withDrafts.map((r) => r.id)).toContain(draft.id);
    });

    it('reader (parent) only sees announcements where they have an audience row', async () => {
      const pub = await withTestTenant(async () =>
        service.create(
          {
            title: 'fan-out me',
            body: 'b',
            audienceType: 'ALL_SCHOOL',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      // Pre-fan-out: parent has no audience row → list is empty
      const empty = await withTestTenant(async () => service.list({} as any, parentActor()));
      expect(empty.map((r) => r.id)).not.toContain(pub.id);

      // Add audience row → parent sees it
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcement_audiences (id, school_id, announcement_id, platform_user_id, delivery_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        generateId(),
        TEST_SCHOOL_ID,
        pub.id,
        TEST_PARENT_ACCOUNT_ID,
      );
      const list = await withTestTenant(async () => service.list({} as any, parentActor()));
      expect(list.map((r) => r.id)).toContain(pub.id);
    });

    it('reader passing includeDrafts=true is silently ignored', async () => {
      const draft = await withTestTenant(async () =>
        service.create(
          { title: 'sneaky', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      // Audience row would normally exist, but we omit it for the draft path
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcement_audiences (id, school_id, announcement_id, platform_user_id, delivery_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        generateId(),
        TEST_SCHOOL_ID,
        draft.id,
        TEST_PARENT_ACCOUNT_ID,
      );
      const list = await withTestTenant(async () =>
        service.list({ includeDrafts: true } as any, parentActor()),
      );
      expect(list.map((r) => r.id)).not.toContain(draft.id);
    });

    it('expired announcements hidden by default; includeExpired surfaces them', async () => {
      const dto = await withTestTenant(async () =>
        service.create(
          {
            title: 'expiring',
            body: 'b',
            audienceType: 'ALL_SCHOOL',
            isPublished: true,
            expiresAt: '2000-01-01T00:00:00.000Z',
          } as any,
          adminActor(),
        ),
      );
      const def = await withTestTenant(async () => service.list({} as any, adminActor()));
      expect(def.map((r) => r.id)).not.toContain(dto.id);
      const full = await withTestTenant(async () =>
        service.list({ includeExpired: true } as any, adminActor()),
      );
      expect(full.map((r) => r.id)).toContain(dto.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getById visibility
  // ────────────────────────────────────────────────────────────────────
  describe('AnnouncementService.getById', () => {
    it('manager fetches a draft they authored', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          { title: 'mine', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      const fetched = await withTestTenant(async () => service.getById(d.id, adminActor()));
      expect(fetched.id).toBe(d.id);
    });

    it('reader without audience row → NotFoundException', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          {
            title: 'no audience',
            body: 'b',
            audienceType: 'ALL_SCHOOL',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.getById(d.id, parentActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // update
  // ────────────────────────────────────────────────────────────────────
  describe('AnnouncementService.update', () => {
    it('publishing a draft via update emits + flips is_published', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          { title: 'draft', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      (kafka as unknown as RecordingKafkaProducer).reset();
      const upd = await withTestTenant(async () =>
        service.update(d.id, { isPublished: true } as any, adminActor()),
      );
      expect(upd.isPublished).toBe(true);
      expect(
        (kafka as unknown as RecordingKafkaProducer).callsForTopic('msg.announcement.published'),
      ).toHaveLength(1);
    });

    it('updating a title on a draft persists', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          { title: 'old', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        service.update(d.id, { title: 'new', body: 'b2' } as any, adminActor()),
      );
      expect(upd.title).toBe('new');
      expect(upd.body).toBe('b2');
    });

    it('changing audience type → CLASS requires audienceRef', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          { title: 'switching', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.update(d.id, { audienceType: 'CLASS' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('published announcements cannot be edited → BadRequestException', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          {
            title: 'locked',
            body: 'b',
            audienceType: 'ALL_SCHOOL',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.update(d.id, { title: 'edited' } as any, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('setting isPublished=false on a draft → BadRequestException', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          { title: 'no-go', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          service.update(d.id, { isPublished: false } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-manager (parent) cannot update → ForbiddenException', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          { title: 'draft', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.update(d.id, { title: 'x' } as any, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.update(
            '00000000-0000-0000-0000-000000000000',
            { title: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // markRead
  // ────────────────────────────────────────────────────────────────────
  describe('AnnouncementService.markRead', () => {
    it('inserts msg_announcement_reads row; subsequent calls newlyRead=false', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          {
            title: 'read me',
            body: 'b',
            audienceType: 'ALL_SCHOOL',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      // seed audience so parent can see + mark read
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcement_audiences (id, school_id, announcement_id, platform_user_id, delivery_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        generateId(),
        TEST_SCHOOL_ID,
        d.id,
        TEST_PARENT_ACCOUNT_ID,
      );

      const first = await withTestTenant(async () => service.markRead(d.id, parentActor()));
      expect(first.newlyRead).toBe(true);
      const second = await withTestTenant(async () => service.markRead(d.id, parentActor()));
      expect(second.newlyRead).toBe(false);
      const row = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.msg_announcement_reads WHERE announcement_id = $1::uuid AND reader_id = $2::uuid`,
        d.id,
        TEST_PARENT_ACCOUNT_ID,
      );
      expect(row[0]!.count).toBe(1);

      // PENDING → DELIVERED on audience flip
      const aud = await rawClient.$queryRawUnsafe<Array<{ delivery_status: string }>>(
        `SELECT delivery_status FROM ${TEST_SCHEMA}.msg_announcement_audiences WHERE announcement_id = $1::uuid AND platform_user_id = $2::uuid`,
        d.id,
        TEST_PARENT_ACCOUNT_ID,
      );
      expect(aud[0]!.delivery_status).toBe('DELIVERED');
    });

    it('cannot mark a draft as read → BadRequestException', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          { title: 'draft', body: 'b', audienceType: 'ALL_SCHOOL' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => service.markRead(d.id, adminActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // stats
  // ────────────────────────────────────────────────────────────────────
  describe('AnnouncementService.getStats', () => {
    it('returns aggregate counts; author or admin only', async () => {
      const d = await withTestTenant(async () =>
        service.create(
          {
            title: 'stats',
            body: 'b',
            audienceType: 'ALL_SCHOOL',
            isPublished: true,
          } as any,
          adminActor(),
        ),
      );
      // 2 audience rows, 1 read
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcement_audiences (id, school_id, announcement_id, platform_user_id, delivery_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'DELIVERED')`,
        generateId(),
        TEST_SCHOOL_ID,
        d.id,
        TEST_PARENT_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcement_audiences (id, school_id, announcement_id, platform_user_id, delivery_status)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'PENDING')`,
        generateId(),
        TEST_SCHOOL_ID,
        d.id,
        TEST_STUDENT_ACCOUNT_ID,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcement_reads (id, school_id, announcement_id, reader_id)
         VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid)`,
        generateId(),
        TEST_SCHOOL_ID,
        d.id,
        TEST_PARENT_ACCOUNT_ID,
      );
      const stats = await withTestTenant(async () => service.getStats(d.id, adminActor()));
      expect(stats.totalAudience).toBe(2);
      expect(stats.readCount).toBe(1);
      expect(stats.deliveredCount).toBe(1);
      expect(stats.pendingCount).toBe(1);
      expect(stats.readPercentage).toBe(50);
    });

    it('non-author non-admin → ForbiddenException', async () => {
      const d = await withTestTenant(async () =>
        service.create({ title: 't', body: 'b', audienceType: 'ALL_SCHOOL' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => service.getStats(d.id, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getStats('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School B announcement invisible to School A list', async () => {
      // Manually seed a School B announcement (same schema, different school_id).
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcements
         (id, school_id, author_id, title, body, audience_type, is_published, publish_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'school-B-msg', 'b', 'ALL_SCHOOL', true, now())`,
        id,
        TEST_SCHOOL_B_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      const listA = await withTestTenant(async () => service.list({} as any, adminActor()));
      expect(listA.map((r) => r.id)).not.toContain(id);

      const listB = await withTestTenantB(async () => service.list({} as any, adminActor()));
      expect(listB.map((r) => r.id)).toContain(id);
    });

    it('School B announcement cannot be fetched by School A admin', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_announcements
         (id, school_id, author_id, title, body, audience_type, is_published, publish_at)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'B-only', 'b', 'ALL_SCHOOL', true, now())`,
        id,
        TEST_SCHOOL_B_ID,
        TEST_ADMIN_ACCOUNT_ID,
      );
      await expect(
        withTestTenant(async () => service.getById(id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // Silence unused-import warnings
  void TEST_ALERT_TYPE_EMERGENCY_ID;
  void teacherActor;
  void studentActor;
});
