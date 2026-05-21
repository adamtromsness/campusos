import type { PrismaClient } from '@prisma/client';
import {
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_ACCOUNT_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_STUDENT_ACCOUNT_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID, TEST_SIS_CLASS_B_ID } from './sis';

/**
 * Wave 8 — m26-portfolio fixtures.
 *
 * Seeds the cross-module identity surface the portfolio services need:
 *   - sis_students rows for the STUDENT actor (school A) + a school A
 *     second student (used to exercise the STUDENT-OWNED row-scope
 *     contract — caller-student vs. other-student) + a school B student
 *     for cross-school isolation.
 *   - sis_guardians + sis_student_guardians binding the PARENT actor
 *     to the school A student so the PARENT-visibility branch resolves.
 *   - sis_class_teachers row mapping the TEACHER actor to TEST_SIS_CLASS_ID
 *     plus an ACTIVE enrolment so isAssignedTeacherOf returns true for
 *     the school A student.
 *   - cls_assignment_types / cls_assignments / cls_submissions / cls_grades
 *     so the portfolio-item source-validation path (SUBMISSION / GRADE /
 *     ACHIEVEMENT) has real rows to match against.
 *   - lib_reading_programmes + lib_programme_completions, ext_service_*
 *     programme + progress row so cross-cycle achievement validation
 *     (sourceModule = library / clubs) has real rows.
 *   - sis_service_learning_hours rows for the school A student so the
 *     resume generate-pdf aggregation (post-bug-fix) returns >0.
 *   - ext_activity + ext_activity_members row so the resume extracurricular
 *     aggregation (post-bug-fix) returns a row.
 *
 * Tables wiped per test:
 *   pfl_resume_profiles
 *   pfl_college_applications
 *   pfl_student_pathway_assignments
 *   pfl_pathway_milestones
 *   pfl_readiness_pathways
 *   pfl_endorsements
 *   pfl_reflections
 *   pfl_portfolio_sections
 *   pfl_achievement_shares
 *   pfl_achievements
 *   pfl_portfolio_shares
 *   pfl_portfolio_items
 *   pfl_portfolios
 *
 * The seeded students, classroom rows, library, clubs and service-hours
 * rows are NOT wiped per test — they're stable cross-test scaffolding.
 */

// ── Reserved IDs in the m26 range (000000026xxx) ──────────────────────

// Students (school A primary STUDENT actor + a second school A student +
// a school B student for cross-school isolation)
//
// These are `let` rather than `const` because sibling fixtures
// (library.ts, substitutes.ts) may have already seeded a
// platform_students + sis_students row for TEST_STUDENT_PERSON_ID
// under their own ids. Both `platform_students.person_id` and
// `sis_students.platform_student_id` are UNIQUE, so we cannot create
// a second row with the same person. ensurePortfolioSeed below uses
// lookup-or-insert and updates these bindings to point at whichever
// canonical row already exists (or its newly-inserted hint id).
const TEST_PORTFOLIO_STU_A_PLATFORM_ID_HINT =
  '019e0cf8-aaaa-7777-8888-000000026101';
const TEST_PORTFOLIO_STU_A_ID_HINT =
  '019e0cf8-aaaa-7777-8888-000000026102';
export let TEST_PORTFOLIO_STU_A_PLATFORM_ID =
  TEST_PORTFOLIO_STU_A_PLATFORM_ID_HINT;
export let TEST_PORTFOLIO_STU_A_ID = TEST_PORTFOLIO_STU_A_ID_HINT;

export const TEST_PORTFOLIO_STU_A2_PERSON_ID =
  '019e0cf8-aaaa-7777-8888-000000026111';
export const TEST_PORTFOLIO_STU_A2_PLATFORM_ID =
  '019e0cf8-aaaa-7777-8888-000000026112';
export const TEST_PORTFOLIO_STU_A2_ID =
  '019e0cf8-aaaa-7777-8888-000000026113';
export const TEST_PORTFOLIO_STU_A2_ACCOUNT_ID =
  '019e0cf8-aaaa-7777-8888-000000026114';

export const TEST_PORTFOLIO_STU_B_PERSON_ID =
  '019e0cf8-aaaa-7777-8888-000000026201';
export const TEST_PORTFOLIO_STU_B_PLATFORM_ID =
  '019e0cf8-aaaa-7777-8888-000000026202';
export const TEST_PORTFOLIO_STU_B_ID =
  '019e0cf8-aaaa-7777-8888-000000026203';

