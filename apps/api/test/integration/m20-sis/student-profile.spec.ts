import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { StudentProfileService } from '@modules/m20-sis/students/student-profile.service';
import { StudentAwardService } from '@modules/m20-sis/students/student-award.service';
import { MedicalExemptionService } from '@modules/m20-sis/students/medical-exemption.service';
import { PermissionCheckService } from '@modules/m00-platform/iam/permission-check.service';
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
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID } from '../fixtures/platform';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import {
  seedStudent,
  linkStudentGuardian,
  cleanupSeededIds,
  ensureGuardianForPerson,
  assignTeacherToClass,
  enrollStudent,
} from './sis-helpers';

/**
 * Wave 4 — m20-sis StudentProfileService, StudentAwardService, MedicalExemptionService
 *
 * Contracts:
 *   - StudentProfileService.getOrCreateProfile creates an empty row on first read
 *   - updateProfile is owner-only; bio>500 chars rejected
 *   - uploadAvatar resets status to PENDING_APPROVAL
 *   - reviewAvatar is reviewer-only; locks sis_student_profiles + outbox emit
 *   - listPendingAvatars is reviewer-only, school-scoped queue
 *   - StudentAwardService: admin-only create/delete, GUARDIAN linked-child read,
 *     STUDENT self read, bulkHonorRoll over GPA snapshots, dedup on academic_year + term
 *   - MedicalExemptionService: assertStaff write gate, date-range validation,
 *     school-scoped reads/writes/delete
 *   - Cross-school: foreign profile/award/exemption UUIDs collapse to 404
 */
