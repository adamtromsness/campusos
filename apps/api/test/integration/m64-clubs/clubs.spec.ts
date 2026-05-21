import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { ActivityService } from '@modules/m64-clubs/activities/activity.service';
import { ScheduleService } from '@modules/m64-clubs/activities/schedule.service';
import { ServiceProgrammeService } from '@modules/m64-clubs/activities/service-programme.service';
import { ServiceHourService } from '@modules/m64-clubs/activities/service-hour.service';
import { MembershipService } from '@modules/m64-clubs/clubs/membership.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import {
  withTestTenant,
  withTestTenantB,
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
} from '../helpers/tenant-context';
import { adminActor, teacherActor, studentActor, parentActor } from '../helpers/actor';
import { seedStudent } from '../m20-sis/sis-helpers';
import {
  resetClubsAndStudents,
  ensureClubsSeed,
  TEST_ACTIVITY_TYPE_SPORT_ID,
  TEST_ACTIVITY_TYPE_ARTS_ID,
  TEST_ACTIVITY_TYPE_B_SPORT_ID,
  TEST_ACTIVITY_A_ID,
  TEST_ACTIVITY_B_ID,
  TEST_PROGRAMME_A_ID,
  TEST_PROGRAMME_B_ID,
} from '../fixtures/clubs';
import { TEST_SIS_ACADEMIC_YEAR_ID, TEST_SIS_ACADEMIC_YEAR_B_ID } from '../fixtures/sis';

/**
 * Wave 7 — m64-clubs core suite. Covers ActivityService (types,
 * activities CRUD, advisor row-scope), MembershipService (student
 * self-registration KEYSTONE + staff-added members + max-cap + UNIQUE),
 * ScheduleService (validation + advisor row-scope), ServiceProgrammeService
 * (leaderboard staff-only gate), ServiceHourService (STUDENT-INPUT
 * keystone + review + progress recompute). Cross-school isolation
 * exercised at each surface.
 */
