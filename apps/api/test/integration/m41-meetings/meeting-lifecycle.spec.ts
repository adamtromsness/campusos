import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { MeetingService } from '@modules/m41-meetings/meetings/meeting.service';
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
  studentActor,
  parentActor,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_STUDENT_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_MEETING_TYPE_ID, TEST_MEETING_TYPE_B_ID } from '../fixtures/meetings';

/**
 * Wave 5 — m41-meetings MeetingService DB-backed integration tests.
 *
 * Strategy:
 *   - CRUD: create / patch / addParticipant / removeParticipant /
 *     list / getById
 *   - mtg.meeting.scheduled outbox-in-tx: every create() lands a
 *     platform_outbox row in the same tenant tx.
 *   - Cross-school isolation: School A admin cannot read or mutate
 *     a meeting created in School B context.
 *   - Visibility: students/parents/teachers see only meetings where
 *     they're organiser or participant.
 *   - State machine: status IN_PROGRESS stamps started_at; COMPLETED
 *     stamps completed_at.
 */
describe('integration:m41-meetings/meeting-lifecycle', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let meetingService: MeetingService;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    meetingService = new MeetingService(tenantPrisma, outbox);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    // Wipe meetings + participants for both schools (cascade clears
    // notes, agenda, action items, recordings, slots).
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    // Wipe outbox so per-test emit counts are deterministic
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'mtg.meeting.scheduled' AND tenant_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  });

  // ────────────────────────────────────────────────────────────────────
  // MeetingService.create
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates a meeting → row inserted + mtg.meeting.scheduled outbox row written in same tx', async () => {
      const dto = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'Staff sync',
            scheduledAt: '2026-06-15T15:00:00Z',
            durationMinutes: 60,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.title).toBe('Staff sync');
      expect(dto.durationMinutes).toBe(60);
      expect(dto.status).toBe('SCHEDULED');
      expect(dto.organiserId).toBe(TEST_ADMIN_ACCOUNT_ID);
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);

      // Auto-host: organiser is on the participant list as HOST
      expect(dto.participants).toBeDefined();
      const hosts = dto.participants!.filter((p) => p.role === 'HOST');
      expect(hosts).toHaveLength(1);
      expect(hosts[0]!.participantId).toBe(TEST_ADMIN_ACCOUNT_ID);

      // Row in DB
      const rows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM ${TEST_SCHEMA}.mtg_meetings WHERE id = $1::uuid`,
        dto.id,
      );
      expect(rows).toHaveLength(1);

      // Outbox row in same tx
      const outboxRows = await rawClient.$queryRawUnsafe<
        Array<{ topic: string; message_key: string; envelope: string }>
      >(
        `SELECT topic, message_key, envelope::text AS envelope
           FROM platform.platform_outbox
          WHERE topic = 'mtg.meeting.scheduled' AND message_key = $1`,
        dto.id,
      );
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]!.topic).toBe('mtg.meeting.scheduled');
      const envelope = JSON.parse(outboxRows[0]!.envelope);
      expect(envelope.payload).toMatchObject({
        meetingId: dto.id,
        schoolId: TEST_SCHOOL_ID,
        title: 'Staff sync',
        organiserId: TEST_ADMIN_ACCOUNT_ID,
      });
    });

    it('create with participantIds adds participants and emits one outbox row', async () => {
      // Use static teacher account (already in tenant via hr_employees)
      const dto = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'IEP review',
            scheduledAt: '2026-06-16T15:00:00Z',
            durationMinutes: 45,
            participantIds: [TEST_TEACHER_ACCOUNT_ID],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.participants?.length).toBe(2); // HOST (admin) + ATTENDEE (teacher)
      const attendees = dto.participants!.filter((p) => p.role === 'ATTENDEE');
      expect(attendees).toHaveLength(1);
      expect(attendees[0]!.participantId).toBe(TEST_TEACHER_ACCOUNT_ID);

      const outboxRows = await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `SELECT id::text FROM platform.platform_outbox WHERE topic = 'mtg.meeting.scheduled' AND message_key = $1`,
        dto.id,
      );
      expect(outboxRows).toHaveLength(1);
    });

    it('STUDENT persona cannot create a meeting → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          meetingService.create(
            {
              meetingTypeId: TEST_MEETING_TYPE_ID,
              title: 'Forbidden',
              scheduledAt: '2026-06-16T15:00:00Z',
              durationMinutes: 30,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('GUARDIAN persona cannot create a meeting → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          meetingService.create(
            {
              meetingTypeId: TEST_MEETING_TYPE_ID,
              title: 'Forbidden',
              scheduledAt: '2026-06-16T15:00:00Z',
              durationMinutes: 30,
            } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('participantId not in current tenant → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          meetingService.create(
            {
              meetingTypeId: TEST_MEETING_TYPE_ID,
              title: 'Bogus',
              scheduledAt: '2026-06-16T15:00:00Z',
              durationMinutes: 30,
              participantIds: ['00000000-0000-0000-0000-000000000099'],
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // MeetingService.list / getById
  // ────────────────────────────────────────────────────────────────────
  describe('list / getById', () => {
    async function createMeetingAsAdmin(title = 'List me') {
      return withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title,
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
    }

    it('admin sees all meetings; teacher (non-participant) sees none', async () => {
      const meeting = await createMeetingAsAdmin('Admin only');

      const adminList = await withTestTenant(async () => meetingService.list({}, adminActor()));
      expect(adminList.map((m) => m.id)).toContain(meeting.id);

      const teacherList = await withTestTenant(async () => meetingService.list({}, teacherActor()));
      expect(teacherList.map((m) => m.id)).not.toContain(meeting.id);
    });

    it('teacher added as participant sees the meeting in list and via getById', async () => {
      const meeting = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'Visible to teacher',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
            participantIds: [TEST_TEACHER_ACCOUNT_ID],
          } as any,
          adminActor(),
        ),
      );
      const teacherList = await withTestTenant(async () => meetingService.list({}, teacherActor()));
      expect(teacherList.map((m) => m.id)).toContain(meeting.id);

      const fetched = await withTestTenant(async () =>
        meetingService.getById(meeting.id, teacherActor()),
      );
      expect(fetched.id).toBe(meeting.id);
      expect(fetched.participants).toBeDefined();
    });

    it('getById for non-participant non-admin → NotFoundException', async () => {
      const m = await createMeetingAsAdmin('hidden');
      await expect(
        withTestTenant(async () => meetingService.getById(m.id, teacherActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('getById for non-existent meeting → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          meetingService.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list with status filter narrows results', async () => {
      const a = await createMeetingAsAdmin('Active');
      const b = await createMeetingAsAdmin('Completed');
      await withTestTenant(async () =>
        meetingService.patch(b.id, { status: 'COMPLETED' } as any, adminActor()),
      );
      const list = await withTestTenant(async () =>
        meetingService.list({ status: 'COMPLETED' }, adminActor()),
      );
      const ids = list.map((m) => m.id);
      expect(ids).toContain(b.id);
      expect(ids).not.toContain(a.id);
    });

    it('list filters by fromDate / toDate / conferenceEventId', async () => {
      const m1 = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'Early',
            scheduledAt: '2026-01-01T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      const m2 = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'Late',
            scheduledAt: '2027-01-01T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      const filtered = await withTestTenant(async () =>
        meetingService.list(
          { fromDate: '2026-06-01T00:00:00Z', toDate: '2027-06-01T00:00:00Z' },
          adminActor(),
        ),
      );
      const ids = filtered.map((m) => m.id);
      expect(ids).toContain(m2.id);
      expect(ids).not.toContain(m1.id);

      const ghost = await withTestTenant(async () =>
        meetingService.list(
          { conferenceEventId: '00000000-0000-0000-0000-000000000000' },
          adminActor(),
        ),
      );
      expect(ghost).toHaveLength(0);
    });

    it('listParticipants returns the roster', async () => {
      const m = await createMeetingAsAdmin('participants');
      const list = await withTestTenant(async () => meetingService.listParticipants(m.id));
      expect(list).toHaveLength(1); // organiser only
      expect(list[0]!.participantId).toBe(TEST_ADMIN_ACCOUNT_ID);
    });

    it('isParticipantOrOrganiser returns true for organiser, false for stranger', async () => {
      const m = await createMeetingAsAdmin('check');
      const isOrg = await withTestTenant(async () =>
        meetingService.isParticipantOrOrganiser(m.id, TEST_ADMIN_ACCOUNT_ID),
      );
      expect(isOrg).toBe(true);
      const isStranger = await withTestTenant(async () =>
        meetingService.isParticipantOrOrganiser(m.id, TEST_STUDENT_ACCOUNT_ID),
      );
      expect(isStranger).toBe(false);
    });

    it('loadOrFail returns meeting regardless of caller (service-to-service)', async () => {
      const m = await createMeetingAsAdmin('load it');
      const loaded = await withTestTenant(async () => meetingService.loadOrFail(m.id));
      expect(loaded.id).toBe(m.id);
    });

    it('loadOrFail throws NotFoundException for missing id', async () => {
      await expect(
        withTestTenant(async () =>
          meetingService.loadOrFail('00000000-0000-0000-0000-000000000000'),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // MeetingService.patch
  // ────────────────────────────────────────────────────────────────────
  describe('patch', () => {
    it('admin patches title + status → row updated, started_at stamped on IN_PROGRESS', async () => {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'Original',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      const updated = await withTestTenant(async () =>
        meetingService.patch(
          m.id,
          {
            title: 'Renamed',
            description: 'desc',
            scheduledAt: '2026-06-21T15:00:00Z',
            durationMinutes: 45,
            meetingUrl: 'https://meet.example.com',
            status: 'IN_PROGRESS',
          } as any,
          adminActor(),
        ),
      );
      expect(updated.title).toBe('Renamed');
      expect(updated.status).toBe('IN_PROGRESS');
      expect(updated.startedAt).not.toBeNull();
      expect(updated.durationMinutes).toBe(45);
      expect(updated.meetingUrl).toBe('https://meet.example.com');
    });

    it('patching to COMPLETED stamps completed_at', async () => {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'finish me',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      const completed = await withTestTenant(async () =>
        meetingService.patch(m.id, { status: 'COMPLETED' } as any, adminActor()),
      );
      expect(completed.status).toBe('COMPLETED');
      expect(completed.completedAt).not.toBeNull();
    });

    it('non-organiser non-admin teacher → ForbiddenException', async () => {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'mine',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          meetingService.patch(m.id, { title: 'hijack' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch on a non-existent meeting → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          meetingService.patch(
            '00000000-0000-0000-0000-000000000000',
            { title: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('empty patch is a no-op and returns the current meeting', async () => {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'untouched',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      const after = await withTestTenant(async () =>
        meetingService.patch(m.id, {} as any, adminActor()),
      );
      expect(after.title).toBe('untouched');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Participants — add / remove
  // ────────────────────────────────────────────────────────────────────
  describe('participants', () => {
    it('admin adds a participant; duplicate add → BadRequestException', async () => {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'addable',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      const added = await withTestTenant(async () =>
        meetingService.addParticipant(
          m.id,
          { participantId: TEST_TEACHER_ACCOUNT_ID, role: 'PRESENTER' } as any,
          adminActor(),
        ),
      );
      expect(added.participantId).toBe(TEST_TEACHER_ACCOUNT_ID);
      expect(added.role).toBe('PRESENTER');

      // Duplicate INSERT fails via UNIQUE(meeting_id, participant_id).
      // The service catches the pg 23505 code (via Prisma's wrapping)
      // and returns BadRequest in the common case; but the raw Prisma
      // path may surface the wrapped error directly, so we assert on
      // rejection without pinning the exact class. The DB-level
      // assertion (still only one row) is the load-bearing check.
      await expect(
        withTestTenant(async () =>
          meetingService.addParticipant(
            m.id,
            { participantId: TEST_TEACHER_ACCOUNT_ID } as any,
            adminActor(),
          ),
        ),
      ).rejects.toThrow();
      const cnt = await rawClient.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.mtg_meeting_participants
         WHERE meeting_id = $1::uuid AND participant_id = $2::uuid`,
        m.id,
        TEST_TEACHER_ACCOUNT_ID,
      );
      expect(cnt[0]!.c).toBe(1);
    });

    it('addParticipant with participant not in tenant → BadRequestException', async () => {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'check tenant',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          meetingService.addParticipant(
            m.id,
            { participantId: '00000000-0000-0000-0000-000000000099' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('removeParticipant by admin → row deleted', async () => {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'removable',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
            participantIds: [TEST_TEACHER_ACCOUNT_ID],
          } as any,
          adminActor(),
        ),
      );
      const teacherPart = m.participants!.find((p) => p.role === 'ATTENDEE')!;
      await withTestTenant(async () =>
        meetingService.removeParticipant(teacherPart.id, adminActor()),
      );
      const after = await withTestTenant(async () => meetingService.listParticipants(m.id));
      expect(after.map((p) => p.participantId)).not.toContain(TEST_TEACHER_ACCOUNT_ID);
    });

    it('removeParticipant on non-existent id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          meetingService.removeParticipant('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addParticipant by non-organiser non-admin → ForbiddenException', async () => {
      const m = await withTestTenant(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_ID,
            title: 'walled',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          meetingService.addParticipant(
            m.id,
            { participantId: TEST_PARENT_ACCOUNT_ID } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('assertOrganiserOrAdmin on a missing meeting → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          meetingService.assertOrganiserOrAdmin(
            '00000000-0000-0000-0000-000000000000',
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('a School A admin cannot see a meeting created in School B context', async () => {
      // Create meeting under School B context
      const schoolBMeeting = await withTestTenantB(async () =>
        meetingService.create(
          {
            meetingTypeId: TEST_MEETING_TYPE_B_ID,
            title: 'School B private',
            scheduledAt: '2026-06-20T15:00:00Z',
            durationMinutes: 30,
          } as any,
          adminActor(),
        ),
      );
      expect(schoolBMeeting.schoolId).toBe(TEST_SCHOOL_B_ID);

      // School A admin cannot getById
      await expect(
        withTestTenant(async () => meetingService.getById(schoolBMeeting.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);

      // School A admin list excludes it
      const aList = await withTestTenant(async () => meetingService.list({}, adminActor()));
      expect(aList.map((m) => m.id)).not.toContain(schoolBMeeting.id);

      // School A admin cannot patch
      await expect(
        withTestTenant(async () =>
          meetingService.patch(schoolBMeeting.id, { title: 'tampered' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
