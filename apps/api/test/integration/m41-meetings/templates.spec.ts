import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { MeetingTemplateService } from '@modules/m41-meetings/templates/meeting-template.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  studentActor,
  parentActor,
  teacherActor,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_MEETING_TYPE_ID, TEST_MEETING_TYPE_B_ID } from '../fixtures/meetings';

/**
 * Wave 5 — m41-meetings MeetingTemplateService.
 *
 * Strategy:
 *   - list / getById — staff-gated
 *   - create — UNIQUE(school_id, name) prevents duplicate names
 *   - patch — sets fields, re-applies UNIQUE on rename
 *   - createMeetingFromTemplate (KEYSTONE) — INSERTs a mtg_meetings
 *     row + N mtg_agenda_items rows in one tx
 *   - Cross-school isolation: list / getById filtered by school_id
 */
describe('integration:m41-meetings/templates', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let templateService: MeetingTemplateService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    templateService = new MeetingTemplateService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe templates for both schools
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meeting_templates WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    // Wipe meetings derived from templates
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // create + list + getById
  // ────────────────────────────────────────────────────────────────────
  describe('CRUD', () => {
    it('admin creates a template → row inserted with default_agenda JSON', async () => {
      const dto = await withTestTenant(async () =>
        templateService.create(
          {
            name: 'Weekly Staff Sync',
            description: 'Recurring staff sync template',
            meetingTypeId: TEST_MEETING_TYPE_ID,
            defaultDurationMinutes: 45,
            defaultAgenda: [
              { title: 'Updates', durationMinutes: 10, sortOrder: 0 },
              { title: 'Discussion', durationMinutes: 30, sortOrder: 1 },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('Weekly Staff Sync');
      expect(dto.defaultAgenda).toHaveLength(2);
      expect(dto.isActive).toBe(true);

      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.mtg_meeting_templates WHERE id = $1::uuid`,
        dto.id,
      );
      expect(rows).toHaveLength(1);
    });

    it('duplicate template name in same school → BadRequestException (UNIQUE)', async () => {
      await withTestTenant(async () =>
        templateService.create({ name: 'Dup', defaultDurationMinutes: 30 } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          templateService.create({ name: 'Dup', defaultDurationMinutes: 60 } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('STUDENT cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          templateService.create({ name: 'Forbidden' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          templateService.create({ name: 'Forbidden' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-admin staff without employeeId would fail — but test teacher has one (staff path)', async () => {
      const dto = await withTestTenant(async () =>
        templateService.create({ name: 'Teacher built' } as any, teacherActor()),
      );
      expect(dto.name).toBe('Teacher built');
    });

    it('list returns only active templates by default', async () => {
      const t1 = await withTestTenant(async () =>
        templateService.create({ name: 'Active T' } as any, adminActor()),
      );
      const t2 = await withTestTenant(async () =>
        templateService.create({ name: 'Inactive T' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        templateService.patch(t2.id, { isActive: false } as any, adminActor()),
      );

      const activeList = await withTestTenant(async () => templateService.list(adminActor()));
      const ids = activeList.map((r) => r.id);
      expect(ids).toContain(t1.id);
      expect(ids).not.toContain(t2.id);

      const allList = await withTestTenant(async () => templateService.list(adminActor(), true));
      const allIds = allList.map((r) => r.id);
      expect(allIds).toContain(t1.id);
      expect(allIds).toContain(t2.id);
    });

    it('getById returns the template; missing id → NotFoundException', async () => {
      const t = await withTestTenant(async () =>
        templateService.create({ name: 'Findme' } as any, adminActor()),
      );
      const fetched = await withTestTenant(async () => templateService.getById(t.id, adminActor()));
      expect(fetched.id).toBe(t.id);

      await expect(
        withTestTenant(async () =>
          templateService.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('STUDENT cannot list or getById → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => templateService.list(studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);

      await expect(
        withTestTenant(async () =>
          templateService.getById('00000000-0000-0000-0000-000000000000', studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // patch
  // ────────────────────────────────────────────────────────────────────
  describe('patch', () => {
    it('patch updates name, description, agenda, isActive', async () => {
      const t = await withTestTenant(async () =>
        templateService.create(
          {
            name: 'Original',
            description: 'old',
            defaultDurationMinutes: 30,
            defaultAgenda: [],
          } as any,
          adminActor(),
        ),
      );
      const updated = await withTestTenant(async () =>
        templateService.patch(
          t.id,
          {
            name: 'Renamed',
            description: 'new desc',
            meetingTypeId: TEST_MEETING_TYPE_ID,
            defaultDurationMinutes: 60,
            defaultAgenda: [{ title: 'New item', sortOrder: 0 }],
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(updated.name).toBe('Renamed');
      expect(updated.description).toBe('new desc');
      expect(updated.defaultDurationMinutes).toBe(60);
      expect(updated.defaultAgenda).toHaveLength(1);
      expect(updated.isActive).toBe(false);
    });

    it('patch with empty body returns current template', async () => {
      const t = await withTestTenant(async () =>
        templateService.create({ name: 'static' } as any, adminActor()),
      );
      const after = await withTestTenant(async () =>
        templateService.patch(t.id, {} as any, adminActor()),
      );
      expect(after.id).toBe(t.id);
      expect(after.name).toBe('static');
    });

    it('patch on a missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          templateService.patch(
            '00000000-0000-0000-0000-000000000000',
            { name: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch rename to existing name → BadRequestException', async () => {
      const t1 = await withTestTenant(async () =>
        templateService.create({ name: 'first' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        templateService.create({ name: 'second' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          templateService.patch(t1.id, { name: 'second' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // createMeetingFromTemplate — KEYSTONE
  // ────────────────────────────────────────────────────────────────────
  describe('createMeetingFromTemplate', () => {
    it('inserts meeting + N agenda items atomically', async () => {
      const t = await withTestTenant(async () =>
        templateService.create(
          {
            name: 'IEP template',
            meetingTypeId: TEST_MEETING_TYPE_ID,
            defaultDurationMinutes: 60,
            defaultAgenda: [
              { title: 'Welcome', durationMinutes: 5, sortOrder: 0 },
              { title: 'Review goals', durationMinutes: 30, sortOrder: 1 },
              { title: 'Next steps', durationMinutes: 15, sortOrder: 2 },
            ],
          } as any,
          adminActor(),
        ),
      );
      const result = await withTestTenant(async () =>
        templateService.createMeetingFromTemplate(
          t.id,
          {
            title: 'IEP for student',
            scheduledAt: '2026-06-25T15:00:00Z',
            participantIds: [TEST_TEACHER_ACCOUNT_ID],
          } as any,
          adminActor(),
        ),
      );
      expect(result.agendaItemsCreated).toBe(3);

      const meetingRows = await rawClient.$queryRawUnsafe<
        Array<{ id: string; duration_minutes: number }>
      >(
        `SELECT id::text, duration_minutes FROM ${TEST_SCHEMA}.mtg_meetings WHERE id = $1::uuid`,
        result.meetingId,
      );
      expect(meetingRows).toHaveLength(1);
      expect(meetingRows[0]!.duration_minutes).toBe(60);

      const agenda = await rawClient.$queryRawUnsafe<Array<{ title: string; sort_order: number }>>(
        `SELECT title, sort_order FROM ${TEST_SCHEMA}.mtg_agenda_items WHERE meeting_id = $1::uuid ORDER BY sort_order ASC`,
        result.meetingId,
      );
      expect(agenda).toHaveLength(3);
      expect(agenda[0]!.title).toBe('Welcome');
      expect(agenda[2]!.title).toBe('Next steps');
    });

    it('refuses inactive templates → BadRequestException', async () => {
      const t = await withTestTenant(async () =>
        templateService.create({ name: 'will deactivate' } as any, adminActor()),
      );
      await withTestTenant(async () =>
        templateService.patch(t.id, { isActive: false } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          templateService.createMeetingFromTemplate(
            t.id,
            {
              title: 'should fail',
              scheduledAt: '2026-06-25T15:00:00Z',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses templates without meeting_type_id → BadRequestException', async () => {
      const t = await withTestTenant(async () =>
        templateService.create({ name: 'no type' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          templateService.createMeetingFromTemplate(
            t.id,
            {
              title: 'must have type',
              scheduledAt: '2026-06-25T15:00:00Z',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('participantIds with cross-school account → BadRequestException', async () => {
      const t = await withTestTenant(async () =>
        templateService.create(
          { name: 'with check', meetingTypeId: TEST_MEETING_TYPE_ID } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          templateService.createMeetingFromTemplate(
            t.id,
            {
              title: 'bogus',
              scheduledAt: '2026-06-25T15:00:00Z',
              participantIds: ['00000000-0000-0000-0000-000000000099'],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('uses input.durationMinutes override over template default', async () => {
      const t = await withTestTenant(async () =>
        templateService.create(
          {
            name: 'override-duration',
            meetingTypeId: TEST_MEETING_TYPE_ID,
            defaultDurationMinutes: 60,
          } as any,
          adminActor(),
        ),
      );
      const result = await withTestTenant(async () =>
        templateService.createMeetingFromTemplate(
          t.id,
          {
            title: 'short version',
            scheduledAt: '2026-06-25T15:00:00Z',
            durationMinutes: 15,
          } as any,
          adminActor(),
        ),
      );
      const m = await rawClient.$queryRawUnsafe<Array<{ duration_minutes: number }>>(
        `SELECT duration_minutes FROM ${TEST_SCHEMA}.mtg_meetings WHERE id = $1::uuid`,
        result.meetingId,
      );
      expect(m[0]!.duration_minutes).toBe(15);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('list returns templates only from the current school', async () => {
      const aTemplate = await withTestTenant(async () =>
        templateService.create({ name: 'A only' } as any, adminActor()),
      );
      const bTemplate = await withTestTenantB(async () =>
        templateService.create({ name: 'B only' } as any, adminActor()),
      );
      const aList = await withTestTenant(async () => templateService.list(adminActor()));
      const aIds = aList.map((r) => r.id);
      expect(aIds).toContain(aTemplate.id);
      expect(aIds).not.toContain(bTemplate.id);

      const bList = await withTestTenantB(async () => templateService.list(adminActor()));
      const bIds = bList.map((r) => r.id);
      expect(bIds).toContain(bTemplate.id);
      expect(bIds).not.toContain(aTemplate.id);
    });

    it('School A admin cannot getById a School B template → NotFoundException', async () => {
      const bTemplate = await withTestTenantB(async () =>
        templateService.create({ name: 'B confidential' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () => templateService.getById(bTemplate.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('same template name allowed in different schools', async () => {
      const aId = (
        await withTestTenant(async () =>
          templateService.create({ name: 'Shared name' } as any, adminActor()),
        )
      ).id;
      const bId = (
        await withTestTenantB(async () =>
          templateService.create({ name: 'Shared name' } as any, adminActor()),
        )
      ).id;
      expect(aId).not.toBe(bId);
    });
  });

  void TEST_MEETING_TYPE_B_ID;
});
