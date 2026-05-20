import type { PrismaClient } from '@prisma/client';
import {
  TEST_SCHEMA,
  TEST_SCHOOL_ID,
  TEST_SCHOOL_B_ID,
} from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_ADMIN_PERSON_ID,
} from '../helpers/actor';

/**
 * Wave 7 — m103-groups fixtures.
 *
 * Per-test reset helper + canonical seed for the 18 grp_* tables. Tests
 * call resetGroupsAndStudents in beforeEach to wipe every grp_* row +
 * any spec-tracked SIS / platform rows, and ensureGroupsSeed to lay
 * down deterministic groups for School A + School B. Pattern is a
 * direct adaptation of fixtures/clubs.ts.
 *
 * Seeded canonical groups (all status=ACTIVE):
 *   - GROUP_OPEN_A          School A, scope=SCHOOL, join_policy=OPEN
 *                           admin actor is the OWNER
 *   - GROUP_APPROVAL_A      School A, scope=CUSTOM, join_policy=APPROVAL_REQUIRED
 *   - GROUP_INVITE_A        School A, scope=CUSTOM, join_policy=INVITE_ONLY
 *   - GROUP_B               School B, scope=SCHOOL, join_policy=OPEN — used
 *                           by cross-school isolation tests
 *
 * Each canonical group has admin as the OWNER member so any test that
 * needs an active OWNER can use the admin actor immediately. Tests
 * that need additional members layer them on per-test.
 */
export const TEST_GROUP_OPEN_A_ID = '019e0cf8-aaaa-7777-8888-000000103001';
export const TEST_GROUP_APPROVAL_A_ID = '019e0cf8-aaaa-7777-8888-000000103002';
export const TEST_GROUP_INVITE_A_ID = '019e0cf8-aaaa-7777-8888-000000103003';
export const TEST_GROUP_B_ID = '019e0cf8-aaaa-7777-8888-000000103004';

// Deterministic OWNER membership row ids for the canonical groups (so
// other tests can reference admin's OWNER membership without re-querying).
export const TEST_GROUP_OPEN_A_OWNER_MEMBER_ID = '019e0cf8-aaaa-7777-8888-000000103011';
export const TEST_GROUP_APPROVAL_A_OWNER_MEMBER_ID = '019e0cf8-aaaa-7777-8888-000000103012';
export const TEST_GROUP_INVITE_A_OWNER_MEMBER_ID = '019e0cf8-aaaa-7777-8888-000000103013';
export const TEST_GROUP_B_OWNER_MEMBER_ID = '019e0cf8-aaaa-7777-8888-000000103014';

// Every grp_* table touched by the module. Child-first so the TRUNCATE
// CASCADE intent is explicit even though CASCADE handles dependencies.
const GROUP_TABLES = [
  'grp_poll_voter_checks',
  'grp_poll_votes',
  'grp_poll_options',
  'grp_group_polls',
  'grp_group_event_rsvps',
  'grp_group_events',
  'grp_resource_versions',
  'grp_resource_library',
  'grp_group_invitations',
  'grp_group_analytics',
  'grp_event_rsvps',
  'grp_events',
  'grp_announcement_reads',
  'grp_announcements',
  'grp_ownership_transfers',
  'grp_member_notification_prefs',
  'grp_members',
  'grp_groups',
];

