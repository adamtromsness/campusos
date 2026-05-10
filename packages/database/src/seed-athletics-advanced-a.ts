import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-athletics-advanced-a.ts — Phase 2 Cycle 8 (P2-8) sub-cycle a Step 2.
 *
 * Idempotent. Gated on whether ath_equipment has any rows for the demo
 * school. Re-running is a no-op once the seed has landed.
 *
 * Sections covering all 9 P2-8a tables:
 *   A) 10 ath_equipment rows across the Basketball + Track programmes
 *      (5 each). Mix of UNIFORM, GAME_EQUIPMENT, PROTECTIVE_GEAR,
 *      TRAINING_EQUIPMENT, MEDICAL_EQUIPMENT.
 *   B) 5 ath_equipment_checkouts — 3 ACTIVE (returned_at NULL),
 *      1 RETURNED GOOD condition, 1 RETURNED DAMAGED with
 *      replacement_charge populated demonstrating the damage path.
 *   C) 4 ath_safety_equipment rows for the Maya VARSITY member —
 *      HELMET (issued + certified), MOUTHGUARD (issued + certified),
 *      PADS (issued + certification expired — drives the amber row),
 *      SHIN_GUARDS (not issued).
 *   D) 1 ath_conferences row "Kansas 4A" Basketball KS-EAST.
 *   E) 3 ath_conference_memberships — Lincoln Academy + 2 placeholder
 *      cross-school UUIDs (synthetic schools for the schedule demo).
 *   F) 4 ath_conference_schedules cross-school games for the Basketball
 *      season.
 *   G) 3 ath_team_photos for the VARSITY roster (TEAM_PHOTO + 2
 *      ACTION_SHOT).
 *   H) 5 ath_media_assets across the 4 asset types (PHOTO, VIDEO,
 *      DOCUMENT, LOGO).
 *   I) 2 ath_equipment_maintenance rows (1 CLEANING, 1 REPAIR with
 *      cost) on the Basketball uniform set.
 *
 * No new permissions — ATH-001..005 are already in the catalogue and
 * the existing Cycle 13 IAM seed grants Teacher + Student ATH-004:read,
 * and Staff (AD) ATH-001..005 read+write+admin via everyFunction on
 * School Admin.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedAthleticsAdvancedA() {
  console.log('');
  console.log('  Athletics Advanced Seed — Sub-cycle a (P2-8a Step 2)');
  console.log('');

  const client = getPlatformClient();

  // ── 1. School + lookups ───────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  // Idempotency gate
  const existing = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' + TENANT_SCHEMA + '.ath_equipment WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0] && existing[0].c > 0) {
    console.log('  ath_equipment already populated for demo school — skipping');
    await disconnectAll();
    return;
  }

  // Resolve programmes + roster_member for FK targets
  const progs = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, sport_name FROM ' +
      TENANT_SCHEMA +
      '.ath_programmes WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ id: string; sport_name: string }>;
  if (progs.length === 0) throw new Error('ath_programmes empty — run pnpm seed:athletics first');
  const basketballId = progs.find((p) => p.sport_name === 'Basketball')?.id;
  const trackId = progs.find((p) => p.sport_name === 'Track & Field')?.id;
  if (!basketballId || !trackId) throw new Error('Basketball or Track & Field programme missing');

  // Resolve VARSITY roster + Maya membership
  const rosters = (await client.$queryRawUnsafe(
    'SELECT r.id::text AS id, r.level AS level FROM ' +
      TENANT_SCHEMA +
      '.ath_rosters r JOIN ' +
      TENANT_SCHEMA +
      '.ath_seasons s ON s.id = r.season_id WHERE s.programme_id = $1::uuid',
    basketballId,
  )) as Array<{ id: string; level: string }>;
  const varsityRosterId = rosters.find((r) => r.level === 'VARSITY')?.id;
  if (!varsityRosterId) throw new Error('VARSITY roster missing for Basketball');

  const mayaMember = (await client.$queryRawUnsafe(
    'SELECT m.id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.ath_roster_members m JOIN ' +
      TENANT_SCHEMA +
      '.sis_students s ON s.id = m.student_id JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person p ON p.id = ps.person_id WHERE m.roster_id = $1::uuid AND p.first_name = $2 AND p.last_name = $3',
    varsityRosterId,
    'Maya',
    'Chen',
  )) as Array<{ id: string }>;
  if (mayaMember.length === 0) throw new Error('Maya VARSITY roster_member row missing');
  const mayaMemberId = mayaMember[0]!.id;

  // Resolve a person_id for checkout assignments — Maya's iam_person.id
  const mayaPerson = (await client.$queryRawUnsafe(
    'SELECT p.id::text AS id FROM platform.iam_person p WHERE p.first_name = $1 AND p.last_name = $2',
    'Maya',
    'Chen',
  )) as Array<{ id: string }>;
  const mayaPersonId = mayaPerson[0]!.id;

  // Resolve Ethan iam_person for additional checkout
  const ethanPerson = (await client.$queryRawUnsafe(
    'SELECT p.id::text AS id FROM platform.iam_person p WHERE p.first_name = $1 AND p.last_name = $2',
    'Ethan',
    'Rodriguez',
  )) as Array<{ id: string }>;
  const ethanPersonId = ethanPerson[0]!.id;

  // Aiden iam_person
  const aidenPerson = (await client.$queryRawUnsafe(
    'SELECT p.id::text AS id FROM platform.iam_person p WHERE p.first_name = $1 AND p.last_name = $2',
    'Aiden',
    'Johnson',
  )) as Array<{ id: string }>;
  const aidenPersonId = aidenPerson[0]!.id;

  // Resolve a Basketball season for media + conference schedule
  const seasons = (await client.$queryRawUnsafe(
    'SELECT id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.ath_seasons WHERE programme_id = $1::uuid LIMIT 1',
    basketballId,
  )) as Array<{ id: string }>;
  const seasonId = seasons[0]!.id;

  // Resolve principal employee (Mitchell) as uploader
  const principal = (await client.$queryRawUnsafe(
    'SELECT p.id::text AS person_id FROM platform.iam_person p JOIN platform.platform_users u ON u.person_id = p.id WHERE u.email = $1',
    'principal@demo.campusos.dev',
  )) as Array<{ person_id: string }>;
  const principalPersonId = principal[0]!.person_id;

  // ── A) 10 ath_equipment ────────────────────────────────────────
  console.log('  A) 10 equipment rows across Basketball + Track');
  const eq: Record<string, string> = {};
  const equipmentSeed: Array<{
    key: string;
    progId: string;
    item_type: string;
    item_name: string;
    quantity: number;
    condition: string;
    unit_cost: number | null;
  }> = [
    {
      key: 'bb_jersey',
      progId: basketballId,
      item_type: 'UNIFORM',
      item_name: 'Home Jersey Set',
      quantity: 15,
      condition: 'GOOD',
      unit_cost: 65.0,
    },
    {
      key: 'bb_short',
      progId: basketballId,
      item_type: 'UNIFORM',
      item_name: 'Home Shorts Set',
      quantity: 15,
      condition: 'GOOD',
      unit_cost: 45.0,
    },
    {
      key: 'bb_ball',
      progId: basketballId,
      item_type: 'GAME_EQUIPMENT',
      item_name: 'Game Basketball',
      quantity: 6,
      condition: 'EXCELLENT',
      unit_cost: 80.0,
    },
    {
      key: 'bb_warmup',
      progId: basketballId,
      item_type: 'UNIFORM',
      item_name: 'Warmup Jacket',
      quantity: 15,
      condition: 'FAIR',
      unit_cost: 95.0,
    },
    {
      key: 'bb_kit',
      progId: basketballId,
      item_type: 'MEDICAL_EQUIPMENT',
      item_name: 'Sideline First Aid Kit',
      quantity: 2,
      condition: 'GOOD',
      unit_cost: 120.0,
    },
    {
      key: 'tk_singlet',
      progId: trackId,
      item_type: 'UNIFORM',
      item_name: 'Track Singlet',
      quantity: 20,
      condition: 'GOOD',
      unit_cost: 35.0,
    },
    {
      key: 'tk_short',
      progId: trackId,
      item_type: 'UNIFORM',
      item_name: 'Track Shorts',
      quantity: 20,
      condition: 'GOOD',
      unit_cost: 30.0,
    },
    {
      key: 'tk_baton',
      progId: trackId,
      item_type: 'GAME_EQUIPMENT',
      item_name: 'Relay Baton',
      quantity: 8,
      condition: 'EXCELLENT',
      unit_cost: 12.0,
    },
    {
      key: 'tk_block',
      progId: trackId,
      item_type: 'TRAINING_EQUIPMENT',
      item_name: 'Starting Block',
      quantity: 8,
      condition: 'GOOD',
      unit_cost: 150.0,
    },
    {
      key: 'tk_bag',
      progId: trackId,
      item_type: 'OTHER',
      item_name: 'Equipment Bag',
      quantity: 5,
      condition: 'POOR',
      unit_cost: 50.0,
    },
  ];

  for (const e of equipmentSeed) {
    const id = generateId();
    eq[e.key] = id;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.ath_equipment (id, school_id, programme_id, item_type, item_name, quantity, condition, purchase_date, unit_cost) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::date, $9)',
      id,
      schoolId,
      e.progId,
      e.item_type,
      e.item_name,
      e.quantity,
      e.condition,
      '2024-08-15',
      e.unit_cost,
    );
  }

  // ── B) 5 ath_equipment_checkouts ──────────────────────────────
  console.log('  B) 5 checkouts (3 active, 1 returned GOOD, 1 returned DAMAGED with charge)');
  // Active 1 — Maya jersey #23
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_equipment_checkouts (id, equipment_id, assigned_to_person_id, item_identifier, checked_out_at, expected_return_date) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date)',
    generateId(),
    eq.bb_jersey,
    mayaPersonId,
    'JERSEY-23',
    '2025-11-01',
    '2026-03-15',
  );
  // Active 2 — Ethan jersey #11
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_equipment_checkouts (id, equipment_id, assigned_to_person_id, item_identifier, checked_out_at, expected_return_date) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date)',
    generateId(),
    eq.bb_jersey,
    ethanPersonId,
    'JERSEY-11',
    '2025-11-01',
    '2026-03-15',
  );
  // Active 3 — Aiden warmup
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_equipment_checkouts (id, equipment_id, assigned_to_person_id, item_identifier, checked_out_at, expected_return_date) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date)',
    generateId(),
    eq.bb_warmup,
    aidenPersonId,
    'WARMUP-15',
    '2025-11-01',
    '2026-03-15',
  );
  // Returned GOOD — Aiden warmup last season
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_equipment_checkouts (id, equipment_id, assigned_to_person_id, item_identifier, checked_out_at, expected_return_date, returned_at, condition_at_return) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7::date, $8)',
    generateId(),
    eq.bb_short,
    mayaPersonId,
    'SHORTS-23',
    '2024-11-01',
    '2025-03-15',
    '2025-03-12',
    'GOOD',
  );
  // Returned DAMAGED — Ethan warmup with replacement_charge
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_equipment_checkouts (id, equipment_id, assigned_to_person_id, item_identifier, checked_out_at, expected_return_date, returned_at, condition_at_return, damage_notes, replacement_charge) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::date, $6::date, $7::date, $8, $9, $10)',
    generateId(),
    eq.bb_warmup,
    ethanPersonId,
    'WARMUP-11',
    '2024-11-01',
    '2025-03-15',
    '2025-03-12',
    'DAMAGED',
    'Torn at left shoulder, zipper broken',
    95.0,
  );

  // ── C) 4 ath_safety_equipment for Maya VARSITY ────────────────
  console.log('  C) 4 safety equipment rows for Maya VARSITY');
  // HELMET — issued + certified
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_safety_equipment (id, roster_member_id, equipment_type, issued, meets_safety_standard, certification_date, certification_expiry, recall_status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, true, true, $4::date, $5::date, false)',
    generateId(),
    mayaMemberId,
    'HELMET',
    '2025-09-01',
    '2026-09-01',
  );
  // MOUTHGUARD — issued + certified
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_safety_equipment (id, roster_member_id, equipment_type, issued, meets_safety_standard, certification_date, certification_expiry, recall_status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, true, true, $4::date, $5::date, false)',
    generateId(),
    mayaMemberId,
    'MOUTHGUARD',
    '2025-09-01',
    '2026-09-01',
  );
  // PADS — issued but expired certification (the amber row)
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_safety_equipment (id, roster_member_id, equipment_type, issued, meets_safety_standard, certification_date, certification_expiry, recall_status, notes) ' +
      'VALUES ($1::uuid, $2::uuid, $3, true, true, $4::date, $5::date, false, $6)',
    generateId(),
    mayaMemberId,
    'PADS',
    '2024-08-01',
    '2025-08-01',
    'Certification expired — needs re-inspection before next game',
  );
  // SHIN_GUARDS — not yet issued
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_safety_equipment (id, roster_member_id, equipment_type, issued, meets_safety_standard) ' +
      'VALUES ($1::uuid, $2::uuid, $3, false, true)',
    generateId(),
    mayaMemberId,
    'SHIN_GUARDS',
  );

  // ── D) 1 ath_conferences ──────────────────────────────────────
  console.log('  D) 1 conference: Kansas 4A Basketball');
  const confId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_conferences (id, name, sport, region, governing_body, is_active) ' +
      'VALUES ($1::uuid, $2, $3, $4, $5, true)',
    confId,
    'Kansas 4A',
    'Basketball',
    'KS-EAST',
    'KSHSAA',
  );

  // ── E) 3 ath_conference_memberships ───────────────────────────
  console.log('  E) 3 conference memberships (Lincoln + 2 synthetic schools)');
  const synthSchoolA = '019df111-0000-7000-8000-000000a00001';
  const synthSchoolB = '019df111-0000-7000-8000-000000a00002';
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_conference_memberships (id, conference_id, school_id, programme_id, joined_date, level, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, true)',
    generateId(),
    confId,
    schoolId,
    basketballId,
    '2024-08-01',
    'D1',
  );
  // Synthetic schools: programme_id reuses Lincoln basketball as a placeholder
  // (cross-tenant programme refs are out of P2-8a scope per the plan).
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_conference_memberships (id, conference_id, school_id, programme_id, joined_date, level, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, true)',
    generateId(),
    confId,
    synthSchoolA,
    basketballId,
    '2024-08-01',
    'D1',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_conference_memberships (id, conference_id, school_id, programme_id, joined_date, level, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::date, $6, true)',
    generateId(),
    confId,
    synthSchoolB,
    basketballId,
    '2024-08-01',
    'D1',
  );

  // ── F) 4 ath_conference_schedules ─────────────────────────────
  console.log('  F) 4 conference schedule slots');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_conference_schedules (id, conference_id, season_id, home_school_id, away_school_id, scheduled_date, scheduled_time) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::time)',
    generateId(),
    confId,
    seasonId,
    schoolId,
    synthSchoolA,
    '2026-01-12',
    '19:00',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_conference_schedules (id, conference_id, season_id, home_school_id, away_school_id, scheduled_date, scheduled_time) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::time)',
    generateId(),
    confId,
    seasonId,
    synthSchoolA,
    schoolId,
    '2026-01-26',
    '18:30',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_conference_schedules (id, conference_id, season_id, home_school_id, away_school_id, scheduled_date, scheduled_time) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::time)',
    generateId(),
    confId,
    seasonId,
    schoolId,
    synthSchoolB,
    '2026-02-09',
    '19:00',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_conference_schedules (id, conference_id, season_id, home_school_id, away_school_id, scheduled_date, scheduled_time) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::date, $7::time)',
    generateId(),
    confId,
    seasonId,
    synthSchoolB,
    schoolId,
    '2026-02-23',
    '18:30',
  );

  // ── G) 3 ath_team_photos ──────────────────────────────────────
  console.log('  G) 3 team photos for VARSITY roster');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_team_photos (id, roster_id, photo_type, s3_key, caption, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
    generateId(),
    varsityRosterId,
    'TEAM_PHOTO',
    's3://campusos-demo/athletics/varsity-team-2025-2026.jpg',
    '2025-2026 VARSITY Basketball — Team Photo',
    principalPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_team_photos (id, roster_id, photo_type, s3_key, caption, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
    generateId(),
    varsityRosterId,
    'ACTION_SHOT',
    's3://campusos-demo/athletics/maya-game-1-action.jpg',
    'Maya driving the lane vs Jefferson — Game 1',
    principalPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_team_photos (id, roster_id, photo_type, s3_key, caption, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::uuid)',
    generateId(),
    varsityRosterId,
    'ACTION_SHOT',
    's3://campusos-demo/athletics/ethan-rebound-game-2.jpg',
    'Ethan rebounds — Game 2 vs Washington',
    principalPersonId,
  );

  // ── H) 5 ath_media_assets ─────────────────────────────────────
  console.log('  H) 5 media assets across PHOTO/VIDEO/DOCUMENT/LOGO');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_media_assets (id, school_id, programme_id, asset_type, s3_key, title, description, season_id, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::uuid)',
    generateId(),
    schoolId,
    basketballId,
    'LOGO',
    's3://campusos-demo/athletics/basketball-logo.svg',
    'Basketball Logo',
    'School-approved Basketball programme logo',
    seasonId,
    principalPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_media_assets (id, school_id, programme_id, asset_type, s3_key, title, description, season_id, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::uuid)',
    generateId(),
    schoolId,
    basketballId,
    'PHOTO',
    's3://campusos-demo/athletics/varsity-roster-portraits.jpg',
    'VARSITY Roster Portraits',
    'Individual headshots for the 2025-2026 VARSITY roster',
    seasonId,
    principalPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_media_assets (id, school_id, programme_id, asset_type, s3_key, title, description, season_id, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::uuid)',
    generateId(),
    schoolId,
    basketballId,
    'VIDEO',
    's3://campusos-demo/athletics/game-1-vs-jefferson.mp4',
    'Game 1 vs Jefferson — Full Game',
    'Game 1 Basketball recording — Lincoln 52 Jefferson 48',
    seasonId,
    principalPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_media_assets (id, school_id, programme_id, asset_type, s3_key, title, description, season_id, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9::uuid)',
    generateId(),
    schoolId,
    basketballId,
    'DOCUMENT',
    's3://campusos-demo/athletics/season-handbook-2025-2026.pdf',
    'Season Handbook 2025-2026',
    'Player handbook with rules, expectations, and travel info',
    seasonId,
    principalPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_media_assets (id, school_id, programme_id, asset_type, s3_key, title, description, uploaded_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid)',
    generateId(),
    schoolId,
    trackId,
    'LOGO',
    's3://campusos-demo/athletics/track-logo.svg',
    'Track & Field Logo',
    'School-approved Track & Field programme logo',
    principalPersonId,
  );

  // ── I) 2 ath_equipment_maintenance ────────────────────────────
  console.log('  I) 2 maintenance records');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_equipment_maintenance (id, equipment_id, maintenance_type, performed_at, performed_by, cost, notes, next_maintenance_date) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::date)',
    generateId(),
    eq.bb_jersey,
    'CLEANING',
    '2025-12-15',
    'Springfield Cleaners',
    35.0,
    'Mid-season uniform deep clean',
    '2026-02-01',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_equipment_maintenance (id, equipment_id, maintenance_type, performed_at, performed_by, cost, notes, next_maintenance_date) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5, $6, $7, $8::date)',
    generateId(),
    eq.bb_warmup,
    'REPAIR',
    '2026-03-15',
    'In-house — Coach Rivera',
    25.0,
    'Replaced zipper on warmup #11 after damage report',
    '2026-09-01',
  );

  console.log('');
  console.log('  Athletics Advanced Seed (P2-8a) complete.');
  console.log('');

  await disconnectAll();
}

seedAthleticsAdvancedA().catch((e) => {
  console.error(e);
  process.exit(1);
});
