import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-training.ts — Phase 2 Cycle 4 sub-cycle c (P2-4c) Step 7.
 *
 * Idempotent — gated on whether hr_training_programmes already
 * has rows for the demo school.
 *
 * Sections:
 *   A) 2 training programmes:
 *      - "Safeguarding Level 1" mandatory annual (12 months).
 *      - "First Aid (Adult Pediatric)" mandatory triennial (36 months).
 *   B) 2 cert types matching by name (so the AUTO-ISSUE keystone
 *      fires when a completion is recorded against either).
 *   C) 2 training events:
 *      - Safeguarding L1 last quarter — COMPLETED.
 *      - First Aid this quarter — SCHEDULED.
 *   D) 1 completion (Rivera completed Safeguarding L1 last quarter
 *      with a passing score of 92). Triggers the AUTO-ISSUE keystone
 *      so an hr_employee_certifications row should land.
 *   E) 1 manual employee certification — Mitchell holds the
 *      Pediatric First Aid certification (issued by Red Cross,
 *      expires in ~30 months — within Phase 2 polish window for the
 *      certifications-expiring dashboard test).
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedTraining() {
  console.log('');
  console.log('  Training Seed (P2-4c sub-cycle c)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.hr_training_programmes WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  hr_training_programmes already populated for demo school. Skipping.');
    return;
  }

  await client.$executeRawUnsafe('SET search_path TO ' + TENANT_SCHEMA + ', platform, public');

  // Find Rivera + Mitchell employee ids.
  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, pu.email ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e ' +
      'JOIN platform.iam_person ip ON ip.id = e.person_id ' +
      'JOIN platform.platform_users pu ON pu.person_id = ip.id ' +
      "WHERE pu.email IN ('teacher@demo.campusos.dev', 'principal@demo.campusos.dev')",
  )) as Array<{ id: string; email: string }>;
  const riveraId = employees.find((e) => e.email === 'teacher@demo.campusos.dev')?.id;
  const mitchellId = employees.find((e) => e.email === 'principal@demo.campusos.dev')?.id;
  if (!riveraId || !mitchellId) {
    throw new Error('seed-training requires Rivera + Mitchell hr_employees rows from seed-hr');
  }

  // --- A. 2 programmes ---
  const safeguardingId = generateId();
  const firstAidId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_training_programmes (id, school_id, name, description, is_mandatory, renewal_months) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, true, 12)',
    safeguardingId,
    schoolId,
    'Safeguarding Level 1',
    'Annual safeguarding refresher covering child protection statute, reporting protocols, and DSL escalation paths.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_training_programmes (id, school_id, name, description, is_mandatory, renewal_months) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, true, 36)',
    firstAidId,
    schoolId,
    'First Aid (Adult Pediatric)',
    'Three-year first aid certification covering CPR, choking response, anaphylaxis injectors, and bleeding control. Required for all instructional staff.',
  );
  console.log('  A. 2 programmes (Safeguarding L1 annual + First Aid triennial)');

  // --- B. 2 cert types matching by name ---
  const safeguardingTypeId = generateId();
  const firstAidTypeId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_certification_types (id, school_id, name, issuing_body, validity_months, is_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, 12, true)',
    safeguardingTypeId,
    schoolId,
    'Safeguarding Level 1',
    'Lincoln Academy Internal',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_certification_types (id, school_id, name, issuing_body, validity_months, is_required) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, 36, true)',
    firstAidTypeId,
    schoolId,
    'First Aid (Adult Pediatric)',
    'American Red Cross',
  );
  console.log('  B. 2 cert types (matching programmes by name)');

  // --- C. 2 events ---
  const today = new Date();
  const lastQuarter = new Date(today);
  lastQuarter.setDate(today.getDate() - 90);
  const nextMonth = new Date(today);
  nextMonth.setDate(today.getDate() + 30);
  const completedEventId = generateId();
  const scheduledEventId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_training_events (id, programme_id, school_id, title, scheduled_at, duration_minutes, ' +
      ' location, facilitator, status, completed_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, 90, $6, $7, 'COMPLETED', $5::timestamptz)",
    completedEventId,
    safeguardingId,
    schoolId,
    'Safeguarding L1 — Spring refresher',
    lastQuarter.toISOString(),
    'Conference Room A',
    'Marcus Hayes (DSL)',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_training_events (id, programme_id, school_id, title, scheduled_at, duration_minutes, ' +
      ' location, facilitator, status, max_participants) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::timestamptz, 480, $6, $7, 'SCHEDULED', 20)",
    scheduledEventId,
    firstAidId,
    schoolId,
    'First Aid certification — full day',
    nextMonth.toISOString(),
    'Multi-purpose Hall',
    'Red Cross instructor (TBD)',
  );
  console.log('  C. 2 events (1 COMPLETED + 1 SCHEDULED)');

  // --- D. 1 completion + auto-issued cert ---
  const completionId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_training_completions (id, event_id, employee_id, school_id, completed_at, score, passed) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::timestamptz, 92.00, true)',
    completionId,
    completedEventId,
    riveraId,
    schoolId,
    lastQuarter.toISOString(),
  );
  // Auto-issue the matching cert (mirrors the runtime CompletionService
  // path so a clean re-seed lands the same shape as a live completion).
  const issuedAt = lastQuarter.toISOString().slice(0, 10);
  const expiresAt = new Date(lastQuarter);
  expiresAt.setMonth(expiresAt.getMonth() + 12);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_employee_certifications (id, employee_id, certification_type_id, school_id, ' +
      ' issued_at, expires_at, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, 'ACTIVE')",
    generateId(),
    riveraId,
    safeguardingTypeId,
    schoolId,
    issuedAt,
    expiresAt.toISOString().slice(0, 10),
  );
  console.log('  D. 1 completion (Rivera Safeguarding L1, score 92, auto-issued cert)');

  // --- E. 1 manual cert (Mitchell holds First Aid) ---
  const firstAidIssued = new Date(today);
  firstAidIssued.setMonth(firstAidIssued.getMonth() - 6);
  const firstAidExpires = new Date(firstAidIssued);
  firstAidExpires.setMonth(firstAidExpires.getMonth() + 36);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_employee_certifications (id, employee_id, certification_type_id, school_id, ' +
      ' issued_at, expires_at, reference_number, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6::date, $7, 'ACTIVE')",
    generateId(),
    mitchellId,
    firstAidTypeId,
    schoolId,
    firstAidIssued.toISOString().slice(0, 10),
    firstAidExpires.toISOString().slice(0, 10),
    'RC-2025-LIN-0042',
  );
  console.log('  E. 1 manual cert (Mitchell First Aid, Red Cross ref RC-2025-LIN-0042)');

  console.log('  done.');
}

seedTraining()
  .then(() => disconnectAll())
  .catch((err) => {
    console.error(err);
    return disconnectAll().then(() => {
      process.exit(1);
    });
  });