/** Wipe every grp_* table in the integration test schema. */
export async function resetGroupsTables(client: PrismaClient): Promise<void> {
  const list = GROUP_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Seed canonical groups for School A + School B with admin as OWNER on
 * each. Idempotent — every INSERT uses ON CONFLICT DO NOTHING.
 */
export async function ensureGroupsSeed(client: PrismaClient): Promise<void> {
  // School A — OPEN group
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.grp_groups
       (id, school_id, name, description, scope_type, scope_id, status, join_policy, created_by)
     VALUES ($1::uuid, $2::uuid, 'Open Group A', 'Open-join School A fixture', 'SCHOOL', NULL, 'ACTIVE', 'OPEN', $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_GROUP_OPEN_A_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.grp_members
       (id, group_id, person_id, member_role, status, joined_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', now())
     ON CONFLICT (id) DO NOTHING`,
    TEST_GROUP_OPEN_A_OWNER_MEMBER_ID,
    TEST_GROUP_OPEN_A_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );

  // School A — APPROVAL_REQUIRED group
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.grp_groups
       (id, school_id, name, description, scope_type, scope_id, status, join_policy, created_by)
     VALUES ($1::uuid, $2::uuid, 'Approval Group A', 'Approval-required fixture', 'CUSTOM', NULL, 'ACTIVE', 'APPROVAL_REQUIRED', $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_GROUP_APPROVAL_A_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.grp_members
       (id, group_id, person_id, member_role, status, joined_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', now())
     ON CONFLICT (id) DO NOTHING`,
    TEST_GROUP_APPROVAL_A_OWNER_MEMBER_ID,
    TEST_GROUP_APPROVAL_A_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );

  // School A — INVITE_ONLY group
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.grp_groups
       (id, school_id, name, description, scope_type, scope_id, status, join_policy, created_by)
     VALUES ($1::uuid, $2::uuid, 'Invite Group A', 'Invite-only fixture', 'CUSTOM', NULL, 'ACTIVE', 'INVITE_ONLY', $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_GROUP_INVITE_A_ID,
    TEST_SCHOOL_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.grp_members
       (id, group_id, person_id, member_role, status, joined_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', now())
     ON CONFLICT (id) DO NOTHING`,
    TEST_GROUP_INVITE_A_OWNER_MEMBER_ID,
    TEST_GROUP_INVITE_A_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );

  // School B — OPEN group (cross-school isolation target)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.grp_groups
       (id, school_id, name, description, scope_type, scope_id, status, join_policy, created_by)
     VALUES ($1::uuid, $2::uuid, 'Open Group B', 'School B fixture', 'SCHOOL', NULL, 'ACTIVE', 'OPEN', $3::uuid)
     ON CONFLICT (id) DO NOTHING`,
    TEST_GROUP_B_ID,
    TEST_SCHOOL_B_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.grp_members
       (id, group_id, person_id, member_role, status, joined_at)
     VALUES ($1::uuid, $2::uuid, $3::uuid, 'OWNER', 'ACTIVE', now())
     ON CONFLICT (id) DO NOTHING`,
    TEST_GROUP_B_OWNER_MEMBER_ID,
    TEST_GROUP_B_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );
}

/**
 * Combined per-test reset helper. Wipes every grp_* table and any
 * spec-tracked sis_* / platform_* rows inside ONE transaction. Modelled
 * on fixtures/clubs.ts resetClubsAndStudents — the same deadlock retry
 * loop applies when coverage instrumentation interleaves teardowns
 * across spec files.
 */
export async function resetGroupsAndStudents(
  client: PrismaClient,
  ids: {
    studentIds?: string[];
    platformStudentIds?: string[];
    guardianIds?: string[];
    personIds?: string[];
    accountIds?: string[];
  },
): Promise<void> {
  const stuIds = ids.studentIds ?? [];
  const psIds = ids.platformStudentIds ?? [];
  const gdIds = ids.guardianIds ?? [];
  const pIds = ids.personIds ?? [];
  const aIds = ids.accountIds ?? [];

  const truncateList = GROUP_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');

  let attempt = 0;
  const maxAttempts = 5;
  while (true) {
    try {
      await client.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`TRUNCATE ${truncateList} RESTART IDENTITY CASCADE`);
        if (stuIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE student_id = ANY($1::uuid[])`,
            stuIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.sis_students WHERE id = ANY($1::uuid[])`,
            stuIds,
          );
        }
        if (psIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM platform.platform_students WHERE id = ANY($1::uuid[])`,
            psIds,
          );
        }
        if (gdIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.sis_student_guardians WHERE guardian_id = ANY($1::uuid[])`,
            gdIds,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM ${TEST_SCHEMA}.sis_guardians WHERE id = ANY($1::uuid[])`,
            gdIds,
          );
        }
        if (aIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM platform.platform_users WHERE id = ANY($1::uuid[])`,
            aIds,
          );
        }
        if (pIds.length) {
          await tx.$executeRawUnsafe(
            `DELETE FROM platform.iam_person WHERE id = ANY($1::uuid[])`,
            pIds,
          );
        }
      });
      return;
    } catch (e) {
      const err = e as { code?: string; meta?: { code?: string }; message?: string };
      const isDeadlock =
        err.code === '40P01' ||
        err.meta?.code === '40P01' ||
        /deadlock detected/i.test(err.message ?? '');
      attempt += 1;
      if (!isDeadlock || attempt >= maxAttempts) throw e;
      await new Promise((r) => setTimeout(r, 50 * attempt));
    }
  }
}