// Guardian for student A (parent persona — sis_guardians binding)
export const TEST_PORTFOLIO_GUARDIAN_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026301';
export const TEST_PORTFOLIO_GUARDIAN_LINK_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026302';

// Class-teacher binding so isAssignedTeacherOf returns true for student A.
export const TEST_PORTFOLIO_CLASS_TEACHER_LINK_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026401';
export const TEST_PORTFOLIO_ENROLLMENT_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026402';

// Classroom assignment + grade rows (for source validation path).
export const TEST_PORTFOLIO_ASSIGNMENT_TYPE_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026501';
export const TEST_PORTFOLIO_ASSIGNMENT_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026502';
export const TEST_PORTFOLIO_SUBMISSION_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026503';
export const TEST_PORTFOLIO_GRADE_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026504';
// Cross-school assignment + submission belonging to student B (cross-school
// source-ownership validation).
export const TEST_PORTFOLIO_ASSIGNMENT_TYPE_B_ID =
  '019e0cf8-aaaa-7777-8888-000000026511';
export const TEST_PORTFOLIO_ASSIGNMENT_B_ID =
  '019e0cf8-aaaa-7777-8888-000000026512';
export const TEST_PORTFOLIO_SUBMISSION_B_ID =
  '019e0cf8-aaaa-7777-8888-000000026513';

// Library programme + completion (cross-cycle achievement source).
export const TEST_PORTFOLIO_LIB_PROGRAMME_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026601';
export const TEST_PORTFOLIO_LIB_COMPLETION_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026602';

// Clubs / service programme + progress (cross-cycle achievement source).
export const TEST_PORTFOLIO_CLUB_PROGRAMME_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026701';
export const TEST_PORTFOLIO_SERVICE_PROGRESS_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026702';

// Athletics all-time record (cross-cycle achievement source).
export const TEST_PORTFOLIO_ATH_RECORD_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026801';

// Extracurricular activity + membership (resume aggregation).
export const TEST_PORTFOLIO_EXT_ACTIVITY_TYPE_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026901';
export const TEST_PORTFOLIO_EXT_ACTIVITY_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026902';
export const TEST_PORTFOLIO_EXT_MEMBER_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026903';

// Service-learning hour row (resume aggregation).
export const TEST_PORTFOLIO_SERVICE_HOURS_A_ID =
  '019e0cf8-aaaa-7777-8888-000000026a01';

// Reviewer account / hr_employee for the service-learning hour APPROVED entry
// — sis_service_learning_hours requires reviewed_by/reviewed_at to be set
// when status='APPROVED'. We reuse the admin employee id (already seeded).

// Tables wiped per test (order matters — children before parents).
const PORTFOLIO_TABLES = [
  'pfl_resume_profiles',
  'pfl_college_applications',
  'pfl_student_pathway_assignments',
  'pfl_pathway_milestones',
  'pfl_readiness_pathways',
  'pfl_endorsements',
  'pfl_reflections',
  'pfl_portfolio_sections',
  'pfl_achievement_shares',
  'pfl_achievements',
  'pfl_portfolio_shares',
  'pfl_portfolio_items',
  'pfl_portfolios',
];

