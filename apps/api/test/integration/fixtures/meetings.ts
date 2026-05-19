import type { PrismaClient } from '@prisma/client';
import { TEST_SCHOOL_ID, TEST_SCHOOL_B_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * Wave 5 — m41-meetings fixtures.
 *
 * Seeds the shared catalogue rows required for the meetings /
 * recordings / templates services:
 *
 *   - mtg_meeting_types  (Default for both schools)
 *
 * Per-test rows (meetings, notes, action items, recordings, templates)
 * are created inside each spec file's beforeEach.
 *
 * IDs follow the suite convention: aaaa-7777-8888-0000000005xx
 * for School A, with -00000000b5xx mirrors on School B.
 */
export const TEST_MEETING_TYPE_ID = '019e0cf8-aaaa-7777-8888-000000000500';
export const TEST_MEETING_TYPE_B_ID = '019e0cf8-aaaa-7777-8888-00000000b500';

export async function ensureMeetingsFixtures(prisma: PrismaClient): Promise<void> {
  // Meeting types — School A
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.mtg_meeting_types
       (id, school_id, name, description, default_duration_minutes, is_video, is_active)
     VALUES ($1::uuid, $2::uuid, 'Default Meeting', 'Generic meeting type', 30, false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_MEETING_TYPE_ID,
    TEST_SCHOOL_ID,
  );

  // Meeting types — School B
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.mtg_meeting_types
       (id, school_id, name, description, default_duration_minutes, is_video, is_active)
     VALUES ($1::uuid, $2::uuid, 'Default Meeting B', 'Generic meeting B', 30, false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_MEETING_TYPE_B_ID,
    TEST_SCHOOL_B_ID,
  );
}
