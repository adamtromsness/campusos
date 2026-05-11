import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-substitutes.ts — Phase 2 Cycle 9 (P2-9) sub-cycle a step 4.
 *
 * Idempotent. Gated on whether platform.platform_substitute_profiles already
 * has rows for the demo school's substitute pool. Re-running is a no-op
 * once the seed has landed.
 *
 * Sections:
 *   A) 3 iam_person rows (Sarah Johnson, Mike Patel, Lisa Anderson) — the
 *      Substitute personas. No platform_users / auth account this cycle —
 *      P2-9b adds login. Looked up by personalEmail for idempotency.
 *
 *   B) 3 platform_substitute_profiles — Sarah Elementary + Middle 5yrs
 *      verified, Mike High School Science 2yrs pending verification, Lisa
 *      All levels 10yrs verified.
 *
 *   C) 6 platform_sub_credentials — Sarah Teaching License VERIFIED + First
 *      Aid VERIFIED expiring in 45 days (alert window keystone), Mike
 *      Teaching License PENDING + Background Check VERIFIED, Lisa Teaching
 *      License VERIFIED + Safeguarding L2 VERIFIED.
 *
 *   D) Recurring + specific platform_sub_availability — Sarah Mon-Thu
 *      RECURRING 7am-3pm + BLOCKED next Friday. Mike Tue+Thu RECURRING.
 *      Lisa SPECIFIC future date.
 *
 *   E) 2 platform_sub_preferences — Sarah PREFERRED for Lincoln Academy,
 *      Lisa BLOCKED from a synthetic Elmwood school id.
 *
 *   F) 1 sub_school_pool — Lincoln Academy with Sarah ACTIVE + Mike ACTIVE
 *      + Lisa SUSPENDED (suspended_until = today + 7d, reason = late
 *      cancellation).
 *
 *   G) 2 sub_job_postings — Job 1 FILLED for Rivera's classes, Job 2
 *      OPEN upcoming. 3 sub_job_classes for Job 1 (Periods 1, 3, 5).
 *      4 sub_job_notifications across the 2 jobs (Sarah ACCEPTED Job 1,
 *      Mike DECLINED Job 1, Lisa EXPIRED Job 1, Sarah PENDING Job 2).
 *
 *   H) 1 sub_assignment for Job 1 — Sarah, CHECKED_OUT, full lifecycle
 *      timestamps populated. 2 sub_ratings (SCHOOL_RATES_SUB 5/5/5 by
 *      principal + SUB_RATES_SCHOOL 4/4/null by sub side). 1
 *      sub_session_note (visible to teacher).
 *
 *   I) 2 sub_pay_rates — Lincoln Academy default $180/day DAILY +
 *      Sarah-specific $200/day DAILY override (effective today onwards).
 *
 *   J) 1 sub_cancellation_policies — Lincoln Academy: 2-hour late window,
 *      WARNING_ONLY consequence, repeat_offence_threshold=3.
 */

const TENANT_SCHEMA = 'tenant_demo';

interface SubPersona {
  email: string;
  firstName: string;
  lastName: string;
  displayName: string;
  bio: string;
  gradeLevels: string[];
  subjectAreas: string[];
  yearsExperience: number;
  isAvailable: boolean;
  overallRating: string | null;
}

