import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';

import { StudentService } from '@modules/m20-sis/students/student.service';
import { PersonaResolutionService } from '@modules/m00-platform/iam/persona-resolution.service';
import { TenantPrismaService } from '@shared/tenant/tenant-prisma.service';

import { withTestTenant, TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { adminActor } from '../helpers/actor';

/**
 * Auto-alumni — persona-registration Step 14 (Section 4 of the
 * design). When a school admin flips sis_students.enrollment_status
 * to GRADUATED via StudentService.update, the service should:
 *   1. Insert into alm_alumni_profiles (idempotent — UNIQUE
 *      (school_id, person_id) means re-graduation is a no-op).
 *   2. Refresh the student's persona cache so ALUMNI surfaces on
 *      the next /auth/me / persona switcher render.
 *
 * Today the codebase has no sis.student.graduated Kafka event; the
 * hook lives synchronously in StudentService.update. If a graduation
 * event ships later, the hook can move to a consumer with the same
 * UPSERT + refresh logic.
 */
describe('integration:m102-alumni/auto-alumni', () => {
  let prisma: PrismaClient;
  let tenantPrisma: TenantPrismaService;
  let students: StudentService;
  let personaResolution: PersonaResolutionService;

  // Fresh person + platform_student + sis_student per test so each
  // case starts from a clean slate. IDs are stable per-suite for
  // afterAll cleanup.
  const personId = generateId();
  const platformStudentId = generateId();
  const sisStudentId = generateId();

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    tenantPrisma = new TenantPrismaService();
    personaResolution = new PersonaResolutionService(prisma, tenantPrisma);
    students = new StudentService(tenantPrisma, personaResolution);

    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, 'Auto', 'Alumni', 'STUDENT', true)
       ON CONFLICT (id) DO NOTHING`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Auto', 'Alumni', true)
       ON CONFLICT (id) DO NOTHING`,
      platformStudentId,
      personId,
    );
  });

  afterAll(async () => {
    // Tear down in FK-safe order.
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.alm_alumni_profiles WHERE person_id = $1::uuid`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
      sisStudentId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE id = $1::uuid`,
      platformStudentId,
    );
    await prisma.$executeRawUnsafe(`DELETE FROM platform.iam_person WHERE id = $1::uuid`, personId);
    await tenantPrisma.onModuleDestroy();
    await prisma.$disconnect();
  });

  beforeEach(async () => {
    // Reset per-test sis_students + alm_alumni_profiles + cached
    // personas so each test is independent.
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.alm_alumni_profiles WHERE person_id = $1::uuid`,
      personId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = $1::uuid`,
      sisStudentId,
    );
    await prisma.$executeRawUnsafe(
      `DELETE FROM platform.platform_personas WHERE person_id = $1::uuid`,
      personId,
    );
    // Seed a fresh ENROLLED student row that the test will graduate.
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'ENROLLED')`,
      sisStudentId,
      platformStudentId,
      TEST_SCHOOL_ID,
    );
  });

  it('graduating a student inserts alm_alumni_profiles + activates ALUMNI persona', async () => {
    await withTestTenant(async () => {
      await students.update(sisStudentId, { enrollmentStatus: 'GRADUATED' }, adminActor());
    });

    const alumni = await prisma.$queryRawUnsafe<Array<{ id: string; graduation_year: number }>>(
      `SELECT id::text AS id, graduation_year FROM ${TEST_SCHEMA}.alm_alumni_profiles
       WHERE person_id = $1::uuid AND school_id = $2::uuid`,
      personId,
      TEST_SCHOOL_ID,
    );
    expect(alumni.length).toBe(1);
    expect(alumni[0]!.graduation_year).toBe(new Date().getUTCFullYear());

    const persona = await prisma.platformPersona.findFirst({
      where: { personId, type: 'ALUMNI', schoolId: TEST_SCHOOL_ID },
    });
    expect(persona).toBeTruthy();
    expect(persona!.label).toContain('Alumni');
  });

  it('idempotent — re-graduating produces no duplicate alm_alumni_profiles row', async () => {
    await withTestTenant(async () => {
      await students.update(sisStudentId, { enrollmentStatus: 'GRADUATED' }, adminActor());
    });

    // Flip back to ENROLLED then re-graduate. The UPSERT means the
    // alumni profile stays at the original row id.
    await withTestTenant(async () => {
      await students.update(sisStudentId, { enrollmentStatus: 'ENROLLED' }, adminActor());
    });
    await withTestTenant(async () => {
      await students.update(sisStudentId, { enrollmentStatus: 'GRADUATED' }, adminActor());
    });

    const alumni = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.alm_alumni_profiles
       WHERE person_id = $1::uuid AND school_id = $2::uuid`,
      personId,
      TEST_SCHOOL_ID,
    );
    expect(alumni.length).toBe(1);
  });

  it('non-graduation status update does NOT create alumni profile', async () => {
    await withTestTenant(async () => {
      await students.update(sisStudentId, { enrollmentStatus: 'TRANSFERRED' }, adminActor());
    });

    const alumni = await prisma.$queryRawUnsafe<Array<{ id: string }>>(
      `SELECT id::text AS id FROM ${TEST_SCHEMA}.alm_alumni_profiles
       WHERE person_id = $1::uuid`,
      personId,
    );
    expect(alumni.length).toBe(0);

    const persona = await prisma.platformPersona.findFirst({
      where: { personId, type: 'ALUMNI' },
    });
    expect(persona).toBeNull();
  });
});
