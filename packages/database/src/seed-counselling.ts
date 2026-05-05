import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-counselling.ts — Cycle 11 Step 4.
 *
 * Idempotent. Gated on whether svc_referral_types already has rows for
 * the demo school. Re-running is a no-op once the seed has landed.
 *
 * Seven sections:
 *   A) 2 svc_referral_types — "Social/Emotional" (default_priority=MEDIUM,
 *      requires_parent_notification=true) and "Academic Concern"
 *      (default_priority=LOW, requires_parent_notification=false).
 *   B) 1 svc_caseloads row — Marcus Hayes (counsellor) assigned to
 *      Maya Chen for the 2025-2026 academic year. is_primary_counselor=true,
 *      primary_concern=SOCIAL_EMOTIONAL, status=ACTIVE,
 *      opened_at=2025-09-15. Plus a backfill UPDATE on Maya's existing
 *      Cycle 9 BIP to populate svc_behavior_plans.caseload_id with the
 *      new caseload row id — completes the cross-cycle integration that
 *      the Step 3 FK backfill set up.
 *   C) 1 svc_referrals + 1 svc_referral_activity — James Rivera refers
 *      Maya for "Social/Emotional" with reason "Struggling with peer
 *      relationships and declining academic performance...". Priority
 *      MEDIUM, status ACCEPTED, assigned_counselor=Hayes. Activity row:
 *      STATUS_CHANGE captured at acceptance.
 *   D) 2 svc_sessions + 2 svc_session_notes — Session 1: INDIVIDUAL,
 *      COMPLETED, 45 min, ~3 weeks ago, linked to Maya's caseload.
 *      Note 1 with goals_addressed array and follow_up_required=true.
 *      Session 2: CHECK_IN, COMPLETED, 15 min, ~1 week ago. Note 2
 *      brief follow-up. Both notes ship is_locked=false so the Step 6
 *      SessionNoteService can exercise the lock path against fresh
 *      seed data.
 *   E) 1 svc_mtss_tiers + 1 svc_interventions + 1 svc_intervention_progress
 *      — Maya TIER_2 BEHAVIORAL ACTIVE, assigned by Hayes 2025-10-01,
 *      review_date today+30d. Intervention: "Social Skills Group"
 *      BEHAVIORAL_SUPPORT, 2x per week 30 min, ACTIVE, provider=Hayes.
 *      Progress: recorded last week, measure_type="Office Referrals
 *      per Week", score=2.00, benchmark=1.00, notes="Down from 4 at
 *      baseline. Steady improvement.".
 *   F) 1 svc_coordinated_care_notes — Hayes (COUNSELLOR) writes a
 *      coordinated care note about Maya's anxiety around peer teasing
 *      over inhaler use. Demonstrates the nurse + counsellor
 *      intersection-gated thread.
 */

const TENANT_SCHEMA = 'tenant_demo';

function isoDateOffset(daysFromToday: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d.toISOString().slice(0, 10);
}

