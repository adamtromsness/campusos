import type { ResolvedActor } from '@modules/m00-platform';

/**
 * Stable test actor IDs. Reserved for the integration fixture set —
 * see helpers/tenant-context.ts for the 'aaaa-7777-8888-' suffix
 * convention.
 *
 * The full actor set:
 *   - admin   : school admin staff. isSchoolAdmin=true, has hr_employees row.
 *   - officer : non-admin procurement-officer-tier staff. personType=STAFF,
 *               has hr_employees row, isSchoolAdmin=false. Procurement
 *               services treat STAFF + non-admin as procurement officer.
 *   - teacher : non-admin non-officer staff. Used to exercise gate denials.
 *   - student : STUDENT persona. Used to exercise gate denials.
 *   - parent  : GUARDIAN persona. Used to exercise gate denials + row-scope.
 *
 * Loop 2 (this scaffold) only wires the admin. Officer/teacher/student/parent
 * actors land when the relevant test suites need them in later loops.
 */
export const TEST_ADMIN_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000000010';
export const TEST_ADMIN_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000000011';
export const TEST_ADMIN_EMPLOYEE_ID = '019e0cf8-aaaa-7777-8888-000000000012';

export const TEST_OFFICER_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000000020';
export const TEST_OFFICER_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000000021';
export const TEST_OFFICER_EMPLOYEE_ID = '019e0cf8-aaaa-7777-8888-000000000022';

export const TEST_TEACHER_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000000030';
export const TEST_TEACHER_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000000031';
export const TEST_TEACHER_EMPLOYEE_ID = '019e0cf8-aaaa-7777-8888-000000000032';

export const TEST_STUDENT_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000000040';
export const TEST_STUDENT_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000000041';

export const TEST_PARENT_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000000050';
export const TEST_PARENT_ACCOUNT_ID = '019e0cf8-aaaa-7777-8888-000000000051';

export function adminActor(): ResolvedActor {
  return {
    accountId: TEST_ADMIN_ACCOUNT_ID,
    personId: TEST_ADMIN_PERSON_ID,
    employeeId: TEST_ADMIN_EMPLOYEE_ID,
    personType: 'STAFF',
    isSchoolAdmin: true,
  };
}

export function officerActor(): ResolvedActor {
  return {
    accountId: TEST_OFFICER_ACCOUNT_ID,
    personId: TEST_OFFICER_PERSON_ID,
    employeeId: TEST_OFFICER_EMPLOYEE_ID,
    personType: 'STAFF',
    isSchoolAdmin: false,
  };
}

export function teacherActor(): ResolvedActor {
  return {
    accountId: TEST_TEACHER_ACCOUNT_ID,
    personId: TEST_TEACHER_PERSON_ID,
    employeeId: TEST_TEACHER_EMPLOYEE_ID,
    personType: 'STAFF',
    isSchoolAdmin: false,
  };
}

export function studentActor(): ResolvedActor {
  return {
    accountId: TEST_STUDENT_ACCOUNT_ID,
    personId: TEST_STUDENT_PERSON_ID,
    employeeId: null,
    personType: 'STUDENT',
    isSchoolAdmin: false,
  };
}

export function parentActor(): ResolvedActor {
  return {
    accountId: TEST_PARENT_ACCOUNT_ID,
    personId: TEST_PARENT_PERSON_ID,
    employeeId: null,
    personType: 'GUARDIAN',
    isSchoolAdmin: false,
  };
}
