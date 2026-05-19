import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { MeetingService } from '@modules/m41-meetings/meetings/meeting.service';
import { ActionItemService } from '@modules/m41-meetings/meetings/action-item.service';
import { AgendaService } from '@modules/m41-meetings/meetings/agenda.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

import {
  withTestTenant,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  adminActor,
  teacherActor,
  parentActor,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_ADMIN_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_MEETING_TYPE_ID } from '../fixtures/meetings';

/**
 * Wave 5 — m41-meetings ActionItemService + AgendaService.
 */
describe('integration:m41-meetings/actions-agenda', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let meetingService: MeetingService;
  let actionService: ActionItemService;
  let agendaService: AgendaService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    meetingService = new MeetingService(tenantPrisma, outbox);
    actionService = new ActionItemService(tenantPrisma, meetingService);
    agendaService = new AgendaService(tenantPrisma, meetingService);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'mtg.meeting.scheduled' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  async function createMeeting(): Promise<string> {
    const m = await withTestTenant(async () =>
      meetingService.create(
        {
          meetingTypeId: TEST_MEETING_TYPE_ID,
          title: 'Action+agenda meeting',
          scheduledAt: '2026-06-20T15:00:00Z',
          durationMinutes: 30,
          participantIds: [TEST_TEACHER_ACCOUNT_ID],
        } as any,
        adminActor(),
      ),
    );
    return m.id;
  }

  // ────────────────────────────────────────────────────────────────────
  // ActionItemService
  // ────────────────────────────────────────────────────────────────────
  describe('ActionItemService', () => {
    it('admin creates action item assigned to teacher → row inserted', async () => {
      const meetingId = await createMeeting();
      const dto = await withTestTenant(async () =>
        actionService.create(
          meetingId,
          {
            assigneeId: TEST_TEACHER_ACCOUNT_ID,
            description: 'Prep handout',
            dueDate: '2026-06-30',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.description).toBe('Prep handout');
      expect(dto.status).toBe('OPEN');
      expect(dto.assigneeId).toBe(TEST_TEACHER_ACCOUNT_ID);
      expect(dto.dueDate).toBe('2026-06-30');
    });

    it('listForMeeting returns all items; admin bypasses participant scope', async () => {
      const meetingId = await createMeeting();
      await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'item 1' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        actionService.listForMeeting(meetingId, adminActor()),
      );
      expect(list).toHaveLength(1);
      expect(list[0]!.description).toBe('item 1');
    });

    it('non-participant cannot listForMeeting → NotFoundException', async () => {
      const meetingId = await createMeeting();
      await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'hidden' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          actionService.listForMeeting(meetingId, parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher (participant) can list items', async () => {
      const meetingId = await createMeeting();
      await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'visible to teacher' } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        actionService.listForMeeting(meetingId, teacherActor()),
      );
      expect(list).toHaveLength(1);
    });

    it('listMine filters by assignee', async () => {
      const meetingId = await createMeeting();
      await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'teacher item' } as any,
          adminActor(),
        ),
      );
      const mine = await withTestTenant(async () =>
        actionService.listMine(teacherActor()),
      );
      expect(mine).toHaveLength(1);
      expect(mine[0]!.description).toBe('teacher item');

      // Admin has no items assigned to them on this meeting
      const adminMine = await withTestTenant(async () =>
        actionService.listMine(adminActor()),
      );
      expect(adminMine.map((i) => i.description)).not.toContain('teacher item');
    });

    it('listMine with status filter narrows results', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'todo' } as any,
          adminActor(),
        ),
      );
      // Set to DONE
      await withTestTenant(async () =>
        actionService.patch(item.id, { status: 'DONE' } as any, teacherActor()),
      );
      const openItems = await withTestTenant(async () =>
        actionService.listMine(teacherActor(), 'OPEN' as any),
      );
      expect(openItems).toHaveLength(0);
      const doneItems = await withTestTenant(async () =>
        actionService.listMine(teacherActor(), 'DONE' as any),
      );
      expect(doneItems).toHaveLength(1);
    });

    it('assignee can patch status; DONE stamps completed_at', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'finish me' } as any,
          adminActor(),
        ),
      );
      const done = await withTestTenant(async () =>
        actionService.patch(item.id, { status: 'DONE' } as any, teacherActor()),
      );
      expect(done.status).toBe('DONE');
      expect(done.completedAt).not.toBeNull();
    });

    it('moving back from DONE to OPEN clears completed_at', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'reopened' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        actionService.patch(item.id, { status: 'DONE' } as any, teacherActor()),
      );
      const reopened = await withTestTenant(async () =>
        actionService.patch(item.id, { status: 'OPEN' } as any, teacherActor()),
      );
      expect(reopened.completedAt).toBeNull();
    });

    it('assignee CANNOT change description (only organiser/admin)', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'orig desc' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          actionService.patch(item.id, { description: 'changed' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-assignee non-organiser cannot patch → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'walled' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          actionService.patch(item.id, { status: 'DONE' } as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          actionService.patch(
            '00000000-0000-0000-0000-000000000000',
            { status: 'DONE' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('admin patch description + dueDate + status in one call', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'origin' } as any,
          adminActor(),
        ),
      );
      const updated = await withTestTenant(async () =>
        actionService.patch(
          item.id,
          {
            description: 'new desc',
            dueDate: '2026-07-15',
            status: 'IN_PROGRESS',
          } as any,
          adminActor(),
        ),
      );
      expect(updated.description).toBe('new desc');
      expect(updated.dueDate).toBe('2026-07-15');
      expect(updated.status).toBe('IN_PROGRESS');
      expect(updated.completedAt).toBeNull();
    });

    it('empty patch is a no-op', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        actionService.create(
          meetingId,
          { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'unchanged' } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () =>
        actionService.patch(item.id, {} as any, adminActor()),
      );
      expect(after.description).toBe('unchanged');
    });

    it('non-organiser non-admin cannot create → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          actionService.create(
            meetingId,
            { assigneeId: TEST_TEACHER_ACCOUNT_ID, description: 'unauthorised' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // AgendaService
  // ────────────────────────────────────────────────────────────────────
  describe('AgendaService', () => {
    it('admin creates agenda item; presenterId validated against tenant', async () => {
      const meetingId = await createMeeting();
      const dto = await withTestTenant(async () =>
        agendaService.create(
          meetingId,
          {
            title: 'Item 1',
            description: 'desc',
            presenterId: TEST_TEACHER_ACCOUNT_ID,
            durationMinutes: 10,
            sortOrder: 0,
            notes: 'inline notes',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Item 1');
      expect(dto.presenterId).toBe(TEST_TEACHER_ACCOUNT_ID);
      expect(dto.durationMinutes).toBe(10);
    });

    it('listForMeeting orders by sort_order', async () => {
      const meetingId = await createMeeting();
      await withTestTenant(async () =>
        agendaService.create(
          meetingId,
          { title: 'C', sortOrder: 2 } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        agendaService.create(
          meetingId,
          { title: 'A', sortOrder: 0 } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () =>
        agendaService.create(
          meetingId,
          { title: 'B', sortOrder: 1 } as any,
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        agendaService.listForMeeting(meetingId, adminActor()),
      );
      expect(list.map((i) => i.title)).toEqual(['A', 'B', 'C']);
    });

    it('non-participant cannot list → NotFoundException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          agendaService.listForMeeting(meetingId, parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patch updates title, description, presenter, duration, sortOrder, notes', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        agendaService.create(
          meetingId,
          { title: 'orig', sortOrder: 0 } as any,
          adminActor(),
        ),
      );
      const updated = await withTestTenant(async () =>
        agendaService.patch(
          item.id,
          {
            title: 'updated',
            description: 'new desc',
            presenterId: TEST_TEACHER_ACCOUNT_ID,
            durationMinutes: 30,
            sortOrder: 5,
            notes: 'fresh notes',
          } as any,
          adminActor(),
        ),
      );
      expect(updated.title).toBe('updated');
      expect(updated.description).toBe('new desc');
      expect(updated.presenterId).toBe(TEST_TEACHER_ACCOUNT_ID);
      expect(updated.durationMinutes).toBe(30);
      expect(updated.sortOrder).toBe(5);
      expect(updated.notes).toBe('fresh notes');
    });

    it('empty patch returns current row', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        agendaService.create(
          meetingId,
          { title: 'stable' } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () =>
        agendaService.patch(item.id, {} as any, adminActor()),
      );
      expect(after.title).toBe('stable');
    });

    it('patch on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          agendaService.patch(
            '00000000-0000-0000-0000-000000000000',
            { title: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-organiser non-admin cannot create → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          agendaService.create(
            meetingId,
            { title: 'unauthorised' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('non-organiser non-admin cannot patch → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        agendaService.create(
          meetingId,
          { title: 'walled' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          agendaService.patch(item.id, { title: 'tampered' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove deletes the item', async () => {
      const meetingId = await createMeeting();
      const item = await withTestTenant(async () =>
        agendaService.create(
          meetingId,
          { title: 'delete me' } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => agendaService.remove(item.id, adminActor()));
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.mtg_agenda_items WHERE id = $1::uuid`,
        item.id,
      );
      expect(rows).toHaveLength(0);
    });

    it('remove on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          agendaService.remove('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('presenterId not in tenant → BadRequestException', async () => {
      const meetingId = await createMeeting();
      // Use a bogus UUID
      await expect(
        withTestTenant(async () =>
          agendaService.create(
            meetingId,
            { title: 'bogus', presenterId: '00000000-0000-0000-0000-000000000099' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toThrow();
    });
  });

  void TEST_ADMIN_ACCOUNT_ID;
});
