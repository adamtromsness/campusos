import { PrismaClient } from '@prisma/client';
import { generateId } from '@campusos/database';
import { TEST_SCHEMA, TEST_SCHOOL_ID } from '../helpers/tenant-context';
import { TEST_SIS_CLASS_ID } from '../fixtures/sis';
import { TEST_TEACHER_EMPLOYEE_ID } from '../helpers/actor';

/**
 * Small toolkit for m20-sis specs to seed per-test SIS rows.
 *
 * Each helper returns the freshly-minted id so the test can reference it.
 * Specs track their own arrays of created ids (personId, studentId,
 * guardianId, etc.) and call the corresponding cleanup helper in
 * beforeEach. The integration suite uses one tenant_test schema across
 * many specs, so per-spec cleanup is mandatory — TRUNCATEing shared
 * tables would wipe out fixtures or unrelated specs' rows.
 */

export interface SeededStudent {
  studentId: string;
  platformStudentId: string;
  personId: string;
  studentNumber: string;
}

export interface SeededGuardian {
  guardianId: string;
  personId: string;
  accountId: string;
}

export async function seedStudent(
  client: PrismaClient,
  opts: {
    schoolId?: string;
    studentNumber?: string;
    gradeLevel?: string;
    firstName?: string;
    lastName?: string;
    homeroomClassId?: string;
  } = {},
): Promise<SeededStudent> {
  const personId = generateId();
  const platformStudentId = generateId();
  const studentId = generateId();
  const studentNumber =
    opts.studentNumber ?? 'SIS-' + Math.random().toString(36).slice(2, 9).toUpperCase();
  const firstName = opts.firstName ?? 'Test';
  const lastName = opts.lastName ?? 'Student';

  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, $2, $3, 'STUDENT', true)`,
    personId,
    firstName,
    lastName,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_students (id, person_id, first_name, last_name, is_active)
     VALUES ($1::uuid, $2::uuid, $3, $4, true)`,
    platformStudentId,
    personId,
    firstName,
    lastName,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_students
       (id, platform_student_id, school_id, student_number, grade_level, homeroom_class_id, enrollment_status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, 'ENROLLED')`,
    studentId,
    platformStudentId,
    opts.schoolId ?? TEST_SCHOOL_ID,
    studentNumber,
    opts.gradeLevel ?? '5',
    opts.homeroomClassId ?? null,
  );

  return { studentId, platformStudentId, personId, studentNumber };
}

export async function seedGuardian(
  client: PrismaClient,
  opts: {
    schoolId?: string;
    familyId?: string;
    firstName?: string;
    lastName?: string;
    email?: string;
    relationship?: 'PARENT' | 'GUARDIAN' | 'GRANDPARENT' | 'FOSTER_PARENT' | 'OTHER';
  } = {},
): Promise<SeededGuardian> {
  const personId = generateId();
  const accountId = generateId();
  const guardianId = generateId();
  const firstName = opts.firstName ?? 'Test';
  const lastName = opts.lastName ?? 'Guardian';
  const email = opts.email ?? 'gd-' + guardianId + '@test.local';

  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, $2, $3, 'GUARDIAN', true)`,
    personId,
    firstName,
    lastName,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_users (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
     VALUES ($1::uuid, $2::uuid, $3, $4, 'ACTIVE', 'HUMAN', false)`,
    accountId,
    personId,
    email,
    firstName + ' ' + lastName,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, person_id, account_id, school_id, family_id, relationship)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6)`,
    guardianId,
    personId,
    accountId,
    opts.schoolId ?? TEST_SCHOOL_ID,
    opts.familyId ?? null,
    opts.relationship ?? 'PARENT',
  );

  return { guardianId, personId, accountId };
}

export async function linkStudentGuardian(
  client: PrismaClient,
  studentId: string,
  guardianId: string,
  opts: { hasCustody?: boolean; isEmergencyContact?: boolean } = {},
): Promise<string> {
  const linkId = generateId();
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_student_guardians
       (id, student_id, guardian_id, has_custody, is_emergency_contact, receives_reports)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, true)`,
    linkId,
    studentId,
    guardianId,
    opts.hasCustody ?? false,
    opts.isEmergencyContact ?? false,
  );
  return linkId;
}

export async function enrollStudent(
  client: PrismaClient,
  studentId: string,
  classId: string = TEST_SIS_CLASS_ID,
): Promise<string> {
  const enrId = generateId();
  const affected = await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_enrollments (id, student_id, class_id, status)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'ACTIVE')
     ON CONFLICT DO NOTHING`,
    enrId,
    studentId,
    classId,
  );
  // eslint-disable-next-line no-console
  if (affected === 0) console.log('[enrollStudent] no row inserted for', studentId, classId);
  return enrId;
}

