import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';

/**
 * Wave 7 — m100-engagement fixtures.
 *
 * Per-test reset helper for the 5 eng_* tables + supporting rows the
 * engagement module reads (school_config rows for weights/thresholds,
 * pay_family_accounts rows it writes scores to). The fixtures here are
 * deliberately minimal — every spec lays down its own conference event /
 * survey / scoring family account inside the test body so the lock-step
 * cleanup stays simple.
 *
 * The reset wipes:
 *   - eng_conference_bookings, eng_conference_slots, eng_conference_events
 *   - eng_family_engagement_scores
 *   - eng_parent_surveys
 *   - school_config rows for the engagement keys
 *   - pay_family_accounts rows we created (passed in via fa_ids)
 *   - platform_outbox rows for the engagement topics (eng.conference.booking_open,
 *     eng.survey.opened)
 */
const ENG_TABLES = [
  'eng_conference_bookings',
  'eng_conference_slots',
  'eng_conference_events',
  'eng_family_engagement_scores',
  'eng_parent_surveys',
];

const ENG_CONFIG_KEYS = ['engagement_score_weights', 'engagement_level_thresholds'];
const ENG_TOPICS = ['eng.conference.booking_open', 'eng.survey.opened'];

export async function resetEngagementTables(
  client: PrismaClient,
  extra?: { familyAccountIds?: string[]; wipeAllFamilyAccounts?: boolean },
): Promise<void> {
  for (const table of ENG_TABLES) {
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.${table} WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  }
  // When the spec exercises the EngagementScoreWorker we want a clean
  // slate of pay_family_accounts too — leftover rows from a prior spec
  // (or a mid-test failure that escaped the tracked-ids cleanup) would
  // throw off the row counts the worker returns. Per-test specs that
  // care about exact tick counts must opt in via wipeAllFamilyAccounts.
  if (extra?.wipeAllFamilyAccounts) {
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_family_account_students
         WHERE family_account_id IN (
           SELECT id FROM ${TEST_SCHEMA}.pay_family_accounts
            WHERE school_id IN ($1::uuid, $2::uuid)
         )`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_invoices WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_family_accounts WHERE school_id IN ($1::uuid, $2::uuid)`,
      TEST_SCHOOL_ID,
      TEST_SCHOOL_B_ID,
    );
  } else if (extra?.familyAccountIds?.length) {
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_family_account_students WHERE family_account_id = ANY($1::uuid[])`,
      extra.familyAccountIds,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_invoices WHERE family_account_id = ANY($1::uuid[])`,
      extra.familyAccountIds,
    );
    await client.$executeRawUnsafe(
      `DELETE FROM ${TEST_SCHEMA}.pay_family_accounts WHERE id = ANY($1::uuid[])`,
      extra.familyAccountIds,
    );
  }
  await client.$executeRawUnsafe(
    `DELETE FROM ${TEST_SCHEMA}.school_config WHERE config_key = ANY($1)`,
    ENG_CONFIG_KEYS,
  );
  await client.$executeRawUnsafe(
    `DELETE FROM platform.platform_outbox WHERE topic = ANY($1)`,
    ENG_TOPICS,
  );
}
