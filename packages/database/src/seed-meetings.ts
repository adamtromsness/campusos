import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-meetings.ts — Cycle 15 Step 3.
 *
 * Idempotent. Gated on whether mtg_meeting_types already has rows for
 * the demo school. Re-running is a no-op once the seed has landed.
 *
 * Sections:
 *   A) 4 meeting types (Parent-Teacher Conference 15min, Staff Meeting
 *      60min, IEP Review 45min video, Department Meeting 30min).
 *   B) 1 conference event (Spring PTC 2026, May 20-21, SCHEDULED).
 *   C) 2 meetings (PTC by Rivera, IEP review by Hayes).
 *   D) 6 PTC time slots (3 per day) with slot #1 booked by David Chen
 *      so the booked_chk lockstep is exercised in seed data.
 *   E) 4 meeting participants (PTC: Rivera HOST + David Chen ATTENDEE,
 *      IEP: Hayes HOST + Mitchell PRESENTER).
 *   F) 2 agenda items on the IEP meeting.
 *   G) 2 meeting notes (PTC parent-visible + approved with parent
 *      summary, IEP staff-only).
 *   H) 3 action items (Rivera self-assigned + David parent-assigned +
 *      Hayes DONE).
 *   I) 1 IEP meeting record linking to Maya's Cycle 10 IEP plan.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedMeetings() {
  console.log('');
  console.log('  Meetings Seed (Cycle 15 Step 3)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.mtg_meeting_types WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  Meeting types already populated for demo school. Skipping.');
    return;
  }

  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const mitchell = await findUserByEmail('principal@demo.campusos.dev');
  const rivera = await findUserByEmail('teacher@demo.campusos.dev');
  const david = await findUserByEmail('parent@demo.campusos.dev');
  const hayes = await findUserByEmail('counsellor@demo.campusos.dev');

  // Resolve Maya's sis_students id + her current ACTIVE IEP plan id
  // from Cycle 10. Both are required for the IEP meeting record.
  const mayaRow = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS sis_id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
      "WHERE ip.first_name = 'Maya' AND ip.last_name = 'Chen' LIMIT 1",
  )) as Array<{ sis_id: string }>;
  if (mayaRow.length === 0) throw new Error('Maya Chen not found in sis_students');
  const mayaStudentId = mayaRow[0]!.sis_id;

  const iepPlanRow = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".hlth_iep_plans WHERE student_id = $1::uuid AND status = 'ACTIVE' LIMIT 1",
    mayaStudentId,
  )) as Array<{ id: string }>;
  const mayaIepPlanId = iepPlanRow[0]?.id ?? null;

  // ── A. 4 meeting types ────────────────────────────────────────
  console.log('  Seeding 4 meeting types...');
  const ptcTypeId = generateId();
  const staffTypeId = generateId();
  const iepTypeId = generateId();
  const deptTypeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_meeting_types (id, school_id, name, description, default_duration_minutes, is_video, is_active) VALUES ' +
      '($1::uuid, $9::uuid, $2, $3, 15, false, true), ' +
      '($4::uuid, $9::uuid, $5, NULL, 60, false, true), ' +
      '($6::uuid, $9::uuid, $7, $8, 45, true, true), ' +
      "($10::uuid, $9::uuid, 'Department Meeting', NULL, 30, false, true)",
    ptcTypeId,
    'Parent-Teacher Conference',
    '15-minute conference between a teacher and a parent.',
    staffTypeId,
    'Staff Meeting',
    iepTypeId,
    'IEP Review',
    'IEP team review meeting. Health-sensitive content stays staff-side.',
    schoolId,
    deptTypeId,
  );

  // ── B. 1 conference event ─────────────────────────────────────
  console.log('  Seeding 1 conference event (Spring PTC 2026)...');
  const conferenceId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_conference_events (id, school_id, title, description, conference_type, start_date, end_date, status, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'Spring Parent-Teacher Conferences 2026', 'Twice-yearly PTC week. Parents book 15-minute slots with their child''s teachers.', 'PARENT_TEACHER', '2026-05-20', '2026-05-21', 'SCHEDULED', $3::uuid)",
    conferenceId,
    schoolId,
    mitchell.accountId,
  );

  // ── C. 2 meetings ─────────────────────────────────────────────
  console.log('  Seeding 2 meetings...');
  const ptcMeetingId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_meetings (id, school_id, meeting_type_id, conference_event_id, title, description, scheduled_at, duration_minutes, status, organiser_id) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, 'Rivera availability container for Spring 2026 conferences. Parents book individual 15-min slots under this meeting.', '2026-05-20 15:00:00+00', 90, 'SCHEDULED', $6::uuid)",
    ptcMeetingId,
    schoolId,
    ptcTypeId,
    conferenceId,
    'Mr. Rivera — PTC slots',
    rivera.accountId,
  );

  const iepMeetingId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_meetings (id, school_id, meeting_type_id, title, description, scheduled_at, duration_minutes, status, organiser_id, completed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, 'IEP team review for Maya Chen.', '2026-04-15 14:00:00+00', 45, 'COMPLETED', $5::uuid, '2026-04-15 14:45:00+00')",
    iepMeetingId,
    schoolId,
    iepTypeId,
    'IEP Review — Maya Chen',
    hayes.accountId,
  );

  // ── D. 6 PTC time slots (3 per day) with slot #1 booked by David ──
  console.log('  Seeding 6 PTC time slots (slot #1 booked by David Chen)...');
  const slotTimes = [
    ['2026-05-20 15:00:00+00', '2026-05-20 15:15:00+00'],
    ['2026-05-20 15:15:00+00', '2026-05-20 15:30:00+00'],
    ['2026-05-20 15:30:00+00', '2026-05-20 15:45:00+00'],
    ['2026-05-21 15:00:00+00', '2026-05-21 15:15:00+00'],
    ['2026-05-21 15:15:00+00', '2026-05-21 15:30:00+00'],
    ['2026-05-21 15:30:00+00', '2026-05-21 15:45:00+00'],
  ];
  for (let i = 0; i < slotTimes.length; i++) {
    const slotId = generateId();
    const [start, end] = slotTimes[i]!;
    if (i === 0) {
      // Booked slot — booked_chk lockstep verified
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.mtg_meeting_slots (id, meeting_id, start_time, end_time, is_booked, booked_by, booked_at) ' +
          'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, true, $5::uuid, now())',
        slotId,
        ptcMeetingId,
        start,
        end,
        david.accountId,
      );
    } else {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.mtg_meeting_slots (id, meeting_id, start_time, end_time, is_booked) ' +
          'VALUES ($1::uuid, $2::uuid, $3::timestamptz, $4::timestamptz, false)',
        slotId,
        ptcMeetingId,
        start,
        end,
      );
    }
  }

  // ── E. 4 meeting participants ─────────────────────────────────
  console.log('  Seeding 4 meeting participants...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_meeting_participants (id, meeting_id, participant_id, role, attended) VALUES ' +
      "($1::uuid, $9::uuid, $2::uuid, 'HOST', false), " +
      "($3::uuid, $9::uuid, $4::uuid, 'ATTENDEE', true), " +
      "($5::uuid, $10::uuid, $6::uuid, 'HOST', true), " +
      "($7::uuid, $10::uuid, $8::uuid, 'PRESENTER', true)",
    generateId(),
    rivera.accountId,
    generateId(),
    david.accountId,
    generateId(),
    hayes.accountId,
    generateId(),
    mitchell.accountId,
    ptcMeetingId,
    iepMeetingId,
  );

  // ── F. 2 agenda items on the IEP meeting ──────────────────────
  console.log('  Seeding 2 agenda items...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_agenda_items (id, meeting_id, title, presenter_id, duration_minutes, sort_order) VALUES ' +
      '($1::uuid, $5::uuid, $2, $6::uuid, 20, 0), ' +
      '($3::uuid, $5::uuid, $4, $6::uuid, 25, 1)',
    generateId(),
    'Review current goals progress',
    generateId(),
    'Discuss accommodation adjustments',
    iepMeetingId,
    hayes.accountId,
  );

  // ── G. 2 meeting notes ────────────────────────────────────────
  console.log('  Seeding 2 meeting notes (PTC parent-visible + IEP staff-only)...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_meeting_notes (id, meeting_id, notes_text, is_approved, approved_by, approved_at, is_parent_visible, parent_visible_summary, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, true, $4::uuid, now(), true, $5, $4::uuid)',
    generateId(),
    ptcMeetingId,
    'Internal notes — Maya is making strong progress in math (consistently above 85% on quizzes). Reading comprehension still a focus area. Discussed at-home practice strategies with parent.',
    rivera.accountId,
    'Maya is making strong progress in math and consistently scoring above 85% on quizzes. Reading comprehension remains a focus area. We discussed practical at-home practice strategies and Mr. Rivera will send additional reading materials this week.',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_meeting_notes (id, meeting_id, notes_text, is_approved, approved_by, approved_at, is_parent_visible, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, true, $4::uuid, now(), false, $4::uuid)',
    generateId(),
    iepMeetingId,
    'IEP team review notes — sensitive content. Discussed Maya progress against current accommodations. Decision to add small-group reading instruction. Parent informed via separate parent-summary email after the meeting.',
    hayes.accountId,
  );

  // ── H. 3 action items ─────────────────────────────────────────
  console.log('  Seeding 3 action items...');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_action_items (id, meeting_id, assignee_id, description, due_date, status, completed_at, created_by) VALUES ' +
      "($1::uuid, $7::uuid, $2::uuid, 'Send Maya additional reading materials for at-home practice', CURRENT_DATE + 7, 'OPEN', NULL, $2::uuid), " +
      "($3::uuid, $7::uuid, $4::uuid, 'Practice multiplication tables with Maya at home (15 min daily)', CURRENT_DATE + 7, 'OPEN', NULL, $2::uuid), " +
      "($5::uuid, $8::uuid, $6::uuid, 'Update accommodation plan with small-group reading instruction', NULL, 'DONE', now() - interval '5 days', $6::uuid)",
    generateId(),
    rivera.accountId,
    generateId(),
    david.accountId,
    generateId(),
    hayes.accountId,
    ptcMeetingId,
    iepMeetingId,
  );

  // ── I. 1 IEP meeting record ───────────────────────────────────
  console.log('  Seeding 1 IEP meeting record (links to Cycle 10 IEP plan)...');
  const attendeeRoles = JSON.stringify([
    { personId: hayes.personId, role: 'COUNSELLOR', name: 'Marcus Hayes' },
    { personId: mitchell.personId, role: 'ADMIN', name: 'Sarah Mitchell' },
  ]);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.mtg_iep_meeting_records (id, meeting_id, student_id, iep_plan_id, attendee_roles, outcomes_summary, next_review_date, recorded_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::jsonb, 'Reviewed Maya progress against current IEP. Adding small-group reading instruction as a new accommodation. Maya parent informed via separate summary.', CURRENT_DATE + 90, $6::uuid)",
    generateId(),
    iepMeetingId,
    mayaStudentId,
    mayaIepPlanId,
    attendeeRoles,
    hayes.accountId,
  );

  console.log('');
  console.log('  Meetings seed complete.');
}

seedMeetings()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
