import type { PrismaClient } from '@prisma/client';
import { TEST_SCHOOL_ID, TEST_SCHEMA } from '../helpers/tenant-context';
import {
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_OFFICER_PERSON_ID,
  TEST_OFFICER_ACCOUNT_ID,
  TEST_OFFICER_EMPLOYEE_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';

interface PlatformActor {
  personId: string;
  accountId: string;
  firstName: string;
  lastName: string;
  email: string;
  personType: 'STAFF' | 'STUDENT' | 'GUARDIAN';
}

interface EmployeeRow {
  employeeId: string;
  personId: string;
  accountId: string;
  employeeNumber: string;
}

const PLATFORM_ACTORS: PlatformActor[] = [
  {
    personId: TEST_OFFICER_PERSON_ID,
    accountId: TEST_OFFICER_ACCOUNT_ID,
    firstName: 'Integration',
    lastName: 'Officer',
    email: 'officer@test.integration.local',
    personType: 'STAFF',
  },
  {
    personId: TEST_TEACHER_PERSON_ID,
    accountId: TEST_TEACHER_ACCOUNT_ID,
    firstName: 'Integration',
    lastName: 'Teacher',
    email: 'teacher@test.integration.local',
    personType: 'STAFF',
  },
  {
    personId: TEST_STUDENT_PERSON_ID,
    accountId: TEST_STUDENT_ACCOUNT_ID,
    firstName: 'Integration',
    lastName: 'Student',
    email: 'student@test.integration.local',
    personType: 'STUDENT',
  },
  {
    personId: TEST_PARENT_PERSON_ID,
    accountId: TEST_PARENT_ACCOUNT_ID,
    firstName: 'Integration',
    lastName: 'Parent',
    email: 'parent@test.integration.local',
    personType: 'GUARDIAN',
  },
];

const EMPLOYEE_ROWS: EmployeeRow[] = [
  // Admin row landed in Loop 2 setup; included here too for the assert step.
  {
    employeeId: TEST_ADMIN_EMPLOYEE_ID,
    personId: TEST_ADMIN_PERSON_ID,
    accountId: TEST_ADMIN_ACCOUNT_ID,
    employeeNumber: 'INT-001',
  },
  {
    employeeId: TEST_OFFICER_EMPLOYEE_ID,
    personId: TEST_OFFICER_PERSON_ID,
    accountId: TEST_OFFICER_ACCOUNT_ID,
    employeeNumber: 'INT-002',
  },
  {
    employeeId: TEST_TEACHER_EMPLOYEE_ID,
    personId: TEST_TEACHER_PERSON_ID,
    accountId: TEST_TEACHER_ACCOUNT_ID,
    employeeNumber: 'INT-003',
  },
];

/**
 * Loop 3 expansion. Beyond the admin row from Loop 2:
 *   - Officer + Teacher iam_person + platform_users + hr_employees rows
 *     so the corresponding actor builders return real-DB-backed actors.
 *   - Student + Parent iam_person + platform_users (no hr_employees row
 *     because they're not staff per ADR-055).
 *
 * Idempotent — every INSERT uses ON CONFLICT DO NOTHING. The trivial
 * Loop 2 admin row is included so the seed is a complete snapshot.
 */
export async function ensureEmployeeFixtures(prisma: PrismaClient): Promise<void> {
  // iam_person + platform_users for the Loop 3 actors (admin already seeded
  // in fixtures/platform.ts).
  for (const actor of PLATFORM_ACTORS) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
       VALUES ($1::uuid, $2, $3, $4::platform."PersonType", true)
       ON CONFLICT (id) DO NOTHING`,
      actor.personId,
      actor.firstName,
      actor.lastName,
      actor.personType,
    );
    await prisma.$executeRawUnsafe(
      `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
       VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', 'HUMAN', false)
       ON CONFLICT (id) DO NOTHING`,
      actor.accountId,
      actor.personId,
      actor.email,
      `${actor.firstName} ${actor.lastName}`,
    );
  }

  // hr_employees rows for staff actors (admin + officer + teacher).
  for (const emp of EMPLOYEE_ROWS) {
    await prisma.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.hr_employees
         (id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'FULL_TIME', 'ACTIVE', '2024-01-01')
       ON CONFLICT (id) DO NOTHING`,
      emp.employeeId,
      emp.personId,
      emp.accountId,
      TEST_SCHOOL_ID,
      emp.employeeNumber,
    );
  }
}

export async function assertEmployeeFixtures(prisma: PrismaClient): Promise<void> {
  for (const emp of EMPLOYEE_ROWS) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM ${TEST_SCHEMA}.hr_employees WHERE id = '${emp.employeeId}'::uuid`,
    )) as unknown[];
    if (rows.length === 0) {
      throw new Error(
        `Integration test fixture missing: hr_employees (${emp.employeeNumber}). ` +
          'Re-run globalSetup or delete tenant_test and try again.',
      );
    }
  }
  for (const actor of PLATFORM_ACTORS) {
    const rows = (await prisma.$queryRawUnsafe(
      `SELECT 1 FROM platform.platform_users WHERE id = '${actor.accountId}'::uuid`,
    )) as unknown[];
    if (rows.length === 0) {
      throw new Error(
        `Integration test fixture missing: platform_users (${actor.email}). ` +
          'Re-run globalSetup or delete tenant_test and try again.',
      );
    }
  }
}
