import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_ADMIN_PERSON_ID,
  TEST_ADMIN_ACCOUNT_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
  TEST_STUDENT_PERSON_ID,
} from '../helpers/actor';

/**
 * Wave 8 — m82-substitutes fixtures.
 *
 * Seeds platform-side substitute profiles + tenant-side school pools,
 * pay rates, cancellation policies, plus shadow hr_employees rows for
 * the cross-school tests. Wipes every sub_* table per test and resets
 * platform_sub_* + platform_substitute_profiles between specs.
 *
 * The m82 module straddles platform + tenant per ADR-029:
 *   - platform.platform_substitute_profiles     (sub identity)
 *   - platform.platform_sub_credentials         (verified TEACHING_LICENSE etc)
 *   - platform.platform_sub_availability        (RECURRING / SPECIFIC / BLOCKED)
 *   - platform.platform_sub_preferences         (PREFERRED / BLOCKED per school)
 *   - tenant.sub_school_pool                    (curated pool rows)
 *   - tenant.sub_job_postings + sub_job_classes + sub_job_notifications
 *   - tenant.sub_assignments + sub_ratings + sub_session_notes
 *   - tenant.sub_pay_rates                      (EXCLUDE-gist no overlap)
 *   - tenant.sub_cancellation_policies          (one per school)
 *
 * We seed two substitute profiles per spec, one bound to the test
 * teacher persona (so the actor.personId path resolves to a real
 * profile in availability / preference / accept tests) and one
 * "marketplace" substitute bound to the test parent persona (so we
 * can exercise notify-fan-out without bumping the teacher's own
 * assignment counter).
 */

// ── Reserved IDs in the m82 range (000000082xxx) ────────────────────

// Platform substitute profiles
export const TEST_SUB_PROFILE_TEACHER_ID = '019e0cf8-aaaa-7777-8888-000000082001';
export const TEST_SUB_PROFILE_PARENT_ID = '019e0cf8-aaaa-7777-8888-000000082002';

// Shadow hr_employees row for School B (so we can post jobs there).
// Backed by a dedicated person + account because hr_employees has UNIQUE
// constraints on both person_id + account_id, so we can't reuse the
// admin/teacher fixtures in a second school.
export const TEST_SUB_SHADOW_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000082020';
export const TEST_SUB_SHADOW_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000082021';
export const TEST_SUB_HR_EMP_SCHOOL_B_ID = '019e0cf8-aaaa-7777-8888-000000082011';

// Tenant pre-seeded rows (per test we wipe + reseed)
export const TEST_SUB_POOL_A_TEACHER_ID = '019e0cf8-aaaa-7777-8888-000000082101';

// ── Tables wiped per test ────────────────────────────────────────────

const TENANT_TABLES = [
  'sub_ratings',
  'sub_session_notes',
  'sub_assignments',
  'sub_job_notifications',
  'sub_job_classes',
  'sub_job_postings',
  'sub_pay_rates',
  'sub_school_pool',
  'sub_cancellation_policies',
];

/**
 * Reset all sub_* tables in the tenant schema + every platform_sub_*
 * row tied to the test substitute profiles. Idempotent.
 */
