import type { PrismaClient } from '@prisma/client';
import { TEST_SCHEMA, TEST_SCHOOL_ID, TEST_SCHOOL_B_ID } from '../helpers/tenant-context';

/**
 * Wave 8 — m03-tasks fixtures.
 *
 * Per-test reset of every tsk_* table. Optional seed of canonical
 * auto-task rules so the worker tests don't repeat boilerplate.
 */
export const TEST_TSK_RULE_ASSIGN_A_ID = '019e0cf8-aaaa-7777-8888-000000030001';
export const TEST_TSK_RULE_ASSIGN_B_ID = '019e0cf8-aaaa-7777-8888-000000030002';
export const TEST_TSK_RULE_ACK_A_ID = '019e0cf8-aaaa-7777-8888-000000030003';
export const TEST_TSK_RULE_ADMIN_A_ID = '019e0cf8-aaaa-7777-8888-000000030004';

const TASK_TABLES = [
  'tsk_tasks',
  'tsk_auto_task_actions',
  'tsk_auto_task_conditions',
  'tsk_acknowledgements',
  'tsk_auto_task_rules',
];

export async function resetTasksTables(client: PrismaClient): Promise<void> {
  // tsk_tasks is partitioned + has FK to tsk_acknowledgements — TRUNCATE
  // CASCADE handles the order. The FK on partitions explodes into 25
  // pg_constraint rows; CASCADE drains all of them.
  const list = TASK_TABLES.map((t) => `${TEST_SCHEMA}.${t}`).join(', ');
  await client.$executeRawUnsafe(`TRUNCATE ${list} CASCADE`);
}

/**
 * Seed two canonical auto-task rules per school. Tests can layer on
 * top via custom inserts; this just covers the keystone paths so
 * worker boot tests see real subscriptions.
 */
export async function ensureTasksRules(client: PrismaClient): Promise<void> {
  // School A — assignment posted rule (target STUDENT, single action CREATE_TASK)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_rules
       (id, school_id, trigger_event_type, target_role, title_template, description_template,
        priority, due_offset_hours, task_category, is_active, is_system)
     VALUES ($1::uuid, $2::uuid, 'cls.assignment.posted', 'STUDENT',
             'Complete: {assignment_title}', 'Class: {class_name}',
             'NORMAL', 168, 'ACADEMIC', true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TSK_RULE_ASSIGN_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
       (id, rule_id, action_type, action_config, sort_order)
     VALUES (gen_random_uuid(), $1::uuid, 'CREATE_TASK', '{}'::jsonb, 0)
     ON CONFLICT DO NOTHING`,
    TEST_TSK_RULE_ASSIGN_A_ID,
  );

  // School A — acknowledgement rule (CREATE_ACKNOWLEDGEMENT + CREATE_TASK)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_rules
       (id, school_id, trigger_event_type, target_role, title_template, description_template,
        priority, due_offset_hours, task_category, is_active, is_system)
     VALUES ($1::uuid, $2::uuid, 'msg.announcement.posted', 'STUDENT',
             'Acknowledge: {announcement_title}', NULL,
             'HIGH', 48, 'ACKNOWLEDGEMENT', true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TSK_RULE_ACK_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
       (id, rule_id, action_type, action_config, sort_order)
     VALUES (gen_random_uuid(), $1::uuid, 'CREATE_ACKNOWLEDGEMENT', '{}'::jsonb, 0)
     ON CONFLICT DO NOTHING`,
    TEST_TSK_RULE_ACK_A_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
       (id, rule_id, action_type, action_config, sort_order)
     VALUES (gen_random_uuid(), $1::uuid, 'CREATE_TASK', '{}'::jsonb, 1)
     ON CONFLICT DO NOTHING`,
    TEST_TSK_RULE_ACK_A_ID,
  );

  // School A — admin notification rule (target SCHOOL_ADMIN, with condition)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_rules
       (id, school_id, trigger_event_type, target_role, title_template, description_template,
        priority, due_offset_hours, task_category, is_active, is_system)
     VALUES ($1::uuid, $2::uuid, 'pay.invoice.overdue', 'SCHOOL_ADMIN',
             'Overdue invoice {invoice_number}', NULL,
             'URGENT', 24, 'ADMINISTRATIVE', true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TSK_RULE_ADMIN_A_ID,
    TEST_SCHOOL_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
       (id, rule_id, action_type, action_config, sort_order)
     VALUES (gen_random_uuid(), $1::uuid, 'CREATE_TASK', '{}'::jsonb, 0)
     ON CONFLICT DO NOTHING`,
    TEST_TSK_RULE_ADMIN_A_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_conditions
       (id, rule_id, field_path, operator, value)
     VALUES (gen_random_uuid(), $1::uuid, 'amount', 'GT', '100'::jsonb)
     ON CONFLICT DO NOTHING`,
    TEST_TSK_RULE_ADMIN_A_ID,
  );

  // School B — assignment posted rule (cross-school check)
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_rules
       (id, school_id, trigger_event_type, target_role, title_template, description_template,
        priority, due_offset_hours, task_category, is_active, is_system)
     VALUES ($1::uuid, $2::uuid, 'cls.assignment.posted', 'STUDENT',
             'School B: {assignment_title}', NULL,
             'NORMAL', 168, 'ACADEMIC', true, true)
     ON CONFLICT (id) DO NOTHING`,
    TEST_TSK_RULE_ASSIGN_B_ID,
    TEST_SCHOOL_B_ID,
  );
  await client.$executeRawUnsafe(
    `INSERT INTO ${TEST_SCHEMA}.tsk_auto_task_actions
       (id, rule_id, action_type, action_config, sort_order)
     VALUES (gen_random_uuid(), $1::uuid, 'CREATE_TASK', '{}'::jsonb, 0)
     ON CONFLICT DO NOTHING`,
    TEST_TSK_RULE_ASSIGN_B_ID,
  );
}

export async function resetAndSeedTasks(client: PrismaClient): Promise<void> {
  await resetTasksTables(client);
  await ensureTasksRules(client);
}
