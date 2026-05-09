import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { createCipheriv, createHmac, randomBytes, scryptSync } from 'crypto';
import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-visitors.ts — Phase 2 Cycle 1 (P2C1) Step 4.
 *
 * M90 Visitor Management. Idempotent — gated on whether
 * vis_visitor_types already has rows for the demo school.
 *
 * Sections:
 *   A) 4 visitor types — Parent (no safeguarding, blue), Contractor
 *      (safeguarding, amber), Guest Speaker (safeguarding, green),
 *      Volunteer (safeguarding, purple — links to platform_volunteer
 *      _profiles per ADR-032 once that table ships).
 *   B) 5 visitors with encrypted PII + HMAC blind index — 3
 *      returning parents (David Chen + 2 others), 1 contractor
 *      (Acme Maintenance), 1 guest speaker (Dr Patel).
 *   C) 1 sign-in settings row — require_purpose=true,
 *      auto_sign_out_hours=12, badge_template=STANDARD.
 *   D) 8 sign-ins — 3 currently on-site (signed_out_at IS NULL,
 *      drives the muster keystone) + 5 historical (completed
 *      sign-in/sign-out). Mix of safeguarding statuses including
 *      one BYPASSED_BY_ADMIN with reason populated.
 *   E) 1 pre-registration — guest speaker for Thursday's assembly,
 *      QR token generated via crypto.randomBytes, expires +14d.
 *   F) 1 recurring visitor — Acme Maintenance contractor on
 *      Tuesdays + Thursdays 8am-4pm, valid current month.
 *   G) 1 banned person — "John Doe" COURT_ORDER, name_hash
 *      computed from normalised "john doe" + DOB.
 *   H) 1 muster snapshot from a fire drill last week + 3
 *      entries (2 ACCOUNTED_FOR + 1 EVACUATED).
 */

const TENANT_SCHEMA = 'tenant_demo';

// AES-256-GCM helper that mirrors the Step 5 VisitorService
// encryption shape. Wire format: base64(iv).base64(tag).base64(ciphertext).
const SEED_KEY_MATERIAL = process.env.VISITOR_PII_KEY || 'campusos-demo-visitor-pii-key-2026';
const SEED_KEY_SALT = 'campusos-demo-visitor-salt';
const HMAC_SECRET = process.env.VISITOR_HMAC_SECRET || 'campusos-demo-visitor-hmac-secret-2026';

function deriveKey(): Buffer {
  return scryptSync(SEED_KEY_MATERIAL, SEED_KEY_SALT, 32);
}