export async function resetSubstitutesTables(client: PrismaClient): Promise<void> {
  const list = TENANT_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);

  // Platform-side: wipe credentials / availability / preferences for our
  // test profiles. We keep the profiles themselves around — they're
  // re-upserted by ensureSubstitutesSeed.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_sub_credentials WHERE substitute_id IN ($1::uuid, $2::uuid)`,
    TEST_SUB_PROFILE_TEACHER_ID,
    TEST_SUB_PROFILE_PARENT_ID,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_sub_availability WHERE substitute_id IN ($1::uuid, $2::uuid)`,
    TEST_SUB_PROFILE_TEACHER_ID,
    TEST_SUB_PROFILE_PARENT_ID,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_sub_preferences WHERE substitute_id IN ($1::uuid, $2::uuid)`,
    TEST_SUB_PROFILE_TEACHER_ID,
    TEST_SUB_PROFILE_PARENT_ID,
  );

  // Drain any leftover sub.* outbox rows so the kafka recorder is the
  // ONLY source of truth in assertions.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox WHERE topic LIKE 'sub.%' AND tenant_id IN ($1::uuid, $2::uuid)`,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );

  // Drop our consumer idempotency claims so re-runs are clean.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_event_consumer_idempotency
       WHERE consumer_group IN ('cancellation-policy-consumer', 'cover-arrangement-consumer')`,
  );
}

/**
 * Seed canonical fixtures. Idempotent (ON CONFLICT DO NOTHING).
 * Called once in beforeAll AND after every reset.
 */
export async function ensureSubstitutesSeed(client: PrismaClient): Promise<void> {
  // ── Parent persona iam_person row (used as the substitute identity
  //    for the "other substitute" profile). The Parent platform_users
  //    row is seeded by globalSetup; we just need to make sure the
  //    iam_person row is there.
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'Parent', 'Substitute', 'GUARDIAN', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PARENT_PERSON_ID,
  );

  // ── Substitute profile #1 — bound to the test teacher persona.
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_substitute_profiles
       (id, person_id, display_name, bio, grade_levels, subject_areas,
        years_experience, max_distance_miles, is_available, is_active, total_assignments)
     VALUES ($1::uuid, $2::uuid, 'Teacher Sub', 'Veteran substitute',
             ARRAY['K','1','2','3']::text[], ARRAY['MATH','SCIENCE']::text[],
             10, 25, true, true, 0)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SUB_PROFILE_TEACHER_ID,
    TEST_TEACHER_PERSON_ID,
  );

  // ── Substitute profile #2 — bound to the parent persona (a totally
  //    separate substitute used for fan-out + marketplace tests).
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_substitute_profiles
       (id, person_id, display_name, bio, grade_levels, subject_areas,
        years_experience, max_distance_miles, is_available, is_active, total_assignments)
     VALUES ($1::uuid, $2::uuid, 'Marketplace Sub', 'Available marketplace sub',
             ARRAY['4','5','6']::text[], ARRAY['ENGLISH']::text[],
             3, 40, true, true, 0)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SUB_PROFILE_PARENT_ID,
    TEST_PARENT_PERSON_ID,
  );

  // Reset totalAssignments back to 0 on both profiles so per-test
  // counter assertions are deterministic.
  await client.$executeRawUnsafe(
    `UPDATE platform.platform_substitute_profiles
       SET total_assignments = 0, overall_rating = NULL, is_active = true, is_available = true
       WHERE id IN ($1::uuid, $2::uuid)`,
    TEST_SUB_PROFILE_TEACHER_ID,
    TEST_SUB_PROFILE_PARENT_ID,
  );

  // ── Shadow hr_employees row in School B (sub_job_postings.absent_teacher_id
  //    is a real DB-enforced FK to hr_employees; we need a teacher in
  //    School B to post a job there). Backed by a dedicated person +
  //    account so we don't collide with hr_employees UNIQUE(person_id)
  //    or UNIQUE(account_id).
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'SchoolB', 'Shadow', 'STAFF', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SUB_SHADOW_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_users
       (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
     VALUES ($1::uuid, $2::uuid, 'shadow.schoolb@test.local',
             'SchoolB Shadow', 'ACTIVE', 'HUMAN', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_SUB_SHADOW_ACCOUNT_ID,
    TEST_SUB_SHADOW_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_employees
       (id, person_id, account_id, school_id, employee_number, employment_type, employment_status, hire_date)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SUB-B-001', 'FULL_TIME', 'ACTIVE', '2024-01-01')
     ON CONFLICT (id) DO NOTHING`,
    TEST_SUB_HR_EMP_SCHOOL_B_ID,
    TEST_SUB_SHADOW_PERSON_ID,
    TEST_SUB_SHADOW_ACCOUNT_ID,
    TEST_SCHOOL_B_ID,
  );

  // Touch the student person_id so we don't fall foul of any cascading
  // referential checks (no-op if already there).
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'Student', 'Touch', 'STUDENT', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_STUDENT_PERSON_ID,
  );

  // Keep TEST_ADMIN_EMPLOYEE_ID + TEST_TEACHER_EMPLOYEE_ID intact — they
  // are already seeded by globalSetup via fixtures/employees.ts.
  void TEST_ADMIN_EMPLOYEE_ID;
  void TEST_TEACHER_EMPLOYEE_ID;
}

export async function resetAndSeedSubstitutes(client: PrismaClient): Promise<void> {
  await resetSubstitutesTables(client);
  await ensureSubstitutesSeed(client);
}