const SUB_PERSONAS: SubPersona[] = [
  {
    email: 'sarah.johnson@subs.example.com',
    firstName: 'Sarah',
    lastName: 'Johnson',
    displayName: 'Sarah J.',
    bio: 'Five years of substitute experience covering elementary and middle grades. Strong in classroom management and reading instruction.',
    gradeLevels: ['ELEMENTARY', 'MIDDLE'],
    subjectAreas: ['ENGLISH', 'MATHS', 'GENERAL'],
    yearsExperience: 5,
    isAvailable: true,
    overallRating: '5.0',
  },
  {
    email: 'mike.patel@subs.example.com',
    firstName: 'Mike',
    lastName: 'Patel',
    displayName: 'Mike P.',
    bio: 'High school science specialist. Two years of substitute experience.',
    gradeLevels: ['HIGH'],
    subjectAreas: ['SCIENCE', 'BIOLOGY', 'CHEMISTRY'],
    yearsExperience: 2,
    isAvailable: true,
    overallRating: null,
  },
  {
    email: 'lisa.anderson@subs.example.com',
    firstName: 'Lisa',
    lastName: 'Anderson',
    displayName: 'Lisa A.',
    bio: 'Veteran substitute with 10 years of cross-grade experience. Reliable for emergency same-day coverage.',
    gradeLevels: ['ELEMENTARY', 'MIDDLE', 'HIGH'],
    subjectAreas: ['ENGLISH', 'HISTORY', 'GENERAL'],
    yearsExperience: 10,
    isAvailable: false,
    overallRating: '4.5',
  },
];

const SENTINEL_SCHOOL_DEFAULT_SUB_ID = '00000000-0000-0000-0000-000000000000';

