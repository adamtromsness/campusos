import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

import { StudentService } from '@modules/m20-sis/students/student.service';
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
} from '../helpers/actor';
import {
  seedStudent,
  seedGuardian,
  linkStudentGuardian,
  enrollStudent,
  assignTeacherToClass,
  cleanupSeededIds,
  ensureGuardianForPerson,
} from './sis-helpers';
import { TEST_SIS_CLASS_ID, TEST_SIS_CLASS_B_ID } from '../fixtures/sis';

/**
 * Wave 4 — m20-sis StudentService DB-backed integration tests.
 *
 * Contracts verified:
 *   - create() inserts platform.iam_person + platform.platform_students +
 *     tenant.sis_students atomically; rolls back on uniqueness violation.
 *   - getById / list / assertCanViewStudent respect the visibility
 *     predicate (admin → all, teacher → roster, student → self,
 *     guardian → linked children, other → none).
 *   - update() rejects non-admin actors via ForbiddenException.
 *   - Cross-school isolation: a School A actor sees no School B
 *     students even when targeting their ids directly (404 collapses
 *     the existence probe).
 */
describe('integration:m20-sis/student-crud', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;
  let service: StudentService;

  // Per-test trackers (cleaned in beforeEach of next test). The arrays
  // are referenced by both seed helpers and cleanupSeededIds.
  const personIds: string[] = [];
  const platformStudentIds: string[] = [];
  const studentIds: string[] = [];
  const guardianIds: string[] = [];
  const accountIds: string[] = [];

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
    service = new StudentService(tenantPrisma);
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  beforeEach(async () => {
    await cleanupSeededIds(rawClient, {
      studentIds: studentIds.splice(0),
      platformStudentIds: platformStudentIds.splice(0),
      guardianIds: guardianIds.splice(0),
      personIds: personIds.splice(0),
      accountIds: accountIds.splice(0),
    });
  });

  async function trackedSeedStudent(opts: Parameters<typeof seedStudent>[1] = {}) {
    const s = await seedStudent(rawClient, opts);
    studentIds.push(s.studentId);
    platformStudentIds.push(s.platformStudentId);
    personIds.push(s.personId);
    return s;
  }

  async function trackedSeedGuardian(opts: Parameters<typeof seedGuardian>[1] = {}) {
    const g = await seedGuardian(rawClient, opts);
    guardianIds.push(g.guardianId);
    personIds.push(g.personId);
    accountIds.push(g.accountId);
    return g;
  }

  // ────────────────────────────────────────────────────────────────────
  // create — admin-only, atomic across three tables, 409 on duplicate
  // ────────────────────────────────────────────────────────────────────
  describe('create', () => {
    it('admin creates a student → inserts iam_person + platform_students + sis_students', async () => {
      const studentNumber = 'CR-' + Date.now();
      const dto = {
        firstName: 'Alice',
        lastName: 'Anderson',
        studentNumber,
        gradeLevel: '6',
      };
      const created = await withTestTenant(async () => service.create(dto as any, adminActor()));
      // Track for cleanup
      studentIds.push(created.id);
      platformStudentIds.push(created.platformStudentId);
      personIds.push(created.personId);

      expect(created.firstName).toBe('Alice');
      expect(created.studentNumber).toBe(studentNumber);
      expect(created.schoolId).toBe(TEST_SCHOOL_ID);

      // Verify the three tables were written
      const rows = (await rawClient.$queryRawUnsafe(
        `SELECT s.id::text AS sid, s.school_id::text AS school_id, ip.first_name, ps.id::text AS psid
           FROM ${TEST_SCHEMA}.sis_students s
           JOIN platform.platform_students ps ON ps.id = s.platform_student_id
           JOIN platform.iam_person ip ON ip.id = ps.person_id
           WHERE s.id = $1::uuid`,
        created.id,
      )) as Array<{ sid: string; school_id: string; first_name: string; psid: string }>;
      expect(rows).toHaveLength(1);
      expect(rows[0]!.first_name).toBe('Alice');
      expect(rows[0]!.school_id).toBe(TEST_SCHOOL_ID);
    });

    it('non-admin caller → ForbiddenException', async () => {
      await expect(
        withTestTenant(async () =>
          service.create(
            { firstName: 'Bob', lastName: 'Brown', studentNumber: 'NX-1', gradeLevel: '7' } as any,
            teacherActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('duplicate student_number for the same school → ConflictException', async () => {
      const dup = 'DUP-' + Date.now();
      const first = await withTestTenant(async () =>
        service.create(
          { firstName: 'C', lastName: 'C', studentNumber: dup, gradeLevel: '5' } as any,
          adminActor(),
        ),
      );
      studentIds.push(first.id);
      platformStudentIds.push(first.platformStudentId);
      personIds.push(first.personId);

      await expect(
        withTestTenant(async () =>
          service.create(
            { firstName: 'D', lastName: 'D', studentNumber: dup, gradeLevel: '5' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('same student_number across different schools → both succeed', async () => {
      const num = 'XS-' + Date.now();
      // School A — via service create
      const a = await withTestTenant(async () =>
        service.create(
          { firstName: 'Sa', lastName: 'Sa', studentNumber: num, gradeLevel: '5' } as any,
          adminActor(),
        ),
      );
      studentIds.push(a.id);
      platformStudentIds.push(a.platformStudentId);
      personIds.push(a.personId);

      // School B — via service create with switched tenant context
      const b = await withTestTenantB(async () =>
        service.create(
          { firstName: 'Sb', lastName: 'Sb', studentNumber: num, gradeLevel: '5' } as any,
          adminActor(),
        ),
      );
      studentIds.push(b.id);
      platformStudentIds.push(b.platformStudentId);
      personIds.push(b.personId);

      expect(a.studentNumber).toBe(num);
      expect(b.studentNumber).toBe(num);
      expect(a.schoolId).not.toBe(b.schoolId);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // getById / list — visibility predicate by persona
  // ────────────────────────────────────────────────────────────────────
  describe('read', () => {
    it('admin: list returns all school students', async () => {
      const s1 = await trackedSeedStudent({ firstName: 'A', lastName: 'A' });
      const s2 = await trackedSeedStudent({ firstName: 'B', lastName: 'B' });
      const list = await withTestTenant(async () => service.list({}, adminActor()));
      const ids = list.map((r) => r.id);
      expect(ids).toContain(s1.studentId);
      expect(ids).toContain(s2.studentId);
    });

    it('admin: getById returns the student', async () => {
      const s = await trackedSeedStudent();
      const dto = await withTestTenant(async () => service.getById(s.studentId, adminActor()));
      expect(dto.id).toBe(s.studentId);
    });

    it('admin: getById on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.getById('00000000-0000-0000-0000-000000000000', adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('student persona: getSelfForStudent finds own row', async () => {
      // Map student actor.personId → a sis_students row
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
           VALUES ($1::uuid, $2::uuid, 'Self', 'Student', true)
           ON CONFLICT (id) DO NOTHING`,
        '019e0cf8-aaaa-7777-8888-000000000042',
        TEST_STUDENT_PERSON_ID,
      );
      platformStudentIds.push('019e0cf8-aaaa-7777-8888-000000000042');
      // sis_students row pointing to this platform_students
      const sid = '019e0cf8-aaaa-7777-8888-000000000043';
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students
           (id, platform_student_id, school_id, student_number, grade_level)
         VALUES ($1::uuid, $2::uuid, $3::uuid, 'SELF-1', '5')
         ON CONFLICT (id) DO NOTHING`,
        sid,
        '019e0cf8-aaaa-7777-8888-000000000042',
        TEST_SCHOOL_ID,
      );
      studentIds.push(sid);

      const self = await withTestTenant(
        async () => service.getSelfForStudent(studentActor()),
        { personId: TEST_STUDENT_PERSON_ID },
      );
      expect(self.id).toBe(sid);
    });

    it('student persona: getSelfForStudent → 404 when no sis_students row exists', async () => {
      // Make sure no row exists (cleanup already ran)
      await expect(
        withTestTenant(
          async () => service.getSelfForStudent(studentActor()),
          { personId: TEST_STUDENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('non-STUDENT persona calling getSelfForStudent → 404', async () => {
      await expect(
        withTestTenant(async () => service.getSelfForStudent(adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('guardian persona: list returns only linked children; non-linked invisible', async () => {
      const myKid = await trackedSeedStudent({ firstName: 'My', lastName: 'Kid' });
      const otherKid = await trackedSeedStudent({ firstName: 'Other', lastName: 'Kid' });
      // Link parentActor() → myKid (parentActor's personId already exists
      // via globalSetup as a GUARDIAN iam_person). Cross-spec safety: a
      // sis_guardians row for (TEST_SCHOOL_ID, TEST_PARENT_PERSON_ID) may
      // already exist from a sibling spec's leftover row. Take whichever
      // guardian_id is present after the upsert, then track it for cleanup.
      const guardianId = await ensureGuardianForPerson(
        rawClient,
        TEST_PARENT_PERSON_ID,
        '019e0cf8-aaaa-7777-8888-000000000051',
      );
      guardianIds.push(guardianId);
      await linkStudentGuardian(rawClient, myKid.studentId, guardianId);

      const list = await withTestTenant(
        async () => service.list({}, parentActor()),
        { personId: TEST_PARENT_PERSON_ID },
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(myKid.studentId);
      expect(ids).not.toContain(otherKid.studentId);

      // Direct getById on the unlinked sibling collapses to 404
      await expect(
        withTestTenant(
          async () => service.getById(otherKid.studentId, parentActor()),
          { personId: TEST_PARENT_PERSON_ID },
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher persona: list returns only enrolled-class roster', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_ID);
      const enrolled = await trackedSeedStudent({ firstName: 'In', lastName: 'Class' });
      const unenrolled = await trackedSeedStudent({ firstName: 'Not', lastName: 'In' });
      await enrollStudent(rawClient, enrolled.studentId);

      const list = await withTestTenant(async () => service.list({}, teacherActor()));
      const ids = list.map((r) => r.id);
      expect(ids).toContain(enrolled.studentId);
      expect(ids).not.toContain(unenrolled.studentId);
    });

    it('list with classId filter narrows roster', async () => {
      const s = await trackedSeedStudent({ firstName: 'Filtered', lastName: 'Student' });
      await enrollStudent(rawClient, s.studentId);
      const list = await withTestTenant(async () =>
        service.list({ classId: TEST_SIS_CLASS_ID } as any, adminActor()),
      );
      expect(list.map((r) => r.id)).toContain(s.studentId);
    });

    it('list with gradeLevel filter narrows by grade', async () => {
      const a = await trackedSeedStudent({ gradeLevel: '5', firstName: 'F5', lastName: 'A' });
      const b = await trackedSeedStudent({ gradeLevel: '6', firstName: 'F6', lastName: 'B' });
      const list = await withTestTenant(async () =>
        service.list({ gradeLevel: '5' } as any, adminActor()),
      );
      const ids = list.map((r) => r.id);
      expect(ids).toContain(a.studentId);
      expect(ids).not.toContain(b.studentId);
    });

    it('listForGuardianPerson returns linked-children rows', async () => {
      const g = await trackedSeedGuardian({ firstName: 'Linker', lastName: 'P' });
      const child = await trackedSeedStudent({ firstName: 'Linked', lastName: 'Child' });
      await linkStudentGuardian(rawClient, child.studentId, g.guardianId);

      const list = await withTestTenant(async () =>
        service.listForGuardianPerson(g.personId),
      );
      expect(list.map((r) => r.id)).toContain(child.studentId);
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // update — admin-only
  // ────────────────────────────────────────────────────────────────────
  describe('update', () => {
    it('admin updates fields → row reflected on next read', async () => {
      const s = await trackedSeedStudent({ gradeLevel: '5' });
      const updated = await withTestTenant(async () =>
        service.update(s.studentId, { gradeLevel: '6' } as any, adminActor()),
      );
      expect(updated.gradeLevel).toBe('6');
    });

    it('non-admin → ForbiddenException', async () => {
      const s = await trackedSeedStudent();
      await expect(
        withTestTenant(async () =>
          service.update(s.studentId, { gradeLevel: '6' } as any, teacherActor()),
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('update on unknown id → NotFoundException', async () => {
      await expect(
        withTestTenant(async () =>
          service.update(
            '00000000-0000-0000-0000-000000000000',
            { gradeLevel: '6' } as any,
            adminActor(),
          ),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('update with empty patch → BadRequestException', async () => {
      const s = await trackedSeedStudent();
      await expect(
        withTestTenant(async () => service.update(s.studentId, {} as any, adminActor())),
      ).rejects.toThrow(/No fields to update/);
    });

    it('admin updates studentNumber, homeroomClassId, enrollmentStatus → row reflects new values', async () => {
      const s = await trackedSeedStudent({ gradeLevel: '5' });
      const fresh = 'UPD-' + Date.now();
      const updated = await withTestTenant(async () =>
        service.update(
          s.studentId,
          {
            studentNumber: fresh,
            homeroomClassId: TEST_SIS_CLASS_ID,
            enrollmentStatus: 'TRANSFERRED',
          } as any,
          adminActor(),
        ),
      );
      expect(updated.studentNumber).toBe(fresh);
      expect(updated.homeroomClassId).toBe(TEST_SIS_CLASS_ID);
      expect(updated.enrollmentStatus).toBe('TRANSFERRED');
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Cross-school isolation
  // ────────────────────────────────────────────────────────────────────
  describe('cross-school isolation', () => {
    it('School A admin probing School B studentId → NotFoundException', async () => {
      const schoolBStudent = await trackedSeedStudent({
        schoolId: TEST_SCHOOL_B_ID,
        firstName: 'Cross',
        lastName: 'School',
      });

      // School A admin queries → 404
      await expect(
        withTestTenant(async () => service.getById(schoolBStudent.studentId, adminActor())),
      ).rejects.toBeInstanceOf(NotFoundException);

      // School A admin list does not surface the School B row
      const listA = await withTestTenant(async () => service.list({}, adminActor()));
      expect(listA.map((r) => r.id)).not.toContain(schoolBStudent.studentId);
    });

    it('assertCanViewStudent: cross-school student id → 404', async () => {
      const schoolBStudent = await trackedSeedStudent({
        schoolId: TEST_SCHOOL_B_ID,
        firstName: 'Hidden',
        lastName: 'B',
      });
      await expect(
        withTestTenant(async () =>
          service.assertCanViewStudent(schoolBStudent.studentId, adminActor()),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('teacher in School A cannot see School B roster via enrollment', async () => {
      await assignTeacherToClass(rawClient, TEST_SIS_CLASS_B_ID);
      const bStudent = await trackedSeedStudent({ schoolId: TEST_SCHOOL_B_ID });
      await enrollStudent(rawClient, bStudent.studentId, TEST_SIS_CLASS_B_ID);

      // Teacher actor in School A context — should not see B's roster
      const list = await withTestTenant(async () => service.list({}, teacherActor()));
      expect(list.map((r) => r.id)).not.toContain(bStudent.studentId);
    });
  });
});
