import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-onboarding.ts — Cycle 16 Step 4.
 *
 * Idempotent. Gated on whether enr_onboarding_checklists already has
 * rows for the demo school. Re-running is a no-op once the seed has
 * landed.
 *
 * Sections:
 *   A) 1 onboarding checklist — "Standard New Student Checklist"
 *      admission_type=STANDARD_INTAKE.
 *   B) 8 onboarding tasks across the 7 categories — Uniform ordered
 *      ADMINISTRATIVE / Bus route assigned TRANSPORT / Medical form
 *      returned HEALTH / Locker allocated FACILITIES / IT account
 *      created IT / Library card issued ADMINISTRATIVE / Emergency
 *      contacts confirmed COMMUNICATIONS / Enrolment deposit paid
 *      FINANCE. All mandatory.
 *   C) 1 progress row + 8 task_completion rows wired to Maya Chen's
 *      ENROLLED application from Cycle 6 seed. 3 tasks COMPLETED + 5
 *      PENDING so the Step 8 progress UI has live demo data.
 *   D) 1 sample stage row — Initial SUBMITTED stage for Maya's
 *      application so the Step 6 audit trail has a seeded entry.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedOnboarding() {
  console.log('');
  console.log('  Onboarding Seed (Cycle 16 Step 4)');
  console.log('');

  const client = getPlatformClient();

  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.enr_onboarding_checklists WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  Onboarding checklists already populated for demo school. Skipping.');
    return;
  }

  // Resolve Maya's ENROLLED application from Cycle 6 seed.
  const appRow = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, school_id::text AS school_id FROM ' +
      TENANT_SCHEMA +
      ".enr_applications WHERE student_first_name = 'Maya' AND student_last_name = 'Chen' " +
      "AND status = 'ENROLLED' LIMIT 1",
  )) as Array<{ id: string; school_id: string }>;
  if (appRow.length === 0) {
    throw new Error("Maya Chen's ENROLLED application not found — run pnpm seed:enrollment first");
  }
  const mayaApplicationId = appRow[0]!.id;

  async function findUserByEmail(email: string): Promise<{ accountId: string; personId: string }> {
    const rows = (await client.$queryRawUnsafe(
      'SELECT id::text AS account_id, person_id::text AS person_id FROM platform.platform_users WHERE email = $1',
      email,
    )) as Array<{ account_id: string; person_id: string }>;
    if (rows.length === 0) throw new Error('platform_users not found for ' + email);
    return { accountId: rows[0]!.account_id, personId: rows[0]!.person_id };
  }

  const mitchell = await findUserByEmail('principal@demo.campusos.dev');

  // ── A. 1 checklist ────────────────────────────────────────────
  console.log('  Seeding 1 onboarding checklist (Standard New Student Checklist)...');
  const checklistId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_onboarding_checklists (id, school_id, name, description, admission_type, is_active) ' +
      "VALUES ($1::uuid, $2::uuid, 'Standard New Student Checklist', $3, 'STANDARD_INTAKE', true)",
    checklistId,
    schoolId,
    'Default checklist for new students entering at the start of the academic year.',
  );

  // ── B. 8 onboarding tasks ─────────────────────────────────────
  console.log('  Seeding 8 onboarding tasks...');
  const taskSpec = [
    { name: 'Uniform ordered', category: 'ADMINISTRATIVE', role: 'Front Office' },
    { name: 'Bus route assigned', category: 'TRANSPORT', role: 'Transport Coordinator' },
    { name: 'Medical form returned', category: 'HEALTH', role: 'School Nurse' },
    { name: 'Locker allocated', category: 'FACILITIES', role: 'Facilities' },
    { name: 'IT account created', category: 'IT', role: 'IT Help Desk' },
    { name: 'Library card issued', category: 'ADMINISTRATIVE', role: 'Librarian' },
    { name: 'Emergency contacts confirmed', category: 'COMMUNICATIONS', role: 'Front Office' },
    { name: 'Enrolment deposit paid', category: 'FINANCE', role: 'Finance' },
  ];
  const taskIds: string[] = [];
  for (let i = 0; i < taskSpec.length; i++) {
    const t = taskSpec[i]!;
    const id = generateId();
    taskIds.push(id);
    await client.$executeRawUnsafe(
      'INSERT INTO ' +
        TENANT_SCHEMA +
        '.enr_onboarding_tasks (id, checklist_id, task_name, task_category, is_mandatory, responsible_role, sort_order, due_days_before_start) ' +
        'VALUES ($1::uuid, $2::uuid, $3, $4, true, $5, $6, 7)',
      id,
      checklistId,
      t.name,
      t.category,
      t.role,
      i,
    );
  }

  // ── C. 1 progress row + 8 task completions (3 COMPLETED + 5 PENDING) ──
  console.log("  Seeding Maya Chen's onboarding progress (3 of 8 tasks completed)...");
  const progressId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_student_onboarding_progress (id, application_id, checklist_id, started_date, target_start_date, overall_status, tasks_total, tasks_completed) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, CURRENT_DATE - 14, CURRENT_DATE + 30, 'IN_PROGRESS', 8, 3)",
    progressId,
    mayaApplicationId,
    checklistId,
  );

  // 3 tasks COMPLETED (Uniform / Bus / Library card) + 5 PENDING
  for (let i = 0; i < taskIds.length; i++) {
    const id = generateId();
    const isCompleted = i === 0 || i === 1 || i === 5;
    if (isCompleted) {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.enr_student_onboarding_task_completions (id, progress_id, task_id, status, completed_by, completed_at) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'COMPLETED', $4::uuid, now() - interval '7 days')",
        id,
        progressId,
        taskIds[i],
        mitchell.accountId,
      );
    } else {
      await client.$executeRawUnsafe(
        'INSERT INTO ' +
          TENANT_SCHEMA +
          '.enr_student_onboarding_task_completions (id, progress_id, task_id, status) ' +
          "VALUES ($1::uuid, $2::uuid, $3::uuid, 'PENDING')",
        id,
        progressId,
        taskIds[i],
      );
    }
  }

  // ── D. 1 sample stage row for Maya's application ──────────────
  console.log("  Seeding 1 sample stage row for Maya's application...");
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.enr_application_stages (id, application_id, from_status, to_status, changed_by, notes) ' +
      "VALUES ($1::uuid, $2::uuid, NULL, 'SUBMITTED', $3::uuid, 'Initial submission via parent portal.')",
    generateId(),
    mayaApplicationId,
    mitchell.accountId,
  );

  console.log('');
  console.log('  Onboarding seed complete.');
}

seedOnboarding()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => {
    void disconnectAll();
  });
