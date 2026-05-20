import type { PrismaClient } from '@prisma/client';
import {
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';

/**
 * Wave 7 — m85-accreditation fixtures.
 *
 * Six tenant tables (acc_*) + the outbox topic emitted by the
 * ActionPlanOverdueWorker. The two platform tables
 * (platform.acc_frameworks_platform + platform.acc_standards_platform)
 * are seeded once by `ensureAccreditationPlatformFixtures` and left in
 * place across runs — they're stable test infrastructure mirroring the
 * shipping platform-seeded national frameworks.
 *
 * resetAccreditationTables wipes ONLY the tenant rows belonging to
 * School A + School B between tests, leaving the platform framework /
 * standard catalogue intact. Custom tenant frameworks belong to a
 * school via school_id and are cleared the same way.
 */
const ACC_TABLES = [
  // child rows first
  'acc_evidence_items',
  'acc_self_study_ratings',
  'acc_action_plans',
  'acc_site_visit_prep',
  'acc_school_framework_adoptions',
  'acc_frameworks',
];

const ACC_TOPICS = ['acc.action_plan.overdue'];

// Stable test framework + standard UUIDs (separate from the live demo
// seed which uses random UUIDs). Pinning IDs lets the per-test bodies
// reference them as constants instead of querying for them.
export const TEST_PLATFORM_FRAMEWORK_ID = '019e1000-aaaa-7777-8888-000000008501';
export const TEST_PLATFORM_FRAMEWORK_B_ID = '019e1000-aaaa-7777-8888-000000008502';
export const TEST_PLATFORM_FRAMEWORK_INACTIVE_ID = '019e1000-aaaa-7777-8888-000000008503';

// Two standards under the primary framework, distinct domains so the
// summary by-domain test can assert a multi-domain rollup.
export const TEST_PLATFORM_STANDARD_A_ID = '019e1000-aaaa-7777-8888-000000008511';
export const TEST_PLATFORM_STANDARD_B_ID = '019e1000-aaaa-7777-8888-000000008512';
export const TEST_PLATFORM_STANDARD_C_ID = '019e1000-aaaa-7777-8888-000000008513';
// Standard under FRAMEWORK_B — used to verify SOFT INTEGRITY refuses
// references to a framework the school hasn't adopted.
export const TEST_PLATFORM_STANDARD_UNADOPTED_ID = '019e1000-aaaa-7777-8888-000000008521';

/**
 * Idempotent platform-side seed for the two M85 platform tables. Run
 * once per suite via globalSetup; safe to call from per-spec beforeAll
 * fallbacks too (every INSERT is ON CONFLICT DO NOTHING).
 */
export async function ensureAccreditationPlatformFixtures(
  client: PrismaClient,
): Promise<void> {
  // Primary framework + 3 standards (2 domains so summary tests can
  // assert a multi-domain rollup).
  await client.$executeRawUnsafe(
    `INSERT INTO platform.acc_frameworks_platform
       (id, name, abbreviation, organisation, description, version, is_active)
     VALUES ($1::uuid, 'Test Primary Framework', 'TPF', 'TestAccred', 'desc', '1.0', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PLATFORM_FRAMEWORK_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.acc_frameworks_platform
       (id, name, abbreviation, organisation, description, version, is_active)
     VALUES ($1::uuid, 'Test Secondary Framework', 'TSF', 'TestAccred', 'desc', '1.0', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PLATFORM_FRAMEWORK_B_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.acc_frameworks_platform
       (id, name, abbreviation, organisation, description, version, is_active)
     VALUES ($1::uuid, 'Test Inactive Framework', 'TIF', 'TestAccred', 'desc', '1.0', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PLATFORM_FRAMEWORK_INACTIVE_ID,
  );

  // Standards under the primary framework
  await client.$executeRawUnsafe(
    `INSERT INTO platform.acc_standards_platform
       (id, framework_id, standard_code, domain, standard_text, guidance_notes, sort_order)
     VALUES ($1::uuid, $2::uuid, '1.1', 'Curriculum', 'Standard A text', 'guidance', 1)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PLATFORM_STANDARD_A_ID,
    TEST_PLATFORM_FRAMEWORK_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.acc_standards_platform
       (id, framework_id, standard_code, domain, standard_text, guidance_notes, sort_order)
     VALUES ($1::uuid, $2::uuid, '1.2', 'Curriculum', 'Standard B text', NULL, 2)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PLATFORM_STANDARD_B_ID,
    TEST_PLATFORM_FRAMEWORK_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.acc_standards_platform
       (id, framework_id, standard_code, domain, standard_text, guidance_notes, sort_order)
     VALUES ($1::uuid, $2::uuid, '2.1', 'Leadership', 'Standard C text', NULL, 3)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PLATFORM_STANDARD_C_ID,
    TEST_PLATFORM_FRAMEWORK_ID,
  );
  // Standard under the secondary framework — used in SOFT INTEGRITY
  // negative tests (school adopts primary, then references this
  // unadopted-framework standard).
  await client.$executeRawUnsafe(
    `INSERT INTO platform.acc_standards_platform
       (id, framework_id, standard_code, domain, standard_text, guidance_notes, sort_order)
     VALUES ($1::uuid, $2::uuid, '1.1', 'Other', 'Unadopted standard', NULL, 1)
     ON CONFLICT (id) DO NOTHING`,
    TEST_PLATFORM_STANDARD_UNADOPTED_ID,
    TEST_PLATFORM_FRAMEWORK_B_ID,
  );
}

export async function resetAccreditationTables(client: PrismaClient): Promise<void> {
  for (const table of ACC_TABLES) {
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.${table} WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  }
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox WHERE topic = ANY($1) AND (tenant_id = $2::uuid OR tenant_id = $3::uuid)`,
    ACC_TOPICS,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );
}

/**
 * Idempotent helper to install an active adoption of the test platform
 * framework for the given school. Returns the new adoption id.
 */
export async function seedAdoption(
  client: PrismaClient,
  schoolId: string = TEST_SCHOOL_ID,
  frameworkId: string = TEST_PLATFORM_FRAMEWORK_ID,
): Promise<string> {
  const id = await client.$queryRawUnsafe<Array<{ id: string }>>(
    `INSERT INTO ${TEST_SCHEMA}.acc_school_framework_adoptions
       (id, school_id, platform_framework_id, adopted_at, is_active)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, CURRENT_DATE, true)
     ON CONFLICT (school_id, platform_framework_id) DO UPDATE
       SET is_active = EXCLUDED.is_active
     RETURNING id::text AS id`,
    schoolId,
    frameworkId,
  );
  return id[0]!.id;
}
