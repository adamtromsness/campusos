import { config } from "dotenv";
config({ path: ["../../.env.local", "../../.env", ".env"] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

var TENANT_SCHEMA = 'tenant_demo';

interface StudentSpec {
  firstName: string;
  lastName: string;
  gradeLevel: string;
  studentNumber: string;
}

interface GuardianSpec {
  firstName: string;
  lastName: string;
  email: string;
  relationship: string;
}

interface FamilySpec {
  name: string;
  studentNames: string[];
  guardianNames: string[];
}

var NEW_STUDENTS: StudentSpec[] = [
  { firstName: 'Ethan',    lastName: 'Rodriguez', gradeLevel: '9',  studentNumber: 'S-1002' },
  { firstName: 'Aaliyah',  lastName: 'Johnson',   gradeLevel: '9',  studentNumber: 'S-1003' },
  { firstName: 'Liam',     lastName: "O'Connor",  gradeLevel: '9',  studentNumber: 'S-1004' },
  { firstName: 'Sofia',    lastName: 'Patel',     gradeLevel: '9',  studentNumber: 'S-1005' },
  { firstName: 'Noah',     lastName: 'Williams',  gradeLevel: '9',  studentNumber: 'S-1006' },
  { firstName: 'Emma',     lastName: 'Goldberg',  gradeLevel: '9',  studentNumber: 'S-1007' },
  { firstName: 'Zara',     lastName: 'Patel',     gradeLevel: '9',  studentNumber: 'S-1008' },
  { firstName: 'Mason',    lastName: 'Goldberg',  gradeLevel: '10', studentNumber: 'S-1009' },
  { firstName: 'Olivia',   lastName: 'Williams',  gradeLevel: '10', studentNumber: 'S-1010' },
  { firstName: 'Lucas',    lastName: 'Tanaka',    gradeLevel: '10', studentNumber: 'S-1011' },
  { firstName: 'Isabella', lastName: 'Rodriguez', gradeLevel: '10', studentNumber: 'S-1012' },
  { firstName: 'Aiden',    lastName: 'Johnson',   gradeLevel: '10', studentNumber: 'S-1013' },
  { firstName: 'Jackson',  lastName: 'Tanaka',    gradeLevel: '10', studentNumber: 'S-1014' },
  { firstName: 'Chloe',    lastName: 'Tanaka',    gradeLevel: '10', studentNumber: 'S-1015' },
];

var NEW_GUARDIANS: GuardianSpec[] = [
  { firstName: 'Carmen',  lastName: 'Rodriguez', email: 'crodriguez@parents.demo.campusos.dev', relationship: 'PARENT' },
  { firstName: 'Tasha',   lastName: 'Johnson',   email: 'tjohnson@parents.demo.campusos.dev',   relationship: 'PARENT' },
  { firstName: 'Patrick', lastName: "O'Connor",  email: 'poconnor@parents.demo.campusos.dev',   relationship: 'PARENT' },
  { firstName: 'Raj',     lastName: 'Patel',     email: 'rpatel@parents.demo.campusos.dev',     relationship: 'PARENT' },
  { firstName: 'Marcus',  lastName: 'Williams',  email: 'mwilliams@parents.demo.campusos.dev',  relationship: 'PARENT' },
  { firstName: 'Janelle', lastName: 'Williams',  email: 'jwilliams@parents.demo.campusos.dev',  relationship: 'PARENT' },
  { firstName: 'Rivka',   lastName: 'Goldberg',  email: 'rgoldberg@parents.demo.campusos.dev',  relationship: 'PARENT' },
  { firstName: 'Yuki',    lastName: 'Tanaka',    email: 'ytanaka@parents.demo.campusos.dev',    relationship: 'PARENT' },
  { firstName: 'Hiro',    lastName: 'Tanaka',    email: 'htanaka@parents.demo.campusos.dev',    relationship: 'PARENT' },
];

var FAMILIES: FamilySpec[] = [
  { name: 'Chen Family',      studentNames: ['Maya Chen'],                                          guardianNames: ['David Chen'] },
  { name: 'Rodriguez Family', studentNames: ['Ethan Rodriguez', 'Isabella Rodriguez'],              guardianNames: ['Carmen Rodriguez'] },
  { name: 'Johnson Family',   studentNames: ['Aaliyah Johnson', 'Aiden Johnson'],                   guardianNames: ['Tasha Johnson'] },
  { name: "O'Connor Family",  studentNames: ["Liam O'Connor"],                                      guardianNames: ["Patrick O'Connor"] },
  { name: 'Patel Family',     studentNames: ['Sofia Patel', 'Zara Patel'],                          guardianNames: ['Raj Patel'] },
  { name: 'Williams Family',  studentNames: ['Noah Williams', 'Olivia Williams'],                   guardianNames: ['Marcus Williams', 'Janelle Williams'] },
  { name: 'Goldberg Family',  studentNames: ['Emma Goldberg', 'Mason Goldberg'],                    guardianNames: ['Rivka Goldberg'] },
  { name: 'Tanaka Family',    studentNames: ['Lucas Tanaka', 'Jackson Tanaka', 'Chloe Tanaka'],     guardianNames: ['Yuki Tanaka', 'Hiro Tanaka'] },
];

var COURSES = [
  { code: 'MATH-101', name: 'Algebra 1',     dept: 'MATH', grade: '9'  },
  { code: 'MATH-201', name: 'Geometry',      dept: 'MATH', grade: '10' },
  { code: 'ELA-101',  name: 'English 9',     dept: 'ELA',  grade: '9'  },
  { code: 'SCI-101',  name: 'Biology',       dept: 'SCI',  grade: '9'  },
  { code: 'SCI-201',  name: 'Chemistry',     dept: 'SCI',  grade: '10' },
  { code: 'SS-101',   name: 'World History', dept: 'SS',   grade: '9'  },
];

var CLASSES = [
  { period: '1', courseCode: 'MATH-101', room: '101' },
  { period: '2', courseCode: 'ELA-101',  room: '102' },
  { period: '3', courseCode: 'SCI-101',  room: '103' },
  { period: '4', courseCode: 'SS-101',   room: '104' },
  { period: '5', courseCode: 'MATH-201', room: '105' },
  { period: '6', courseCode: 'SCI-201',  room: '106' },
];

var ENROLLMENTS: Record<string, string[]> = {
  '1': ['Maya Chen', 'Ethan Rodriguez', 'Aaliyah Johnson', "Liam O'Connor", 'Sofia Patel', 'Noah Williams', 'Emma Goldberg', 'Zara Patel'],
  '2': ['Maya Chen', 'Ethan Rodriguez', 'Aaliyah Johnson', "Liam O'Connor", 'Sofia Patel', 'Noah Williams', 'Emma Goldberg', 'Zara Patel'],
  '3': ['Maya Chen', 'Ethan Rodriguez', 'Aaliyah Johnson', "Liam O'Connor", 'Sofia Patel', 'Emma Goldberg'],
  '4': ['Maya Chen', 'Ethan Rodriguez', "Liam O'Connor", 'Sofia Patel', 'Noah Williams'],
  '5': ['Mason Goldberg', 'Olivia Williams', 'Lucas Tanaka', 'Isabella Rodriguez', 'Aiden Johnson', 'Jackson Tanaka', 'Chloe Tanaka'],
  '6': ['Mason Goldberg', 'Olivia Williams', 'Lucas Tanaka', 'Isabella Rodriguez', 'Aiden Johnson', 'Jackson Tanaka', 'Chloe Tanaka'],
};

async function seedSis() {
  console.log('');
  console.log('  SIS Seed');
  console.log('');

  var client = getPlatformClient();

  // ── Idempotency check ──
  var existingCount = await client.$queryRawUnsafe<Array<{ count: bigint }>>(
    'SELECT count(*)::bigint AS count FROM ' + TENANT_SCHEMA + '.sis_students'
  );
  if (existingCount[0] && existingCount[0].count > 0n) {
    console.log('  SIS data already seeded (' + existingCount[0].count + ' sis_students rows) — skipping');
    return;
  }

  // ── Look up dependencies seeded by seed.ts ──
  var school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  var schoolId = school.id;

  var principal = await client.platformUser.findFirst({ where: { email: 'principal@demo.campusos.dev' } });
  if (!principal) throw new Error('principal@demo.campusos.dev not found — run pnpm seed first');
  var createdBy = principal.id;

  var teacherUser = await client.platformUser.findFirst({ where: { email: 'teacher@demo.campusos.dev' } });
  if (!teacherUser) throw new Error('teacher@demo.campusos.dev not found — run pnpm seed first');
  var teacherPersonId = teacherUser.personId;
  var teacherUserId = teacherUser.id;

  var mayaPerson = await client.iamPerson.findFirst({ where: { firstName: 'Maya', lastName: 'Chen' } });
  if (!mayaPerson) throw new Error('Maya Chen iam_person not found');
  var mayaPlatformStudent = await client.platformStudent.findFirst({ where: { personId: mayaPerson.id } });
  if (!mayaPlatformStudent) throw new Error('Maya platform_student not found');

  var davidPerson = await client.iamPerson.findFirst({ where: { firstName: 'David', lastName: 'Chen' } });
  if (!davidPerson) throw new Error('David Chen iam_person not found');
  var davidUser = await client.platformUser.findFirst({ where: { personId: davidPerson.id } });
  if (!davidUser) throw new Error('David Chen platform_user not found');

  // ── Phase 1: Platform-side identity for the 14 new students + 9 new guardians ──
  var personByName: Record<string, string> = {};
  var platformStudentByName: Record<string, string> = {};
  var platformUserByName: Record<string, string> = {};

  personByName['Maya Chen'] = mayaPerson.id;
  platformStudentByName['Maya Chen'] = mayaPlatformStudent.id;
  personByName['David Chen'] = davidPerson.id;
  platformUserByName['David Chen'] = davidUser.id;

  for (var i = 0; i < NEW_STUDENTS.length; i++) {
    var s = NEW_STUDENTS[i]!;
    var personId = generateId();
    await client.iamPerson.create({
      data: {
        id: personId,
        firstName: s.firstName,
        lastName: s.lastName,
        personType: 'STUDENT',
        isActive: true,
      },
    });
    var platformStudentId = generateId();
    await client.platformStudent.create({
      data: {
        id: platformStudentId,
        personId: personId,
        firstName: s.firstName,
        lastName: s.lastName,
        isActive: true,
        dataSubjectIsSelf: false,
      },
    });
    var fullName = s.firstName + ' ' + s.lastName;
    personByName[fullName] = personId;
    platformStudentByName[fullName] = platformStudentId;
  }
  console.log('  ' + NEW_STUDENTS.length + ' new students created (iam_person + platform_students)');

  for (var gi = 0; gi < NEW_GUARDIANS.length; gi++) {
    var g = NEW_GUARDIANS[gi]!;
    var gPersonId = generateId();
    await client.iamPerson.create({
      data: {
        id: gPersonId,
        firstName: g.firstName,
        lastName: g.lastName,
        personType: 'GUARDIAN',
        isActive: true,
      },
    });
    var gUserId = generateId();
    await client.platformUser.create({
      data: {
        id: gUserId,
        personId: gPersonId,
        email: g.email,
        displayName: g.firstName + ' ' + g.lastName,
        accountStatus: 'ACTIVE',
        accountType: 'HUMAN',
      },
    });
    var gFullName = g.firstName + ' ' + g.lastName;
    personByName[gFullName] = gPersonId;
    platformUserByName[gFullName] = gUserId;
  }
  console.log('  ' + NEW_GUARDIANS.length + ' new guardians created (iam_person + platform_users)');

  // ── Phase 2: Tenant SIS data ──

  var academicYearId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' + TENANT_SCHEMA + '.sis_academic_years (id, school_id, name, start_date, end_date, is_current) VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6)',
    academicYearId, schoolId, '2025-2026', '2025-08-15', '2026-06-15', true
  );

  var termFallId = generateId();
  var termSpringId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' + TENANT_SCHEMA + '.sis_terms (id, academic_year_id, name, start_date, end_date, term_type) VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6)',
    termFallId, academicYearId, 'Fall 2025', '2025-08-15', '2025-12-19', 'SEMESTER'
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' + TENANT_SCHEMA + '.sis_terms (id, academic_year_id, name, start_date, end_date, term_type) VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6)',
    termSpringId, academicYearId, 'Spring 2026', '2026-01-12', '2026-06-15', 'SEMESTER'
  );
  console.log('  Academic year 2025-2026 + Fall/Spring terms');

  var deptIdByCode: Record<string, string> = {};
  var deptDefs = [
    { code: 'MATH', name: 'Mathematics' },
    { code: 'ELA',  name: 'English Language Arts' },
    { code: 'SCI',  name: 'Science' },
    { code: 'SS',   name: 'Social Studies' },
  ];
  for (var di = 0; di < deptDefs.length; di++) {
    var d = deptDefs[di]!;
    var deptId = generateId();
    deptIdByCode[d.code] = deptId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' + TENANT_SCHEMA + '.sis_departments (id, school_id, name) VALUES ($1::uuid, $2::uuid, $3)',
      deptId, schoolId, d.name
    );
  }
  console.log('  4 departments');

  var courseIdByCode: Record<string, string> = {};
  for (var ci = 0; ci < COURSES.length; ci++) {
    var c = COURSES[ci]!;
    var courseId = generateId();
    courseIdByCode[c.code] = courseId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' + TENANT_SCHEMA + '.sis_courses (id, school_id, department_id, code, name, credit_hours, grade_level) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::numeric, $7)',
      courseId, schoolId, deptIdByCode[c.dept]!, c.code, c.name, '1.0', c.grade
    );
  }
  console.log('  ' + COURSES.length + ' courses');

  var classIdByPeriod: Record<string, string> = {};
  for (var ki = 0; ki < CLASSES.length; ki++) {
    var cl = CLASSES[ki]!;
    var classId = generateId();
    classIdByPeriod[cl.period] = classId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' + TENANT_SCHEMA + '.sis_classes (id, school_id, course_id, academic_year_id, term_id, section_code, room, max_enrollment) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8)',
      classId, schoolId, courseIdByCode[cl.courseCode]!, academicYearId, termSpringId, cl.period, cl.room, 25
    );
  }
  console.log('  ' + CLASSES.length + ' classes (Spring 2026 term)');

  var teacherStaffId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' + TENANT_SCHEMA + '.sis_staff (id, person_id, account_id, school_id, staff_type) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5)',
    teacherStaffId, teacherPersonId, teacherUserId, schoolId, 'TEACHER'
  );
  for (var ti = 0; ti < CLASSES.length; ti++) {
    var tcl = CLASSES[ti]!;
    var ctId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' + TENANT_SCHEMA + '.sis_class_teachers (id, class_id, teacher_employee_id, is_primary_teacher) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
      ctId, classIdByPeriod[tcl.period]!, teacherPersonId, true
    );
  }
  console.log('  James Rivera assigned as TEACHER to all 6 classes');

  // sis_students
  var sisStudentIdByName: Record<string, string> = {};

  var mayaSisId = generateId();
  sisStudentIdByName['Maya Chen'] = mayaSisId;
  await client.$executeRawUnsafe(
    'INSERT INTO ' + TENANT_SCHEMA + '.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
    mayaSisId, mayaPlatformStudent.id, schoolId, 'S-1001', '9', 'ENROLLED'
  );
  for (var si2 = 0; si2 < NEW_STUDENTS.length; si2++) {
    var s2 = NEW_STUDENTS[si2]!;
    var fn2 = s2.firstName + ' ' + s2.lastName;
    var sisId = generateId();
    sisStudentIdByName[fn2] = sisId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' + TENANT_SCHEMA + '.sis_students (id, platform_student_id, school_id, student_number, grade_level, enrollment_status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
      sisId, platformStudentByName[fn2]!, schoolId, s2.studentNumber, s2.gradeLevel, 'ENROLLED'
    );
  }
  console.log('  15 sis_students');

  // sis_guardians
  var sisGuardianIdByName: Record<string, string> = {};

  var davidSisGuardianId = generateId();
  sisGuardianIdByName['David Chen'] = davidSisGuardianId;
  await client.$executeRawUnsafe(
    'INSERT INTO ' + TENANT_SCHEMA + '.sis_guardians (id, person_id, account_id, school_id, relationship, preferred_contact_method) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)',
    davidSisGuardianId, davidPerson.id, davidUser.id, schoolId, 'PARENT', 'EMAIL'
  );
  for (var gi2 = 0; gi2 < NEW_GUARDIANS.length; gi2++) {
    var g2 = NEW_GUARDIANS[gi2]!;
    var gfn = g2.firstName + ' ' + g2.lastName;
    var gSisId = generateId();
    sisGuardianIdByName[gfn] = gSisId;
    await client.$executeRawUnsafe(
      'INSERT INTO ' + TENANT_SCHEMA + '.sis_guardians (id, person_id, account_id, school_id, relationship, preferred_contact_method) VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6)',
      gSisId, personByName[gfn]!, platformUserByName[gfn]!, schoolId, g2.relationship, 'EMAIL'
    );
  }
  console.log('  10 sis_guardians (portal access enabled)');

  // sis_families + sis_family_members + back-reference sis_guardians.family_id
  for (var fi = 0; fi < FAMILIES.length; fi++) {
    var f = FAMILIES[fi]!;
    var familyId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' + TENANT_SCHEMA + '.sis_families (id, family_name, created_by) VALUES ($1::uuid, $2, $3::uuid)',
      familyId, f.name, createdBy
    );

    for (var sm = 0; sm < f.studentNames.length; sm++) {
      var stuName = f.studentNames[sm]!;
      var fmId = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO ' + TENANT_SCHEMA + '.sis_family_members (id, family_id, person_id, person_type, relationship_to_family, is_primary_contact) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
        fmId, familyId, personByName[stuName]!, 'STUDENT', 'CHILD', false
      );
    }
    for (var gm = 0; gm < f.guardianNames.length; gm++) {
      var grdName = f.guardianNames[gm]!;
      var fgId = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO ' + TENANT_SCHEMA + '.sis_family_members (id, family_id, person_id, person_type, relationship_to_family, is_primary_contact) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
        fgId, familyId, personByName[grdName]!, 'PARENT', null, gm === 0
      );
      await client.$executeRawUnsafe(
        'UPDATE ' + TENANT_SCHEMA + '.sis_guardians SET family_id = $1::uuid WHERE id = $2::uuid',
        familyId, sisGuardianIdByName[grdName]!
      );
    }
  }
  console.log('  ' + FAMILIES.length + ' sis_families with members');

  // sis_student_guardians — every student linked to every guardian in their family
  var linkCount = 0;
  for (var fj = 0; fj < FAMILIES.length; fj++) {
    var fam = FAMILIES[fj]!;
    for (var sj = 0; sj < fam.studentNames.length; sj++) {
      for (var gj = 0; gj < fam.guardianNames.length; gj++) {
        var sgId = generateId();
        await client.$executeRawUnsafe(
          'INSERT INTO ' + TENANT_SCHEMA + '.sis_student_guardians (id, student_id, guardian_id, has_custody, is_emergency_contact, receives_reports, portal_access, portal_access_scope) VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8)',
          sgId, sisStudentIdByName[fam.studentNames[sj]!]!, sisGuardianIdByName[fam.guardianNames[gj]!]!, true, true, true, true, 'FULL'
        );
        linkCount++;
      }
    }
  }
  console.log('  ' + linkCount + ' sis_student_guardians links');

  // sis_enrollments
  var enrollmentCount = 0;
  var periods = Object.keys(ENROLLMENTS);
  for (var pi = 0; pi < periods.length; pi++) {
    var period = periods[pi]!;
    var classId = classIdByPeriod[period]!;
    var roster = ENROLLMENTS[period]!;
    for (var ri = 0; ri < roster.length; ri++) {
      var enrId = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO ' + TENANT_SCHEMA + '.sis_enrollments (id, student_id, class_id, status) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
        enrId, sisStudentIdByName[roster[ri]!]!, classId, 'ACTIVE'
      );
      enrollmentCount++;
    }
  }
  console.log('  ' + enrollmentCount + ' sis_enrollments');

  // Today's pre-populated attendance
  var todayDate = new Date().toISOString().slice(0, 10);
  var schoolYearDate = '2025-08-15';
  var attendanceCount = 0;
  for (var pa = 0; pa < periods.length; pa++) {
    var pPeriod = periods[pa]!;
    var pClassId = classIdByPeriod[pPeriod]!;
    var pRoster = ENROLLMENTS[pPeriod]!;
    for (var ai = 0; ai < pRoster.length; ai++) {
      var arId = generateId();
      await client.$executeRawUnsafe(
        'INSERT INTO ' + TENANT_SCHEMA + '.sis_attendance_records (id, school_id, school_year, student_id, class_id, date, period, status, confirmation_status) VALUES ($1::uuid, $2::uuid, $3::date, $4::uuid, $5::uuid, $6::date, $7, $8, $9)',
        arId, schoolId, schoolYearDate, sisStudentIdByName[pRoster[ai]!]!, pClassId, todayDate, pPeriod, 'PRESENT', 'PRE_POPULATED'
      );
      attendanceCount++;
    }
  }
  console.log('  ' + attendanceCount + ' sis_attendance_records pre-populated for ' + todayDate);

  console.log('');
  console.log('  SIS seed complete!');
  console.log('  Next: rebuild permission cache → tsx src/build-cache.ts');
}

if (require.main === module) {
  seedSis()
    .then(function() { return disconnectAll(); })
    .then(function() { process.exit(0); })
    .catch(function(e) {
      console.error('SIS seed failed:', e);
      disconnectAll().then(function() { process.exit(1); });
    });
}

export { seedSis };
