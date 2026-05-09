import { config } from 'dotenv';
config({ path: ['../../.env.local', '../../.env', '.env'] });

import { getPlatformClient, disconnectAll } from './client';
import { generateId } from './uuid';

/*
 * seed-appraisals.ts — Phase 2 Cycle 4 sub-cycle c (P2-4c) Step 7.
 *
 * Idempotent — gated on whether hr_appraisal_frameworks already
 * has rows for the demo school.
 *
 * Sections:
 *   A) 1 framework "Lincoln Academy Annual Review" with 4 competency
 *      criteria (Instruction, Student Engagement, Professional
 *      Development, Collaboration) all weighted 25%.
 *   B) 1 OPEN cycle for the current academic year — ANNUAL.
 *   C) 1 appraisal for Rivera (status=DRAFT). Mitchell is the
 *      appraiser.
 *   D) 2 SMART goals attached to the appraisal.
 *   E) 1 PENDING expense claim from Rivera ($45 textbook).
 *
 * No lesson observations are seeded — they require an admin to
 * exercise the keystone gate via the API. The CAT script seeds one
 * during scenario S5.
 */

const TENANT_SCHEMA = 'tenant_demo';

async function seedAppraisals() {
  console.log('');
  console.log('  Appraisals Seed (P2-4c sub-cycle c)');
  console.log('');

  const client = getPlatformClient();
  const school = await client.school.findFirst({ where: { subdomain: 'demo' } });
  if (!school) throw new Error('demo school not found — run pnpm seed first');
  const schoolId = school.id;

  const existing = (await client.$queryRawUnsafe(
    'SELECT COUNT(*)::int AS c FROM ' +
      TENANT_SCHEMA +
      '.hr_appraisal_frameworks WHERE school_id = $1::uuid',
    schoolId,
  )) as Array<{ c: number }>;
  if (existing[0]!.c > 0) {
    console.log('  hr_appraisal_frameworks already populated for demo school. Skipping.');
    return;
  }

  await client.$executeRawUnsafe('SET search_path TO ' + TENANT_SCHEMA + ', platform, public');

  const employees = (await client.$queryRawUnsafe(
    'SELECT e.id::text AS id, pu.email ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.hr_employees e ' +
      'JOIN platform.iam_person ip ON ip.id = e.person_id ' +
      'JOIN platform.platform_users pu ON pu.person_id = ip.id ' +
      "WHERE pu.email IN ('teacher@demo.campusos.dev', 'principal@demo.campusos.dev')",
  )) as Array<{ id: string; email: string }>;
  const riveraId = employees.find((e) => e.email === 'teacher@demo.campusos.dev')?.id;
  const mitchellId = employees.find((e) => e.email === 'principal@demo.campusos.dev')?.id;
  if (!riveraId || !mitchellId) {
    throw new Error('seed-appraisals requires Rivera + Mitchell hr_employees rows from seed-hr');
  }

  const academicYear = (await client.$queryRawUnsafe(
    'SELECT id::text AS id, start_date::text AS starts_on, end_date::text AS ends_on ' +
      'FROM ' +
      TENANT_SCHEMA +
      '.sis_academic_years WHERE school_id = $1::uuid AND is_current = true LIMIT 1',
    schoolId,
  )) as Array<{ id: string; starts_on: string; ends_on: string }>;
  if (academicYear.length === 0) {
    throw new Error('seed-appraisals requires a current sis_academic_years row from seed-sis');
  }
  const ayId = academicYear[0]!.id;
  const ayStart = academicYear[0]!.starts_on;
  const ayEnd = academicYear[0]!.ends_on;

  // --- A. framework ---
  const frameworkId = generateId();
  const criteria = JSON.stringify([
    { competency: 'Instruction', weight: 25, description: 'Lesson planning + delivery' },
    {
      competency: 'Student Engagement',
      weight: 25,
      description: 'Classroom climate + relationships',
    },
    { competency: 'Professional Development', weight: 25, description: 'Growth + reflection' },
    { competency: 'Collaboration', weight: 25, description: 'Department + grade-level teamwork' },
  ]);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_appraisal_frameworks (id, school_id, name, description, criteria) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::jsonb)',
    frameworkId,
    schoolId,
    'Lincoln Academy Annual Review',
    'Standard 4-competency annual review framework. Each competency carries equal weight; overall rating is the weighted average rounded to the nearest band.',
    criteria,
  );
  console.log('  A. 1 framework (Lincoln Academy Annual Review, 4 competencies)');

  // --- B. cycle ---
  const cycleId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_appraisal_cycles ' +
      '(id, school_id, academic_year_id, framework_id, cycle_type, name, starts_on, ends_on, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, 'ANNUAL', $5, $6::date, $7::date, 'OPEN')",
    cycleId,
    schoolId,
    ayId,
    frameworkId,
    'Annual Review — current academic year',
    ayStart,
    ayEnd,
  );
  console.log('  B. 1 OPEN cycle (ANNUAL)');

  // --- C. appraisal ---
  const appraisalId = generateId();
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_appraisals (id, cycle_id, employee_id, appraiser_id, school_id, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, 'DRAFT')",
    appraisalId,
    cycleId,
    riveraId,
    mitchellId,
    schoolId,
  );
  console.log('  C. 1 appraisal (Rivera, appraiser Mitchell, DRAFT)');

  // --- D. goals ---
  const today = new Date();
  const targetDate = new Date(today);
  targetDate.setMonth(targetDate.getMonth() + 6);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_appraisal_goals (id, appraisal_id, goal_text, success_criteria, target_date, sort_order) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, 0)',
    generateId(),
    appraisalId,
    'Implement project-based learning unit in Algebra 1',
    'Design + deliver a 4-week PBL unit; collect student artefacts; share reflection with department.',
    targetDate.toISOString().slice(0, 10),
  );
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_appraisal_goals (id, appraisal_id, goal_text, success_criteria, target_date, sort_order) ' +
      'VALUES ($1::uuid, $2::uuid, $3, $4, $5::date, 1)',
    generateId(),
    appraisalId,
    'Co-plan with Grade 9 ELA team monthly',
    'Attend all 6 grade-level meetings; document at least 2 cross-curricular connections per term.',
    targetDate.toISOString().slice(0, 10),
  );
  console.log('  D. 2 goals (PBL unit + cross-team co-planning)');

  // --- E. expense claim ---
  const claimDate = new Date(today);
  claimDate.setDate(today.getDate() - 14);
  await client.$executeRawUnsafe(
    'INSERT INTO ' +
      TENANT_SCHEMA +
      '.hr_expense_claims ' +
      '(id, employee_id, school_id, claim_title, description, incurred_on, total_amount, status) ' +
      "VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::date, 45.00, 'SUBMITTED')",
    generateId(),
    riveraId,
    schoolId,
    'Math department reading group — textbook',
    'Purchased "Mathematical Mindsets" by Jo Boaler for the Q2 department reading group.',
    claimDate.toISOString().slice(0, 10),
  );
  console.log('  E. 1 SUBMITTED expense claim (Rivera, $45 textbook)');

  console.log('  done.');
}

seedAppraisals()
  .then(() => disconnectAll())
  .catch((err) => {
    console.error(err);
    return disconnectAll().then(() => {
      process.exit(1);
    });
  });