async function seedCounselling() {
  console.log('');
  console.log(
    '  Counselling Seed (Cycle 11 Step 4 — Caseloads + Referrals + Sessions + MTSS + Coordinated Care)',
  );
  console.log('');

  const client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  async function findEmployeeId(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT he.id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.hr_employees he ' +
        'JOIN platform.iam_person p ON p.id = he.person_id ' +
        'JOIN platform.platform_users pu ON pu.person_id = p.id ' +
        'WHERE pu.email = $1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('hr_employees not found for ' + email);
    return rows[0].id;
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
    if (rows.length === 0)
      throw new Error('sis_students not found for ' + firstName + ' ' + lastName);
    return rows[0].id;
  }

  async function findEmployeePersonId(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT p.id::text AS id ' +
        'FROM platform.iam_person p ' +
        'JOIN platform.platform_users pu ON pu.person_id = p.id ' +
        'WHERE pu.email = $1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('iam_person not found for ' + email);
    return rows[0].id;
  }

  async function findAccountId(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return rows[0].id;
  }

  const [riveraEmpId, hayesEmpId] = await Promise.all([
    findEmployeeId('teacher@demo.campusos.dev'),
    findEmployeeId('counsellor@demo.campusos.dev'),
  ]);
  const [hayesPersonId] = await Promise.all([findEmployeePersonId('counsellor@demo.campusos.dev')]);
  const [hayesAccountId] = await Promise.all([findAccountId('counsellor@demo.campusos.dev')]);
  const mayaStudentId = await findStudentIdByName('Maya', 'Chen');

  // Resolve the 2025-2026 academic year — created in seed-sis.
  const ayRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' + TENANT_SCHEMA + ".sis_academic_years WHERE name = '2025-2026'",
  )) as Array<{ id: string }>;
  if (ayRows.length === 0) throw new Error('sis_academic_years 2025-2026 not found');
  const academicYearId = ayRows[0]!.id;

  // Idempotency gate — checks svc_referral_types for the demo school.
  const existingTypes = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.svc_referral_types WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existingTypes[0] && existingTypes[0].c > 0) {
    console.log('  svc_referral_types already populated for demo school — skipping');
    return;
  }

  // ── 2. Referral types ─────────────────────────────────────────
  console.log('  A) referral types:');
  const socialEmotionalTypeId = generateId();
  const academicTypeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_referral_types (id, school_id, name, description, default_priority, requires_parent_notification) ' +
      "VALUES ($1::uuid, $2::uuid, 'Social/Emotional', $3, 'MEDIUM', true)",
    socialEmotionalTypeId,
    schoolId,
    'Peer relationships, emotional regulation, anxiety, or social withdrawal concerns. Parent notification required by default for the medium-priority intake.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_referral_types (id, school_id, name, description, default_priority, requires_parent_notification) ' +
      "VALUES ($1::uuid, $2::uuid, 'Academic Concern', $3, 'LOW', false)",
    academicTypeId,
    schoolId,
    'Sustained drop in grades or engagement concerns flagged by a teacher. Handled through routine teacher-parent communication. No automatic parent notification.',
  );
  console.log('     - Social/Emotional MEDIUM (notify) + Academic Concern LOW (no notify)');

  // ── 3. Hayes -> Maya caseload + Cycle 9 BIP backfill ─────────
  console.log('  B) caseload + Cycle 9 BIP caseload_id backfill:');
  const caseloadId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_caseloads (id, school_id, counselor_id, student_id, academic_year_id, primary_concern, is_primary_counselor, status, opened_at, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'SOCIAL_EMOTIONAL', true, 'ACTIVE', $6::date, $7)",
    caseloadId,
    schoolId,
    hayesEmpId,
    mayaStudentId,
    academicYearId,
    '2025-09-15',
    'Initial caseload assignment following the September check-in. Focus on peer relationships and emotional regulation. Coordinating with health team on inhaler-use related anxiety.',
  );
  console.log('     - Hayes -> Maya, primary, SOCIAL_EMOTIONAL, opened 2025-09-15');

  const backfillResult = (await client.$executeRawUnsafe(
    'UPDATE ' +
      TENANT_SCHEMA +
      '.svc_behavior_plans SET caseload_id = $1::uuid, updated_at = now() ' +
      'WHERE student_id = $2::uuid AND status = ' +
      "'ACTIVE' AND caseload_id IS NULL",
    caseloadId,
    mayaStudentId,
  )) as number;
  console.log(
    '     - Cycle 9 BIP caseload_id backfill: ' +
      backfillResult +
      ' row(s) updated (Maya ACTIVE BIP now points at the new caseload)',
  );

  // ── 4. Rivera referral + activity ─────────────────────────────
  console.log('  C) referral + activity:');
  const referralId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_referrals (id, school_id, student_id, referred_by, referral_type_id, assigned_counselor_id, priority, status, reason, parent_notified, parent_notified_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, 'MEDIUM', 'ACCEPTED', $7, true, $8::timestamptz)",
    referralId,
    schoolId,
    mayaStudentId,
    riveraEmpId,
    socialEmotionalTypeId,
    hayesEmpId,
    'Struggling with peer relationships and declining academic performance. Shows signs of social withdrawal during group activities. Has not initiated peer interactions in the last three group projects despite prompts.',
    '2026-04-10 14:30:00+00',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_referral_activity (id, referral_id, actor_id, activity_type, notes, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'STATUS_CHANGE', $4, $5::timestamptz)",
    generateId(),
    referralId,
    hayesAccountId,
    'Reviewed and accepted. Caseload assignment already active for Maya. Will follow up via 1:1 sessions over the next month.',
    '2026-04-12 09:15:00+00',
  );
  console.log('     - 1 referral (Rivera -> Maya, Social/Emotional, ACCEPTED) + 1 activity row');

  // ── 5. Sessions + notes ───────────────────────────────────────
  console.log('  D) sessions + notes:');
  const session1Id = generateId();
  const session2Id = generateId();
  // 3 weeks ago and 1 week ago to give the Step 9 session log a
  // realistic date range without crowding around today.
  const session1Date = isoDateOffset(-21);
  const session2Date = isoDateOffset(-7);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_sessions (id, school_id, counselor_id, session_date, duration_minutes, session_type, primary_caseload_id, referral_id, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 45, 'INDIVIDUAL', $5::uuid, $6::uuid, 'COMPLETED', $7)",
    session1Id,
    schoolId,
    hayesEmpId,
    session1Date,
    caseloadId,
    referralId,
    'Initial 1:1 session following referral acceptance. Office.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_sessions (id, school_id, counselor_id, session_date, duration_minutes, session_type, primary_caseload_id, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, 15, 'CHECK_IN', $5::uuid, 'COMPLETED', $6)",
    session2Id,
    schoolId,
    hayesEmpId,
    session2Date,
    caseloadId,
    'Brief follow-up check-in during lunch period.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_session_notes (id, session_id, student_id, notes_text, goals_addressed, follow_up_required, follow_up_notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::text[], true, $6)',
    generateId(),
    session1Id,
    mayaStudentId,
    'Discussed peer relationship challenges. Maya expressed frustration about feeling excluded during group projects. We identified three strategies for initiating peer interactions: (1) start with a shared interest comment, (2) offer to help when a peer looks stuck, and (3) ask one open-ended question. Maya agreed to try at least one of these in science lab next week.',
    ['Peer relationship building', 'Social skills development'],
    'Follow up next week to see which strategies Maya tried and how they went.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_session_notes (id, session_id, student_id, notes_text, goals_addressed, follow_up_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::text[], false)',
    generateId(),
    session2Id,
    mayaStudentId,
    'Brief follow-up. Maya reports trying two of the three strategies. One positive peer interaction during science lab when she offered to help her partner with the lab equipment. Another attempt during lunch was less successful but Maya recognised the effort. Mood appears improved.',
    ['Peer relationship building'],
  );
  console.log(
    '     - Session 1: INDIVIDUAL COMPLETED 45min ' +
      session1Date +
      ' + Note 1 with 2 goals + follow_up_required',
  );
  console.log(
    '     - Session 2: CHECK_IN COMPLETED 15min ' + session2Date + ' + Note 2 brief follow-up',
  );

  // ── 6. MTSS tier + intervention + progress ────────────────────
  console.log('  E) MTSS tier + intervention + progress:');
  const tierId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_mtss_tiers (id, school_id, student_id, academic_year_id, tier, domain, assigned_by, assigned_at, review_date, status, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'TIER_2', 'BEHAVIORAL', $5::uuid, $6::date, $7::date, 'ACTIVE', $8)",
    tierId,
    schoolId,
    mayaStudentId,
    academicYearId,
    hayesEmpId,
    '2025-10-01',
    isoDateOffset(30),
    'Initial tier assignment based on incident pattern (2 medium-severity incidents in early term) and counselling team observation. Will review at 6-week mark.',
  );
  const interventionId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_interventions (id, tier_id, intervention_name, intervention_type, description, frequency, start_date, provider_id, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'BEHAVIORAL_SUPPORT', $4, '2x per week, 30 minutes', $5::date, $6::uuid, 'ACTIVE')",
    interventionId,
    tierId,
    'Social Skills Group',
    'Small-group social skills practice covering conversation initiation, perspective-taking, and conflict de-escalation. Co-facilitated by Hayes and a peer-mentor.',
    '2025-10-15',
    hayesEmpId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_intervention_progress (id, intervention_id, recorded_by, recorded_date, measure_type, score, benchmark, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5, 2.00, 1.00, $6)',
    generateId(),
    interventionId,
    hayesEmpId,
    isoDateOffset(-7),
    'Office Referrals per Week',
    'Down from 4 at baseline. Steady improvement over the last three review windows. Maya is starting to use the conflict de-escalation script we practised in group.',
  );
  console.log(
    '     - 1 TIER_2 BEHAVIORAL ACTIVE + 1 Social Skills Group intervention + 1 progress entry (score=2.00, benchmark=1.00)',
  );

  // ── 7. Coordinated care note ──────────────────────────────────
  console.log('  F) coordinated care note:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.svc_coordinated_care_notes (id, student_id, author_person_id, author_role, note_text) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'COUNSELLOR', $4)",
    generateId(),
    mayaStudentId,
    hayesPersonId,
    'Maya shows anxiety around health episodes that may be related to peer teasing about her inhaler use. Coordinating with nurse Mitchell to ensure Maya has a private space for medication administration to reduce social stigma. Will revisit at our next monthly health-counselling sync.',
  );
  console.log('     - 1 coordinated care note (Hayes / COUNSELLOR / Maya)');

  console.log('');
  console.log('  Counselling seed complete!');
}

seedCounselling()
  .then(() => disconnectAll())
  .catch((err) => {
    console.error(err);
    return disconnectAll().then(() => process.exit(1));
  });
