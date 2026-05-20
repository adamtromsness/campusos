import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';

/**
 * Wave 8 — m09-behaviour fixtures.
 *
 * Seeds canonical categories + action types per school, two test
 * students (one per school), a guardian + portal account, and a
 * parent-student link so the parent-row-scope incident path resolves.
 * Wipes every behaviour-related table per test plus drains the
 * outbox/idempotency rows the OutboxService + IdempotencyService leave
 * behind.
 *
 * The behaviour module spans:
 *   - sis_discipline_categories      (taxonomy)
 *   - sis_discipline_action_types    (taxonomy)
 *   - sis_discipline_incidents       (incident FSM)
 *   - sis_discipline_actions         (per-incident consequences)
 *   - svc_behavior_plans             (BIP)
 *   - svc_behavior_plan_goals        (goals on a BIP)
 *   - svc_bip_teacher_feedback       (periodic feedback + UNIQUE pending)
 *   - sis_restorative_justice_conferences
 *   - sis_rj_agreement_actions       (action items)
 *   - sis_peer_mediations            (peer mediation lifecycle)
 *   - sis_positive_behaviour_points  (points ledger AWARD/REDEMPTION)
 *   - sis_behaviour_rewards          (marketplace)
 *
 * The two-student seed (one in school A, one in school B) is reused
 * across cross-school isolation tests so each spec doesn't repeat the
 * platform_students/sis_students dance.
 */

// ── Reserved IDs in the m09 range (000000009xxx) ──────────────────────
export const TEST_BEH_CAT_MINOR_A_ID = '019e0cf8-aaaa-7777-8888-000000009001';
export const TEST_BEH_CAT_MAJOR_A_ID = '019e0cf8-aaaa-7777-8888-000000009002';
export const TEST_BEH_CAT_CRIT_A_ID = '019e0cf8-aaaa-7777-8888-000000009003';
export const TEST_BEH_CAT_INACTIVE_A_ID = '019e0cf8-aaaa-7777-8888-000000009004';
export const TEST_BEH_CAT_MINOR_B_ID = '019e0cf8-aaaa-7777-8888-000000009005';

export const TEST_BEH_ACT_TYPE_DETENTION_A_ID = '019e0cf8-aaaa-7777-8888-000000009011';
export const TEST_BEH_ACT_TYPE_SUSPENSION_A_ID = '019e0cf8-aaaa-7777-8888-000000009012';
export const TEST_BEH_ACT_TYPE_WARNING_A_ID = '019e0cf8-aaaa-7777-8888-000000009013';
export const TEST_BEH_ACT_TYPE_INACTIVE_A_ID = '019e0cf8-aaaa-7777-8888-000000009014';
export const TEST_BEH_ACT_TYPE_DETENTION_B_ID = '019e0cf8-aaaa-7777-8888-000000009015';

// Test students (one per school)
export const TEST_BEH_STU_A_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000009101';
export const TEST_BEH_STU_A_PLATFORM_ID = '019e0cf8-aaaa-7777-8888-000000009102';
export const TEST_BEH_STU_A_ID = '019e0cf8-aaaa-7777-8888-000000009103';

export const TEST_BEH_STU_A2_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000009111';
export const TEST_BEH_STU_A2_PLATFORM_ID = '019e0cf8-aaaa-7777-8888-000000009112';
export const TEST_BEH_STU_A2_ID = '019e0cf8-aaaa-7777-8888-000000009113';

export const TEST_BEH_STU_B_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000009201';
export const TEST_BEH_STU_B_PLATFORM_ID = '019e0cf8-aaaa-7777-8888-000000009202';
export const TEST_BEH_STU_B_ID = '019e0cf8-aaaa-7777-8888-000000009203';

// Guardian for student A (the parent persona — linked via sis_student_guardians)
export const TEST_BEH_GUARDIAN_A_ID = '019e0cf8-aaaa-7777-8888-000000009301';
export const TEST_BEH_STU_GUARDIAN_LINK_A_ID = '019e0cf8-aaaa-7777-8888-000000009302';

// School B teacher / employee (so we can post incidents over there)
export const TEST_BEH_SHADOW_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000009401';
export const TEST_BEH_SHADOW_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000009402';
export const TEST_BEH_SHADOW_EMP_B_ID = '019e0cf8-aaaa-7777-8888-000000009403';

