import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import {
  TEST_SIS_ACADEMIC_YEAR_ID,
  TEST_SIS_ACADEMIC_YEAR_B_ID,
} from './sis';
import {
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
} from '../helpers/actor';

/**
 * Wave 7 — m64-clubs fixtures.
 *
 * Tests reset every ext_* table and call ensureClubsSeed to lay down
 * canonical activity types + activity per school, plus a couple of
 * service programmes. IDs are deterministic so cross-school isolation
 * tests can reliably reference School B's seeds.
 *
 * The seeded activity is owned by the test admin's hr_employees row.
 * Per-test specs may seed additional advisors / activities / elections
 * / field trips on top.
 */
export const TEST_ACTIVITY_TYPE_SPORT_ID = '019e0cf8-aaaa-7777-8888-000000064001';
export const TEST_ACTIVITY_TYPE_ARTS_ID = '019e0cf8-aaaa-7777-8888-000000064002';
export const TEST_ACTIVITY_TYPE_LEAD_ID = '019e0cf8-aaaa-7777-8888-000000064003';
export const TEST_ACTIVITY_TYPE_B_SPORT_ID = '019e0cf8-aaaa-7777-8888-000000064004';

export const TEST_ACTIVITY_A_ID = '019e0cf8-aaaa-7777-8888-000000064010';
export const TEST_ACTIVITY_B_ID = '019e0cf8-aaaa-7777-8888-000000064011';

export const TEST_PROGRAMME_A_ID = '019e0cf8-aaaa-7777-8888-000000064020';
export const TEST_PROGRAMME_B_ID = '019e0cf8-aaaa-7777-8888-000000064021';

// Every ext_* table touched by the clubs module. Order is child-first
// so TRUNCATE … CASCADE has clear intent even though CASCADE handles it.
const CLUB_TABLES = [
  'ext_service_progress',
  'ext_service_hour_approvals',
  'ext_service_hours',
  'ext_service_programmes',
  'ext_election_voter_check',
  'ext_votes',
  'ext_candidates',
  'ext_elections',
  'ext_field_trip_chaperones',
  'ext_field_trip_consent_records',
  'ext_field_trip_participants',
  'ext_field_trips',
  'ext_activity_schedules',
  'ext_activity_members',
  'ext_activities',
  'ext_activity_types',
];

/** Wipe every ext_* table in the integration test schema. */
export async function resetClubsTables(client: PrismaClient): Promise<void> {
  const list = CLUB_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Seed canonical activity types + one activity + one service programme
 * per school. Tests can layer on top; resetClubsTables reverts to empty.
 */
export async function ensureClubsSeed(client: PrismaClient): Promise<void> {
  // ── School A activity types ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activity_types
       (id, school_id, name, category, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'Soccer', 'SPORT', 'Test soccer type', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ACTIVITY_TYPE_SPORT_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activity_types
       (id, school_id, name, category, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'Drama Club', 'ARTS', 'Test drama type', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ACTIVITY_TYPE_ARTS_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activity_types
       (id, school_id, name, category, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'Student Council', 'LEADERSHIP', 'Test council type', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ACTIVITY_TYPE_LEAD_ID,
    TEST_SCHOOL_ID,
  );
  // ── School B activity type ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activity_types
       (id, school_id, name, category, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'B Soccer', 'SPORT', 'School B soccer', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ACTIVITY_TYPE_B_SPORT_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── School A activity, advised by admin ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activities
       (id, school_id, activity_type_id, name, description, academic_year_id, advisor_id, max_participants, status, meeting_location)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'Soccer Team', 'Fixture soccer team', $4::uuid, $5::uuid, 20, 'ACTIVE', 'Gym A')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ACTIVITY_A_ID,
    TEST_SCHOOL_ID,
    TEST_ACTIVITY_TYPE_SPORT_ID,
    TEST_SIS_ACADEMIC_YEAR_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );

  // ── School B activity, advised by admin (admin row exists in both schools via shared hr_employees row in TEST_SCHEMA) ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activities
       (id, school_id, activity_type_id, name, description, academic_year_id, advisor_id, max_participants, status, meeting_location)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'B Soccer Team', 'School B soccer', $4::uuid, $5::uuid, 10, 'ACTIVE', 'Gym B')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ACTIVITY_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_ACTIVITY_TYPE_B_SPORT_ID,
    TEST_SIS_ACADEMIC_YEAR_B_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );

  // ── Service programmes (one per school) ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_service_programmes
       (id, school_id, name, description, academic_year_id, target_hours, start_date, end_date, is_active, eligible_grade_levels)
     VALUES ($1::uuid, $2::uuid, 'Community Hours 2026', 'Test programme', $3::uuid, 40, '2026-08-01', '2027-07-31', true, ARRAY['5','6']::text[])
     ON CONFLICT (id) DO NOTHING`,
    TEST_PROGRAMME_A_ID,
    TEST_SCHOOL_ID,
    TEST_SIS_ACADEMIC_YEAR_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_service_programmes
       (id, school_id, name, description, academic_year_id, target_hours, start_date, end_date, is_active, eligible_grade_levels)
     VALUES ($1::uuid, $2::uuid, 'B Community Hours', 'School B programme', $3::uuid, 30, '2026-08-01', '2027-07-31', true, ARRAY['5']::text[])
     ON CONFLICT (id) DO NOTHING`,
    TEST_PROGRAMME_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_SIS_ACADEMIC_YEAR_B_ID,
  );
}

