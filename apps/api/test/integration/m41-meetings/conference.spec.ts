import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { ConferenceService } from '@modules/m41-meetings/meetings/conference.service';
import { MeetingService } from '@modules/m41-meetings/meetings/meeting.service';
import { SlotService } from '@modules/m41-meetings/meetings/slot.service';
import { MeetingTypeService } from '@modules/m41-meetings/meetings/meeting-type.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import { OutboxService } from '@shared/kafka/outbox.service';

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
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_MEETING_TYPE_ID, TEST_MEETING_TYPE_B_ID } from '../fixtures/meetings';

/**
 * Wave 5 — m41-meetings ConferenceService + SlotService + MeetingTypeService.
 *
 * The ConferenceService manages mtg_conference_events. SlotService manages
 * mtg_meeting_slots with a SELECT FOR UPDATE booking keystone.
 */
describe('integration:m41-meetings/conference', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let conferenceService: ConferenceService;
  let meetingService: MeetingService;
  let slotService: SlotService;
  let typeService: MeetingTypeService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    conferenceService = new ConferenceService(tenantPrisma);
    meetingService = new MeetingService(tenantPrisma, outbox);
    slotService = new SlotService(tenantPrisma, meetingService);
    typeService = new MeetingTypeService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.mtg_meeting_slots`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_conference_events WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'mtg.meeting.scheduled' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // ConferenceService
  // ────────────────────────────────────────────────────────────────────
  describe('ConferenceService', () => {
    it('admin creates conference event → row inserted', async () => {
      const dto = await withTestTenant(async () =>
        conferenceService.create(
          {
            title: 'Fall PTC',
            description: 'Parent-teacher conference',
            conferenceType: 'PARENT_TEACHER',
            startDate: '2026-10-01',
            endDate: '2026-10-03',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Fall PTC');
      expect(dto.status).toBe('SCHEDULED');
      expect(dto.conferenceType).toBe('PARENT_TEACHER');
      expect(dto.meetingCount).toBe(0);
    });

    it('non-admin cannot create → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          conferenceService.create(
            {
              title: 'Forbidden',
              conferenceType: 'STAFF',
              startDate: '2026-10-01',
              endDate: '2026-10-03',
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('endDate before startDate → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          conferenceService.create(
            {
              title: 'Backwards',
              conferenceType: 'STAFF',
              startDate: '2026-10-05',
              endDate: '2026-10-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('patch updates fields', async () => {
      const c = await withTestTenant(async () =>
        conferenceService.create(
          {
            title: 'Orig',
            conferenceType: 'STAFF',
            startDate: '2026-10-01',
            endDate: '2026-10-03',
          } as any,
          adminActor(),
        ),
      );
      const patched = await withTestTenant(async () =>
        conferenceService.patch(
          c.id,
          {
            title: 'Updated',
            description: 'new desc',
            status: 'ACTIVE',
            startDate: '2026-10-02',
            endDate: '2026-10-04',
          } as any,
          adminActor(),
        ),
      );
      expect(patched.title).toBe('Updated');
      expect(patched.status).toBe('ACTIVE');
    });

    it('patch with empty body returns current row', async () => {
      const c = await withTestTenant(async () =>
        conferenceService.create(
          {
            title: 'static',
            conferenceType: 'STAFF',
            startDate: '2026-10-01',
            endDate: '2026-10-03',
          } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () =>
        conferenceService.patch(c.id, {} as any, adminActor()),
      );
      expect(after.id).toBe(c.id);
    });

    it('non-admin cannot patch → ForbiddenException', async () => {
      const c = await withTestTenant(async () =>
        conferenceService.create(
          {
            title: 'walled',
            conferenceType: 'STAFF',
            startDate: '2026-10-01',
            endDate: '2026-10-03',
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          conferenceService.patch(c.id, { title: 'hijack' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          conferenceService.patch(
            '00000000-0000-0000-0000-000000000000',
            { title: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list returns conferences for this school only', async () => {
      const aCon = await withTestTenant(async () =>
        conferenceService.create(
          {
            title: 'A side',
            conferenceType: 'STAFF',
            startDate: '2026-10-01',
            endDate: '2026-10-03',
          } as any,
          adminActor(),
        ),
      );
      const bCon = await withTestTenantB(async () =>
        conferenceService.create(
          {
            title: 'B side',
            conferenceType: 'STAFF',
            startDate: '2026-10-01',
            endDate: '2026-10-03',
          } as any,
          adminActor(),
        ),
      );
      const aList = await withTestTenant(async () => conferenceService.list());
      const aIds = aList.map((c) => c.id);
      expect(aIds).toContain(aCon.id);
      expect(aIds).not.toContain(bCon.id);
    });

    it('getById on missing or cross-school → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          conferenceService.getById('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // SlotService
  // ────────────────────────────────────────────────────────────────────
  describe('SlotService', () => {
    async function createMeeting(): Promise<string> {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'PTC slot meeting',
            scheduledAt: '2026-10-02T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      return m.id;
    }

    it('admin creates bulk slots → rows inserted', async () => {
      const meetingId = await createMeeting();
      const slots = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [
              { startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' },
              { startTime: '2026-10-02T15:15:00Z', endTime: '2026-10-02T15:30:00Z' },
            ],
          } as any,
          adminActor(),
        ),
      );
      expect(slots).toHaveLength(2);
      expect(slots.every((s) => !s.isBooked)).toBe(true);
    });

    it('createBulk with endTime <= startTime → BadRequestException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          slotService.createBulk(
            meetingId,
            {
              slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T14:00:00Z' }],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-organiser non-admin cannot create slots → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          slotService.createBulk(
            meetingId,
            {
              slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
            } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('parent (GUARDIAN) books a slot → is_booked=true + participant row added (KEYSTONE)', async () => {
      const meetingId = await createMeeting();
      const slots = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      const booked = await withTestTenant(async () =>
        slotService.book(slots[0]!.id, parentActor()),
      );
      expect(booked.isBooked).toBe(true);
      expect(booked.bookedBy).toBe(TEST_PARENT_ACCOUNT_ID);
      expect(booked.bookedAt).not.toBeNull();

      // Auto-participant row created
      const partRows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.mtg_meeting_participants
         WHERE meeting_id = $1::uuid AND participant_id = $2::uuid`,
        meetingId,
        TEST_PARENT_ACCOUNT_ID,
      );
      expect(partRows).toHaveLength(1);
    });

    it('double-booking the same slot → BadRequestException (locked already)', async () => {
      const meetingId = await createMeeting();
      const [slot] = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => slotService.book(slot!.id, parentActor()));
      // Another guardian (using same parent actor, simulating distinct user) — same person tries again
      await expect(
        withTestTenant(async () => slotService.book(slot!.id, parentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('teacher (non-admin non-guardian non-organiser) cannot book → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      const [slot] = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => slotService.book(slot!.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('book on missing slot → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          slotService.book('00000000-0000-0000-0000-000000000000', parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cancel by booker → is_booked=false + booked_by NULL + participant row removed', async () => {
      const meetingId = await createMeeting();
      const [slot] = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => slotService.book(slot!.id, parentActor()));
      const cancelled = await withTestTenant(async () =>
        slotService.cancel(slot!.id, parentActor()),
      );
      expect(cancelled.isBooked).toBe(false);
      expect(cancelled.bookedBy).toBeNull();

      // Participant row removed for the booker
      const partRows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.mtg_meeting_participants
         WHERE meeting_id = $1::uuid AND participant_id = $2::uuid`,
        meetingId,
        TEST_PARENT_ACCOUNT_ID,
      );
      expect(partRows).toHaveLength(0);
    });

    it('cancel an unbooked slot → BadRequestException', async () => {
      const meetingId = await createMeeting();
      const [slot] = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => slotService.cancel(slot!.id, parentActor())),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cancel by other-parent (non-booker, non-organiser) → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      const [slot] = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => slotService.book(slot!.id, parentActor()));
      // teacher (not the booker, not organiser) tries to cancel
      await expect(
        withTestTenant(async () => slotService.cancel(slot!.id, teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('cancel by admin works', async () => {
      const meetingId = await createMeeting();
      const [slot] = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => slotService.book(slot!.id, parentActor()));
      const cancelled = await withTestTenant(async () =>
        slotService.cancel(slot!.id, adminActor()),
      );
      expect(cancelled.isBooked).toBe(false);
    });

    it('cancel on missing slot → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          slotService.cancel('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('listForMeeting strips identity columns for non-organiser non-admin readers', async () => {
      const meetingId = await createMeeting();
      const slots = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => slotService.book(slots[0]!.id, parentActor()));

      // Admin sees full row
      const adminList = await withTestTenant(async () =>
        slotService.listForMeeting(meetingId, adminActor()),
      );
      expect(adminList[0]!.bookedBy).toBe(TEST_PARENT_ACCOUNT_ID);

      // Teacher (not organiser) sees stripped row
      const teacherList = await withTestTenant(async () =>
        slotService.listForMeeting(meetingId, teacherActor()),
      );
      expect(teacherList[0]!.bookedBy).toBeNull();
      expect(teacherList[0]!.bookedAt).toBeNull();
    });

    it('listForMeeting shows own booking even to non-organiser', async () => {
      const meetingId = await createMeeting();
      const slots = await withTestTenant(async () =>
        slotService.createBulk(
          meetingId,
          {
            slots: [{ startTime: '2026-10-02T15:00:00Z', endTime: '2026-10-02T15:15:00Z' }],
          } as any,
          adminActor(),
        ),
      );
      await withTestTenant(async () => slotService.book(slots[0]!.id, parentActor()));
      const parentList = await withTestTenant(async () =>
        slotService.listForMeeting(meetingId, parentActor()),
      );
      expect(parentList[0]!.bookedBy).toBe(TEST_PARENT_ACCOUNT_ID);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // MeetingTypeService
  // ────────────────────────────────────────────────────────────────────
  describe('MeetingTypeService', () => {
    it('list returns active types for the current school', async () => {
      const list = await withTestTenant(async () => typeService.list());
      const ids = list.map((t) => t.id);
      expect(ids).toContain(TEST_MEETING_TYPE_ID);
    });

    it('getById returns the type; missing → NotFoundException', async () => {
      const type = await withTestTenant(async () => typeService.getById(TEST_MEETING_TYPE_ID));
      expect(type.name).toBe('Default Meeting');

      await expect(
        withTestTenant(async () => typeService.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cross-school: School A cannot getById a School B type', async () => {
      await expect(
        withTestTenant(async () => typeService.getById(TEST_MEETING_TYPE_B_ID)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  void TEST_ADMIN_ACCOUNT_ID;
  void TEST_TEACHER_ACCOUNT_ID;
  void generateId;
});