// Tables wiped per test (order matters — children before parents)
const BEHAVIOUR_TABLES = [
  'sis_rj_agreement_actions',
  'sis_restorative_justice_conferences',
  'sis_peer_mediations',
  'sis_positive_behaviour_points',
  'sis_behaviour_rewards',
  'svc_bip_teacher_feedback',
  'svc_behavior_plan_goals',
  'svc_behavior_plans',
  'sis_discipline_actions',
  'sis_discipline_incidents',
  'sis_discipline_action_types',
  'sis_discipline_categories',
];

/**
 * TRUNCATE every behaviour-table in tenant_test plus drain the outbox /
 * idempotency / school_config rows the behaviour services leave behind.
 *
 * Notes:
 *   - sis_discipline_actions has FK to sis_discipline_incidents (CASCADE),
 *     so the order is mostly belt-and-braces. CASCADE handles it but a
 *     deterministic ordering keeps reasoning simple.
 *   - The fixture students (TEST_BEH_STU_*) are NOT wiped — they're
 *     re-seeded by ensureBehaviourSeed and persist across tests so
 *     student_id refs stay stable.
 *   - school_config rows for positive_behaviour_categories are wiped
 *     so CategoryConfigService tests see the DEFAULT_CATEGORIES.
 */
export async function resetBehaviourTables(client: PrismaClient): Promise<void> {
  const list = BEHAVIOUR_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);

  // Drain outbox rows behaviour services emit (positive_points + rj_conference)
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox WHERE topic LIKE 'beh.%' AND tenant_id IN ($1::uuid, $2::uuid)`,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );

  // Reset the positive-behaviour-categories tenant config
  await client.$executeRawUnsafe(
    `DELETE FROM ${TEST_SCHEMA}.school_config WHERE config_key = 'positive_behaviour_categories'`,
  );
}

/**
 * Idempotent seed. Called once in beforeAll + after every reset.
 *
 * Builds the canonical taxonomy (categories + action types) per school
 * plus the test students and guardian link. Stable identifiers so
 * cross-spec references don't drift.
 */
export async function ensureBehaviourSeed(client: PrismaClient): Promise<void> {
  // ── School A — discipline categories
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_categories (id, school_id, name, severity, is_active)
     VALUES ($1::uuid, $2::uuid, 'Minor Disruption', 'LOW', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_CAT_MINOR_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_categories (id, school_id, name, severity, is_active)
     VALUES ($1::uuid, $2::uuid, 'Fighting', 'HIGH', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_CAT_MAJOR_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_categories (id, school_id, name, severity, is_active)
     VALUES ($1::uuid, $2::uuid, 'Weapons', 'CRITICAL', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_CAT_CRIT_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_categories (id, school_id, name, severity, is_active)
     VALUES ($1::uuid, $2::uuid, 'Inactive Cat', 'MEDIUM', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_CAT_INACTIVE_A_ID,
    TEST_SCHOOL_ID,
  );

  // ── School B — discipline category (cross-school isolation)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_categories (id, school_id, name, severity, is_active)
     VALUES ($1::uuid, $2::uuid, 'B Minor', 'LOW', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_CAT_MINOR_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── School A — action types
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_action_types
       (id, school_id, name, requires_parent_notification, is_active)
     VALUES ($1::uuid, $2::uuid, 'Detention', true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_ACT_TYPE_DETENTION_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_action_types
       (id, school_id, name, requires_parent_notification, is_active)
     VALUES ($1::uuid, $2::uuid, 'Suspension', true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_ACT_TYPE_SUSPENSION_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_action_types
       (id, school_id, name, requires_parent_notification, is_active)
     VALUES ($1::uuid, $2::uuid, 'Verbal Warning', false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_ACT_TYPE_WARNING_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_action_types
       (id, school_id, name, requires_parent_notification, is_active)
     VALUES ($1::uuid, $2::uuid, 'Inactive Action', false, false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_ACT_TYPE_INACTIVE_A_ID,
    TEST_SCHOOL_ID,
  );

  // ── School B — action type (cross-school)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_discipline_action_types
       (id, school_id, name, requires_parent_notification, is_active)
     VALUES ($1::uuid, $2::uuid, 'B Detention', true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_ACT_TYPE_DETENTION_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── Students for School A (used for incidents, BIPs, points)
  await ensureStudent(
    client,
    TEST_BEH_STU_A_PERSON_ID,
    TEST_BEH_STU_A_PLATFORM_ID,
    TEST_BEH_STU_A_ID,
    'Beh',
    'Student-A',
    TEST_SCHOOL_ID,
    'BEH-STU-A',
  );
  await ensureStudent(
    client,
    TEST_BEH_STU_A2_PERSON_ID,
    TEST_BEH_STU_A2_PLATFORM_ID,
    TEST_BEH_STU_A2_ID,
    'Beh',
    'Student-A2',
    TEST_SCHOOL_ID,
    'BEH-STU-A2',
  );

  // ── Student for School B (cross-school isolation)
  await ensureStudent(
    client,
    TEST_BEH_STU_B_PERSON_ID,
    TEST_BEH_STU_B_PLATFORM_ID,
    TEST_BEH_STU_B_ID,
    'Beh',
    'Student-B',
    TEST_SCHOOL_B_ID,
    'BEH-STU-B',
  );

  // ── Guardian for student A (using the parent persona — TEST_PARENT_PERSON_ID
  //    is reused; we just attach a sis_guardians row per school).
  // The parent actor's person_id is already in iam_person from employee seed.
  // Create a sis_guardians row keyed on the parent's person_id, then link
  // the guardian to student A so the parent-row-scope visibility branch
  // returns student A's incident.
  const TEST_PARENT_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000000050';
  const TEST_PARENT_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000000051';
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians
       (id, person_id, account_id, school_id, family_id, relationship)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 'PARENT')
     ON CONFLICT (school_id, person_id) DO UPDATE SET account_id = EXCLUDED.account_id`,
    TEST_BEH_GUARDIAN_A_ID,
    TEST_PARENT_PERSON_ID,
    TEST_PARENT_ACCOUNT_ID,
    TEST_SCHOOL_ID,
  );
  // Resolve the actual guardian id (could differ if a prior spec inserted
  // one with a different id under the same UNIQUE (school_id, person_id)).
  const gdRows = await client.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id::text FROM ${TEST_SCHEMA}.sis_guardians
      WHERE school_id = $1::uuid AND person_id = $2::uuid LIMIT 1`,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  );
  const realGuardianId = gdRows[0]?.id ?? TEST_BEH_GUARDIAN_A_ID;
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians
       (id, student_id, guardian_id, has_custody, is_emergency_contact,
        receives_reports, portal_access)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true, true)
     ON CONFLICT (student_id, guardian_id) DO UPDATE SET portal_access = true`,
    TEST_BEH_STU_GUARDIAN_LINK_A_ID,
    TEST_BEH_STU_A_ID,
    realGuardianId,
  );

  // ── Shadow staff in School B (so we can post incidents there as admin
  //    with a "real" employee row). hr_employees has UNIQUE(person_id) +
  //    UNIQUE(account_id) so a separate identity is needed.
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'BehSchoolB', 'Shadow', 'STAFF', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_SHADOW_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_users
       (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
     VALUES ($1::uuid, $2::uuid, 'beh-shadow.b@test.local', 'BehSchoolB Shadow',
             'ACTIVE', 'HUMAN', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_SHADOW_ACCOUNT_ID,
    TEST_BEH_SHADOW_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.hr_employees
       (id, person_id, account_id, school_id, employee_number,
        employment_type, employment_status, hire_date)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'BEH-B-001',
             'FULL_TIME', 'ACTIVE', '2024-01-01')
     ON CONFLICT (id) DO NOTHING`,
    TEST_BEH_SHADOW_EMP_B_ID,
    TEST_BEH_SHADOW_PERSON_ID,
    TEST_BEH_SHADOW_ACCOUNT_ID,
    TEST_SCHOOL_B_ID,
  );
}

async function ensureStudent(
  client: PrismaClient,
  personId: string,
  platformStudentId: string,
  studentId: string,
  firstName: string,
  lastName: string,
  schoolId: string,
  studentNumber: string,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, $2, $3, 'STUDENT', true)
     ON CONFLICT (id) DO NOTHING`,
    personId,
    firstName,
    lastName,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
     VALUES ($1::uuid, $2::uuid, $3, $4, true)
     ON CONFLICT (id) DO NOTHING`,
    platformStudentId,
    personId,
    firstName,
    lastName,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_students
       (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '7', 'ENROLLED')
     ON CONFLICT (id) DO NOTHING`,
    studentId,
    platformStudentId,
    schoolId,
    studentNumber,
  );
}

export async function resetAndSeedBehaviour(client: PrismaClient): Promise<void> {
  await resetBehaviourTables(client);
  await ensureBehaviourSeed(client);
}
