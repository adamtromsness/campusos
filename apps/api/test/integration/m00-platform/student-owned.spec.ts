import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { ForbiddenException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { assertStudentOwnsRecord } from '@shared/auth/student-owned.guard';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';
import type { ResolvedActor } from '@modules/m00-platform/iam/actor-context.service';

import { withTestTenant, TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import { adminActor, officerActor, teacherActor, parentActor } from '../helpers/actor';

/**
 * Wave 2 — DB-backed integration tests for assertStudentOwnsRecord.
 *
 * Strategy doc Wave 2 contracts:
 *   - Student writing OWN record → ok
 *   - Other student → reject
 *   - Teacher without delegation → reject
 *   - School admin → ok (when allowAdminOverride !== false)
 *   - allowAdminOverride=false: even admin must be the owning student
 *   - Coach with allowCoachDelegation=true (STAFF + employeeId) → ok
 *     (stubbed-true path; iam_delegations Phase 2 H2 will tighten)
 *
 * Resolution: STUDENT actor's personId is resolved to sis_students.id
 * via platform_students.person_id within the current tenant.
 */
describe('integration:m00-platform/student-owned (assertStudentOwnsRecord)', () => {
  let tenantPrisma: TenantPrismaService;
  let rawClient: PrismaClient;

  beforeAll(async () => {
    tenantPrisma = new TenantPrismaService();
    rawClient = new PrismaClient();
    await rawClient.$connect();
  });

  afterAll(async () => {
    await tenantPrisma.onModuleDestroy();
    await rawClient.$disconnect();
  });

  const createdPersonIds: string[] = [];
  const createdPlatformStudentIds: string[] = [];

  beforeEach(async () => {
    await rawClient.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE student_number LIKE 'SO-TEST-%'`,
    );
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
  });

  /** Seed a sis_students row + return the studentId and the student's personId. */
  async function seedStudent(): Promise<{ studentId: string; personId: string }> {
    const personId = generateId();
    const platformStudentId = generateId();
    const studentId = generateId();
    createdPersonIds.push(personId);
    createdPlatformStudentIds.push(platformStudentId);
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'SO', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'SO', 'Student', true) ON CONFLICT (id) DO NOTHING`,
      platformStudentId,
      personId,
    );
    await rawClient.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '5')`,
      studentId,
      platformStudentId,
      TEST_SCHOOL_ID,
      'SO-TEST-' + studentId,
    );
    return { studentId, personId };
  }

  function studentActorFor(personId: string): ResolvedActor {
    return {
      accountId: generateId(),
      personId,
      employeeId: null,
      personType: 'STUDENT',
      isSchoolAdmin: false,
    };
  }

  // ────────────────────────────────────────────────────────────────────
  // Admin override
  // ────────────────────────────────────────────────────────────────────
  describe('admin override', () => {
    it('school admin → passes silently (default allowAdminOverride=true)', async () => {
      const { studentId } = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(adminActor(), studentId, tenantPrisma),
        ).resolves.toBeUndefined();
      });
    });

    it('allowAdminOverride=false: admin must still be the owning student → ForbiddenException', async () => {
      const { studentId } = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(adminActor(), studentId, tenantPrisma, {
            allowAdminOverride: false,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // STUDENT actor — own record vs another student's
  // ────────────────────────────────────────────────────────────────────
  describe('STUDENT actor', () => {
    it('STUDENT writing OWN record → ok', async () => {
      const { studentId, personId } = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(studentActorFor(personId), studentId, tenantPrisma),
        ).resolves.toBeUndefined();
      });
    });

    it("STUDENT writing ANOTHER student's record → ForbiddenException", async () => {
      const me = await seedStudent();
      const other = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(studentActorFor(me.personId), other.studentId, tenantPrisma),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('STUDENT actor without a bridged sis_students row → ForbiddenException', async () => {
      // personId that doesn't resolve through platform_students → sis_students
      const orphanPersonId = generateId();
      createdPersonIds.push(orphanPersonId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'Orphan', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
        orphanPersonId,
      );
      const target = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(studentActorFor(orphanPersonId), target.studentId, tenantPrisma),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('STUDENT actor whose sis_students row is in ANOTHER school → ForbiddenException', async () => {
      // Manually seed a student linked to School B
      const personId = generateId();
      const platformStudentId = generateId();
      const studentInSchoolB = generateId();
      createdPersonIds.push(personId);
      createdPlatformStudentIds.push(platformStudentId);
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
         VALUES ($1::uuid, 'B', 'Student', 'STUDENT', true) ON CONFLICT (id) DO NOTHING`,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
         VALUES ($1::uuid, $2::uuid, 'B', 'Student', true) ON CONFLICT (id) DO NOTHING`,
        platformStudentId,
        personId,
      );
      await rawClient.$executeRawUnsafe(
        `INSERT INTO ${TEST_SCHEMA}.sis_students (id, platform_student_id, school_id, student_number, grade_level)
         VALUES ($1::uuid, $2::uuid, '019e0cf8-aaaa-7777-8888-00000000000b'::uuid, $3, '5')`,
        studentInSchoolB,
        platformStudentId,
        'SO-TEST-' + studentInSchoolB,
      );

      // Use School A context — student doesn't resolve in this tenant
      const target = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(studentActorFor(personId), target.studentId, tenantPrisma),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Non-STUDENT non-admin actors
  // ────────────────────────────────────────────────────────────────────
  describe('non-STUDENT non-admin actors', () => {
    it.each([
      ['officer', officerActor],
      ['teacher', teacherActor],
      ['parent', parentActor],
    ])('%s without coach delegation → ForbiddenException', async (_label, actor) => {
      const target = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(actor(), target.studentId, tenantPrisma),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('STAFF with allowCoachDelegation=true and an employeeId → passes (stubbed-true path)', async () => {
      const target = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(officerActor(), target.studentId, tenantPrisma, {
            allowCoachDelegation: true,
          }),
        ).resolves.toBeUndefined();
      });
    });

    it('STAFF with allowCoachDelegation=true but NO employeeId → ForbiddenException', async () => {
      const target = await seedStudent();
      const staffWithoutEmployeeId: ResolvedActor = {
        ...officerActor(),
        employeeId: null,
      };
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(staffWithoutEmployeeId, target.studentId, tenantPrisma, {
            allowCoachDelegation: true,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });

    it('PARENT with allowCoachDelegation=true → still denied (parents are not STAFF)', async () => {
      const target = await seedStudent();
      await withTestTenant(async () => {
        await expect(
          assertStudentOwnsRecord(parentActor(), target.studentId, tenantPrisma, {
            allowCoachDelegation: true,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      });
    });
  });

  // ────────────────────────────────────────────────────────────────────
  // Capability label appears in the error message (used by audit logging)
  // ────────────────────────────────────────────────────────────────────
  describe('capability label in error messages', () => {
    it('uses the supplied capability in the not-owning-student error', async () => {
      const me = await seedStudent();
      const other = await seedStudent();
      await withTestTenant(async () => {
        let caught: Error | undefined;
        try {
          await assertStudentOwnsRecord(
            studentActorFor(me.personId),
            other.studentId,
            tenantPrisma,
            { capability: 'recruiting profile' },
          );
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).toBeDefined();
        expect(caught!.message).toContain('recruiting profile');
      });
    });

    it('default capability label is "this record"', async () => {
      const target = await seedStudent();
      await withTestTenant(async () => {
        let caught: Error | undefined;
        try {
          await assertStudentOwnsRecord(parentActor(), target.studentId, tenantPrisma);
        } catch (err) {
          caught = err as Error;
        }
        expect(caught).toBeDefined();
        expect(caught!.message).toContain('this record');
      });
    });
  });
});