describe('integration:m64-clubs/clubs', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let activities: ActivityService;
  let schedules: ScheduleService;
  let memberships: MembershipService;
  let programmes: ServiceProgrammeService;
  let hours: ServiceHourService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    activities = new ActivityService(tenantPrisma);
    schedules = new ScheduleService(tenantPrisma, activities);
    memberships = new MembershipService(tenantPrisma, activities);
    programmes = new ServiceProgrammeService(tenantPrisma);
    hours = new ServiceHourService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetClubsAndStudents(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
    await ensureClubsSeed(rawClient);
  });

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /**
   * Link a SIS student row to a stable platform person — used so the
   * student/parent actors can be resolved by service-side
   * platform_students bridge lookups.
   */
  async function linkStudentToPerson(personId: string): Promise<string> {
    // Make sure there is a platform_students row + sis_students row
    // pointing at the supplied personId. Reuses an existing row if
    // one was created in a prior test (so re-running idempotent).
    const platformStudentId = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
      personId,
    )) as Array<{ id: string }>;
    let psId: string;
    if (platformStudentId.length > 0) {
      psId = platformStudentId[0]!.id;
    } else {
      psId = await rawClient
        .$queryRawUnsafe<Array<{ id: string }>>(
          `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
           VALUES (gen_random_uuid(), $1::uuid, 'Linked', 'Student', true)
           RETURNING id::text AS id`,
          personId,
        )
        .then((rows) => (rows as Array<{ id: string }>)[0]!.id);
      platformStudentIds.push(psId);
    }
    const existing = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid LIMIT 1`,
      psId,
    )) as Array<{ id: string }>;
    if (existing.length > 0) return existing[0]!.id;
    const stuRows = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, '5', 'ENROLLED')
       RETURNING id::text AS id`,
      psId,
      TEST_SCHOOL_ID,
      'LINK-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    )) as Array<{ id: string }>;
    const newId = stuRows[0]!.id;
    studentIds.push(newId);
    return newId;
  }

  // ─────────────────────────────────────────────────────────────────
  // ActivityService.listTypes / createType
  // ─────────────────────────────────────────────────────────────────
  describe('ActivityService — types', () => {
    it('listTypes returns school A types only', async () => {
      const list = await withTestTenant(async () => activities.listTypes());
      const ids = list.map((t) => t.id);
      expect(ids).toContain(TEST_ACTIVITY_TYPE_SPORT_ID);
      expect(ids).toContain(TEST_ACTIVITY_TYPE_ARTS_ID);
      expect(ids).not.toContain(TEST_ACTIVITY_TYPE_B_SPORT_ID);
    });

    it('listTypes with includeInactive=true still scopes to school', async () => {
      // Deactivate one
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ext_activity_types SET is_active = false WHERE id = $1::uuid`,
        TEST_ACTIVITY_TYPE_ARTS_ID,
      );
      const all = await withTestTenant(async () => activities.listTypes(true));
      const active = await withTestTenant(async () => activities.listTypes(false));
      expect(all.map((t) => t.id)).toContain(TEST_ACTIVITY_TYPE_ARTS_ID);
      expect(active.map((t) => t.id)).not.toContain(TEST_ACTIVITY_TYPE_ARTS_ID);
    });

    it('cross-school: School B activity types not visible from School A', async () => {
      const list = await withTestTenant(async () => activities.listTypes());
      expect(list.map((t) => t.id)).not.toContain(TEST_ACTIVITY_TYPE_B_SPORT_ID);

      const fromB = await withTestTenantB(async () => activities.listTypes());
      expect(fromB.map((t) => t.id)).toContain(TEST_ACTIVITY_TYPE_B_SPORT_ID);
      expect(fromB.map((t) => t.id)).not.toContain(TEST_ACTIVITY_TYPE_SPORT_ID);
    });

    it('createType: admin succeeds', async () => {
      const dto = await withTestTenant(async () =>
        activities.createType({ name: 'Robotics', category: 'ACADEMIC' } as any, adminActor()),
      );
      expect(dto.name).toBe('Robotics');
      expect(dto.schoolId).toBe(TEST_SCHOOL_ID);
    });

    it('createType: duplicate name same school → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          activities.createType({ name: 'Soccer', category: 'SPORT' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('createType: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          activities.createType({ name: 'X', category: 'OTHER' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ActivityService.list / getById / create / patch
  // ─────────────────────────────────────────────────────────────────
  describe('ActivityService — activities', () => {
    it('list returns school A activities with filters', async () => {
      const all = await withTestTenant(async () => activities.list({}));
      expect(all.map((a) => a.id)).toContain(TEST_ACTIVITY_A_ID);
      // School B not visible
      expect(all.map((a) => a.id)).not.toContain(TEST_ACTIVITY_B_ID);

      const filtered = await withTestTenant(async () =>
        activities.list({
          category: 'SPORT',
          status: 'ACTIVE',
          academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
        }),
      );
      expect(filtered.map((a) => a.id)).toContain(TEST_ACTIVITY_A_ID);
    });

    it('getById returns activity with empty members/schedule', async () => {
      const dto = await withTestTenant(async () => activities.getById(TEST_ACTIVITY_A_ID));
      expect(dto.id).toBe(TEST_ACTIVITY_A_ID);
      expect(dto.members).toEqual([]);
      expect(dto.schedule).toEqual([]);
    });

    it('getById missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => activities.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create: admin creates new activity', async () => {
      const dto = await withTestTenant(async () =>
        activities.create(
          {
            activityTypeId: TEST_ACTIVITY_TYPE_ARTS_ID,
            name: 'New Drama',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            maxParticipants: 5,
            meetingLocation: 'Theatre',
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('New Drama');
      expect(dto.maxParticipants).toBe(5);
    });

    it('create: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          activities.create(
            {
              activityTypeId: TEST_ACTIVITY_TYPE_ARTS_ID,
              name: 'X',
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: admin updates name + status', async () => {
      const dto = await withTestTenant(async () =>
        activities.patch(
          TEST_ACTIVITY_A_ID,
          {
            name: 'Renamed Soccer',
            status: 'INACTIVE',
            description: 'Updated',
            meetingLocation: 'Gym B',
            maxParticipants: 25,
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('Renamed Soccer');
      expect(dto.status).toBe('INACTIVE');
    });

    it('patch: no-op update returns getById', async () => {
      const dto = await withTestTenant(async () =>
        activities.patch(TEST_ACTIVITY_A_ID, {} as any, adminActor()),
      );
      expect(dto.id).toBe(TEST_ACTIVITY_A_ID);
    });

    it('patch: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          activities.patch(TEST_ACTIVITY_A_ID, { name: 'X' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: non-admin staff who is NOT advisor → ForbiddenException (BLOCKING 1)', async () => {
      // teacherActor.employeeId is not the advisor of TEST_ACTIVITY_A_ID
      await expect(
        withTestTenant(async () =>
          activities.patch(TEST_ACTIVITY_A_ID, { name: 'X' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: missing activity → NotFoundException via assertCanManageActivity', async () => {
      // teacherActor not advisor, but activity not found — for non-admin, the
      // lookup raises NotFound before the ownership check.
      await expect(
        withTestTenant(async () =>
          activities.patch(
            '00000000-0000-0000-0000-000000000000',
            { name: 'X' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('assertCanManageActivity: staff with no employeeId → ForbiddenException', async () => {
      const ghostStaff: any = {
        accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        personId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: false,
      };
      await expect(
        withTestTenant(async () =>
          activities.assertCanManageActivity(TEST_ACTIVITY_A_ID, ghostStaff),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // MembershipService — joinAsStudent / addMember / patchMember
  // ─────────────────────────────────────────────────────────────────
  describe('MembershipService', () => {
    it('joinAsStudent: STUDENT keystone — student self-registers', async () => {
      const studentId = await linkStudentToPerson(studentActor().personId!);
      const member = await withTestTenant(async () =>
        memberships.joinAsStudent(TEST_ACTIVITY_A_ID, { role: 'MEMBER' } as any, studentActor()),
      );
      expect(member.studentId).toBe(studentId);
      expect(member.role).toBe('MEMBER');
    });

    it('joinAsStudent: non-student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.joinAsStudent(TEST_ACTIVITY_A_ID, {} as any, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('joinAsStudent: activity not ACTIVE → BadRequestException', async () => {
      await linkStudentToPerson(studentActor().personId!);
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ext_activities SET status = 'INACTIVE' WHERE id = $1::uuid`,
        TEST_ACTIVITY_A_ID,
      );
      await expect(
        withTestTenant(async () =>
          memberships.joinAsStudent(TEST_ACTIVITY_A_ID, {} as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('joinAsStudent: max_participants enforced under lock', async () => {
      // Lower the cap to 1
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ext_activities SET max_participants = 1 WHERE id = $1::uuid`,
        TEST_ACTIVITY_A_ID,
      );
      // Pre-seat one member
      const other = await trackedSeedStudent({ firstName: 'Pre', lastName: 'Seat' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_activity_members
           (id, activity_id, student_id, role, joined_at)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 'MEMBER', CURRENT_DATE)`,
        TEST_ACTIVITY_A_ID,
        other.studentId,
      );
      await linkStudentToPerson(studentActor().personId!);
      await expect(
        withTestTenant(async () =>
          memberships.joinAsStudent(TEST_ACTIVITY_A_ID, {} as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('joinAsStudent: double-join → BadRequestException via UNIQUE', async () => {
      await linkStudentToPerson(studentActor().personId!);
      await withTestTenant(async () =>
        memberships.joinAsStudent(TEST_ACTIVITY_A_ID, {} as any, studentActor()),
      );
      await expect(
        withTestTenant(async () =>
          memberships.joinAsStudent(TEST_ACTIVITY_A_ID, {} as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('joinAsStudent: missing activity → NotFoundException', async () => {
      await linkStudentToPerson(studentActor().personId!);
      await expect(
        withTestTenant(async () =>
          memberships.joinAsStudent(
            '00000000-0000-0000-0000-000000000000',
            {} as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('addMember: admin adds a student', async () => {
      const stu = await trackedSeedStudent();
      const member = await withTestTenant(async () =>
        memberships.addMember(
          TEST_ACTIVITY_A_ID,
          { studentId: stu.studentId, role: 'OFFICER' } as any,
          adminActor(),
        ),
      );
      expect(member.studentId).toBe(stu.studentId);
      expect(member.role).toBe('OFFICER');
    });

    it('addMember: student → ForbiddenException', async () => {
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(async () =>
          memberships.addMember(
            TEST_ACTIVITY_A_ID,
            { studentId: stu.studentId } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('addMember: max cap → BadRequestException', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ext_activities SET max_participants = 1 WHERE id = $1::uuid`,
        TEST_ACTIVITY_A_ID,
      );
      const stu1 = await trackedSeedStudent({ firstName: 'A' });
      const stu2 = await trackedSeedStudent({ firstName: 'B' });
      await withTestTenant(async () =>
        memberships.addMember(
          TEST_ACTIVITY_A_ID,
          { studentId: stu1.studentId } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          memberships.addMember(
            TEST_ACTIVITY_A_ID,
            { studentId: stu2.studentId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addMember: duplicate → BadRequestException', async () => {
      const stu = await trackedSeedStudent();
      await withTestTenant(async () =>
        memberships.addMember(
          TEST_ACTIVITY_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          memberships.addMember(
            TEST_ACTIVITY_A_ID,
            { studentId: stu.studentId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('addMember: missing activity → NotFoundException via assertCanManageActivity', async () => {
      const stu = await trackedSeedStudent();
      await expect(
        withTestTenant(async () =>
          memberships.addMember(
            '00000000-0000-0000-0000-000000000000',
            { studentId: stu.studentId } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patchMember: admin updates role / isActive / leftAt', async () => {
      const stu = await trackedSeedStudent();
      const m = await withTestTenant(async () =>
        memberships.addMember(
          TEST_ACTIVITY_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      // leftAt must be >= joined_at (CURRENT_DATE) per
      // ext_activity_members_dates_chk. Use a far-future date.
      const patched = await withTestTenant(async () =>
        memberships.patchMember(
          m.id,
          { role: 'PRESIDENT', isActive: false, leftAt: '2030-12-31' } as any,
          adminActor(),
        ),
      );
      expect(patched.role).toBe('PRESIDENT');
      expect(patched.isActive).toBe(false);
      expect(patched.leftAt).toBe('2030-12-31');
    });

    it('patchMember: no-op returns row', async () => {
      const stu = await trackedSeedStudent();
      const m = await withTestTenant(async () =>
        memberships.addMember(
          TEST_ACTIVITY_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      const dto = await withTestTenant(async () =>
        memberships.patchMember(m.id, {} as any, adminActor()),
      );
      expect(dto.id).toBe(m.id);
    });

    it('patchMember: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          memberships.patchMember(
            '00000000-0000-0000-0000-000000000000',
            { role: 'OFFICER' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('patchMember: student → ForbiddenException', async () => {
      const stu = await trackedSeedStudent();
      const m = await withTestTenant(async () =>
        memberships.addMember(
          TEST_ACTIVITY_A_ID,
          { studentId: stu.studentId } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          memberships.patchMember(m.id, { role: 'OFFICER' } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('listMyActivities: student sees own activities', async () => {
      await linkStudentToPerson(studentActor().personId!);
      await withTestTenant(async () =>
        memberships.joinAsStudent(TEST_ACTIVITY_A_ID, {} as any, studentActor()),
      );
      const list = await withTestTenant(async () => memberships.listMyActivities(studentActor()));
      expect(list.length).toBe(1);
      expect(list[0]!.activityId).toBe(TEST_ACTIVITY_A_ID);
    });

    it('listMyActivities: non-student returns []', async () => {
      const list = await withTestTenant(async () => memberships.listMyActivities(parentActor()));
      expect(list).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ScheduleService
  // ─────────────────────────────────────────────────────────────────
  describe('ScheduleService', () => {
    it('listForActivity: empty by default', async () => {
      const list = await withTestTenant(async () => schedules.listForActivity(TEST_ACTIVITY_A_ID));
      expect(list).toEqual([]);
    });

    it('create + patch + remove: admin lifecycle', async () => {
      const created = await withTestTenant(async () =>
        schedules.create(
          TEST_ACTIVITY_A_ID,
          { dayOfWeek: 1, startTime: '15:00', endTime: '16:30', location: 'Field' } as any,
          adminActor(),
        ),
      );
      expect(created.startTime).toBe('15:00');
      expect(created.endTime).toBe('16:30');

      const patched = await withTestTenant(async () =>
        schedules.patch(
          created.id,
          {
            dayOfWeek: 2,
            startTime: '16:00',
            endTime: '17:00',
            location: 'Field B',
            isActive: false,
          } as any,
          adminActor(),
        ),
      );
      expect(patched.dayOfWeek).toBe(2);
      expect(patched.isActive).toBe(false);

      const noop = await withTestTenant(async () =>
        schedules.patch(created.id, {} as any, adminActor()),
      );
      expect(noop.id).toBe(created.id);

      await withTestTenant(async () => schedules.remove(created.id, adminActor()));
      const after = await withTestTenant(async () => schedules.listForActivity(TEST_ACTIVITY_A_ID));
      expect(after.length).toBe(0);
    });

    it('create: bad dayOfWeek → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          schedules.create(
            TEST_ACTIVITY_A_ID,
            { dayOfWeek: 9, startTime: '15:00', endTime: '16:00' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: startTime >= endTime → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          schedules.create(
            TEST_ACTIVITY_A_ID,
            { dayOfWeek: 1, startTime: '16:00', endTime: '15:00' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          schedules.create(
            TEST_ACTIVITY_A_ID,
            { dayOfWeek: 1, startTime: '15:00', endTime: '16:00' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: student → ForbiddenException', async () => {
      const sched = await withTestTenant(async () =>
        schedules.create(
          TEST_ACTIVITY_A_ID,
          { dayOfWeek: 1, startTime: '15:00', endTime: '16:00' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          schedules.patch(sched.id, { dayOfWeek: 2 } as any, studentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('patch: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          schedules.patch(
            '00000000-0000-0000-0000-000000000000',
            { dayOfWeek: 1 } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove: student → ForbiddenException', async () => {
      const sched = await withTestTenant(async () =>
        schedules.create(
          TEST_ACTIVITY_A_ID,
          { dayOfWeek: 1, startTime: '15:00', endTime: '16:00' } as any,
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => schedules.remove(sched.id, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('remove: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          schedules.remove('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('loadActivityIdForSchedule: known id returns activity id, unknown returns null', async () => {
      const sched = await withTestTenant(async () =>
        schedules.create(
          TEST_ACTIVITY_A_ID,
          { dayOfWeek: 1, startTime: '15:00', endTime: '16:00' } as any,
          adminActor(),
        ),
      );
      const aid = await withTestTenant(async () => activities.loadActivityIdForSchedule(sched.id));
      expect(aid).toBe(TEST_ACTIVITY_A_ID);
      const missing = await withTestTenant(async () =>
        activities.loadActivityIdForSchedule('00000000-0000-0000-0000-000000000000'),
      );
      expect(missing).toBeNull();
    });

    it('loadActivityIdForMember: unknown → null', async () => {
      const missing = await withTestTenant(async () =>
        activities.loadActivityIdForMember('00000000-0000-0000-0000-000000000000'),
      );
      expect(missing).toBeNull();
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ServiceProgrammeService
  // ─────────────────────────────────────────────────────────────────
  describe('ServiceProgrammeService', () => {
    it('list active programmes (school scoped)', async () => {
      const list = await withTestTenant(async () => programmes.list());
      expect(list.map((p) => p.id)).toContain(TEST_PROGRAMME_A_ID);
      expect(list.map((p) => p.id)).not.toContain(TEST_PROGRAMME_B_ID);
    });

    it('list includeInactive=true returns inactive too', async () => {
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ext_service_programmes SET is_active = false WHERE id = $1::uuid`,
        TEST_PROGRAMME_A_ID,
      );
      const active = await withTestTenant(async () => programmes.list(false));
      expect(active.map((p) => p.id)).not.toContain(TEST_PROGRAMME_A_ID);
      const all = await withTestTenant(async () => programmes.list(true));
      expect(all.map((p) => p.id)).toContain(TEST_PROGRAMME_A_ID);
    });

    it('getById returns DTO', async () => {
      const dto = await withTestTenant(async () => programmes.getById(TEST_PROGRAMME_A_ID));
      expect(dto.id).toBe(TEST_PROGRAMME_A_ID);
      expect(dto.targetHours).toBe(40);
      expect(dto.eligibleGradeLevels).toEqual(['5', '6']);
    });

    it('getById: missing → NotFoundException', async () => {
      await expect(
        withTestTenant(async () => programmes.getById('00000000-0000-0000-0000-000000000000')),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('create: admin creates programme', async () => {
      const dto = await withTestTenant(async () =>
        programmes.create(
          {
            name: 'New Programme',
            academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
            targetHours: 25,
            startDate: '2026-09-01',
            endDate: '2027-06-30',
            eligibleGradeLevels: ['5'],
          } as any,
          adminActor(),
        ),
      );
      expect(dto.name).toBe('New Programme');
    });

    it('create: endDate < startDate → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          programmes.create(
            {
              name: 'Bad Dates',
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              targetHours: 10,
              startDate: '2027-06-01',
              endDate: '2026-09-01',
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: duplicate (school,name,year) → BadRequestException', async () => {
      await expect(
        withTestTenant(async () =>
          programmes.create(
            {
              name: 'Community Hours 2026',
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              targetHours: 1,
            } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('create: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          programmes.create(
            {
              name: 'X',
              academicYearId: TEST_SIS_ACADEMIC_YEAR_ID,
              targetHours: 1,
            } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('leaderboard: admin sees data', async () => {
      const list = await withTestTenant(async () =>
        programmes.getLeaderboard(TEST_PROGRAMME_A_ID, adminActor()),
      );
      expect(Array.isArray(list)).toBe(true);
    });

    it('leaderboard: student → ForbiddenException (MAJOR 6)', async () => {
      await expect(
        withTestTenant(async () => programmes.getLeaderboard(TEST_PROGRAMME_A_ID, studentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('leaderboard: parent → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => programmes.getLeaderboard(TEST_PROGRAMME_A_ID, parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // ServiceHourService — STUDENT-INPUT KEYSTONE + review + progress
  // ─────────────────────────────────────────────────────────────────
  describe('ServiceHourService', () => {
    it('log: student keystone — logs hours + PENDING approval + progress.pending_hours', async () => {
      await linkStudentToPerson(studentActor().personId!);
      const dto = await withTestTenant(async () =>
        hours.log(
          {
            programmeId: TEST_PROGRAMME_A_ID,
            organisation: 'Local Foodbank',
            description: 'Sorting cans',
            serviceDate: '2026-05-01',
            hours: 4,
            supervisorName: 'Sup A',
            supervisorContact: 'sup@example.com',
            evidenceS3Key: 'evidence/x.png',
          } as any,
          studentActor(),
        ),
      );
      expect(dto.organisation).toBe('Local Foodbank');
      expect(dto.approvalStatus).toBe('PENDING');
      // MAJOR 4: approver name suppressed while PENDING
      expect(dto.approvedByName).toBeNull();

      const progressRows = (await rawClient.$queryRawUnsafe(
        `SELECT pending_hours::text AS p, approved_hours::text AS a FROM ${TEST_SCHEMA}.ext_service_progress WHERE programme_id = $1::uuid`,
        TEST_PROGRAMME_A_ID,
      )) as Array<{ p: string; a: string }>;
      expect(Number(progressRows[0]!.p)).toBe(4);
      expect(Number(progressRows[0]!.a)).toBe(0);
    });

    it('log: without programmeId → no progress row created', async () => {
      await linkStudentToPerson(studentActor().personId!);
      const dto = await withTestTenant(async () =>
        hours.log(
          {
            organisation: 'Solo',
            description: 'Independent',
            serviceDate: '2026-05-02',
            hours: 2,
          } as any,
          studentActor(),
        ),
      );
      expect(dto.programmeId).toBeNull();
    });

    it('log: non-student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          hours.log(
            {
              organisation: 'X',
              description: 'Y',
              serviceDate: '2026-05-01',
              hours: 1,
            } as any,
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('review: APPROVE recomputes progress.approved_hours and is_complete', async () => {
      await linkStudentToPerson(studentActor().personId!);
      // Lower target so we can flip is_complete cleanly
      await rawClient.$executeRawUnsafe(
        `UPDATE ${TEST_SCHEMA}.ext_service_programmes SET target_hours = 3 WHERE id = $1::uuid`,
        TEST_PROGRAMME_A_ID,
      );
      const logged = await withTestTenant(async () =>
        hours.log(
          {
            programmeId: TEST_PROGRAMME_A_ID,
            organisation: 'Lib',
            description: 'Shelving',
            serviceDate: '2026-05-03',
            hours: 5,
          } as any,
          studentActor(),
        ),
      );
      const approvalRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_service_hour_approvals WHERE service_hour_id = $1::uuid`,
        logged.id,
      )) as Array<{ id: string }>;
      const approvalId = approvalRows[0]!.id;

      const reviewed = await withTestTenant(async () =>
        hours.review(approvalId, { status: 'APPROVED', notes: 'great' } as any, adminActor()),
      );
      expect(reviewed.approvalStatus).toBe('APPROVED');
      expect(reviewed.approvedByName).not.toBeNull();

      const progressRows = (await rawClient.$queryRawUnsafe(
        `SELECT pending_hours::text AS p, approved_hours::text AS a, is_complete FROM ${TEST_SCHEMA}.ext_service_progress WHERE programme_id = $1::uuid`,
        TEST_PROGRAMME_A_ID,
      )) as Array<{ p: string; a: string; is_complete: boolean }>;
      expect(Number(progressRows[0]!.a)).toBe(5);
      expect(Number(progressRows[0]!.p)).toBe(0);
      expect(progressRows[0]!.is_complete).toBe(true);
    });

    it('review: REJECT decrements pending only', async () => {
      await linkStudentToPerson(studentActor().personId!);
      const logged = await withTestTenant(async () =>
        hours.log(
          {
            programmeId: TEST_PROGRAMME_A_ID,
            organisation: 'Lib',
            description: 'Shelving',
            serviceDate: '2026-05-03',
            hours: 2,
          } as any,
          studentActor(),
        ),
      );
      const approvalRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_service_hour_approvals WHERE service_hour_id = $1::uuid`,
        logged.id,
      )) as Array<{ id: string }>;
      const approvalId = approvalRows[0]!.id;

      await withTestTenant(async () =>
        hours.review(approvalId, { status: 'REJECTED', notes: 'no evidence' } as any, adminActor()),
      );
      const progressRows = (await rawClient.$queryRawUnsafe(
        `SELECT pending_hours::text AS p, approved_hours::text AS a FROM ${TEST_SCHEMA}.ext_service_progress WHERE programme_id = $1::uuid`,
        TEST_PROGRAMME_A_ID,
      )) as Array<{ p: string; a: string }>;
      expect(Number(progressRows[0]!.p)).toBe(0);
      expect(Number(progressRows[0]!.a)).toBe(0);
    });

    it('review: re-review of terminal status → BadRequestException', async () => {
      await linkStudentToPerson(studentActor().personId!);
      const logged = await withTestTenant(async () =>
        hours.log(
          {
            programmeId: TEST_PROGRAMME_A_ID,
            organisation: 'Lib',
            description: 'Shelving',
            serviceDate: '2026-05-03',
            hours: 2,
          } as any,
          studentActor(),
        ),
      );
      const approvalRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_service_hour_approvals WHERE service_hour_id = $1::uuid`,
        logged.id,
      )) as Array<{ id: string }>;
      const approvalId = approvalRows[0]!.id;
      await withTestTenant(async () =>
        hours.review(approvalId, { status: 'APPROVED' } as any, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          hours.review(approvalId, { status: 'REJECTED' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('review: transitioning to PENDING → BadRequestException', async () => {
      await linkStudentToPerson(studentActor().personId!);
      const logged = await withTestTenant(async () =>
        hours.log(
          {
            programmeId: TEST_PROGRAMME_A_ID,
            organisation: 'L',
            description: 'D',
            serviceDate: '2026-05-04',
            hours: 1,
          } as any,
          studentActor(),
        ),
      );
      const approvalRows = (await rawClient.$queryRawUnsafe(
        `SELECT id::text AS id FROM ${TEST_SCHEMA}.ext_service_hour_approvals WHERE service_hour_id = $1::uuid`,
        logged.id,
      )) as Array<{ id: string }>;
      await expect(
        withTestTenant(async () =>
          hours.review(approvalRows[0]!.id, { status: 'PENDING' } as any, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('review: student → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          hours.review(
            '00000000-0000-0000-0000-000000000000',
            { status: 'APPROVED' } as any,
            studentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('review: staff without employeeId → BadRequestException', async () => {
      const ghostStaff: any = {
        accountId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
        personId: 'aaaaaaaa-bbbb-cccc-dddd-ffffffffffff',
        employeeId: null,
        personType: 'STAFF',
        isSchoolAdmin: true,
      };
      await expect(
        withTestTenant(async () =>
          hours.review(
            '00000000-0000-0000-0000-000000000000',
            { status: 'APPROVED' } as any,
            ghostStaff,
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('review: missing approval → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          hours.review(
            '00000000-0000-0000-0000-000000000000',
            { status: 'APPROVED' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list: student sees only own; staff sees all', async () => {
      await linkStudentToPerson(studentActor().personId!);
      await withTestTenant(async () =>
        hours.log(
          {
            organisation: 'StuOrg',
            description: 'X',
            serviceDate: '2026-05-01',
            hours: 1,
          } as any,
          studentActor(),
        ),
      );
      // Seed a second student's row directly
      const other = await trackedSeedStudent({ firstName: 'Other', lastName: 'Stu' });
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ext_service_hours (id, student_id, organisation, description, service_date, hours)
         VALUES (gen_random_uuid(), $1::uuid, 'OthOrg', 'Y', '2026-05-02', 1)`,
        other.studentId,
      );
      const stuList = await withTestTenant(async () => hours.list(studentActor()));
      expect(stuList.length).toBe(1);
      expect(stuList[0]!.organisation).toBe('StuOrg');

      const adminList = await withTestTenant(async () => hours.list(adminActor()));
      expect(adminList.length).toBe(2);
    });

    it('list: parent without student bridge → []', async () => {
      const list = await withTestTenant(async () => hours.list(parentActor()));
      expect(list).toEqual([]);
    });

    it('myProgress: student returns own progress', async () => {
      await linkStudentToPerson(studentActor().personId!);
      await withTestTenant(async () =>
        hours.log(
          {
            programmeId: TEST_PROGRAMME_A_ID,
            organisation: 'X',
            description: 'Y',
            serviceDate: '2026-05-01',
            hours: 1.5,
          } as any,
          studentActor(),
        ),
      );
      const progress = await withTestTenant(async () => hours.myProgress(studentActor()));
      expect(progress.length).toBe(1);
      expect(progress[0]!.pendingHours).toBe(1.5);
      expect(progress[0]!.approvedHours).toBe(0);
    });

    it('myProgress: parent → []', async () => {
      const progress = await withTestTenant(async () => hours.myProgress(parentActor()));
      expect(progress).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-school isolation final check
  // ─────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A admin cannot list School B activities', async () => {
      const listA = await withTestTenant(async () => activities.list({}));
      expect(listA.map((a) => a.id)).not.toContain(TEST_ACTIVITY_B_ID);
      const listB = await withTestTenantB(async () => activities.list({}));
      expect(listB.map((a) => a.id)).toContain(TEST_ACTIVITY_B_ID);
    });

    it('School A admin cannot list School B programmes', async () => {
      const listA = await withTestTenant(async () => programmes.list());
      expect(listA.map((p) => p.id)).not.toContain(TEST_PROGRAMME_B_ID);
    });
  });
});
