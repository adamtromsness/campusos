import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-sis-graduation.ts — Phase 2 Cycle 13 sub-cycle b (P2-13b) Step 4.
 *
 * M20 SIS Advanced — Graduation + Service Learning + GPA.
 * Idempotent — gated on whether sis_graduation_requirements already
 * has rows for the demo school. Re-running is a no-op once seeded.
 *
 * Sections:
 *   A) 6 graduation requirements — CREDIT_TOTAL 24, SUBJECT_CREDIT
 *      English 4, SPECIFIC_COURSE World History, SERVICE_HOURS 40,
 *      ASSESSMENT SAT, MINIMUM_GPA 2.0.
 *   B) 10 graduation audits across 3 students (Maya / Aaliyah /
 *      Ethan Rodriguez) — 2 MET, 5 IN_PROGRESS, 3 NOT_MET.
 *   C) 1 service learning requirement — Grade 12, 40 hours,
 *      BEFORE_GRADUATION.
 *   D) 5 service learning hours — 3 APPROVED, 1 PENDING, 1 REJECTED.
 *   E) 2 GPA configs — UNWEIGHTED 4-point default, WEIGHTED 4-point
 *      with honors plus AP bonus.
 *   F) 6 GPA snapshots across 3 students using the WEIGHTED config —
 *      cumulative plus current term.
 *   G) 3 course prerequisites — Geometry requires Algebra 1 with C,
 *      Chemistry requires Biology with C, World History recommends
 *      English 9.
 *   H) 1 grade scale "Standard" — A+ through F with grade_points.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedSisGraduation(): Promise<void> {
  console.log('');
  console.log('  SIS Advanced B Seed (P2-13b Step 4)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.sis_graduation_requirements WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  sis_graduation_requirements already populated for demo school. Skipping.');
    return;
  }

  async function findStudent(firstName: string, lastName: string): Promise<{ studentId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS student_id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
        'WHERE ip.first_name = $1 AND ip.last_name = $2 LIMIT 1',
      firstName,
      lastName,
    )) as Array<{ student_id: string }>;
    if (rows.length === 0) throw new Error('Student not found: ' + firstName + ' ' + lastName);
    return { studentId: rows[0]!.student_id };
  }

  async function findCourse(code: string): Promise<{ courseId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS course_id FROM ' + TENANT_SCHEMA + '.sis_courses WHERE code = $1 LIMIT 1',
      code,
    )) as Array<{ course_id: string }>;
    if (rows.length === 0) throw new Error('Course not found: ' + code);
    return { courseId: rows[0]!.course_id };
  }

  async function findUserByEmail(email: string): Promise<{ personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { personId: rows[0]!.person_id };
  }

  const principal = await findUserByEmail('principal@demo.campusos.dev');
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');

  const maya = await findStudent('Maya', 'Chen');
  const aaliyah = await findStudent('Aaliyah', 'Johnson');
  const ethan = await findStudent('Ethan', 'Rodriguez');

  const worldHistory = await findCourse('SS-101');
  const algebra1 = await findCourse('MATH-101');
  const geometry = await findCourse('MATH-201');
  const biology = await findCourse('SCI-101');
  const chemistry = await findCourse('SCI-201');
  const english9 = await findCourse('ELA-101');

  // ── A. 6 graduation requirements ──
  console.log('  Seeding 6 graduation requirements...');
  const reqCreditTotalId = generateId();
  const reqEnglishCreditId = generateId();
  const reqWorldHistoryId = generateId();
  const reqServiceHoursId = generateId();
  const reqAssessmentSatId = generateId();
  const reqMinGpaId = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_graduation_requirements (id, school_id, requirement_type, requirement_name, credits_required, applies_to_grade_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'CREDIT_TOTAL', 'Total Credits — 24', 24.00, $3::text[])",
    reqCreditTotalId,
    schoolId,
    ['9', '10', '11', '12'],
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_graduation_requirements (id, school_id, requirement_type, requirement_name, subject_area, credits_required, applies_to_grade_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'SUBJECT_CREDIT', 'English — 4 Credits', 'English', 4.00, $3::text[])",
    reqEnglishCreditId,
    schoolId,
    ['9', '10', '11', '12'],
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_graduation_requirements (id, school_id, requirement_type, requirement_name, specific_course_id, applies_to_grade_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'SPECIFIC_COURSE', 'World History (Required)', $3::uuid, $4::text[])",
    reqWorldHistoryId,
    schoolId,
    worldHistory.courseId,
    ['9', '10', '11', '12'],
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_graduation_requirements (id, school_id, requirement_type, requirement_name, hours_required, applies_to_grade_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'SERVICE_HOURS', 'Service Learning — 40 Hours', 40, $3::text[])",
    reqServiceHoursId,
    schoolId,
    ['9', '10', '11', '12'],
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_graduation_requirements (id, school_id, requirement_type, requirement_name, assessment_name, applies_to_grade_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'ASSESSMENT', 'SAT (or equivalent)', 'SAT', $3::text[])",
    reqAssessmentSatId,
    schoolId,
    ['11', '12'],
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_graduation_requirements (id, school_id, requirement_type, requirement_name, minimum_gpa, applies_to_grade_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'MINIMUM_GPA', 'Minimum Cumulative GPA — 2.0', 2.00, $3::text[])",
    reqMinGpaId,
    schoolId,
    ['9', '10', '11', '12'],
  );

  // ── B. 10 graduation audits across 3 students ──
  console.log('  Seeding 10 graduation audits...');
  // Maya — strong student: 3 IN_PROGRESS, 1 MET (English Subject Credit at 4 / 4).
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, credits_earned, credits_remaining, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'IN_PROGRESS', 6.00, 18.00, 'Maya has 6 of 24 credits earned in Grade 9.')",
    generateId(),
    maya.studentId,
    reqCreditTotalId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, credits_earned, credits_remaining, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'IN_PROGRESS', 1.00, 3.00, 'Maya has 1 of 4 English credits earned (English 9 in progress).')",
    generateId(),
    maya.studentId,
    reqEnglishCreditId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MET', 'Maya completed World History in Fall 2025 with a B+.')",
    generateId(),
    maya.studentId,
    reqWorldHistoryId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'IN_PROGRESS', 'Maya has logged 12 of 40 service hours (3 approved entries).')",
    generateId(),
    maya.studentId,
    reqServiceHoursId,
  );

  // Aaliyah — Grade 9 in progress: 2 IN_PROGRESS, 1 NOT_MET.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, credits_earned, credits_remaining, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'IN_PROGRESS', 5.00, 19.00, 'Aaliyah has 5 of 24 credits earned in Grade 9.')",
    generateId(),
    aaliyah.studentId,
    reqCreditTotalId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, credits_earned, credits_remaining, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'IN_PROGRESS', 0.50, 3.50, 'Aaliyah is mid-semester in English 9 — 0.5 credits projected.')",
    generateId(),
    aaliyah.studentId,
    reqEnglishCreditId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'NOT_MET', 'Aaliyah has not yet enrolled in World History.')",
    generateId(),
    aaliyah.studentId,
    reqWorldHistoryId,
  );

  // Ethan — at-risk: 1 MET, 2 NOT_MET (treated as senior for audit demo).
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, credits_earned, credits_remaining, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'MET', 22.00, 2.00, 'Ethan needs 2 more credits — on track for graduation.')",
    generateId(),
    ethan.studentId,
    reqCreditTotalId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'NOT_MET', 'Ethan has not logged any approved service hours.')",
    generateId(),
    ethan.studentId,
    reqServiceHoursId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_graduation_audits (id, student_id, requirement_id, status, detail) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'NOT_MET', 'Ethan has not yet taken the SAT — senior year deadline approaching.')",
    generateId(),
    ethan.studentId,
    reqAssessmentSatId,
  );

  // ── C. 1 service learning requirement ──
  console.log('  Seeding 1 service learning requirement...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_service_learning_requirements (id, school_id, grade_level, required_hours, deadline_type) ' +
      "VALUES ($1::uuid, $2::uuid, '12', 40, 'BEFORE_GRADUATION')",
    generateId(),
    schoolId,
  );

  // ── D. 5 service learning hours (3 APPROVED, 1 PENDING, 1 REJECTED) ──
  console.log('  Seeding 5 service learning hours...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_service_learning_hours (id, student_id, organisation_name, activity_description, hours, service_date, supervisor_name, supervisor_contact, status, reviewed_by, reviewed_at, review_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 4.00, current_date - interval '30 days', 'Karen Mills', 'kmills@foodbank.org', 'APPROVED', $5::uuid, now(), $6)",
    generateId(),
    maya.studentId,
    'Springfield Community Food Bank',
    'Sorted and packed donations for distribution.',
    teacher.personId,
    'Verified with supervisor — letter on file.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_service_learning_hours (id, student_id, organisation_name, activity_description, hours, service_date, supervisor_name, supervisor_contact, status, reviewed_by, reviewed_at, review_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 4.00, current_date - interval '21 days', 'James Park', 'jpark@library.org', 'APPROVED', $5::uuid, now(), $6)",
    generateId(),
    maya.studentId,
    'Springfield Public Library',
    'Read aloud to children at Saturday story time.',
    teacher.personId,
    'Approved.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_service_learning_hours (id, student_id, organisation_name, activity_description, hours, service_date, supervisor_name, supervisor_contact, status, reviewed_by, reviewed_at, review_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 4.00, current_date - interval '14 days', 'Linda Park', 'lpark@library.org', 'APPROVED', $5::uuid, now(), $6)",
    generateId(),
    maya.studentId,
    'Springfield Public Library',
    'Shelved returns and assisted with summer reading program signup.',
    teacher.personId,
    'Approved.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_service_learning_hours (id, student_id, organisation_name, activity_description, hours, service_date, supervisor_name, supervisor_contact, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 3.00, current_date - interval '5 days', 'Carlos Reyes', 'creyes@animals.org', 'PENDING')",
    generateId(),
    aaliyah.studentId,
    'Springfield Animal Shelter',
    'Walked dogs and cleaned kennels.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_service_learning_hours (id, student_id, organisation_name, activity_description, hours, service_date, supervisor_name, supervisor_contact, status, reviewed_by, reviewed_at, review_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, 10.00, current_date - interval '60 days', NULL, NULL, 'REJECTED', $5::uuid, now(), $6)",
    generateId(),
    ethan.studentId,
    'Family Babysitting',
    'Babysat younger siblings.',
    principal.personId,
    'Service for immediate family does not qualify per school policy. Please contact the office for approved organisations.',
  );

  // ── E. 2 GPA configurations ──
  console.log('  Seeding 2 GPA configurations...');
  const unweightedId = generateId();
  const weightedId = generateId();
  const fourPointMapping = {
    'A+': 4.0,
    A: 4.0,
    'A-': 3.7,
    'B+': 3.3,
    B: 3.0,
    'B-': 2.7,
    'C+': 2.3,
    C: 2.0,
    'C-': 1.7,
    'D+': 1.3,
    D: 1.0,
    F: 0.0,
  };

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_gpa_configurations (id, school_id, config_name, calculation_method, scale_type, grade_point_mapping, honors_weight_bonus, ap_weight_bonus, is_default) ' +
      "VALUES ($1::uuid, $2::uuid, 'Standard Unweighted', 'UNWEIGHTED', 'FOUR_POINT', $3::jsonb, 0.0, 0.0, true)",
    unweightedId,
    schoolId,
    JSON.stringify(fourPointMapping),
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_gpa_configurations (id, school_id, config_name, calculation_method, scale_type, grade_point_mapping, honors_weight_bonus, ap_weight_bonus, is_default) ' +
      "VALUES ($1::uuid, $2::uuid, 'Weighted (Honors plus AP)', 'WEIGHTED', 'FOUR_POINT', $3::jsonb, 0.5, 1.0, false)",
    weightedId,
    schoolId,
    JSON.stringify(fourPointMapping),
  );

  // ── F. 6 GPA snapshots (2 per student — cumulative + Fall 2025 term) ──
  console.log('  Seeding 6 GPA snapshots...');
  const currentYearRows = (await client.$queryRawUnsafe(
    'SELECT id::text FROM ' +
      TENANT_SCHEMA +
      ".sis_academic_years WHERE name = '2025-2026' LIMIT 1",
  )) as Array<{ id: string }>;
  if (currentYearRows.length === 0) throw new Error('Academic year 2025-2026 not found');
  const yearId = currentYearRows[0]!.id;

  const fallTermRows = (await client.$queryRawUnsafe(
    'SELECT id::text FROM ' +
      TENANT_SCHEMA +
      ".sis_terms WHERE name = 'Fall 2025' AND academic_year_id = $1::uuid LIMIT 1",
    yearId,
  )) as Array<{ id: string }>;
  if (fallTermRows.length === 0) throw new Error('Fall 2025 term not found');
  const fallTermId = fallTermRows[0]!.id;

  // Maya — cumulative 3.65, term 3.80, rank 5 of 18.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_gpa_snapshots (id, student_id, gpa_config_id, academic_year_id, term_id, cumulative_gpa, term_gpa, total_credits_attempted, total_credits_earned, class_rank, class_size) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 3.650, 3.800, 6.0, 6.0, 5, 18)',
    generateId(),
    maya.studentId,
    weightedId,
    yearId,
    fallTermId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_gpa_snapshots (id, student_id, gpa_config_id, cumulative_gpa, total_credits_attempted, total_credits_earned, class_rank, class_size) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, 3.650, 6.0, 6.0, 5, 18)',
    generateId(),
    maya.studentId,
    weightedId,
  );

  // Aaliyah — cumulative 3.10, term 3.20, rank 12 of 18.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_gpa_snapshots (id, student_id, gpa_config_id, academic_year_id, term_id, cumulative_gpa, term_gpa, total_credits_attempted, total_credits_earned, class_rank, class_size) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 3.100, 3.200, 5.5, 5.0, 12, 18)',
    generateId(),
    aaliyah.studentId,
    weightedId,
    yearId,
    fallTermId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_gpa_snapshots (id, student_id, gpa_config_id, cumulative_gpa, total_credits_attempted, total_credits_earned, class_rank, class_size) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, 3.100, 5.5, 5.0, 12, 18)',
    generateId(),
    aaliyah.studentId,
    weightedId,
  );

  // Ethan — cumulative 1.80, term 1.60, rank 17 of 18 (at-risk).
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_gpa_snapshots (id, student_id, gpa_config_id, academic_year_id, term_id, cumulative_gpa, term_gpa, total_credits_attempted, total_credits_earned, class_rank, class_size) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 1.800, 1.600, 6.0, 5.0, 17, 18)',
    generateId(),
    ethan.studentId,
    weightedId,
    yearId,
    fallTermId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_gpa_snapshots (id, student_id, gpa_config_id, cumulative_gpa, total_credits_attempted, total_credits_earned, class_rank, class_size) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, 1.800, 6.0, 5.0, 17, 18)',
    generateId(),
    ethan.studentId,
    weightedId,
  );

  // ── G. 3 course prerequisites ──
  console.log('  Seeding 3 course prerequisites...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_course_prerequisites (id, course_id, prerequisite_course_id, is_mandatory, min_grade) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, true, 'C')",
    generateId(),
    geometry.courseId,
    algebra1.courseId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_course_prerequisites (id, course_id, prerequisite_course_id, is_mandatory, min_grade) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, true, 'C')",
    generateId(),
    chemistry.courseId,
    biology.courseId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_course_prerequisites (id, course_id, prerequisite_course_id, is_mandatory, min_grade) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, false, NULL)',
    generateId(),
    worldHistory.courseId,
    english9.courseId,
  );

  // ── H. 1 grade scale "Standard" — A+ through F ──
  console.log('  Seeding 1 grade scale (12 entries)...');
  const scale = [
    { letter: 'A+', min: 97.0, max: 100.0, points: 4.0, passing: true, sort: 10 },
    { letter: 'A', min: 93.0, max: 96.99, points: 4.0, passing: true, sort: 20 },
    { letter: 'A-', min: 90.0, max: 92.99, points: 3.7, passing: true, sort: 30 },
    { letter: 'B+', min: 87.0, max: 89.99, points: 3.3, passing: true, sort: 40 },
    { letter: 'B', min: 83.0, max: 86.99, points: 3.0, passing: true, sort: 50 },
    { letter: 'B-', min: 80.0, max: 82.99, points: 2.7, passing: true, sort: 60 },
    { letter: 'C+', min: 77.0, max: 79.99, points: 2.3, passing: true, sort: 70 },
    { letter: 'C', min: 73.0, max: 76.99, points: 2.0, passing: true, sort: 80 },
    { letter: 'C-', min: 70.0, max: 72.99, points: 1.7, passing: true, sort: 90 },
    { letter: 'D+', min: 67.0, max: 69.99, points: 1.3, passing: true, sort: 100 },
    { letter: 'D', min: 60.0, max: 66.99, points: 1.0, passing: true, sort: 110 },
    { letter: 'F', min: 0.0, max: 59.99, points: 0.0, passing: false, sort: 120 },
  ];
  for (const entry of scale) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_grade_scale_entries (id, school_id, scale_name, letter_grade, min_percentage, max_percentage, grade_points, is_passing, sort_order) ' +
        "VALUES ($1::uuid, $2::uuid, 'Standard', $3, $4::numeric, $5::numeric, $6::numeric, $7, $8)",
      generateId(),
      schoolId,
      entry.letter,
      entry.min,
      entry.max,
      entry.points,
      entry.passing,
      entry.sort,
    );
  }

  console.log('');
  console.log('  SIS Advanced B seed complete.');
  console.log(
    '    Graduation requirements: 6 (CREDIT_TOTAL/SUBJECT/COURSE/SERVICE/ASSESSMENT/GPA)',
  );
  console.log('    Graduation audits: 10 (2 MET, 5 IN_PROGRESS, 3 NOT_MET)');
  console.log('    Service learning requirements: 1 (Grade 12, 40 hours)');
  console.log('    Service learning hours: 5 (3 APPROVED, 1 PENDING, 1 REJECTED)');
  console.log('    GPA configs: 2 (UNWEIGHTED default, WEIGHTED)');
  console.log('    GPA snapshots: 6 (3 students × 2 — term + cumulative)');
  console.log('    Course prerequisites: 3 (Geometry, Chemistry, World History)');
  console.log('    Grade scale entries: 12 (Standard A+ through F)');
}

seedSisGraduation()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
