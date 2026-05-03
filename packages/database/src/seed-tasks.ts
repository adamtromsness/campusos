import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-tasks.ts — Cycle 7 Step 3.
 *
 * Idempotent. Gated on whether tsk_auto_task_rules already has rows for the
 * demo school. Re-running is a no-op once the seed has landed.
 *
 * Six sections:
 *   A) 8 auto-task rules — ASSIGNMENT_POSTED, GRADE_POSTED, GRADE_RETURNED,
 *      LEAVE_APPROVED, ABSENCE_REQUEST_SUBMITTED,
 *      ANNOUNCEMENT_REQUIRES_ACKNOWLEDGEMENT, CONSENT_REQUESTED,
 *      INFO_UPDATE_REQUESTED. Each has one CREATE_TASK action; the two
 *      ACKNOWLEDGEMENT rules also have a CREATE_ACKNOWLEDGEMENT action
 *      that fires first (sort_order=0) before the linked task.
 *   B) 2 auto-task conditions — ASSIGNMENT_POSTED and GRADE_POSTED both
 *      fire only when payload.isPublished = true.
 *   C) 3 workflow templates — Leave Request Approval (LEAVE_REQUEST,
 *      DEPARTMENT_HEAD then ROLE SCHOOL_ADMIN), Absence Request Review
 *      (ABSENCE_REQUEST, ROLE SCHOOL_ADMIN), Child Link Approval
 *      (CHILD_LINK_REQUEST, ROLE SCHOOL_ADMIN).
 *   D) 5 sample tasks for Maya and David — 3 ACADEMIC tasks tied to
 *      Maya's first 3 cls_assignments rows, 1 PERSONAL task on Maya, 1
 *      ADMINISTRATIVE task on David.
 *   E) 1 historical wsk_approval_requests audit row wrapping Rivera's
 *      APPROVED sick leave with 2 completed wsk_approval_steps showing
 *      what the engine would have written for the same approval.
 */

const TENANT_SCHEMA = 'tenant_demo';
const TODAY_ISO = new Date().toISOString();

