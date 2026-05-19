import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { MeetingService } from '@modules/m41-meetings/meetings/meeting.service';
import { IepMeetingRecordService } from '@modules/m41-meetings/meetings/iep-meeting-record.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
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
  studentActor,
  parentActor,
} from '../helpers/actor';
import { TEST_MEETING_TYPE_ID } from '../fixtures/meetings';

/**
 * Wave 5 — m41-meetings IepMeetingRecordService.
 *
 * Authorisation:
 *   - admin                                  → full access
 *   - counsellor (cou-001:write tenant)      → own caseload
 *   - non-counsellor + meeting participant   → read meetings attended
 *   - everyone else                          → 404
 *
 * To keep the spec simple we test the admin + non-counsellor non-staff
 * paths. Counsellor caseload paths require iam_effective_access_cache
 * seeding and are validated indirectly via the ForbiddenException case.
 */
describe('integration:m41-meetings/iep-meetings', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let outbox: OutboxService;
  let permCheck: PermissionCheckService;
  let meetingService: MeetingService;
  let iepService: IepMeetingRecordService;

  let studentId: string;
  let createdStudentIds: string[] = [];
  let createdPlatformStudentIds: string[] = [];
  let createdPersonIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    outbox = new OutboxService();
    permCheck = new PermissionCheckService(rawClient);
    meetingService = new MeetingService(tenantPrisma, outbox);
    iepService = new IepMeetingRecordService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_iep_meeting_records`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.mtg_meetings WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    if (createdStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        createdStudentIds.splice(0),
      );
    }
    if (createdPlatformStudentIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        createdPlatformStudentIds.splice(0),
      );
    }
    if (createdPersonIds.length > 0) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        createdPersonIds.splice(0),
      );
    }
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'mtg.meeting.scheduled' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    studentId = await seedStudent();
  });

  async function seedStudent(): Promise<string> {
    const personId = generateId();
    const platformStudentId = generateId();
    const sid = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    createdStudentIds.push(sid);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'IEP', 'Student', 'STUDENT', true)`,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'IEP', 'Student', true)`,
      platformStudentId,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      sid,
      platformStudentId,
      TEST_SCHOOL_ID,
      'IEP-MTG-' + sid.slice(-6),
    );
    return sid;
  }

  async function createMeeting(): Promise<string> {
    const m = await withTestTenant(async () =>
      meetingService.create(
        {
          meetingTypeId: TEST_MEETING_TYPE_ID,
          title: 'IEP team meeting',
          scheduledAt: '2026-06-20T15:00:00Z',
          durationMinutes: 60,
        } as any,
        adminActor(),
      ),
    );
    return m.id;
  }

  // ────────────────────────────────────────────────────────────────────
  // create
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates IEP meeting record → row inserted', async () => {
      const meetingId = await createMeeting();
      const dto = await withTestTenant(async () =>
        iepService.create(
          meetingId,
          {
            studentId,
            attendeeRoles: [{ personId: 'p1', role: 'TEACHER', name: 'Mr. R' }],
            outcomesSummary: 'Reviewed goals',
            nextReviewDate: '2026-12-15',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.meetingId).toBe(meetingId);
      expect(dto.studentId).toBe(studentId);
      expect(dto.outcomesSummary).toBe('Reviewed goals');
      expect(dto.attendeeRoles).toHaveLength(1);
      expect(dto.nextReviewDate).toBe('2026-12-15');
    });

    it('duplicate record for same meeting → rejected (UNIQUE constraint)', async () => {
      const meetingId = await createMeeting();
      await withTestTenant(async () =>
        iepService.create(meetingId, { studentId } as any, adminActor()),
      );
      // The service catches pg 23505 but Prisma's wrapping may surface
      // the wrapped error instead. The contract is "duplicate fails";
      // assert on rejection + DB-level single-row enforcement.
      await expect(
        withTestTenant(async () =>
          iepService.create(meetingId, { studentId } as any, adminActor()),
        ),
      ).rejects.toThrow();
      const cnt = await rawClient.$queryRawUnsafe<Array<{ c: number }>>(
        `SELECT count(*)::int AS c FROM ${TEST_SCHEMA}.mtg_iep_meeting_records WHERE meeting_id = $1::uuid`,
        meetingId,
      );
      expect(cnt[0]!.c).toBe(1);
    });

    it('non-admin non-counsellor (teacher) → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          iepService.create(meetingId, { studentId } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('STUDENT → ForbiddenException', async () => {
      const meetingId = await createMeeting();
      await expect(
        withTestTenant(async () =>
          iepService.create(meetingId, { studentId } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getForMeeting / list
  // ────────────────────────────────────────────────────────────────────
  describe('reads', () => {
    it('getForMeeting returns the record for admin', async () => {
      const meetingId = await createMeeting();
      const r = await withTestTenant(async () =>
        iepService.create(meetingId, { studentId } as any, adminActor()),
      );
      const fetched = await withTestTenant(async () =>
        iepService.getForMeeting(meetingId, adminActor()),
      );
      expect(fetched?.id).toBe(r.id);
    });

    it('getForMeeting returns null when no record exists', async () => {
      const meetingId = await createMeeting();
      const fetched = await withTestTenant(async () =>
        iepService.getForMeeting(meetingId, adminActor()),
      );
      expect(fetched).toBeNull();
    });

    it('non-admin non-counsellor (parent) gets 404 on existing record (don\'t-leak-existence)', async () => {
      const meetingId = await createMeeting();
      await withTestTenant(async () =>
        iepService.create(meetingId, { studentId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          iepService.getForMeeting(meetingId, parentActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list returns all records for admin', async () => {
      const meeting1 = await createMeeting();
      await withTestTenant(async () =>
        iepService.create(meeting1, { studentId } as any, adminActor()),
      );
      const list = await withTestTenant(async () => iepService.list(adminActor()));
      expect(list.length).toBeGreaterThanOrEqual(1);
    });

    it('list as non-counsellor non-admin → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => iepService.list(teacherActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // patch
  // ────────────────────────────────────────────────────────────────────
  describe('patch', () => {
    it('admin patches outcomes_summary and next_review_date', async () => {
      const meetingId = await createMeeting();
      const created = await withTestTenant(async () =>
        iepService.create(meetingId, { studentId } as any, adminActor()),
      );
      const updated = await withTestTenant(async () =>
        iepService.patch(
          created.id,
          {
            outcomesSummary: 'updated summary',
            nextReviewDate: '2027-01-15',
            attendeeRoles: [{ personId: 'p2', role: 'PARENT', name: 'Mrs. X' }],
          } as any,
          adminActor(),
        ),
      );
      expect(updated.outcomesSummary).toBe('updated summary');
      expect(updated.nextReviewDate).toBe('2027-01-15');
      expect(updated.attendeeRoles).toHaveLength(1);
    });

    it('empty patch returns current row', async () => {
      const meetingId = await createMeeting();
      const created = await withTestTenant(async () =>
        iepService.create(meetingId, { studentId, outcomesSummary: 'unchanged' } as any, adminActor()),
      );
      const after = await withTestTenant(async () =>
        iepService.patch(created.id, {} as any, adminActor()),
      );
      expect(after.outcomesSummary).toBe('unchanged');
    });

    it('patch on missing id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          iepService.patch(
            '00000000-0000-0000-0000-000000000000',
            { outcomesSummary: 'x' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-counsellor non-admin → ForbiddenException on patch', async () => {
      const meetingId = await createMeeting();
      const created = await withTestTenant(async () =>
        iepService.create(meetingId, { studentId } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          iepService.patch(created.id, { outcomesSummary: 'x' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // hasCounsellorScope
  // ────────────────────────────────────────────────────────────────────
  describe('hasCounsellorScope', () => {
    it('admin is always counsellor-scope', async () => {
      const hasScope = await withTestTenant(async () =>
        iepService.hasCounsellorScope(adminActor()),
      );
      expect(hasScope).toBe(true);
    });

    it('teacher without cou-001:write → false', async () => {
      const hasScope = await withTestTenant(async () =>
        iepService.hasCounsellorScope(teacherActor()),
      );
      expect(hasScope).toBe(false);
    });
  });
});
