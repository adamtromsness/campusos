import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

var TENANT_SCHEMA = 'tenant_demo';

interface ScreeningResponse {
  questionKey: string;
  responseValue: any;
}

interface ApplicationSpec {
  studentFirstName: string;
  studentLastName: string;
  studentDateOfBirth: string;
  applyingForGrade: string;
  guardianEmail: string;
  guardianPhone: string;
  admissionType: 'NEW_STUDENT' | 'TRANSFER' | 'MID_YEAR_ADMISSION';
  status:
    | 'DRAFT'
    | 'SUBMITTED'
    | 'UNDER_REVIEW'
    | 'ACCEPTED'
    | 'REJECTED'
    | 'WAITLISTED'
    | 'WITHDRAWN'
    | 'ENROLLED';
  submittedAtIso?: string;
  reviewedByEmail?: string;
  reviewedAtIso?: string;
  streamName?: string;
  guardianFirstName?: string;
  guardianLastName?: string;
  isMaya?: boolean;
  screening: ScreeningResponse[];
  notes: Array<{
    noteType:
      | 'INTERVIEW_NOTES'
      | 'ASSESSMENT_RESULT'
      | 'STAFF_OBSERVATION'
      | 'REFERENCE_CHECK'
      | 'VISIT_NOTES'
      | 'GENERAL';
    text: string;
    isConfidential: boolean;
  }>;
}

// Three sample applications. The first is SUBMITTED and pending admin review
// (drives the Step 8 admin pipeline UI). The second is ACCEPTED and has an
// offer ISSUED with a 14-day deadline (drives the Step 9 parent offer-response
// page). The third is Maya Chen's historical application — already ENROLLED
// (proves the completed pipeline shape; her sis_students row was created by
// seed-sis a year earlier).
var APPLICATIONS: ApplicationSpec[] = [
  {
    studentFirstName: 'Aiden',
    studentLastName: 'Park',
    studentDateOfBirth: '2012-04-12',
    applyingForGrade: '9',
    guardianFirstName: 'Helen',
    guardianLastName: 'Park',
    guardianEmail: 'helen.park@example.com',
    guardianPhone: '+1-555-0188',
    admissionType: 'NEW_STUDENT',
    status: 'SUBMITTED',
    submittedAtIso: '2026-04-20T15:30:00Z',
    streamName: 'Standard Intake',
    screening: [
      { questionKey: 'previous_school', responseValue: 'Westwood Middle School' },
      { questionKey: 'has_iep', responseValue: false },
      { questionKey: 'language_at_home', responseValue: 'English' },
    ],
    notes: [],
  },
  {
    studentFirstName: 'Sophia',
    studentLastName: 'Nakamura',
    studentDateOfBirth: '2011-09-03',
    applyingForGrade: '10',
    guardianFirstName: 'Kenji',
    guardianLastName: 'Nakamura',
    guardianEmail: 'kenji.nakamura@example.com',
    guardianPhone: '+1-555-0199',
    admissionType: 'TRANSFER',
    status: 'ACCEPTED',
    submittedAtIso: '2026-04-05T13:00:00Z',
    reviewedByEmail: 'principal@demo.campusos.dev',
    reviewedAtIso: '2026-04-15T18:45:00Z',
    streamName: 'Music Scholarship',
    screening: [
      { questionKey: 'previous_school', responseValue: 'Crescent Music Academy' },
      { questionKey: 'has_iep', responseValue: false },
      { questionKey: 'instrument', responseValue: 'Violin' },
      { questionKey: 'years_playing', responseValue: 7 },
    ],
    notes: [
      {
        noteType: 'INTERVIEW_NOTES',
        text: 'Strong audition — solo violin demo demonstrated grade-7-equivalent technique.',
        isConfidential: false,
      },
      {
        noteType: 'REFERENCE_CHECK',
        text: 'Reference from Crescent Music Academy: outstanding student, consistent attendance.',
        isConfidential: true,
      },
    ],
  },
  {
    studentFirstName: 'Maya',
    studentLastName: 'Chen',
    studentDateOfBirth: '2011-02-18',
    applyingForGrade: '9',
    guardianEmail: 'parent@demo.campusos.dev',
    guardianPhone: '+1-555-0100',
    admissionType: 'NEW_STUDENT',
    status: 'ENROLLED',
    submittedAtIso: '2025-04-10T09:00:00Z',
    reviewedByEmail: 'principal@demo.campusos.dev',
    reviewedAtIso: '2025-05-12T17:30:00Z',
    streamName: 'Standard Intake',
    isMaya: true,
    screening: [
      { questionKey: 'previous_school', responseValue: 'Lincoln Middle School' },
      { questionKey: 'has_iep', responseValue: false },
      { questionKey: 'language_at_home', responseValue: 'English' },
    ],
    notes: [
      {
        noteType: 'GENERAL',
        text: 'Sibling-priority — older sibling on roster (note retained for audit).',
        isConfidential: false,
      },
    ],
  },
];

