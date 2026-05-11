import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { createCipheriv, randomBytes, scryptSync } from 'crypto';

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-sis-advanced-c.ts — Phase 2 Cycle 13 sub-cycle c (P2-13c) Step 6 (seed).
 *
 * M20 SIS Advanced — Transcripts + Transfers + Lockers + Reporting Periods +
 * Awards + Medical Exemptions. Final sub-cycle of P2-13.
 *
 * Idempotent — gated on whether sis_lockers already has rows for the
 * demo school. Re-running is a no-op once seeded.
 *
 * Sections:
 *   A) 2 transcripts (1 OFFICIAL SENT, 1 UNOFFICIAL GENERATED) with
 *      12 frozen transcript_courses snapshots.
 *   B) 2 transcript_requests (1 SENT with linked invoice, 1 SUBMITTED
 *      no fee).
 *   C) 2 transfer_records (1 INCOMING received from Springfield
 *      Elementary, 1 OUTGOING sent to Riverside Academy).
 *   D) 10 lockers — 6 ASSIGNED with AES-256-GCM encrypted combinations,
 *      3 AVAILABLE, 1 OUT_OF_SERVICE.
 *   E) 3 reporting_periods (1 PUBLISHED Q1, 1 OPEN Q2, 1 UPCOMING Q3).
 *   F) 4 student_awards (HONOR_ROLL × 2, PERFECT_ATTENDANCE,
 *      SUBJECT_AWARD).
 *   G) 2 medical_exemption_records (1 current PE exemption, 1 expired
 *      SWIMMING exemption).
 */

const TENANT_SCHEMA = 'tenant_demo';

// Locker combination encryption — mirrors visitor PII wire format.
// Dev only; production deployments set SIS_LOCKER_KEY for at-rest
// encryption of locker combinations.
const KEY_MATERIAL = process.env.SIS_LOCKER_KEY || 'campusos-demo-locker-combination-key-2026';
const KEY_SALT = 'campusos-demo-locker-salt';

function deriveKey(): Buffer {
  return scryptSync(KEY_MATERIAL, KEY_SALT, 32);
}