export async function resetPortfolioTables(client: PrismaClient): Promise<void> {
  const list = PORTFOLIO_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);

  // Drain outbox rows the portfolio services emit (milestone_completed).
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox
       WHERE topic LIKE 'pfl.%'
         AND tenant_id IN ($1::uuid, $2::uuid)`,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );

  // Drain idempotency rows for the milestone consumer group so re-runs
  // of the auto-check tests don't dedup.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_event_consumer_idempotency
       WHERE consumer_group = 'milestone-auto-check-worker'`,
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
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, '11', 'ENROLLED')
     ON CONFLICT (id) DO NOTHING`,
    studentId,
    platformStudentId,
    schoolId,
    studentNumber,
  );
}

/**
 * Idempotent seed. Called once in beforeAll + after every reset.
 *
 * The classroom + library + clubs cross-module rows persist across
 * tests so source-validation paths always resolve. Per-test mutation
 * happens against the pfl_* tables only.
 */
export async function ensurePortfolioSeed(client: PrismaClient): Promise<void> {
  // ── STUDENT actor as a sis_students row in school A (Maya Chen analogue).
  // The TEST_STUDENT_PERSON_ID already exists in platform.iam_person + .platform_users
  // from ensureEmployeeFixtures. We need to land the platform_students +
  // sis_students rows so resolveStudentIdForActor returns a real id.
  //
  // Sibling fixtures (library.ts, behaviour.ts, substitutes.ts) may have
  // already inserted a platform_students row for TEST_STUDENT_PERSON_ID
  // under their own platform_student_id — and platform_students.person_id
  // is UNIQUE. Look up the existing row first and reuse its id; otherwise
  // INSERT with our canonical PFL id. This makes the portfolio fixture
  // resilient to suite-discovery order.
  const existingPlatformStudent = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
    TEST_STUDENT_PERSON_ID,
  )) as Array<{ id: string }>;
  if (existingPlatformStudent[0]?.id) {
    TEST_PORTFOLIO_STU_A_PLATFORM_ID = existingPlatformStudent[0].id;
  } else {
    await client.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Integration', 'Student', true)
       ON CONFLICT (id) DO NOTHING`,
      TEST_PORTFOLIO_STU_A_PLATFORM_ID_HINT,
      TEST_STUDENT_PERSON_ID,
    );
    TEST_PORTFOLIO_STU_A_PLATFORM_ID = TEST_PORTFOLIO_STU_A_PLATFORM_ID_HINT;
  }
  // sis_students has UNIQUE on platform_student_id. Look up or insert,
  // and update the exported binding so downstream INSERTs reference the
  // canonical row.
  const existingSisStudent = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students
       WHERE platform_student_id = $1::uuid LIMIT 1`,
    TEST_PORTFOLIO_STU_A_PLATFORM_ID,
  )) as Array<{ id: string }>;
  if (existingSisStudent[0]?.id) {
    TEST_PORTFOLIO_STU_A_ID = existingSisStudent[0].id;
  } else {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'PFL-STU-A', '11', 'ENROLLED')
       ON CONFLICT (id) DO NOTHING`,
      TEST_PORTFOLIO_STU_A_ID_HINT,
      TEST_PORTFOLIO_STU_A_PLATFORM_ID,
      TEST_SCHOOL_ID,
    );
    TEST_PORTFOLIO_STU_A_ID = TEST_PORTFOLIO_STU_A_ID_HINT;
  }

  // Second student in school A (a different STUDENT used to verify the
  // STUDENT-OWNED contract — actor for student A2 cannot read student A's
  // portfolio). Has its own person + account so it can be a real actor.
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'Other', 'Student-A2', 'STUDENT', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_STU_A2_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_users
       (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
     VALUES ($1::uuid, $2::uuid, 'pfl-other.student@test.local',
             'Other Student A2', 'ACTIVE', 'HUMAN', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_STU_A2_ACCOUNT_ID,
    TEST_PORTFOLIO_STU_A2_PERSON_ID,
  );
  await ensureStudent(
    client,
    TEST_PORTFOLIO_STU_A2_PERSON_ID,
    TEST_PORTFOLIO_STU_A2_PLATFORM_ID,
    TEST_PORTFOLIO_STU_A2_ID,
    'Other',
    'Student-A2',
    TEST_SCHOOL_ID,
    'PFL-STU-A2',
  );

  // Student in school B (cross-school isolation).
  await ensureStudent(
    client,
    TEST_PORTFOLIO_STU_B_PERSON_ID,
    TEST_PORTFOLIO_STU_B_PLATFORM_ID,
    TEST_PORTFOLIO_STU_B_ID,
    'Pfl',
    'Student-B',
    TEST_SCHOOL_B_ID,
    'PFL-STU-B',
  );

  // ── Guardian for student A — the PARENT actor (David Chen analogue).
  // Bind the parent's person_id to a sis_guardians row, then link the
  // guardian to student A so PARENT-tier visibility resolves.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians
       (id, person_id, account_id, school_id, family_id, relationship)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 'PARENT')
     ON CONFLICT (school_id, person_id) DO UPDATE
       SET account_id = EXCLUDED.account_id`,
    TEST_PORTFOLIO_GUARDIAN_A_ID,
    TEST_PARENT_PERSON_ID,
    TEST_PARENT_ACCOUNT_ID,
    TEST_SCHOOL_ID,
  );
  // Resolve the actual guardian id (other fixtures may have inserted one
  // under the (school_id, person_id) UNIQUE first).
  const gdRows = (await client.$queryRawUnsafe(
    `SELECT id::text FROM ${TEST_SCHEMA}.sis_guardians
       WHERE school_id = $1::uuid AND person_id = $2::uuid LIMIT 1`,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  )) as Array<{ id: string }>;
  const realGuardianId = gdRows[0]?.id ?? TEST_PORTFOLIO_GUARDIAN_A_ID;
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians
       (id, student_id, guardian_id, has_custody, is_emergency_contact,
        receives_reports, portal_access)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true, true)
     ON CONFLICT (student_id, guardian_id) DO UPDATE SET portal_access = true`,
    TEST_PORTFOLIO_GUARDIAN_LINK_A_ID,
    TEST_PORTFOLIO_STU_A_ID,
    realGuardianId,
  );

  // ── Teacher-of binding so isAssignedTeacherOf returns true for student A.
  // sis_class_teachers binds TEST_TEACHER_EMPLOYEE_ID to TEST_SIS_CLASS_ID,
  // and an ACTIVE enrolment on TEST_SIS_CLASS_ID for student A.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_class_teachers
       (id, class_id, teacher_employee_id, is_primary_teacher)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true)
     ON CONFLICT (class_id, teacher_employee_id) DO NOTHING`,
    TEST_PORTFOLIO_CLASS_TEACHER_LINK_A_ID,
    TEST_SIS_CLASS_ID,
    TEST_TEACHER_EMPLOYEE_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_enrollments
       (id, student_id, class_id, status, enrolled_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE', now())
     ON CONFLICT DO NOTHING`,
    TEST_PORTFOLIO_ENROLLMENT_A_ID,
    TEST_PORTFOLIO_STU_A_ID,
    TEST_SIS_CLASS_ID,
  );

  // ── Classroom: assignment type + assignment + submission + grade for
  // student A in school A's class. The portfolio source-validation path
  // probes cls_submissions + cls_grades by id and student_id.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_assignment_types
       (id, school_id, name, weight_in_category, category)
     VALUES ($1::uuid, $2::uuid, 'Portfolio Test Homework', 100.00, 'HOMEWORK')
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_ASSIGNMENT_TYPE_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_assignments
       (id, class_id, assignment_type_id, title, max_points, is_published)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'Portfolio Demo Assignment', 100.00, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_ASSIGNMENT_A_ID,
    TEST_SIS_CLASS_ID,
    TEST_PORTFOLIO_ASSIGNMENT_TYPE_A_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_submissions
       (id, assignment_id, student_id, status, submitted_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', now())
     ON CONFLICT (assignment_id, student_id) DO NOTHING`,
    TEST_PORTFOLIO_SUBMISSION_A_ID,
    TEST_PORTFOLIO_ASSIGNMENT_A_ID,
    TEST_PORTFOLIO_STU_A_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_grades
       (id, assignment_id, student_id, teacher_id, grade_value, is_published, published_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 92.0, true, now())
     ON CONFLICT (assignment_id, student_id) DO NOTHING`,
    TEST_PORTFOLIO_GRADE_A_ID,
    TEST_PORTFOLIO_ASSIGNMENT_A_ID,
    TEST_PORTFOLIO_STU_A_ID,
    TEST_TEACHER_EMPLOYEE_ID,
  );

  // ── School B classroom — assignment + submission belonging to student B.
  // Used by the cross-school source-ownership test (student A trying to
  // paste student B's submission UUID into their own portfolio → 400).
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_assignment_types
       (id, school_id, name, weight_in_category, category)
     VALUES ($1::uuid, $2::uuid, 'Portfolio B Homework', 100.00, 'HOMEWORK')
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_ASSIGNMENT_TYPE_B_ID,
    TEST_SCHOOL_B_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_assignments
       (id, class_id, assignment_type_id, title, max_points, is_published)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'Portfolio B Assignment', 100.00, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_ASSIGNMENT_B_ID,
    TEST_SIS_CLASS_B_ID,
    TEST_PORTFOLIO_ASSIGNMENT_TYPE_B_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.cls_submissions
       (id, assignment_id, student_id, status, submitted_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'SUBMITTED', now())
     ON CONFLICT (assignment_id, student_id) DO NOTHING`,
    TEST_PORTFOLIO_SUBMISSION_B_ID,
    TEST_PORTFOLIO_ASSIGNMENT_B_ID,
    TEST_PORTFOLIO_STU_B_ID,
  );

  // ── Library programme + completion for student A (cross-cycle achievement
  // source). Schema: lib_reading_programmes(id, school_id, name, ...).
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_reading_programmes
       (id, school_id, name, description, target_books, target_pages, start_date, end_date, is_active)
     VALUES ($1::uuid, $2::uuid, 'Summer Reading', 'Read books over the summer', 10, 1000, '2026-06-01', '2026-08-31', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_LIB_PROGRAMME_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_programme_completions
       (id, programme_id, student_id, completed_at, books_read, pages_read)
     VALUES ($1::uuid, $2::uuid, $3::uuid, now(), 12, 1200)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_LIB_COMPLETION_A_ID,
    TEST_PORTFOLIO_LIB_PROGRAMME_A_ID,
    TEST_PORTFOLIO_STU_A_ID,
  );

  // ── Clubs / service programme + progress for student A.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_service_programmes
       (id, school_id, name, academic_year_id, target_hours, is_active)
     SELECT $1::uuid, $2::uuid, 'Community Service Hours', ay.id, 40, true
       FROM ${TEST_SCHEMA}.sis_academic_years ay
       WHERE ay.school_id = $2::uuid
       ORDER BY ay.start_date DESC
       LIMIT 1
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_CLUB_PROGRAMME_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_service_progress
       (id, programme_id, student_id, approved_hours, pending_hours, is_complete)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 25.0, 5.0, false)
     ON CONFLICT (programme_id, student_id) DO NOTHING`,
    TEST_PORTFOLIO_SERVICE_PROGRESS_A_ID,
    TEST_PORTFOLIO_CLUB_PROGRAMME_A_ID,
    TEST_PORTFOLIO_STU_A_ID,
  );

  // ── Athletics all-time record (school-scoped — achievement validation
  // accepts a match on school_id even without student_id). This row lives
  // at school A.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ath_all_time_records
       (id, school_id, sport, record_type, stat_category, record_value, holder_student_id, set_date)
     VALUES ($1::uuid, $2::uuid, 'BASKETBALL', 'SINGLE_GAME', 'POINTS', 45.0, $3::uuid, '2026-04-01')
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_ATH_RECORD_A_ID,
    TEST_SCHOOL_ID,
    TEST_PORTFOLIO_STU_A_ID,
  );

  // ── Service-learning hours (APPROVED, for the resume aggregation).
  // sis_service_learning_hours requires reviewed_by + reviewed_at when
  // status='APPROVED'.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_service_learning_hours
       (id, student_id, organisation_name, activity_description, hours, service_date,
        status, reviewed_by, reviewed_at)
     VALUES ($1::uuid, $2::uuid, 'Food Pantry', 'Sorted donations', 4.5,
             '2026-04-15', 'APPROVED', $3::uuid, now())
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_SERVICE_HOURS_A_ID,
    TEST_PORTFOLIO_STU_A_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );

  // ── Ext activity + membership for the resume extracurricular aggregator.
  // ext_activities requires academic_year_id + activity_type_id — we seed
  // a minimal activity_type and reuse the SIS academic year that
  // ensureSisFixtures already wrote.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activity_types
       (id, school_id, name, category)
     VALUES ($1::uuid, $2::uuid, 'Robotics-pfl-test', 'ACADEMIC')
     ON CONFLICT (school_id, name) DO NOTHING`,
    TEST_PORTFOLIO_EXT_ACTIVITY_TYPE_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activities
       (id, school_id, activity_type_id, name, description, academic_year_id, status)
     SELECT $1::uuid, $2::uuid, $3::uuid, 'Robotics Club', 'Build robots',
            ay.id, 'ACTIVE'
       FROM ${TEST_SCHEMA}.sis_academic_years ay
       WHERE ay.school_id = $2::uuid
       ORDER BY ay.start_date DESC
       LIMIT 1
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_EXT_ACTIVITY_A_ID,
    TEST_SCHOOL_ID,
    TEST_PORTFOLIO_EXT_ACTIVITY_TYPE_A_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ext_activity_members
       (id, activity_id, student_id, role, joined_at, is_active)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'MEMBER', '2026-09-01', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PORTFOLIO_EXT_MEMBER_A_ID,
    TEST_PORTFOLIO_EXT_ACTIVITY_A_ID,
    TEST_PORTFOLIO_STU_A_ID,
  );
}

export async function resetAndSeedPortfolio(client: PrismaClient): Promise<void> {
  await resetPortfolioTables(client);
  await ensurePortfolioSeed(client);
}
