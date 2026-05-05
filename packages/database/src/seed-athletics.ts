import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-athletics.ts — Cycle 13 Step 4.
 *
 * Idempotent. Gated on whether ath_programmes already has rows for
 * the demo school. Re-running is a no-op once the seed has landed.
 *
 * Sections covering all 14 ath_* tables:
 *   A) 2 programmes — Basketball (WINTER, [VARSITY, JV], min_gpa=2.0)
 *      and Track & Field (SPRING, [VARSITY], min_gpa=2.0).
 *   B) 2 seasons — Basketball 2025-2026 ACTIVE and Track 2025-2026
 *      UPCOMING.
 *   C) 2 rosters — Basketball VARSITY (Coach Rivera, certified) and
 *      Basketball JV (uncertified).
 *   D) 3 roster_members — Maya VARSITY #23 Guard
 *      INJURED_NOT_CLEARED (mid-protocol), Ethan VARSITY #11 Forward
 *      ELIGIBLE, Aiden Johnson JV #15 Forward ELIGIBLE.
 *   E) 3 games + 2 results + stats — Game 1 vs Jefferson HOME
 *      COMPLETED WIN 52-48; Game 2 vs Washington AWAY COMPLETED
 *      LOSS 41-55; Game 3 vs Roosevelt HOME SCHEDULED. Maya stats
 *      G1 (12 pts, 5 reb, 3 ast); G2 (8 pts, 4 reb, 2 ast).
 *   F) 1 season_record — VARSITY 1W-1L-0D, 1CW-1CL-0CD.
 *   G) 1 coaching_assignment — Rivera HEAD_COACH on VARSITY.
 *   H) 1 injury — Maya practice head injury MODERATE
 *      CONCUSSION_PROTOCOL.
 *   I) 3 concussion_protocol_steps — steps 1 and 2 completed,
 *      step 3 in progress (started, not completed).
 *   J) 0 medical_clearances — Maya is mid-protocol.
 *
 * Permissions:
 *   ATH-001:read to Teacher, Student, Parent (programmes + rosters).
 *   ATH-001:write to Staff (AD manages programmes).
 *   ATH-002:read to Teacher, Student, Parent (game schedule + results).
 *   ATH-002:write to Staff (enter results + stats).
 *   ATH-003:read+write to Staff (coaching).
 *   ATH-004:read to Teacher, Student (view injury status).
 *   ATH-004:write to Staff (log injuries, manage protocol).
 *   ATH-005:read+write to Staff (medical clearances).
 *   Admin via everyFunction.
 */

const TENANT_SCHEMA = 'tenant_demo';

function isoDateOffset(daysFromToday: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + daysFromToday);
  return d;
}

function dateOnlyOffset(daysFromToday: number): string {
  return isoDateOffset(daysFromToday).toISOString().slice(0, 10);
}