/**
 * Idempotent guardian creation for a fixed (person_id, school_id) actor —
 * typically the parentActor() persona. Returns the guardian id (newly
 * created OR pre-existing from a prior spec).
 *
 * Cross-spec safety: sis_guardians has UNIQUE (school_id, person_id), so
 * a stable fixture actor like parentActor can only have ONE guardian row
 * at a time. ON CONFLICT DO NOTHING + SELECT lets each spec pick up the
 * row regardless of which spec created it first.
 */
export async function ensureGuardianForPerson(
  client: PrismaClient,
  personId: string,
  accountId: string,
  schoolId: string = TEST_SCHOOL_ID,
  relationship: 'PARENT' | 'GUARDIAN' | 'GRANDPARENT' | 'FOSTER_PARENT' | 'OTHER' = 'PARENT',
): Promise<string> {
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_guardians (id, person_id, account_id, school_id, family_id, relationship)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, NULL, $4)
     ON CONFLICT (school_id, person_id) DO NOTHING`,
    personId,
    accountId,
    schoolId,
    relationship,
  );
  const rows = await client.$queryRawUnsafe<Array<{ id: string }>>(
    `SELECT id::text FROM ${TEST_SCHEMA}.sis_guardians WHERE person_id = $1::uuid AND school_id = $2::uuid LIMIT 1`,
    personId,
    schoolId,
  );
  return rows[0]!.id;
}

export async function assignTeacherToClass(
  client: PrismaClient,
  classId: string = TEST_SIS_CLASS_ID,
  teacherEmployeeId: string = TEST_TEACHER_EMPLOYEE_ID,
): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.sis_class_teachers (id, class_id, teacher_employee_id, is_primary_teacher)
     VALUES ($1::uuid, $2::uuid, $3::uuid, true)
     ON CONFLICT (class_id, teacher_employee_id) DO NOTHING`,
    generateId(),
    classId,
    teacherEmployeeId,
  );
}

/**
 * Bulk-cleanup helper for a spec that has tracked the ids it created in
 * an array. Order matters: child rows first, then sis_students, then
 * platform_students, then iam_person. Each delete is parameterised on a
 * UUID[] so it short-circuits cleanly on an empty array.
 */
export async function cleanupSeededIds(
  client: PrismaClient,
  ids: {
    studentIds?: string[];
    platformStudentIds?: string[];
    guardianIds?: string[];
    personIds?: string[];
    accountIds?: string[];
  },
): Promise<void> {
  if (ids.studentIds?.length) {
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = ANY($1::uuid[])`,
      ids.studentIds,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_notes WHERE student_id = ANY($1::uuid[])`,
      ids.studentIds,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_enrollments WHERE student_id = ANY($1::uuid[])`,
      ids.studentIds,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_emergency_contacts WHERE student_id = ANY($1::uuid[])`,
      ids.studentIds,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
      ids.studentIds,
    );
  }
  if (ids.platformStudentIds?.length) {
    await client.$executeRawUnsafe(
      `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
      ids.platformStudentIds,
    );
  }
  if (ids.guardianIds?.length) {
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE guardian_id = ANY($1::uuid[])`,
      ids.guardianIds,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_family_relationships WHERE guardian_a_id = ANY($1::uuid[]) OR guardian_b_id = ANY($1::uuid[])`,
      ids.guardianIds,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = ANY($1::uuid[])`,
      ids.guardianIds,
    );
  }
  if (ids.accountIds?.length) {
    await client.$executeRawUnsafe(
      `DELETE FROM platform.platform_users WHERE id = ANY($1::uuid[])`,
      ids.accountIds,
    );
  }
  if (ids.personIds?.length) {
    await client.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
      ids.personIds,
    );
  }
}