function encryptPII(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', deriveKey(), iv);
  const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

// REVIEW-P2C1 MAJOR 1 — every blind index binds to schoolId. Mirrors
// apps/api/src/visitors/crypto.ts so seed + runtime produce identical
// hashes for the same (school, value) pair.
function emailHash(schoolId: string, email: string): string {
  const normalised = email.toLowerCase().trim();
  return createHmac('sha256', HMAC_SECRET)
    .update(schoolId + '|' + normalised)
    .digest('hex');
}

function phoneHash(schoolId: string, phone: string): string {
  const normalised = phone.replace(/[^0-9+]/g, '');
  return createHmac('sha256', HMAC_SECRET)
    .update(schoolId + '|' + normalised)
    .digest('hex');
}

// REVIEW-P2C1 MAJOR 3 — Unicode-aware name normalisation matches
// runtime crypto.normaliseNameComponent(): NFKD + diacritic strip +
// lowercase + punctuation strip + whitespace collapse.
function normaliseNameComponent(s: string): string {
  return s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function nameHash(schoolId: string, firstName: string, lastName: string, dob?: string): string {
  const first = normaliseNameComponent(firstName);
  const last = normaliseNameComponent(lastName);
  const fullName = (first + ' ' + last).trim();
  const material = schoolId + '|' + fullName + (dob ? '|' + dob : '');
  return createHmac('sha256', HMAC_SECRET).update(material).digest('hex');
}

function qrToken(): string {
  return randomBytes(32).toString('hex');
}

async function seedVisitors() {
  console.log('');
  console.log('  Visitor Management Seed (P2C1 Step 4)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.vis_visitor_types WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  vis_visitor_types already populated for demo school. Skipping.');
    return;
  }

  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT pu.id::text AS account_id, ip.id::text AS person_id ' +
        'FROM platform.platform_users pu ' +
        'JOIN platform.iam_person ip ON ip.id = pu.person_id ' +
        'WHERE pu.email = $1 LIMIT 1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('User not found: ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const principal = await findUserByEmail('principal@demo.campusos.dev');
  const teacher = await findUserByEmail('teacher@demo.campusos.dev');
  const vp = await findUserByEmail('vp@demo.campusos.dev');
  const parentChen = await findUserByEmail('parent@demo.campusos.dev');

  // ── Section A: visitor types ──
  const typeParent = generateId();
  const typeContractor = generateId();
  const typeSpeaker = generateId();
  const typeVolunteer = generateId();
  const visitorTypes = [
    { id: typeParent, name: 'Parent', requires: false, color: 'blue' },
    { id: typeContractor, name: 'Contractor', requires: true, color: 'amber' },
    { id: typeSpeaker, name: 'Guest Speaker', requires: true, color: 'green' },
    { id: typeVolunteer, name: 'Volunteer', requires: true, color: 'purple' },
  ];
  for (const vt of visitorTypes) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.vis_visitor_types (id, school_id, name, requires_safeguarding_check, badge_color) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5)',
      vt.id,
      schoolId,
      vt.name,
      vt.requires,
      vt.color,
    );
  }

  // ── Section B: 5 visitors (encrypted PII) ──
  const visParent1 = generateId();
  const visParent2 = generateId();
  const visParent3 = generateId();
  const visContractor = generateId();
  const visSpeaker = generateId();
  const visitors = [
    {
      id: visParent1,
      type: typeParent,
      first: 'David',
      last: 'Chen',
      company: null,
      email: 'david.chen.visitor@example.com',
      phone: '+12175550101',
    },
    {
      id: visParent2,
      type: typeParent,
      first: 'Patricia',
      last: 'Nguyen',
      company: null,
      email: 'patricia.nguyen@example.com',
      phone: '+12175550102',
    },
    {
      id: visParent3,
      type: typeParent,
      first: 'Marcus',
      last: 'Owen',
      company: null,
      email: 'marcus.owen@example.com',
      phone: '+12175550103',
    },
    {
      id: visContractor,
      type: typeContractor,
      first: 'Greg',
      last: 'Hayes',
      company: 'Acme Maintenance',
      email: 'greg@acme-maint.example.com',
      phone: '+12175550201',
    },
    {
      id: visSpeaker,
      type: typeSpeaker,
      first: 'Anita',
      last: 'Patel',
      company: 'Springfield Science Outreach',
      email: 'anita.patel@science-outreach.example.com',
      phone: '+12175550301',
    },
  ];
  for (const v of visitors) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.vis_visitors (id, school_id, visitor_type_id, first_name, last_name, company, email_encrypted, email_hash, phone_encrypted, phone_hash) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8, $9, $10)',
      v.id,
      schoolId,
      v.type,
      v.first,
      v.last,
      v.company,
      encryptPII(v.email),
      emailHash(schoolId, v.email),
      encryptPII(v.phone),
      phoneHash(schoolId, v.phone),
    );
  }

  // ── Section C: settings row ──
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_in_settings (id, school_id, require_photo_id, require_purpose, auto_sign_out_hours, safeguarding_provider, badge_template, kiosk_welcome_message) ' +
      'VALUES ($1::uuid, $2::uuid, false, true, 12, $3, $4, $5)',
    generateId(),
    schoolId,
    'Demo Safeguarding Service',
    'STANDARD',
    'Welcome to Lincoln Elementary',
  );

  // ── Section D: 8 sign-ins (3 active + 5 historical) ──
  // Active sign-ins (signed_out_at IS NULL) drive the muster keystone.
  const activeSignIn1 = generateId();
  const activeSignIn2 = generateId();
  const activeSignIn3 = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_ins (id, school_id, visitor_id, signed_in_at, host_id, purpose, safeguarding_check_status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '45 minutes', $4::uuid, $5, 'NOT_REQUIRED')",
    activeSignIn1,
    schoolId,
    visParent1,
    teacher.accountId,
    'Parent-teacher meeting about Maya',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_ins (id, school_id, visitor_id, signed_in_at, host_id, purpose, safeguarding_check_status, safeguarding_check_ref) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '90 minutes', $4::uuid, $5, 'PASSED', $6)",
    activeSignIn2,
    schoolId,
    visContractor,
    principal.accountId,
    'HVAC quarterly inspection',
    'DBS-2026-0451',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_ins (id, school_id, visitor_id, signed_in_at, host_id, purpose, safeguarding_check_status, safeguarding_check_ref) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '20 minutes', $4::uuid, $5, 'PASSED', $6)",
    activeSignIn3,
    schoolId,
    visSpeaker,
    principal.accountId,
    'Guest speaker — Grade 5 science assembly',
    'DBS-2026-0552',
  );

  // 5 historical sign-ins
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_ins (id, school_id, visitor_id, signed_in_at, signed_out_at, host_id, purpose, safeguarding_check_status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '7 days' - interval '4 hours', now() - interval '7 days' - interval '3 hours', $4::uuid, $5, 'NOT_REQUIRED')",
    generateId(),
    schoolId,
    visParent2,
    teacher.accountId,
    'IEP meeting',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_ins (id, school_id, visitor_id, signed_in_at, signed_out_at, host_id, purpose, safeguarding_check_status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '14 days' - interval '5 hours', now() - interval '14 days' - interval '4 hours', $4::uuid, $5, 'NOT_REQUIRED')",
    generateId(),
    schoolId,
    visParent3,
    teacher.accountId,
    'Pickup early for medical appointment',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_ins (id, school_id, visitor_id, signed_in_at, signed_out_at, host_id, purpose, safeguarding_check_status, safeguarding_check_ref) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '21 days' - interval '6 hours', now() - interval '21 days' - interval '4 hours', $4::uuid, $5, 'PASSED', $6)",
    generateId(),
    schoolId,
    visContractor,
    principal.accountId,
    'Boiler repair',
    'DBS-2026-0301',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_ins (id, school_id, visitor_id, signed_in_at, signed_out_at, host_id, purpose, safeguarding_check_status, safeguarding_check_ref, bypass_admin_id, bypass_reason) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '30 days' - interval '3 hours', now() - interval '30 days' - interval '2 hours', $4::uuid, $5, 'BYPASSED_BY_ADMIN', NULL, $6::uuid, $7)",
    generateId(),
    schoolId,
    visSpeaker,
    principal.accountId,
    'Career day talk — backup speaker urgent slot',
    principal.accountId,
    'Pre-vetted speaker from previous school visit; DBS check on file at sister school. Approved by principal.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_sign_ins (id, school_id, visitor_id, signed_in_at, signed_out_at, host_id, purpose, safeguarding_check_status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() - interval '45 days' - interval '2 hours', now() - interval '45 days' - interval '1 hour', $4::uuid, $5, 'NOT_REQUIRED')",
    generateId(),
    schoolId,
    visParent1,
    vp.accountId,
    'Discipline meeting follow-up',
  );

  // ── Section E: 1 pre-registration ──
  const preRegToken = qrToken();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_pre_registrations (id, school_id, visitor_id, expected_at, purpose, host_id, qr_code_token, expires_at, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, now() + interval '4 days', $4, $5::uuid, $6, now() + interval '14 days', $7::uuid)",
    generateId(),
    schoolId,
    visSpeaker,
    'Grade 5 science assembly',
    teacher.accountId,
    preRegToken,
    teacher.accountId,
  );
  console.log('  Seeded pre-registration QR token: ' + preRegToken.substring(0, 16) + '...');

  // ── Section F: 1 recurring visitor ──
  const accessSchedule = JSON.stringify({
    days: ['TUE', 'THU'],
    time_start: '08:00',
    time_end: '16:00',
  });
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_recurring_visitors (id, school_id, visitor_id, access_schedule, valid_from, valid_to, approved_by, notes) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::jsonb, date_trunc('month', now())::date, (date_trunc('month', now()) + interval '1 month' - interval '1 day')::date, $5::uuid, $6)",
    generateId(),
    schoolId,
    visContractor,
    accessSchedule,
    principal.accountId,
    'Weekly maintenance — boiler, HVAC, electrical',
  );

  // ── Section G: 1 banned person ──
  const bannedDob = '1985-03-12';
  const bannedNameHash = nameHash(schoolId, 'John', 'Doe', bannedDob);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_banned_persons (id, school_id, first_name, last_name, date_of_birth, name_hash, ban_reason, ban_type, ban_order_s3_key, added_by, last_reviewed_at, is_active, effective_from) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, $6, $7, 'COURT_ORDER', $8, $9::uuid, CURRENT_DATE - interval '60 days', true, '2025-01-15')",
    generateId(),
    schoolId,
    'John',
    'Doe',
    bannedDob,
    bannedNameHash,
    'Court-issued protection order against contact with school community. Effective indefinitely.',
    'docs/safeguarding/court-order-2025-0001.pdf',
    principal.accountId,
  );

  // ── Section H: 1 muster snapshot from last week's fire drill ──
  // Snapshot was taken at the moment the alarm sounded; 3 visitors
  // were on-site at the time. 2 ACCOUNTED_FOR + 1 EVACUATED.
  // Use 3 of the historical sign-ins as the snapshot rows.
  const musterId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_emergency_muster (id, school_id, drill_type, description, created_by, total_on_site_at_snapshot, closed_at, closed_by, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, 'FIRE_DRILL', $3, $4::uuid, 3, now() - interval '7 days' + interval '15 minutes', $5::uuid, now() - interval '7 days')",
    musterId,
    schoolId,
    'Quarterly fire drill — Building A. Three visitors on-site.',
    principal.accountId,
    principal.accountId,
  );

  // 3 muster entries — referencing the 3 active sign-ins (which would
  // have been on-site at the time the historical drill ran).
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_muster_entries (id, muster_id, sign_in_id, visitor_name, visitor_type, visitor_company, building, status, marked_by, marked_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'David Chen', 'Parent', NULL, 'Main Building', 'ACCOUNTED_FOR', $4::uuid, now() - interval '7 days' + interval '8 minutes')",
    generateId(),
    musterId,
    activeSignIn1,
    principal.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_muster_entries (id, muster_id, sign_in_id, visitor_name, visitor_type, visitor_company, building, status, marked_by, marked_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Greg Hayes', 'Contractor', 'Acme Maintenance', 'Boiler Room', 'EVACUATED', $4::uuid, now() - interval '7 days' + interval '12 minutes')",
    generateId(),
    musterId,
    activeSignIn2,
    principal.accountId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.vis_muster_entries (id, muster_id, sign_in_id, visitor_name, visitor_type, visitor_company, building, status, marked_by, marked_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'Anita Patel', 'Guest Speaker', 'Springfield Science Outreach', 'Main Hall', 'ACCOUNTED_FOR', $4::uuid, now() - interval '7 days' + interval '14 minutes')",
    generateId(),
    musterId,
    activeSignIn3,
    principal.accountId,
  );

  // Suppress unused var warning — parentChen is reserved for future
  // visitor-as-parent linkage when M90.5 unifies the Cycle 6.1
  // platform_family_members table with vis_visitors.email_hash.
  void parentChen;

  console.log('  Seeded 4 visitor types, 5 visitors, 8 sign-ins (3 active + 5 historical),');
  console.log('  1 pre-registration, 1 recurring visitor, 1 banned person,');
  console.log('  1 muster snapshot + 3 entries (2 ACCOUNTED_FOR + 1 EVACUATED).');
}

async function main(): Promise<void> {
  try {
    await seedVisitors();
  } finally {
    await disconnectAll();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