function encryptCombination(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

async function seedSisAdvancedC(): Promise<void> {
  console.log('');
  console.log('  SIS Advanced C Seed (P2-13c Step 6)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' + TENANT_SCHEMA + '.sis_lockers WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  sis_lockers already populated for demo school. Skipping.');
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

  async function findUserByEmail(email: string): Promise<{ personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { personId: rows[0]!.person_id };
  }

  async function findGpaConfig(name: string): Promise<{ id: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.sis_gpa_configurations WHERE school_id = $1::uuid AND config_name = $2 LIMIT 1',
      schoolId,
      name,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('GPA config not found: ' + name);
    return { id: rows[0]!.id };
  }

  async function findAcademicYear(name: string): Promise<{ id: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.sis_academic_years WHERE name = $1 LIMIT 1',
      name,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('Academic year not found: ' + name);
    return { id: rows[0]!.id };
  }

  const principal = await findUserByEmail('principal@demo.campusos.dev');
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');
  const parent = await findUserByEmail('parent@demo.campusos.dev');

  const maya = await findStudent('Maya', 'Chen');
  const aaliyah = await findStudent('Aaliyah', 'Johnson');
  const ethan = await findStudent('Ethan', 'Rodriguez');

  const gpaConfig = await findGpaConfig('Weighted (Honors plus AP)');
  const academicYear = await findAcademicYear('2025-2026');

  // ── A. 2 transcripts + 12 frozen transcript_courses ──
  console.log('  Seeding 2 transcripts + 12 frozen transcript_courses...');
  const transcriptOfficial = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_transcripts (id, student_id, transcript_type, generated_by, gpa_config_id, ' +
      'cumulative_gpa_snapshot, total_credits, class_rank, class_size, recipient_name, ' +
      'recipient_address, status, sent_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'OFFICIAL', $3::uuid, $4::uuid, " +
      "3.875, 22.0, 5, 120, 'Stanford University Admissions', " +
      "'450 Serra Mall, Stanford, CA 94305', 'SENT', now() - interval '3 days')",
    transcriptOfficial,
    maya.studentId,
    principal.personId,
    gpaConfig.id,
  );

  const transcriptUnofficial = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_transcripts (id, student_id, transcript_type, generated_by, gpa_config_id, ' +
      'cumulative_gpa_snapshot, total_credits, class_rank, class_size, status) ' +
      "VALUES ($1::uuid, $2::uuid, 'UNOFFICIAL', $3::uuid, $4::uuid, " +
      "3.42, 18.0, 12, 120, 'GENERATED')",
    transcriptUnofficial,
    aaliyah.studentId,
    principal.personId,
    gpaConfig.id,
  );

  const courses: Array<{
    transcriptId: string;
    year: string;
    term: string;
    name: string;
    code: string;
    credits: number;
    grade: string;
    points: number;
    honors: boolean;
    ap: boolean;
  }> = [
    // Maya OFFICIAL — 8 courses across 2025-2026 Fall + Spring
    {
      transcriptId: transcriptOfficial,
      year: '2024-2025',
      term: 'Fall',
      name: 'Algebra II',
      code: 'MATH-202',
      credits: 1.0,
      grade: 'A',
      points: 4.0,
      honors: false,
      ap: false,
    },
    {
      transcriptId: transcriptOfficial,
      year: '2024-2025',
      term: 'Fall',
      name: 'English 10 Honors',
      code: 'ENG-201H',
      credits: 1.0,
      grade: 'A-',
      points: 3.7,
      honors: true,
      ap: false,
    },
    {
      transcriptId: transcriptOfficial,
      year: '2024-2025',
      term: 'Fall',
      name: 'Biology',
      code: 'SCI-101',
      credits: 1.0,
      grade: 'A',
      points: 4.0,
      honors: false,
      ap: false,
    },
    {
      transcriptId: transcriptOfficial,
      year: '2024-2025',
      term: 'Fall',
      name: 'World History',
      code: 'SS-101',
      credits: 1.0,
      grade: 'B+',
      points: 3.3,
      honors: false,
      ap: false,
    },
    {
      transcriptId: transcriptOfficial,
      year: '2025-2026',
      term: 'Fall',
      name: 'Pre-Calculus',
      code: 'MATH-301',
      credits: 1.0,
      grade: 'A',
      points: 4.0,
      honors: false,
      ap: false,
    },
    {
      transcriptId: transcriptOfficial,
      year: '2025-2026',
      term: 'Fall',
      name: 'AP US History',
      code: 'SS-202AP',
      credits: 1.0,
      grade: 'A-',
      points: 3.7,
      honors: false,
      ap: true,
    },
    {
      transcriptId: transcriptOfficial,
      year: '2025-2026',
      term: 'Fall',
      name: 'Chemistry Honors',
      code: 'SCI-201H',
      credits: 1.0,
      grade: 'A',
      points: 4.0,
      honors: true,
      ap: false,
    },
    {
      transcriptId: transcriptOfficial,
      year: '2025-2026',
      term: 'Fall',
      name: 'Spanish III',
      code: 'WL-301',
      credits: 1.0,
      grade: 'A',
      points: 4.0,
      honors: false,
      ap: false,
    },
    // Aaliyah UNOFFICIAL — 4 courses
    {
      transcriptId: transcriptUnofficial,
      year: '2024-2025',
      term: 'Fall',
      name: 'Algebra I',
      code: 'MATH-101',
      credits: 1.0,
      grade: 'B',
      points: 3.0,
      honors: false,
      ap: false,
    },
    {
      transcriptId: transcriptUnofficial,
      year: '2024-2025',
      term: 'Fall',
      name: 'English 9',
      code: 'ENG-101',
      credits: 1.0,
      grade: 'B+',
      points: 3.3,
      honors: false,
      ap: false,
    },
    {
      transcriptId: transcriptUnofficial,
      year: '2024-2025',
      term: 'Fall',
      name: 'Physical Science',
      code: 'SCI-091',
      credits: 1.0,
      grade: 'C+',
      points: 2.3,
      honors: false,
      ap: false,
    },
    {
      transcriptId: transcriptUnofficial,
      year: '2024-2025',
      term: 'Fall',
      name: 'PE 9',
      code: 'PE-101',
      credits: 0.5,
      grade: 'A',
      points: 4.0,
      honors: false,
      ap: false,
    },
  ];

  for (let i = 0; i < courses.length; i++) {
    const c = courses[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_transcript_courses (id, transcript_id, academic_year, term, course_name, course_code, credits, grade, grade_points, is_honors, is_ap, sort_order) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7::numeric, $8, $9::numeric, $10, $11, $12)',
      generateId(),
      c.transcriptId,
      c.year,
      c.term,
      c.name,
      c.code,
      c.credits,
      c.grade,
      c.points,
      c.honors,
      c.ap,
      i * 10,
    );
  }

  // ── B. 2 transcript_requests ──
  console.log('  Seeding 2 transcript_requests...');
  const requestSent = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_transcript_requests (id, student_id, requested_by, recipient_name, recipient_address, ' +
      'transcript_type, copies, fee_amount, fee_paid, status, processed_at, sent_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Stanford University Admissions', " +
      "'450 Serra Mall, Stanford, CA 94305', 'OFFICIAL', 1, 10.00, true, 'SENT', " +
      "now() - interval '5 days', now() - interval '3 days')",
    requestSent,
    maya.studentId,
    parent.personId,
  );

  const requestSubmitted = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_transcript_requests (id, student_id, requested_by, recipient_name, recipient_email, ' +
      'transcript_type, copies, fee_amount, fee_paid, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Local Community College', " +
      "'admissions@lcc.edu', 'UNOFFICIAL', 1, NULL, false, 'SUBMITTED', " +
      "'Requested via parent portal for dual-enrollment application.')",
    requestSubmitted,
    aaliyah.studentId,
    parent.personId,
  );

  // ── C. 2 transfer_records ──
  console.log('  Seeding 2 transfer_records...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_transfer_records (id, student_id, transfer_direction, other_school_name, ' +
      'other_school_country, transfer_date, records_received, records_sent, ' +
      'records_package_s3_key, recorded_by, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 'INCOMING', 'Springfield Elementary', " +
      "'United States', current_date - interval '90 days', true, false, " +
      "'transfers/aaliyah-johnson-incoming-2025-08.pdf', $3::uuid, " +
      "'Transferred mid-Year 9 from Springfield Elementary, IL.')",
    generateId(),
    aaliyah.studentId,
    principal.personId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_transfer_records (id, student_id, transfer_direction, other_school_name, ' +
      'transfer_date, records_received, records_sent, records_package_s3_key, ' +
      'recorded_by, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 'OUTGOING', 'Riverside Academy', " +
      "current_date - interval '30 days', false, true, " +
      "'transfers/ethan-rodriguez-outgoing-2026-04.pdf', $3::uuid, " +
      "'Family relocating out of state — records package mailed.')",
    generateId(),
    ethan.studentId,
    principal.personId,
  );

  // ── D. 10 lockers — 6 ASSIGNED (encrypted combos), 3 AVAILABLE, 1 OUT_OF_SERVICE ──
  console.log('  Seeding 10 lockers (combinations encrypted at rest)...');
  const assignedLockers: Array<{ number: string; loc: string; combo: string; studentId: string }> =
    [
      { number: 'A-101', loc: 'Hallway A, Floor 1', combo: '12-24-36', studentId: maya.studentId },
      {
        number: 'A-102',
        loc: 'Hallway A, Floor 1',
        combo: '08-16-32',
        studentId: aaliyah.studentId,
      },
      { number: 'A-103', loc: 'Hallway A, Floor 1', combo: '14-28-42', studentId: ethan.studentId },
      { number: 'B-201', loc: 'Hallway B, Floor 2', combo: '05-15-25', studentId: maya.studentId },
      {
        number: 'B-202',
        loc: 'Hallway B, Floor 2',
        combo: '07-21-35',
        studentId: aaliyah.studentId,
      },
      { number: 'B-203', loc: 'Hallway B, Floor 2', combo: '03-09-27', studentId: ethan.studentId },
    ];

  for (const l of assignedLockers) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_lockers (id, school_id, locker_number, location_description, combination_encrypted, ' +
        'status, assigned_to_student_id, assigned_at, academic_year) ' +
        "VALUES ($1::uuid, $2::uuid, $3, $4, $5, 'ASSIGNED', $6::uuid, current_date - interval '180 days', '2025-2026')",
      generateId(),
      schoolId,
      l.number,
      l.loc,
      encryptCombination(l.combo),
      l.studentId,
    );
  }

  for (const num of ['A-104', 'A-105', 'B-204']) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_lockers (id, school_id, locker_number, location_description, status) ' +
        "VALUES ($1::uuid, $2::uuid, $3, 'Hallway, Floor 1-2', 'AVAILABLE')",
      generateId(),
      schoolId,
      num,
    );
  }

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_lockers (id, school_id, locker_number, location_description, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 'C-301', 'Hallway C, Floor 3', 'OUT_OF_SERVICE', " +
      "'Door hinge broken — work order #FAC-2026-042 filed.')",
    generateId(),
    schoolId,
  );

  // ── E. 3 reporting_periods ──
  console.log('  Seeding 3 reporting_periods...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_reporting_periods (id, school_id, academic_year_id, name, period_type, ' +
      'start_date, end_date, grades_due_date, comments_due_date, status, published_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Q1 Progress Report', 'PROGRESS_REPORT', " +
      "'2025-08-15', '2025-10-15', '2025-10-20', '2025-10-25', 'PUBLISHED', " +
      "'2025-10-26 09:00:00+00')",
    generateId(),
    schoolId,
    academicYear.id,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_reporting_periods (id, school_id, academic_year_id, name, period_type, ' +
      'start_date, end_date, grades_due_date, comments_due_date, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Q2 Report Card', 'REPORT_CARD', " +
      "'2025-10-16', '2026-01-15', '2026-01-20', '2026-01-22', 'OPEN')",
    generateId(),
    schoolId,
    academicYear.id,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_reporting_periods (id, school_id, academic_year_id, name, period_type, ' +
      'start_date, end_date, grades_due_date, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Q3 Progress Report', 'PROGRESS_REPORT', " +
      "'2026-01-16', '2026-04-15', '2026-04-20', 'UPCOMING')",
    generateId(),
    schoolId,
    academicYear.id,
  );

  // ── F. 4 student_awards ──
  console.log('  Seeding 4 student_awards...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_awards (id, student_id, award_type, award_name, academic_year, term, ' +
      'awarded_by, awarded_at, description) ' +
      "VALUES ($1::uuid, $2::uuid, 'HONOR_ROLL', 'Q1 Honor Roll', '2025-2026', 'Q1', " +
      "$3::uuid, current_date - interval '60 days', 'GPA 3.5 or higher for Q1.')",
    generateId(),
    maya.studentId,
    principal.personId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_awards (id, student_id, award_type, award_name, academic_year, term, ' +
      'awarded_by, awarded_at, description) ' +
      "VALUES ($1::uuid, $2::uuid, 'HONOR_ROLL', 'Q1 Honor Roll', '2025-2026', 'Q1', " +
      "$3::uuid, current_date - interval '60 days', 'GPA 3.5 or higher for Q1.')",
    generateId(),
    aaliyah.studentId,
    principal.personId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_awards (id, student_id, award_type, award_name, academic_year, ' +
      'awarded_by, awarded_at, description) ' +
      "VALUES ($1::uuid, $2::uuid, 'PERFECT_ATTENDANCE', 'Perfect Attendance — Q1', " +
      "'2025-2026', $3::uuid, current_date - interval '60 days', " +
      "'No absences during Q1 reporting period.')",
    generateId(),
    maya.studentId,
    principal.personId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_student_awards (id, student_id, award_type, award_name, academic_year, term, ' +
      'awarded_by, awarded_at, description) ' +
      "VALUES ($1::uuid, $2::uuid, 'SUBJECT_AWARD', 'Outstanding Chemistry Student', " +
      "'2025-2026', 'Q1', $3::uuid, current_date - interval '45 days', " +
      "'Highest Q1 score in Chemistry Honors.')",
    generateId(),
    maya.studentId,
    teacher.personId,
  );

  // ── G. 2 medical_exemption_records ──
  console.log('  Seeding 2 medical_exemption_records...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_medical_exemption_records (id, student_id, exemption_type, reason, ' +
      'doctor_note_s3_key, effective_from, effective_to, approved_by, approved_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'PE', " +
      "'Recovering from knee surgery — no high-impact activity for 6 weeks.', " +
      "'medical/ethan-pe-exemption-2026-04.pdf', current_date - interval '14 days', " +
      "current_date + interval '28 days', $3::uuid, now() - interval '14 days')",
    generateId(),
    ethan.studentId,
    principal.personId,
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sis_medical_exemption_records (id, student_id, exemption_type, reason, ' +
      'doctor_note_s3_key, effective_from, effective_to, approved_by, approved_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'SWIMMING', " +
      "'Chronic ear infection — cleared after course of antibiotics.', " +
      "'medical/aaliyah-swimming-exemption-2025-09.pdf', '2025-09-01', '2025-10-15', " +
      "$3::uuid, '2025-09-02 10:00:00+00')",
    generateId(),
    aaliyah.studentId,
    principal.personId,
  );

  console.log('');
  console.log('  SIS Advanced C seed complete.');
  console.log('    Transcripts: 2 (1 OFFICIAL SENT, 1 UNOFFICIAL GENERATED)');
  console.log('    Transcript courses: 12 (frozen at generation time — never live join)');
  console.log('    Transcript requests: 2 (1 SENT with fee, 1 SUBMITTED no fee)');
  console.log('    Transfer records: 2 (1 INCOMING, 1 OUTGOING)');
  console.log('    Lockers: 10 (6 ASSIGNED encrypted, 3 AVAILABLE, 1 OUT_OF_SERVICE)');
  console.log('    Reporting periods: 3 (1 PUBLISHED, 1 OPEN, 1 UPCOMING)');
  console.log('    Student awards: 4 (HONOR_ROLL × 2, PERFECT_ATTENDANCE, SUBJECT_AWARD)');
  console.log('    Medical exemptions: 2 (1 current PE, 1 expired SWIMMING)');
}

seedSisAdvancedC()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
