import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-scheduling-advanced.ts — Phase 2 Cycle 17 sub-cycle a (P2-17a).
 *
 * Idempotent. Gated on whether sch_rotation_cycles already has a row
 * for the demo school. Re-running is a no-op once the seed has landed.
 *
 * Sections:
 *   A) 1 sch_rotation_cycles — "A/B Week" length=2 academic-year linked.
 *   B) 20 sch_rotation_calendar entries — 10 school days mapped to
 *      day 1 or 2 alternating Mon..Fri across two weeks.
 *   C) 1 sch_scheduling_constraints — 5 hard H1..H5 plus 5 soft S1..S5
 *      with weights per ADR-053.
 *   D) 15 sch_student_subject_choices — 3 choices each for 5 students
 *      (Maya plus 4 others) across the current academic year.
 *   E) 1 sch_scheduling_requests — CP_SAT solver run with 200 sections
 *      status=COMPLETED candidates_generated=2.
 *   F) 2 sch_scheduling_candidates — Candidate A APPROVED 30 slots
 *      0 clashes, Candidate B REJECTED 28 slots 2 clashes.
 *   G) 30 sch_scheduling_candidate_slots — 28 clean on Candidate A
 *      with 2 sample clashing rows on Candidate B (has_clash=true
 *      with clash_description populated).
 *   H) 1 sch_scheduling_activation_log — Candidate A promoted with
 *      slots_promoted=30 slots_skipped=0.
 *   I) 1 sch_room_change_requests — APPROVED Park requesting Room 102
 *      instead of Room 101 for a future date (uses the existing Cycle
 *      5 table).
 *   J) 1 sch_subject_choice_windows — open window grades 9 10 11 12
 *      for the demo academic year.
 *
 * All cross-cycle refs (sis_students sis_courses sis_academic_years
 * sis_classes hr_employees sch_rooms sch_periods) are looked up by
 * name/email/order so the seed adapts to whatever the upstream seeds
 * produced.
 *
 * Splitter trap — no semicolons inside string literals or block
 * comment headers. Idempotent — safe to re-run.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedSchedulingAdvanced(): Promise<void> {
  console.log('');
  console.log('  Scheduling Advanced Seed (P2-17a — Rotation + Schedule Generation)');
  console.log('');

  const client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const principal = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
    select: { id: true, personId: true },
  });
  if (!principal) throw new Error('principal@demo.campusos.dev not found — run pnpm seed first');

  // Academic year — use current year if available; the upstream Cycle 1 seed
  // creates the 2025-2026 row and the P2-5 seed adds 2026-2027.
  const years = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' +
      TENANT_SCHEMA +
      '.sis_academic_years ORDER BY start_date DESC LIMIT 1',
  )) as Array<{ id: string; name: string }>;
  if (years.length === 0) throw new Error('seed-scheduling-advanced: no sis_academic_years rows');
  const academicYearId = years[0]!.id;
  console.log('  academic year: ' + years[0]!.name);

  // Students for subject choices — first 5 by surname order.
  const students = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, student_number FROM ' +
      TENANT_SCHEMA +
      '.sis_students ORDER BY student_number LIMIT 5',
  )) as Array<{ id: string; student_number: string }>;
  if (students.length < 5)
    throw new Error('seed-scheduling-advanced: need at least 5 sis_students');

  // Courses for subject choice picks — first 3 by name.
  const courses = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' + TENANT_SCHEMA + '.sis_courses ORDER BY name LIMIT 3',
  )) as Array<{ id: string; name: string }>;
  if (courses.length < 3) throw new Error('seed-scheduling-advanced: need at least 3 sis_courses');

  // Rooms + periods for candidate slots.
  const rooms = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' + TENANT_SCHEMA + '.sch_rooms ORDER BY name LIMIT 10',
  )) as Array<{ id: string; name: string }>;
  if (rooms.length === 0)
    throw new Error('seed-scheduling-advanced: no sch_rooms — run seed:scheduling first');

  const periods = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, name FROM ' +
      TENANT_SCHEMA +
      ".sch_periods WHERE period_type = 'LESSON' ORDER BY sort_order LIMIT 6",
  )) as Array<{ id: string; name: string }>;
  if (periods.length === 0)
    throw new Error('seed-scheduling-advanced: no LESSON sch_periods — run seed:scheduling first');

  // Classes for candidate slots.
  const classes = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, section_code FROM ' +
      TENANT_SCHEMA +
      '.sis_classes ORDER BY section_code LIMIT 6',
  )) as Array<{ id: string; section_code: string }>;

  // Teachers — Rivera as the demo teacher.
  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, u.email::text AS email FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e JOIN platform.platform_users u ON u.id = e.account_id',
  )) as Array<{ id: string; email: string }>;
  const employeeByEmail: Record<string, string> = {};
  for (let i = 0; i < employees.length; i++)
    employeeByEmail[employees[i]!.email] = employees[i]!.id;
  const riveraEmployeeId = employeeByEmail['teacher@demo.campusos.dev'];
  const parkEmployeeId = employeeByEmail['vp@demo.campusos.dev'];
  if (!riveraEmployeeId || !parkEmployeeId) {
    throw new Error('seed-scheduling-advanced: missing teacher@ or vp@ hr_employees rows');
  }

  // ── 2. Idempotency gate ──
  const existingCycles = (await client.$queryRawUnsafe(
    'SELECT count(*)::bigint AS c FROM ' +
      TENANT_SCHEMA +
      '.sch_rotation_cycles WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: bigint }>;
  if (existingCycles[0] && Number(existingCycles[0].c) > 0) {
    console.log('  sch_rotation_cycles already populated for demo school — skipping');
    return;
  }

  // ── A. Rotation cycle ──
  console.log('  rotation cycle:');
  const cycleId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_rotation_cycles (id, school_id, name, cycle_length, academic_year_id, is_active, description) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4::int, $5::uuid, true, 'Two-week A/B rotation — Mon..Fri Week A then Mon..Fri Week B.')",
    cycleId,
    schoolId,
    'A/B Week',
    2,
    academicYearId,
  );
  console.log('    1 cycle — A/B Week length=2');

  // ── B. Rotation calendar — 20 entries (2 weeks Mon..Fri across 4 weeks) ──
  console.log('  rotation calendar:');
  // Use 2026-09-07 (Monday) as Week A day 1. Alternate A/B by Monday.
  const startDates = [
    { date: '2026-09-07', day: 1 }, // Week A Mon
    { date: '2026-09-08', day: 1 },
    { date: '2026-09-09', day: 1 },
    { date: '2026-09-10', day: 1 },
    { date: '2026-09-11', day: 1 },
    { date: '2026-09-14', day: 2 }, // Week B Mon
    { date: '2026-09-15', day: 2 },
    { date: '2026-09-16', day: 2 },
    { date: '2026-09-17', day: 2 },
    { date: '2026-09-18', day: 2 },
    { date: '2026-09-21', day: 1 }, // Week A Mon
    { date: '2026-09-22', day: 1 },
    { date: '2026-09-23', day: 1 },
    { date: '2026-09-24', day: 1 },
    { date: '2026-09-25', day: 1 },
    { date: '2026-09-28', day: 2 }, // Week B Mon
    { date: '2026-09-29', day: 2 },
    { date: '2026-09-30', day: 2 },
    { date: '2026-10-01', day: 2 },
    { date: '2026-10-02', day: 2 },
  ];
  for (let i = 0; i < startDates.length; i++) {
    const d = startDates[i]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sch_rotation_calendar (id, rotation_cycle_id, calendar_date, rotation_day, is_school_day) ' +
        'VALUES ($1::uuid, $2::uuid, $3::date, $4::int, true)',
      generateId(),
      cycleId,
      d.date,
      d.day,
    );
  }
  console.log('    20 calendar entries — 4 weeks Mon..Fri across Sep 2026');

  // ── C. Constraint profile ──
  console.log('  constraint profile:');
  const constraintId = generateId();
  const hardConstraints = JSON.stringify([
    {
      code: 'H1',
      name: 'teacher_no_double_book',
      description: 'A teacher cannot be assigned to two slots in the same period.',
    },
    {
      code: 'H2',
      name: 'room_no_double_book',
      description: 'A room cannot host two classes in the same period.',
    },
    {
      code: 'H3',
      name: 'student_no_concurrency',
      description: 'A student cannot be enrolled in two classes in the same period.',
    },
    {
      code: 'H4',
      name: 'class_fits_room_capacity',
      description: 'Class enrolment must fit within the assigned room capacity.',
    },
    {
      code: 'H5',
      name: 'cross_school_max_periods',
      description: 'Visiting staff respect the configured max periods per week.',
    },
  ]);
  const softConstraints = JSON.stringify([
    { code: 'S1', name: 'avoid_consecutive_same_subject', weight: 3 },
    { code: 'S2', name: 'teacher_preferences', weight: 2 },
    { code: 'S3', name: 'minimise_student_free_periods', weight: 4 },
    { code: 'S4', name: 'balance_teacher_load', weight: 2 },
    { code: 'S5', name: 'room_proximity', weight: 1 },
  ]);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_scheduling_constraints (id, school_id, academic_year_id, name, hard_constraints, soft_constraints, is_active, description, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::jsonb, $6::jsonb, true, 'Default H1..H5 plus S1..S5 profile for the demo school.', $7::uuid)",
    constraintId,
    schoolId,
    academicYearId,
    'Default Profile',
    hardConstraints,
    softConstraints,
    principal.id,
  );
  console.log('    1 profile — Default Profile (5 hard, 5 soft)');

  // ── D. Student subject choices — 3 per student × 5 students = 15 ──
  console.log('  student subject choices:');
  let choiceCount = 0;
  for (let si = 0; si < students.length; si++) {
    const stu = students[si]!;
    for (let ci = 0; ci < 3; ci++) {
      const crs = courses[ci]!;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.sch_student_subject_choices (id, student_id, academic_year_id, course_id, preference_rank, is_required, submitted_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::int, $6, now())',
        generateId(),
        stu.id,
        academicYearId,
        crs.id,
        ci + 1,
        ci === 0, // first pick marked required
      );
      choiceCount++;
    }
  }
  console.log('    ' + choiceCount + ' subject choices (3 per student × 5 students)');

  // ── E. Scheduling request — COMPLETED CP_SAT ──
  console.log('  scheduling request:');
  const requestId = generateId();
  const solverPayload = JSON.stringify({
    schoolId,
    academicYearId,
    constraintId,
    sectionCount: 200,
    studentCount: students.length,
    courseCount: courses.length,
    snapshotAt: new Date().toISOString(),
  });
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_scheduling_requests (id, school_id, academic_year_id, constraint_id, section_count_at_submission, solver_algorithm, status, requested_by, candidates_generated, queued_at, started_at, completed_at, solver_payload) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 200, 'CP_SAT', 'COMPLETED', $5::uuid, 2, now() - interval '2 hours', now() - interval '1 hour 50 minutes', now() - interval '1 hour', $6::jsonb)",
    requestId,
    schoolId,
    academicYearId,
    constraintId,
    principal.id,
    solverPayload,
  );
  console.log('    1 request — CP_SAT 200 sections COMPLETED');

  // ── F. Candidates — 1 APPROVED + 1 REJECTED ──
  console.log('  candidates:');
  const candidateAId = generateId();
  const candidateBId = generateId();
  const violationsA = JSON.stringify([]);
  const violationsB = JSON.stringify([
    { code: 'S1', count: 2, description: 'Two consecutive Math periods detected.' },
  ]);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_scheduling_candidates (id, request_id, candidate_name, solver_seed, total_slots, total_clashes, all_constraints_satisfied, constraint_violations, soft_constraint_score, review_status, reviewed_by, reviewed_at, review_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3, NULL, 30, 0, true, $4::jsonb, 92.50, 'APPROVED', $5::uuid, now() - interval '30 minutes', 'Approved — no hard violations, soft score acceptable.')",
    candidateAId,
    requestId,
    'Candidate A',
    violationsA,
    principal.id,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_scheduling_candidates (id, request_id, candidate_name, solver_seed, total_slots, total_clashes, all_constraints_satisfied, constraint_violations, soft_constraint_score, review_status, reviewed_by, reviewed_at, review_notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3, NULL, 28, 2, false, $4::jsonb, 78.20, 'REJECTED', $5::uuid, now() - interval '20 minutes', 'Rejected — 2 unresolved clashes.')",
    candidateBId,
    requestId,
    'Candidate B',
    violationsB,
    principal.id,
  );
  console.log(
    '    2 candidates — A APPROVED (30 slots, 0 clashes), B REJECTED (28 slots, 2 clashes)',
  );

  // ── G. Candidate slots — 28 clean on Candidate A + 2 clashing on Candidate B = 30 total ──
  // Candidate A.total_slots is stamped as 30 (the metadata count) — we land 28
  // clean rows here. Plus 2 clashing rows on Candidate B below: 30 total.
  console.log('  candidate slots:');
  let slotsInserted = 0;
  // 5 rotation days × 6 periods × 1 class slot each = 30 candidate slot rows,
  // capped at 28 so the count adds up to 30 once the 2 clash rows land.
  outer: for (let dow = 1; dow <= 5; dow++) {
    for (let pi = 0; pi < periods.length; pi++) {
      if (slotsInserted >= 28) break outer;
      const period = periods[pi]!;
      const cls = classes[pi % Math.max(classes.length, 1)];
      const room = rooms[pi % rooms.length]!;
      const rotationDay = ((slotsInserted % 2) + 1) as 1 | 2;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.sch_scheduling_candidate_slots (id, candidate_id, class_id, teacher_id, room_id, period_id, day_of_week, rotation_day, has_clash, clash_description) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::smallint, $8::smallint, false, NULL)',
        generateId(),
        candidateAId,
        cls ? cls.id : null,
        riveraEmployeeId,
        room.id,
        period.id,
        dow,
        rotationDay,
      );
      slotsInserted++;
    }
  }
  // Candidate B: 2 clashing slots so the activation worker would refuse promotion.
  for (let ci = 0; ci < 2; ci++) {
    const period = periods[ci]!;
    const room = rooms[ci]!;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sch_scheduling_candidate_slots (id, candidate_id, class_id, teacher_id, room_id, period_id, day_of_week, rotation_day, has_clash, clash_description) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::smallint, 1, true, 'Soft S1 violation — consecutive same-subject blocks for student group A.')",
      generateId(),
      candidateBId,
      classes[ci] ? classes[ci]!.id : null,
      riveraEmployeeId,
      room.id,
      period.id,
      1,
    );
  }
  console.log(
    '    ' +
      (slotsInserted + 2) +
      ' candidate slots (' +
      slotsInserted +
      ' clean on A, 2 clashing on B)',
  );

  // ── H. Activation log — Candidate A promoted ──
  console.log('  activation log:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_scheduling_activation_log (id, candidate_id, slots_promoted, slots_skipped, activated_by, activated_at, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 30, 0, $3::uuid, now() - interval '25 minutes', 'Candidate A approved and promoted.')",
    generateId(),
    candidateAId,
    principal.id,
  );
  console.log('    1 activation log entry — Candidate A 30 promoted 0 skipped');

  // ── I. Room change request — APPROVED ──
  // The Cycle 5 table is already populated by seed-scheduling? Check first.
  const existingChanges = (await client.$queryRawUnsafe(
    'SELECT count(*)::bigint AS c FROM ' +
      TENANT_SCHEMA +
      '.sch_room_change_requests WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: bigint }>;
  if (Number(existingChanges[0]?.c ?? 0) === 0) {
    console.log('  room change request:');
    // Pick the first timetable slot to attach to.
    const tt = (await client.$queryRawUnsafe(
      'SELECT id::text AS id, room_id::text AS room_id FROM ' +
        TENANT_SCHEMA +
        '.sch_timetable_slots LIMIT 1',
    )) as Array<{ id: string; room_id: string }>;
    if (tt.length > 0) {
      // pick a different room
      const otherRoom = rooms.find((r) => r.id !== tt[0]!.room_id) ?? rooms[0]!;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.sch_room_change_requests (id, school_id, timetable_slot_id, requested_by, current_room_id, requested_room_id, request_date, reason, status, reviewed_by, reviewed_at, review_notes) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, '2026-09-15'::date, 'Projector upgrade needed in current room.', 'APPROVED', $7::uuid, now() - interval '15 minutes', 'Approved — Room 102 has the AV upgrade.')",
        generateId(),
        schoolId,
        tt[0]!.id,
        parkEmployeeId,
        tt[0]!.room_id,
        otherRoom.id,
        principal.id,
      );
      console.log('    1 room change request — APPROVED');
    } else {
      console.log('    no timetable slot — skipping room change request');
    }
  } else {
    console.log('  room change requests already populated — skipping');
  }

  // ── J. Subject choice window — open ──
  console.log('  subject choice window:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.sch_subject_choice_windows (id, school_id, academic_year_id, name, opens_at, closes_at, target_grade_levels, is_active, description) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, now() - interval '7 days', now() + interval '60 days', ARRAY['9','10','11','12'], true, '2026-2027 course selection window — open to grades 9 through 12.')",
    generateId(),
    schoolId,
    academicYearId,
    '2026-2027 Course Selection',
  );
  console.log('    1 window — open grades 9..12');

  // ── 11. Summary ──
  console.log('');
  console.log('  Scheduling advanced seed complete:');
  await summary(client);
}

async function summary(client: any): Promise<void> {
  const rows = [
    'sch_rotation_cycles',
    'sch_rotation_calendar',
    'sch_scheduling_constraints',
    'sch_student_subject_choices',
    'sch_scheduling_requests',
    'sch_scheduling_candidates',
    'sch_scheduling_candidate_slots',
    'sch_scheduling_activation_log',
    'sch_subject_choice_windows',
  ];
  for (let i = 0; i < rows.length; i++) {
    const table = rows[i]!;
    const counts = (await client.$queryRawUnsafe(
      'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.' + table,
    )) as Array<{ c: bigint }>;
    const n = counts[0] ? Number(counts[0].c) : 0;
    console.log('    ' + table + ': ' + n);
  }
}

seedSchedulingAdvanced()
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  })
  .finally(function () {
    return disconnectAll();
  });