function isoDateOffset(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

async function seedSubstitutes() {
  console.log('');
  console.log(
    '  Substitutes Seed (P2-9 step 4 — platform profiles + credentials + availability + school pool + jobs + assignments)',
  );
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existingProfiles = await client.substituteProfile.count({
    where: { displayName: { in: SUB_PERSONAS.map((p) => p.displayName) } },
  });
  if (existingProfiles >= SUB_PERSONAS.length) {
    console.log('  Substitute profiles already present — skipping seed.');
    return;
  }

  // ── A. iam_person rows ──────────────────────────────────────────────
  const personaIds: Record<string, string> = {};
  for (const p of SUB_PERSONAS) {
    let person = await client.iamPerson.findFirst({ where: { personalEmail: p.email } });
    if (!person) {
      person = await client.iamPerson.create({
        data: {
          id: generateId(),
          firstName: p.firstName,
          lastName: p.lastName,
          personalEmail: p.email,
          personType: 'STAFF',
          isActive: true,
          preferredLanguage: 'en',
        },
      });
      console.log(`    + iam_person ${p.firstName} ${p.lastName}`);
    }
    personaIds[p.email] = person.id;
  }

  // ── B. platform_substitute_profiles ─────────────────────────────────
  const profileIds: Record<string, string> = {};
  for (const p of SUB_PERSONAS) {
    const personId = personaIds[p.email]!;
    let profile = await client.substituteProfile.findUnique({ where: { personId } });
    if (!profile) {
      profile = await client.substituteProfile.create({
        data: {
          id: generateId(),
          personId,
          displayName: p.displayName,
          bio: p.bio,
          gradeLevels: p.gradeLevels,
          subjectAreas: p.subjectAreas,
          yearsExperience: p.yearsExperience,
          isAvailable: p.isAvailable,
          maxDistanceMiles: 30,
          overallRating: p.overallRating ?? undefined,
          totalAssignments: p.overallRating === '5.0' ? 1 : 0,
          isActive: true,
        },
      });
      console.log(`    + platform_substitute_profiles ${p.displayName}`);
    }
    profileIds[p.email] = profile.id;
  }

  const sarahProfileId = profileIds['sarah.johnson@subs.example.com']!;
  const mikeProfileId = profileIds['mike.patel@subs.example.com']!;
  const lisaProfileId = profileIds['lisa.anderson@subs.example.com']!;

  // ── C. platform_sub_credentials ─────────────────────────────────────
  const principalEmployeeId = await findEmployeeIdByEmail(client, 'principal@demo.campusos.dev');

  const credentials = [
    {
      substituteId: sarahProfileId,
      credentialType: 'TEACHING_LICENSE',
      credentialName: 'State Teaching License',
      issuingBody: 'Department of Education',
      issueDate: '2021-09-01',
      expiryDate: '2027-08-31',
      verificationStatus: 'VERIFIED',
      verifiedBy: principalEmployeeId,
      verifiedAt: new Date(),
    },
    {
      substituteId: sarahProfileId,
      credentialType: 'FIRST_AID',
      credentialName: 'First Aid Certificate',
      issuingBody: 'Red Cross',
      issueDate: '2024-06-15',
      // 45 days from today — drives the expiry alert keystone window.
      expiryDate: isoDateOffset(45),
      verificationStatus: 'VERIFIED',
      verifiedBy: principalEmployeeId,
      verifiedAt: new Date(),
    },
    {
      substituteId: mikeProfileId,
      credentialType: 'TEACHING_LICENSE',
      credentialName: 'State Teaching License',
      issuingBody: 'Department of Education',
      issueDate: '2024-01-15',
      expiryDate: '2029-01-14',
      verificationStatus: 'PENDING',
    },
    {
      substituteId: mikeProfileId,
      credentialType: 'BACKGROUND_CHECK',
      credentialName: 'Enhanced DBS',
      issuingBody: 'DBS',
      issueDate: '2024-09-01',
      expiryDate: '2027-09-01',
      verificationStatus: 'VERIFIED',
      verifiedBy: principalEmployeeId,
      verifiedAt: new Date(),
    },
    {
      substituteId: lisaProfileId,
      credentialType: 'TEACHING_LICENSE',
      credentialName: 'State Teaching License',
      issuingBody: 'Department of Education',
      issueDate: '2016-08-01',
      expiryDate: '2026-07-31',
      verificationStatus: 'VERIFIED',
      verifiedBy: principalEmployeeId,
      verifiedAt: new Date(),
    },
    {
      substituteId: lisaProfileId,
      credentialType: 'SAFEGUARDING',
      credentialName: 'Safeguarding Level 2',
      issuingBody: 'Safer Schools Foundation',
      issueDate: '2025-03-01',
      expiryDate: '2028-03-01',
      verificationStatus: 'VERIFIED',
      verifiedBy: principalEmployeeId,
      verifiedAt: new Date(),
    },
  ];

  for (const c of credentials) {
    const existing = await client.platformSubCredential.findFirst({
      where: { substituteId: c.substituteId, credentialName: c.credentialName },
    });
    if (!existing) {
      await client.platformSubCredential.create({
        data: {
          id: generateId(),
          substituteId: c.substituteId,
          credentialType: c.credentialType,
          credentialName: c.credentialName,
          issuingBody: c.issuingBody,
          issueDate: new Date(c.issueDate),
          expiryDate: c.expiryDate ? new Date(c.expiryDate) : null,
          verificationStatus: c.verificationStatus,
          verifiedBy: c.verifiedBy ?? null,
          verifiedAt: c.verifiedAt ?? null,
        },
      });
      console.log(`    + platform_sub_credentials ${c.credentialName} (${c.verificationStatus})`);
    }
  }

  // ── D. platform_sub_availability ────────────────────────────────────
  // Sarah Mon-Thu 7am-3pm RECURRING + BLOCKED next Friday
  // Mike Tue+Thu 9am-3pm RECURRING
  // Lisa specific future date
  const availabilityRows = [
    // Sarah RECURRING Mon-Thu
    ...[1, 2, 3, 4].map((dow) => ({
      substituteId: sarahProfileId,
      availabilityType: 'RECURRING',
      dayOfWeek: dow,
      specificDate: null as string | null,
      startTime: '07:00',
      endTime: '15:00',
    })),
    // Sarah BLOCKED next Friday
    {
      substituteId: sarahProfileId,
      availabilityType: 'BLOCKED',
      dayOfWeek: null as number | null,
      specificDate: nextDayOfWeek(5), // 5 = Friday
      startTime: null,
      endTime: null,
    },
    // Mike Tue + Thu
    ...[2, 4].map((dow) => ({
      substituteId: mikeProfileId,
      availabilityType: 'RECURRING',
      dayOfWeek: dow,
      specificDate: null as string | null,
      startTime: '09:00',
      endTime: '15:00',
    })),
    // Lisa SPECIFIC date
    {
      substituteId: lisaProfileId,
      availabilityType: 'SPECIFIC',
      dayOfWeek: null as number | null,
      specificDate: isoDateOffset(14),
      startTime: '08:00',
      endTime: '15:00',
    },
  ];

  for (const a of availabilityRows) {
    // Idempotency: substitute_id + (dow|specific_date) + start_time
    const existing = await client.platformSubAvailability.findFirst({
      where: {
        substituteId: a.substituteId,
        availabilityType: a.availabilityType,
        dayOfWeek: a.dayOfWeek,
        specificDate: a.specificDate ? new Date(a.specificDate) : null,
      },
    });
    if (!existing) {
      await client.platformSubAvailability.create({
        data: {
          id: generateId(),
          substituteId: a.substituteId,
          availabilityType: a.availabilityType,
          dayOfWeek: a.dayOfWeek as number | null,
          specificDate: a.specificDate ? new Date(a.specificDate) : null,
          startTime: a.startTime ? new Date(`1970-01-01T${a.startTime}:00Z`) : null,
          endTime: a.endTime ? new Date(`1970-01-01T${a.endTime}:00Z`) : null,
        },
      });
    }
  }
  console.log(`    + platform_sub_availability (${availabilityRows.length} rows)`);

  // ── E. platform_sub_preferences ─────────────────────────────────────
  const preferences = [
    {
      substituteId: sarahProfileId,
      schoolId,
      preferenceType: 'PREFERRED',
      reason: 'Great rapport with the math department.',
    },
    {
      substituteId: lisaProfileId,
      schoolId: 'ffffffff-1111-1111-1111-ffffffffffff', // synthetic Elmwood school
      preferenceType: 'BLOCKED',
      reason: 'Bad scheduling experience in 2025.',
    },
  ];

  for (const pref of preferences) {
    const existing = await client.platformSubPreference.findFirst({
      where: { substituteId: pref.substituteId, schoolId: pref.schoolId },
    });
    if (!existing) {
      await client.platformSubPreference.create({ data: { id: generateId(), ...pref } });
      console.log(
        `    + platform_sub_preferences ${pref.preferenceType} ${pref.schoolId.substring(0, 8)}`,
      );
    }
  }

  // ── F. sub_school_pool ──────────────────────────────────────────────
  const poolRows = [
    {
      substituteId: sarahProfileId,
      status: 'ACTIVE',
      addedBy: principalEmployeeId,
      suspendedUntil: null as string | null,
      suspensionReason: null as string | null,
      notes: 'Top of pool. Sarah has 5 years experience and 5/5 rating.',
    },
    {
      substituteId: mikeProfileId,
      status: 'ACTIVE',
      addedBy: principalEmployeeId,
      suspendedUntil: null,
      suspensionReason: null,
      notes: 'New addition. High school science specialist.',
    },
    {
      substituteId: lisaProfileId,
      status: 'SUSPENDED',
      addedBy: principalEmployeeId,
      suspendedUntil: isoDateOffset(7),
      suspensionReason:
        'Late cancellation on 2026-04-30 (3rd offence — temporary 7-day suspension per cancellation policy).',
      notes: 'Returns to pool after suspension expires.',
    },
  ];

  for (const pool of poolRows) {
    await execTenant(
      client,
      'INSERT INTO sub_school_pool (id, school_id, substitute_id, status, added_by, suspended_until, suspension_reason, notes) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::uuid, $6::date, $7, $8) ' +
        'ON CONFLICT (school_id, substitute_id) DO NOTHING',
      [
        generateId(),
        schoolId,
        pool.substituteId,
        pool.status,
        pool.addedBy,
        pool.suspendedUntil,
        pool.suspensionReason,
        pool.notes,
      ],
    );
  }
  console.log(`    + sub_school_pool (${poolRows.length} rows)`);

  // ── G. sub_job_postings + classes + notifications ──────────────────
  const riveraEmpId = await findEmployeeIdByEmail(client, 'teacher@demo.campusos.dev');

  // Job 1 — historical FILLED, Rivera's classes
  const job1Date = isoDateOffset(-3);
  const job1Id = await execTenantReturn(
    client,
    'INSERT INTO sub_job_postings (id, school_id, absent_teacher_id, job_date, start_time, end_time, job_type, grade_level, subject, posted_by, status, acceptance_window_minutes, notification_tier, filled_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::time, $6::time, $7, $8, $9, $10::uuid, 'FILLED', 30, 'POOL', now() - interval '3 days') " +
      'ON CONFLICT DO NOTHING RETURNING id',
    [
      generateId(),
      schoolId,
      riveraEmpId,
      job1Date,
      '08:00',
      '15:00',
      'FULL_DAY',
      '5',
      'Math',
      principalEmployeeId,
    ],
  );

  // Re-find the job id idempotently
  const job1 = await execTenantOne(
    client,
    "SELECT id FROM sub_job_postings WHERE school_id = $1::uuid AND absent_teacher_id = $2::uuid AND job_date = $3::date AND status = 'FILLED' LIMIT 1",
    [schoolId, riveraEmpId, job1Date],
  );
  const resolvedJob1Id = (job1 as { id: string } | null)?.id ?? job1Id;
  if (!resolvedJob1Id) throw new Error('Failed to seed Job 1');

  // Job 2 — upcoming OPEN
  const job2Date = isoDateOffset(7);
  await execTenant(
    client,
    'INSERT INTO sub_job_postings (id, school_id, absent_teacher_id, job_date, start_time, end_time, job_type, grade_level, subject, posted_by, status, acceptance_window_minutes, notification_tier, escalate_to_marketplace_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::time, $6::time, $7, $8, $9, $10::uuid, 'OPEN', 30, 'POOL', now() + interval '30 minutes') " +
      'ON CONFLICT DO NOTHING',
    [
      generateId(),
      schoolId,
      riveraEmpId,
      job2Date,
      '08:00',
      '12:30',
      'HALF_DAY',
      '5',
      'Math',
      principalEmployeeId,
    ],
  );

  // Get a few sch_timetable_slots for the snapshot
  const slots = await client.$queryRawUnsafe<Array<{ id: string }>>(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.sch_timetable_slots WHERE teacher_id = $1::uuid LIMIT 3',
    riveraEmpId,
  );

  for (let i = 0; i < slots.length; i++) {
    await execTenant(
      client,
      'INSERT INTO sub_job_classes (id, job_id, timetable_slot_id, class_name, room_name, period_label) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6) ' +
        'ON CONFLICT DO NOTHING',
      [
        generateId(),
        resolvedJob1Id,
        slots[i]!.id,
        `5th Grade Math (Period ${i * 2 + 1})`,
        `Room ${100 + i}`,
        `P${i * 2 + 1}`,
      ],
    );
  }
  console.log(`    + sub_job_classes (${slots.length} snapshot rows for Job 1)`);

  // 4 notifications
  const job1NotifiedAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
  const job1ExpiryAt = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000 + 30 * 60 * 1000);
  const notifications = [
    {
      jobId: resolvedJob1Id,
      substituteId: sarahProfileId,
      response: 'ACCEPTED',
      respondedAt: new Date(job1ExpiryAt.getTime() - 5 * 60 * 1000),
      tier: 'POOL',
    },
    {
      jobId: resolvedJob1Id,
      substituteId: mikeProfileId,
      response: 'DECLINED',
      respondedAt: new Date(job1ExpiryAt.getTime() - 10 * 60 * 1000),
      tier: 'POOL',
    },
    {
      jobId: resolvedJob1Id,
      substituteId: lisaProfileId,
      response: 'EXPIRED',
      respondedAt: job1ExpiryAt,
      tier: 'POOL',
    },
  ];
  for (const n of notifications) {
    await execTenant(
      client,
      'INSERT INTO sub_job_notifications (id, job_id, substitute_id, notification_tier, notified_at, response, responded_at, acceptance_window_expires_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, $6, $7::timestamptz, $8::timestamptz) ' +
        'ON CONFLICT (job_id, substitute_id) DO NOTHING',
      [
        generateId(),
        n.jobId,
        n.substituteId,
        n.tier,
        job1NotifiedAt.toISOString(),
        n.response,
        n.respondedAt.toISOString(),
        job1ExpiryAt.toISOString(),
      ],
    );
  }
  console.log(`    + sub_job_notifications (${notifications.length} rows for Job 1)`);

  // ── H. sub_assignments + ratings + session note ────────────────────
  const checkInAt = new Date(`${job1Date}T07:45:00Z`);
  const checkOutAt = new Date(`${job1Date}T15:15:00Z`);

  await execTenant(
    client,
    'INSERT INTO sub_assignments (id, job_id, substitute_id, confirmed_at, check_in_at, check_out_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, $5::timestamptz, $6::timestamptz, 'CHECKED_OUT') " +
      'ON CONFLICT (job_id) DO NOTHING',
    [
      generateId(),
      resolvedJob1Id,
      sarahProfileId,
      job1NotifiedAt.toISOString(),
      checkInAt.toISOString(),
      checkOutAt.toISOString(),
    ],
  );
  const asg = await execTenantOne(
    client,
    'SELECT id FROM sub_assignments WHERE job_id = $1::uuid LIMIT 1',
    [resolvedJob1Id],
  );
  const asgId = (asg as { id: string }).id;

  // 2 ratings (bidirectional)
  await execTenant(
    client,
    'INSERT INTO sub_ratings (id, assignment_id, rater_type, overall_score, professionalism, punctuality, comments, rated_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'SCHOOL_RATES_SUB', 5.0, 5.0, 5.0, $3, $4::uuid) " +
      'ON CONFLICT (assignment_id, rater_type) DO NOTHING',
    [
      generateId(),
      asgId,
      'Sarah was excellent. The kids responded well. Will book again.',
      principalEmployeeId,
    ],
  );
  await execTenant(
    client,
    'INSERT INTO sub_ratings (id, assignment_id, rater_type, overall_score, professionalism, punctuality, comments) ' +
      "VALUES ($1::uuid, $2::uuid, 'SUB_RATES_SCHOOL', 4.0, 4.0, 4.0, $3) " +
      'ON CONFLICT (assignment_id, rater_type) DO NOTHING',
    [generateId(), asgId, 'Friendly office staff. Materials were ready on arrival.'],
  );
  console.log('    + sub_ratings (2 bidirectional)');

  // 1 session note
  await execTenant(
    client,
    'INSERT INTO sub_session_notes (id, assignment_id, notes_text, homework_set, is_visible_to_teacher, submitted_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, true, $5::timestamptz) ' +
      'ON CONFLICT (assignment_id) DO NOTHING',
    [
      generateId(),
      asgId,
      'Covered fractions unit (chapter 7). Maya excelled and finished early. Ethan struggled with word problems and was assigned a practice worksheet pp 45-50. Class generally well-behaved.',
      'Worksheet pp 45-50. Practice problems 1-15.',
      checkOutAt.toISOString(),
    ],
  );
  console.log('    + sub_session_notes (1 row, visible to teacher)');

  // ── I. sub_pay_rates ────────────────────────────────────────────────
  await execTenant(
    client,
    'INSERT INTO sub_pay_rates (id, school_id, substitute_id, job_type, rate, rate_type, effective_from, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'FULL_DAY', 180.00, 'DAILY', $4::date, $5)",
    [
      generateId(),
      schoolId,
      SENTINEL_SCHOOL_DEFAULT_SUB_ID,
      isoDateOffset(-30),
      'Lincoln Academy default daily substitute rate.',
    ],
  ).catch((e) => {
    if (!String(e).includes('sub_pay_rates_no_overlap')) throw e;
  });
  await execTenant(
    client,
    'INSERT INTO sub_pay_rates (id, school_id, substitute_id, job_type, rate, rate_type, effective_from, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'FULL_DAY', 200.00, 'DAILY', $4::date, $5)",
    [
      generateId(),
      schoolId,
      sarahProfileId,
      isoDateOffset(-30),
      'Sarah Johnson — premium rate due to 5+ years experience and 5/5 rating.',
    ],
  ).catch((e) => {
    if (!String(e).includes('sub_pay_rates_no_overlap')) throw e;
  });
  console.log('    + sub_pay_rates (school default + Sarah override)');

  // ── J. sub_cancellation_policies ────────────────────────────────────
  await execTenant(
    client,
    'INSERT INTO sub_cancellation_policies (id, school_id, late_window_hours, consequence, repeat_offence_threshold, notes, updated_by) ' +
      "VALUES ($1::uuid, $2::uuid, 2, 'WARNING_ONLY', 3, $3, $4::uuid) " +
      'ON CONFLICT (school_id) DO NOTHING',
    [
      generateId(),
      schoolId,
      'Substitutes who cancel within 2 hours of job start are flagged. WARNING_ONLY for first 2 offences. 3rd offence triggers TEMPORARY_POOL_SUSPENSION via the CancellationPolicyWorker.',
      principalEmployeeId,
    ],
  );
  console.log('    + sub_cancellation_policies (Lincoln Academy 2h/3-strike)');

  console.log('');
  console.log('  Substitutes Seed COMPLETE.');
  console.log('');
}