async function seedEnrollment() {
  console.log('');
  console.log('  Enrollment Seed (Cycle 6 Step 5 — Admissions Pipeline)');
  console.log('');

  var client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────
  var school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  var schoolId = school.id;

  var principal = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
    select: { id: true, personId: true },
  });
  if (!principal) throw new Error('principal@demo.campusos.dev not found — run pnpm seed first');

  var davidPerson = await client.iamPerson.findFirst({
    where: { firstName: 'David', lastName: 'Chen' },
    select: { id: true },
  });
  if (!davidPerson) throw new Error('David Chen iam_person not found — run pnpm seed first');

  // ── 2. Idempotency gate — enrollment periods ──
  var existing = (await client.$queryRawUnsafe(
    'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.enr_enrollment_periods',
  )) as Array<{ c: bigint }>;
  if (existing[0] && Number(existing[0].c) > 0) {
    console.log('  enr_enrollment_periods already populated — skipping');
    return;
  }

  // ── 3. Academic year 2026-2027 (insert if missing) ──
  // The Fall 2026 admissions period feeds into the upcoming 2026-2027 year,
  // which seed-sis does not create (it only creates 2025-2026). We add it
  // here without flipping is_current=true so the rest of the codebase keeps
  // pointing at 2025-2026.
  var ayRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".sis_academic_years WHERE name = '2026-2027' AND school_id = $1::uuid LIMIT 1",
    schoolId,
  )) as Array<{ id: string }>;
  var academicYearId: string;
  if (ayRows.length > 0) {
    academicYearId = ayRows[0]!.id;
    console.log('  Academic year 2026-2027 already exists');
  } else {
    academicYearId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.sis_academic_years (id, school_id, name, start_date, end_date, is_current) VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6)',
      academicYearId,
      schoolId,
      '2026-2027',
      '2026-08-15',
      '2027-06-15',
      false,
    );
    console.log('  Academic year 2026-2027 created (is_current=false)');
  }

  // Maya's sis_students id — the Maya application is ENROLLED so we
  // illustrate the historical link, but the Cycle 6 schema does not yet
  // have a column on enr_applications pointing at sis_students; the
  // EnrollmentConfirmedWorker (Step 6 / 7) is what will create that
  // linkage post-acceptance. The seed only needs Maya's row to exist
  // (it does — seed-sis created it) so the illustration is plausible.
  var mayaRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      ".sis_students WHERE student_number = 'S-1001' LIMIT 1",
  )) as Array<{ id: string }>;
  if (mayaRows.length === 0) throw new Error('Maya sis_students row not found — run seed:sis');

  // Pre-resolve the principal personId for note created_by audit fields.
  var principalId = principal.id;

  // ── 4. Enrollment period — Fall 2026 OPEN ──
  console.log('  enrollment period:');
  var periodId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_enrollment_periods (id, school_id, academic_year_id, name, opens_at, closes_at, status, allows_mid_year_applications) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6::timestamptz, 'OPEN', false)",
    periodId,
    schoolId,
    academicYearId,
    'Fall 2026 Admissions',
    '2026-04-01T00:00:00Z',
    '2026-06-30T23:59:59Z',
  );
  console.log('    Fall 2026 Admissions — OPEN, 2026-04-01 to 2026-06-30');

  // ── 5. Admission streams ──
  console.log('  admission streams:');
  var standardStreamId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_admission_streams (id, enrollment_period_id, name, grade_level, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, NULL, true)',
    standardStreamId,
    periodId,
    'Standard Intake',
  );
  var musicStreamId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_admission_streams (id, enrollment_period_id, name, grade_level, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, NULL, true)',
    musicStreamId,
    periodId,
    'Music Scholarship',
  );
  console.log('    Standard Intake + Music Scholarship');
  var streamIdByName: Record<string, string> = {
    'Standard Intake': standardStreamId,
    'Music Scholarship': musicStreamId,
  };

  // ── 6. Intake capacities ──
  console.log('  intake capacities:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_intake_capacities (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places) ' +
      'VALUES ($1::uuid, $2::uuid, NULL, $3, $4::int, $5::int)',
    generateId(),
    periodId,
    '9',
    120,
    10,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_intake_capacities (id, enrollment_period_id, stream_id, grade_level, total_places, reserved_places) ' +
      'VALUES ($1::uuid, $2::uuid, NULL, $3, $4::int, $5::int)',
    generateId(),
    periodId,
    '10',
    110,
    0,
  );
  console.log('    Grade 9: 120 places (10 reserved); Grade 10: 110 places');

  // ── 7. Capacity summary — pre-computed snapshot ──
  // applications: 1 (Aiden SUBMITTED, Grade 9) + 1 (Maya historical
  // ENROLLED, Grade 9) for Grade 9; 1 (Sophia ACCEPTED, Grade 10) for
  // Grade 10. offers_issued for Grade 10 is 1 (Sophia). offers_accepted
  // for Grade 9 is 1 (Maya historical). The CapacitySummaryService will
  // recompute these on every status change in Step 6+.
  console.log('  capacity summary:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_capacity_summary (id, enrollment_period_id, grade_level, total_places, reserved, applications_received, offers_issued, offers_accepted, waitlisted, available) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::int, $5::int, $6::int, $7::int, $8::int, $9::int, $10::int)',
    generateId(),
    periodId,
    '9',
    120,
    10,
    2,
    1,
    1,
    1,
    108,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_capacity_summary (id, enrollment_period_id, grade_level, total_places, reserved, applications_received, offers_issued, offers_accepted, waitlisted, available) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::int, $5::int, $6::int, $7::int, $8::int, $9::int, $10::int)',
    generateId(),
    periodId,
    '10',
    110,
    0,
    1,
    1,
    0,
    0,
    109,
  );
  console.log('    Grade 9 / Grade 10 — counters seeded');

  // ── 8. Applications + screening + notes ──
  console.log('  applications:');
  var applicationIds: Record<string, string> = {};
  for (var ai = 0; ai < APPLICATIONS.length; ai++) {
    var app = APPLICATIONS[ai]!;
    var appId = generateId();
    var key = app.studentFirstName + ' ' + app.studentLastName;
    applicationIds[key] = appId;

    var streamId = app.streamName ? streamIdByName[app.streamName] : null;
    var guardianPersonId: string | null = null;
    if (app.isMaya) {
      guardianPersonId = davidPerson.id;
    }
    var reviewedById: string | null = null;
    if (app.reviewedByEmail) {
      var reviewer = await client.platformUser.findFirst({
        where: { email: app.reviewedByEmail },
        select: { id: true },
      });
      if (reviewer) reviewedById = reviewer.id;
    }

    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.enr_applications (id, school_id, enrollment_period_id, stream_id, student_first_name, student_last_name, student_date_of_birth, applying_for_grade, guardian_person_id, guardian_email, guardian_phone, admission_type, status, submitted_at, reviewed_by, reviewed_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7::date, $8, $9::uuid, $10, $11, $12, $13, $14::timestamptz, $15::uuid, $16::timestamptz)',
      appId,
      schoolId,
      periodId,
      streamId,
      app.studentFirstName,
      app.studentLastName,
      app.studentDateOfBirth,
      app.applyingForGrade,
      guardianPersonId,
      app.guardianEmail,
      app.guardianPhone,
      app.admissionType,
      app.status,
      app.submittedAtIso ?? null,
      reviewedById,
      app.reviewedAtIso ?? null,
    );

    for (var sj = 0; sj < app.screening.length; sj++) {
      var sr = app.screening[sj]!;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.enr_application_screening_responses (id, application_id, question_key, response_value) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::jsonb)',
        generateId(),
        appId,
        sr.questionKey,
        JSON.stringify(sr.responseValue),
      );
    }

    for (var nj = 0; nj < app.notes.length; nj++) {
      var note = app.notes[nj]!;
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.enr_application_notes (id, application_id, note_type, note_text, is_confidential, created_by) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
        generateId(),
        appId,
        note.noteType,
        note.text,
        note.isConfidential,
        principalId,
      );
    }
    console.log(
      '    ' +
        app.studentFirstName +
        ' ' +
        app.studentLastName +
        ' (Grade ' +
        app.applyingForGrade +
        ') — ' +
        app.status +
        ' (' +
        app.screening.length +
        ' screening, ' +
        app.notes.length +
        ' notes)',
    );
  }

  // ── 9. Offers ──
  console.log('  offers:');
  // Sophia — UNCONDITIONAL ISSUED with 14-day response deadline
  var sophiaAppId = applicationIds['Sophia Nakamura']!;
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_offers (id, school_id, application_id, offer_type, issued_at, response_deadline, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'UNCONDITIONAL', $4::timestamptz, $5::timestamptz, 'ISSUED')",
    generateId(),
    schoolId,
    sophiaAppId,
    '2026-04-15T19:00:00Z',
    '2026-04-29T23:59:59Z',
  );
  console.log('    Sophia Nakamura — UNCONDITIONAL ISSUED, deadline 2026-04-29');

  // Maya historical — UNCONDITIONAL ACCEPTED last summer
  var mayaAppId = applicationIds['Maya Chen']!;
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_offers (id, school_id, application_id, offer_type, issued_at, response_deadline, family_response, family_responded_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'UNCONDITIONAL', $4::timestamptz, $5::timestamptz, 'ACCEPTED', $6::timestamptz, 'ACCEPTED')",
    generateId(),
    schoolId,
    mayaAppId,
    '2025-05-12T18:00:00Z',
    '2025-05-26T23:59:59Z',
    '2025-05-15T11:30:00Z',
  );
  console.log('    Maya Chen (historical) — UNCONDITIONAL ACCEPTED 2025-05-15');

  // ── 10. Waitlist — 1 ACTIVE Grade 9 entry on top of Aiden's pending app ──
  // To plant a waitlist row we add an extra application that has been
  // pushed to the waitlist (status=WAITLISTED). Position 1 on the Grade 9
  // queue. priority_score reflects sibling weight (none, baseline 50.00).
  console.log('  waitlist:');
  var waitlistAppId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_applications (id, school_id, enrollment_period_id, stream_id, student_first_name, student_last_name, student_date_of_birth, applying_for_grade, guardian_email, guardian_phone, admission_type, status, submitted_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'Olivia', 'Bennett', '2012-06-25'::date, '9', 'sara.bennett@example.com', '+1-555-0144', 'NEW_STUDENT', 'WAITLISTED', '2026-04-08T10:00:00Z'::timestamptz)",
    waitlistAppId,
    schoolId,
    periodId,
    standardStreamId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_waitlist_entries (id, school_id, enrollment_period_id, application_id, grade_level, priority_score, position, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, '9', 50.00, 1, 'ACTIVE')",
    generateId(),
    schoolId,
    periodId,
    waitlistAppId,
  );
  console.log('    Olivia Bennett — Grade 9 waitlist position 1 (ACTIVE)');

  // ── 11. Summary ──
  console.log('');
  console.log('  Enrollment seed complete:');
  await summary(client);
}

async function summary(client: any): Promise<void> {
  var rows = [
    ['enr_enrollment_periods', 'enr_enrollment_periods'],
    ['enr_admission_streams', 'enr_admission_streams'],
    ['enr_intake_capacities', 'enr_intake_capacities'],
    ['enr_capacity_summary', 'enr_capacity_summary'],
    ['enr_applications', 'enr_applications'],
    ['enr_application_screening_responses', 'enr_application_screening_responses'],
    ['enr_application_notes', 'enr_application_notes'],
    ['enr_offers', 'enr_offers'],
    ['enr_waitlist_entries', 'enr_waitlist_entries'],
  ];
  for (var i = 0; i < rows.length; i++) {
    var label = rows[i]![0]!;
    var table = rows[i]![1]!;
    var counts = (await client.$queryRawUnsafe(
      'SELECT count(*)::bigint AS c FROM ' + TENANT_SCHEMA + '.' + table,
    )) as Array<{ c: bigint }>;
    var n = counts[0] ? Number(counts[0].c) : 0;
    console.log('    ' + label + ': ' + n);
  }
}

seedEnrollment()
  .catch(function (err) {
    console.error(err);
    process.exit(1);
  })
  .finally(function () {
    return disconnectAll();
  });
