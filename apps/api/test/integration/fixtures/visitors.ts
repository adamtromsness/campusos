import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';

/**
 * Wave 8 — m90-visitors fixtures.
 *
 * Seeds canonical visitor types per school + a sign-in settings row
 * per school. Wipes every vis_* table per test for a clean slate.
 */
export const TEST_VIS_TYPE_CONTRACTOR_A_ID = '019e0cf8-aaaa-7777-8888-000000090001';
export const TEST_VIS_TYPE_PARENT_A_ID = '019e0cf8-aaaa-7777-8888-000000090002';
export const TEST_VIS_TYPE_RETIRED_A_ID = '019e0cf8-aaaa-7777-8888-000000090003';
export const TEST_VIS_TYPE_CONTRACTOR_B_ID = '019e0cf8-aaaa-7777-8888-000000090004';

const VIS_TABLES = [
  'vis_muster_entries',
  'vis_emergency_muster',
  'vis_banned_persons',
  'vis_recurring_visitors',
  'vis_pre_registrations',
  'vis_sign_ins',
  'vis_visitors',
  'vis_visitor_types',
  'vis_sign_in_settings',
];

export async function resetVisitorsTables(client: PrismaClient): Promise<void> {
  const list = VIS_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function ensureVisitorsSeed(client: PrismaClient): Promise<void> {
  // School A visitor types
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.vis_visitor_types
       (id, school_id, name, description, requires_safeguarding_check, badge_color, is_active)
     VALUES ($1::uuid, $2::uuid, 'Contractor', 'Trade visit', true, 'amber', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_VIS_TYPE_CONTRACTOR_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.vis_visitor_types
       (id, school_id, name, description, requires_safeguarding_check, badge_color, is_active)
     VALUES ($1::uuid, $2::uuid, 'Parent', 'Parent visit', false, 'green', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_VIS_TYPE_PARENT_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.vis_visitor_types
       (id, school_id, name, description, requires_safeguarding_check, badge_color, is_active)
     VALUES ($1::uuid, $2::uuid, 'Retired Cat', 'Retired', false, 'gray', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_VIS_TYPE_RETIRED_A_ID,
    TEST_SCHOOL_ID,
  );
  // School B visitor types
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.vis_visitor_types
       (id, school_id, name, description, requires_safeguarding_check, badge_color, is_active)
     VALUES ($1::uuid, $2::uuid, 'B Contractor', 'B trade visit', true, 'amber', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_VIS_TYPE_CONTRACTOR_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // Sign-in settings per school
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.vis_sign_in_settings
       (id, school_id, require_photo_id, require_purpose, auto_sign_out_hours,
        safeguarding_provider, badge_template, kiosk_welcome_message)
     VALUES (gen_random_uuid(), $1::uuid, false, true, 12,
             'TestProvider', 'STANDARD', 'Welcome')
     ON CONFLICT (school_id) DO NOTHING`,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.vis_sign_in_settings
       (id, school_id, require_photo_id, require_purpose, auto_sign_out_hours,
        safeguarding_provider, badge_template, kiosk_welcome_message)
     VALUES (gen_random_uuid(), $1::uuid, true, false, 8,
             'BProvider', 'COMPACT', 'B welcome')
     ON CONFLICT (school_id) DO NOTHING`,
    TEST_SCHOOL_B_ID,
  );
}

export async function resetAndSeedVisitors(client: PrismaClient): Promise<void> {
  await resetVisitorsTables(client);
  await ensureVisitorsSeed(client);
}
