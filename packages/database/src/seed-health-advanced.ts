import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-health-advanced.ts — Phase 2 Cycle 3 (P2C3) Step 2.
 *
 * M23 Health Advanced. Idempotent — gated on whether
 * hlth_telehealth_providers already has rows for the demo school.
 *
 * Sections:
 *   A) 2 telehealth providers — Children's Mercy Behavioral Health,
 *      Kansas Vision Clinic.
 *   B) 2 telehealth sessions — Maya with behavioral health
 *      (COMPLETED, notes uploaded as encrypted s3 key);
 *      Ethan with Kansas Vision Clinic (SCHEDULED, consent pending).
 *   C) 1 telehealth document — Maya's session notes (encrypted s3 key).
 *   D) 6 Kansas immunisation requirements — DTaP, MMR, IPV,
 *      Varicella, Hep B (all by Kindergarten); Tdap by 7th grade.
 *      Exemption types: MEDICAL + RELIGIOUS allowed.
 *   E) 10 student compliance rows — 7 COMPLIANT, 2 NON_COMPLIANT
 *      with missing_vaccines JSONB documenting the gap, 1 EXEMPT
 *      (religious, document s3 key).
 *   F) 3 screening referrals — Maya VISION GLASSES_PRESCRIBED
 *      (FOLLOW_UP_COMPLETE), Ethan HEARING REFERRED, Aiden SCOLIOSIS
 *      NORMAL (FOLLOW_UP_COMPLETE).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedHealthAdvanced() {
  console.log('');
  console.log('  Health Advanced Seed (P2C3 Step 2)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.hlth_telehealth_providers WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  hlth_telehealth_providers already populated for demo school. Skipping.');
    return;
  }

  async function findUserByEmail(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM platform.platform_users WHERE email = $1 LIMIT 1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('User not found: ' + email);
    return rows[0]!.id;
  }
  const principal = await findUserByEmail('principal@demo.campusos.dev');
  const counsellor = await findUserByEmail('counsellor@demo.campusos.dev');

  const studentLookup = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS id, ip.first_name, ip.last_name, s.grade_level ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.sis_students s ' +
      'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
      'JOIN platform.iam_person ip ON ip.id = ps.person_id ' +
      'ORDER BY ip.last_name, ip.first_name',
  )) as Array<{ id: string; first_name: string; last_name: string; grade_level: string | null }>;
  const findStudent = (first: string, last: string): string | null => {
    const r = studentLookup.find(
      (s) => s.first_name.startsWith(first) && s.last_name.startsWith(last),
    );
    return r ? r.id : null;
  };
  const maya = findStudent('Maya', 'Chen');
  const ethan = findStudent('Ethan', 'Rodriguez');
  const aiden = findStudent('Aiden', 'Johnson');
  if (!maya || !ethan || !aiden) {
    console.warn(
      '  Could not find one or more demo students. maya=' +
        String(maya) +
        ' ethan=' +
        String(ethan) +
        ' aiden=' +
        String(aiden),
    );
  }

  // Look up the current academic year (seeded by seed-sis).
  const yearRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.sis_academic_years WHERE is_current = true LIMIT 1',
  )) as Array<{ id: string }>;
  const academicYearId = yearRows.length > 0 ? yearRows[0]!.id : null;

  // ----- A) telehealth providers -------------------------------------------
  console.log('  Seeding 2 telehealth providers ...');
  const behavioralProviderId = generateId();
  const visionProviderId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hlth_telehealth_providers (id, school_id, provider_name, speciality, ' +
      ' contact_email, contact_phone, booking_url) VALUES ' +
      ' ($1::uuid, $2::uuid, $3, $4, $5, $6, $7), ' +
      ' ($8::uuid, $2::uuid, $9, $10, $11, $12, $13)',
    behavioralProviderId,
    schoolId,
    "Children's Mercy Behavioral Health",
    'Behavioral / Mental Health',
    'consults@cmbh.example',
    '+1-816-555-0142',
    'https://cmbh.example/book',
    visionProviderId,
    'Kansas Vision Clinic',
    'Optometry',
    'appts@ksvision.example',
    '+1-913-555-0211',
    'https://ksvision.example/book',
  );

  // ----- B) telehealth sessions --------------------------------------------
  console.log('  Seeding 2 telehealth sessions ...');
  const mayaSessionId = generateId();
  const ethanSessionId = generateId();
  const completedAt = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000); // 2 weeks ago
  const completedScheduledAt = new Date(completedAt.getTime() - 30 * 60 * 1000);
  const upcomingScheduledAt = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

  if (maya) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_telehealth_sessions ' +
        '(id, school_id, student_id, provider_id, scheduled_at, duration_minutes, status, ' +
        ' meeting_url, session_notes_s3_key, consent_received_at, completed_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, 30, $6, ' +
        ' $7, $8, $9::timestamptz, $10::timestamptz)',
      mayaSessionId,
      schoolId,
      maya,
      behavioralProviderId,
      completedScheduledAt.toISOString(),
      'COMPLETED',
      'https://cmbh.example/meet/abc123',
      'tenants/demo/telehealth/' + mayaSessionId + '/notes.enc',
      new Date(completedScheduledAt.getTime() - 24 * 60 * 60 * 1000).toISOString(),
      completedAt.toISOString(),
    );
  }
  if (ethan) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_telehealth_sessions ' +
        '(id, school_id, student_id, provider_id, scheduled_at, duration_minutes, status, meeting_url) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, 45, $6, $7)',
      ethanSessionId,
      schoolId,
      ethan,
      visionProviderId,
      upcomingScheduledAt.toISOString(),
      'SCHEDULED',
      'https://ksvision.example/meet/xyz789',
    );
  }

  // ----- C) telehealth documents -------------------------------------------
  if (maya) {
    console.log('  Seeding 1 telehealth document ...');
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_telehealth_documents ' +
        '(id, session_id, document_type, s3_key, file_size_bytes, uploaded_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
      generateId(),
      mayaSessionId,
      'SESSION_NOTES',
      'tenants/demo/telehealth/' + mayaSessionId + '/notes.enc',
      4096,
      counsellor,
    );
  }

  // ----- D) Kansas immunisation requirements -------------------------------
  console.log('  Seeding 6 Kansas immunisation requirements ...');
  const requirements = [
    { vaccine: 'DTaP', doses: 5, grade: 'K' },
    { vaccine: 'MMR', doses: 2, grade: 'K' },
    { vaccine: 'IPV', doses: 4, grade: 'K' },
    { vaccine: 'Varicella', doses: 2, grade: 'K' },
    { vaccine: 'Hep B', doses: 3, grade: 'K' },
    { vaccine: 'Tdap', doses: 1, grade: '7' },
  ];
  for (const r of requirements) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_immunisation_requirements ' +
        '(id, school_id, state_code, vaccine_name, required_doses, required_by_grade, ' +
        " allows_exemption, exemption_types) VALUES ($1::uuid, NULL, 'KS', $2, $3, $4, true, " +
        " ARRAY['MEDICAL', 'RELIGIOUS'])",
      generateId(),
      r.vaccine,
      r.doses,
      r.grade,
    );
  }

  // ----- E) 10 compliance rows ---------------------------------------------
  console.log('  Seeding 10 immunisation compliance rows ...');
  const compliancePlan: Array<{
    studentId: string | null;
    status: string;
    missing: Array<{ vaccine_name: string; doses_received: number; doses_required: number }>;
    exemption: string | null;
    parentNotified: boolean;
  }> = [
    { studentId: maya, status: 'COMPLIANT', missing: [], exemption: null, parentNotified: false },
    { studentId: ethan, status: 'COMPLIANT', missing: [], exemption: null, parentNotified: false },
    { studentId: aiden, status: 'COMPLIANT', missing: [], exemption: null, parentNotified: false },
  ];
  // Use other seeded students for the remaining 7 rows.
  for (let i = 0; i < studentLookup.length && compliancePlan.length < 10; i++) {
    const s = studentLookup[i]!;
    if (
      compliancePlan.find((c) => c.studentId === s.id) ||
      s.id === maya ||
      s.id === ethan ||
      s.id === aiden
    ) {
      continue;
    }
    if (compliancePlan.length === 7) {
      compliancePlan.push({
        studentId: s.id,
        status: 'NON_COMPLIANT',
        missing: [{ vaccine_name: 'MMR', doses_received: 1, doses_required: 2 }],
        exemption: null,
        parentNotified: false,
      });
    } else if (compliancePlan.length === 8) {
      compliancePlan.push({
        studentId: s.id,
        status: 'NON_COMPLIANT',
        missing: [
          { vaccine_name: 'Varicella', doses_received: 1, doses_required: 2 },
          { vaccine_name: 'Hep B', doses_received: 2, doses_required: 3 },
        ],
        exemption: null,
        parentNotified: false,
      });
    } else if (compliancePlan.length === 9) {
      compliancePlan.push({
        studentId: s.id,
        status: 'EXEMPT',
        missing: [],
        exemption: 'RELIGIOUS',
        parentNotified: false,
      });
    } else {
      compliancePlan.push({
        studentId: s.id,
        status: 'COMPLIANT',
        missing: [],
        exemption: null,
        parentNotified: false,
      });
    }
  }
  for (const row of compliancePlan) {
    if (!row.studentId) continue;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_immunisation_compliance ' +
        '(id, student_id, school_id, academic_year_id, status, missing_vaccines, ' +
        ' exemption_type, exemption_document_s3_key, last_computed_at) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6::jsonb, $7, $8, now())',
      generateId(),
      row.studentId,
      schoolId,
      academicYearId,
      row.status,
      JSON.stringify(row.missing),
      row.exemption,
      row.exemption === 'RELIGIOUS'
        ? 'tenants/demo/imm/exemption/' + row.studentId + '/religious.enc'
        : null,
    );
  }

  // ----- F) 3 screening referrals ------------------------------------------
  console.log('  Seeding 3 screening referrals ...');

  // Find or create a screening row per referral (Cycle 10 hlth_screenings).
  async function findOrCreateScreening(
    studentId: string,
    type: 'VISION' | 'HEARING' | 'SCOLIOSIS',
  ): Promise<string> {
    const existing = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM ' +
        TENANT_SCHEMA +
        '.hlth_screenings WHERE student_id = $1::uuid AND screening_type = $2 LIMIT 1',
      studentId,
      type,
    )) as Array<{ id: string }>;
    if (existing.length > 0) return existing[0]!.id;
    const id = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_screenings ' +
        '(id, school_id, student_id, screening_type, screening_date, result, follow_up_required) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, CURRENT_DATE - INTERVAL '14 days', 'REFER', true)",
      id,
      schoolId,
      studentId,
      type,
    );
    return id;
  }

  if (maya) {
    const sid = await findOrCreateScreening(maya, 'VISION');
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_screening_referrals ' +
        '(id, screening_id, student_id, school_id, referral_type, reason, referred_to, ' +
        ' referral_date, follow_up_date, follow_up_outcome, follow_up_notes, status, created_by) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'VISION', $5, $6, " +
        " CURRENT_DATE - INTERVAL '14 days', CURRENT_DATE - INTERVAL '5 days', " +
        " 'GLASSES_PRESCRIBED', $7, 'FOLLOW_UP_COMPLETE', $8::uuid)",
      generateId(),
      sid,
      maya,
      schoolId,
      'Right eye 20/40 — below 20/30 referral threshold',
      'Kansas Vision Clinic',
      'Glasses prescribed; follow-up in 6 months.',
      principal,
    );
  }

  if (ethan) {
    const sid = await findOrCreateScreening(ethan, 'HEARING');
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_screening_referrals ' +
        '(id, screening_id, student_id, school_id, referral_type, reason, referred_to, ' +
        ' referral_date, follow_up_date, status, created_by) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'HEARING', $5, $6, " +
        " CURRENT_DATE - INTERVAL '7 days', CURRENT_DATE + INTERVAL '14 days', " +
        " 'REFERRED', $7::uuid)",
      generateId(),
      sid,
      ethan,
      schoolId,
      'Right ear 25dB threshold at 1kHz — below normal range',
      'Audiology Associates',
      principal,
    );
  }

  if (aiden) {
    const sid = await findOrCreateScreening(aiden, 'SCOLIOSIS');
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.hlth_screening_referrals ' +
        '(id, screening_id, student_id, school_id, referral_type, reason, referred_to, ' +
        ' referral_date, follow_up_date, follow_up_outcome, follow_up_notes, status, created_by) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'SCOLIOSIS', $5, $6, " +
        " CURRENT_DATE - INTERVAL '21 days', CURRENT_DATE - INTERVAL '7 days', " +
        " 'NORMAL', $7, 'FOLLOW_UP_COMPLETE', $8::uuid)",
      generateId(),
      sid,
      aiden,
      schoolId,
      'Forward bend test asymmetry observed during screening',
      "Children's Orthopedic Clinic",
      'Routine asymmetry; no follow-up required.',
      principal,
    );
  }

  console.log('');
  console.log('  M23 Health Advanced seed complete.');
  console.log('  - 2 providers, 2 sessions, 1 document,');
  console.log('  - 6 Kansas immunisation requirements, 10 compliance rows,');
  console.log('  - 3 screening referrals.');
  console.log('');
}

seedHealthAdvanced()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectAll();
  });
