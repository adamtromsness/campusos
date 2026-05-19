import type { PrismaClient } from '@prisma/client';
import { TEST_SCHOOL_ID, TEST_SCHOOL_B_ID, TEST_SCHEMA } from '../helpers/tenant-context';

/**
 * Wave 5 — m40-communications fixtures.
 *
 * Seeds the shared catalogue rows required for the messaging /
 * announcements / notifications / emergency-alerts services:
 *
 *   - msg_thread_types (DIRECT for both schools)
 *   - msg_alert_types  (INFO + EMERGENCY for both schools)
 *
 * Per-test rows (threads, messages, announcements, notification queue
 * entries, push tokens, broadcast segments) are created inside each
 * spec file's beforeEach. The catalogue rows above are stable across
 * the suite — both schools get a fresh fixture row so cross-school
 * isolation tests can refer to either side without per-test seeding.
 *
 * IDs follow the suite convention: aaaa-7777-8888-0000000004xx
 * for School A, with -00000000b4xx mirrors on School B.
 */
export const TEST_THREAD_TYPE_DIRECT_ID = '019e0cf8-aaaa-7777-8888-000000000400';
export const TEST_THREAD_TYPE_OPEN_ID = '019e0cf8-aaaa-7777-8888-000000000401';
export const TEST_ALERT_TYPE_INFO_ID = '019e0cf8-aaaa-7777-8888-000000000402';
export const TEST_ALERT_TYPE_EMERGENCY_ID = '019e0cf8-aaaa-7777-8888-000000000403';

export const TEST_THREAD_TYPE_DIRECT_B_ID = '019e0cf8-aaaa-7777-8888-00000000b400';
export const TEST_THREAD_TYPE_OPEN_B_ID = '019e0cf8-aaaa-7777-8888-00000000b401';
export const TEST_ALERT_TYPE_INFO_B_ID = '019e0cf8-aaaa-7777-8888-00000000b402';
export const TEST_ALERT_TYPE_EMERGENCY_B_ID = '019e0cf8-aaaa-7777-8888-00000000b403';

export async function ensureCommunicationsFixtures(prisma: PrismaClient): Promise<void> {
  // Thread types — School A
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.msg_thread_types
       (id, school_id, name, description, allowed_participant_roles, is_system, is_active)
     VALUES ($1::uuid, $2::uuid, 'Direct', 'Direct conversation', ARRAY[]::TEXT[], false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_THREAD_TYPE_DIRECT_ID,
    TEST_SCHOOL_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.msg_thread_types
       (id, school_id, name, description, allowed_participant_roles, is_system, is_active)
     VALUES ($1::uuid, $2::uuid, 'Open', 'Open thread', ARRAY[]::TEXT[], true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_THREAD_TYPE_OPEN_ID,
    TEST_SCHOOL_ID,
  );

  // Thread types — School B mirror
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.msg_thread_types
       (id, school_id, name, description, allowed_participant_roles, is_system, is_active)
     VALUES ($1::uuid, $2::uuid, 'Direct', 'Direct conversation B', ARRAY[]::TEXT[], false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_THREAD_TYPE_DIRECT_B_ID,
    TEST_SCHOOL_B_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.msg_thread_types
       (id, school_id, name, description, allowed_participant_roles, is_system, is_active)
     VALUES ($1::uuid, $2::uuid, 'Open', 'Open thread B', ARRAY[]::TEXT[], true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_THREAD_TYPE_OPEN_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // Alert types — School A
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.msg_alert_types
       (id, school_id, name, description, severity, default_channels, requires_acknowledgement, is_active)
     VALUES ($1::uuid, $2::uuid, 'Info', 'General announcement', 'INFO', ARRAY['IN_APP']::TEXT[], false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ALERT_TYPE_INFO_ID,
    TEST_SCHOOL_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.msg_alert_types
       (id, school_id, name, description, severity, default_channels, requires_acknowledgement, is_active)
     VALUES ($1::uuid, $2::uuid, 'Emergency', 'Emergency alert', 'EMERGENCY', ARRAY['IN_APP','SMS','EMAIL']::TEXT[], true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ALERT_TYPE_EMERGENCY_ID,
    TEST_SCHOOL_ID,
  );

  // Alert types — School B mirror
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.msg_alert_types
       (id, school_id, name, description, severity, default_channels, requires_acknowledgement, is_active)
     VALUES ($1::uuid, $2::uuid, 'Info', 'General announcement B', 'INFO', ARRAY['IN_APP']::TEXT[], false, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ALERT_TYPE_INFO_B_ID,
    TEST_SCHOOL_B_ID,
  );
  await prisma.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.msg_alert_types
       (id, school_id, name, description, severity, default_channels, requires_acknowledgement, is_active)
     VALUES ($1::uuid, $2::uuid, 'Emergency', 'Emergency B', 'EMERGENCY', ARRAY['IN_APP','SMS','EMAIL']::TEXT[], true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_ALERT_TYPE_EMERGENCY_B_ID,
    TEST_SCHOOL_B_ID,
  );
}
