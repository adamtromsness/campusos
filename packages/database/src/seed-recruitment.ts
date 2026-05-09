import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-recruitment.ts — Phase 2 Cycle 4 (P2C4) sub-cycle b.
 *
 * Idempotent — gated on whether hr_job_postings already has rows
 * for the demo school.
 *
 * Sections:
 *   A) 1 LIVE job posting — "5th Grade Teacher", FULL_TIME, salary
 *      45-60K, deadline 60 days from now, posted 7 days ago.
 *   B) 3 candidate iam_person + platform_users rows. The seed
 *      writes platform.iam_person + platform.platform_users
 *      directly so the public apply() path is exercised by the
 *      CAT instead of being a no-op.
 *   C) 3 hr_applications — INTERVIEW_COMPLETED, OFFER_EXTENDED,
 *      and NOT_SELECTED, one per candidate.
 *   D) 1 interview panel "Grade 5 Hiring Panel" — Mitchell + Park.
 *   E) 2 hr_interviews tied to the first two candidates, both
 *      COMPLETED with interview notes.
 *   F) 4 evaluations across the 2 interviews (Mitchell + Park
 *      evaluated each), ratings: HIRE / STRONG_HIRE / NEUTRAL /
 *      HIRE.
 *   G) 1 PENDING offer extended to candidate #2 (the OFFER_EXTENDED
 *      application), salary 50K, start in 30 days, 14-day
 *      acceptance deadline.
 *   H) 1 hr_job_alert for candidate #1.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedRecruitment() {
  console.log('');
  console.log('  Recruitment Seed (P2C4 sub-cycle b)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.hr_job_postings WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  hr_job_postings already populated for demo school. Skipping.');
    return;
  }

  await client.$executeRawUnsafe('SET search_path TO ' + TENANT_SCHEMA + ', platform, public');

  const adminUser = await client.platformUser.findFirst({
    where: { email: 'principal@demo.campusos.dev' },
  });
  if (!adminUser) throw new Error('principal user not found — run pnpm seed first');
  const principalPersonId = adminUser.personId;
  // Find another panelist — Linda Park if seeded.
  const vp = await client.platformUser.findFirst({
    where: { email: 'vp@demo.campusos.dev' },
  });
  if (!vp) throw new Error('vp user not found — run pnpm seed first');
  const vpPersonId = vp.personId;

  // --- A. 1 LIVE job posting ---
  const postingId = generateId();
  const today = new Date();
  const postedAt = new Date(today);
  postedAt.setDate(today.getDate() - 7);
  const deadline = new Date(today);
  deadline.setDate(today.getDate() + 60);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_job_postings (id, school_id, position_title, department, description, qualifications_required, ' +
      ' salary_range_low, salary_range_high, employment_type, application_deadline, status, posted_at, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, 'FULL_TIME', $9::date, 'LIVE', $10::timestamptz, $11::uuid)",
    postingId,
    schoolId,
    '5th Grade Teacher',
    'Elementary',
    'Lincoln Academy is seeking a passionate 5th grade teacher to join our elementary team for the 2026-2027 academic year. The successful candidate will design engaging lessons across all core subjects, collaborate with the grade-level team, and partner with families to support student growth.',
    "Bachelor''s degree in Education or related field. State teaching certification (or eligibility). 2+ years of elementary classroom experience preferred. Demonstrated commitment to inclusive practice.",
    45000,
    60000,
    deadline.toISOString().slice(0, 10),
    postedAt.toISOString(),
    adminUser.id,
  );
  console.log('  A. 1 LIVE job posting (5th Grade Teacher)');

  // --- B. 3 candidate iam_person + platform_users rows ---
  const candidates = [
    {
      firstName: 'Hannah',
      lastName: 'Bauer',
      email: 'hannah.bauer@example.com',
      phone: '+1-217-555-1101',
    },
    {
      firstName: 'Marcus',
      lastName: 'Singh',
      email: 'marcus.singh@example.com',
      phone: '+1-217-555-1102',
    },
    {
      firstName: 'Elena',
      lastName: 'Reyes',
      email: 'elena.reyes@example.com',
      phone: '+1-217-555-1103',
    },
  ];
  const candidateIds: Array<{ personId: string; userId: string }> = [];
  for (const c of candidates) {
    const personId = generateId();
    await client.$executeRawUnsafe(
      "INSERT INTO platform.iam_person (id, first_name, last_name, primary_phone, person_type) VALUES ($1::uuid, $2, $3, $4, 'STAFF')",
      personId,
      c.firstName,
      c.lastName,
      c.phone,
    );
    const userId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO platform.platform_users (id, person_id, email, account_status, account_type) ' +
        "VALUES ($1::uuid, $2::uuid, LOWER($3), 'PENDING_VERIFICATION', 'HUMAN')",
      userId,
      personId,
      c.email,
    );
    candidateIds.push({ personId, userId });
  }
  console.log('  B. 3 candidate identities created');

  // --- C. 3 hr_applications ---
  const applicationStates = [
    { idx: 0, status: 'INTERVIEW_COMPLETED' },
    { idx: 1, status: 'OFFER_EXTENDED' },
    { idx: 2, status: 'NOT_SELECTED' },
  ];
  const applicationIds: string[] = [];
  for (const a of applicationStates) {
    const id = generateId();
    applicationIds.push(id);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_applications (id, posting_id, person_id, status, resume_s3_key, cover_letter_s3_key, not_selected_reason) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7)',
      id,
      postingId,
      candidateIds[a.idx]!.personId,
      a.status,
      'recruitment/applications/' + id + '/resume.pdf',
      'recruitment/applications/' + id + '/cover-letter.pdf',
      a.status === 'NOT_SELECTED' ? 'Stronger candidates advanced to the offer stage.' : null,
    );
  }
  console.log('  C. 3 applications (INTERVIEW_COMPLETED, OFFER_EXTENDED, NOT_SELECTED)');

  // --- D. 1 interview panel ---
  const panelId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_interview_panels (id, posting_id, panel_name, notes, created_by) VALUES ($1::uuid, $2::uuid, $3, $4, $5::uuid)',
    panelId,
    postingId,
    'Grade 5 Hiring Panel',
    'Two-person panel — principal + VP. Each conducts a 45-minute structured interview.',
    adminUser.id,
  );
  for (const personId of [principalPersonId, vpPersonId]) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_interview_panel_members (id, panel_id, panelist_person_id, role_in_panel) VALUES ($1::uuid, $2::uuid, $3::uuid, $4)',
      generateId(),
      panelId,
      personId,
      personId === principalPersonId ? 'CHAIR' : 'MEMBER',
    );
  }
  console.log('  D. 1 panel (Mitchell + Park)');

  // --- E. 2 COMPLETED interviews ---
  const interviewIds: string[] = [];
  for (let i = 0; i < 2; i++) {
    const id = generateId();
    interviewIds.push(id);
    const scheduledAt = new Date(today);
    scheduledAt.setDate(today.getDate() - (5 - i));
    const completedAt = new Date(scheduledAt);
    completedAt.setMinutes(completedAt.getMinutes() + 45);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_interviews (id, application_id, panel_id, scheduled_at, duration_minutes, location, status, notes, completed_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::timestamptz, 45, 'Conference Room A', 'COMPLETED', $5, $6::timestamptz)",
      id,
      applicationIds[i]!,
      panelId,
      scheduledAt.toISOString(),
      'Structured behavioural + classroom-scenario interview.',
      completedAt.toISOString(),
    );
  }
  console.log('  E. 2 COMPLETED interviews');

  // --- F. 4 evaluations ---
  const evaluations = [
    { interviewIdx: 0, evaluatorPersonId: principalPersonId, rating: 'HIRE' },
    { interviewIdx: 0, evaluatorPersonId: vpPersonId, rating: 'NEUTRAL' },
    { interviewIdx: 1, evaluatorPersonId: principalPersonId, rating: 'STRONG_HIRE' },
    { interviewIdx: 1, evaluatorPersonId: vpPersonId, rating: 'HIRE' },
  ];
  for (const e of evaluations) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hr_interview_evaluations (id, interview_id, evaluator_id, rating, strengths, concerns) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6)',
      generateId(),
      interviewIds[e.interviewIdx]!,
      e.evaluatorPersonId,
      e.rating,
      'Clear pedagogical philosophy. Strong responses to scenario questions.',
      e.rating === 'NEUTRAL' ? 'Limited experience with the specific curriculum.' : null,
    );
  }
  console.log('  F. 4 evaluations (HIRE / NEUTRAL / STRONG_HIRE / HIRE)');

  // --- G. 1 PENDING offer ---
  const offerId = generateId();
  const startDate = new Date(today);
  startDate.setDate(today.getDate() + 30);
  const acceptanceDeadline = new Date(today);
  acceptanceDeadline.setDate(today.getDate() + 14);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_offers (id, application_id, school_id, position_title, salary, start_date, contract_type, conditions, ' +
      ' acceptance_deadline, status, extended_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, 'ANNUAL', $7::jsonb, $8::date, 'PENDING', $9::uuid)",
    offerId,
    applicationIds[1]!,
    schoolId,
    '5th Grade Teacher',
    50000,
    startDate.toISOString().slice(0, 10),
    JSON.stringify([
      'Provide background-check clearance before start date.',
      'Sign FERPA + acceptable-use policy.',
    ]),
    acceptanceDeadline.toISOString().slice(0, 10),
    adminUser.id,
  );
  console.log('  G. 1 PENDING offer (Marcus Singh, $50K, ANNUAL)');

  // --- H. 1 hr_job_alert ---
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_job_alerts (id, person_id, school_id, subject_area, grade_level, employment_type) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Elementary Education', '5', 'FULL_TIME')",
    generateId(),
    candidateIds[0]!.personId,
    schoolId,
  );
  console.log('  H. 1 job alert (Hannah Bauer)');

  console.log('  done.');
}

seedRecruitment()
  .then(() => disconnectAll())
  .catch((err) => {
    console.error(err);
    return disconnectAll().then(() => {
      process.exit(1);
    });
  });
