import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-clubs.ts — Cycle 17 Step 4.
 *
 * M64 Clubs and Student Life. Idempotent — gated on whether
 * ext_activity_types already has rows for the demo school. Re-running
 * is a no-op once the seed has landed.
 *
 * Sections:
 *   A) 4 activity types — Chess (ACADEMIC), Drama (ARTS), Student
 *      Council (LEADERSHIP), Debate (ACADEMIC).
 *   B) 3 activities + 5 members + 1 schedule per activity. Chess Club
 *      with Maya as PRESIDENT and Ethan as MEMBER. Drama Club with 2
 *      students. Student Council with Maya as OFFICER.
 *   C) 1 field trip "Natural History Museum" CONFIRMED + 2
 *      participants (Maya, Ethan) + 1 signed consent for Maya
 *      (David Chen) + 2 chaperones (Rivera LEAD CLEARED, Mitchell
 *      CHAPERONE NOT_REQUIRED).
 *   D) 1 election "Student Council Election 2026" status=CLOSED with
 *      President position + Maya + a peer candidate + 3 anonymous
 *      votes (NO voter_id) + 2 voter_check rows. Note: vote count
 *      and voter_check count are intentionally different to
 *      demonstrate that the schema does not enforce match between
 *      them — the only structural contract is anti-double-vote on
 *      voter_check.
 *   E) 1 service programme "Community Impact 2026" target=20 hours
 *      + 2 hours rows (Maya 3hr APPROVED + 2hr PENDING) + 1 approval
 *      + 1 progress row (3 approved / 2 pending).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedClubs() {
  console.log('');
  console.log('  Clubs & Student Life Seed (Cycle 17 Step 4)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.ext_activity_types WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  ext_activity_types already populated for demo school. Skipping.');
    return;
  }

  // ── Resolve common refs ──
  async function findStudent(firstName: string, lastName: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person p ON p.id = ps.person_id ' +
        'WHERE p.first_name = $1 AND p.last_name = $2 LIMIT 1',
      firstName,
      lastName,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('Student not found: ' + firstName + ' ' + lastName);
    return rows[0]!.id;
  }
  async function findEmployee(
    email: string,
  ): Promise<{ employeeId: string; personId: string; accountId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT e.id::text AS employee_id, e.person_id::text AS person_id, e.account_id::text AS account_id FROM ' +
        TENANT_SCHEMA +
        '.hr_employees e JOIN platform.platform_users u ON u.id = e.account_id WHERE u.email = $1 LIMIT 1',
      email,
    )) as Array<{ employee_id: string; person_id: string; account_id: string }>;
    if (rows.length === 0) throw new Error('Employee not found: ' + email);
    return {
      employeeId: rows[0]!.employee_id,
      personId: rows[0]!.person_id,
      accountId: rows[0]!.account_id,
    };
  }
  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const yearRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + '.sis_academic_years WHERE name = $1 LIMIT 1',
    '2025-2026',
  )) as Array<{ id: string }>;
  if (yearRows.length === 0) throw new Error('2025-2026 academic year not found');
  const academicYearId = yearRows[0]!.id;

  const maya = await findStudent('Maya', 'Chen');
  const ethan = await findStudent('Ethan', 'Rodriguez');
  const aaliyah = await findStudent('Aaliyah', 'Johnson');
  const liam = await findStudent('Liam', "O'Connor");
  const sofia = await findStudent('Sofia', 'Patel');

  const rivera = await findEmployee('teacher@demo.campusos.dev');
  const mitchell = await findEmployee('principal@demo.campusos.dev');
  const hayes = await findEmployee('counsellor@demo.campusos.dev');

  const davidChen = await findUserByEmail('parent@demo.campusos.dev');

  // ── A. 4 activity types ──
  console.log('  Seeding 4 activity types (Chess, Drama, Student Council, Debate)...');
  const typeChess = generateId();
  const typeDrama = generateId();
  const typeCouncil = generateId();
  const typeDebate = generateId();
  for (const [id, name, category] of [
    [typeChess, 'Chess', 'ACADEMIC'],
    [typeDrama, 'Drama', 'ARTS'],
    [typeCouncil, 'Student Council', 'LEADERSHIP'],
    [typeDebate, 'Debate', 'ACADEMIC'],
  ] as Array<[string, string, string]>) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.ext_activity_types (id, school_id, name, category) VALUES ($1::uuid, $2::uuid, $3, $4)',
      id,
      schoolId,
      name,
      category,
    );
  }

  // ── B. 3 activities + 5 members + 1 schedule per activity ──
  console.log('  Seeding 3 activities (Chess Club, Drama Club, Student Council)...');
  const chessClub = generateId();
  const dramaClub = generateId();
  const studentCouncil = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_activities (id, school_id, activity_type_id, name, description, academic_year_id, advisor_id, max_participants, status, meeting_location) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid, $8, $9, $10)',
    chessClub,
    schoolId,
    typeChess,
    'Chess Club',
    'Weekly chess matches and tournament prep.',
    academicYearId,
    rivera.employeeId,
    20,
    'ACTIVE',
    'Library — Chess corner',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_activities (id, school_id, activity_type_id, name, description, academic_year_id, advisor_id, status, meeting_location) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid, $8, $9)',
    dramaClub,
    schoolId,
    typeDrama,
    'Drama Club',
    'Spring play rehearsals and improv workshops.',
    academicYearId,
    mitchell.employeeId,
    'ACTIVE',
    'Auditorium',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_activities (id, school_id, activity_type_id, name, description, academic_year_id, advisor_id, status, meeting_location) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid, $7::uuid, $8, $9)',
    studentCouncil,
    schoolId,
    typeCouncil,
    'Student Council',
    'Student government and event planning.',
    academicYearId,
    hayes.employeeId,
    'ACTIVE',
    'Room 202',
  );

  console.log(
    '  Seeding 5 members (Maya PRESIDENT + Ethan MEMBER in Chess; 2 in Drama; Maya OFFICER in Council)...',
  );
  for (const [activityId, studentId, role] of [
    [chessClub, maya, 'PRESIDENT'],
    [chessClub, ethan, 'MEMBER'],
    [dramaClub, aaliyah, 'MEMBER'],
    [dramaClub, liam, 'OFFICER'],
    [studentCouncil, maya, 'OFFICER'],
  ] as Array<[string, string, string]>) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.ext_activity_members (id, activity_id, student_id, role, joined_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, CURRENT_DATE - INTERVAL ' +
        "'30 days')",
      generateId(),
      activityId,
      studentId,
      role,
    );
  }

  console.log('  Seeding 1 schedule per activity...');
  // Chess Club — Tuesdays 3:30–4:30
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_activity_schedules (id, activity_id, day_of_week, start_time, end_time, location) ' +
      "VALUES ($1::uuid, $2::uuid, 2, '15:30', '16:30', 'Library — Chess corner')",
    generateId(),
    chessClub,
  );
  // Drama Club — Thursdays 3:30–5:00
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_activity_schedules (id, activity_id, day_of_week, start_time, end_time, location) ' +
      "VALUES ($1::uuid, $2::uuid, 4, '15:30', '17:00', 'Auditorium')",
    generateId(),
    dramaClub,
  );
  // Student Council — Wednesdays 12:00–12:45 (lunch meeting)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_activity_schedules (id, activity_id, day_of_week, start_time, end_time, location) ' +
      "VALUES ($1::uuid, $2::uuid, 3, '12:00', '12:45', 'Room 202')",
    generateId(),
    studentCouncil,
  );

  // ── C. 1 field trip + 2 participants + 1 consent + 2 chaperones ──
  console.log('  Seeding 1 field trip "Natural History Museum"...');
  const tripId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_field_trips (id, school_id, title, description, destination, trip_date, departure_time, return_time, grade_levels, max_participants, cost_per_student, organiser_id, status, consent_deadline) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, $5, CURRENT_DATE + INTERVAL '30 days', '08:30', '14:30', ARRAY[$6], 30, 12.50, $7::uuid, 'CONFIRMED', CURRENT_DATE + INTERVAL '14 days')",
    tripId,
    schoolId,
    'Natural History Museum',
    'Field trip to the Natural History Museum for the Grade 5 cohort.',
    'Natural History Museum, Chicago',
    '5',
    rivera.employeeId,
  );

  for (const [studentId] of [[maya], [ethan]] as Array<[string]>) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.ext_field_trip_participants (id, field_trip_id, student_id, attendance_status) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, 'REGISTERED')",
      generateId(),
      tripId,
      studentId,
    );
  }

  // David Chen signs consent for Maya
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_field_trip_consent_records (id, field_trip_id, student_id, guardian_person_id, consent_given, signed_at, ip_address, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, true, now() - INTERVAL '5 days', '127.0.0.1', 'Seeded consent — David Chen signs for Maya.')",
    generateId(),
    tripId,
    maya,
    davidChen.personId,
  );

  // 2 chaperones
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_field_trip_chaperones (id, field_trip_id, person_id, role, background_check_status, confirmed) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'LEAD', 'CLEARED', true)",
    generateId(),
    tripId,
    rivera.personId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_field_trip_chaperones (id, field_trip_id, person_id, role, background_check_status, confirmed) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'CHAPERONE', 'CLEARED', true)",
    generateId(),
    tripId,
    mitchell.personId,
  );

  // ── D. 1 election + 2 candidates + 3 anonymous votes + 2 voter_check rows ──
  console.log('  Seeding 1 election "Student Council Election 2026" with anonymous votes...');
  const electionId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_elections (id, school_id, title, description, voting_start, voting_end, eligible_voters_filter, status, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, now() - INTERVAL '14 days', now() - INTERVAL '7 days', $5::jsonb, 'CLOSED', $6::uuid)",
    electionId,
    schoolId,
    'Student Council Election 2026',
    'Annual student government election.',
    JSON.stringify({ all: true }),
    hayes.employeeId,
  );

  const mayaCandidate = generateId();
  const peerCandidate = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_candidates (id, election_id, student_id, position, statement, is_approved, registered_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'PRESIDENT', 'Vote Maya for inclusive school events and a stronger student voice.', true, now() - INTERVAL '20 days')",
    mayaCandidate,
    electionId,
    maya,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_candidates (id, election_id, student_id, position, statement, is_approved, registered_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'PRESIDENT', 'Bringing fresh ideas and better cafeteria menus.', true, now() - INTERVAL '20 days')",
    peerCandidate,
    electionId,
    sofia,
  );

  // 3 anonymous votes — 2 for Maya, 1 for Sofia. NO voter_id column.
  for (const [voteIdx, candidateId] of [
    [0, mayaCandidate],
    [1, mayaCandidate],
    [2, peerCandidate],
  ] as Array<[number, string]>) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.ext_votes (id, election_id, position, candidate_id, voted_at) ' +
        "VALUES ($1::uuid, $2::uuid, 'PRESIDENT', $3::uuid, now() - INTERVAL '" +
        (10 - voteIdx) +
        " days')",
      generateId(),
      electionId,
      candidateId,
    );
  }

  // 2 voter_check rows — Ethan + Aaliyah voted (the seed intentionally
  // does NOT match the vote count to demonstrate that the schema makes
  // no count-equality contract — the only structural rule is anti-
  // double-vote on the (election, student) primary key)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_election_voter_check (election_id, student_id, voted_at) ' +
      "VALUES ($1::uuid, $2::uuid, now() - INTERVAL '10 days')",
    electionId,
    ethan,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_election_voter_check (election_id, student_id, voted_at) ' +
      "VALUES ($1::uuid, $2::uuid, now() - INTERVAL '9 days')",
    electionId,
    aaliyah,
  );

  // ── E. 1 service programme + 2 hours + 1 approval + 1 progress ──
  console.log('  Seeding 1 service programme "Community Impact 2026"...');
  const programmeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_service_programmes (id, school_id, name, description, academic_year_id, target_hours, start_date, end_date, eligible_grade_levels) ' +
      "VALUES ($1::uuid, $2::uuid, 'Community Impact 2026', 'Annual community service programme.', $3::uuid, 20.0, CURRENT_DATE - INTERVAL '60 days', CURRENT_DATE + INTERVAL '180 days', ARRAY['5','6','7','8'])",
    programmeId,
    schoolId,
    academicYearId,
  );

  const hour1 = generateId();
  const hour2 = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_service_hours (id, student_id, programme_id, organisation, description, service_date, hours, supervisor_name, supervisor_contact) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, CURRENT_DATE - INTERVAL '14 days', 3.0, 'Park Ranger Olivia', 'olivia@parks.example')",
    hour1,
    maya,
    programmeId,
    'Springfield Parks Department',
    'Park cleanup along the river trail.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_service_hours (id, student_id, programme_id, organisation, description, service_date, hours, supervisor_name) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, CURRENT_DATE - INTERVAL '3 days', 2.0, 'Librarian Mike')",
    hour2,
    maya,
    programmeId,
    'Springfield Public Library',
    'Volunteered shelving books in the children section.',
  );

  // 1 approval (APPROVED for hour1)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_service_hour_approvals (id, service_hour_id, approved_by, status, notes, reviewed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'APPROVED', 'Verified with park ranger.', now() - INTERVAL '10 days')",
    generateId(),
    hour1,
    hayes.employeeId,
  );

  // 1 progress row — 3 approved + 2 pending
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ext_service_progress (id, programme_id, student_id, approved_hours, pending_hours, is_complete) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, 3.0, 2.0, false)',
    generateId(),
    programmeId,
    maya,
  );

  console.log('');
  console.log('  Clubs seed complete.');
  console.log('    Activities: 3 (Chess Club / Drama Club / Student Council)');
  console.log('    Members: 5 / Schedules: 3');
  console.log('    Field trip: 1 (Natural History Museum) / Consent: 1 / Chaperones: 2');
  console.log('    Election: 1 (CLOSED) / Candidates: 2 / Votes: 3 (anonymous) / Voter checks: 2');
  console.log('    Service programme: 1 / Hours: 2 (1 APPROVED, 1 PENDING) / Progress: 1 (3/20)');
}

seedClubs()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
