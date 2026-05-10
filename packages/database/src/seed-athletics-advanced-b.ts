import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-athletics-advanced-b.ts — Phase 2 Cycle 8 (P2-8) sub-cycle b Step 4.
 *
 * Idempotent. Gated on whether platform.platform_official_profiles has any
 * rows. Re-running is a no-op once the seed has landed.
 *
 * Sections covering all 9 P2-8b tables (7 tenant + 2 platform):
 *   A) 3 platform_official_profiles — referees portable across schools
 *      (Karen Wright HS Basketball certified; Robert Thompson Football
 *      certified; Maria Sanchez Soccer certified).
 *   B) 6 platform_official_availability rows (2 per official) covering
 *      future game dates the demo basketball season needs.
 *   C) 2 ath_game_streams — one ENDED with recording_s3_key + recording
 *      duration, one SCHEDULED for an upcoming game.
 *   D) 3 ath_highlight_clips — 1 CONSENTED + added_to_portfolio (Maya
 *      drives the layup at 02:35), 1 PENDING consent (Maya assist at
 *      05:12), 1 DECLINED consent (Ethan strip-steal at 11:02 — student
 *      declined publication).
 *   E) 2 ath_game_recordings — 1 FULL_GAME + 1 COACHES_FILM for the same
 *      ENDED stream's parent game.
 *   F) 4 ath_official_assignments — 1 POSTED, 1 ACCEPTED, 1 COMPLETED, 1
 *      NO_SHOW. Each row exercises a different lifecycle terminal so the
 *      Step 4 service's transition guards have rows to read against.
 *   G) 2 ath_official_ratings — 1 SCHOOL_RATES_OFFICIAL (overall=4) +
 *      1 OFFICIAL_RATES_SCHOOL (overall=5) on the COMPLETED assignment.
 *   H) 2 ath_recruiting_profiles — Maya Chen (basketball, grad year 2027,
 *      is_published=true with gpa snapshot) + Ethan Rodriguez (basketball,
 *      grad year 2027, draft).
 *   I) 3 ath_recruiting_interests — 2 on Maya (KU EXPLORING + KSU
 *      INTERESTED), 1 on Ethan (Pittsburg State EXPLORING).
 *
 * No new permissions — ATH-001..005 are already in the catalogue and the
 * existing Cycle 13 IAM seed covers them. ATH-005 (Athletic Streaming) is
 * granted to Staff (covers AD) plus the Cycle 13 admin tier via everyFunction.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedAthleticsAdvancedB() {
  console.log('');
  console.log('  Athletics Advanced Seed — Sub-cycle b (P2-8b Step 4)');
  console.log('');

  const client = getPlatformClient();

  // ── 1. School + lookups ───────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');

  // Idempotency gate
  const existing = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM platform.platform_official_profiles',
  )) as Array<{ c: number }>;
  if (existing[0] && existing[0].c > 0) {
    console.log('  platform_official_profiles already populated — skipping');
    await disconnectAll();
    return;
  }

  // Resolve a game we can hang the streams on — pick a COMPLETED basketball game
  // and a SCHEDULED basketball game from the seed.
  const games = (await client.$queryRawUnsafe(
    'SELECT g.id::text AS id, g.status, g.game_date::text AS game_date FROM ' +
      TENANT_SCHEMA +
      '.ath_games g ORDER BY g.game_date DESC LIMIT 5',
  )) as Array<{ id: string; status: string; game_date: string }>;
  if (games.length < 2) throw new Error('Need at least 2 ath_games rows for the demo seed');
  const completedGame = games.find((g) => g.status === 'COMPLETED');
  const scheduledGame = games.find((g) => g.status === 'SCHEDULED');
  if (!completedGame || !scheduledGame) {
    throw new Error('Demo seed expects 1 COMPLETED + 1 SCHEDULED basketball game from Cycle 13');
  }

  // Resolve Maya + Ethan students for clips + recruiting profiles
  const mayaStudent = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person p ON p.id = ps.person_id WHERE p.first_name = $1 AND p.last_name = $2',
    'Maya',
    'Chen',
  )) as Array<{ id: string }>;
  const ethanStudent = (await client.$queryRawUnsafe(
    'SELECT s.id::text AS id FROM ' +
      TENANT_SCHEMA +
      '.sis_students s JOIN platform.platform_students ps ON ps.id = s.platform_student_id JOIN platform.iam_person p ON p.id = ps.person_id WHERE p.first_name = $1 AND p.last_name = $2',
    'Ethan',
    'Rodriguez',
  )) as Array<{ id: string }>;
  if (mayaStudent.length === 0 || ethanStudent.length === 0) {
    throw new Error('Maya or Ethan student row missing — run pnpm seed:sis first');
  }
  const mayaStudentId = mayaStudent[0]!.id;
  const ethanStudentId = ethanStudent[0]!.id;

  // Resolve admin person id for configured_by + uploaded_by
  const adminPerson = (await client.$queryRawUnsafe(
    'SELECT p.id::text AS id FROM platform.iam_person p WHERE p.first_name = $1 AND p.last_name = $2',
    'Sarah',
    'Mitchell',
  )) as Array<{ id: string }>;
  if (adminPerson.length === 0) throw new Error('Sarah Mitchell person row missing');
  const adminPersonId = adminPerson[0]!.id;

  // ── A. Officials (platform schema) ────────────────────────────

  console.log('  A. Creating 3 platform official profiles');

  // Synthetic iam_person rows for the 3 officials so the JOIN to platform.iam_person
  // surfaces a name in the marketplace browse UI. The plan does not require these
  // to have platform user accounts (the official-self-service onboarding is a
  // Phase 2 carry-over per the plan).
  const officialPersonIds: Record<string, string> = {};
  for (const [first, last] of [
    ['Karen', 'Wright'],
    ['Robert', 'Thompson'],
    ['Maria', 'Sanchez'],
  ]) {
    const existing = (await client.$queryRawUnsafe(
      'SELECT id::text AS id FROM platform.iam_person WHERE first_name = $1 AND last_name = $2',
      first,
      last,
    )) as Array<{ id: string }>;
    if (existing.length > 0) {
      officialPersonIds[first + ' ' + last] = existing[0]!.id;
      continue;
    }
    const personId = generateId();
    await client.$executeRawUnsafe(
      "INSERT INTO platform.iam_person (id, first_name, last_name, person_type) VALUES ($1::uuid, $2, $3, 'STAFF')",
      personId,
      first,
      last,
    );
    officialPersonIds[first + ' ' + last] = personId;
  }

  const karenProfileId = generateId();
  const robertProfileId = generateId();
  const mariaProfileId = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO platform.platform_official_profiles (id, person_id, sports, certification_level, certification_body, certification_expiry, years_experience, max_travel_miles, base_fee, is_available, bio, contact_email) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12)',
    karenProfileId,
    officialPersonIds['Karen Wright'],
    ['BASKETBALL', 'VOLLEYBALL'],
    'IAABO Level 2',
    'Kansas High School Activities Association',
    '2027-08-01',
    12,
    50,
    75.0,
    true,
    '12 years officiating Kansas 4A and 5A basketball. Certified IAABO Level 2.',
    'karen.wright@example.com',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO platform.platform_official_profiles (id, person_id, sports, certification_level, certification_body, certification_expiry, years_experience, max_travel_miles, base_fee, is_available, bio, contact_email) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12)',
    robertProfileId,
    officialPersonIds['Robert Thompson'],
    ['FOOTBALL'],
    'KHSAA Certified',
    'Kansas High School Activities Association',
    '2026-08-01',
    8,
    75,
    150.0,
    true,
    'High school football head referee since 2018. Specializes in Kansas Class 4A.',
    'robert.thompson@example.com',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO platform.platform_official_profiles (id, person_id, sports, certification_level, certification_body, certification_expiry, years_experience, max_travel_miles, base_fee, is_available, bio, contact_email) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6::date, $7, $8, $9, $10, $11, $12)',
    mariaProfileId,
    officialPersonIds['Maria Sanchez'],
    ['SOCCER'],
    'NFHS Level 6',
    'NFHS',
    '2027-12-31',
    15,
    100,
    125.0,
    false,
    'NFHS Level 6 soccer official. Currently on injury leave through end of season.',
    'maria.sanchez@example.com',
  );

  // ── B. Availability ──────────────────────────────────────────
  console.log('  B. Creating 6 official availability rows');
  const futureDates = [
    ['2026-12-15', '17:00:00', '21:00:00'],
    ['2026-12-22', '17:00:00', '21:00:00'],
    ['2026-09-12', '19:00:00', '22:00:00'],
    ['2026-09-19', '19:00:00', '22:00:00'],
    ['2026-10-05', '15:00:00', '18:00:00'],
    ['2026-10-12', '15:00:00', '18:00:00'],
  ];
  const profileForRow = [
    karenProfileId,
    karenProfileId,
    robertProfileId,
    robertProfileId,
    mariaProfileId,
    mariaProfileId,
  ];
  for (let i = 0; i < futureDates.length; i++) {
    await client.$executeRawUnsafe(
      'INSERT INTO platform.platform_official_availability (id, official_profile_id, available_date, start_time, end_time, is_available) ' +
        'VALUES ($1::uuid, $2::uuid, $3::date, $4::time, $5::time, true)',
      generateId(),
      profileForRow[i],
      futureDates[i]![0],
      futureDates[i]![1],
      futureDates[i]![2],
    );
  }

  // ── C. Game streams ──────────────────────────────────────────
  console.log('  C. Creating 2 game streams');
  const endedStreamId = generateId();
  const scheduledStreamId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_game_streams (id, game_id, stream_url, stream_status, access_level, recording_s3_key, recording_duration_seconds, configured_by, started_at, ended_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'ENDED', 'PUBLIC', $4, 7320, $5::uuid, now() - interval '14 days', now() - interval '14 days' + interval '2 hours 2 minutes')",
    endedStreamId,
    completedGame.id,
    'https://stream.demo.campusos.dev/g/' + completedGame.id,
    's3://campusos-recordings/demo/' + completedGame.id + '/full.mp4',
    adminPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_game_streams (id, game_id, stream_url, stream_status, access_level, configured_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3, 'SCHEDULED', 'BOTH_SCHOOLS', $4::uuid)",
    scheduledStreamId,
    scheduledGame.id,
    'https://stream.demo.campusos.dev/g/' + scheduledGame.id,
    adminPersonId,
  );

  // ── D. Highlight clips ───────────────────────────────────────
  console.log('  D. Creating 3 highlight clips');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_highlight_clips (id, stream_id, student_id, start_time_seconds, end_time_seconds, title, s3_key, added_to_portfolio, consent_status, consent_recorded_at, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 155, 168, 'Drive layup', $4, true, 'CONSENTED', now() - interval '12 days', $5::uuid)",
    generateId(),
    endedStreamId,
    mayaStudentId,
    's3://campusos-clips/demo/maya-drive-layup.mp4',
    adminPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_highlight_clips (id, stream_id, student_id, start_time_seconds, end_time_seconds, title, s3_key, added_to_portfolio, consent_status, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 312, 326, 'Assist on baseline', $4, false, 'PENDING', $5::uuid)",
    generateId(),
    endedStreamId,
    mayaStudentId,
    's3://campusos-clips/demo/maya-assist-baseline.mp4',
    adminPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_highlight_clips (id, stream_id, student_id, start_time_seconds, end_time_seconds, title, s3_key, added_to_portfolio, consent_status, consent_recorded_at, created_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 660, 678, 'Strip steal', $4, false, 'DECLINED', now() - interval '11 days', $5::uuid)",
    generateId(),
    endedStreamId,
    ethanStudentId,
    's3://campusos-clips/demo/ethan-strip-steal.mp4',
    adminPersonId,
  );

  // ── E. Game recordings ───────────────────────────────────────
  console.log('  E. Creating 2 game recordings');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_game_recordings (id, game_id, recording_type, s3_key, duration_seconds, title, uploaded_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'FULL_GAME', $3, 7320, 'Full game vs Topeka High', $4::uuid)",
    generateId(),
    completedGame.id,
    's3://campusos-recordings/demo/' + completedGame.id + '/full.mp4',
    adminPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_game_recordings (id, game_id, recording_type, s3_key, duration_seconds, title, uploaded_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'COACHES_FILM', $3, 7320, 'Coaches film vs Topeka High — full all-22', $4::uuid)",
    generateId(),
    completedGame.id,
    's3://campusos-recordings/demo/' + completedGame.id + '/coaches-film.mp4',
    adminPersonId,
  );

  // ── F. Official assignments ──────────────────────────────────
  console.log('  F. Creating 4 official assignments');
  const completedAssignmentId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_official_assignments (id, game_id, official_profile_id, role, fee, status, payment_status, accepted_at, confirmed_at, completed_at, assigned_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_REFEREE', 75.00, 'COMPLETED', 'PROCESSED', now() - interval '20 days', now() - interval '15 days', now() - interval '14 days', $4::uuid)",
    completedAssignmentId,
    completedGame.id,
    karenProfileId,
    adminPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_official_assignments (id, game_id, official_profile_id, role, fee, status, payment_status, accepted_at, confirmed_at, assigned_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'HEAD_REFEREE', 75.00, 'CONFIRMED', 'PENDING', now() - interval '5 days', now() - interval '4 days', $4::uuid)",
    generateId(),
    scheduledGame.id,
    karenProfileId,
    adminPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_official_assignments (id, game_id, official_profile_id, role, fee, status, payment_status, assigned_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'ASSISTANT_REFEREE', 50.00, 'POSTED', 'PENDING', $4::uuid)",
    generateId(),
    scheduledGame.id,
    robertProfileId,
    adminPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_official_assignments (id, game_id, official_profile_id, role, fee, status, payment_status, accepted_at, completed_at, assigned_by) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, 'SCORER', 25.00, 'NO_SHOW', 'PENDING', now() - interval '20 days', NULL, $4::uuid)",
    generateId(),
    completedGame.id,
    robertProfileId,
    adminPersonId,
  );

  // ── G. Bidirectional ratings on the COMPLETED assignment ─────
  console.log('  G. Creating 2 bidirectional ratings');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_official_ratings (id, assignment_id, rater_type, professionalism, knowledge, communication, punctuality, overall, comments, rated_by) ' +
      "VALUES ($1::uuid, $2::uuid, 'SCHOOL_RATES_OFFICIAL', 4, 5, 4, 5, 4, 'Strong officiating, clear calls, on time. Recommend.', $3::uuid)",
    generateId(),
    completedAssignmentId,
    adminPersonId,
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_official_ratings (id, assignment_id, rater_type, professionalism, knowledge, communication, punctuality, overall, comments) ' +
      "VALUES ($1::uuid, $2::uuid, 'OFFICIAL_RATES_SCHOOL', 5, 5, 5, 5, 5, 'Well-organised event, good crowd control, prompt payment. Will work again.')",
    generateId(),
    completedAssignmentId,
  );

  // ── H. Recruiting profiles ───────────────────────────────────
  console.log('  H. Creating 2 recruiting profiles');
  const mayaProfileId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_recruiting_profiles (id, student_id, sport, graduation_year, position, height_inches, weight_lbs, gpa, gpa_snapshot_at, highlight_reel_s3_key, is_published, published_at, achievements, contact_email) ' +
      "VALUES ($1::uuid, $2::uuid, 'BASKETBALL', 2027, 'Point Guard', 67, 130, 3.750, now() - interval '7 days', $3, true, now() - interval '7 days', $4, $5)",
    mayaProfileId,
    mayaStudentId,
    's3://campusos-recruiting/demo/maya-chen-highlight-reel.mp4',
    'All-conference 2025-2026. Team captain. 14.3 ppg, 5.2 apg, 3.8 rpg.',
    'maya.chen@example.com',
  );
  const ethanProfileId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_recruiting_profiles (id, student_id, sport, graduation_year, position, height_inches, weight_lbs, is_published, achievements) ' +
      "VALUES ($1::uuid, $2::uuid, 'BASKETBALL', 2027, 'Forward', 73, 175, false, '8.1 ppg, 6.5 rpg.')",
    ethanProfileId,
    ethanStudentId,
  );

  // ── I. Recruiting interests ──────────────────────────────────
  console.log('  I. Creating 3 recruiting interests');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_recruiting_interests (id, recruiting_profile_id, college_name, contact_name, contact_email, interest_level, last_contact_date, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 'University of Kansas', 'Coach Anderson', 'manderson@ku.edu', 'EXPLORING', $3::date, 'Initial outreach at Kansas City summer camp.')",
    generateId(),
    mayaProfileId,
    '2026-07-15',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_recruiting_interests (id, recruiting_profile_id, college_name, contact_name, contact_email, interest_level, last_contact_date, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 'Kansas State University', 'Coach Davis', 'jdavis@ksu.edu', 'INTERESTED', $3::date, 'Visited campus during fall break. Coach Davis sent follow-up email.')",
    generateId(),
    mayaProfileId,
    '2026-10-20',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_recruiting_interests (id, recruiting_profile_id, college_name, contact_name, contact_email, interest_level, last_contact_date, notes) ' +
      "VALUES ($1::uuid, $2::uuid, 'Pittsburg State University', 'Coach Miller', 'tmiller@pittstate.edu', 'EXPLORING', $3::date, 'Coach Miller reached out after the conference championship.')",
    generateId(),
    ethanProfileId,
    '2026-04-15',
  );

  console.log('');
  console.log('  Athletics Advanced Seed (P2-8b) complete.');
  console.log('');

  await disconnectAll();
}

seedAthleticsAdvancedB().catch((e) => {
  console.error(e);
  process.exit(1);
});
