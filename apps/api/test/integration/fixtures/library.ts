import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_EMPLOYEE_ID,
  TEST_TEACHER_EMPLOYEE_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_STUDENT_PERSON_ID,
  TEST_PARENT_PERSON_ID,
  TEST_PARENT_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SIS_CLASS_ID } from './sis';

/**
 * Wave 8 — m24-library fixtures.
 *
 * The library module needs:
 *   - lib_locations (school A + school B)
 *   - lib_catalogue_items (school A + school B)
 *   - lib_catalogue_copies (with distinct barcodes)
 *   - lib_checkout_policies (per school per patron type)
 *   - sis_students bridging the STUDENT actor (so reading log /
 *     review / programme-progress paths resolve)
 *   - sis_guardians + sis_student_guardians binding PARENT to the
 *     student (for recommendation read scope)
 *   - sis_class_teachers + sis_enrollments so CLASS-targeted
 *     reading programmes can match the student
 *
 * Tables wiped per test (children before parents):
 *   lib_programme_completions, lib_programme_progress, lib_reading_logs
 *   lib_reviews, lib_recommendations
 *   lib_reading_list_items, lib_reading_lists
 *   lib_fines, lib_checkouts, lib_class_set_checkouts
 *   lib_holds, lib_interlibrary_loans
 *   lib_catalogue_import_jobs
 *
 * Stable seed (lives across tests):
 *   lib_locations, lib_catalogue_items, lib_catalogue_copies,
 *   lib_checkout_policies, lib_reading_programmes
 *   + the sis_students / sis_guardians / sis_class_teachers /
 *     sis_enrollments bridges.
 */

// ── Reserved IDs in the m24 range (000000024xxx) ────────────────────

// Student bridge for school A — these IDs are placeholders. Because
// platform_students.person_id is UNIQUE and another fixture (e.g.
// portfolio) may have already seeded a row for the same STUDENT actor
// person_id, ensureLibrarySeed reads the *actual* id back via
// loadLibSchoolAStudentIds(client) and exposes it through getter-style
// async helpers. The exported const here is the "preferred new ID" if
// no other fixture has claimed the bridge yet.
export const TEST_LIB_STU_A_PLATFORM_ID_HINT = '019e0cf8-aaaa-7777-8888-000000024101';
export const TEST_LIB_STU_A_ID_HINT = '019e0cf8-aaaa-7777-8888-000000024102';

// The canonical resolved ids — populated lazily by ensureLibrarySeed.
// Tests should import these AFTER beforeAll has run ensureLibrarySeed.
export let TEST_LIB_STU_A_PLATFORM_ID = TEST_LIB_STU_A_PLATFORM_ID_HINT;
export let TEST_LIB_STU_A_ID = TEST_LIB_STU_A_ID_HINT;

// School B student (cross-school isolation for student-input surfaces)
export const TEST_LIB_STU_B_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000024201';
export const TEST_LIB_STU_B_PLATFORM_ID = '019e0cf8-aaaa-7777-8888-000000024202';
export const TEST_LIB_STU_B_ID = '019e0cf8-aaaa-7777-8888-000000024203';

// Guardian binding for the PARENT actor → student A
export const TEST_LIB_GUARDIAN_A_ID = '019e0cf8-aaaa-7777-8888-000000024301';
export const TEST_LIB_GUARDIAN_LINK_A_ID = '019e0cf8-aaaa-7777-8888-000000024302';

// Class-teacher + enrollment (for CLASS-targeted reading programme matching)
export const TEST_LIB_CLASS_TEACHER_LINK_A_ID = '019e0cf8-aaaa-7777-8888-000000024401';
export const TEST_LIB_ENROLLMENT_A_ID = '019e0cf8-aaaa-7777-8888-000000024402';

// Library catalogue rows — School A
export const TEST_LIB_LOCATION_A_ID = '019e0cf8-aaaa-7777-8888-000000024501';
export const TEST_LIB_LOCATION_DISPLAY_A_ID = '019e0cf8-aaaa-7777-8888-000000024502';

