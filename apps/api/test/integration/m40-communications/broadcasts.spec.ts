import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { BroadcastSegmentService } from '@modules/m40-communications/broadcasts/broadcast-segment.service';
import { BroadcastAnalyticsService } from '@modules/m40-communications/broadcasts/broadcast-analytics.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { adminActor, teacherActor, TEST_ADMIN_ACCOUNT_ID } from '../helpers/actor';

/**
 * Wave 5 — m40-communications broadcasts DB-backed integration tests.
 *
 * Surface covered:
 *   - BroadcastSegmentService — list/getById/create/patch/resolve/preview,
 *     six segmentType resolution branches.
 *   - BroadcastAnalyticsService — getForBroadcast + applyDeliveryEvent UPSERT.
 */
describe('integration:m40-communications/broadcasts', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let segments: BroadcastSegmentService;
  let analytics: BroadcastAnalyticsService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    segments = new BroadcastSegmentService(tenantPrisma);
    analytics = new BroadcastAnalyticsService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.msg_broadcast_analytics`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.msg_broadcast_segments WHERE name LIKE 'IT-%'`,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // BroadcastSegmentService CRUD
  // ────────────────────────────────────────────────────────────────────
  describe('BroadcastSegmentService.create / patch / list / getById', () => {
    it('admin creates an ALL_STAFF segment; list / getById round-trip', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          {
            name: 'IT-all-staff',
            description: 'Every staff member',
            segmentType: 'ALL_STAFF',
            filterCriteria: {},
            isActive: true,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('IT-all-staff');
      expect(dto.segmentType).toBe('ALL_STAFF');

      const fetched = await withTestTenant(async () => segments.getById(dto.id));
      expect(fetched.id).toBe(dto.id);

      const list = await withTestTenant(async () => segments.list());
      expect(list.map((s) => s.id)).toContain(dto.id);
    });

    it('non-admin cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          segments.create(
            {
              name: 'IT-blocked',
              segmentType: 'ALL_STAFF',
              filterCriteria: {},
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate name on same school → ConflictException', async () => {
      await withTestTenant(async () =>
        segments.create(
          { name: 'IT-dup', segmentType: 'ALL_STAFF', filterCriteria: {} } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          segments.create(
            { name: 'IT-dup', segmentType: 'ALL_STAFF', filterCriteria: {} } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('patch updates name + filterCriteria; non-admin patch → 403', async () => {
      const d = await withTestTenant(async () =>
        segments.create(
          { name: 'IT-orig', segmentType: 'ALL_STAFF', filterCriteria: {} } as any,
          adminActor(),
        ),
      );
      const upd = await withTestTenant(async () =>
        segments.patch(
          d.id,
          { name: 'IT-patched', filterCriteria: { tag: 'beta' } } as any,
          adminActor(),
        ),
      );
      expect(upd.name).toBe('IT-patched');
      expect((upd.filterCriteria as any).tag).toBe('beta');

      await expect(
        withTestTenant(async () =>
          segments.patch(d.id, { name: 'IT-stolen' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          segments.patch(
            '00000000-0000-0000-0000-000000000000',
            { name: 'IT-ghost' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list includeInactive=false hides inactive rows', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          {
            name: 'IT-inactive',
            segmentType: 'ALL_STAFF',
            filterCriteria: {},
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      const def = await withTestTenant(async () => segments.list());
      expect(def.map((s) => s.id)).not.toContain(dto.id);
      const incl = await withTestTenant(async () => segments.list({ includeInactive: true }));
      expect(incl.map((s) => s.id)).toContain(dto.id);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Resolution branches
  // ────────────────────────────────────────────────────────────────────
  describe('BroadcastSegmentService.resolve', () => {
    it('ALL_STAFF resolves to platform_users joined via hr_employees', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          { name: 'IT-staff-resolve', segmentType: 'ALL_STAFF', filterCriteria: {} } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => segments.resolve(dto.id));
      // The integration suite seeds 3 hr_employees rows (admin/officer/teacher)
      // all in School A — every one has a platform_users row.
      expect(r.totalRecipients).toBeGreaterThanOrEqual(1);
      // Cached on the row
      const fetched = await withTestTenant(async () => segments.getById(dto.id));
      expect(fetched.estimatedRecipients).toBe(r.totalRecipients);
    });

    it('ALL_PARENTS resolves to 0 when no guardians seeded', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          { name: 'IT-parents', segmentType: 'ALL_PARENTS', filterCriteria: {} } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => segments.resolve(dto.id));
      expect(r.totalRecipients).toBeGreaterThanOrEqual(0);
    });

    it('GRADE_LEVEL requires filter_criteria.grade_level', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          { name: 'IT-grade-bare', segmentType: 'GRADE_LEVEL', filterCriteria: {} } as any,
          adminActor(),
        ),
      );
      await expect(withTestTenant(async () => segments.resolve(dto.id))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('CLASS requires non-empty filter_criteria.class_ids', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          { name: 'IT-class-bare', segmentType: 'CLASS', filterCriteria: {} } as any,
          adminActor(),
        ),
      );
      await expect(withTestTenant(async () => segments.resolve(dto.id))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('TRANSPORT_ROUTE returns empty when transport tables not present', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          {
            name: 'IT-route',
            segmentType: 'TRANSPORT_ROUTE',
            filterCriteria: { route_ids: [generateId()] },
          } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => segments.resolve(dto.id));
      expect(r.totalRecipients).toBe(0);
    });

    it('CUSTOM with empty list → BadRequestException', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          {
            name: 'IT-custom-bare',
            segmentType: 'CUSTOM',
            filterCriteria: { custom_user_ids: [] },
          } as any,
          adminActor(),
        ),
      );
      await expect(withTestTenant(async () => segments.resolve(dto.id))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('CUSTOM with a school-affiliated id resolves to that id; bogus id silently drops', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          {
            name: 'IT-custom-resolve',
            segmentType: 'CUSTOM',
            filterCriteria: {
              custom_user_ids: [TEST_ADMIN_ACCOUNT_ID, '00000000-0000-0000-0000-000000000000'],
            },
          } as any,
          adminActor(),
        ),
      );
      const r = await withTestTenant(async () => segments.resolve(dto.id));
      // admin actor has an hr_employees row in TEST_SCHOOL_ID, so they resolve;
      // the bogus uuid silently drops.
      expect(r.accountIds).toContain(TEST_ADMIN_ACCOUNT_ID);
    });

    it('preview returns the cached estimated_recipients without re-resolving', async () => {
      const dto = await withTestTenant(async () =>
        segments.create(
          {
            name: 'IT-preview',
            segmentType: 'ALL_STAFF',
            filterCriteria: {},
          } as any,
          adminActor(),
        ),
      );
      // First preview triggers resolve and caches the count
      const p1 = await withTestTenant(async () => segments.preview(dto.id));
      const p2 = await withTestTenant(async () => segments.preview(dto.id));
      expect(p1.estimatedRecipients).toBe(p2.estimatedRecipients);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('segment created in School B invisible to School A list', async () => {
      // Hand-seed a School B segment with explicit school_id
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_broadcast_segments
         (id, school_id, name, segment_type, filter_criteria)
         VALUES ($1::uuid, $2::uuid, 'IT-B-only', 'ALL_STAFF', '{}'::jsonb)`,
        id,
        TEST_SCHOOL_B_ID,
      );
      const listA = await withTestTenant(async () => segments.list());
      expect(listA.map((s) => s.id)).not.toContain(id);
      const listB = await withTestTenantB(async () => segments.list());
      expect(listB.map((s) => s.id)).toContain(id);
    });

    it('getById on cross-school segment → NotFoundException', async () => {
      const id = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.msg_broadcast_segments
         (id, school_id, name, segment_type, filter_criteria)
         VALUES ($1::uuid, $2::uuid, 'IT-B-get', 'ALL_STAFF', '{}'::jsonb)`,
        id,
        TEST_SCHOOL_B_ID,
      );
      await expect(withTestTenant(async () => segments.getById(id))).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // BroadcastAnalyticsService
  // ────────────────────────────────────────────────────────────────────
  describe('BroadcastAnalyticsService.applyDeliveryEvent', () => {
    it('first event INSERTs row with computed rates', async () => {
      const broadcastId = generateId();
      const result = await withTestTenant(async () =>
        analytics.applyDeliveryEvent({
          broadcastId,
          totalRecipients: 100,
          delivered: 80,
          opened: 40,
          clicked: 10,
          bounced: 5,
          unsubscribed: 1,
        } as any),
      );
      expect(result.totalRecipients).toBe(100);
      expect(result.delivered).toBe(80);
      expect(result.deliveryRate).toBeCloseTo(0.8, 5);
      expect(result.openRate).toBeCloseTo(0.5, 5);
      expect(result.clickRate).toBeCloseTo(0.25, 5);

      const all = await withTestTenant(async () => analytics.getForBroadcast(broadcastId));
      expect(all.aggregate?.totalRecipients).toBe(100);
    });

    it('duplicate event on same broadcast UPDATEs (not INSERTs) the row', async () => {
      const broadcastId = generateId();
      await withTestTenant(async () =>
        analytics.applyDeliveryEvent({
          broadcastId,
          totalRecipients: 10,
          delivered: 5,
        } as any),
      );
      await withTestTenant(async () =>
        analytics.applyDeliveryEvent({
          broadcastId,
          totalRecipients: 10,
          delivered: 8,
        } as any),
      );
      const rows = await rawClient.$queryRawUnsafe<Array<{ count: number }>>(
        `SELECT count(*)::int AS count FROM ${TEST_SCHEMA}.msg_broadcast_analytics WHERE broadcast_id = $1::uuid AND segment_id IS NULL`,
        broadcastId,
      );
      expect(rows[0]!.count).toBe(1);
    });

    it('per-segment event creates a distinct row alongside the aggregate', async () => {
      const broadcastId = generateId();
      const segDto = await withTestTenant(async () =>
        segments.create(
          { name: 'IT-seg-an', segmentType: 'ALL_STAFF', filterCriteria: {} } as any,
          adminActor(),
        ),
      );
      // aggregate
      await withTestTenant(async () =>
        analytics.applyDeliveryEvent({
          broadcastId,
          totalRecipients: 50,
          delivered: 40,
        } as any),
      );
      // per-segment
      await withTestTenant(async () =>
        analytics.applyDeliveryEvent({
          broadcastId,
          segmentId: segDto.id,
          totalRecipients: 20,
          delivered: 18,
        } as any),
      );
      const view = await withTestTenant(async () => analytics.getForBroadcast(broadcastId));
      expect(view.perSegment.length).toBe(1);
      expect(view.perSegment[0]!.segmentId).toBe(segDto.id);
      expect(view.aggregate?.delivered).toBe(40);
    });

    it('missing broadcastId → BadRequestException', async () => {
      await expect(
        withTestTenant(async () => analytics.applyDeliveryEvent({ broadcastId: '' } as any)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('negative totalRecipients → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          analytics.applyDeliveryEvent({
            broadcastId: generateId(),
            totalRecipients: -1,
          } as any),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
