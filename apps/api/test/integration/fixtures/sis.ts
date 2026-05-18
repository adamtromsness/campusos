import type { PrismaClient } from '@prisma/client';
import { TEST_SCHOOL_ID, TEST_SCHOOL_B_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * Wave 4 — m20-sis fixtures.
 *
 * Shared SIS infrastructure rows the m20-sis (and downstream m21/m22)
 * integration suites need: academic years (current + School B counterpart),
 * a department, a course, a class, and a class-teacher row that ties the
 * test teacher actor to a class. Per-test rows (students, guardians,
 * relationships, notes, attendance) are created inside each spec file's
 * beforeEach/seed helpers because they have per-test variability.
 *
 * IDs follow the suite convention: `019e0cf8-aaaa-7777-8888-0000000002xx`
 * for canonical academic structure, with `aaaa-7777-8888-00000000b2xx`
 * mirrors on School B. Static so cross-test references don't drift.
 */
export const TEST_SIS_ACADEMIC_YEAR_ID = '019e0cf8-aaaa-7777-8888-000000000200';
export const TEST_SIS_TERM_ID = '019e0cf8-aaaa-7777-8888-000000000201';
export const TEST_SIS_DEPARTMENT_ID = '019e0cf8-aaaa-7777-8888-000000000202';
export const TEST_SIS_COURSE_ID = '019e0cf8-aaaa-7777-8888-000000000203';
export const TEST_SIS_CLASS_ID = '019e0cf8-aaaa-7777-8888-000000000204';
export const TEST_SIS_FAMILY_ID = '019e0cf8-aaaa-7777-8888-000000000205';

// School B mirrors — same schema, school_id=TEST_SCHOOL_B_ID. Used by
// cross-school isolation tests.
export const TEST_SIS_ACADEMIC_YEAR_B_ID = '019e0cf8-aaaa-7777-8888-00000000b200';
export const TEST_SIS_DEPARTMENT_B_ID = '019e0cf8-aaaa-7777-8888-00000000b202';
export const TEST_SIS_COURSE_B_ID = '019e0cf8-aaaa-7777-8888-00000000b203';
export const TEST_SIS_CLASS_B_ID = '019e0cf8-aaaa-7777-8888-00000000b204';
export const TEST_SIS_FAMILY_B_ID = '019e0cf8-aaaa-7777-8888-00000000b205';

export async function ensureSisFixtures(prisma: PrismaClient): Promise<void> {
  // School A — academic year. Distinct from the finance fixture year so
  // they coexist without colliding on the (school_id, start_date) UNIQUE.
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_academic_years (id, school_id, name, start_date, end_date, is_current)
     VALUES ($1::uuid, $2::uuid, '2026-2027 SIS Test', '2026-08-01', '2027-07-31', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_ACADEMIC_YEAR_ID,
    TEST_SCHOOL_ID,
  );

  // Term — Fall 2026
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_terms (id, academic_year_id, name, start_date, end_date, term_type)
     VALUES ($1::uuid, $2::uuid, 'Fall 2026', '2026-08-01', '2026-12-15', 'SEMESTER')
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_TERM_ID,
    TEST_SIS_ACADEMIC_YEAR_ID,
  );

  // Department
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_departments (id, school_id, name)
     VALUES ($1::uuid, $2::uuid, 'SIS Test Department')
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_DEPARTMENT_ID,
    TEST_SCHOOL_ID,
  );

  // Course
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_courses (id, school_id, department_id, code, name, credit_hours, grade_level)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'SIS-101', 'SIS Test Course', 1.0, '5')
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_COURSE_ID,
    TEST_SCHOOL_ID,
    TEST_SIS_DEPARTMENT_ID,
  );

  // Class — one section
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_classes (id, school_id, course_id, academic_year_id, term_id, section_code, max_enrollment)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'A', 30)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_CLASS_ID,
    TEST_SCHOOL_ID,
    TEST_SIS_COURSE_ID,
    TEST_SIS_ACADEMIC_YEAR_ID,
    TEST_SIS_TERM_ID,
  );

  // Family (sis_families)
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_families (id, organisation_id, family_name, created_by)
     SELECT $1::uuid, organisation_id, 'SIS Test Family', $2::uuid
       FROM platform.schools WHERE id = $3::uuid
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_FAMILY_ID,
    '019e0cf8-aaaa-7777-8888-000000000011', // TEST_ADMIN_ACCOUNT_ID
    TEST_SCHOOL_ID,
  );

  // School B — academic year + department + course + class (cross-school
  // mirror so cross-school SIS tests can seed a foreign-school class and
  // verify isolation).
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_academic_years (id, school_id, name, start_date, end_date, is_current)
     VALUES ($1::uuid, $2::uuid, '2026-2027 SIS Test B', '2026-08-02', '2027-07-30', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_ACADEMIC_YEAR_B_ID,
    TEST_SCHOOL_B_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_departments (id, school_id, name)
     VALUES ($1::uuid, $2::uuid, 'SIS Test Department B')
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_DEPARTMENT_B_ID,
    TEST_SCHOOL_B_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_courses (id, school_id, department_id, code, name, credit_hours, grade_level)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'SIS-101-B', 'SIS Test Course B', 1.0, '5')
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_COURSE_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_SIS_DEPARTMENT_B_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_classes (id, school_id, course_id, academic_year_id, term_id, section_code, max_enrollment)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 'A', 30)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_CLASS_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_SIS_COURSE_B_ID,
    TEST_SIS_ACADEMIC_YEAR_B_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_families (id, organisation_id, family_name, created_by)
     SELECT $1::uuid, organisation_id, 'SIS Test Family B', $2::uuid
       FROM platform.schools WHERE id = $3::uuid
     ON CONFLICT (id) DO NOTHING`,
    TEST_SIS_FAMILY_B_ID,
    '019e0cf8-aaaa-7777-8888-000000000011',
    TEST_SCHOOL_B_ID,
  );
}

export async function assertSisFixtures(prisma: PrismaClient): Promise<void> {
  const checks: Array<{ label: string; sql: string }> = [
    {
      label: 'sis_academic_years (A)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.sis_academic_years WHERE id = '${TEST_SIS_ACADEMIC_YEAR_ID}'::uuid`,
    },
    {
      label: 'sis_classes (A)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.sis_classes WHERE id = '${TEST_SIS_CLASS_ID}'::uuid`,
    },
    {
      label: 'sis_classes (B)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.sis_classes WHERE id = '${TEST_SIS_CLASS_B_ID}'::uuid`,
    },
    {
      label: 'sis_families (A)',
      sql: `SELECT 1 FROM ${TEST_SCHEMA}.sis_families WHERE id = '${TEST_SIS_FAMILY_ID}'::uuid`,
    },
  ];
  for (const check of checks) {
    const rows = (await prisma.$queryRawUnsafe(check.sql)) as unknown[];
    if (rows.length === 0) {
      throw new Error(
        `Integration test fixture missing: ${check.label}. Re-run globalSetup or delete tenant_test and try again.`,
      );
    }
  }
}