export const TEST_LIB_ITEM_A_ID = '019e0cf8-aaaa-7777-8888-000000024601';
export const TEST_LIB_ITEM_A2_ID = '019e0cf8-aaaa-7777-8888-000000024602';
export const TEST_LIB_ITEM_NOPCOPY_A_ID = '019e0cf8-aaaa-7777-8888-000000024603';

// 5 copies of item A (used for class-set tests where copy_count=3 etc)
export const TEST_LIB_COPY_A1_ID = '019e0cf8-aaaa-7777-8888-000000024701';
export const TEST_LIB_COPY_A2_ID = '019e0cf8-aaaa-7777-8888-000000024702';
export const TEST_LIB_COPY_A3_ID = '019e0cf8-aaaa-7777-8888-000000024703';
export const TEST_LIB_COPY_A4_ID = '019e0cf8-aaaa-7777-8888-000000024704';
export const TEST_LIB_COPY_A5_ID = '019e0cf8-aaaa-7777-8888-000000024705';
// One copy of item A2 (for hold-against-A2 tests)
export const TEST_LIB_COPY_A2_ITEM_ID = '019e0cf8-aaaa-7777-8888-000000024706';

export const TEST_LIB_COPY_A1_BARCODE = 'LIB-A-0001';
export const TEST_LIB_COPY_A2_BARCODE = 'LIB-A-0002';
export const TEST_LIB_COPY_A3_BARCODE = 'LIB-A-0003';
export const TEST_LIB_COPY_A4_BARCODE = 'LIB-A-0004';
export const TEST_LIB_COPY_A5_BARCODE = 'LIB-A-0005';
export const TEST_LIB_COPY_A2_ITEM_BARCODE = 'LIB-A2-0001';

// School B catalogue (cross-school isolation)
export const TEST_LIB_LOCATION_B_ID = '019e0cf8-aaaa-7777-8888-000000024801';
export const TEST_LIB_ITEM_B_ID = '019e0cf8-aaaa-7777-8888-000000024802';
export const TEST_LIB_COPY_B1_ID = '019e0cf8-aaaa-7777-8888-000000024803';
export const TEST_LIB_COPY_B1_BARCODE = 'LIB-B-0001';

// Checkout policies (one per (school, patron_type))
export const TEST_LIB_POLICY_A_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000024901';
export const TEST_LIB_POLICY_A_STAFF_ID = '019e0cf8-aaaa-7777-8888-000000024902';
export const TEST_LIB_POLICY_B_STUDENT_ID = '019e0cf8-aaaa-7777-8888-000000024903';

// Stable reading programme (SCHOOL_WIDE)
export const TEST_LIB_PROGRAMME_A_ID = '019e0cf8-aaaa-7777-8888-000000024a01';
export const TEST_LIB_PROGRAMME_CLASS_A_ID = '019e0cf8-aaaa-7777-8888-000000024a02';
export const TEST_LIB_PROGRAMME_B_ID = '019e0cf8-aaaa-7777-8888-000000024a03';

// Tables wiped per test (children before parents). lib_catalogue_items +
// lib_catalogue_copies + lib_locations + lib_checkout_policies +
// lib_reading_programmes are listed here so import / class-set / log
// tests don't leak rows into the next test. ensureLibrarySeed re-creates
// every canonical row.
const LIBRARY_TABLES = [
  'lib_programme_completions',
  'lib_programme_progress',
  'lib_reading_logs',
  'lib_reviews',
  'lib_recommendations',
  'lib_reading_list_items',
  'lib_reading_lists',
  'lib_fines',
  'lib_checkouts',
  'lib_class_set_checkouts',
  'lib_holds',
  'lib_interlibrary_loans',
  'lib_catalogue_import_jobs',
  'lib_catalogue_copies',
  'lib_catalogue_items',
  'lib_locations',
  'lib_checkout_policies',
  'lib_reading_programmes',
];

