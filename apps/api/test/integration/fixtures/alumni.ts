import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';

/**
 * Wave 7 — m102-alumni fixtures.
 *
 * Resets the 8 alm_* tables + supporting platform.platform_outbox rows
 * the alumni module emits. Per-test specs lay down their own alumni
 * profiles / campaigns / donations / news / reunions / events inside
 * the test body — no canonical seed needed.
 *
 * The CASCADE FKs on alm_alumni_tags, alm_donations,
 * alm_campaign_recipients, alm_reunion_groups (organiser_id) mean the
 * order matters: child rows first, then parent tables.
 */
const ALM_TABLES = [
  'alm_donations',
  'alm_campaign_recipients',
  'alm_campaigns',
  'alm_alumni_news',
  'alm_reunion_groups',
  'alm_events',
  'alm_alumni_tags',
  'alm_alumni_profiles',
];

const ALM_TOPICS = ['alm.campaign.activated', 'alm.donation.received'];

export async function resetAlumniTables(
  client: PrismaClient,
  extra?: { personIds?: string[] },
): Promise<void> {
  for (const table of ALM_TABLES) {
    if (
      table === 'alm_alumni_tags' ||
      table === 'alm_donations' ||
      table === 'alm_campaign_recipients'
    ) {
      // child tables — wipe all rows that hang off this tenant's profiles
      await client.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.${table} WHERE ${
          table === 'alm_alumni_tags'
            ? 'alumni_id IN (SELECT id FROM ' +
              TEST_SCHEMA +
              '.alm_alumni_profiles WHERE school_id IN ($1::uuid, $2::uuid))'
            : table === 'alm_donations'
              ? 'donor_alumni_id IN (SELECT id FROM ' +
                TEST_SCHEMA +
                '.alm_alumni_profiles WHERE school_id IN ($1::uuid, $2::uuid))'
              : 'campaign_id IN (SELECT id FROM ' +
                TEST_SCHEMA +
                '.alm_campaigns WHERE school_id IN ($1::uuid, $2::uuid))'
        }`,
        TEST_SCHOOL_ID,
        TEST_SCHOOL_B_ID,
      );
    } else {
      await client.$executeRawUnsafe(
        `DELETE FROM ${TEST_SCHEMA}.${table} WHERE school_id IN ($1::uuid, $2::uuid)`,
        TEST_SCHOOL_ID,
        TEST_SCHOOL_B_ID,
      );
    }
  }
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox WHERE topic = ANY($1) AND (tenant_id = $2::uuid OR tenant_id = $3::uuid)`,
    ALM_TOPICS,
    TEST_SCHOOL_ID,
    TEST_SCHOOL_B_ID,
  );
  if (extra?.personIds?.length) {
    await client.$executeRawUnsafe(
      `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
      extra.personIds,
    );
  }
}

/**
 * Idempotent helper to ensure an iam_person row exists for a given
 * personId. Used by specs that pin alumni profiles to specific
 * synthetic identities (parent/student personas). The platform admin
 * person + platform_users row are seeded once by globalSetup; other
 * stable persona person_ids (parent / student / teacher) are NOT
 * pre-seeded so each spec opt-in seeds the rows it needs.
 */
export async function ensureIamPerson(
  client: PrismaClient,
  personId: string,
  opts: {
    firstName?: string;
    lastName?: string;
    personType?: 'STAFF' | 'STUDENT' | 'GUARDIAN';
  } = {},
): Promise<void> {
  // person_type is a Prisma enum — interpolate the literal so Postgres sees
  // it as the enum value rather than a generic text param.
  const personType = opts.personType ?? 'STAFF';
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, $2, $3, '${personType}', true)
     ON CONFLICT (id) DO NOTHING`,
    personId,
    opts.firstName ?? 'Test',
    opts.lastName ?? 'Person',
  );
}
