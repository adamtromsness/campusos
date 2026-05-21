import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';
import {
  TEST_ADMIN_ACCOUNT_ID,
  TEST_TEACHER_PERSON_ID,
  TEST_TEACHER_ACCOUNT_ID,
} from '../helpers/actor';
import { TEST_SCHOOL_SCOPE_ID, TEST_SCHOOL_B_SCOPE_ID } from './platform';

/**
 * Wave 8 — m02-workflows fixtures.
 *
 * Seeds:
 *   - Per-test wipe of every wsk_* table for clean state.
 *   - Canonical workflow templates per school:
 *       School A: hr_leave_requests (1-step ROLE='SCHOOL_ADMIN'),
 *                 sis_absence_requests (2-step SPECIFIC_USER → SPECIFIC_USER),
 *                 sis_child_link_requests (1-step MANAGER fallback).
 *       School B: hr_leave_requests (1-step ROLE='SCHOOL_ADMIN').
 *   - A second platform_users row (TEACHER) we can use as the "requester
 *     who is not an admin" so the requester ≠ approver predicate fires.
 *   - iam_effective_access_cache row giving the admin sch-001:admin at
 *     SCHOOL scope so the engine's fallback approver lookup
 *     (iam_effective_access_cache scan) can resolve the admin.
 *
 * The cache row + teacher rows are inserted once with ON CONFLICT DO
 * NOTHING; templates/steps are wiped + reseeded between specs via
 * resetWorkflowsTables + ensureWorkflowsSeed.
 */
export const TEST_WORKFLOW_TPL_LEAVE_A_ID = '019e0cf8-aaaa-7777-8888-000000020001';
export const TEST_WORKFLOW_TPL_ABSENCE_A_ID = '019e0cf8-aaaa-7777-8888-000000020002';
export const TEST_WORKFLOW_TPL_CHILD_LINK_A_ID = '019e0cf8-aaaa-7777-8888-000000020003';
export const TEST_WORKFLOW_TPL_LEAVE_B_ID = '019e0cf8-aaaa-7777-8888-000000020004';
export const TEST_WORKFLOW_TPL_INACTIVE_A_ID = '019e0cf8-aaaa-7777-8888-000000020005';

export const TEST_WORKFLOW_STEP_LEAVE_A1_ID = '019e0cf8-aaaa-7777-8888-000000020011';
export const TEST_WORKFLOW_STEP_ABSENCE_A1_ID = '019e0cf8-aaaa-7777-8888-000000020021';
export const TEST_WORKFLOW_STEP_ABSENCE_A2_ID = '019e0cf8-aaaa-7777-8888-000000020022';
export const TEST_WORKFLOW_STEP_CHILD_LINK_A1_ID = '019e0cf8-aaaa-7777-8888-000000020031';
export const TEST_WORKFLOW_STEP_LEAVE_B1_ID = '019e0cf8-aaaa-7777-8888-000000020041';

const WORKFLOW_TABLES = [
  'wsk_workflow_escalations',
  'wsk_approval_comments',
  'wsk_approval_steps',
  'wsk_approval_requests',
  'wsk_workflow_steps',
  'wsk_workflow_templates',
];

const IAM_CACHE_VERSION_HASH = 'wave8-m02-workflows-test';