export async function resetLibraryTables(client: PrismaClient): Promise<void> {
  const list = LIBRARY_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);

  // Drain any library outbox rows so the in-memory recorder is the
  // only source of truth in assertions.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox
       WHERE topic LIKE 'lib.%'
         AND tenant_id IN ($1::uuid, $2::uuid)`,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );

  // Wipe school_config rows the recommendation-config tests insert.
  await client.$executeRawUnsafe(
    `DELETE FROM ${TEST_SCHEMA}.school_config WHERE config_key = 'library_recommendation_weights'`,
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
 * The catalogue + locations + checkout policies + reading programmes +
 * the cross-module SIS rows persist across tests.
 */
export async function ensureLibrarySeed(client: PrismaClient): Promise<void> {
  // ── Student actor bridging — the TEST_STUDENT_PERSON_ID iam_person +
  //    platform_users rows are already seeded by globalSetup. The bridge
  //    rows (platform_students + sis_students for school A) may already
  //    exist if another fixture (portfolio) seeded them for the same
  //    person id. platform_students.person_id is UNIQUE and
  //    sis_students.platform_student_id+school_id is UNIQUE, so use
  //    look-up-then-insert and update the exported `let` bindings to
  //    point at the canonical row.
  const psExisting = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM platform.platform_students WHERE person_id = $1::uuid LIMIT 1`,
    TEST_STUDENT_PERSON_ID,
  )) as Array<{ id: string }>;
  if (psExisting.length > 0) {
    TEST_LIB_STU_A_PLATFORM_ID = psExisting[0]!.id;
  } else {
    await client.$executeRawUnsafe(
      `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
       VALUES ($1::uuid, $2::uuid, 'Library', 'Student', true)
       ON CONFLICT (id) DO NOTHING`,
      TEST_LIB_STU_A_PLATFORM_ID_HINT,
      TEST_STUDENT_PERSON_ID,
    );
    TEST_LIB_STU_A_PLATFORM_ID = TEST_LIB_STU_A_PLATFORM_ID_HINT;
  }
  const ssExisting = (await client.$queryRawUnsafe(
    `SELECT id::text AS id FROM ${TEST_SCHEMA}.sis_students
       WHERE platform_student_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
    TEST_LIB_STU_A_PLATFORM_ID,
    TEST_SCHOOL_ID,
  )) as Array<{ id: string }>;
  if (ssExisting.length > 0) {
    TEST_LIB_STU_A_ID = ssExisting[0]!.id;
  } else {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.sis_students
         (id, platform_student_id, school_id, student_number, grade_level, enrollment_status)
       VALUES ($1::uuid, $2::uuid, $3::uuid, 'LIB-STU-A', '11', 'ENROLLED')
       ON CONFLICT (id) DO NOTHING`,
      TEST_LIB_STU_A_ID_HINT,
      TEST_LIB_STU_A_PLATFORM_ID,
      TEST_SCHOOL_ID,
    );
    TEST_LIB_STU_A_ID = TEST_LIB_STU_A_ID_HINT;
  }

  // ── Second student in school B (cross-school isolation).
  await ensureStudent(
    client,
    TEST_LIB_STU_B_PERSON_ID,
    TEST_LIB_STU_B_PLATFORM_ID,
    TEST_LIB_STU_B_ID,
    'Lib',
    'Student-B',
    TEST_SCHOOL_B_ID,
    'LIB-STU-B',
  );

  // ── Guardian binding for PARENT actor → student A.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians
       (id, person_id, account_id, school_id, family_id, relationship)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, NULL, 'PARENT')
     ON CONFLICT (school_id, person_id) DO UPDATE
       SET account_id = EXCLUDED.account_id`,
    TEST_LIB_GUARDIAN_A_ID,
    TEST_PARENT_PERSON_ID,
    TEST_PARENT_ACCOUNT_ID,
    TEST_SCHOOL_ID,
  );
  const gdRows = (await client.$queryRawUnsafe(
    `SELECT id::text FROM ${TEST_SCHEMA}.sis_guardians
       WHERE school_id = $1::uuid AND person_id = $2::uuid LIMIT 1`,
    TEST_SCHOOL_ID,
    TEST_PARENT_PERSON_ID,
  )) as Array<{ id: string }>;
  const realGuardianId = gdRows[0]?.id ?? TEST_LIB_GUARDIAN_A_ID;
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians
       (id, student_id, guardian_id, has_custody, is_emergency_contact,
        receives_reports, portal_access)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true, true, true, true)
     ON CONFLICT (student_id, guardian_id) DO UPDATE SET portal_access = true`,
    TEST_LIB_GUARDIAN_LINK_A_ID,
    TEST_LIB_STU_A_ID,
    realGuardianId,
  );

  // ── Class-teacher binding + enrollment so CLASS-targeted programmes
  //    match the student. sis_class_teachers + sis_enrollments.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_class_teachers
       (id, class_id, teacher_employee_id, is_primary_teacher)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true)
     ON CONFLICT (class_id, teacher_employee_id) DO NOTHING`,
    TEST_LIB_CLASS_TEACHER_LINK_A_ID,
    TEST_SIS_CLASS_ID,
    TEST_TEACHER_EMPLOYEE_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_enrollments
       (id, student_id, class_id, status, enrolled_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE', now())
     ON CONFLICT DO NOTHING`,
    TEST_LIB_ENROLLMENT_A_ID,
    TEST_LIB_STU_A_ID,
    TEST_SIS_CLASS_ID,
  );

  // ── Library locations (school A: 1 SHELF + 1 DISPLAY; school B: 1 SHELF).
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_locations (id, school_id, name, location_type, sort_order, is_active)
     VALUES ($1::uuid, $2::uuid, 'Fiction Shelf', 'SHELF', 1, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_LOCATION_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_locations (id, school_id, name, location_type, sort_order, is_active)
     VALUES ($1::uuid, $2::uuid, 'New Arrivals', 'DISPLAY', 2, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_LOCATION_DISPLAY_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_locations (id, school_id, name, location_type, sort_order, is_active)
     VALUES ($1::uuid, $2::uuid, 'B Fiction', 'SHELF', 1, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_LOCATION_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── Catalogue items.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_items
       (id, school_id, title, author, isbn, publisher, publish_year, category, dewey_decimal, description)
     VALUES ($1::uuid, $2::uuid, 'The Test Book', 'Jane Author', '978-1-111-11111-1',
             'TestPub', 2024, 'FIC', '813.54', 'A test fiction title.')
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_ITEM_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_items
       (id, school_id, title, author, isbn, category, dewey_decimal)
     VALUES ($1::uuid, $2::uuid, 'Another Title', 'Sam Author', '978-2-222-22222-2', 'NON', '500.0')
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_ITEM_A2_ID,
    TEST_SCHOOL_ID,
  );
  // Item with NO copies (used for hold-rejection test).
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_items
       (id, school_id, title, author)
     VALUES ($1::uuid, $2::uuid, 'No Copies Yet', 'Future Author')
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_ITEM_NOPCOPY_A_ID,
    TEST_SCHOOL_ID,
  );
  // School B item — cross-school isolation
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_items
       (id, school_id, title, author, isbn)
     VALUES ($1::uuid, $2::uuid, 'School B Only', 'B Author', '978-3-333-33333-3')
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_ITEM_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── Catalogue copies for item A (5 copies).
  const copies: Array<[string, string]> = [
    [TEST_LIB_COPY_A1_ID, TEST_LIB_COPY_A1_BARCODE],
    [TEST_LIB_COPY_A2_ID, TEST_LIB_COPY_A2_BARCODE],
    [TEST_LIB_COPY_A3_ID, TEST_LIB_COPY_A3_BARCODE],
    [TEST_LIB_COPY_A4_ID, TEST_LIB_COPY_A4_BARCODE],
    [TEST_LIB_COPY_A5_ID, TEST_LIB_COPY_A5_BARCODE],
  ];
  for (const [id, barcode] of copies) {
    await client.$executeRawUnsafe(
      `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_copies
         (id, catalogue_item_id, location_id, barcode, condition, is_available, location_status, replacement_value)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'GOOD', true, 'ON_SHELF', 12.50)
       ON CONFLICT (id) DO NOTHING`,
      id,
      TEST_LIB_ITEM_A_ID,
      TEST_LIB_LOCATION_A_ID,
      barcode,
    );
  }
  // Item A2 — 1 copy (for hold-against-A2 tests)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_copies
       (id, catalogue_item_id, location_id, barcode, condition, is_available, location_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'NEW', true, 'ON_SHELF')
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_COPY_A2_ITEM_ID,
    TEST_LIB_ITEM_A2_ID,
    TEST_LIB_LOCATION_A_ID,
    TEST_LIB_COPY_A2_ITEM_BARCODE,
  );
  // School B copy
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_catalogue_copies
       (id, catalogue_item_id, location_id, barcode, condition, is_available, location_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'NEW', true, 'ON_SHELF')
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_COPY_B1_ID,
    TEST_LIB_ITEM_B_ID,
    TEST_LIB_LOCATION_B_ID,
    TEST_LIB_COPY_B1_BARCODE,
  );

  // ── Checkout policies. School A: STUDENT (5 books / 14 days / 2 renewals / 0.25 per day),
  //    STAFF (10 books / 28 days / 3 renewals / 0.00). School B: STUDENT only.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_checkout_policies
       (id, school_id, patron_type, max_checkouts, loan_period_days, renewals_allowed, overdue_fine_per_day)
     VALUES ($1::uuid, $2::uuid, 'STUDENT', 5, 14, 2, 0.25)
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_POLICY_A_STUDENT_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_checkout_policies
       (id, school_id, patron_type, max_checkouts, loan_period_days, renewals_allowed, overdue_fine_per_day)
     VALUES ($1::uuid, $2::uuid, 'STAFF', 10, 28, 3, 0.00)
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_POLICY_A_STAFF_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_checkout_policies
       (id, school_id, patron_type, max_checkouts, loan_period_days, renewals_allowed, overdue_fine_per_day)
     VALUES ($1::uuid, $2::uuid, 'STUDENT', 5, 14, 2, 0.10)
     ON CONFLICT (id) DO NOTHING`,
    TEST_LIB_POLICY_B_STUDENT_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── Stable reading programmes (one SCHOOL_WIDE per school + one CLASS-targeted).
  // Re-set is_active to true on every reset because individual tests may
  // deactivate the row to exercise the inactive-filter branch.
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_reading_programmes
       (id, school_id, name, description, target_books, target_pages, is_active, target_audience_type)
     VALUES ($1::uuid, $2::uuid, 'Reader of the Year', 'Schoolwide', 3, 300, true, 'SCHOOL_WIDE')
     ON CONFLICT (id) DO UPDATE
       SET is_active = true, target_books = EXCLUDED.target_books, target_pages = EXCLUDED.target_pages`,
    TEST_LIB_PROGRAMME_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_reading_programmes
       (id, school_id, name, description, target_books, target_pages, is_active,
        target_audience_type, target_id)
     VALUES ($1::uuid, $2::uuid, 'Class Reading Challenge', 'Just our class', 2, 200, true,
             'CLASS', $3::uuid)
     ON CONFLICT (id) DO UPDATE
       SET is_active = true, target_books = EXCLUDED.target_books,
           target_pages = EXCLUDED.target_pages, target_id = EXCLUDED.target_id`,
    TEST_LIB_PROGRAMME_CLASS_A_ID,
    TEST_SCHOOL_ID,
    TEST_SIS_CLASS_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.lib_reading_programmes
       (id, school_id, name, description, target_books, is_active, target_audience_type)
     VALUES ($1::uuid, $2::uuid, 'B Schoolwide Reading', 'School B', 5, true, 'SCHOOL_WIDE')
     ON CONFLICT (id) DO UPDATE SET is_active = true`,
    TEST_LIB_PROGRAMME_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // Keep references alive (avoid unused-import warnings in strict tsc)
  void TEST_ADMIN_EMPLOYEE_ID;
}

export async function resetAndSeedLibrary(client: PrismaClient): Promise<void> {
  await resetLibraryTables(client);
  await ensureLibrarySeed(client);
}
