import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-enrolment-advanced.ts — Phase 2 Cycle 5 (P2-5).
 *
 * Idempotent — gated on whether enr_tour_slots already has rows
 * for the demo school.
 *
 * Sections:
 *   A) 3 published tour slots — 1 GENERAL_OPEN_DAY group (max 10),
 *      2 INDIVIDUAL_FAMILY_TOUR slots across the next 2 weeks.
 *   B) 2 tour bookings — 1 COMPLETED with linked_application_id
 *      pointing at one of the seeded applications, 1 CONFIRMED
 *      upcoming. 3 guests across the bookings.
 *   C) 1 COMPLETED withdrawal — Maya Chen transfer with all 7
 *      exit tasks COMPLETED.
 *   D) 1 IN_PROGRESS withdrawal — Aiden Park transfer with 4
 *      tasks COMPLETED + 3 PENDING.
 *   E) 5 re-enrolment confirmations for next year — 4
 *      confirmed_continuing=true, 1 confirmed_continuing=false
 *      (auto-initiated withdrawal linked).
 *   F) 1 ENROLLED mid-year admission linked to an existing
 *      application + 1 RECEIVED request awaiting capacity check.
 *
 * Note — the COMPLETED withdrawal in section C does NOT flip
 * sis_students.enrollment_status to WITHDRAWN at seed time. The
 * runtime WithdrawalService.complete() handles that flip inside
 * a tx; the seed leaves the student row alone so downstream seeds
 * (counselling caseloads, library checkouts, etc.) that reference
 * Maya as ACTIVE continue to work. The CAT script exercises a
 * fresh withdrawal end-to-end against a different student so the
 * flip is observable without disturbing the demo data lattice.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedEnrolmentAdvanced(): Promise<void> {
  console.log('');
  console.log('  Enrolment Advanced Seed (P2-5)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.enr_tour_slots WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  enr_tour_slots already populated for demo school. Skipping.');
    return;
  }

  await client.$executeRawUnsafe('SET search_path TO ' + TENANT_SCHEMA + ', platform, public');

  const principal = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
  });
  if (!principal) throw new Error('principal user not found — run pnpm seed first');
  const principalPersonId = principal.personId;

  const parentUser = await client.platformUser.findFirst({
    where: { email: 'parent@demo.campusos.dev' },
  });
  if (!parentUser) throw new Error('parent user not found — run pnpm seed first');
  const parentPersonId = parentUser.personId;

  // Find principal's hr_employees row for tour led_by
  const principalEmpRows = (await client.$queryRawUnsafe(
    'SELECT id FROM ' + TENANT_SCHEMA + '.hr_employees WHERE person_id = $1::uuid LIMIT 1',
    principalPersonId,
  )) as Array<{ id: string }>;
  const principalEmpId = principalEmpRows[0]?.id ?? null;

  // Find current academic year + next year
  const yearRows = (await client.$queryRawUnsafe(
    'SELECT id, name, is_current FROM ' +
      TENANT_SCHEMA +
      '.sis_academic_years ORDER BY start_date DESC LIMIT 5',
  )) as Array<{ id: string; name: string; is_current: boolean }>;
  if (yearRows.length === 0) throw new Error('no sis_academic_years rows — run seed-sis first');
  // pick a year that exists for re-enrolment (prefer the most recent, even if not "current")
  const targetYearId = yearRows[0]!.id;
  const targetYearName = yearRows[0]!.name;

  // Pick 5 students for re-enrolment + withdrawal
  const studentRows = (await client.$queryRawUnsafe(
    'SELECT id, student_number FROM ' +
      TENANT_SCHEMA +
      '.sis_students ORDER BY student_number LIMIT 6',
  )) as Array<{ id: string; student_number: string }>;
  if (studentRows.length < 6) throw new Error('need at least 6 sis_students for P2-5 seed');

  // Find Maya specifically for the COMPLETED withdrawal storyline
  const mayaRows = (await client.$queryRawUnsafe(
    'SELECT s.id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'JOIN platform.iam_person p ON p.id = ps.person_id ' +
      "WHERE p.first_name = 'Maya' AND p.last_name = 'Chen' LIMIT 1",
  )) as Array<{ id: string }>;
  const mayaStudentId = mayaRows[0]?.id ?? studentRows[0]!.id;

  // ============================================================
  // A) 3 tour slots
  // ============================================================
  const today = new Date();
  const todayIso = (offsetDays: number): string => {
    const d = new Date(today);
    d.setDate(today.getDate() + offsetDays);
    return d.toISOString().slice(0, 10);
  };

  const slotIds = {
    openDay: generateId(),
    individual1: generateId(),
    individual2: generateId(),
  };

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_tour_slots (id, school_id, tour_date, start_time, end_time, max_bookings, current_bookings, tour_type, led_by, meeting_point, notes, is_published) ' +
      'VALUES ($1::uuid, $2::uuid, $3::date, $4::time, $5::time, $6, $7, $8, $9::uuid, $10, $11, true)',
    slotIds.openDay,
    schoolId,
    todayIso(7),
    '10:00',
    '11:30',
    10,
    1,
    'GENERAL_OPEN_DAY',
    principalEmpId,
    'Reception, Main Entrance',
    'Spring Open Day — meet the head of school, tour classrooms, Q+A.',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_tour_slots (id, school_id, tour_date, start_time, end_time, max_bookings, current_bookings, tour_type, led_by, meeting_point, is_published) ' +
      'VALUES ($1::uuid, $2::uuid, $3::date, $4::time, $5::time, 1, 1, $6, $7::uuid, $8, true)',
    slotIds.individual1,
    schoolId,
    todayIso(3),
    '14:00',
    '15:00',
    'INDIVIDUAL_FAMILY_TOUR',
    principalEmpId,
    'Reception, Main Entrance',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_tour_slots (id, school_id, tour_date, start_time, end_time, max_bookings, current_bookings, tour_type, led_by, meeting_point, is_published) ' +
      'VALUES ($1::uuid, $2::uuid, $3::date, $4::time, $5::time, 1, 0, $6, $7::uuid, $8, true)',
    slotIds.individual2,
    schoolId,
    todayIso(10),
    '14:00',
    '15:00',
    'INDIVIDUAL_FAMILY_TOUR',
    principalEmpId,
    'Reception, Main Entrance',
  );
  console.log('  A. 3 published tour slots (1 group Open Day + 2 individual)');

  // ============================================================
  // B) Tour bookings + guests
  // ============================================================
  // Create one prospective-family iam_person at booking time (ADR-055)
  const sarahPersonId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO platform.iam_person (id, first_name, last_name, primary_phone, person_type) ' +
      "VALUES ($1::uuid, $2, $3, $4, 'GUARDIAN')",
    sarahPersonId,
    'Sarah',
    'Prospective',
    '+1-217-555-2001',
  );

  // Find an existing application to link the COMPLETED tour booking to
  const appRows = (await client.$queryRawUnsafe(
    'SELECT id FROM ' + TENANT_SCHEMA + '.enr_applications LIMIT 1',
  )) as Array<{ id: string }>;
  const linkedApplicationId = appRows[0]?.id ?? null;

  const bookingIds = {
    openDay: generateId(),
    individual: generateId(),
  };

  // Booking 1 — CONFIRMED on the upcoming Open Day
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_tour_bookings (id, slot_id, school_id, booked_by, family_name, contact_email, contact_phone, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, 'CONFIRMED', $8)",
    bookingIds.openDay,
    slotIds.openDay,
    schoolId,
    sarahPersonId,
    'Prospective Family',
    'sarah.prospective@example.com',
    '+1-217-555-2001',
    'Visiting from out of town — interested in Grade 5.',
  );

  // Booking 2 — historical individual tour COMPLETED, linked to an application
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_tour_bookings (id, slot_id, school_id, booked_by, family_name, contact_email, status, linked_application_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, 'COMPLETED', $7::uuid)",
    bookingIds.individual,
    slotIds.individual1,
    schoolId,
    parentPersonId,
    'Chen Family',
    'parent@demo.campusos.dev',
    linkedApplicationId,
  );
  console.log('  B. 2 tour bookings (1 CONFIRMED open day + 1 COMPLETED with linked application)');

  // 3 guests — Sarah herself ADULT + prospective student CHILD on Open Day,
  //            David Chen ADULT on the historical Chen tour
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_tour_booking_guests (id, booking_id, guest_type, first_name, last_name, age) VALUES ' +
      "($1::uuid, $2::uuid, 'ADULT', 'Sarah', 'Prospective', 38), " +
      "($3::uuid, $4::uuid, 'PROSPECTIVE_STUDENT', 'Jamie', 'Prospective', 10), " +
      "($5::uuid, $6::uuid, 'ADULT', 'David', 'Chen', 42)",
    generateId(),
    bookingIds.openDay,
    generateId(),
    bookingIds.openDay,
    generateId(),
    bookingIds.individual,
  );
  console.log('  B. 3 guests across the bookings');

  // ============================================================
  // C) Completed withdrawal — Maya Chen transfer
  // ============================================================
  const completedWithdrawalId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_withdrawal_requests (id, school_id, student_id, initiated_by, requested_by, withdrawal_reason_category, withdrawal_reason_detail, last_attendance_date, requested_at, destination_school_name, destination_school_country, records_release_consented, records_sent_at, status, completed_at, completed_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'FAMILY', $4::uuid, 'TRANSFER_TO_OTHER_SCHOOL', 'Family relocating to Madison, WI for new job opportunity.', $5::date, $6::timestamptz, 'Madison Country Day School', 'United States', true, $7::date, 'COMPLETED', $8::timestamptz, $9::uuid)",
    completedWithdrawalId,
    schoolId,
    mayaStudentId,
    parentPersonId,
    todayIso(-30),
    new Date(today.getTime() - 35 * 86400000).toISOString(),
    todayIso(-25),
    new Date(today.getTime() - 28 * 86400000).toISOString(),
    principalPersonId,
  );

  // 7 exit tasks all COMPLETED
  const completedTasks = [
    { name: 'Library books returned', cat: 'RECORDS' },
    { name: 'Device returned (Chromebook + charger)', cat: 'IT' },
    { name: 'Locker cleared', cat: 'FACILITIES' },
    { name: 'Outstanding fees resolved', cat: 'FINANCE' },
    { name: 'Records package prepared for transfer', cat: 'RECORDS' },
    { name: 'Bus assignment cancelled', cat: 'TRANSPORT' },
    { name: 'Lunch account closed', cat: 'ADMINISTRATIVE' },
  ];
  for (let i = 0; i < completedTasks.length; i++) {
    const t = completedTasks[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.enr_withdrawal_exit_tasks (id, withdrawal_id, task_name, task_category, status, completed_by, completed_at, sort_order) ' +
        "VALUES ($1::uuid, $2::uuid, $3, $4, 'COMPLETED', $5::uuid, $6::timestamptz, $7)",
      generateId(),
      completedWithdrawalId,
      t.name,
      t.cat,
      principalPersonId,
      new Date(today.getTime() - (28 - i) * 86400000).toISOString(),
      i,
    );
  }
  console.log('  C. 1 COMPLETED withdrawal (Maya Chen transfer, 7 exit tasks COMPLETED)');

  // ============================================================
  // D) In-progress withdrawal — Aiden Park
  // ============================================================
  const aidenRows = (await client.$queryRawUnsafe(
    'SELECT s.id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'JOIN platform.iam_person p ON p.id = ps.person_id ' +
      "WHERE p.first_name = 'Aiden' LIMIT 1",
  )) as Array<{ id: string }>;
  const aidenStudentId = aidenRows[0]?.id ?? studentRows[1]!.id;

  const inProgressWithdrawalId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_withdrawal_requests (id, school_id, student_id, initiated_by, requested_by, withdrawal_reason_category, withdrawal_reason_detail, last_attendance_date, requested_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'FAMILY', $4::uuid, 'FAMILY_RELOCATION', 'Family moving abroad next month.', $5::date, $6::timestamptz, 'IN_PROGRESS')",
    inProgressWithdrawalId,
    schoolId,
    aidenStudentId,
    parentPersonId,
    todayIso(14),
    new Date(today.getTime() - 7 * 86400000).toISOString(),
  );

  const inProgressTasks = [
    { name: 'Library books returned', cat: 'RECORDS', completed: true },
    { name: 'Device returned (Chromebook + charger)', cat: 'IT', completed: true },
    { name: 'Locker cleared', cat: 'FACILITIES', completed: true },
    { name: 'Outstanding fees resolved', cat: 'FINANCE', completed: true },
    { name: 'Records package prepared for transfer', cat: 'RECORDS', completed: false },
    { name: 'Bus assignment cancelled', cat: 'TRANSPORT', completed: false },
    { name: 'Lunch account closed', cat: 'ADMINISTRATIVE', completed: false },
  ];
  for (let i = 0; i < inProgressTasks.length; i++) {
    const t = inProgressTasks[i]!;
    if (t.completed) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.enr_withdrawal_exit_tasks (id, withdrawal_id, task_name, task_category, status, completed_by, completed_at, sort_order) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, 'COMPLETED', $5::uuid, $6::timestamptz, $7)",
        generateId(),
        inProgressWithdrawalId,
        t.name,
        t.cat,
        principalPersonId,
        new Date(today.getTime() - (5 - i) * 86400000).toISOString(),
        i,
      );
    } else {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.enr_withdrawal_exit_tasks (id, withdrawal_id, task_name, task_category, status, sort_order) ' +
          "VALUES ($1::uuid, $2::uuid, $3, $4, 'PENDING', $5)",
        generateId(),
        inProgressWithdrawalId,
        t.name,
        t.cat,
        i,
      );
    }
  }
  console.log('  D. 1 IN_PROGRESS withdrawal (4 COMPLETED + 3 PENDING)');

  // ============================================================
  // E) Re-enrolment confirmations
  // ============================================================
  // 4 continuing + 1 not continuing for next year
  const continuingStudents = studentRows.slice(0, 4);
  for (const s of continuingStudents) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.enr_reenrollment_confirmations (id, school_id, student_id, academic_year_id, submitted_by, confirmed_continuing, processed_by, processed_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, true, $6::uuid, $7::timestamptz)',
      generateId(),
      schoolId,
      s.id,
      targetYearId,
      parentPersonId,
      principalPersonId,
      new Date(today.getTime() - 3 * 86400000).toISOString(),
    );
  }

  // 1 not continuing — link to a fresh withdrawal request (the
  // ReenrolmentService.submit auto-initiates this in production;
  // the seed materialises both rows so the dashboard tile is
  // populated for the demo).
  const departingStudent = studentRows[4]!;
  const autoWithdrawalId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_withdrawal_requests (id, school_id, student_id, initiated_by, requested_by, withdrawal_reason_category, withdrawal_reason_detail, last_attendance_date, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'FAMILY', $4::uuid, 'OTHER', 'Auto-initiated from re-enrolment confirmation (confirmed_continuing=false).', $5::date, 'REQUESTED', 'Auto-initiated by ReenrolmentService.')",
    autoWithdrawalId,
    schoolId,
    departingStudent.id,
    parentPersonId,
    todayIso(60),
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_reenrollment_confirmations (id, school_id, student_id, academic_year_id, submitted_by, confirmed_continuing, withdrawal_reason, linked_withdrawal_id, processed_by, processed_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, false, $6, $7::uuid, $8::uuid, $9::timestamptz)',
    generateId(),
    schoolId,
    departingStudent.id,
    targetYearId,
    parentPersonId,
    'Family relocating to a different state at the end of this academic year.',
    autoWithdrawalId,
    principalPersonId,
    new Date(today.getTime() - 1 * 86400000).toISOString(),
  );
  console.log(
    '  E. 5 re-enrolment confirmations for ' +
      targetYearName +
      ' (4 continuing + 1 departing with auto-initiated withdrawal)',
  );

  // ============================================================
  // F) Mid-year admission requests
  // ============================================================
  // 1 ENROLLED with linked_application_id
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_mid_year_admission_requests (id, school_id, requested_by, student_first_name, student_last_name, student_date_of_birth, applying_for_grade_level, requested_start_date, admission_reason, admission_reason_detail, previous_school_name, previous_school_country, records_requested, status, capacity_available, capacity_checked_at, capacity_checked_by, linked_application_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7, $8::date, 'TRANSFER_FROM_OTHER_SCHOOL', 'Family moved from California after parents took new positions.', 'Pacific Crest Academy', 'United States', true, 'ENROLLED', true, $9::timestamptz, $10::uuid, $11::uuid)",
    generateId(),
    schoolId,
    parentPersonId,
    'Avery',
    'Singh',
    '2014-08-22',
    '5',
    todayIso(-45),
    new Date(today.getTime() - 50 * 86400000).toISOString(),
    principalPersonId,
    linkedApplicationId,
  );

  // 1 RECEIVED awaiting capacity check
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_mid_year_admission_requests (id, school_id, requested_by, student_first_name, student_last_name, student_date_of_birth, applying_for_grade_level, requested_start_date, admission_reason, previous_school_name, previous_school_country, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, $7, $8::date, 'RETURNING_FROM_ABROAD', 'International School of Geneva', 'Switzerland', 'RECEIVED')",
    generateId(),
    schoolId,
    sarahPersonId,
    'Theo',
    'Bennett',
    '2014-02-15',
    '5',
    todayIso(30),
  );
  console.log('  F. 2 mid-year admission requests (1 ENROLLED + 1 RECEIVED)');

  console.log('  done.');
}

seedEnrolmentAdvanced()
  .then(() => disconnectAll())
  .catch((err: unknown) => {
    console.error(err);
    return disconnectAll().then(() => {
      process.exit(1);
    });
  });