// ── Helpers ──────────────────────────────────────────────────────────

async function findEmployeeIdByEmail(
  client: ReturnType<typeof getPlatformClient>,
  email: string,
): Promise<string> {
  const rows = (await client.$queryRawUnsafe(
    'SELECT he.id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.hr_employees he ' +
      'JOIN platform.iam_person p ON p.id = he.person_id ' +
      'JOIN platform.platform_users pu ON pu.person_id = p.id ' +
      'WHERE pu.email = $1',
    email,
  )) as Array<{ id: string }>;
  if (rows.length === 0) throw new Error(`hr_employees not found for ${email}`);
  return rows[0]!.id;
}

async function execTenant(
  client: ReturnType<typeof getPlatformClient>,
  sql: string,
  params: unknown[],
): Promise<void> {
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path = ${TENANT_SCHEMA}, platform, public`);
    await tx.$executeRawUnsafe(sql, ...params);
  });
}

async function execTenantReturn(
  client: ReturnType<typeof getPlatformClient>,
  sql: string,
  params: unknown[],
): Promise<string | null> {
  let result: string | null = null;
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path = ${TENANT_SCHEMA}, platform, public`);
    const rows = (await tx.$queryRawUnsafe(sql, ...params)) as Array<{ id: string }>;
    if (rows.length > 0) result = rows[0]!.id;
  });
  return result;
}

async function execTenantOne(
  client: ReturnType<typeof getPlatformClient>,
  sql: string,
  params: unknown[],
): Promise<unknown> {
  let result: unknown = null;
  await client.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL search_path = ${TENANT_SCHEMA}, platform, public`);
    const rows = (await tx.$queryRawUnsafe(sql, ...params)) as Array<unknown>;
    if (rows.length > 0) result = rows[0];
  });
  return result;
}

function nextDayOfWeek(targetDow: number): string {
  const today = new Date();
  const currentDow = today.getDay();
  const diff = (targetDow + 7 - currentDow) % 7 || 7;
  const result = new Date(today.getTime() + diff * 24 * 60 * 60 * 1000);
  return result.toISOString().slice(0, 10);
}

seedSubstitutes()
  .then(() => disconnectAll())
  .catch((err) => {
    console.error(err);
    return disconnectAll().then(() => {
      throw err;
    });
  });