async function seedAthletics() {
  console.log('');
  console.log('  Athletics Seed (Cycle 13 Step 4)');
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

  async function findStudentByName(
    firstName: string,
    lastName: string,
  ): Promise<{ studentId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT s.id::text AS sis_id, p.id::text AS person_id FROM ' +
        TENANT_SCHEMA +
        '.sis_students s ' +
        'JOIN platform.platform_students ps ON ps.id = s.platform_student_id ' +
        'JOIN platform.iam_person p ON p.id = ps.person_id ' +
        'WHERE p.first_name = $1 AND p.last_name = $2',
      firstName,
      lastName,
    )) as Array<{ sis_id: string; person_id: string }>;
    if (rows.length === 0)
      throw new Error('sis_students not found for ' + firstName + ' ' + lastName);
    return { studentId: rows[0].sis_id, personId: rows[0].person_id };
  }

  async function findIamPersonId(email: string): Promise<string> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT p.id::text AS id FROM platform.platform_users pu ' +
        'JOIN platform.iam_person p ON p.id = pu.person_id ' +
        'WHERE pu.email = $1',
      email,
    )) as Array<{ id: string }>;
    if (rows.length === 0) throw new Error('iam_person not found for ' + email);
    return rows[0].id;
  }

  const riveraEmpId = await findEmployeeId('teacher@demo.campusos.dev');
  const principalEmpId = await findEmployeeId('principal@demo.campusos.dev');
  const riveraPersonId = await findIamPersonId('teacher@demo.campusos.dev');
  const maya = await findStudentByName('Maya', 'Chen');
  const ethan = await findStudentByName('Ethan', 'Rodriguez');
  const aiden = await findStudentByName('Aiden', 'Johnson');

  // ── 2. Idempotency gate ──────────────────────────────────────
  const existing = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.ath_programmes WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0] && existing[0].c > 0) {
    console.log('  ath_programmes already populated for demo school — skipping');
    return;
  }

  // ── 3. Programmes ────────────────────────────────────────────
  console.log('  A) 2 programmes:');
  const progBasketball = generateId();
  const progTrack = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_programmes (id, school_id, sport_name, season, levels_offered, max_roster_size_per_level, min_gpa, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, ARRAY['VARSITY','JV'], $5::jsonb, $6, true)",
    progBasketball,
    schoolId,
    'Basketball',
    'WINTER',
    JSON.stringify({ VARSITY: 15, JV: 18 }),
    2.0,
  );
  console.log('     - Basketball WINTER VARSITY+JV min_gpa=2.0');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_programmes (id, school_id, sport_name, season, levels_offered, min_gpa, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, $3, $4, ARRAY['VARSITY'], $5, true)",
    progTrack,
    schoolId,
    'Track & Field',
    'SPRING',
    2.0,
  );
  console.log('     - Track & Field SPRING VARSITY min_gpa=2.0');

  // ── 4. Seasons ───────────────────────────────────────────────
  console.log('  B) 2 seasons:');
  const seasonBasketball = generateId();
  const seasonTrack = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_seasons (id, programme_id, academic_year, first_practice_date, first_game_date, last_game_date, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5::date, $6::date, $7)',
    seasonBasketball,
    progBasketball,
    '2025-2026',
    '2025-11-01',
    '2026-01-08',
    '2026-03-01',
    'ACTIVE',
  );
  console.log('     - Basketball 2025-2026 ACTIVE');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_seasons (id, programme_id, academic_year, first_practice_date, status) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::date, $5)',
    seasonTrack,
    progTrack,
    '2025-2026',
    '2026-03-15',
    'UPCOMING',
  );
  console.log('     - Track & Field 2025-2026 UPCOMING');

  // ── 5. Rosters ───────────────────────────────────────────────
  console.log('  C) 2 rosters:');
  const rosterVarsity = generateId();
  const rosterJV = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_rosters (id, season_id, level, head_coach_id, is_certified, certified_at, certified_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4::uuid, true, now(), $5::uuid)',
    rosterVarsity,
    seasonBasketball,
    'VARSITY',
    riveraEmpId,
    principalEmpId,
  );
  console.log('     - Basketball VARSITY (Coach Rivera, CERTIFIED)');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_rosters (id, season_id, level) ' +
      'VALUES ($1::uuid, $2::uuid, $3)',
    rosterJV,
    seasonBasketball,
    'JV',
  );
  console.log('     - Basketball JV (uncertified)');

  // ── 6. Roster members ────────────────────────────────────────
  console.log('  D) 3 roster members:');
  const memberMaya = generateId();
  const memberEthan = generateId();
  const memberAiden = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_roster_members (id, roster_id, student_id, jersey_number, position, eligibility_status, joined_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date)',
    memberMaya,
    rosterVarsity,
    maya.studentId,
    '23',
    'Guard',
    'INJURED_NOT_CLEARED',
    '2025-09-01',
  );
  console.log('     - Maya Chen VARSITY #23 Guard INJURED_NOT_CLEARED (mid-concussion-protocol)');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_roster_members (id, roster_id, student_id, jersey_number, position, eligibility_status, joined_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date)',
    memberEthan,
    rosterVarsity,
    ethan.studentId,
    '11',
    'Forward',
    'ELIGIBLE',
    '2025-09-01',
  );
  console.log('     - Ethan Rodriguez VARSITY #11 Forward ELIGIBLE');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_roster_members (id, roster_id, student_id, jersey_number, position, eligibility_status, joined_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7::date)',
    memberAiden,
    rosterJV,
    aiden.studentId,
    '15',
    'Forward',
    'ELIGIBLE',
    '2025-09-01',
  );
  console.log('     - Aiden Johnson JV #15 Forward ELIGIBLE');

  // ── 7. Games ─────────────────────────────────────────────────
  console.log('  E) 3 games:');
  const gameJefferson = generateId();
  const gameWashington = generateId();
  const gameRoosevelt = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_games (id, season_id, roster_id, game_date, game_time, opponent_name, location, status, is_conference_game) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::time, $6, $7, $8, true)',
    gameJefferson,
    seasonBasketball,
    rosterVarsity,
    '2026-01-08',
    '19:00',
    'Jefferson High',
    'HOME',
    'COMPLETED',
  );
  console.log('     - vs Jefferson High HOME COMPLETED');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_games (id, season_id, roster_id, game_date, game_time, opponent_name, location, status, is_conference_game) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::time, $6, $7, $8, true)',
    gameWashington,
    seasonBasketball,
    rosterVarsity,
    '2026-01-15',
    '19:00',
    'Washington High',
    'AWAY',
    'COMPLETED',
  );
  console.log('     - vs Washington High AWAY COMPLETED');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_games (id, season_id, roster_id, game_date, game_time, opponent_name, location, status, is_conference_game) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4::date, $5::time, $6, $7, $8, true)',
    gameRoosevelt,
    seasonBasketball,
    rosterVarsity,
    '2026-01-22',
    '19:00',
    'Roosevelt High',
    'HOME',
    'SCHEDULED',
  );
  console.log('     - vs Roosevelt High HOME SCHEDULED');

  // ── 8. Game results ──────────────────────────────────────────
  console.log('  F) 2 game results:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_game_results (id, game_id, home_score, away_score, score_by_period, outcome, entered_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::uuid)',
    generateId(),
    gameJefferson,
    52,
    48,
    JSON.stringify({ q1: [12, 10], q2: [14, 12], q3: [13, 14], q4: [13, 12] }),
    'WIN',
    principalEmpId,
  );
  console.log('     - Game 1: Jefferson 52-48 WIN');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_game_results (id, game_id, home_score, away_score, score_by_period, outcome, entered_by) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb, $6, $7::uuid)',
    generateId(),
    gameWashington,
    41,
    55,
    JSON.stringify({ q1: [10, 12], q2: [9, 15], q3: [11, 13], q4: [11, 15] }),
    'LOSS',
    principalEmpId,
  );
  console.log('     - Game 2: Washington 41-55 LOSS');

  // ── 9. Player game stats ─────────────────────────────────────
  console.log('  G) 6 player_game_stats (Maya G1 + G2):');
  const stats = [
    { game: gameJefferson, cat: 'points', val: 12.0 },
    { game: gameJefferson, cat: 'rebounds', val: 5.0 },
    { game: gameJefferson, cat: 'assists', val: 3.0 },
    { game: gameWashington, cat: 'points', val: 8.0 },
    { game: gameWashington, cat: 'rebounds', val: 4.0 },
    { game: gameWashington, cat: 'assists', val: 2.0 },
  ];
  for (const s of stats) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.ath_player_game_stats (id, game_id, student_id, stat_category, stat_value, entered_by) ' +
        'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::uuid)',
      generateId(),
      s.game,
      maya.studentId,
      s.cat,
      s.val,
      principalEmpId,
    );
  }
  console.log('     - Maya G1: 12 pts / 5 reb / 3 ast');
  console.log('     - Maya G2: 8 pts / 4 reb / 2 ast');

  // ── 10. Season record ────────────────────────────────────────
  console.log('  H) 1 season_record:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_season_records (id, roster_id, wins, losses, draws, conference_wins, conference_losses, conference_draws) ' +
      'VALUES ($1::uuid, $2::uuid, 1, 1, 0, 1, 1, 0)',
    generateId(),
    rosterVarsity,
  );
  console.log('     - VARSITY 1W-1L-0D / 1CW-1CL-0CD');

  // ── 11. Coaching assignment ──────────────────────────────────
  console.log('  I) 1 coaching_assignment:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_coaching_assignments (id, roster_id, coach_person_id, role, stipend_amount, start_date, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, true)',
    generateId(),
    rosterVarsity,
    riveraPersonId,
    'HEAD_COACH',
    5000.0,
    '2025-11-01',
  );
  console.log('     - Rivera HEAD_COACH on VARSITY ($5000 stipend)');

  // ── 12. Injury (Maya, mid-concussion-protocol) ──────────────
  console.log('  J) 1 injury (Maya CONCUSSION_PROTOCOL):');
  const injuryMaya = generateId();
  const practiceDate = dateOnlyOffset(-14);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_injuries (id, student_id, practice_date, injury_date, body_part, injury_description, initial_assessment, action_taken, severity, return_to_play_status, logged_by, logged_at) ' +
      'VALUES ($1::uuid, $2::uuid, $3::date, $4::date, $5, $6, $7, $8, $9, $10, $11::uuid, $12::timestamptz)',
    injuryMaya,
    maya.studentId,
    practiceDate,
    practiceDate,
    'Head',
    'Hit head on the floor during practice scrimmage. Reported headache and brief disorientation.',
    'Possible concussion. Removed from practice. Athletic trainer assessed on scene.',
    'Sent home with parents. Concussion protocol initiated. Cleared from school nurse for class.',
    'MODERATE',
    'CONCUSSION_PROTOCOL',
    riveraEmpId,
    new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
  );
  console.log('     - Maya MODERATE head injury 2 weeks ago, CONCUSSION_PROTOCOL');

  // ── 13. Concussion protocol steps (steps 1-2 done, 3 in progress) ──
  console.log('  K) 3 concussion_protocol_steps:');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_concussion_protocol_steps (id, injury_id, step_number, step_name, started_at, minimum_duration_hours, completed_at, symptom_free, cleared_by, notes) ' +
      'VALUES ($1::uuid, $2::uuid, 1, $3, $4::timestamptz, 24, $5::timestamptz, true, $6::uuid, $7)',
    generateId(),
    injuryMaya,
    'Complete rest',
    new Date(Date.now() - 14 * 24 * 60 * 60 * 1000).toISOString(),
    new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString(),
    riveraEmpId,
    'Maya rested 24 hours, no symptoms reported on day 2 morning.',
  );
  console.log('     - Step 1 Complete rest — COMPLETED');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_concussion_protocol_steps (id, injury_id, step_number, step_name, started_at, minimum_duration_hours, completed_at, symptom_free, cleared_by, notes) ' +
      'VALUES ($1::uuid, $2::uuid, 2, $3, $4::timestamptz, 24, $5::timestamptz, true, $6::uuid, $7)',
    generateId(),
    injuryMaya,
    'Light aerobic activity',
    new Date(Date.now() - 13 * 24 * 60 * 60 * 1000).toISOString(),
    new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
    riveraEmpId,
    'Walking and stationary cycling. No symptoms.',
  );
  console.log('     - Step 2 Light aerobic activity — COMPLETED');
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.ath_concussion_protocol_steps (id, injury_id, step_number, step_name, started_at, minimum_duration_hours, symptom_free, notes) ' +
      'VALUES ($1::uuid, $2::uuid, 3, $3, $4::timestamptz, 24, false, $5)',
    generateId(),
    injuryMaya,
    'Sport-specific exercise',
    new Date(Date.now() - 12 * 24 * 60 * 60 * 1000).toISOString(),
    'Started running drills. Awaiting end-of-day symptom check.',
  );
  console.log('     - Step 3 Sport-specific exercise — IN PROGRESS');

  console.log('');
  console.log('  Athletics seed complete (14 ath_* tables, 32 rows total).');
}

seedAthletics()
  .catch((e) => {
    console.error('Athletics seed failed:', e);
    process.exit(1);
  })
  .finally(async () => {
    await disconnectAll();
  });