/**
 * Combined per-test reset helper. Wipes every ext_* table and any
 * spec-tracked sis_* / platform_* rows inside ONE transaction so all
 * locks accumulate on a single connection — mixing TRUNCATE
 * (AccessExclusive) and DELETE (RowExclusive) on FK-related tables
 * across two pool connections triggers 40P01 deadlocks when vitest
 * coverage instrumentation interleaves spec teardowns.
 *
 * The retry loop covers a stubborn cross-spec race that survives the
 * single-tx scope: under coverage instrumentation, two beforeEach calls
 * from different spec files can briefly overlap on the connection pool.
 * 40P01 is a transient failure — a retry on a fresh connection always
 * succeeds because the rival tx has already been aborted by PG.
 */
export async function resetClubsAndStudents(
  client: PrismaClient,
  ids: {
    studentIds?: string[];
    platformStudentIds?: string[];
    guardianIds?: string[];
    personIds?: string[];
    accountIds?: string[];
  },
): Promise<void> {
  const stuIds = ids.studentIds ?? [];
  const psIds = ids.platformStudentIds ?? [];
  const gdIds = ids.guardianIds ?? [];
  const pIds = ids.personIds ?? [];
  const aIds = ids.accountIds ?? [];

  const truncateList = CLUB_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');

  let attempt = 0;
  const maxAttempts = 5;
  while (true) {
    try {
      await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`TRUNCATE ${truncateList} RESTART IDENTITY CASCADE`);
        if (stuIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = ANY($1::uuid[])`,
            stuIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
            stuIds,
          );
        }
        if (psIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
            psIds,
          );
        }
        if (gdIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE guardian_id = ANY($1::uuid[])`,
            gdIds,
          );
          // m84-payments specs leave pay_financial_aid_applications rows
          // that FK-reference sis_guardians without CASCADE. The sis_guardians
          // DELETE below trips constraint 23503 unless we wipe the
          // payment-side rows first. Mirrors the sis-helpers.ts cleanup.
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.pay_financial_aid_applications WHERE guardian_id = ANY($1::uuid[])`,
            gdIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = ANY($1::uuid[])`,
            gdIds,
          );
        }
        if (aIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM platform.platform_users WHERE id = ANY($1::uuid[])`,
            aIds,
          );
        }
        if (pIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
            pIds,
          );
        }
      });
      return;
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      const isDeadlock =
        err.code === '40P01' ||
        err.meta?.code === '40P01' ||
        /deadlock detected/i.test(err.message ?? '');
      attempt += 1;
      if (!isDeadlock || attempt >= maxAttempts) throw e;
      // Brief backoff before retry — PG's deadlock detector already
      // aborted the rival tx, so the next attempt acquires its locks
      // unopposed.
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}

// Re-exports used by spec files for convenience.
export {
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_ADMIN_EMPLOYEE_ID,
};
