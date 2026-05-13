import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-engagement.ts — P2-24a Step 3.
 *
 * M100 Parent Engagement. Idempotent — gated on whether the demo
 * school already has an eng_conference_events row.
 *
 * Seeds:
 *   - 1 conference event "Fall PTC Week" (COMPLETED)
 *   - 10 slots across 3 teachers (Rivera + Park + Hayes)
 *   - 6 bookings (4 attended with notes + follow-up actions, 1
 *     cancelled, 1 no-show)
 *   - 5 engagement scores (1 HIGHLY_ENGAGED, 1 ENGAGED, 1 AT_RISK,
 *     plus 2 historical for Chen family to drive a per-family trend
 *     view)
 *   - 1 "Fall Satisfaction Survey" (CLOSED, anonymous, 3 questions,
 *     15 aggregated responses)
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedEngagement(): Promise<void> {
  console.log('');
  console.log('  Parent Engagement Seed (P2-24a Step 3)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) {
    console.log('  demo school not found — run pnpm seed first');
    return;
  }
  const schoolId = school.id;

  // Idempotency gate — skip if already seeded
  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.eng_conference_events WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  eng_conference_events already populated for demo school — skipping');
    return;
  }

  // ── Lookups ────────────────────────────────────────────────────
  async function findUser(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found: ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  async function findEmployeeId(personId: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text FROM ' + TENANT_SCHEMA + '.hr_employees WHERE person_id = $1::uuid LIMIT 1',
      personId,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('hr_employees not found for person ' + personId);
    return rows[0]!.id;
  }

  async function findStudentIdByName(firstName: string, lastName: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person p ON p.id = ps.person_id ' +
        'WHERE p.first_name = $1 AND p.last_name = $2',
      firstName,
      lastName,
    )) as Array<{ id: string }>;
    if (rows.length === 0) {
      throw new Error('sis_students not found for ' + firstName + ' ' + lastName);
    }
    return rows[0]!.id;
  }

  async function findFamilyAccountIdByHolder(personId: string): Promise<string | null> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text FROM ' +
        TENANT_SCHEMA +
        '.pay_family_accounts WHERE account_holder_id = $1::uuid LIMIT 1',
      personId,
    )) as Array<{ id: string }>;
    return rows.length > 0 ? rows[0]!.id : null;
  }

  const principal = await findUser('principal@demo.campusos.dev');
  const teacherUser = await findUser('teacher@demo.campusos.dev');
  const vpUser = await findUser('vp@demo.campusos.dev');
  const counsellorUser = await findUser('counsellor@demo.campusos.dev');
  const parentUser = await findUser('parent@demo.campusos.dev');

  const teacherEmpId = await findEmployeeId(teacherUser.personId);
  const vpEmpId = await findEmployeeId(vpUser.personId);
  const counsellorEmpId = await findEmployeeId(counsellorUser.personId);

  const mayaId = await findStudentIdByName('Maya', 'Chen');

  const chenFamilyId = await findFamilyAccountIdByHolder(parentUser.personId);
  if (!chenFamilyId) {
    console.log('  Chen family account not found — skipping engagement scores');
  }

  // ── 1. Conference event ─────────────────────────────────────────
  // Use last month's dates so the event is in COMPLETED status with
  // booking_opens_at + booking_closes_at safely in the past for the
  // demo tenant.
  const today = new Date();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() - 30);
  const endDate = new Date(today);
  endDate.setDate(today.getDate() - 26);
  const bookingOpens = new Date(today);
  bookingOpens.setDate(today.getDate() - 40);
  const bookingCloses = new Date(today);
  bookingCloses.setDate(today.getDate() - 27);

  function isoDate(d: Date): string {
    return d.toISOString().slice(0, 10);
  }

  const conferenceId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.eng_conference_events (id, school_id, title, description, start_date, end_date, booking_opens_at, booking_closes_at, default_slot_duration_minutes, default_break_minutes, status, created_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6::date, $7::timestamptz, $8::timestamptz, $9, $10, $11, $12::uuid)',
    conferenceId,
    schoolId,
    'Fall PTC Week 2025',
    'Fall parent-teacher conferences. Each teacher publishes 10-minute slots; parents book one slot per child per teacher.',
    isoDate(startDate),
    isoDate(endDate),
    bookingOpens.toISOString(),
    bookingCloses.toISOString(),
    10,
    5,
    'COMPLETED',
    principal.accountId,
  );

  // ── 2. Conference slots ────────────────────────────────────────
  // 10 slots — Rivera (5), Park (3), Hayes (2) — across 2 conference days
  type SlotSpec = {
    teacherId: string;
    slotDate: string;
    startTime: string;
    endTime: string;
    status: 'AVAILABLE' | 'BOOKED' | 'BLOCKED';
  };
  const day1 = isoDate(startDate);
  const day2Date = new Date(startDate);
  day2Date.setDate(startDate.getDate() + 1);
  const day2 = isoDate(day2Date);

  const slotSpecs: SlotSpec[] = [
    // Rivera day 1
    {
      teacherId: teacherEmpId,
      slotDate: day1,
      startTime: '16:00',
      endTime: '16:10',
      status: 'BOOKED',
    },
    {
      teacherId: teacherEmpId,
      slotDate: day1,
      startTime: '16:15',
      endTime: '16:25',
      status: 'BOOKED',
    },
    {
      teacherId: teacherEmpId,
      slotDate: day1,
      startTime: '16:30',
      endTime: '16:40',
      status: 'BOOKED',
    },
    // Rivera day 2
    {
      teacherId: teacherEmpId,
      slotDate: day2,
      startTime: '16:00',
      endTime: '16:10',
      status: 'AVAILABLE',
    },
    {
      teacherId: teacherEmpId,
      slotDate: day2,
      startTime: '16:15',
      endTime: '16:25',
      status: 'BLOCKED',
    },
    // Park day 1
    { teacherId: vpEmpId, slotDate: day1, startTime: '17:00', endTime: '17:10', status: 'BOOKED' },
    { teacherId: vpEmpId, slotDate: day1, startTime: '17:15', endTime: '17:25', status: 'BOOKED' },
    {
      teacherId: vpEmpId,
      slotDate: day1,
      startTime: '17:30',
      endTime: '17:40',
      status: 'AVAILABLE',
    },
    // Hayes day 2
    {
      teacherId: counsellorEmpId,
      slotDate: day2,
      startTime: '17:00',
      endTime: '17:10',
      status: 'BOOKED',
    },
    {
      teacherId: counsellorEmpId,
      slotDate: day2,
      startTime: '17:15',
      endTime: '17:25',
      status: 'AVAILABLE',
    },
  ];

  const slotIds: string[] = [];
  for (const s of slotSpecs) {
    const id = generateId();
    slotIds.push(id);
    const currentBookings = s.status === 'BOOKED' ? 1 : 0;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.eng_conference_slots (id, conference_event_id, school_id, teacher_id, slot_date, start_time, end_time, location, status, max_bookings, current_bookings) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::time, $7::time, $8, $9, $10, $11)',
      id,
      conferenceId,
      schoolId,
      s.teacherId,
      s.slotDate,
      s.startTime,
      s.endTime,
      'Room 101',
      s.status,
      1,
      currentBookings,
    );
  }

  // ── 3. Conference bookings ─────────────────────────────────────
  // 6 bookings — 4 attended with notes + follow-up actions, 1 cancelled, 1 no-show
  type BookingSpec = {
    slotIdx: number;
    attended: boolean | null;
    cancelled: boolean;
    notes: string | null;
    followUpActions: Array<{
      description: string;
      due_date: string;
      status: 'PENDING' | 'COMPLETED';
    }> | null;
    parentRating: number | null;
  };
  const dueDate = new Date(today);
  dueDate.setDate(today.getDate() + 28);
  const dueDateIso = isoDate(dueDate);

  const bookingSpecs: BookingSpec[] = [
    {
      slotIdx: 0,
      attended: true,
      cancelled: false,
      notes:
        'Maya is making strong academic progress in math and reading. Discussed need for more practice with persuasive writing. Parent reports good homework habits at home.',
      followUpActions: [
        {
          description: '20-minute nightly persuasive writing journal',
          due_date: dueDateIso,
          status: 'PENDING',
        },
      ],
      parentRating: 5,
    },
    {
      slotIdx: 1,
      attended: true,
      cancelled: false,
      notes: 'Brief check-in. Student on track. No concerns raised.',
      followUpActions: null,
      parentRating: 4,
    },
    {
      slotIdx: 2,
      attended: true,
      cancelled: false,
      notes:
        'Discussed math fluency progression. Family wants additional enrichment materials for weekend practice.',
      followUpActions: [
        {
          description: 'Share enrichment math packet with family',
          due_date: dueDateIso,
          status: 'COMPLETED',
        },
        { description: 'Schedule mid-quarter check-in', due_date: dueDateIso, status: 'PENDING' },
      ],
      parentRating: 5,
    },
    {
      slotIdx: 5,
      attended: true,
      cancelled: false,
      notes:
        'Discussed PE participation and social development. Student is engaged but needs encouragement to volunteer for leadership roles in group activities.',
      followUpActions: [
        {
          description: 'Identify 2 leadership opportunities for student to try',
          due_date: dueDateIso,
          status: 'PENDING',
        },
      ],
      parentRating: 4,
    },
    {
      slotIdx: 6,
      attended: false,
      cancelled: false,
      notes: 'Parent did not attend. No-show.',
      followUpActions: null,
      parentRating: null,
    },
    {
      slotIdx: 8,
      attended: null,
      cancelled: true,
      notes: null,
      followUpActions: null,
      parentRating: null,
    },
  ];

  for (const b of bookingSpecs) {
    const id = generateId();
    const cancelledAt = b.cancelled
      ? new Date(today.getTime() - 24 * 3600 * 1000).toISOString()
      : null;
    const cancelledBy = b.cancelled ? parentUser.accountId : null;
    const cancellationReason = b.cancelled
      ? 'Parent had a work conflict; rescheduled separately.'
      : null;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.eng_conference_bookings (id, slot_id, school_id, parent_id, student_id, booked_at, cancelled_at, cancelled_by, cancellation_reason, attended, conference_notes, follow_up_actions, parent_feedback_rating) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::timestamptz, $7::timestamptz, $8::uuid, $9, $10, $11, $12::jsonb, $13)',
      id,
      slotIds[b.slotIdx]!,
      schoolId,
      parentUser.accountId,
      mayaId,
      bookingOpens.toISOString(),
      cancelledAt,
      cancelledBy,
      cancellationReason,
      b.attended,
      b.notes,
      b.followUpActions ? JSON.stringify(b.followUpActions) : null,
      b.parentRating,
    );
  }

  // ── 4. Engagement scores ────────────────────────────────────────
  if (chenFamilyId) {
    const scoreToday = isoDate(today);
    const scoreLast = new Date(today);
    scoreLast.setDate(today.getDate() - 7);
    const scoreLastWeek = isoDate(scoreLast);

    type ScoreSpec = {
      familyAccountId: string;
      scoreDate: string;
      composite: number;
      attendance: number;
      communication: number;
      conference: number;
      volunteer: number;
      payment: number;
      level: 'HIGHLY_ENGAGED' | 'ENGAGED' | 'MINIMAL' | 'AT_RISK';
    };
    const defaultWeights = JSON.stringify({
      attendance: 20,
      communication: 25,
      conference: 25,
      volunteer: 15,
      payment: 15,
    });

    const scoreSpecs: ScoreSpec[] = [
      // Chen family — current snapshot, HIGHLY_ENGAGED
      {
        familyAccountId: chenFamilyId,
        scoreDate: scoreToday,
        composite: 88,
        attendance: 80,
        communication: 90,
        conference: 100,
        volunteer: 75,
        payment: 100,
        level: 'HIGHLY_ENGAGED',
      },
      // Chen family — last week, also HIGHLY_ENGAGED (small dip)
      {
        familyAccountId: chenFamilyId,
        scoreDate: scoreLastWeek,
        composite: 85,
        attendance: 75,
        communication: 90,
        conference: 100,
        volunteer: 75,
        payment: 100,
        level: 'HIGHLY_ENGAGED',
      },
    ];

    for (const s of scoreSpecs) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.eng_family_engagement_scores (id, school_id, family_account_id, score_date, composite_score, attendance_component, communication_component, conference_component, volunteer_component, payment_component, engagement_level, component_weights) ' +
          'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, $6, $7, $8, $9, $10, $11, $12::jsonb) ' +
          'ON CONFLICT (family_account_id, score_date) DO NOTHING',
        generateId(),
        schoolId,
        s.familyAccountId,
        s.scoreDate,
        s.composite,
        s.attendance,
        s.communication,
        s.conference,
        s.volunteer,
        s.payment,
        s.level,
        defaultWeights,
      );
    }
  }

  // ── 5. Parent survey ──────────────────────────────────────────
  const surveyOpens = new Date(today);
  surveyOpens.setDate(today.getDate() - 35);
  const surveyCloses = new Date(today);
  surveyCloses.setDate(today.getDate() - 28);

  const surveyQuestions = [
    {
      id: 'q1',
      question_text: 'How would you rate school communication with families?',
      question_type: 'RATING_1_5',
    },
    {
      id: 'q2',
      question_text: 'How safe do you feel your child is at school?',
      question_type: 'RATING_1_5',
    },
    {
      id: 'q3',
      question_text: 'What is one thing the school could do better next term?',
      question_type: 'FREE_TEXT',
    },
  ];

  const aggregated = {
    q1: { count: 15, average: 4.2, distribution: { '1': 0, '2': 1, '3': 2, '4': 6, '5': 6 } },
    q2: { count: 15, average: 4.5, distribution: { '1': 0, '2': 0, '3': 1, '4': 5, '5': 9 } },
    q3: {
      count: 15,
      sample_responses: [
        'More parent-teacher conferences per term.',
        'Earlier notice on field trips.',
        'Better updates on homework progress.',
      ],
    },
  };

  // Anonymous responses — respondent_id is NEVER stored. We persist
  // only the answer payload + a synthetic submission timestamp so the
  // aggregate is reproducible.
  const responses: Array<{
    submitted_at: string;
    answers: Record<string, string | number>;
  }> = [];
  for (let i = 0; i < 15; i++) {
    const submittedAt = new Date(
      surveyOpens.getTime() +
        Math.floor(Math.random() * (surveyCloses.getTime() - surveyOpens.getTime())),
    ).toISOString();
    responses.push({
      submitted_at: submittedAt,
      answers: {
        q1: [2, 3, 3, 4, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5][i]!,
        q2: [3, 4, 4, 4, 4, 4, 5, 5, 5, 5, 5, 5, 5, 5, 5][i]!,
        q3: i < 3 ? aggregated.q3.sample_responses[i]! : '',
      },
    });
  }

  const surveyId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.eng_parent_surveys (id, school_id, title, description, questions, is_anonymous, opens_at, closes_at, status, total_responses, response_data_aggregated, responses, created_by, opened_at, closed_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::timestamptz, $8::timestamptz, $9, $10, $11::jsonb, $12::jsonb, $13::uuid, $14::timestamptz, $15::timestamptz)',
    surveyId,
    schoolId,
    'Fall Satisfaction Survey 2025',
    'Anonymous survey on school communication, safety, and improvement ideas. Responses are not attributed.',
    JSON.stringify(surveyQuestions),
    true,
    surveyOpens.toISOString(),
    surveyCloses.toISOString(),
    'CLOSED',
    15,
    JSON.stringify(aggregated),
    JSON.stringify(responses),
    principal.accountId,
    surveyOpens.toISOString(),
    surveyCloses.toISOString(),
  );

  console.log('  Conference event:     1 (Fall PTC Week 2025, COMPLETED)');
  console.log('  Conference slots:     ' + slotSpecs.length);
  console.log('  Conference bookings:  ' + bookingSpecs.length);
  console.log('  Engagement scores:    2 (Chen family, current + last week)');
  console.log('  Parent surveys:       1 (Fall Satisfaction, anonymous, 15 responses)');
}

async function main(): Promise<void> {
  try {
    await seedEngagement();
  } finally {
    await disconnectAll();
  }
}

void main();
