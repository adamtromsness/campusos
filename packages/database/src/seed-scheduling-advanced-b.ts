import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-scheduling-advanced-b.ts — Phase 2 Cycle 17 sub-cycle b (P2-17b).
 *
 * Idempotent. Gated on whether sch_exam_sessions already has a row
 * for the demo school. Re-running is a no-op once the seed has landed.
 *
 * Sections:
 *   A) 2 sch_exam_sessions — Math Final (2026-06-15 09:00..11:00 120m)
 *      plus English Final (2026-06-17 09:00..11:30 150m).
 *   B) 3 sch_exam_session_rooms — Main hall for both sessions plus one
 *      accommodation room on the Math final.
 *   C) 8 sch_exam_seatings — 4 per session. The Math final includes
 *      one EXTENDED_TIME student (extra_time_minutes=30) and one
 *      SEPARATE_LOCATION student routed to the accommodation room.
 *   D) 3 sch_exam_invigilator_assignments — lead invigilator per room
 *      and a floating second invigilator on the main hall for Math.
 *   E) 2 sch_coteaching_arrangements — TEAM_TEACHING plus
 *      STATION_ROTATION on two distinct timetable slots.
 *   F) 2 sch_pull_out_interventions — Reading Recovery WEEKLY for the
 *      first student plus Speech Therapy FORTNIGHTLY for the second.
 *   G) 1 sch_cross_school_staff_assignments — visiting music teacher
 *      using person_id (iam_person) and home_employee_id (hr_employees)
 *      with the keystone person-level EXCLUSION protection.
 *   H) 2 sch_cover_arrangements — 1 SUBSTITUTE_REPLACEMENT (linked to
 *      P2-9 sub_assignments when present) and 1 CLASS_SPLIT.
 *   I) 3 sch_cover_arrangement_classes — 1 COVERED_BY_SUB on the
 *      SUBSTITUTE_REPLACEMENT arrangement plus 2 SPLIT_TO on the
 *      CLASS_SPLIT arrangement.
 *   J) 5 sch_cover_split_students — distributing the affected class
 *      across Group A plus Group B with labelled destinations.
 *
 * All cross-cycle refs (sis_students sch_rooms hr_employees
 * sch_timetable_slots sis_classes platform.iam_person platform.schools
 * sub_assignments) are looked up by name plus order so the seed
 * adapts to whatever the upstream seeds produced.
 *
 * Splitter trap — no semicolons inside string literals or block
 * comment headers. Idempotent — safe to re-run.
 */

const TENANT_SCHEMA = 'tenant_demo';

interface IdRow {
  id: string;
}

interface IdNameRow {
  id: string;
  name: string;
}

interface PersonRow {
  id: string;
  person_id: string | null;
}