async function seedTasks() {
  console.log('');
  console.log('  Tasks Seed (Cycle 7 Step 3 — Auto-Task Rules + Workflow Templates)');
  console.log('');

  const client = getPlatformClient();

  // ── 1. Lookups ────────────────────────────────────────────────
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  async function findUserId(email: string): Promise<string> {
    const u = await client.platformUser.findUnique({ where: { email }, select: { id: true } });
    if (!u) throw new Error('platform_users not found for ' + email);
    return u.id;
  }

  const [mayaUserId, davidUserId, principalUserId, vpUserId, riveraUserId] = await Promise.all([
    findUserId('student@demo.campusos.dev'),
    findUserId('parent@demo.campusos.dev'),
    findUserId('principal@demo.campusos.dev'),
    findUserId('vp@demo.campusos.dev'),
    findUserId('teacher@demo.campusos.dev'),
  ]);

  // Idempotency gate
  const existingRules = (await client.$queryRawUnsafe(
    'SELECT count(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.tsk_auto_task_rules WHERE school_id = $1::uuid AND is_system = true',
    schoolId,
  )) as Array<{ c: number }>;
  if (existingRules[0] && existingRules[0].c > 0) {
    console.log('  tsk_auto_task_rules already populated for demo school — skipping');
    return;
  }

  // ── 2. Auto-task rules + conditions + actions ─────────────────
  console.log('  A) auto-task rules:');
  interface RuleSpec {
    triggerEventType: string;
    targetRole: string | null;
    titleTemplate: string;
    descriptionTemplate?: string;
    priority: 'LOW' | 'NORMAL' | 'HIGH' | 'URGENT';
    dueOffsetHours: number | null;
    category: 'ACADEMIC' | 'PERSONAL' | 'ADMINISTRATIVE' | 'ACKNOWLEDGEMENT';
    actions: Array<{
      type: 'CREATE_TASK' | 'CREATE_ACKNOWLEDGEMENT' | 'SEND_NOTIFICATION';
      sortOrder: number;
      config?: Record<string, unknown>;
    }>;
    conditions?: Array<{ fieldPath: string; operator: 'EQUALS'; value: unknown }>;
  }
  const ruleSpecs: RuleSpec[] = [
    {
      triggerEventType: 'cls.assignment.posted',
      targetRole: 'STUDENT',
      titleTemplate: 'Complete: {assignment_title}',
      descriptionTemplate: 'Due {due_date} — {class_name}',
      priority: 'NORMAL',
      dueOffsetHours: 0,
      category: 'ACADEMIC',
      actions: [{ type: 'CREATE_TASK', sortOrder: 0 }],
      conditions: [{ fieldPath: 'isPublished', operator: 'EQUALS', value: true }],
    },
    {
      triggerEventType: 'cls.grade.published',
      targetRole: 'STUDENT',
      titleTemplate: 'Review grade: {assignment_title}',
      descriptionTemplate: 'Posted in {class_name}',
      priority: 'LOW',
      dueOffsetHours: 168, // 7 days
      category: 'ACADEMIC',
      actions: [{ type: 'CREATE_TASK', sortOrder: 0 }],
      conditions: [{ fieldPath: 'isPublished', operator: 'EQUALS', value: true }],
    },
    {
      triggerEventType: 'cls.grade.returned',
      targetRole: 'STUDENT',
      titleTemplate: 'Review feedback: {assignment_title}',
      descriptionTemplate: 'Your teacher returned feedback in {class_name}',
      priority: 'LOW',
      dueOffsetHours: 168,
      category: 'ACADEMIC',
      actions: [{ type: 'CREATE_TASK', sortOrder: 0 }],
    },
    {
      triggerEventType: 'hr.leave.approved',
      targetRole: 'SCHOOL_ADMIN',
      titleTemplate: 'Leave approved: {employee_name}',
      descriptionTemplate: 'Arrange coverage for {dates}',
      priority: 'HIGH',
      dueOffsetHours: 24,
      category: 'ADMINISTRATIVE',
      actions: [{ type: 'CREATE_TASK', sortOrder: 0 }],
    },
    {
      triggerEventType: 'att.absence.requested',
      targetRole: 'SCHOOL_ADMIN',
      titleTemplate: 'Absence request: {student_name} on {date}',
      descriptionTemplate: 'Submitted by {requester_name}',
      priority: 'NORMAL',
      dueOffsetHours: 24,
      category: 'ADMINISTRATIVE',
      actions: [{ type: 'CREATE_TASK', sortOrder: 0 }],
    },
    {
      triggerEventType: 'msg.announcement.requires_acknowledgement',
      targetRole: null, // resolved per-recipient by the worker
      titleTemplate: 'Acknowledge: {announcement_title}',
      descriptionTemplate: 'Please review and acknowledge.',
      priority: 'NORMAL',
      dueOffsetHours: 72,
      category: 'ACKNOWLEDGEMENT',
      actions: [
        { type: 'CREATE_ACKNOWLEDGEMENT', sortOrder: 0 },
        { type: 'CREATE_TASK', sortOrder: 1 },
      ],
    },
    {
      triggerEventType: 'sis.consent.requested',
      targetRole: 'GUARDIAN',
      titleTemplate: 'Consent required: {consent_title}',
      descriptionTemplate: 'Action needed for {student_name}',
      priority: 'HIGH',
      dueOffsetHours: 168,
      category: 'ACKNOWLEDGEMENT',
      actions: [
        { type: 'CREATE_ACKNOWLEDGEMENT', sortOrder: 0 },
        { type: 'CREATE_TASK', sortOrder: 1 },
      ],
    },
    {
      triggerEventType: 'sys.profile.update_requested',
      targetRole: null,
      titleTemplate: 'Update your profile information',
      descriptionTemplate: 'The school office has requested updated information.',
      priority: 'NORMAL',
      dueOffsetHours: 168,
      category: 'ADMINISTRATIVE',
      actions: [{ type: 'CREATE_TASK', sortOrder: 0 }],
    },
  ];

  for (const spec of ruleSpecs) {
    const ruleId = generateId();
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tsk_auto_task_rules (id, school_id, trigger_event_type, target_role, title_template, description_template, priority, due_offset_hours, task_category, is_active, is_system) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, true, true)',
      ruleId,
      schoolId,
      spec.triggerEventType,
      spec.targetRole,
      spec.titleTemplate,
      spec.descriptionTemplate ?? null,
      spec.priority,
      spec.dueOffsetHours,
      spec.category,
    );
    if (spec.conditions) {
      for (const cond of spec.conditions) {
        await client.$executeRawUnsafe(
          'INSERT INTO ' +
            TENANT_SCHEMA +
            '.tsk_auto_task_conditions (id, rule_id, field_path, operator, value) ' +
            'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)',
          generateId(),
          ruleId,
          cond.fieldPath,
          cond.operator,
          JSON.stringify(cond.value),
        );
      }
    }
    for (const action of spec.actions) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.tsk_auto_task_actions (id, rule_id, action_type, action_config, sort_order) ' +
          'VALUES ($1::uuid, $2::uuid, $3, $4::jsonb, $5)',
        generateId(),
        ruleId,
        action.type,
        JSON.stringify(action.config ?? {}),
        action.sortOrder,
      );
    }
    console.log(
      '     - ' +
        spec.triggerEventType +
        ' (' +
        spec.actions.length +
        ' action' +
        (spec.actions.length === 1 ? '' : 's') +
        ')',
    );
  }

  // ── 3. Workflow templates + steps ─────────────────────────────
  console.log('  C) workflow templates:');
  const leaveTemplateId = generateId();
  const absenceTemplateId = generateId();
  const childLinkTemplateId = generateId();

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.wsk_workflow_templates (id, school_id, name, request_type, description, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, true)',
    leaveTemplateId,
    schoolId,
    'Leave Request Approval',
    'LEAVE_REQUEST',
    'Two-step approval — department head, then school admin.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.wsk_workflow_steps (id, template_id, step_order, approver_type, approver_ref, timeout_hours) ' +
      'VALUES ($1::uuid, $2::uuid, 1, $3, NULL, 48)',
    generateId(),
    leaveTemplateId,
    'DEPARTMENT_HEAD',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.wsk_workflow_steps (id, template_id, step_order, approver_type, approver_ref, timeout_hours) ' +
      'VALUES ($1::uuid, $2::uuid, 2, $3, $4, 48)',
    generateId(),
    leaveTemplateId,
    'ROLE',
    'SCHOOL_ADMIN',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.wsk_workflow_templates (id, school_id, name, request_type, description, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, true)',
    absenceTemplateId,
    schoolId,
    'Absence Request Review',
    'ABSENCE_REQUEST',
    'Single step — school admin reviews parent-submitted absence requests.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.wsk_workflow_steps (id, template_id, step_order, approver_type, approver_ref, timeout_hours) ' +
      'VALUES ($1::uuid, $2::uuid, 1, $3, $4, 24)',
    generateId(),
    absenceTemplateId,
    'ROLE',
    'SCHOOL_ADMIN',
  );

  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.wsk_workflow_templates (id, school_id, name, request_type, description, is_active) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5, true)',
    childLinkTemplateId,
    schoolId,
    'Child Link Approval',
    'CHILD_LINK_REQUEST',
    'Single step — school admin verifies the parent-child relationship.',
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.wsk_workflow_steps (id, template_id, step_order, approver_type, approver_ref, timeout_hours) ' +
      'VALUES ($1::uuid, $2::uuid, 1, $3, $4, 72)',
    generateId(),
    childLinkTemplateId,
    'ROLE',
    'SCHOOL_ADMIN',
  );
  console.log('     - Leave Request Approval (2 steps)');
  console.log('     - Absence Request Review (1 step)');
  console.log('     - Child Link Approval (1 step)');

  // ── 4. Sample tasks ───────────────────────────────────────────
  console.log('  D) sample tasks:');
  const assignmentRows = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, title FROM ' +
      TENANT_SCHEMA +
      '.cls_assignments WHERE is_published = true ORDER BY created_at LIMIT 3',
  )) as Array<{ id: string; title: string }>;

  // Maya's 3 ACADEMIC tasks tied to her first 3 published assignments.
  // The task created_at is back-dated 3 days so the row lands in the same
  // monthly partition as the assignment-posted event would have.
  const sampleCreatedAt = '2026-04-15 10:00:00+00';
  for (const assignment of assignmentRows) {
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.tsk_tasks (id, school_id, owner_id, title, description, source, source_ref_id, priority, status, task_category, due_at, created_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'AUTO', $6::uuid, 'NORMAL', 'TODO', 'ACADEMIC', $7::timestamptz, $8::timestamptz)",
      generateId(),
      schoolId,
      mayaUserId,
      'Complete: ' + assignment.title,
      'Posted by your teacher in Period ' + (assignmentRows.indexOf(assignment) + 1),
      assignment.id,
      // due 5 days after task creation
      '2026-04-20 23:59:00+00',
      sampleCreatedAt,
    );
  }

  // Maya's 1 PERSONAL task
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tsk_tasks (id, school_id, owner_id, title, description, source, priority, status, task_category, due_at, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'MANUAL', 'NORMAL', 'TODO', 'PERSONAL', $6::timestamptz, $7::timestamptz)",
    generateId(),
    schoolId,
    mayaUserId,
    'Study for Biology test',
    'Friday — Chapter 5 review.',
    '2026-04-18 23:59:00+00',
    sampleCreatedAt,
  );

  // David's 1 ADMINISTRATIVE task
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.tsk_tasks (id, school_id, owner_id, title, description, source, priority, status, task_category, due_at, created_at) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, 'SYSTEM', 'NORMAL', 'TODO', 'ADMINISTRATIVE', $6::timestamptz, $7::timestamptz)",
    generateId(),
    schoolId,
    davidUserId,
    'Update emergency contact information',
    'The school office is refreshing emergency contacts for the new term.',
    '2026-04-25 23:59:00+00',
    sampleCreatedAt,
  );
  console.log('     - 3 ACADEMIC tasks for Maya tied to assignments');
  console.log('     - 1 PERSONAL task for Maya');
  console.log('     - 1 ADMINISTRATIVE task for David');

  // ── 5. Historical Rivera leave approval audit row ────────────
  console.log('  E) historical leave approval audit:');
  const riveraLeaveRows = (await client.$queryRawUnsafe(
    'SELECT lr.id::text AS id, lr.start_date::text AS start_date, lr.end_date::text AS end_date ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_leave_requests lr ' +
      'JOIN ' +
      TENANT_SCHEMA +
      '.hr_employees e ON e.id = lr.employee_id ' +
      "WHERE lr.status = 'APPROVED' AND e.person_id = (SELECT person_id FROM platform.platform_users WHERE email = 'teacher@demo.campusos.dev') " +
      'ORDER BY lr.created_at LIMIT 1',
  )) as Array<{ id: string; start_date: string; end_date: string }>;

  if (riveraLeaveRows.length === 0) {
    console.log('     skipping — no APPROVED Rivera leave row found (run seed:hr first)');
  } else {
    const leave = riveraLeaveRows[0]!;
    const requestId = generateId();
    const step1Id = generateId();
    const step2Id = generateId();
    // Audit timeline is back-dated to a few days before the leave start.
    const submittedAt = '2026-02-15 09:00:00+00';
    const step1ActionedAt = '2026-02-16 14:00:00+00';
    const step2ActionedAt = '2026-02-17 11:30:00+00';
    const resolvedAt = step2ActionedAt;
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.wsk_approval_requests (id, school_id, template_id, requester_id, request_type, reference_id, reference_table, status, submitted_at, resolved_at, created_at) ' +
        "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'LEAVE_REQUEST', $5::uuid, 'hr_leave_requests', 'APPROVED', $6::timestamptz, $7::timestamptz, $6::timestamptz)",
      requestId,
      schoolId,
      leaveTemplateId,
      riveraUserId,
      leave.id,
      submittedAt,
      resolvedAt,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.wsk_approval_steps (id, request_id, step_order, approver_id, status, actioned_at, comments, created_at) ' +
        "VALUES ($1::uuid, $2::uuid, 1, $3::uuid, 'APPROVED', $4::timestamptz, $5, $6::timestamptz)",
      step1Id,
      requestId,
      vpUserId,
      step1ActionedAt,
      'Coverage arranged with Park.',
      submittedAt,
    );
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.wsk_approval_steps (id, request_id, step_order, approver_id, status, actioned_at, comments, created_at) ' +
        "VALUES ($1::uuid, $2::uuid, 2, $3::uuid, 'APPROVED', $4::timestamptz, $5, $6::timestamptz)",
      step2Id,
      requestId,
      principalUserId,
      step2ActionedAt,
      'Approved.',
      step1ActionedAt,
    );
    console.log(
      '     - 1 wsk_approval_requests + 2 wsk_approval_steps for Rivera leave ' +
        leave.start_date +
        ' to ' +
        leave.end_date,
    );
  }

  console.log('');
  console.log('  Tasks seed complete. ' + TODAY_ISO);
}

seedTasks()
  .then(() => disconnectAll())
  .catch(async (err) => {
    console.error(err);
    await disconnectAll();
    process.exit(1);
  });
