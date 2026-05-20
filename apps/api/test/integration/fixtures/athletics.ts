import type { PrismaClient } from '@prisma/client';
import {
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import { TEST_ADMIN_EMPLOYEE_ID } from '../helpers/actor';

/**
 * Wave 7 — m66-athletics fixtures.
 *
 * Seeds canonical programmes / seasons / rosters for both School A and
 * School B so spec files can reference them deterministically. Tests
 * call resetAthleticsTables() in beforeEach and ensureAthleticsSeed()
 * to restore the baseline.
 *
 * Cross-school invariant: every athletic surface ultimately scopes by
 * ath_programmes.school_id (rosters → seasons → programmes → school_id).
 * Cross-school isolation tests seed rows under School B's programme
 * tree and expect School A reads to ignore them.
 */
export const TEST_ATH_PROGRAMME_A_ID = '019e0cf8-aaaa-7777-8888-000000066010';
export const TEST_ATH_PROGRAMME_B_ID = '019e0cf8-aaaa-7777-8888-000000066011';

export const TEST_ATH_SEASON_A_ID = '019e0cf8-aaaa-7777-8888-000000066020';
export const TEST_ATH_SEASON_B_ID = '019e0cf8-aaaa-7777-8888-000000066021';

export const TEST_ATH_ROSTER_A_ID = '019e0cf8-aaaa-7777-8888-000000066030';
export const TEST_ATH_ROSTER_B_ID = '019e0cf8-aaaa-7777-8888-000000066031';

// Platform-level official profile + availability (shared marketplace surface).
export const TEST_ATH_OFFICIAL_PROFILE_ID = '019e0cf8-aaaa-7777-8888-000000066050';
export const TEST_ATH_OFFICIAL_PERSON_ID = '019e0cf8-aaaa-7777-8888-000000066051';

// Canonical conference + memberships (single platform-level row visible to both schools).
export const TEST_ATH_CONFERENCE_ID = '019e0cf8-aaaa-7777-8888-000000066060';

// All ath_* tables touched by the module. Child-first.
const ATH_TABLES = [
  'ath_official_ratings',
  'ath_official_assignments',
  'ath_highlight_clips',
  'ath_game_recordings',
  'ath_game_streams',
  'ath_player_game_stats',
  'ath_game_results',
  'ath_games',
  'ath_game_proposals',
  'ath_concussion_protocol_steps',
  'ath_medical_clearances',
  'ath_injuries',
  'ath_coaching_assignments',
  'ath_safety_equipment',
  'ath_equipment_maintenance',
  'ath_equipment_checkouts',
  'ath_equipment',
  'ath_team_photos',
  'ath_media_assets',
  'ath_conference_schedules',
  'ath_conference_memberships',
  'ath_conferences',
  'ath_all_time_records',
  'ath_season_records',
  'ath_recruiting_interests',
  'ath_recruiting_profiles',
  'ath_roster_members',
  'ath_rosters',
  'ath_seasons',
  'ath_programmes',
];

export async function resetAthleticsTables(client: PrismaClient): Promise<void> {
  const list = ATH_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
  // Wipe ALL platform-level official rows so each spec starts cleanly.
  // m101-events and other modules also create ad-hoc rows here and don't
  // always track + clean them up — sweep the whole surface defensively.
  await client.$executeRawUnsafe(`DELETE FROM platform.platform_official_availability`);
  await client.$executeRawUnsafe(`DELETE FROM platform.platform_official_profiles`);
  await client.$executeRawUnsafe(
    `DELETE FROM platform.iam_person WHERE id = $1::uuid`,
    TEST_ATH_OFFICIAL_PERSON_ID,
  );
  // Athletics outbox events
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox WHERE topic LIKE 'ath.%' AND (tenant_id = $1::uuid OR tenant_id = $2::uuid)`,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );
}

/**
 * Seed a canonical programme + season + roster per school. The roster
 * is uncertified, no members. Programme has min_gpa=2.0 + a level cap
 * map so cap-check tests can be exercised without extra setup.
 */
export async function ensureAthleticsSeed(client: PrismaClient): Promise<void> {
  // School A — programme (Soccer)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ath_programmes
       (id, school_id, sport_name, season, levels_offered, max_roster_size_per_level, min_gpa, is_active)
     VALUES ($1::uuid, $2::uuid, 'Soccer A', 'FALL', ARRAY['VARSITY','JV']::text[], '{"VARSITY": 5}'::jsonb, 2.00, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ATH_PROGRAMME_A_ID,
    TEST_SCHOOL_ID,
  );

  // School A — season
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ath_seasons
       (id, programme_id, academic_year, status)
     VALUES ($1::uuid, $2::uuid, '2026-2027', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ATH_SEASON_A_ID,
    TEST_ATH_PROGRAMME_A_ID,
  );

  // School A — roster (VARSITY)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ath_rosters
       (id, season_id, level, head_coach_id, is_certified)
     VALUES ($1::uuid, $2::uuid, 'VARSITY', $3::uuid, false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ATH_ROSTER_A_ID,
    TEST_ATH_SEASON_A_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );

  // School B mirrors
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ath_programmes
       (id, school_id, sport_name, season, levels_offered, is_active)
     VALUES ($1::uuid, $2::uuid, 'Soccer B', 'FALL', ARRAY['VARSITY']::text[], true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ATH_PROGRAMME_B_ID,
    TEST_SCHOOL_B_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ath_seasons
       (id, programme_id, academic_year, status)
     VALUES ($1::uuid, $2::uuid, '2026-2027', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    TEST_ATH_SEASON_B_ID,
    TEST_ATH_PROGRAMME_B_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.ath_rosters
       (id, season_id, level, head_coach_id, is_certified)
     VALUES ($1::uuid, $2::uuid, 'VARSITY', $3::uuid, false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ATH_ROSTER_B_ID,
    TEST_ATH_SEASON_B_ID,
    TEST_ADMIN_EMPLOYEE_ID,
  );
}

/**
 * Seed a platform-level official profile so tenant-side assignment
 * tests can refer to a stable id. Idempotent.
 */
export async function ensureOfficialProfile(client: PrismaClient): Promise<void> {
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'Test', 'Official', 'STAFF', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ATH_OFFICIAL_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_official_profiles
       (id, person_id, sports, certification_level, base_fee, is_available)
     VALUES ($1::uuid, $2::uuid, ARRAY['Soccer','Basketball']::text[], 'STATE', 75.00, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ATH_OFFICIAL_PROFILE_ID,
    TEST_ATH_OFFICIAL_PERSON_ID,
  );
}