async function seedSchedulingAdvancedB(): Promise<void> {
  console.log('');
  console.log('  Scheduling Advanced Seed (P2-17b — Exams + Co-Teaching + Cover)');
  console.log('');

  const client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const principal = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
  });
  if (!principal) throw new Error('principal@demo.campusos.dev not found');

  // Idempotency gate.
  const existing = (await client.$queryRawUnsafe(
    'SELECT count(*)::bigint AS c FROM ' +
      TENANT_SCHEMA +
      '.sch_exam_sessions WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: bigint }>;
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('  P2-17b already seeded for demo school — skipping.');
    return;
  }

  // Students (need at least 5).
  const students = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, student_number AS name FROM ' +
      TENANT_SCHEMA +
      '.sis_students ORDER BY student_number LIMIT 8',
  )) as IdNameRow[];
  if (students.length < 5) {
    throw new Error('seed-scheduling-advanced-b: need at least 5 sis_students');
  }

  // Rooms (need at least 2).
  const rooms = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' + TENANT_SCHEMA + '.sch_rooms ORDER BY name LIMIT 4',
  )) as IdNameRow[];
  if (rooms.length < 2) {
    throw new Error('seed-scheduling-advanced-b: need at least 2 sch_rooms');
  }

  // Employees with person_id (need at least 2 — primary + secondary teacher).
  const employees = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, person_id::text AS person_id FROM ' +
      TENANT_SCHEMA +
      '.hr_employees WHERE person_id IS NOT NULL ORDER BY employee_number LIMIT 4',
  )) as PersonRow[];
  if (employees.length < 2) {
    throw new Error('seed-scheduling-advanced-b: need at least 2 hr_employees with person_id');
  }

  // Timetable slots (need at least 3 — co-teaching slots plus cover-affected slot).
  const slots = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS id, s.class_id::text AS class_id FROM ' +
      TENANT_SCHEMA +
      '.sch_timetable_slots s WHERE s.class_id IS NOT NULL ORDER BY s.effective_from LIMIT 3',
  )) as Array<{ id: string; class_id: string }>;
  if (slots.length < 3) {
    throw new Error('seed-scheduling-advanced-b: need at least 3 sch_timetable_slots');
  }

  // P2-9 sub_assignment (optional — only linked when at least one exists).
  const subAssignments = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.sub_assignments LIMIT 1',
  )) as IdRow[];
  const subAssignmentId = subAssignments[0] ? subAssignments[0].id : null;

  // ── A. Exam sessions ────────────────────────────────────────
  console.log('  A) sch_exam_sessions');
  const mathFinalId = generateId();
  const englishFinalId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_sessions (id, school_id, exam_name, exam_date, start_time, end_time, duration_minutes, extra_time_minutes, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Math Final 2026', '2026-06-15', '09:00', '11:00', 120, 0, 'End-of-year math summative.', $3::uuid)",
    mathFinalId,
    schoolId,
    principal.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_sessions (id, school_id, exam_name, exam_date, start_time, end_time, duration_minutes, extra_time_minutes, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'English Final 2026', '2026-06-17', '09:00', '11:30', 150, 0, 'End-of-year English summative with composition.', $3::uuid)",
    englishFinalId,
    schoolId,
    principal.id,
  );

  // ── B. Exam session rooms ───────────────────────────────────
  console.log('  B) sch_exam_session_rooms');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_session_rooms (id, session_id, room_id, capacity, is_main_room, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 30, true, 'Main exam venue.')",
    generateId(),
    mathFinalId,
    rooms[0]!.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_session_rooms (id, session_id, room_id, capacity, is_main_room, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 4, false, 'Accommodation room — quieter setting for SEPARATE_LOCATION students.')",
    generateId(),
    mathFinalId,
    rooms[1]!.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_session_rooms (id, session_id, room_id, capacity, is_main_room, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 30, true, 'Main exam venue.')",
    generateId(),
    englishFinalId,
    rooms[0]!.id,
  );

  // ── C. Exam seatings ────────────────────────────────────────
  console.log('  C) sch_exam_seatings');
  // Math: students 1..4. Student 1 gets EXTENDED_TIME (+30). Student 2 gets SEPARATE_LOCATION.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_seatings (id, session_id, student_id, room_id, seat_number, extra_time_minutes, separate_room, reader_required, scribe_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 30, false, false, false)',
    generateId(),
    mathFinalId,
    students[0]!.id,
    rooms[0]!.id,
    'A12',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_seatings (id, session_id, student_id, room_id, seat_number, extra_time_minutes, separate_room, reader_required, scribe_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 0, true, false, false)',
    generateId(),
    mathFinalId,
    students[1]!.id,
    rooms[1]!.id,
    'S1',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_seatings (id, session_id, student_id, room_id, seat_number, extra_time_minutes, separate_room, reader_required, scribe_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 0, false, false, false)',
    generateId(),
    mathFinalId,
    students[2]!.id,
    rooms[0]!.id,
    'B07',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_seatings (id, session_id, student_id, room_id, seat_number, extra_time_minutes, separate_room, reader_required, scribe_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 0, false, false, false)',
    generateId(),
    mathFinalId,
    students[3]!.id,
    rooms[0]!.id,
    'B08',
  );

  // English: students 1..4 again in the same main hall.
  for (let i = 0; i < 4; i += 1) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sch_exam_seatings (id, session_id, student_id, room_id, seat_number, extra_time_minutes, separate_room, reader_required, scribe_required) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 0, false, false, false)',
      generateId(),
      englishFinalId,
      students[i]!.id,
      rooms[0]!.id,
      'E' + String(i + 1).padStart(2, '0'),
    );
  }

  // ── D. Invigilator assignments ──────────────────────────────
  console.log('  D) sch_exam_invigilator_assignments');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_invigilator_assignments (id, session_id, room_id, invigilator_id, is_lead) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true)',
    generateId(),
    mathFinalId,
    rooms[0]!.id,
    employees[0]!.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_invigilator_assignments (id, session_id, room_id, invigilator_id, is_lead) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, false)',
    generateId(),
    mathFinalId,
    rooms[0]!.id,
    employees[1]!.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_exam_invigilator_assignments (id, session_id, room_id, invigilator_id, is_lead) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true)',
    generateId(),
    englishFinalId,
    rooms[0]!.id,
    employees[0]!.id,
  );

  // ── E. Co-teaching arrangements ─────────────────────────────
  console.log('  E) sch_coteaching_arrangements');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_coteaching_arrangements (id, timetable_slot_id, primary_teacher_id, secondary_teacher_id, teaching_model, effective_from, created_by, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TEAM_TEACHING', '2026-01-01', $5::uuid, 'Math class with co-teacher delivering examples concurrently.')",
    generateId(),
    slots[0]!.id,
    employees[0]!.id,
    employees[1]!.id,
    principal.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_coteaching_arrangements (id, timetable_slot_id, primary_teacher_id, secondary_teacher_id, teaching_model, effective_from, created_by, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'STATION_ROTATION', '2026-01-01', $5::uuid, 'Science class with three rotating stations.')",
    generateId(),
    slots[1]!.id,
    employees[0]!.id,
    employees[1]!.id,
    principal.id,
  );

  // ── F. Pull-out interventions ───────────────────────────────
  console.log('  F) sch_pull_out_interventions');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_pull_out_interventions (id, school_id, student_id, regular_slot_id, intervention_name, intervention_provider, intervention_location, start_date, end_date, frequency, days_of_week, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Reading Recovery', $5::uuid, 'Resource Room 2', '2026-01-15', '2026-06-15', 'WEEKLY', ARRAY[2]::smallint[], 'Tuesday morning support.')",
    generateId(),
    schoolId,
    students[0]!.id,
    slots[0]!.id,
    employees[1]!.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_pull_out_interventions (id, school_id, student_id, regular_slot_id, intervention_name, intervention_provider, intervention_location, start_date, end_date, frequency, days_of_week, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Speech Therapy', $5::uuid, 'Speech Room', '2026-02-01', '2026-06-15', 'FORTNIGHTLY', ARRAY[4]::smallint[], 'Alternate Thursdays — articulation work.')",
    generateId(),
    schoolId,
    students[1]!.id,
    slots[1]!.id,
    employees[1]!.id,
  );

  // ── G. Cross-school staff ───────────────────────────────────
  console.log('  G) sch_cross_school_staff_assignments');
  const employeeWithPerson = employees.find((e) => e.person_id !== null);
  if (!employeeWithPerson || !employeeWithPerson.person_id) {
    throw new Error('seed-scheduling-advanced-b: no hr_employees row with non-NULL person_id');
  }
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_cross_school_staff_assignments (id, home_school_id, visiting_school_id, person_id, home_employee_id, role_at_visiting_school, effective_from, effective_to, max_periods_per_week, approved_by, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'Visiting Music Teacher', '2026-01-01', '2026-06-30', 4, $6::uuid, 'Two periods per week — Tuesday and Thursday afternoons.')",
    generateId(),
    schoolId,
    '99999999-9999-7999-8999-999999999999',
    employeeWithPerson.person_id,
    employeeWithPerson.id,
    principal.id,
  );

  // ── H + I + J. Cover arrangements + classes + split students ─
  console.log('  H) sch_cover_arrangements');
  console.log('  I) sch_cover_arrangement_classes');
  console.log('  J) sch_cover_split_students');

  // H1: SUBSTITUTE_REPLACEMENT arrangement linked to P2-9 sub_assignment when present.
  const subArrangementId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_cover_arrangements (id, school_id, absent_teacher_id, cover_date, cover_type, sub_assignment_id, covering_teacher_id, status, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-04-22', 'SUBSTITUTE_REPLACEMENT', $4, NULL, 'PLANNED', 'External substitute covering all periods.', $5::uuid)",
    subArrangementId,
    schoolId,
    employees[0]!.id,
    subAssignmentId ? subAssignmentId : null,
    principal.id,
  );

  // H2: CLASS_SPLIT arrangement.
  const splitArrangementId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_cover_arrangements (id, school_id, absent_teacher_id, cover_date, cover_type, covering_teacher_id, status, notes, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, '2026-05-04', 'CLASS_SPLIT', NULL, 'PLANNED', 'Splitting the class across two other rooms — no substitute available.', $4::uuid)",
    splitArrangementId,
    schoolId,
    employees[1]!.id,
    principal.id,
  );

  // I1: COVERED_BY_SUB row on the SUBSTITUTE_REPLACEMENT arrangement.
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_cover_arrangement_classes (id, arrangement_id, affected_class_id, affected_slot_id, disposition, destination_room_id, supervising_teacher_id, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'COVERED_BY_SUB', NULL, NULL, 'Substitute teaches in the regular room.')",
    generateId(),
    subArrangementId,
    slots[0]!.class_id,
    slots[0]!.id,
  );

  // I2 + I3: SPLIT_TO rows on the CLASS_SPLIT arrangement — affected slot + secondary slot.
  const splitClassId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_cover_arrangement_classes (id, arrangement_id, affected_class_id, affected_slot_id, disposition, destination_room_id, supervising_teacher_id, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SPLIT_TO', NULL, NULL, 'Class split across Groups A and B — see sch_cover_split_students.')",
    splitClassId,
    splitArrangementId,
    slots[2]!.class_id,
    slots[2]!.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_cover_arrangement_classes (id, arrangement_id, affected_class_id, affected_slot_id, disposition, destination_room_id, supervising_teacher_id, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SELF_STUDY', $5::uuid, $6::uuid, 'Self-study under invigilator supervision in destination room.')",
    generateId(),
    splitArrangementId,
    slots[1]!.class_id,
    slots[1]!.id,
    rooms[0]!.id,
    employees[1]!.id,
  );

  // J1..J5: 5 students split across Groups A + B.
  for (let i = 0; i < 5; i += 1) {
    const label = i < 3 ? 'Group A' : 'Group B';
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sch_cover_split_students (id, arrangement_class_id, student_id, destination_class_label, destination_room_id, supervising_teacher_id, notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::uuid, NULL)',
      generateId(),
      splitClassId,
      students[i]!.id,
      label,
      rooms[i < 3 ? 0 : 1]!.id,
      employees[1]!.id,
    );
  }

  // ── Final counts ────────────────────────────────────────────
  console.log('');
  console.log('  P2-17b seed complete:');
  const tables = [
    'sch_exam_sessions',
    'sch_exam_session_rooms',
    'sch_exam_seatings',
    'sch_exam_invigilator_assignments',
    'sch_coteaching_arrangements',
    'sch_pull_out_interventions',
    'sch_cross_school_staff_assignments',
    'sch_cover_arrangements',
    'sch_cover_arrangement_classes',
    'sch_cover_split_students',
  ];
  for (let i = 0; i < tables.length; i += 1) {
    const table = tables[i]!;
    const counts = (await client.$queryRawUnsafe(
      'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.' + table,
    )) as Array<{ c: bigint }>;
    const n = counts[0] ? Number(counts[0].c) : 0;
    console.log('    ' + table + ': ' + n);
  }
}

seedSchedulingAdvancedB()
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  })
  .finally(function () {
    return disconnectAll();
  });