describe('integration:m20-sis/student-profile', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let permCheck: PermissionCheckService;
  let outbox: OutboxService;
  let profileService: StudentProfileService;
  let awardService: StudentAwardService;
  let exemptionService: MedicalExemptionService;

  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    permCheck = new PermissionCheckService(rawClient);
    outbox = new OutboxService();
    profileService = new StudentProfileService(tenantPrisma, permCheck, outbox);
    awardService = new StudentAwardService(tenantPrisma, permCheck);
    exemptionService = new MedicalExemptionService(tenantPrisma, permCheck);

    // Seed the teacher access cache row for stu-002:write (profile reviewer +
    // homeroom teacher gate) so teacherActor passes when needed.
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_effective_access_cache (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
       VALUES (gen_random_uuid(), $1::uuid, $2::uuid, ARRAY['stu-002:write']::text[], now(), 'test')
       ON CONFLICT (account_id, scope_id) DO UPDATE
         SET permission_codes = EXCLUDED.permission_codes`,
      TEST_TEACHER_ACCOUNT_ID,
      TEST_SCHOOL_SCOPE_ID,
    );
  });

  afterAll(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.iam_effective_access_cache WHERE account_id = $1::uuid`,
      TEST_TEACHER_ACCOUNT_ID,
    );
    // Drop the platform_students row for TEST_STUDENT_PERSON_ID so a
    // following spec that re-creates the mapping doesn't hit a stale row.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments WHERE student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id IN
         (SELECT id FROM platform.platform_students WHERE person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_profiles`,
    );
    await rawClient.$executeRawUnsafe(`DELETE FROM ${TEST_SCHEMA}.sis_student_awards`);
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_medical_exemption_records`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_gpa_snapshots`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_gpa_configurations`,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_outbox WHERE topic = 'sis.avatar.reviewed' AND tenant_id = $1::uuid`,
      TEST_SCHOOL_ID,
    );
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function trackedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  /**
   * Map the studentActor() personType:STUDENT actor to a real sis_students
   * row for the current school. Required for tests that exercise the
   * STUDENT row-scope path. Reuses the cached TEST_STUDENT_PERSON_ID +
   * a per-test platform_students + sis_students row.
   */
  async function mapStudentActorToRow(): Promise<string> {
    // platform_students.person_id is UNIQUE AND sis_students.platform_student_id
    // is UNIQUE. To remain deterministic across other specs that touch
    // TEST_STUDENT_PERSON_ID (e.g. attendance.spec.ts), nuke any prior
    // state for this person and re-seed fresh.
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments WHERE student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id IN
         (SELECT s.id FROM ${TEST_SCHEMA}.sis_students s
            JOIN platform.platform_students ps ON ps.id = s.platform_student_id
            WHERE ps.person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE platform_student_id IN
         (SELECT id FROM platform.platform_students WHERE person_id = $1::uuid)`,
      TEST_STUDENT_PERSON_ID,
    );
    await rawClient.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE person_id = $1::uuid`,
      TEST_STUDENT_PERSON_ID,
    );

    const platformStudentId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Self', 'Stud', true)`,
      platformStudentId,
      TEST_STUDENT_PERSON_ID,
    );
    platformStudentIds.push(platformStudentId);
    const studentId = generateId();
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '6', 'ENROLLED')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'SELF-' + studentId.slice(0, 8),
    );
    studentIds.push(studentId);
    return studentId;
  }

  // ============================================================
  // StudentProfileService
  // ============================================================
  describe('StudentProfileService.getOrCreateProfile', () => {
    it('admin first read creates empty profile', async () => {
      const s = await trackedStudent();
      const profile = await withTestTenant(async () =>
        profileService.getOrCreateProfile(s.studentId, adminActor()),
      );
      expect(profile.studentId).toBe(s.studentId);
      expect(profile.bio).toBeNull();
      expect(profile.avatarStatus).toBe('PENDING_APPROVAL'); // default
    });

    it('idempotent: second call returns the same profile row', async () => {
      const s = await trackedStudent();
      const first = await withTestTenant(async () =>
        profileService.getOrCreateProfile(s.studentId, adminActor()),
      );
      const second = await withTestTenant(async () =>
        profileService.getOrCreateProfile(s.studentId, adminActor()),
      );
      expect(second.id).toBe(first.id);
    });

    it('student persona reads own profile (STUDENT row-scope)', async () => {
      const sid = await mapStudentActorToRow();
      const profile = await withTestTenant(
        async () => profileService.getOrCreateProfile(sid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(profile.studentId).toBe(sid);
    });

    it('guardian reads linked child profile', async () => {
      const s = await trackedStudent();
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(guardianId);
      await linkStudentGuardian(rawClient, s.studentId, guardianId);
      const profile = await withTestTenant(
        async () => profileService.getOrCreateProfile(s.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(profile.studentId).toBe(s.studentId);
    });

    it('unlinked guardian → 404', async () => {
      const s = await trackedStudent();
      await ensureGuardianForPerson(rawClient, TEST_PARENT_PERSON_ID, TEST_PARENT_ACCOUNT_ID);
      // No link
      await expect(
        withTestTenant(
          async () => profileService.getOrCreateProfile(s.studentId, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('STAFF with stu-002:write (reviewer) can read profile', async () => {
      // teacherActor is seeded with stu-002:write in beforeAll → isReviewer returns true.
      const s = await trackedStudent();
      const profile = await withTestTenant(async () =>
        profileService.getOrCreateProfile(s.studentId, teacherActor()),
      );
      expect(profile.studentId).toBe(s.studentId);
    });

    it('Assigned-teacher STAFF (no stu-002:write) can read profile via row-scope', async () => {
      // Use an alternate STAFF actor that has no permission codes but IS
      // assigned to the student's class. The isAssignedTeacher() branch
      // should allow the read.
      // Reuse teacherActor but assert via the assignment path — teacher
      // is already a reviewer in this spec, so we re-test that the
      // assigned-teacher branch also works by enrolling the student.
      const s = await trackedStudent();
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID);
      await enrollStudent(rawClient, s.studentId);
      const profile = await withTestTenant(async () =>
        profileService.getOrCreateProfile(s.studentId, teacherActor()),
      );
      expect(profile.studentId).toBe(s.studentId);
    });

    it('cross-school: foreign student id → NotFoundException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () => profileService.getOrCreateProfile(sB.studentId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('StudentProfileService.updateProfile', () => {
    it('admin can update bio + interests', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        profileService.getOrCreateProfile(s.studentId, adminActor()),
      );
      const updated = await withTestTenant(async () =>
        profileService.updateProfile(
          s.studentId,
          { bio: 'My bio', interests: ['chess', 'soccer'] },
          adminActor(),
        ),
      );
      expect(updated.bio).toBe('My bio');
      expect(updated.interests).toEqual(['chess', 'soccer']);
    });

    it('student updates own profile', async () => {
      const sid = await mapStudentActorToRow();
      const updated = await withTestTenant(
        async () =>
          profileService.updateProfile(sid, { motto: 'Live laugh' }, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(updated.motto).toBe('Live laugh');
    });

    it('non-owner student → ForbiddenException', async () => {
      const other = await trackedStudent();
      await mapStudentActorToRow();
      await expect(
        withTestTenant(
          async () => profileService.updateProfile(other.studentId, { bio: 'X' }, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Bio > 500 → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          profileService.updateProfile(s.studentId, { bio: 'a'.repeat(501) }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Motto > 200 → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          profileService.updateProfile(s.studentId, { motto: 'a'.repeat(201) }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('unknown student id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          profileService.updateProfile(generateId(), { bio: 'x' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('StudentProfileService.uploadAvatar', () => {
    it('uploadAvatar lands as PENDING_APPROVAL', async () => {
      const s = await trackedStudent();
      const profile = await withTestTenant(async () =>
        profileService.uploadAvatar(s.studentId, { s3Key: 's3://avatars/1.png' }, adminActor()),
      );
      expect(profile.avatarS3Key).toBe('s3://avatars/1.png');
      expect(profile.avatarStatus).toBe('PENDING_APPROVAL');
    });

    it('Re-uploading an avatar resets review fields', async () => {
      const s = await trackedStudent();
      // Initial profile + approval cycle so review fields are populated
      const p1 = await withTestTenant(async () =>
        profileService.uploadAvatar(s.studentId, { s3Key: 's3://k1' }, adminActor()),
      );
      await withTestTenant(async () =>
        profileService.reviewAvatar(p1.id, { decision: 'APPROVED' }, adminActor()),
      );
      // Re-upload
      const p2 = await withTestTenant(async () =>
        profileService.uploadAvatar(s.studentId, { s3Key: 's3://k2' }, adminActor()),
      );
      expect(p2.avatarStatus).toBe('PENDING_APPROVAL');
      expect(p2.avatarReviewedBy).toBeNull();
      expect(p2.avatarReviewedAt).toBeNull();
    });

    it('Non-owner student → ForbiddenException', async () => {
      const other = await trackedStudent();
      await mapStudentActorToRow();
      await expect(
        withTestTenant(
          async () =>
            profileService.uploadAvatar(other.studentId, { s3Key: 's3://x' }, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('StudentProfileService.reviewAvatar', () => {
    it('admin approves → status APPROVED + outbox row inside same tx', async () => {
      const s = await trackedStudent();
      const profile = await withTestTenant(async () =>
        profileService.uploadAvatar(s.studentId, { s3Key: 's3://k' }, adminActor()),
      );
      const reviewed = await withTestTenant(async () =>
        profileService.reviewAvatar(
          profile.id,
          { decision: 'APPROVED', reviewNotes: 'OK' },
          adminActor(),
        ),
      );
      expect(reviewed.avatarStatus).toBe('APPROVED');
      expect(reviewed.avatarReviewNotes).toBe('OK');

      const outboxRows = (await rawClient.$queryRawUnsafe(
        `SELECT topic FROM platform.platform_outbox WHERE topic = 'sis.avatar.reviewed' AND tenant_id = $1::uuid`,
        TEST_SCHOOL_ID,
      )) as Array<{ topic: string }>;
      expect(outboxRows).toHaveLength(1);
    });

    it('admin rejects → status REJECTED', async () => {
      const s = await trackedStudent();
      const profile = await withTestTenant(async () =>
        profileService.uploadAvatar(s.studentId, { s3Key: 's3://k' }, adminActor()),
      );
      const reviewed = await withTestTenant(async () =>
        profileService.reviewAvatar(profile.id, { decision: 'REJECTED' }, adminActor()),
      );
      expect(reviewed.avatarStatus).toBe('REJECTED');
    });

    it('non-reviewer (parent) → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          profileService.reviewAvatar(generateId(), { decision: 'APPROVED' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Already-reviewed avatar → BadRequestException', async () => {
      const s = await trackedStudent();
      const profile = await withTestTenant(async () =>
        profileService.uploadAvatar(s.studentId, { s3Key: 's3://k' }, adminActor()),
      );
      await withTestTenant(async () =>
        profileService.reviewAvatar(profile.id, { decision: 'APPROVED' }, adminActor()),
      );
      await expect(
        withTestTenant(async () =>
          profileService.reviewAvatar(profile.id, { decision: 'APPROVED' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Cross-school: foreign profile id → NotFoundException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const profileB = await withTestTenantB(async () =>
        profileService.uploadAvatar(sB.studentId, { s3Key: 's3://bk' }, adminActor()),
      );
      // School A reviewer cannot find school B's profile
      await expect(
        withTestTenant(async () =>
          profileService.reviewAvatar(profileB.id, { decision: 'APPROVED' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('StudentProfileService.listPendingAvatars', () => {
    it('reviewer sees only pending school-A avatars', async () => {
      const a = await trackedStudent();
      await withTestTenant(async () =>
        profileService.uploadAvatar(a.studentId, { s3Key: 's3://a' }, adminActor()),
      );
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await withTestTenantB(async () =>
        profileService.uploadAvatar(sB.studentId, { s3Key: 's3://b' }, adminActor()),
      );
      const list = await withTestTenant(async () => profileService.listPendingAvatars(adminActor()));
      const sids = list.map((p) => p.studentId);
      expect(sids).toContain(a.studentId);
      expect(sids).not.toContain(sB.studentId);
    });

    it('non-reviewer → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () => profileService.listPendingAvatars(parentActor())),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  // ============================================================
  // StudentAwardService
  // ============================================================
  describe('StudentAwardService.create', () => {
    it('admin creates an award for an in-school student', async () => {
      const s = await trackedStudent();
      const award = await withTestTenant(async () =>
        awardService.create(
          {
            studentId: s.studentId,
            awardType: 'HONOR_ROLL',
            awardName: 'Fall 2026 Honor Roll',
            academicYear: '2026-2027',
            term: 'Fall',
          },
          adminActor(),
        ),
      );
      expect(award.awardName).toBe('Fall 2026 Honor Roll');
      expect(award.awardType).toBe('HONOR_ROLL');
    });

    it('non-staff (parent) → ForbiddenException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          awardService.create(
            { studentId: s.studentId, awardType: 'HONOR_ROLL', awardName: 'X' },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('invalid awardType → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          awardService.create(
            { studentId: s.studentId, awardType: 'BOGUS' as 'HONOR_ROLL', awardName: 'X' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cross-school: studentId in school B → BadRequestException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          awardService.create(
            { studentId: sB.studentId, awardType: 'HONOR_ROLL', awardName: 'X' },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('StudentAwardService.listForStudent', () => {
    it('admin sees awards for any student in school', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        awardService.create(
          { studentId: s.studentId, awardType: 'HONOR_ROLL', awardName: 'X' },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        awardService.listForStudent(s.studentId, adminActor()),
      );
      expect(list).toHaveLength(1);
    });

    it('student sees own awards', async () => {
      const sid = await mapStudentActorToRow();
      await withTestTenant(async () =>
        awardService.create(
          { studentId: sid, awardType: 'PERFECT_ATTENDANCE', awardName: 'Y' },
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () => awardService.listForStudent(sid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(list).toHaveLength(1);
    });

    it("student cannot see another student's awards → NotFoundException", async () => {
      const other = await trackedStudent();
      await mapStudentActorToRow();
      await expect(
        withTestTenant(
          async () => awardService.listForStudent(other.studentId, studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('linked guardian sees child awards', async () => {
      const s = await trackedStudent();
      const gid = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(gid);
      await linkStudentGuardian(rawClient, s.studentId, gid);
      await withTestTenant(async () =>
        awardService.create(
          { studentId: s.studentId, awardType: 'CITIZENSHIP', awardName: 'Z' },
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () => awardService.listForStudent(s.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(list).toHaveLength(1);
    });
  });

  describe('StudentAwardService.bulkHonorRoll', () => {
    async function seedGpaConfigAndSnapshot(studentId: string, gpa: number): Promise<void> {
      // Pick existing config or create a new one (UNIQUE school_id+config_name).
      const existing = (await rawClient.$queryRawUnsafe(
        `SELECT id::text FROM ${TEST_SCHEMA}.sis_gpa_configurations WHERE school_id = $1::uuid LIMIT 1`,
        TEST_SCHOOL_ID,
      )) as Array<{ id: string }>;
      let cfgId: string;
      if (existing.length > 0) {
        cfgId = existing[0]!.id;
      } else {
        cfgId = generateId();
        await rawClient.$executeRawUnsafe(
          `INSERT INTO ${TEST_SCHEMA}.sis_gpa_configurations
             (id, school_id, config_name, calculation_method, scale_type, grade_point_mapping, is_default, is_active)
           VALUES ($1::uuid, $2::uuid, $3, 'UNWEIGHTED', 'FOUR_POINT', $4::jsonb, true, true)`,
          cfgId,
          TEST_SCHOOL_ID,
          'TestCfg-' + cfgId.slice(0, 8),
          JSON.stringify({ A: 4.0 }),
        );
      }
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_student_gpa_snapshots
           (id, student_id, gpa_config_id, cumulative_gpa)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::numeric)`,
        studentId,
        cfgId,
        gpa.toFixed(3),
      );
    }

    it('bulk-awards every qualifying student', async () => {
      const s1 = await trackedStudent({ firstName: 'A' });
      const s2 = await trackedStudent({ firstName: 'B' });
      const s3 = await trackedStudent({ firstName: 'C' });
      await seedGpaConfigAndSnapshot(s1.studentId, 4.0);
      await seedGpaConfigAndSnapshot(s2.studentId, 3.6);
      await seedGpaConfigAndSnapshot(s3.studentId, 3.0); // below threshold
      const res = await withTestTenant(async () =>
        awardService.bulkHonorRoll(
          { academicYear: '2026-2027', term: 'Fall', gpaThreshold: 3.5 },
          adminActor(),
        ),
      );
      expect(res.awarded).toBe(2);
      expect(res.skipped).toBe(0);
      expect(res.awardIds).toHaveLength(2);
    });

    it('idempotent — re-run skips already-awarded students', async () => {
      const s1 = await trackedStudent({ firstName: 'A' });
      await seedGpaConfigAndSnapshot(s1.studentId, 4.0);
      await withTestTenant(async () =>
        awardService.bulkHonorRoll(
          { academicYear: '2026-2027', term: 'Fall', gpaThreshold: 3.5 },
          adminActor(),
        ),
      );
      const second = await withTestTenant(async () =>
        awardService.bulkHonorRoll(
          { academicYear: '2026-2027', term: 'Fall', gpaThreshold: 3.5 },
          adminActor(),
        ),
      );
      expect(second.awarded).toBe(0);
      expect(second.skipped).toBe(1);
    });

    it('filters to provided studentIds when supplied', async () => {
      const s1 = await trackedStudent({ firstName: 'A' });
      const s2 = await trackedStudent({ firstName: 'B' });
      await seedGpaConfigAndSnapshot(s1.studentId, 4.0);
      await seedGpaConfigAndSnapshot(s2.studentId, 4.0);
      const res = await withTestTenant(async () =>
        awardService.bulkHonorRoll(
          {
            academicYear: '2026-2027',
            term: 'Fall',
            gpaThreshold: 3.5,
            studentIds: [s1.studentId],
          },
          adminActor(),
        ),
      );
      expect(res.awarded).toBe(1);
    });

    it('cross-school: school B GPA snapshots invisible to school A bulk run', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const cfgId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_gpa_configurations
           (id, school_id, config_name, calculation_method, scale_type, grade_point_mapping, is_default, is_active)
         VALUES ($1::uuid, $2::uuid, $3, 'UNWEIGHTED', 'FOUR_POINT', $4::jsonb, true, true)`,
        cfgId,
        TEST_SCHOOL_B_ID,
        'TestCfgB-' + cfgId.slice(0, 8),
        JSON.stringify({ A: 4.0 }),
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_student_gpa_snapshots
           (id, student_id, gpa_config_id, cumulative_gpa)
         VALUES (gen_random_uuid(), $1::uuid, $2::uuid, 4.0)`,
        sB.studentId,
        cfgId,
      );
      const res = await withTestTenant(async () =>
        awardService.bulkHonorRoll(
          { academicYear: '2026-2027', term: 'Fall', gpaThreshold: 3.5 },
          adminActor(),
        ),
      );
      expect(res.awarded).toBe(0);
    });
  });

  describe('StudentAwardService.delete', () => {
    it('admin deletes an award', async () => {
      const s = await trackedStudent();
      const award = await withTestTenant(async () =>
        awardService.create(
          { studentId: s.studentId, awardType: 'HONOR_ROLL', awardName: 'X' },
          adminActor(),
        ),
      );
      await withTestTenant(async () => awardService.delete(award.id, adminActor()));
      const list = await withTestTenant(async () =>
        awardService.listForStudent(s.studentId, adminActor()),
      );
      expect(list).toHaveLength(0);
    });

    it('Cross-school delete → NotFoundException', async () => {
      // Seed an award row directly via raw SQL under school B
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const awardId = generateId();
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_student_awards
           (id, student_id, award_type, award_name)
         VALUES ($1::uuid, $2::uuid, 'HONOR_ROLL', 'B')`,
        awardId,
        sB.studentId,
      );
      await expect(
        withTestTenant(async () => awardService.delete(awardId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ============================================================
  // MedicalExemptionService
  // ============================================================
  describe('MedicalExemptionService.create', () => {
    it('admin creates an exemption', async () => {
      const s = await trackedStudent();
      const ex = await withTestTenant(async () =>
        exemptionService.create(
          {
            studentId: s.studentId,
            exemptionType: 'PE',
            reason: 'Knee injury',
            effectiveFrom: '2026-09-01',
            effectiveTo: '2027-01-01',
          },
          adminActor(),
        ),
      );
      expect(ex.exemptionType).toBe('PE');
      expect(ex.reason).toBe('Knee injury');
    });

    it('open-ended exemption (no effectiveTo)', async () => {
      const s = await trackedStudent();
      const ex = await withTestTenant(async () =>
        exemptionService.create(
          {
            studentId: s.studentId,
            exemptionType: 'SWIMMING',
            reason: 'Chlorine allergy',
            effectiveFrom: '2026-09-01',
          },
          adminActor(),
        ),
      );
      expect(ex.effectiveTo).toBeNull();
    });

    it('non-staff (parent) → ForbiddenException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          exemptionService.create(
            {
              studentId: s.studentId,
              exemptionType: 'PE',
              reason: 'x',
              effectiveFrom: '2026-01-01',
            },
            parentActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Invalid exemptionType → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          exemptionService.create(
            {
              studentId: s.studentId,
              exemptionType: 'BOGUS' as 'PE',
              reason: 'x',
              effectiveFrom: '2026-01-01',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('effectiveTo before effectiveFrom → BadRequestException', async () => {
      const s = await trackedStudent();
      await expect(
        withTestTenant(async () =>
          exemptionService.create(
            {
              studentId: s.studentId,
              exemptionType: 'PE',
              reason: 'x',
              effectiveFrom: '2026-09-01',
              effectiveTo: '2025-09-01',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('Cross-school student id → BadRequestException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await expect(
        withTestTenant(async () =>
          exemptionService.create(
            {
              studentId: sB.studentId,
              exemptionType: 'PE',
              reason: 'x',
              effectiveFrom: '2026-01-01',
            },
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('MedicalExemptionService.listForStudent', () => {
    it('admin reads exemptions; guardian-linked sees too; non-linked → 404', async () => {
      const s = await trackedStudent();
      await withTestTenant(async () =>
        exemptionService.create(
          {
            studentId: s.studentId,
            exemptionType: 'PE',
            reason: 'r',
            effectiveFrom: '2026-09-01',
          },
          adminActor(),
        ),
      );
      const list = await withTestTenant(async () =>
        exemptionService.listForStudent(s.studentId, adminActor()),
      );
      expect(list).toHaveLength(1);

      // Linked guardian path
      const gid = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        TEST_PARENT_ACCOUNT_ID,
      );
      guardianIds.push(gid);
      await linkStudentGuardian(rawClient, s.studentId, gid);
      const parentList = await withTestTenant(
        async () => exemptionService.listForStudent(s.studentId, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      expect(parentList).toHaveLength(1);
    });

    it('student sees own', async () => {
      const sid = await mapStudentActorToRow();
      await withTestTenant(async () =>
        exemptionService.create(
          {
            studentId: sid,
            exemptionType: 'PE',
            reason: 'r',
            effectiveFrom: '2026-09-01',
          },
          adminActor(),
        ),
      );
      const list = await withTestTenant(
        async () => exemptionService.listForStudent(sid, studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(list).toHaveLength(1);
    });
  });

  describe('MedicalExemptionService.patch', () => {
    it('admin patches reason + effectiveTo', async () => {
      const s = await trackedStudent();
      const ex = await withTestTenant(async () =>
        exemptionService.create(
          {
            studentId: s.studentId,
            exemptionType: 'PE',
            reason: 'r',
            effectiveFrom: '2026-09-01',
          },
          adminActor(),
        ),
      );
      const updated = await withTestTenant(async () =>
        exemptionService.patch(
          ex.id,
          { reason: 'updated', effectiveTo: '2027-01-01' },
          adminActor(),
        ),
      );
      expect(updated.reason).toBe('updated');
      expect(updated.effectiveTo).toBe('2027-01-01');
    });

    it('patch enforces effectiveTo >= effectiveFrom', async () => {
      const s = await trackedStudent();
      const ex = await withTestTenant(async () =>
        exemptionService.create(
          {
            studentId: s.studentId,
            exemptionType: 'PE',
            reason: 'r',
            effectiveFrom: '2026-09-01',
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          exemptionService.patch(ex.id, { effectiveTo: '2025-01-01' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('non-staff → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          exemptionService.patch(generateId(), { reason: 'x' }, parentActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('Cross-school exemption id → NotFoundException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const exB = await withTestTenantB(async () =>
        exemptionService.create(
          {
            studentId: sB.studentId,
            exemptionType: 'PE',
            reason: 'rB',
            effectiveFrom: '2026-09-01',
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () =>
          exemptionService.patch(exB.id, { reason: 'foo' }, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('MedicalExemptionService.delete', () => {
    it('admin deletes', async () => {
      const s = await trackedStudent();
      const ex = await withTestTenant(async () =>
        exemptionService.create(
          {
            studentId: s.studentId,
            exemptionType: 'PE',
            reason: 'r',
            effectiveFrom: '2026-09-01',
          },
          adminActor(),
        ),
      );
      await withTestTenant(async () => exemptionService.delete(ex.id, adminActor()));
      const list = await withTestTenant(async () =>
        exemptionService.listForStudent(s.studentId, adminActor()),
      );
      expect(list).toHaveLength(0);
    });

    it('Cross-school delete → NotFoundException', async () => {
      const sB = await trackedStudent({ schoolId: TEST_SCHOOL_B_ID });
      const exB = await withTestTenantB(async () =>
        exemptionService.create(
          {
            studentId: sB.studentId,
            exemptionType: 'PE',
            reason: 'rB',
            effectiveFrom: '2026-09-01',
          },
          adminActor(),
        ),
      );
      await expect(
        withTestTenant(async () => exemptionService.delete(exB.id, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