/** Wipe every wsk_* table for a clean per-test slate. */
export async function resetWorkflowsTables(client: PrismaClient): Promise<void> {
  const list = WORKFLOW_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

/**
 * Set up platform-side actors + IAM cache that the engine reads
 * synchronously inside the transaction. Idempotent (ON CONFLICT
 * DO NOTHING) so safe to call in beforeAll for every spec.
 */
export async function ensureWorkflowsPlatformFixtures(client: PrismaClient): Promise<void> {
  // Teacher persona platform_users row — used as a non-admin requester.
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_person (id, first_name, last_name, person_type, is_active)
     VALUES ($1::uuid, 'Teacher', 'Workflow', 'STAFF', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TEACHER_PERSON_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.platform_users
       (id, person_id, email, display_name, account_status, account_type, mfa_enabled)
     VALUES ($1::uuid, $2::uuid, 'teacher.workflow@test.local',
             'Teacher Workflow', 'ACTIVE', 'HUMAN', false)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TEACHER_ACCOUNT_ID,
    TEST_TEACHER_PERSON_ID,
  );

  // Grant the admin sch-001:admin at SCHOOL A scope so the engine's
  // fallback resolveApprover (scan iam_effective_access_cache) finds it.
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_effective_access_cache
       (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid,
             ARRAY['sch-001:admin','ops-001:read','ops-001:write','ops-001:admin']::text[],
             now(), $3)
     ON CONFLICT (account_id, scope_id) DO UPDATE
       SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
    TEST_ADMIN_ACCOUNT_ID,
    TEST_SCHOOL_SCOPE_ID,
    IAM_CACHE_VERSION_HASH,
  );

  // Grant the admin same set at SCHOOL B scope (cross-school tests).
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_effective_access_cache
       (id, account_id, scope_id, permission_codes, computed_at, assignment_version_hash)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid,
             ARRAY['sch-001:admin','ops-001:read','ops-001:write','ops-001:admin']::text[],
             now(), $3)
     ON CONFLICT (account_id, scope_id) DO UPDATE
       SET permission_codes = EXCLUDED.permission_codes, computed_at = now()`,
    TEST_ADMIN_ACCOUNT_ID,
    TEST_SCHOOL_B_SCOPE_ID,
    IAM_CACHE_VERSION_HASH,
  );

  // Ensure the 'School Admin' role exists in platform.roles. The seed
  // normally creates it; we ON CONFLICT no-op if so. school_id NULL
  // means platform-wide; we use NULL so the unique key matches across
  // re-runs regardless of which migration seed laid it down.
  await client.$executeRawUnsafe(
    `INSERT INTO platform.roles (id, school_id, name, description, is_system)
     VALUES (gen_random_uuid(), NULL, 'School Admin',
             'Test fixture school admin role', true)
     ON CONFLICT (school_id, name) DO NOTHING`,
  );
  // Bind the admin account to the School Admin role at School A + B scope.
  // The engine reads this assignment when approver_type='ROLE' and
  // approver_ref='SCHOOL_ADMIN'. iam_role_assignment has no unique on
  // (account_id, role_id, scope_id) so we de-dupe by deleting existing
  // fixture rows first.
  await client.$executeRawUnsafe(
    `DELETE FROM platform.iam_role_assignment
       WHERE account_id = $1::uuid
         AND scope_id IN ($2::uuid, $3::uuid)
         AND notes = 'wave8-workflows-fixture'`,
    TEST_ADMIN_ACCOUNT_ID,
    TEST_SCHOOL_SCOPE_ID,
    TEST_SCHOOL_B_SCOPE_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_role_assignment
       (id, account_id, role_id, scope_id, status, source, notes)
     SELECT gen_random_uuid(), $1::uuid, r.id, $2::uuid, 'ACTIVE', 'MANUAL',
            'wave8-workflows-fixture'
       FROM platform.roles r WHERE r.name = 'School Admin' LIMIT 1`,
    TEST_ADMIN_ACCOUNT_ID,
    TEST_SCHOOL_SCOPE_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO platform.iam_role_assignment
       (id, account_id, role_id, scope_id, status, source, notes)
     SELECT gen_random_uuid(), $1::uuid, r.id, $2::uuid, 'ACTIVE', 'MANUAL',
            'wave8-workflows-fixture'
       FROM platform.roles r WHERE r.name = 'School Admin' LIMIT 1`,
    TEST_ADMIN_ACCOUNT_ID,
    TEST_SCHOOL_B_SCOPE_ID,
  );
}

/**
 * Seed canonical workflow templates + steps for both schools.
 *
 * School A:
 *   - hr_leave_requests: 1-step ROLE='SCHOOL_ADMIN' (admin is the
 *                        sole holder so engine deterministically picks).
 *   - sis_absence_requests: 2-step SPECIFIC_USER → SPECIFIC_USER (both
 *                          pointing at admin; tests can verify chain).
 *   - sis_child_link_requests: 1-step MANAGER (engine falls back to
 *                              first school admin).
 *   - INACTIVE template: same request_type as one above but is_active=false.
 *                        Used to assert engine ignores inactive templates.
 *
 * School B:
 *   - hr_leave_requests: 1-step ROLE='SCHOOL_ADMIN' (cross-school check).
 */
export async function ensureWorkflowsSeed(client: PrismaClient): Promise<void> {
  // ── School A templates ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_templates
       (id, school_id, name, request_type, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'Leave A', 'hr_leave_requests', 'Leave approvals A', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_TPL_LEAVE_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_templates
       (id, school_id, name, request_type, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'Absence A', 'sis_absence_requests', 'Two-step absence', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_TPL_ABSENCE_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_templates
       (id, school_id, name, request_type, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'ChildLink A', 'sis_child_link_requests', 'Manager fallback', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_TPL_CHILD_LINK_A_ID,
    TEST_SCHOOL_ID,
  );

  // ── School B template ──
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_templates
       (id, school_id, name, request_type, description, is_active)
     VALUES ($1::uuid, $2::uuid, 'Leave B', 'hr_leave_requests', 'Leave approvals B', true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_TPL_LEAVE_B_ID,
    TEST_SCHOOL_B_ID,
  );

  // ── Steps ──
  // School A leave (1-step ROLE SCHOOL_ADMIN)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_steps
       (id, template_id, step_order, approver_type, approver_ref, is_parallel, timeout_hours)
     VALUES ($1::uuid, $2::uuid, 1, 'ROLE', 'SCHOOL_ADMIN', false, 48)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_STEP_LEAVE_A1_ID,
    TEST_WORKFLOW_TPL_LEAVE_A_ID,
  );
  // School A absence step 1 (SPECIFIC_USER admin)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_steps
       (id, template_id, step_order, approver_type, approver_ref, is_parallel, timeout_hours)
     VALUES ($1::uuid, $2::uuid, 1, 'SPECIFIC_USER', $3, false, 24)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_STEP_ABSENCE_A1_ID,
    TEST_WORKFLOW_TPL_ABSENCE_A_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );
  // School A absence step 2 (SPECIFIC_USER admin again - tests chain)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_steps
       (id, template_id, step_order, approver_type, approver_ref, is_parallel, timeout_hours)
     VALUES ($1::uuid, $2::uuid, 2, 'SPECIFIC_USER', $3, false, 24)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_STEP_ABSENCE_A2_ID,
    TEST_WORKFLOW_TPL_ABSENCE_A_ID,
    TEST_ADMIN_ACCOUNT_ID,
  );
  // School A child-link (MANAGER fallback - engine resolves to school admin)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_steps
       (id, template_id, step_order, approver_type, approver_ref, is_parallel, timeout_hours)
     VALUES ($1::uuid, $2::uuid, 1, 'MANAGER', NULL, false, NULL)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_STEP_CHILD_LINK_A1_ID,
    TEST_WORKFLOW_TPL_CHILD_LINK_A_ID,
  );
  // School B leave (1-step ROLE SCHOOL_ADMIN)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.wsk_workflow_steps
       (id, template_id, step_order, approver_type, approver_ref, is_parallel, timeout_hours)
     VALUES ($1::uuid, $2::uuid, 1, 'ROLE', 'SCHOOL_ADMIN', false, 48)
     ON CONFLICT (id) DO NOTHING`,
    TEST_WORKFLOW_STEP_LEAVE_B1_ID,
    TEST_WORKFLOW_TPL_LEAVE_B_ID,
  );
}

/** Combined: reset all wsk_* tables then re-seed canonical templates. */
export async function resetAndSeedWorkflows(client: PrismaClient): Promise<void> {
  await resetWorkflowsTables(client);
  await ensureWorkflowsSeed(client);
}
