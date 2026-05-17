import type { PrismaClient } from '@prisma/client';
import { TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
} from '../helpers/actor';

/**
 * Tenant-side employee fixtures. Like fixtures/platform.ts, these are
 * stable across the entire integration suite and seeded once via
 * globalSetup.
 *
 * Loop 2 (this scaffold): only the admin employee row. The trivial
 * ProcurementSettingsService spec doesn't actually need an hr_employees
 * row (the service reads from tenant context, not actor), but seeding
 * it here matches the design's "one-time per suite" fixture story so
 * later loops don't have to re-seed.
 *
 * Loop 3+ will add officer, teacher, student, and parent rows as the
 * corresponding test suites need them.
 */
export async function ensureEmployeeFixtures(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_employees
       (id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'INT-001', 'FULL_TIME', 'ACTIVE', '2024-01-01')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ADMIN_EMPLOYEE_ID,
    TEST_ADMIN_PERSON_ID,
    TEST_ADMIN_ACCOUNT_ID,
    TEST_SCHOOL_ID,
  );
}

export async function assertEmployeeFixtures(prisma: PrismaClient): Promise<void> {
  const rows = (await prisma.$queryRawUnsafe(
    `SELECT 1 FROM ${TEST_SCHEMA}.hr_employees WHERE id = '${TEST_ADMIN_EMPLOYEE_ID}'::uuid`,
  )) as unknown[];
  if (rows.length === 0) {
    throw new Error(
      'Integration test fixture missing: hr_employees (admin). ' +
        'Re-run globalSetup or delete tenant_test and try again.',
    );
  }
}
