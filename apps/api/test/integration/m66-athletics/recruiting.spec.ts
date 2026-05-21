import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { RecruitingService } from '@modules/m66-athletics/recruiting.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
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
  teacherActor,
  studentActor,
  parentActor,
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { seedStudent, ensureGuardianForPerson, linkStudentGuardian } from '../m20-sis/sis-helpers';
import { resetAthleticsTables, ensureAthleticsSeed } from '../fixtures/athletics';

describe('integration:m66-athletics/recruiting', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let recruiting: RecruitingService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    const permCheck = new PermissionCheckService(rawClient);
    recruiting = new RecruitingService(tenantPrisma, permCheck);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await resetAthleticsTables(rawClient);
    if (studentIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = ANY($1::uuid[])`,
        studentIds,
      );
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
        studentIds.splice(0),
      );
    }
    if (platformStudentIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
        platformStudentIds.splice(0),
      );
    }
    if (guardianIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = ANY($1::uuid[])`,
        guardianIds.splice(0),
      );
    }
    if (personIds.length) {
      await rawClient.$executeRawUnsafe(
        `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
        personIds.splice(0),
      );
    }
    await ensureAthleticsSeed(rawClient);
  });

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /**
   * Link the studentActor.personId to a sis_students row so STUDENT-self
   * paths can be exercised.
   */
  async function linkStudentToPerson(personId: string): Promise<string> {
    const existingPs = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
      personId,
    )) as Array<{ id: string }>;
    let psId: string;
    if (existingPs.length > 0) {
      psId = existingPs[0]!.id;
    } else {
      const newPs = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES (gen_random_uuid(), $1::uuid, 'Rec', 'Stu', true)
         RETURNING id::text AS id`,
        personId,
      )) as Array<{ id: string }>;
      psId = newPs[0]!.id;
      platformStudentIds.push(psId);
    }
    const existing = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id = $1::uuid LIMIT 1`,
      psId,
    )) as Array<{ id: string }>;
    if (existing.length > 0) return existing[0]!.id;
    const stu = (await rawClient.$queryRawUnsafe<Array<{ id: string }>>(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3, '11', 'ENROLLED')
       RETURNING id::text AS id`,
      psId,
      TEST_SCHOOL_ID,
      'REC-' + Math.random().toString(36).slice(2, 8).toUpperCase(),
    )) as Array<{ id: string }>;
    studentIds.push(stu[0]!.id);
    return stu[0]!.id;
  }

  // ─────────────────────────────────────────────────────────────────
  // createProfile + visibility
  // ─────────────────────────────────────────────────────────────────
  it('createProfile: student-self creates own profile', async () => {
    const studentId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const dto = await withTestTenant(() =>
      recruiting.createProfile(
        {
          studentId,
          sport: 'Soccer',
          graduationYear: 2028,
          position: 'Forward',
          heightInches: 70,
          weightLbs: 165,
        } as any,
        studentActor(),
      ),
    );
    expect(dto.studentId).toBe(studentId);
    expect(dto.sport).toBe('Soccer');
    expect(dto.isPublished).toBe(false);
  });

  it('createProfile: admin/coach creates on behalf', async () => {
    const stu = await trackedSeedStudent();
    const dto = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'Basketball', graduationYear: 2027 } as any,
        adminActor(),
      ),
    );
    expect(dto.studentId).toBe(stu.studentId);
  });

  it('createProfile: STUDENT trying to write OTHER student → ForbiddenException', async () => {
    await linkStudentToPerson(TEST_STUDENT_PERSON_ID); // links own student
    const otherStu = await trackedSeedStudent({ firstName: 'Other' });
    await expect(
      withTestTenant(() =>
        recruiting.createProfile(
          { studentId: otherStu.studentId, sport: 'Soccer', graduationYear: 2027 } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('createProfile: teacher without delegation → ForbiddenException', async () => {
    const stu = await trackedSeedStudent();
    await expect(
      withTestTenant(() =>
        recruiting.createProfile(
          { studentId: stu.studentId, sport: 'X', graduationYear: 2027 } as any,
          teacherActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('createProfile: parent → ForbiddenException', async () => {
    const stu = await trackedSeedStudent();
    await expect(
      withTestTenant(() =>
        recruiting.createProfile(
          { studentId: stu.studentId, sport: 'X', graduationYear: 2027 } as any,
          parentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('createProfile: missing student in this school → BadRequestException', async () => {
    await expect(
      withTestTenant(() =>
        recruiting.createProfile(
          {
            studentId: '00000000-0000-0000-0000-000000000000',
            sport: 'X',
            graduationYear: 2027,
          } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('createProfile: duplicate (UNIQUE student_id) → BadRequestException', async () => {
    const stu = await trackedSeedStudent();
    await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'X', graduationYear: 2027 } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() =>
        recruiting.createProfile(
          { studentId: stu.studentId, sport: 'Y', graduationYear: 2028 } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  // ─────────────────────────────────────────────────────────────────
  // listProfiles + visibility
  // ─────────────────────────────────────────────────────────────────
  it('listProfiles: admin sees all', async () => {
    const stu1 = await trackedSeedStudent({ firstName: 'A' });
    const stu2 = await trackedSeedStudent({ firstName: 'B' });
    await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu1.studentId, sport: 'Soccer', graduationYear: 2027 } as any,
        adminActor(),
      ),
    );
    await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu2.studentId, sport: 'Basketball', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(() => recruiting.listProfiles({}, adminActor()));
    expect(list.length).toBe(2);

    // With filters
    const filtered = await withTestTenant(() =>
      recruiting.listProfiles(
        { sport: 'Soccer', graduationYear: 2027, isPublished: false },
        adminActor(),
      ),
    );
    expect(filtered.length).toBe(1);
  });

  it('listProfiles: student sees only own', async () => {
    const studentId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const otherStu = await trackedSeedStudent({ firstName: 'Other' });
    await withTestTenant(() =>
      recruiting.createProfile(
        { studentId, sport: 'Soccer', graduationYear: 2028 } as any,
        studentActor(),
      ),
    );
    await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: otherStu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(() => recruiting.listProfiles({}, studentActor()));
    expect(list.length).toBe(1);
    expect(list[0]!.studentId).toBe(studentId);
  });

  it('listProfiles: parent sees linked child only', async () => {
    const stu = await trackedSeedStudent({ firstName: 'Child' });
    const guardianId = await ensureGuardianForPerson(
      rawClient,
      TEST_PARENT_PERSON_ID,
      TEST_PARENT_ACCOUNT_ID,
    );
    guardianIds.push(guardianId);
    await linkStudentGuardian(rawClient, stu.studentId, guardianId);

    await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'Soccer', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    // Unrelated profile
    const otherStu = await trackedSeedStudent({ firstName: 'Other' });
    await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: otherStu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    const list = await withTestTenant(() => recruiting.listProfiles({}, parentActor()));
    expect(list.length).toBe(1);
    expect(list[0]!.studentId).toBe(stu.studentId);
  });

  it('listProfiles: teacher (non-admin) sees published only', async () => {
    const stu = await trackedSeedStudent();
    const profile = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    // Unpublished — teacher sees nothing
    const teacherList = await withTestTenant(() => recruiting.listProfiles({}, teacherActor()));
    expect(teacherList.length).toBe(0);

    // Now publish
    await withTestTenant(() =>
      recruiting.updateProfile(profile.id, { isPublished: true } as any, adminActor()),
    );
    const after = await withTestTenant(() => recruiting.listProfiles({}, teacherActor()));
    expect(after.length).toBe(1);
  });

  // ─────────────────────────────────────────────────────────────────
  // getProfileById / getProfileByStudent
  // ─────────────────────────────────────────────────────────────────
  it('getProfileById + getProfileByStudent: admin', async () => {
    const stu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    const byId = await withTestTenant(() => recruiting.getProfileById(p.id, adminActor()));
    expect(byId.id).toBe(p.id);
    const byStu = await withTestTenant(() =>
      recruiting.getProfileByStudent(stu.studentId, adminActor()),
    );
    expect(byStu?.id).toBe(p.id);
  });

  it('getProfileByStudent: no profile returns null', async () => {
    const stu = await trackedSeedStudent();
    const out = await withTestTenant(() =>
      recruiting.getProfileByStudent(stu.studentId, adminActor()),
    );
    expect(out).toBeNull();
  });

  it('getProfileById: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        recruiting.getProfileById('00000000-0000-0000-0000-000000000000', adminActor()),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getProfileById: teacher on unpublished → NotFoundException', async () => {
    const stu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() => recruiting.getProfileById(p.id, teacherActor())),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('getProfileByStudent: teacher on unpublished returns null', async () => {
    const stu = await trackedSeedStudent();
    await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    const out = await withTestTenant(() =>
      recruiting.getProfileByStudent(stu.studentId, teacherActor()),
    );
    expect(out).toBeNull();
  });

  // ─────────────────────────────────────────────────────────────────
  // updateProfile
  // ─────────────────────────────────────────────────────────────────
  it('updateProfile: student-self can update own + publish snapshots gpa', async () => {
    const studentId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId, sport: 'Soccer', graduationYear: 2028 } as any,
        studentActor(),
      ),
    );
    // Seed an rpt_student_academic_summary row so publish snapshots gpa.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.rpt_student_academic_summary WHERE student_id = $1::uuid`,
      studentId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.rpt_student_academic_summary
         (id, student_id, academic_year_id, school_id, current_gpa)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 3.875)`,
      studentId,
      // Use the SIS academic year fixture
      (await import('../fixtures/sis')).TEST_SIS_ACADEMIC_YEAR_ID,
      TEST_SCHOOL_ID,
    );
    const patched = await withTestTenant(() =>
      recruiting.updateProfile(
        p.id,
        {
          sport: 'Soccer & Track',
          graduationYear: 2029,
          position: 'Striker',
          heightInches: 72,
          weightLbs: 170,
          highlightReelS3Key: 'reel/x.mp4',
          achievements: 'all-conf',
          contactEmail: 'me@example.com',
          isPublished: true,
        } as any,
        studentActor(),
      ),
    );
    expect(patched.isPublished).toBe(true);
    expect(patched.publishedAt).not.toBeNull();
    expect(patched.gpa).toBe(3.875);
    expect(patched.gpaSnapshotAt).not.toBeNull();
  });

  it('updateProfile: publish without rpt_student_academic_summary row leaves gpa null', async () => {
    const studentId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId, sport: 'Soccer', graduationYear: 2028 } as any,
        studentActor(),
      ),
    );
    // No row for this student.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.rpt_student_academic_summary WHERE student_id = $1::uuid`,
      studentId,
    );
    const patched = await withTestTenant(() =>
      recruiting.updateProfile(p.id, { isPublished: true } as any, adminActor()),
    );
    expect(patched.isPublished).toBe(true);
    expect(patched.gpa).toBeNull();
  });

  it('updateProfile: un-publish nullifies publishedAt', async () => {
    const studentId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId, sport: 'X', graduationYear: 2028 } as any,
        studentActor(),
      ),
    );
    await withTestTenant(() =>
      recruiting.updateProfile(p.id, { isPublished: true } as any, adminActor()),
    );
    const after = await withTestTenant(() =>
      recruiting.updateProfile(p.id, { isPublished: false } as any, adminActor()),
    );
    expect(after.isPublished).toBe(false);
    expect(after.publishedAt).toBeNull();
  });

  it('updateProfile: coach can write coachRecommendation; student cannot', async () => {
    const studentId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId, sport: 'X', graduationYear: 2028 } as any,
        studentActor(),
      ),
    );
    const coachPatched = await withTestTenant(() =>
      recruiting.updateProfile(p.id, { coachRecommendation: 'Outstanding' } as any, adminActor()),
    );
    expect(coachPatched.coachRecommendation).toBe('Outstanding');

    await expect(
      withTestTenant(() =>
        recruiting.updateProfile(
          p.id,
          { coachRecommendation: 'Self-recommendation' } as any,
          studentActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updateProfile: no-op returns the row', async () => {
    const stu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    const noop = await withTestTenant(() =>
      recruiting.updateProfile(p.id, {} as any, adminActor()),
    );
    expect(noop.id).toBe(p.id);
  });

  it('updateProfile: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        recruiting.updateProfile(
          '00000000-0000-0000-0000-000000000000',
          { sport: 'X' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updateProfile: unrelated student → ForbiddenException', async () => {
    await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const otherStu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: otherStu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() => recruiting.updateProfile(p.id, { sport: 'Y' } as any, studentActor())),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─────────────────────────────────────────────────────────────────
  // Interests
  // ─────────────────────────────────────────────────────────────────
  it('createInterest + listInterests + updateInterest', async () => {
    const studentId = await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId, sport: 'Soccer', graduationYear: 2028 } as any,
        studentActor(),
      ),
    );
    const i = await withTestTenant(() =>
      recruiting.createInterest(
        p.id,
        {
          collegeName: 'State U',
          contactName: 'Coach A',
          contactEmail: 'a@example.com',
          contactPhone: '555-1212',
          interestLevel: 'INTERESTED',
          lastContactDate: '2026-09-01',
          notes: 'Initial outreach',
        } as any,
        studentActor(),
      ),
    );
    expect(i.collegeName).toBe('State U');
    expect(i.interestLevel).toBe('INTERESTED');

    const list = await withTestTenant(() =>
      recruiting.listInterestsForProfile(p.id, studentActor()),
    );
    expect(list.length).toBe(1);

    const updated = await withTestTenant(() =>
      recruiting.updateInterest(
        i.id,
        {
          collegeName: 'State U2',
          contactName: 'Coach B',
          contactEmail: 'b@example.com',
          contactPhone: '555-2323',
          interestLevel: 'APPLIED',
          lastContactDate: '2026-10-01',
          notes: 'Apps in',
        } as any,
        studentActor(),
      ),
    );
    expect(updated.interestLevel).toBe('APPLIED');
  });

  it('createInterest: missing profile → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        recruiting.createInterest(
          '00000000-0000-0000-0000-000000000000',
          { collegeName: 'X' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('createInterest: unrelated student → ForbiddenException', async () => {
    await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const otherStu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: otherStu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() =>
        recruiting.createInterest(p.id, { collegeName: 'Other' } as any, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('createInterest: parent → ForbiddenException', async () => {
    const stu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    await expect(
      withTestTenant(() =>
        recruiting.createInterest(p.id, { collegeName: 'X' } as any, parentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('updateInterest: missing → NotFoundException', async () => {
    await expect(
      withTestTenant(() =>
        recruiting.updateInterest(
          '00000000-0000-0000-0000-000000000000',
          { collegeName: 'X' } as any,
          adminActor(),
        ),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('updateInterest: no-op returns row', async () => {
    const stu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: stu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    const i = await withTestTenant(() =>
      recruiting.createInterest(p.id, { collegeName: 'U' } as any, adminActor()),
    );
    const noop = await withTestTenant(() =>
      recruiting.updateInterest(i.id, {} as any, adminActor()),
    );
    expect(noop.id).toBe(i.id);
  });

  it('updateInterest: unrelated student → ForbiddenException', async () => {
    await linkStudentToPerson(TEST_STUDENT_PERSON_ID);
    const otherStu = await trackedSeedStudent();
    const p = await withTestTenant(() =>
      recruiting.createProfile(
        { studentId: otherStu.studentId, sport: 'X', graduationYear: 2028 } as any,
        adminActor(),
      ),
    );
    const i = await withTestTenant(() =>
      recruiting.createInterest(p.id, { collegeName: 'U' } as any, adminActor()),
    );
    await expect(
      withTestTenant(() =>
        recruiting.updateInterest(i.id, { collegeName: 'V' } as any, studentActor()),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  // ─────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ─────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A admin cannot get School B recruiting profile', async () => {
      // Seed a School B student + profile
      const bPersonId = generateId();
      const bPsId = generateId();
      const bStuId = generateId();
      const bProfileId = generateId();
      personIds.push(bPersonId);
      platformStudentIds.push(bPsId);
      studentIds.push(bStuId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active) VALUES ($1::uuid, 'B', 'Student', 'STUDENT', true)`,
        bPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active) VALUES ($1::uuid, $2::uuid, 'B', 'Student', true)`,
        bPsId,
        bPersonId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '11', 'ENROLLED')`,
        bStuId,
        bPsId,
        TEST_SCHOOL_B_ID,
        'B-' + Math.random().toString(36).slice(2, 9).toUpperCase(),
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.ath_recruiting_profiles (id, student_id, sport, graduation_year) VALUES ($1::uuid, $2::uuid, 'Soccer', 2027)`,
        bProfileId,
        bStuId,
      );
      await expect(
        withTestTenant(() => recruiting.getProfileById(bProfileId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);

      // School B sees it
      const bDto = await withTestTenantB(() => recruiting.getProfileById(bProfileId, adminActor()));
      expect(bDto.id).toBe(bProfileId);
    });
  });
});
